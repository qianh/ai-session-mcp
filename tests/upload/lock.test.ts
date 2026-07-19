import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { UploadLock } from "../../src/upload/lock.js";

describe("upload lock", () => {
  it("prevents overlapping processes and releases in finally", async () => {
    const directory = await mkdtemp(join(tmpdir(), "brainhub-lock-"));
    const path = join(directory, "upload.lock");
    const first = new UploadLock(path);
    const second = new UploadLock(path);
    await first.acquire();
    await expect(second.acquire()).rejects.toMatchObject({
      code: "UPLOAD_BUSY",
    });
    await first.release();
    await expect(second.acquire()).resolves.toBeUndefined();
    await second.release();
  });

  it("reclaims a lock left by a process that no longer exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "brainhub-lock-"));
    const path = join(directory, "upload.lock");
    await writeFile(path, "999999\n", { mode: 0o600 });
    const lock = new UploadLock(path);

    await expect(lock.acquire()).resolves.toBeUndefined();

    await lock.release();
  });
});
