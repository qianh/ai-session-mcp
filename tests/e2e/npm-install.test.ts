import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const repository = resolve(import.meta.dirname, "../..");

describe("npm installation lifecycle", () => {
  it("installs packaged skills and Cursor MCP automatically with no setup command", async () => {
    const metadata = JSON.parse(
      await readFile(join(repository, "package.json"), "utf8"),
    );
    expect(metadata.scripts.postinstall).toBe("node scripts/postinstall.mjs");
    expect(metadata.files).toContain("scripts/postinstall.mjs");
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "brainhub-npm-")),
    );
    try {
      const payload = join(directory, "package");
      const home = join(directory, "home");
      const prefix = join(directory, "prefix");
      await mkdir(join(payload, "scripts"), { recursive: true });
      await mkdir(join(home, ".cursor"), { recursive: true });
      // Package the real installer with no unrelated runtime dependencies, keeping this regression offline.
      await writeFile(
        join(payload, "package.json"),
        JSON.stringify({
          name: metadata.name,
          version: metadata.version,
          type: metadata.type,
          files: metadata.files,
          scripts: { postinstall: metadata.scripts.postinstall },
        }),
      );
      await copyFile(
        join(repository, "scripts/postinstall.mjs"),
        join(payload, "scripts/postinstall.mjs"),
      );
      for (const file of [
        "clients/auto-install",
        "clients/registry",
        "clients/skills",
        "domain/errors",
      ]) {
        const compiled = ts.transpileModule(
          await readFile(join(repository, `src/${file}.ts`), "utf8"),
          {
            compilerOptions: {
              target: ts.ScriptTarget.ES2023,
              module: ts.ModuleKind.ESNext,
            },
          },
        );
        const target = join(payload, `dist/${file}.js`);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, compiled.outputText);
      }
      const env = {
        ...process.env,
        HOME: home,
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        npm_config_cache: join(directory, "cache"),
      };
      const npm = join(dirname(process.execPath), "npm");
      const packed = await execute(
        npm,
        ["pack", "--ignore-scripts", "--json"],
        { cwd: payload, env },
      );
      const tarball = join(payload, JSON.parse(packed.stdout)[0].filename);
      await execute(
        npm,
        [
          "install",
          "--global",
          "--prefix",
          prefix,
          "--offline",
          "--no-audit",
          "--no-fund",
          tarball,
        ],
        { env, timeout: 30_000 },
      );
      expect(
        await readFile(
          join(home, ".cursor/skills/brainhub-get-portrait/SKILL.md"),
          "utf8",
        ),
      ).toContain("name: brainhub-get-portrait");
      const config = JSON.parse(
        await readFile(join(home, ".cursor/mcp.json"), "utf8"),
      );
      expect(config.mcpServers["brain-hub"]).toEqual({
        command: process.execPath,
        args: [
          join(prefix, "lib/node_modules/brainhub-mcp/dist/cli/index.js"),
          "serve",
        ],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 45_000);
});
