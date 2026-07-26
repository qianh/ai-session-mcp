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
  it("keeps every uploaded artifact inside inbox", async () => {
    const { session, state } = await fixture();
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    session.turns = [
      {
        role: "user",
        text: "inspect",
        images: [{ kind: "embedded", mediaType: "image/png", data: png }],
      },
    ];
    const drive = new MemoryDrive();
    const service = new UploadService({ drive, state, deviceId: "device-1" });

    const result = await service.uploadSessions([session], { dryRun: false });

    expect(result.uploaded).toBe(1);
    const paths = (await drive.list({ prefix: "" })).map((entry) => entry.path);
    expect(paths.length).toBeGreaterThan(1);
    expect(paths.every((path) => path.startsWith("inbox/"))).toBe(true);
    const markdownEntry = (await drive.list({ prefix: "inbox/macbook/" }))[0];
    expect(markdownEntry).toBeDefined();
    const markdown = (await drive.read(markdownEntry!.id)).bytes.toString();
    expect(markdown).toContain("inbox/_assets/sha256/");
  });

  it("ignores matching candidates outside inbox", async () => {
    const { session, state } = await fixture();
    const drive = new MemoryDrive();
    const outside = await drive.put({
      path: "sessions/2026-07/newer.md",
      bytes: Buffer.from("outside"),
      mimeType: "text/markdown",
      appProperties: {
        brainhubKey: conversationKey("codex", "conversation-1"),
        source: "codex",
        conversationId: "conversation-1",
        deviceId: "cloud",
        updatedAt: "2026-07-19T02:00:00.000Z",
        contentSha256: "f".repeat(64),
      },
    });
    const service = new UploadService({ drive, state, deviceId: "device-1" });

    const result = await service.uploadSessions([session], { dryRun: false });

    expect(result.uploaded).toBe(1);
    expect(await drive.list({ prefix: "inbox/macbook/" })).toHaveLength(1);
    await expect(drive.read(outside.id)).resolves.toMatchObject({
      path: "sessions/2026-07/newer.md",
    });
  });

  it("rejects out-of-scope entries returned by a buggy Drive", async () => {
    const { session, state } = await fixture();
    const base = new MemoryDrive();
    const outside = await base.put({
      path: "sessions/2026-07/newer.md",
      bytes: Buffer.from("outside"),
      mimeType: "text/markdown",
      appProperties: {
        brainhubKey: conversationKey("codex", "conversation-1"),
        source: "codex",
        conversationId: "conversation-1",
        deviceId: "cloud",
        updatedAt: "2026-07-19T02:00:00.000Z",
        contentSha256: "f".repeat(64),
      },
    });
    const touchedOutside: string[] = [];
    const drive = new Proxy(base, {
      get(target, property, receiver) {
        if (property === "list") {
          return (query: Parameters<MemoryDrive["list"]>[0]) =>
            target.list({
              ...(query.appProperty ? { appProperty: query.appProperty } : {}),
              ...(query.modifiedAfter
                ? { modifiedAfter: query.modifiedAfter }
                : {}),
            });
        }
        if (["read", "move", "trash"].includes(String(property))) {
          return async (...args: unknown[]) => {
            if (args[0] === outside.id) touchedOutside.push(String(property));
            return (
              target[property as "read"] as (...values: never[]) => unknown
            )(...(args as never[]));
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
    });

    const result = await service.uploadSessions([session], { dryRun: false });

    expect(result.uploaded).toBe(1);
    expect(touchedOutside).toEqual([]);
    expect(await base.list({ prefix: "inbox/macbook/" })).toHaveLength(1);
  });

  it("does not reuse a matching image outside inbox", async () => {
    const { session, state } = await fixture();
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    session.turns = [
      {
        role: "user",
        text: "inspect",
        images: [{ kind: "embedded", mediaType: "image/png", data: png }],
      },
    ];
    const processed = await import("../../src/capture/images.js").then(
      ({ processSessionImages }) => processSessionImages(session),
    );
    const image = processed.artifacts[0]!;
    const drive = new MemoryDrive();
    const outside = await drive.put({
      path: `images/sha256/${image.sha256.slice(0, 2)}/${image.sha256}.webp`,
      bytes: image.bytes,
      mimeType: "image/webp",
      appProperties: { brainhubImageSha: image.sha256 },
    });
    const service = new UploadService({ drive, state, deviceId: "device-1" });

    const result = await service.uploadSessions([session], { dryRun: false });

    expect(result.uploaded).toBe(1);
    expect(await drive.list({ prefix: "inbox/_assets/sha256/" })).toHaveLength(
      1,
    );
    await expect(drive.read(outside.id)).resolves.toMatchObject({
      path: expect.stringMatching(/^images\/sha256\//),
    });
  });

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

  it("loads the remote inbox inventory once for a concurrent batch", async () => {
    const { session, state } = await fixture();
    const base = new MemoryDrive();
    let activeLists = 0;
    let maxActiveLists = 0;
    let listCalls = 0;
    const drive = new Proxy(base, {
      get(target, property, receiver) {
        if (property === "list") {
          return async (...args: Parameters<MemoryDrive["list"]>) => {
            listCalls += 1;
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
    expect(listCalls).toBe(1);
    expect(maxActiveLists).toBe(1);
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

  it("keeps one remote session when two devices upload the same key", async () => {
    const first = await fixture();
    const second = await fixture();
    first.session.device = "macbook-a";
    second.session.device = "macbook-b";
    const base = new MemoryDrive();
    let initialLists = 0;
    let releaseLists: () => void = () => undefined;
    const listsReady = new Promise<void>((resolve) => {
      releaseLists = resolve;
    });
    let candidatePuts = 0;
    let releasePuts: () => void = () => undefined;
    const putsReady = new Promise<void>((resolve) => {
      releasePuts = resolve;
    });
    const drive = new Proxy(base, {
      get(target, property, receiver) {
        if (property === "list") {
          return async (...args: Parameters<MemoryDrive["list"]>) => {
            const snapshot = await target.list(...args);
            if (initialLists < 2) {
              initialLists += 1;
              if (initialLists === 2) releaseLists();
              await listsReady;
            }
            return snapshot;
          };
        }
        if (property === "put") {
          return async (...args: Parameters<MemoryDrive["put"]>) => {
            const entry = await target.put(...args);
            if (args[0].mimeType === "text/markdown") {
              candidatePuts += 1;
              if (candidatePuts === 2) releasePuts();
              await putsReady;
            }
            return entry;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const firstService = new UploadService({
      drive,
      state: first.state,
      deviceId: "device-a",
    });
    const secondService = new UploadService({
      drive,
      state: second.state,
      deviceId: "device-b",
    });

    await Promise.all([
      firstService.uploadSessions([first.session], { dryRun: false }),
      secondService.uploadSessions([second.session], { dryRun: false }),
    ]);

    const remote = await base.list({
      prefix: "inbox/",
      appProperty: {
        key: "brainhubKey",
        value: conversationKey("codex", "conversation-1"),
      },
    });
    expect(remote).toHaveLength(1);
  });

  it("keeps an uploaded candidate retryable until shared reconciliation succeeds", async () => {
    const { session, state } = await fixture();
    const base = new MemoryDrive();
    let listCalls = 0;
    const drive = new Proxy(base, {
      get(target, property, receiver) {
        if (property === "list") {
          return async (...args: Parameters<MemoryDrive["list"]>) => {
            listCalls += 1;
            if (listCalls === 2)
              throw new Error("shared reconciliation unavailable");
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
    });

    const result = await service.uploadSessions([session], { dryRun: false });

    expect(result.uploaded).toBe(0);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "UPLOAD_FAILED" }),
    );
    expect(
      state.getSession(conversationKey(session.source, session.conversationId)),
    ).toMatchObject({ status: "failed", retryable: true });
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

  it("cleans only the temporary candidate when promotion fails", async () => {
    const { session, state } = await fixture();
    const base = new MemoryDrive();
    let candidateId: string | null = null;
    const trashedIds: string[] = [];
    const drive = new Proxy(base, {
      get(target, property, receiver) {
        if (property === "put") {
          return async (...args: Parameters<MemoryDrive["put"]>) => {
            const entry = await target.put(...args);
            if (args[0].mimeType === "text/markdown") candidateId = entry.id;
            return entry;
          };
        }
        if (property === "move") {
          return async (...args: Parameters<MemoryDrive["move"]>) => {
            if (args[0] === candidateId)
              throw new Error("promotion move failed");
            return target.move(...args);
          };
        }
        if (property === "trash") {
          return async (...args: Parameters<MemoryDrive["trash"]>) => {
            trashedIds.push(args[0]);
            return target.trash(...args);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const service = new UploadService({ drive, state, deviceId: "device-1" });

    const result = await service.uploadSessions([session], { dryRun: false });

    expect(result.uploaded).toBe(0);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "UPLOAD_FAILED" }),
    );
    expect(candidateId).not.toBeNull();
    expect(trashedIds).toEqual([candidateId]);
    expect(await base.list({ prefix: "inbox/" })).toEqual([]);
  });

  it("keeps preprocessing failures retryable by source path", async () => {
    const { session, state } = await fixture();
    session.turns = [
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
    ];
    const service = new UploadService({
      drive: new MemoryDrive(),
      state,
      deviceId: "device-1",
    });

    const result = await service.uploadSessions([session], { dryRun: false });

    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "SESSION_PROCESSING_FAILED" }),
    );
    expect(
      state.getSession(conversationKey(session.source, session.conversationId)),
    ).toMatchObject({
      sourcePath: session.sourcePath,
      status: "failed",
      retryable: true,
      lastErrorCode: "SESSION_PROCESSING_FAILED",
    });
  });

  it("preserves a promoted canonical when local state persistence fails", async () => {
    const { session, state } = await fixture();
    let failMarkUploaded = true;
    const failingState = new Proxy(state, {
      get(target, property, receiver) {
        if (property === "markUploaded") {
          return (...args: Parameters<SqliteStateStore["markUploaded"]>) => {
            if (failMarkUploaded) {
              failMarkUploaded = false;
              throw new Error("state write failed");
            }
            return target.markUploaded(...args);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const drive = new MemoryDrive();
    const first = new UploadService({
      drive,
      state: failingState,
      deviceId: "device-1",
    });

    const failed = await first.uploadSessions([session], { dryRun: false });

    expect(failed.warnings).toContainEqual(
      expect.objectContaining({ code: "UPLOAD_FAILED" }),
    );
    expect(await drive.list({ prefix: "inbox/macbook/" })).toHaveLength(1);

    let retryMoves = 0;
    const retryDrive = new Proxy(drive, {
      get(target, property, receiver) {
        if (property === "move") {
          return async (...args: Parameters<MemoryDrive["move"]>) => {
            retryMoves += 1;
            return target.move(...args);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const retry = new UploadService({
      drive: retryDrive,
      state,
      deviceId: "device-1",
    });
    const repaired = await retry.uploadSessions([session], { dryRun: false });

    expect(repaired).toMatchObject({ uploaded: 0, unchanged: 1 });
    expect(retryMoves).toBe(0);
    expect(
      state.getSession(conversationKey(session.source, session.conversationId)),
    ).toMatchObject({ status: "uploaded", retryable: false });
  });

  it("preserves the winner when loser cleanup fails and converges on retry", async () => {
    const { session, state } = await fixture();
    const base = new MemoryDrive();
    const loser = await base.put({
      path: "inbox/other/older.md",
      bytes: Buffer.from("older"),
      mimeType: "text/markdown",
      appProperties: {
        brainhubKey: conversationKey(session.source, session.conversationId),
        source: session.source,
        conversationId: session.conversationId,
        deviceId: "other",
        updatedAt: "2026-07-17T00:00:00.000Z",
        contentSha256: "0".repeat(64),
      },
    });
    let failLoserCleanup = true;
    const failingDrive = new Proxy(base, {
      get(target, property, receiver) {
        if (property === "trash") {
          return async (id: string) => {
            if (id === loser.id && failLoserCleanup) {
              failLoserCleanup = false;
              throw new Error("loser cleanup failed");
            }
            return target.trash(id);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const first = new UploadService({
      drive: failingDrive,
      state,
      deviceId: "device-1",
    });

    const failed = await first.uploadSessions([session], { dryRun: false });

    expect(failed.warnings).toContainEqual(
      expect.objectContaining({ code: "UPLOAD_FAILED" }),
    );
    expect(
      await base.list({
        prefix: "inbox/",
        appProperty: {
          key: "brainhubKey",
          value: conversationKey(session.source, session.conversationId),
        },
      }),
    ).toHaveLength(2);

    const retry = new UploadService({
      drive: base,
      state,
      deviceId: "device-1",
    });
    const repaired = await retry.uploadSessions([session], { dryRun: false });

    expect(repaired).toMatchObject({ uploaded: 0, unchanged: 1 });
    expect(
      await base.list({
        prefix: "inbox/",
        appProperty: {
          key: "brainhubKey",
          value: conversationKey(session.source, session.conversationId),
        },
      }),
    ).toHaveLength(1);
    expect(
      state.getSession(conversationKey(session.source, session.conversationId)),
    ).toMatchObject({ status: "uploaded" });
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
            if (input.path.startsWith("inbox/_assets/sha256/")) {
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

  it("retries a shared image after a transient upload failure", async () => {
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
    let imagePuts = 0;
    const drive = new Proxy(base, {
      get(target, property, receiver) {
        if (property === "put") {
          return async (...args: Parameters<MemoryDrive["put"]>) => {
            const [input] = args;
            if (input.path.startsWith("inbox/_assets/sha256/")) {
              imagePuts += 1;
              if (imagePuts === 1)
                throw new Error("transient Drive upload failure");
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
      concurrency: 1,
    });

    const result = await service.uploadSessions(sessions, { dryRun: false });

    expect(result.uploaded).toBe(1);
    expect(imagePuts).toBe(2);
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
