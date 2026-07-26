import { describe, expect, it } from "vitest";

import { GoogleDrive } from "../../src/drive/google-drive.js";

const folderMimeType = "application/vnd.google-apps.folder";

function createConcurrentDriveClient() {
  interface StoredFile {
    id: string;
    name: string;
    mimeType: string;
    parents: string[];
    size: string;
    modifiedTime: string;
    appProperties: Record<string, string>;
    version: string;
    trashed: boolean;
  }

  const files: StoredFile[] = [];
  let nextId = 0;
  const client = {
    files: {
      list: async (request: { q?: string }) => {
        const parent = /^'([^']+)' in parents/u.exec(request.q ?? "")?.[1];
        return {
          data: {
            files: files
              .filter((file) => file.parents.includes(parent ?? ""))
              .map((file) => ({ ...file })),
          },
        };
      },
      create: async (request: {
        requestBody?: {
          name?: string;
          mimeType?: string;
          parents?: string[];
          appProperties?: Record<string, string>;
        };
        media?: unknown;
      }) => {
        const body = request.requestBody;
        if (!body?.name) throw new Error("missing file name");
        const file: StoredFile = {
          id: `file-${(nextId += 1)}`,
          name: body.name,
          mimeType: body.mimeType ?? "application/octet-stream",
          parents: body.parents ?? [],
          size: request.media ? "1" : "0",
          modifiedTime: "2026-07-20T00:00:00.000Z",
          appProperties: body.appProperties ?? {},
          version: "1",
          trashed: false,
        };
        files.push(file);
        return { data: { ...file } };
      },
    },
  };
  return { client, files };
}

describe("Google Drive boundary", () => {
  it("scopes app-property listing to the requested prefix subtree", async () => {
    const entries = [
      {
        id: "inbox",
        name: "inbox",
        mimeType: folderMimeType,
        parents: ["root"],
        appProperties: {},
      },
      {
        id: "device",
        name: "device",
        mimeType: folderMimeType,
        parents: ["inbox"],
        appProperties: {},
      },
      {
        id: "inside",
        name: "inside.md",
        mimeType: "text/markdown",
        parents: ["device"],
        appProperties: { brainhubKey: "shared" },
      },
      {
        id: "sessions",
        name: "sessions",
        mimeType: folderMimeType,
        parents: ["root"],
        appProperties: {},
      },
      {
        id: "outside",
        name: "outside.md",
        mimeType: "text/markdown",
        parents: ["sessions"],
        appProperties: { brainhubKey: "shared" },
      },
    ].map((entry) => ({
      ...entry,
      size: "1",
      modifiedTime: "2026-07-26T00:00:00.000Z",
      version: "1",
      trashed: false,
    }));
    const metadataGets: string[] = [];
    const queries: string[] = [];
    const pageSizes: number[] = [];
    const client = {
      files: {
        list: async (request: { q?: string; pageSize?: number }) => {
          const query = request.q ?? "";
          queries.push(query);
          pageSizes.push(request.pageSize ?? 0);
          if (query.includes("appProperties has")) {
            return {
              data: {
                files: entries.filter(
                  (entry) => entry.appProperties.brainhubKey === "shared",
                ),
              },
            };
          }
          const parent = /^'([^']+)' in parents/u.exec(query)?.[1];
          return {
            data: {
              files: entries.filter((entry) =>
                entry.parents.includes(parent ?? ""),
              ),
            },
          };
        },
        get: async (request: { fileId?: string }) => {
          metadataGets.push(request.fileId ?? "");
          const entry = entries.find(
            (candidate) => candidate.id === request.fileId,
          );
          if (!entry) throw new Error(`missing ${request.fileId}`);
          return { data: entry, headers: { etag: "etag" } };
        },
      },
    };
    const drive = new GoogleDrive({
      client: client as never,
      rootFolderId: "root",
    });

    const result = await drive.list({
      prefix: "inbox/",
      appProperty: { key: "brainhubKey", value: "shared" },
    });

    expect(result.map((entry) => entry.path)).toEqual([
      "inbox/device/inside.md",
    ]);
    expect(metadataGets).not.toContain("outside");
    expect(queries.some((query) => query.includes("appProperties has"))).toBe(
      false,
    );
    expect(pageSizes.every((pageSize) => pageSize === 1_000)).toBe(true);
  });

  it("lists candidates from every duplicate prefix folder", async () => {
    const entries = [
      {
        id: "inbox-a",
        name: "inbox",
        mimeType: folderMimeType,
        parents: ["root"],
        appProperties: {},
      },
      {
        id: "inbox-b",
        name: "inbox",
        mimeType: folderMimeType,
        parents: ["root"],
        appProperties: {},
      },
      {
        id: "device-a",
        name: "mac-a",
        mimeType: folderMimeType,
        parents: ["inbox-a"],
        appProperties: {},
      },
      {
        id: "device-b",
        name: "mac-b",
        mimeType: folderMimeType,
        parents: ["inbox-b"],
        appProperties: {},
      },
      {
        id: "inside-a",
        name: "candidate-a.md",
        mimeType: "text/markdown",
        parents: ["device-a"],
        appProperties: { brainhubKey: "shared" },
      },
      {
        id: "inside-b",
        name: "candidate-b.md",
        mimeType: "text/markdown",
        parents: ["device-b"],
        appProperties: { brainhubKey: "shared" },
      },
    ].map((entry) => ({
      ...entry,
      size: "1",
      modifiedTime: "2026-07-26T00:00:00.000Z",
      version: "1",
      trashed: false,
    }));
    const client = {
      files: {
        list: async (request: { q?: string }) => {
          const parent = /^'([^']+)' in parents/u.exec(request.q ?? "")?.[1];
          return {
            data: {
              files: entries.filter((entry) =>
                entry.parents.includes(parent ?? ""),
              ),
            },
          };
        },
      },
    };
    const drive = new GoogleDrive({
      client: client as never,
      rootFolderId: "root",
    });

    const result = await drive.list({
      prefix: "inbox/",
      appProperty: { key: "brainhubKey", value: "shared" },
    });

    expect(result.map((entry) => entry.id).sort()).toEqual([
      "inside-a",
      "inside-b",
    ]);
  });

  it("reads a fixed file relative to the resolved My Drive root", async () => {
    const profile = {
      id: "profile-1",
      name: "Digital_Twin_Profile.md",
      mimeType: "text/markdown",
      parents: ["my-drive-root"],
      size: "15",
      modifiedTime: "2026-07-25T00:00:00.000Z",
      appProperties: {},
      version: "1",
      trashed: false,
    };
    const listedParents: string[] = [];
    const client = {
      files: {
        list: async (request: { q?: string }) => {
          listedParents.push(request.q ?? "");
          return { data: { files: [profile] } };
        },
        get: async (request: { fileId?: string; alt?: string }) => {
          if (request.fileId === "root") {
            return { data: { id: "my-drive-root" } };
          }
          if (request.alt === "media") {
            return { data: Buffer.from("# Digital Twin\n") };
          }
          return { data: profile, headers: { etag: "profile-etag" } };
        },
      },
    };

    const drive = await GoogleDrive.openMyDrive(client as never);
    const result = await drive.readPath("Digital_Twin_Profile.md");

    expect(result?.bytes.toString("utf8")).toBe("# Digital Twin\n");
    expect(listedParents).toContain(
      "'my-drive-root' in parents and name = 'Digital_Twin_Profile.md' and trashed = false",
    );
  });

  it("exports a Google Docs profile as Markdown", async () => {
    const profile = {
      id: "profile-doc",
      name: "Digital_Twin_Profile.md",
      mimeType: "application/vnd.google-apps.document",
      parents: ["my-drive-root"],
      size: "0",
      modifiedTime: "2026-07-25T00:00:00.000Z",
      appProperties: {},
      version: "1",
      trashed: false,
    };
    let exportedMimeType: string | undefined;
    const client = {
      files: {
        list: async () => ({ data: { files: [profile] } }),
        get: async (request: { fileId?: string; alt?: string }) => {
          if (request.fileId === "root") {
            return { data: { id: "my-drive-root" } };
          }
          if (request.alt === "media") {
            throw new Error("Google Docs cannot use media download");
          }
          return { data: profile, headers: { etag: "profile-etag" } };
        },
        export: async (request: { mimeType?: string }) => {
          exportedMimeType = request.mimeType;
          return { data: Buffer.from("# Exported Digital Twin\n") };
        },
      },
    };

    const drive = await GoogleDrive.openMyDrive(client as never);
    const result = await drive.readPath("Digital_Twin_Profile.md");

    expect(exportedMimeType).toBe("text/markdown");
    expect(result?.bytes.toString("utf8")).toBe("# Exported Digital Twin\n");
  });

  it("reuses an existing named root folder", async () => {
    let createCalls = 0;
    const client = {
      files: {
        list: async () => ({ data: { files: [{ id: "existing-root" }] } }),
        create: async () => {
          createCalls += 1;
          return { data: { id: "new-root" } };
        },
      },
    };

    await expect(
      GoogleDrive.createRoot(client as never, "brain-hub"),
    ).resolves.toBe("existing-root");
    expect(createCalls).toBe(0);
  });

  it("requires an explicit BrainHub root", () => {
    expect(
      () => new GoogleDrive({ client: {} as never, rootFolderId: "" }),
    ).toThrow(/Drive root/);
  });

  it("rejects paths outside the configured root before calling Google", async () => {
    const drive = new GoogleDrive({
      client: {} as never,
      rootFolderId: "root",
    });
    await expect(
      drive.put({
        path: "../outside.md",
        bytes: Buffer.from("x"),
        mimeType: "text/plain",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("creates shared folder paths once during concurrent writes", async () => {
    const { client, files } = createConcurrentDriveClient();
    const drive = new GoogleDrive({
      client: client as never,
      rootFolderId: "root",
    });

    await Promise.all([
      drive.put({
        path: "inbox/macbook/first.md",
        bytes: Buffer.from("first"),
        mimeType: "text/markdown",
      }),
      drive.put({
        path: "inbox/macbook/second.md",
        bytes: Buffer.from("second"),
        mimeType: "text/markdown",
      }),
    ]);

    const folders = files.filter((file) => file.mimeType === folderMimeType);
    expect(folders.filter((folder) => folder.name === "inbox")).toHaveLength(1);
    expect(folders.filter((folder) => folder.name === "macbook")).toHaveLength(
      1,
    );
  });
});
