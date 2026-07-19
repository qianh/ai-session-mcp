import { createHash } from "node:crypto";

import type {
  DriveEntry,
  DriveListQuery,
  DriveObject,
  DrivePort,
  DrivePutInput,
  DriveQuota,
} from "./drive-port.js";

interface StoredObject extends DriveObject {
  trashed: boolean;
}

export class MemoryDrive implements DrivePort {
  readonly #objects = new Map<string, StoredObject>();
  readonly #corruptReads: boolean;
  #counter = 0;

  constructor(options: { corruptReads?: boolean } = {}) {
    this.#corruptReads = options.corruptReads ?? false;
  }

  #entry(object: StoredObject): DriveEntry {
    return {
      id: object.id,
      path: object.path,
      mimeType: object.mimeType,
      size: object.size,
      modifiedTime: object.modifiedTime,
      etag: object.etag,
      appProperties: { ...object.appProperties },
    };
  }

  #create(input: DrivePutInput, id?: string): StoredObject {
    const bytes = Buffer.from(input.bytes);
    const objectId = id ?? `file-${String(++this.#counter).padStart(8, "0")}`;
    return {
      id: objectId,
      path: input.path,
      bytes,
      mimeType: input.mimeType,
      size: bytes.length,
      modifiedTime: new Date().toISOString(),
      etag: createHash("sha256")
        .update(bytes)
        .update(String(this.#counter))
        .digest("hex"),
      appProperties: { ...input.appProperties },
      trashed: false,
    };
  }

  async list(query: DriveListQuery): Promise<DriveEntry[]> {
    return [...this.#objects.values()]
      .filter((object) => !object.trashed)
      .filter((object) => !query.prefix || object.path.startsWith(query.prefix))
      .filter(
        (object) =>
          !query.appProperty ||
          object.appProperties[query.appProperty.key] ===
            query.appProperty.value,
      )
      .filter(
        (object) =>
          !query.modifiedAfter || object.modifiedTime > query.modifiedAfter,
      )
      .sort(
        (left, right) =>
          left.path.localeCompare(right.path) ||
          left.id.localeCompare(right.id),
      )
      .map((object) => this.#entry(object));
  }

  async put(input: DrivePutInput): Promise<DriveEntry> {
    const object = this.#create(input);
    this.#objects.set(object.id, object);
    return this.#entry(object);
  }

  async upsert(input: DrivePutInput): Promise<DriveEntry> {
    const existing = [...this.#objects.values()].find(
      (object) => !object.trashed && object.path === input.path,
    );
    if (input.ifMatch && existing?.etag !== input.ifMatch) {
      const error = new Error("Drive precondition failed") as Error & {
        code: number;
      };
      error.code = 412;
      throw error;
    }
    const object = this.#create(input, existing?.id);
    this.#objects.set(object.id, object);
    return this.#entry(object);
  }

  async read(id: string): Promise<DriveObject> {
    const object = this.#objects.get(id);
    if (!object || object.trashed)
      throw new Error(`Drive object not found: ${id}`);
    const bytes = this.#corruptReads
      ? Buffer.concat([object.bytes, Buffer.from("corrupt")])
      : Buffer.from(object.bytes);
    return { ...this.#entry(object), bytes };
  }

  async readPath(path: string): Promise<DriveObject | null> {
    const object = [...this.#objects.values()]
      .filter((candidate) => !candidate.trashed && candidate.path === path)
      .sort((left, right) => right.id.localeCompare(left.id))[0];
    return object ? this.read(object.id) : null;
  }

  async move(id: string, path: string): Promise<DriveEntry> {
    const object = this.#objects.get(id);
    if (!object || object.trashed)
      throw new Error(`Drive object not found: ${id}`);
    object.path = path;
    object.modifiedTime = new Date().toISOString();
    return this.#entry(object);
  }

  async trash(id: string): Promise<void> {
    const object = this.#objects.get(id);
    if (object) object.trashed = true;
  }

  async quota(): Promise<DriveQuota> {
    const usedBytes = [...this.#objects.values()]
      .filter((object) => !object.trashed)
      .reduce((sum, object) => sum + object.size, 0);
    return { usedBytes, totalBytes: 15 * 1024 ** 3 };
  }
}
