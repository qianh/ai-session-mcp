import { open, readFile, unlink, type FileHandle } from "node:fs/promises";

import { BrainHubError } from "../domain/errors.js";

export class UploadLock {
  #handle: FileHandle | null = null;

  constructor(readonly path: string) {}

  async #ownerIsAlive(): Promise<boolean> {
    let contents: string;
    try {
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
    const pid = Number(contents.trim().split(/\s/u)[0]);
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  async acquire(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(this.path, "wx", 0o600);
        try {
          await handle.writeFile(`${process.pid}\n`);
          this.#handle = handle;
          return;
        } catch (error) {
          await handle.close().catch(() => undefined);
          await unlink(this.path).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await this.#ownerIsAlive()) {
          throw new BrainHubError(
            "UPLOAD_BUSY",
            "Another BrainHub upload is running",
          );
        }
        await unlink(this.path).catch((unlinkError: NodeJS.ErrnoException) => {
          if (unlinkError.code !== "ENOENT") throw unlinkError;
        });
      }
    }
    throw new BrainHubError(
      "UPLOAD_BUSY",
      "Another BrainHub upload is running",
    );
  }

  async release(): Promise<void> {
    if (!this.#handle) return;
    await this.#handle.close();
    this.#handle = null;
    await unlink(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
