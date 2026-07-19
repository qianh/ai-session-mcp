import { describe, expect, it } from "vitest";

import { GoogleDrive } from "../../src/drive/google-drive.js";

describe("Google Drive boundary", () => {
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
});
