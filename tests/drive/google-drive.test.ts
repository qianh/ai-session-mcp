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
