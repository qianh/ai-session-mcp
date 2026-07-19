import { randomUUID } from "node:crypto";
import { lstat, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BrainHubError } from "../domain/errors.js";
import type { DrivePort } from "../drive/drive-port.js";
import {
  discoverPublishDirectory,
  type PublishDiscoveryOptions,
} from "./obsidian.js";

export interface PortraitOutput {
  portrait: string;
  localRefreshed: boolean;
  localPath?: string;
  diff?: string | undefined;
  weeklyRefreshed?: boolean;
  warnings: Array<{ code: string; message: string }>;
}

async function atomicWrite(path: string, content: Buffer): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function assertReplaceable(path: string): Promise<void> {
  try {
    if (!(await lstat(path)).isFile()) {
      throw new Error(`Publish target is not a regular file: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function atomicWritePair(
  files: Array<{ path: string; content: Buffer }>,
): Promise<void> {
  await Promise.all(files.map((file) => assertReplaceable(file.path)));
  const transaction = randomUUID();
  const staged = files.map((file) => ({
    ...file,
    temporary: `${file.path}.${transaction}.tmp`,
    backup: `${file.path}.${transaction}.backup`,
  }));
  try {
    await Promise.all(
      staged.map((file) =>
        writeFile(file.temporary, file.content, { mode: 0o600 }),
      ),
    );
  } catch (error) {
    await Promise.all(
      staged.map((file) => unlink(file.temporary).catch(() => undefined)),
    );
    throw error;
  }

  const backedUp: typeof staged = [];
  const committed: typeof staged = [];
  try {
    for (const file of staged) {
      try {
        await rename(file.path, file.backup);
        backedUp.push(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const file of staged) {
      await rename(file.temporary, file.path);
      committed.push(file);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const file of committed.reverse()) {
      await unlink(file.path).catch((rollbackError) =>
        rollbackErrors.push(rollbackError),
      );
    }
    for (const file of backedUp.reverse()) {
      await rename(file.backup, file.path).catch((rollbackError) =>
        rollbackErrors.push(rollbackError),
      );
    }
    await Promise.all(
      staged.map((file) => unlink(file.temporary).catch(() => undefined)),
    );
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        rollbackErrors,
        "Publish pair failed and could not be fully rolled back",
        { cause: error },
      );
    }
    throw error;
  }
  await Promise.all(
    backedUp.map((file) => unlink(file.backup).catch(() => undefined)),
  );
}

function diffSection(markdown: string): string | undefined {
  return /^##\s+(?:变更\s*Diff|本期变化|Diff)\s*\r?\n([\s\S]*?)(?=^##\s|(?![\s\S]))/imu
    .exec(markdown)?.[1]
    ?.trim();
}

export class PortraitService {
  readonly #drive: DrivePort;
  readonly #publish: PublishDiscoveryOptions;

  constructor(options: { drive: DrivePort; publish: PublishDiscoveryOptions }) {
    this.#drive = options.drive;
    this.#publish = options.publish;
  }

  async #readPortrait(): Promise<{ bytes: Buffer; text: string }> {
    const object = await this.#drive.readPath("publish/portrait.md");
    if (!object)
      throw new BrainHubError(
        "SOURCE_UNAVAILABLE",
        "Drive portrait has not been published yet",
      );
    return { bytes: object.bytes, text: object.bytes.toString("utf8") };
  }

  async getPortrait(): Promise<PortraitOutput> {
    const portrait = await this.#readPortrait();
    const warnings: PortraitOutput["warnings"] = [];
    const directory = await discoverPublishDirectory(this.#publish);
    if (!directory) {
      warnings.push({
        code: "PUBLISH_PATH_REQUIRED",
        message:
          "No active Obsidian vault or writable publish fallback was found",
      });
      return {
        portrait: portrait.text,
        localRefreshed: false,
        diff: diffSection(portrait.text),
        warnings,
      };
    }
    const path = join(directory, "portrait.md");
    try {
      await atomicWrite(path, portrait.bytes);
      return {
        portrait: portrait.text,
        localRefreshed: true,
        localPath: path,
        diff: diffSection(portrait.text),
        warnings,
      };
    } catch {
      warnings.push({
        code: "PUBLISH_WRITE_FAILED",
        message: "Portrait was read from Drive but local refresh failed",
      });
      return {
        portrait: portrait.text,
        localRefreshed: false,
        diff: diffSection(portrait.text),
        warnings,
      };
    }
  }

  async pullPortrait(): Promise<PortraitOutput> {
    const portrait = await this.#readPortrait();
    const weekly = await this.#drive.readPath("publish/weekly-latest.md");
    const warnings: PortraitOutput["warnings"] = [];
    if (!weekly)
      warnings.push({
        code: "SOURCE_UNAVAILABLE",
        message: "Drive weekly-latest.md is not available",
      });
    if (!weekly) {
      return {
        portrait: portrait.text,
        localRefreshed: false,
        weeklyRefreshed: false,
        diff: diffSection(portrait.text),
        warnings,
      };
    }
    const directory = await discoverPublishDirectory(this.#publish);
    if (!directory) {
      warnings.push({
        code: "PUBLISH_PATH_REQUIRED",
        message: "No writable publish directory was found",
      });
      return {
        portrait: portrait.text,
        localRefreshed: false,
        weeklyRefreshed: false,
        diff: diffSection(portrait.text),
        warnings,
      };
    }
    try {
      await atomicWritePair([
        { path: join(directory, "portrait.md"), content: portrait.bytes },
        { path: join(directory, "weekly-latest.md"), content: weekly.bytes },
      ]);
      return {
        portrait: portrait.text,
        localRefreshed: true,
        localPath: join(directory, "portrait.md"),
        weeklyRefreshed: true,
        diff: diffSection(portrait.text),
        warnings,
      };
    } catch {
      warnings.push({
        code: "PUBLISH_WRITE_FAILED",
        message: "Atomic local publish failed",
      });
      return {
        portrait: portrait.text,
        localRefreshed: false,
        weeklyRefreshed: false,
        diff: diffSection(portrait.text),
        warnings,
      };
    }
  }
}
