import { BrainHubError } from "./errors.js";

export function assertSupportedPlatform(platform: NodeJS.Platform): void {
  if (platform === "darwin" || platform === "linux") return;
  throw new BrainHubError(
    "PLATFORM_UNSUPPORTED",
    "BrainHub MCP supports macOS and Linux",
  );
}
