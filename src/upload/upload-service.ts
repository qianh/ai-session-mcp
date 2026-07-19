import { randomUUID } from "node:crypto";

import { processSessionImages } from "../capture/images.js";
import {
  renderSessionMarkdown,
  sessionFilename,
} from "../capture/normalize.js";
import { redactText, type RedactionOptions } from "../capture/redact.js";
import { conversationKey, type NormalizedSession } from "../domain/session.js";
import type { DriveEntry, DrivePort } from "../drive/drive-port.js";
import type { StateStore } from "../state/store.js";

export interface UploadWarning {
  code: string;
  message: string;
}

export interface UploadOutput {
  dryRun: boolean;
  scanned: number;
  eligible: number;
  uploaded: number;
  unchanged: number;
  skippedSubagents: number;
  malformed: number;
  redactions: number;
  images: number;
  estimatedBytes: number;
  warnings: UploadWarning[];
}

interface UploadServiceOptions {
  drive: DrivePort;
  state: StateStore;
  deviceId: string;
  redaction?: RedactionOptions;
}

function compareCandidates(left: DriveEntry, right: DriveEntry): number {
  const leftTuple = [
    left.appProperties.updatedAt ?? "",
    left.appProperties.contentSha256 ?? "",
    left.id,
  ];
  const rightTuple = [
    right.appProperties.updatedAt ?? "",
    right.appProperties.contentSha256 ?? "",
    right.id,
  ];
  return rightTuple.join("\0").localeCompare(leftTuple.join("\0"));
}

function redactSession(
  session: NormalizedSession,
  options: RedactionOptions,
): { session: NormalizedSession; count: number } {
  let count = 0;
  return {
    session: {
      ...session,
      turns: session.turns.map((turn) => {
        const text = redactText(turn.text, options);
        count += text.count;
        const images = turn.images.map((image) => {
          if (image.kind !== "remote") return image;
          const url = redactText(image.url, options);
          count += url.count;
          return { ...image, url: url.text };
        });
        return { ...turn, text: text.text, images };
      }),
    },
    get count() {
      return count;
    },
  };
}

export class UploadService {
  readonly #drive: DrivePort;
  readonly #state: StateStore;
  readonly #deviceId: string;
  readonly #redaction: RedactionOptions;

  constructor(options: UploadServiceOptions) {
    this.#drive = options.drive;
    this.#state = options.state;
    this.#deviceId = options.deviceId;
    this.#redaction = options.redaction ?? {};
  }

  async uploadSessions(
    sessions: NormalizedSession[],
    options: { dryRun: boolean },
  ): Promise<UploadOutput> {
    const output: UploadOutput = {
      dryRun: options.dryRun,
      scanned: sessions.length,
      eligible: 0,
      uploaded: 0,
      unchanged: 0,
      skippedSubagents: 0,
      malformed: sessions.reduce(
        (sum, session) => sum + session.warnings.length,
        0,
      ),
      redactions: 0,
      images: 0,
      estimatedBytes: 0,
      warnings: [],
    };
    const seenImageHashes = new Set<string>();

    for (const original of sessions) {
      const redacted = redactSession(original, this.#redaction);
      output.redactions += redacted.count;
      let processedImages: Awaited<ReturnType<typeof processSessionImages>>;
      let rendered: ReturnType<typeof renderSessionMarkdown>;
      try {
        processedImages = await processSessionImages(redacted.session);
        rendered = renderSessionMarkdown(redacted.session, {
          redactionVersion: 1,
          redactionCount: redacted.count,
          imageReferences: processedImages.references,
        });
      } catch {
        output.warnings.push({
          code: "SESSION_PROCESSING_FAILED",
          message: `${original.source} session ${original.conversationId} could not be prepared`,
        });
        continue;
      }
      const bytes = Buffer.from(rendered.markdown);
      const uniqueImages = processedImages.artifacts.filter((image) => {
        if (seenImageHashes.has(image.sha256)) return false;
        seenImageHashes.add(image.sha256);
        return true;
      });
      output.images += uniqueImages.length;
      output.estimatedBytes +=
        bytes.length +
        uniqueImages.reduce((sum, image) => sum + image.bytes.length, 0);
      const key = conversationKey(original.source, original.conversationId);
      const local = this.#state.getSession(key);
      if (
        local?.status === "uploaded" &&
        local.contentSha256 === rendered.contentSha256
      ) {
        output.unchanged += 1;
        continue;
      }

      const existing = await this.#drive.list({
        appProperty: { key: "brainhubKey", value: key },
      });
      const winner = existing.sort(compareCandidates)[0];
      const remoteUpdatedAt = winner?.appProperties.updatedAt ?? "";
      const remoteContentSha = winner?.appProperties.contentSha256 ?? "";
      if (
        winner &&
        (remoteUpdatedAt > original.updatedAt ||
          (remoteUpdatedAt === original.updatedAt &&
            remoteContentSha >= rendered.contentSha256))
      ) {
        output.unchanged += 1;
        continue;
      }

      output.eligible += 1;
      if (options.dryRun) continue;
      this.#state.markPending({
        conversationKey: key,
        source: original.source,
        conversationId: original.conversationId,
        sourcePath: original.sourcePath,
        sourceUpdatedAt: original.updatedAt,
        contentSha256: rendered.contentSha256,
      });

      let candidateId: string | null = null;
      try {
        for (const image of uniqueImages) {
          const imageExisting = await this.#drive.list({
            appProperty: { key: "brainhubImageSha", value: image.sha256 },
          });
          if (imageExisting.length === 0) {
            const uploadedImage = await this.#drive.put({
              path: image.drivePath,
              bytes: image.bytes,
              mimeType: "image/webp",
              appProperties: { brainhubImageSha: image.sha256 },
            });
            const verifiedImage = await this.#drive.read(uploadedImage.id);
            if (!verifiedImage.bytes.equals(image.bytes)) {
              await this.#drive.trash(uploadedImage.id);
              throw new Error("Image verification failed");
            }
          }
        }

        const properties = {
          brainhubKey: key,
          source: original.source,
          conversationId: original.conversationId,
          deviceId: this.#deviceId,
          updatedAt: original.updatedAt,
          contentSha256: rendered.contentSha256,
        };
        const candidate = await this.#drive.put({
          path: `inbox/${original.device}/.${randomUUID()}.tmp`,
          bytes,
          mimeType: "text/markdown",
          appProperties: properties,
        });
        candidateId = candidate.id;
        const verified = await this.#drive.read(candidate.id);
        if (!verified.bytes.equals(bytes))
          throw new Error("Session verification failed");

        const candidates = await this.#drive.list({
          appProperty: { key: "brainhubKey", value: key },
        });
        candidates.sort(compareCandidates);
        const canonical = candidates[0];
        if (!canonical)
          throw new Error("Candidate disappeared during reconciliation");
        const canonicalDirectory = canonical.path.startsWith("inbox/")
          ? canonical.path.split("/").slice(0, -1).join("/")
          : `inbox/${original.device}`;
        const stablePath = `${canonicalDirectory}/${sessionFilename(original)}`;
        await this.#drive.move(canonical.id, stablePath);
        for (const loser of candidates.slice(1))
          await this.#drive.trash(loser.id);
        this.#state.markUploaded(key, canonical.id, new Date().toISOString());
        output.uploaded += 1;
        candidateId = null;
      } catch (error) {
        if (candidateId)
          await this.#drive.trash(candidateId).catch(() => undefined);
        this.#state.markFailed(key, "UPLOAD_FAILED", true);
        output.warnings.push({
          code: "UPLOAD_FAILED",
          message:
            error instanceof Error ? error.message : "Unknown upload failure",
        });
      }
    }

    if (!options.dryRun && output.uploaded > 0) {
      await this.#drive.upsert({
        path: `_meta/devices/${this.#deviceId}.json`,
        bytes: Buffer.from(
          JSON.stringify({
            schema_version: 1,
            device_id: this.#deviceId,
            updated_at: new Date().toISOString(),
          }),
        ),
        mimeType: "application/json",
        appProperties: { brainhubDeviceId: this.#deviceId },
      });
    }
    return output;
  }
}
