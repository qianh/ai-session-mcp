function quoteArgument(value: string): string {
  return /\s/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

export function renderSystemdUnits(options: {
  command: string;
  args: string[];
  at: string;
}): { service: string; timer: string } {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(options.at))
    throw new Error("Invalid schedule time");
  return {
    service: `[Unit]
Description=Upload local AI sessions to BrainHub
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${[options.command, ...options.args, "upload", "--json"].map(quoteArgument).join(" ")}
NoNewPrivileges=true
PrivateTmp=true
`,
    timer: `[Unit]
Description=Daily BrainHub session upload

[Timer]
OnCalendar=*-*-* ${options.at}:00
Persistent=true
Unit=brainhub-upload.service

[Install]
WantedBy=timers.target
`,
  };
}
