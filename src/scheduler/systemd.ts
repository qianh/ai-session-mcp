function quoteArgument(value: string): string {
  return /\s/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

export function renderSystemdUnits(options: {
  command: string;
  args: string[];
  at: string;
  job?: "upload" | "portrait-sync";
}): { service: string; timer: string } {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(options.at))
    throw new Error("Invalid schedule time");
  const sync = options.job === "portrait-sync";
  const description = sync
    ? "Sync BrainHub portrait to the local publish directory"
    : "Upload local AI sessions to BrainHub";
  const commandArguments = sync ? ["portrait", "pull"] : ["upload"];
  const serviceName = sync
    ? "brainhub-sync.service"
    : "brainhub-upload.service";
  return {
    service: `[Unit]
Description=${description}
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${[options.command, ...options.args, ...commandArguments, "--json"].map(quoteArgument).join(" ")}
NoNewPrivileges=true
PrivateTmp=true
`,
    timer: `[Unit]
Description=${sync ? "Daily BrainHub portrait sync" : "Daily BrainHub session upload"}

[Timer]
OnCalendar=*-*-* ${options.at}:00
Persistent=true
Unit=${serviceName}

[Install]
WantedBy=timers.target
`,
  };
}
