import { dailyUploadArguments, portraitSyncArguments } from "./jobs.js";

export type ScheduledJob = "upload" | "portrait-sync";

const schedulePattern = /^(?<hour>[01]\d|2[0-3]):(?<minute>[0-5]\d)$/;

export function systemdUnitBase(job: ScheduledJob = "upload"): string {
  return job === "portrait-sync" ? "brainhub-sync" : "brainhub-upload";
}

function systemdArgument(value: string): string {
  const escaped = value.replaceAll("%", "%%");
  if (/^[\w./:@+=,-]+$/.test(escaped)) return escaped;
  return `"${escaped
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "$$")}"`;
}

export function systemdOnCalendar(at: string): string {
  const match = schedulePattern.exec(at);
  if (!match?.groups) throw new Error("Invalid schedule time");
  return `*-*-* ${match.groups.hour}:${match.groups.minute}:00`;
}

export function renderSystemdService(options: {
  command: string;
  args: string[];
  job?: ScheduledJob;
}): string {
  const sync = options.job === "portrait-sync";
  const description = sync
    ? "BrainHub MCP portrait sync"
    : "BrainHub MCP daily upload";
  const commandArguments = sync ? portraitSyncArguments : dailyUploadArguments;
  const execStart = [
    options.command,
    ...options.args,
    ...commandArguments,
    "--json",
  ]
    .map(systemdArgument)
    .join(" ");
  return `[Unit]
Description=${description}

[Service]
Type=oneshot
ExecStart=${execStart}
`;
}

export function renderSystemdTimer(options: {
  at: string;
  job?: ScheduledJob;
}): string {
  const sync = options.job === "portrait-sync";
  const description = sync
    ? "BrainHub MCP portrait sync"
    : "BrainHub MCP daily upload";
  const unit = `${systemdUnitBase(options.job)}.service`;
  return `[Unit]
Description=${description}

[Timer]
OnCalendar=${systemdOnCalendar(options.at)}
Persistent=true
Unit=${unit}

[Install]
WantedBy=timers.target
`;
}
