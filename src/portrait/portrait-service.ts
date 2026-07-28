import { BrainHubError } from "../domain/errors.js";
import type { DrivePort } from "../drive/drive-port.js";

export const DIGITAL_TWIN_PROFILE_PATH = "Digital_Twin_Profile.md";

export class PortraitService {
  readonly #drive: DrivePort;
  readonly #path: string;

  constructor(options: { drive: DrivePort; path?: string }) {
    this.#drive = options.drive;
    this.#path = options.path ?? DIGITAL_TWIN_PROFILE_PATH;
  }

  async getPortrait(): Promise<{ portrait: string }> {
    const object = await this.#drive.readPath(this.#path);
    if (!object) {
      throw new BrainHubError(
        "SOURCE_UNAVAILABLE",
        `Drive portrait source ${this.#path} is not available`,
      );
    }
    return { portrait: object.bytes.toString("utf8") };
  }
}
