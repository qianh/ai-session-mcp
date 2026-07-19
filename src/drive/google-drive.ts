import { Readable } from "node:stream";
import { posix } from "node:path";

import type { drive_v3 } from "googleapis";

import { BrainHubError } from "../domain/errors.js";
import type {
  DriveEntry,
  DriveListQuery,
  DriveObject,
  DrivePort,
  DrivePutInput,
  DriveQuota,
} from "./drive-port.js";

const folderMimeType = "application/vnd.google-apps.folder";
const fileFields =
  "id,name,mimeType,parents,size,modifiedTime,appProperties,version,trashed";

function safePath(value: string): string {
  if (!value || value.startsWith("/") || value.includes("\\")) {
    throw new BrainHubError(
      "INVALID_INPUT",
      "Drive path must be relative to the BrainHub root",
    );
  }
  const normalized = posix.normalize(value);
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized === "."
  ) {
    throw new BrainHubError(
      "INVALID_INPUT",
      "Drive path escapes the BrainHub root",
    );
  }
  return normalized;
}

function escapeQuery(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    const value = (getter as (key: string) => unknown).call(headers, name);
    return typeof value === "string" ? value : undefined;
  }
  const value = (headers as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

export class GoogleDrive implements DrivePort {
  readonly #client: drive_v3.Drive;
  readonly #rootFolderId: string;

  constructor(options: { client: drive_v3.Drive; rootFolderId: string }) {
    if (!options.rootFolderId) {
      throw new BrainHubError(
        "DRIVE_ROOT_REQUIRED",
        "Drive root folder is not configured",
      );
    }
    this.#client = options.client;
    this.#rootFolderId = options.rootFolderId;
  }

  static async createRoot(
    client: drive_v3.Drive,
    name: string,
  ): Promise<string> {
    const q = `name = '${escapeQuery(name)}' and mimeType = '${folderMimeType}' and trashed = false`;
    const existing = await client.files.list({
      q,
      fields: "files(id)",
      spaces: "drive",
    });
    const id = existing.data.files?.[0]?.id;
    if (id) return id;
    const created = await client.files.create({
      requestBody: { name, mimeType: folderMimeType },
      fields: "id",
    });
    if (!created.data.id)
      throw new Error("Google Drive did not return a root folder ID");
    return created.data.id;
  }

  async #metadataResponse(id: string) {
    return this.#client.files.get({
      fileId: id,
      fields: fileFields,
      supportsAllDrives: true,
    });
  }

  async #metadata(id: string): Promise<drive_v3.Schema$File> {
    return (await this.#metadataResponse(id)).data;
  }

  async #assertDescendant(id: string): Promise<void> {
    let current = id;
    const visited = new Set<string>();
    while (current !== this.#rootFolderId) {
      if (visited.has(current)) throw new Error("Drive parent cycle detected");
      visited.add(current);
      const metadata = await this.#metadata(current);
      const parent = metadata.parents?.[0];
      if (!parent)
        throw new BrainHubError(
          "INVALID_INPUT",
          "Drive object is outside the BrainHub root",
        );
      current = parent;
    }
  }

  async #children(parentId: string): Promise<drive_v3.Schema$File[]> {
    const files: drive_v3.Schema$File[] = [];
    let pageToken: string | undefined;
    do {
      const response = await this.#client.files.list({
        q: `'${escapeQuery(parentId)}' in parents and trashed = false`,
        fields: `nextPageToken,files(${fileFields})`,
        ...(pageToken ? { pageToken } : {}),
        spaces: "drive",
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      });
      files.push(...(response.data.files ?? []));
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);
    return files;
  }

  async #resolve(path: string): Promise<drive_v3.Schema$File | null> {
    const normalized = safePath(path);
    let parent = this.#rootFolderId;
    let found: drive_v3.Schema$File | null = null;
    for (const segment of normalized.split("/")) {
      const children = await this.#children(parent);
      found =
        children
          .filter((file) => file.name === segment)
          .sort((left, right) =>
            String(right.id).localeCompare(String(left.id)),
          )[0] ?? null;
      if (!found?.id) return null;
      parent = found.id;
    }
    return found;
  }

  async #ensureFolder(path: string): Promise<string> {
    if (!path) return this.#rootFolderId;
    const normalized = safePath(path);
    let parent = this.#rootFolderId;
    for (const segment of normalized.split("/")) {
      const child = (await this.#children(parent)).find(
        (file) => file.name === segment && file.mimeType === folderMimeType,
      );
      if (child?.id) {
        parent = child.id;
        continue;
      }
      const created = await this.#client.files.create({
        requestBody: {
          name: segment,
          mimeType: folderMimeType,
          parents: [parent],
        },
        fields: "id",
        supportsAllDrives: true,
      });
      if (!created.data.id)
        throw new Error("Google Drive did not return a folder ID");
      parent = created.data.id;
    }
    return parent;
  }

  async #entry(
    file: drive_v3.Schema$File,
    path: string,
    etag?: string,
  ): Promise<DriveEntry> {
    if (!file.id) throw new Error("Google Drive file is missing an ID");
    return {
      id: file.id,
      path,
      mimeType: file.mimeType ?? "application/octet-stream",
      size: Number(file.size ?? 0),
      modifiedTime: file.modifiedTime ?? new Date(0).toISOString(),
      etag: etag ?? String(file.version ?? ""),
      appProperties: file.appProperties ?? {},
    };
  }

  async #walk(): Promise<Array<{ file: drive_v3.Schema$File; path: string }>> {
    const output: Array<{ file: drive_v3.Schema$File; path: string }> = [];
    const queue: Array<{ id: string; path: string }> = [
      { id: this.#rootFolderId, path: "" },
    ];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const file of await this.#children(current.id)) {
        if (!file.id || !file.name) continue;
        const path = current.path ? `${current.path}/${file.name}` : file.name;
        if (file.mimeType === folderMimeType) queue.push({ id: file.id, path });
        else output.push({ file, path });
      }
    }
    return output;
  }

  async list(query: DriveListQuery): Promise<DriveEntry[]> {
    if (query.prefix) safePath(query.prefix.replace(/\/$/u, "") || "invalid");
    let files: Array<{ file: drive_v3.Schema$File; path: string }>;
    if (query.appProperty) {
      const { key, value } = query.appProperty;
      const response = await this.#client.files.list({
        q: `appProperties has { key='${escapeQuery(key)}' and value='${escapeQuery(value)}' } and trashed = false`,
        fields: `files(${fileFields})`,
        spaces: "drive",
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      });
      files = [];
      for (const file of response.data.files ?? []) {
        if (!file.id) continue;
        try {
          await this.#assertDescendant(file.id);
        } catch {
          continue;
        }
        files.push({ file, path: await this.#pathFor(file.id) });
      }
    } else {
      files = await this.#walk();
    }
    return Promise.all(
      files
        .filter(({ path }) => !query.prefix || path.startsWith(query.prefix))
        .filter(
          ({ file }) =>
            !query.modifiedAfter ||
            (file.modifiedTime ?? "") > query.modifiedAfter,
        )
        .map(({ file, path }) => this.#entry(file, path)),
    );
  }

  async #pathFor(id: string): Promise<string> {
    const segments: string[] = [];
    let current = id;
    while (current !== this.#rootFolderId) {
      const file = await this.#metadata(current);
      if (!file.name || !file.parents?.[0]) {
        throw new BrainHubError(
          "INVALID_INPUT",
          "Drive object is outside the BrainHub root",
        );
      }
      segments.unshift(file.name);
      current = file.parents[0];
    }
    return segments.join("/");
  }

  async put(input: DrivePutInput): Promise<DriveEntry> {
    const path = safePath(input.path);
    const parent = await this.#ensureFolder(
      posix.dirname(path) === "." ? "" : posix.dirname(path),
    );
    const response = await this.#client.files.create({
      requestBody: {
        name: posix.basename(path),
        parents: [parent],
        ...(input.appProperties ? { appProperties: input.appProperties } : {}),
      },
      media: { mimeType: input.mimeType, body: Readable.from(input.bytes) },
      fields: fileFields,
      supportsAllDrives: true,
    });
    return this.#entry(response.data, path);
  }

  async upsert(input: DrivePutInput): Promise<DriveEntry> {
    const path = safePath(input.path);
    const existing = await this.#resolve(path);
    if (!existing?.id) return this.put(input);
    await this.#assertDescendant(existing.id);
    const current = await this.#metadataResponse(existing.id);
    const currentEtag = headerValue(current.headers, "etag");
    if (input.ifMatch && currentEtag !== input.ifMatch) {
      const error = new Error("Drive precondition failed") as Error & {
        code: number;
      };
      error.code = 412;
      throw error;
    }
    const response = await this.#client.files.update(
      {
        fileId: existing.id,
        requestBody: input.appProperties
          ? { appProperties: input.appProperties }
          : {},
        media: { mimeType: input.mimeType, body: Readable.from(input.bytes) },
        fields: fileFields,
        supportsAllDrives: true,
      },
      input.ifMatch ? { headers: { "If-Match": input.ifMatch } } : undefined,
    );
    return this.#entry(response.data, path);
  }

  async read(id: string): Promise<DriveObject> {
    await this.#assertDescendant(id);
    const [metadata, content] = await Promise.all([
      this.#metadataResponse(id),
      this.#client.files.get(
        { fileId: id, alt: "media", supportsAllDrives: true },
        { responseType: "arraybuffer" },
      ),
    ]);
    const path = await this.#pathFor(id);
    return {
      ...(await this.#entry(
        metadata.data,
        path,
        headerValue(metadata.headers, "etag"),
      )),
      bytes: Buffer.from(content.data as ArrayBuffer),
    };
  }

  async readPath(path: string): Promise<DriveObject | null> {
    const file = await this.#resolve(path);
    return file?.id ? this.read(file.id) : null;
  }

  async move(id: string, pathValue: string): Promise<DriveEntry> {
    const path = safePath(pathValue);
    await this.#assertDescendant(id);
    const metadata = await this.#metadata(id);
    const parent = await this.#ensureFolder(
      posix.dirname(path) === "." ? "" : posix.dirname(path),
    );
    const response = await this.#client.files.update({
      fileId: id,
      addParents: parent,
      ...(metadata.parents?.length
        ? { removeParents: metadata.parents.join(",") }
        : {}),
      requestBody: { name: posix.basename(path) },
      fields: fileFields,
      supportsAllDrives: true,
    });
    return this.#entry(response.data, path);
  }

  async trash(id: string): Promise<void> {
    await this.#assertDescendant(id);
    await this.#client.files.update({
      fileId: id,
      requestBody: { trashed: true },
      supportsAllDrives: true,
    });
  }

  async quota(): Promise<DriveQuota> {
    const response = await this.#client.about.get({ fields: "storageQuota" });
    return {
      usedBytes: Number(response.data.storageQuota?.usage ?? 0),
      totalBytes: Number(response.data.storageQuota?.limit ?? 0),
    };
  }
}
