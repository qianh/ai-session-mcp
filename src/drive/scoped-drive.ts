import { posix } from "node:path";

import { BrainHubError } from "../domain/errors.js";
import type {
  DriveEntry,
  DriveChanges,
  DriveListQuery,
  DriveObject,
  DrivePort,
  DrivePutInput,
  DriveQuota,
} from "./drive-port.js";

const inboxPrefix = "inbox/";

function inboxPath(path: string): string {
  const normalized = posix.normalize(path);
  if (
    path.includes("\\") ||
    normalized.startsWith("/") ||
    !normalized.startsWith(inboxPrefix)
  ) {
    throw new BrainHubError(
      "INVALID_INPUT",
      "Session upload is restricted to the Drive inbox",
    );
  }
  return normalized;
}

export class InboxScopedDrive implements DrivePort {
  readonly #drive: DrivePort;
  readonly #knownIds = new Set<string>();

  constructor(drive: DrivePort) {
    this.#drive = drive;
  }

  #register<Entry extends DriveEntry>(entry: Entry): Entry | null {
    try {
      inboxPath(entry.path);
    } catch {
      return null;
    }
    this.#knownIds.add(entry.id);
    return entry;
  }

  #requireKnown(id: string): void {
    if (!this.#knownIds.has(id)) {
      throw new BrainHubError(
        "INVALID_INPUT",
        "Drive object is outside the session upload inbox",
      );
    }
  }

  async list(query: DriveListQuery): Promise<DriveEntry[]> {
    const prefix = query.prefix ? inboxPath(query.prefix) : inboxPrefix;
    const entries = await this.#drive.list({ ...query, prefix });
    return entries.flatMap((entry) => {
      const registered = this.#register(entry);
      return registered ? [registered] : [];
    });
  }

  async changes(query: {
    prefix: string;
    cursor?: string;
  }): Promise<DriveChanges> {
    const prefix = query.prefix ? inboxPath(query.prefix) : inboxPrefix;
    const changes = await this.#drive.changes({
      prefix,
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
    const entries = changes.entries.flatMap((entry) => {
      const registered = this.#register(entry);
      return registered ? [registered] : [];
    });
    for (const id of changes.removedIds) this.#knownIds.delete(id);
    return { ...changes, entries };
  }

  async put(input: DrivePutInput): Promise<DriveEntry> {
    const entry = await this.#drive.put({
      ...input,
      path: inboxPath(input.path),
    });
    const registered = this.#register(entry);
    if (!registered) {
      throw new BrainHubError(
        "INVALID_INPUT",
        "Drive returned an object outside inbox",
      );
    }
    return registered;
  }

  async upsert(input: DrivePutInput): Promise<DriveEntry> {
    const entry = await this.#drive.upsert({
      ...input,
      path: inboxPath(input.path),
    });
    const registered = this.#register(entry);
    if (!registered) {
      throw new BrainHubError(
        "INVALID_INPUT",
        "Drive returned an object outside inbox",
      );
    }
    return registered;
  }

  async read(id: string): Promise<DriveObject> {
    this.#requireKnown(id);
    const object = await this.#drive.read(id);
    const registered = this.#register(object);
    if (!registered) {
      throw new BrainHubError(
        "INVALID_INPUT",
        "Drive returned an object outside inbox",
      );
    }
    return registered;
  }

  async readPath(path: string): Promise<DriveObject | null> {
    const object = await this.#drive.readPath(inboxPath(path));
    if (!object) return null;
    const registered = this.#register(object);
    if (!registered) {
      throw new BrainHubError(
        "INVALID_INPUT",
        "Drive returned an object outside inbox",
      );
    }
    return registered;
  }

  async move(id: string, path: string): Promise<DriveEntry> {
    this.#requireKnown(id);
    const entry = await this.#drive.move(id, inboxPath(path));
    const registered = this.#register(entry);
    if (!registered) {
      throw new BrainHubError(
        "INVALID_INPUT",
        "Drive returned an object outside inbox",
      );
    }
    return registered;
  }

  async trash(id: string): Promise<void> {
    this.#requireKnown(id);
    await this.#drive.trash(id);
    this.#knownIds.delete(id);
  }

  quota(): Promise<DriveQuota> {
    return this.#drive.quota();
  }
}
