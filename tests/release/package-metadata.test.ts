import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("npm package metadata", () => {
  it("publishes brainhub-mcp under Apache-2.0", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as {
      name?: string;
      private?: boolean;
      license?: string;
      bin?: Record<string, string>;
      engines?: { node?: string };
      files?: string[];
      repository?: { url?: string };
    };
    const license = await readFile(
      new URL("../../LICENSE", import.meta.url),
      "utf8",
    );

    expect(packageJson.name).toBe("brainhub-mcp");
    expect(packageJson.private).not.toBe(true);
    expect(packageJson.license).toBe("Apache-2.0");
    expect(packageJson.bin).toEqual({
      "brainhub-mcp": "dist/cli/index.js",
    });
    expect(packageJson.engines?.node).toBe(">=22.12.0");
    expect(packageJson.files).toContain("dist");
    expect(packageJson.repository?.url).toContain("qianh/ai-session-mcp");
    expect(license).toContain("Apache License");
    expect(license).toContain("Version 2.0, January 2004");
  });
});
