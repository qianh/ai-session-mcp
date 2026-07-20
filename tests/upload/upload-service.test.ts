import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  conversationKey,
  type NormalizedSession,
} from "../../src/domain/session.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { SqliteStateStore } from "../../src/state/sqlite-store.js";
import { UploadService } from "../../src/upload/upload-service.js";

const stores: SqliteStateStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function fixture(): Promise<{
  session: NormalizedSession;
  state: SqliteStateStore;
  sourceBytes: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "brainhub-upload-"));
  const sourcePath = join(directory, "source.jsonl");
  const sourceBytes = '{"type":"user","message":"do not change"}\n';
  await writeFile(sourcePath, sourceBytes);
  const state = new SqliteStateStore(join(directory, "state.sqlite"));
  stores.push(state);
  return {
    sourceBytes,
    state,
    session: {
      source: "codex",
      conversationId: "conversation-1",
      device: "macbook",
      startedAt: "2026-07-18T01:00:00.000Z",
      updatedAt: "2026-07-18T02:00:00.000Z",
      sourcePath,
      warnings: [],
      turns: [
        { role: "user", text: "Deploy with password=hunter2", images: [] },
        { role: "assistant", text: "Use a staged release.", images: [] },
      ],
    },
  };
}

describe("upload service", () => {
  it("plans a dry run without writing Drive or state", async () => {
    const { session, state } = await fixture();
    const drive = new MemoryDrive();
    const service = new UploadService({ drive, state, deviceId: "device-1" });

    const output = await service.uploadSessions([session], { dryRun: true });

    expect(output).toMatchObject({
      dryRun: true,
      scanned: 1,
      eligible: 1,
      uploaded: 0,
      redactions: 1,
    });
    expect(await drive.list({ prefix: "" })).toEqual([]);
    expect(state.listPending(10)).toEqual([]);
  });

  it("processes sessions up to the configured concurrency", async () => {
    const { session, state } = await fixture();
    const base = new MemoryDrive();
    let activeLists = 0;
    let maxActiveLists = 0;
    const drive = new Proxy(base, {
      get(target, property, receiver) {
        if (property === "list") {
          return async (...args: Parameters<MemoryDrive["list"]>) => {
            activeLists += 1;
            maxActiveLists = Math.max(maxActiveLists, activeLists);
            await new Promise((resolve) => setTimeout(resolve, 15));
            try {
              return await target.list(...args);
            } finally {
              activeLists -= 1;
            }
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const sessions = Array.from({ length: 6 }, (_value, index) => ({
      ...session,
      conversationId: `parallel-${index}`,
    }));
    const service = new UploadService({
      drive,
      state,
      deviceId: "device-1",
      concurrency: 3,
    });

    const result = await service.uploadSessions(sessions, { dryRun: true });

    expect(result.eligible).toBe(6);
    expect(maxActiveLists).toBe(3);
  });

  it("uploads, verifies, and makes a repeated run idempotent", async () => {
    const { session, state, sourceBytes } = await fixture();
    const drive = new MemoryDrive();
    const service = new UploadService({ drive, state, deviceId: "device-1" });

    const first = await service.uploadSessions([session], { dryRun: false });
    const second = await service.uploadSessions([session], { dryRun: false });

    expect(first.uploaded).toBe(1);
    expect(second).toMatchObject({ uploaded: 0, unchanged: 1 });
    const files = await drive.list({ prefix: "inbox/macbook/" });
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("inbox/macbook/codex-20260718-conversa.md");
    expect((await drive.read(files[0]!.id)).bytes.toString()).not.toContain(
      "hunter2",
    );
    expect(await readFile(session.sourcePath, "utf8")).toBe(sourceBytes);
  });

  it("does not replace a newer remote candidate", async () => {
    const { session, state } = await fixture();
    const drive = new MemoryDrive();
    await drive.put({
      path: "inbox/other/candidate.tmp",
      bytes: Buffer.from("newer"),
      mimeType: "text/markdown",
      appProperties: {
        brainhubKey: conversationKey("codex", "conversation-1"),
        source: "codex",
        conversationId: "conversation-1",
        deviceId: "other-device",
        updatedAt: "2026-07-19T02:00:00.000Z",
        contentSha256: "f".repeat(64),
      },
    });
    const service = new UploadService({ drive, state, deviceId: "device-1" });

    const result = await service.uploadSessions([session], { dryRun: false });
    expect(result).toMatchObject({ uploaded: 0, unchanged: 1 });
    expect(await drive.list({ prefix: "inbox/macbook/" })).toEqual([]);
  });

  it("uploads when the timestamp ties but the local content hash wins", async () => {
    const { session, state } = await fixture();
    const drive = new MemoryDrive();
    await drive.put({
      path: "inbox/other/candidate.tmp",
      bytes: Buffer.from("older tie"),
      mimeType: "text/markdown",
      appProperties: {
        brainhubKey: conversationKey("codex", "conversation-1"),
        source: "codex",
        conversationId: "conversation-1",
        deviceId: "other-device",
        updatedAt: session.updatedAt,
        contentSha256: "0".repeat(64),
      },
    });
    const service = new UploadService({ drive, state, deviceId: "device-1" });

    const result = await service.uploadSessions([session], { dryRun: false });
    expect(result.uploaded).toBe(1);
    const candidates = await drive.list({
      appProperty: {
        key: "brainhubKey",
        value: conversationKey("codex", "conversation-1"),
      },
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.appProperties.contentSha256).not.toBe("0".repeat(64));
  });

  it("records failure only after a remote verification error", async () => {
    const { session, state } = await fixture();
    const drive = new MemoryDrive({ corruptReads: true });
    const service = new UploadService({ drive, state, deviceId: "device-1" });

    const result = await service.uploadSessions([session], { dryRun: false });
    expect(result.uploaded).toBe(0);
    expect(result.warnings[0]?.code).toBe("UPLOAD_FAILED");
    expect(state.listPending(10)[0]).toMatchObject({
      status: "failed",
      retryable: true,
    });
  });

  it("deduplicates identical images across the whole batch", async () => {
    const { session, state } = await fixture();
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const first: NormalizedSession = {
      ...session,
      conversationId: "image-1",
      turns: [
        {
          role: "user",
          text: "first",
          images: [{ kind: "embedded", mediaType: "image/png", data: png }],
        },
      ],
    };
    const second: NormalizedSession = {
      ...first,
      conversationId: "image-2",
    };
    const service = new UploadService({
      drive: new MemoryDrive(),
      state,
      deviceId: "device-1",
    });

    const result = await service.uploadSessions([first, second], {
      dryRun: true,
    });
    expect(result.images).toBe(1);
  });

  it("waits for a shared image upload before writing every session", async () => {
    const { session, state } = await fixture();
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const sessions = ["shared-image-1", "shared-image-2"].map(
      (conversationId): NormalizedSession => ({
        ...session,
        conversationId,
        turns: [
          {
            role: "user",
            text: conversationId,
            images: [{ kind: "embedded", mediaType: "image/png", data: png }],
          },
        ],
      }),
    );
    const base = new MemoryDrive();
    let imageReady = false;
    let imagePuts = 0;
    const drive = new Proxy(base, {
      get(target, property, receiver) {
        if (property === "put") {
          return async (...args: Parameters<MemoryDrive["put"]>) => {
            const [input] = args;
            if (input.path.startsWith("images/sha256/")) {
              imagePuts += 1;
              await new Promise((resolve) => setTimeout(resolve, 25));
              const result = await target.put(...args);
              imageReady = true;
              return result;
            }
            if (input.mimeType === "text/markdown" && !imageReady) {
              throw new Error("session referenced an image before upload");
            }
            return target.put(...args);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const service = new UploadService({
      drive,
      state,
      deviceId: "device-1",
      concurrency: 2,
    });

    const result = await service.uploadSessions(sessions, { dryRun: false });

    expect(result.uploaded).toBe(2);
    expect(imagePuts).toBe(1);
  });

  it("retries a shared image after a transient upload lookup failure", async () => {
    const { session, state } = await fixture();
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const sessions = ["retry-image-1", "retry-image-2"].map(
      (conversationId): NormalizedSession => ({
        ...session,
        conversationId,
        turns: [
          {
            role: "user",
            text: conversationId,
            images: [{ kind: "embedded", mediaType: "image/png", data: png }],
          },
        ],
      }),
    );
    const base = new MemoryDrive();
    let imageLookups = 0;
    const drive = new Proxy(base, {
      get(target, property, receiver) {
        if (property === "list") {
          return async (...args: Parameters<MemoryDrive["list"]>) => {
            const [query] = args;
            if (query.appProperty?.key === "brainhubImageSha") {
              imageLookups += 1;
              if (imageLookups === 1)
                throw new Error("transient Drive lookup failure");
            }
            return target.list(...args);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const service = new UploadService({
      drive,
      state,
      deviceId: "device-1",
      concurrency: 1,
    });

    const result = await service.uploadSessions(sessions, { dryRun: false });

    expect(result.uploaded).toBe(1);
    expect(imageLookups).toBe(2);
  });

  it("redacts credentials and internal hosts from remote image references", async () => {
    const { session, state } = await fixture();
    const drive = new MemoryDrive();
    session.turns = [
      {
        role: "user",
        text: "Inspect this image",
        images: [
          {
            kind: "remote",
            url: "https://images.corp.example/render?X-Amz-Signature=signed-secret&password=hunter2&host=10.2.3.4",
          },
        ],
      },
    ];
    const service = new UploadService({
      drive,
      state,
      deviceId: "device-1",
      redaction: {
        internalDomains: ["corp.example"],
        internalCidrs: ["10.0.0.0/8"],
      },
    });

    const result = await service.uploadSessions([session], { dryRun: false });

    expect(result.uploaded).toBe(1);
    const uploaded = (await drive.list({ prefix: "inbox/macbook/" }))[0];
    expect(uploaded).toBeDefined();
    const markdown = (await drive.read(uploaded!.id)).bytes.toString("utf8");
    expect(markdown).not.toContain("signed-secret");
    expect(markdown).not.toContain("hunter2");
    expect(markdown).not.toContain("images.corp.example");
    expect(markdown).not.toContain("10.2.3.4");
  });

  it("isolates a corrupt image and continues with later sessions", async () => {
    const { session, state } = await fixture();
    const corrupt: NormalizedSession = {
      ...session,
      conversationId: "corrupt-image",
      turns: [
        {
          role: "user",
          text: "broken",
          images: [
            {
              kind: "embedded",
              mediaType: "image/png",
              data: "not-valid-image-data",
            },
          ],
        },
      ],
    };
    const valid: NormalizedSession = {
      ...session,
      conversationId: "valid-after-corrupt",
      turns: [{ role: "user", text: "valid", images: [] }],
    };
    const service = new UploadService({
      drive: new MemoryDrive(),
      state,
      deviceId: "device-1",
    });

    const result = await service.uploadSessions([corrupt, valid], {
      dryRun: true,
    });

    expect(result).toMatchObject({ scanned: 2, eligible: 1 });
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "SESSION_PROCESSING_FAILED" }),
    );
  });
});
