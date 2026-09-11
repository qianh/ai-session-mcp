import { BrainHubError } from "../domain/errors.js";
import type { DrivePort } from "../drive/drive-port.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const DIGITAL_TWIN_PROFILE_PATH = "Digital_Twin_Profile.md";

export class PortraitService {
  readonly #drive: DrivePort;
  readonly #path: string;

  readonly #outputPath?: string;
  constructor(options: {
    drive: DrivePort;
    path?: string;
    outputPath?: string;
  }) {
    this.#drive = options.drive;
    this.#path = options.path ?? DIGITAL_TWIN_PROFILE_PATH;
    if (options.outputPath) this.#outputPath = options.outputPath;
  }

  async getPortrait(): Promise<{ portrait: string }> {
    const object = await this.#drive.readPath(this.#path);
    if (!object) {
      throw new BrainHubError(
        "SOURCE_UNAVAILABLE",
        `Drive portrait source ${this.#path} is not available`,
      );
    }
    const portrait = object.bytes.toString("utf8");
    if (this.#outputPath) {
      await mkdir(dirname(this.#outputPath), { recursive: true });
      await writeFile(this.#outputPath, object.bytes, { mode: 0o600 });
    }
    return { portrait };
  }
}
