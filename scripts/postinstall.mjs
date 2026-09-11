import { existsSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";

// Installing repository dependencies must not change the developer's clients.
if (!existsSync(new URL("../src/cli/index.ts", import.meta.url))) {
  try {
    const { installLocalIntegrations } =
      await import("../dist/clients/auto-install.js");
    const result = await installLocalIntegrations({
      launch: {
        command: process.execPath,
        args: [fileURLToPath(new URL("../dist/cli/index.js", import.meta.url))],
      },
    });
    for (const warning of result.warnings) {
      process.stderr.write(`BrainHub: ${warning}\n`);
    }
  } catch (error) {
    // A local integration failure must not invalidate the installed CLI.
    process.stderr.write(
      `BrainHub: automatic integration incomplete: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}
