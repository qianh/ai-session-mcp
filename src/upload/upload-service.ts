import { createHash, randomUUID } from "node:crypto";

import { processSessionImages } from "../capture/images.js";
import {
  renderSessionMarkdown,
  sessionFilename,
} from "../capture/normalize.js";
import { redactText, type RedactionOptions } from "../capture/redact.js";
import { conversationKey, type NormalizedSession } from "../domain/session.js";
import type { DriveEntry, DrivePort } from "../drive/drive-port.js";
import { InboxScopedDrive } from "../drive/scoped-drive.js";
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
  concurrency?: number;
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
  readonly #concurrency: number;

  constructor(options: UploadServiceOptions) {
    this.#drive = new InboxScopedDrive(options.drive);
    this.#state = options.state;
    this.#deviceId = options.deviceId;
    this.#redaction = options.redaction ?? {};
    this.#concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
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
    const imageUploads = new Map<string, Promise<void>>();
    const reconcileSessions = new Map<
      string,
      { original: NormalizedSession; uploaded: boolean }
    >();
    let inventoryPromise: Promise<DriveEntry[]> | null = null;
    const inventory = (): Promise<DriveEntry[]> => {
      if (inventoryPromise) return inventoryPromise;
      const loading = this.#drive.list({ prefix: "inbox/" });
      inventoryPromise = loading;
      void loading.catch(() => {
        if (inventoryPromise === loading) inventoryPromise = null;
      });
      return loading;
    };
    const matchingEntries = async (
      key: string,
      value: string,
    ): Promise<DriveEntry[]> =>
      (await inventory()).filter((entry) => entry.appProperties[key] === value);
    const rememberEntry = async (entry: DriveEntry): Promise<void> => {
      const entries = await inventory();
      const index = entries.findIndex((current) => current.id === entry.id);
      if (index === -1) entries.push(entry);
      else entries[index] = entry;
    };
    const forgetEntry = async (id: string): Promise<void> => {
      const entries = await inventory();
      const index = entries.findIndex((entry) => entry.id === id);
      if (index !== -1) entries.splice(index, 1);
    };
    const ensureImageUploaded = (
      image: Awaited<
        ReturnType<typeof processSessionImages>
      >["artifacts"][number],
    ): Promise<void> => {
      const current = imageUploads.get(image.sha256);
      if (current) return current;
      const upload = (async () => {
        const existing = await matchingEntries(
          "brainhubImageSha",
          image.sha256,
        );
        if (existing.length > 0) return;
        const uploaded = await this.#drive.put({
          path: image.drivePath,
          bytes: image.bytes,
          mimeType: "image/webp",
          appProperties: { brainhubImageSha: image.sha256 },
        });
        await rememberEntry(uploaded);
        const verified = await this.#drive.read(uploaded.id);
        if (!verified.bytes.equals(image.bytes)) {
          await this.#drive.trash(uploaded.id);
          await forgetEntry(uploaded.id);
          throw new Error("Image verification failed");
        }
      })();
      imageUploads.set(image.sha256, upload);
      void upload.catch(() => {
        if (imageUploads.get(image.sha256) === upload) {
          imageUploads.delete(image.sha256);
        }
      });
      return upload;
    };

    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        const original = sessions[index];
        if (!original) return;
        const key = conversationKey(original.source, original.conversationId);
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
          if (!options.dryRun) {
            const provisionalSha = createHash("sha256")
              .update(
                [
                  "processing-failed",
                  original.source,
                  original.conversationId,
                  original.updatedAt,
                ].join("\0"),
              )
              .digest("hex");
            this.#state.markPending({
              conversationKey: key,
              source: original.source,
              conversationId: original.conversationId,
              sourcePath: original.sourcePath,
              sourceUpdatedAt: original.updatedAt,
              contentSha256: provisionalSha,
            });
            this.#state.markFailed(key, "SESSION_PROCESSING_FAILED", true);
          }
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
        const local = this.#state.getSession(key);
        if (
          local?.status === "uploaded" &&
          local.contentSha256 === rendered.contentSha256
        ) {
          output.unchanged += 1;
          continue;
        }

        const existing = await matchingEntries("brainhubKey", key);
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
          if (!options.dryRun) {
            this.#state.markPending({
              conversationKey: key,
              source: original.source,
              conversationId: original.conversationId,
              sourcePath: original.sourcePath,
              sourceUpdatedAt: original.updatedAt,
              contentSha256: rendered.contentSha256,
            });
            try {
              const canonicalDirectory = winner.path
                .split("/")
                .slice(0, -1)
                .join("/");
              const stablePath = `${canonicalDirectory}/${sessionFilename(original)}`;
              if (winner.path !== stablePath) {
                const moved = await this.#drive.move(winner.id, stablePath);
                await rememberEntry(moved);
              }
              for (const loser of existing.slice(1)) {
                await this.#drive.trash(loser.id);
                await forgetEntry(loser.id);
              }
              reconcileSessions.set(key, { original, uploaded: false });
            } catch (error) {
              this.#state.markFailed(key, "UPLOAD_FAILED", true);
              output.warnings.push({
                code: "UPLOAD_FAILED",
                message:
                  error instanceof Error
                    ? error.message
                    : "Unknown upload failure",
              });
            }
          }
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
          await Promise.all(
            processedImages.artifacts.map((image) =>
              ensureImageUploaded(image),
            ),
          );

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
          await rememberEntry(candidate);
          candidateId = candidate.id;
          const verified = await this.#drive.read(candidate.id);
          if (!verified.bytes.equals(bytes))
            throw new Error("Session verification failed");

          const candidates = await matchingEntries("brainhubKey", key);
          candidates.sort(compareCandidates);
          const canonical = candidates[0];
          if (!canonical)
            throw new Error("Candidate disappeared during reconciliation");
          const canonicalDirectory = canonical.path.startsWith("inbox/")
            ? canonical.path.split("/").slice(0, -1).join("/")
            : `inbox/${original.device}`;
          const stablePath = `${canonicalDirectory}/${sessionFilename(original)}`;
          const moved = await this.#drive.move(canonical.id, stablePath);
          await rememberEntry(moved);
          if (canonical.id === candidateId) candidateId = null;
          for (const loser of candidates.slice(1)) {
            await this.#drive.trash(loser.id);
            await forgetEntry(loser.id);
            if (loser.id === candidateId) candidateId = null;
          }
          reconcileSessions.set(key, { original, uploaded: true });
        } catch (error) {
          if (candidateId) {
            await this.#drive.trash(candidateId).catch(() => undefined);
            await forgetEntry(candidateId).catch(() => undefined);
          }
          this.#state.markFailed(key, "UPLOAD_FAILED", true);
          output.warnings.push({
            code: "UPLOAD_FAILED",
            message:
              error instanceof Error ? error.message : "Unknown upload failure",
          });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.#concurrency, sessions.length) }, () =>
        worker(),
      ),
    );

    if (!options.dryRun && reconcileSessions.size > 0) {
      inventoryPromise = null;
      try {
        await inventory();
      } catch (error) {
        for (const key of reconcileSessions.keys()) {
          this.#state.markFailed(key, "UPLOAD_FAILED", true);
          output.warnings.push({
            code: "UPLOAD_FAILED",
            message:
              error instanceof Error ? error.message : "Unknown upload failure",
          });
        }
        return output;
      }
      for (const [key, reconciliation] of reconcileSessions) {
        try {
          const { original } = reconciliation;
          const candidates = await matchingEntries("brainhubKey", key);
          candidates.sort(compareCandidates);
          const winner = candidates[0];
          if (!winner) throw new Error("Remote session disappeared");
          const canonicalDirectory = winner.path
            .split("/")
            .slice(0, -1)
            .join("/");
          const stablePath = `${canonicalDirectory}/${sessionFilename(original)}`;
          if (winner.path !== stablePath) {
            const moved = await this.#drive.move(winner.id, stablePath);
            await rememberEntry(moved);
          }
          for (const loser of candidates.slice(1)) {
            await this.#drive.trash(loser.id);
            await forgetEntry(loser.id);
          }
          this.#state.markUploaded(key, winner.id, new Date().toISOString());
          if (reconciliation.uploaded) output.uploaded += 1;
        } catch (error) {
          this.#state.markFailed(key, "UPLOAD_FAILED", true);
          output.warnings.push({
            code: "UPLOAD_FAILED",
            message:
              error instanceof Error ? error.message : "Unknown upload failure",
          });
        }
      }
    }

    return output;
  }
}
