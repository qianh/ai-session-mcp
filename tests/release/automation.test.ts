import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const repositoryFile = (path: string): URL =>
  new URL(`../../${path}`, import.meta.url);

describe("automated npm releases", () => {
  it("releases conventional commits pushed to master", async () => {
    const workflow = await readFile(
      repositoryFile(".github/workflows/publish.yml"),
      "utf8",
    );
    const packageJson = JSON.parse(
      await readFile(repositoryFile("package.json"), "utf8"),
    ) as { release?: { branches?: string[] } };

    expect(workflow).toMatch(/on:\s*\n\s+push:\s*\n\s+branches: \[master\]/u);
    expect(workflow).not.toMatch(/on:\s*\n\s+release:/u);
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("issues: write");
    expect(workflow).toContain("pull-requests: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).not.toContain("registry-url:");
    expect(workflow).toContain("npx --yes semantic-release@25.0.8");
    expect(workflow).toContain("GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
    expect(workflow).toContain("BRAINHUB_GOOGLE_OAUTH_CLIENT_ID:");
    expect(workflow).toContain("BRAINHUB_GOOGLE_OAUTH_CLIENT_SECRET:");
    expect(packageJson.release?.branches).toEqual(["master"]);
  });

  it("does not duplicate the package version in CLI source", async () => {
    const source = await readFile(repositoryFile("src/cli/index.ts"), "utf8");

    expect(source).not.toMatch(/\.version\(["']\d+\.\d+\.\d+["']\)/u);
  });
});
