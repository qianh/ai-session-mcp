import { describe, expect, it } from "vitest";

import { MemoryDrive } from "../../src/drive/memory-drive.js";

describe("Drive change cursor", () => {
  it("returns an initial prefix snapshot and subsequent changes", async () => {
    const drive = new MemoryDrive();
    const first = await drive.put({
      path: "inbox/mac/first.md",
      bytes: Buffer.from("first"),
      mimeType: "text/markdown",
    });
    await drive.put({
      path: "sessions/legacy.md",
      bytes: Buffer.from("legacy"),
      mimeType: "text/markdown",
    });

    const initial = await drive.changes({ prefix: "inbox/" });

    expect(initial.reset).toBe(true);
    expect(initial.entries.map((entry) => entry.id)).toEqual([first.id]);
    expect(initial.removedIds).toEqual([]);

    await drive.move(first.id, "sessions/first.md");
    const second = await drive.put({
      path: "inbox/mac/second.md",
      bytes: Buffer.from("second"),
      mimeType: "text/markdown",
    });

    const incremental = await drive.changes({
      prefix: "inbox/",
      cursor: initial.cursor,
    });

    expect(incremental.reset).toBe(false);
    expect(incremental.entries.map((entry) => entry.id)).toEqual([second.id]);
    expect(incremental.removedIds).toEqual([first.id]);
  });
});
