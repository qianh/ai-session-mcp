import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BrainHubError } from "../domain/errors.js";
import type { DrivePort } from "../drive/drive-port.js";
import {
  discoverPublishDirectory,
  type PublishDiscoveryOptions,
} from "./obsidian.js";

export interface PortraitSyncOutput {
  synced: boolean;
  path?: string;
  warnings: Array<{ code: string; message: string }>;
}

export class PortraitSyncService {
  readonly #portraitSource: { drive: DrivePort; path: string };
  readonly #publish: PublishDiscoveryOptions;

  constructor(options: {
    portraitSource: { drive: DrivePort; path: string };
    publish: PublishDiscoveryOptions;
  }) {
    this.#portraitSource = options.portraitSource;
    this.#publish = options.publish;
  }

  async sync(): Promise<PortraitSyncOutput> {
    const portrait = await this.#portraitSource.drive.readPath(
      this.#portraitSource.path,
    );
    if (!portrait) {
      throw new BrainHubError(
        "SOURCE_UNAVAILABLE",
        `Drive portrait source ${this.#portraitSource.path} is not available`,
      );
    }
    const directory = await discoverPublishDirectory(this.#publish);
    if (!directory) {
      return {
        synced: false,
        warnings: [
          {
            code: "PUBLISH_PATH_REQUIRED",
            message: "No writable Obsidian BrainHub directory was found",
          },
        ],
      };
    }

    const path = join(directory, "portrait.md");
    const temporary = join(directory, `.portrait.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, portrait.bytes, { mode: 0o600 });
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    return { synced: true, path, warnings: [] };
  }
}
