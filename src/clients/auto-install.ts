import type { CommandSpec } from "../runtime/command.js";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLIENT_NAMES, ClientRegistry, type ClientName } from "./registry.js";

type Runner = (
  command: string,
  args: string[],
) => Promise<{ stdout: string; exitCode: number }>;
interface InstallOptions {
  launch: CommandSpec;
  homeDir?: string;
  skillsOnly?: boolean;
  run?: Runner;
}
// Automatic installation must not wait indefinitely for a client CLI.
const automaticRunner: Runner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: 10_000, encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve({ stdout, exitCode: 0 });
      },
    );
  });

export async function installLocalIntegrations(
  options: InstallOptions,
): Promise<{ installed: ClientName[]; warnings: string[] }> {
  const homeDir = options.homeDir ?? homedir();
  const registry = new ClientRegistry(
    options.launch,
    options.run ?? automaticRunner,
    homeDir,
  );
  const results = await Promise.all(
    CLIENT_NAMES.map(async (client) => {
      const warnings: string[] = [];
      let installed = false;
      try {
        let hasDirectory = false;
        try {
          hasDirectory = (
            await stat(join(homeDir, `.${client}`))
          ).isDirectory();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        // Never run `mcp list` from a server: some clients start servers while listing.
        const status = options.skillsOnly
          ? { available: false, registered: false }
          : await registry.status(client);
        if (!hasDirectory && !status.available)
          return { client, installed, warnings };
        await registry.installSkills(client);
        installed = true;
        if (!options.skillsOnly && status.available && !status.registered) {
          await registry.mutate(client, "install");
        }
      } catch (error) {
        warnings.push(
          `${client}: ${error instanceof Error ? error.message : "Local integration failed"}`,
        );
      }
      return { client, installed, warnings };
    }),
  );
  return {
    installed: results
      .filter((result) => result.installed)
      .map((result) => result.client),
    warnings: results.flatMap((result) => result.warnings),
  };
}
