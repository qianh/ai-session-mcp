function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderLaunchAgent(options: {
  command: string;
  args: string[];
  at: string;
  logDirectory: string;
  job?: "upload" | "portrait-sync";
}): string {
  const [hour, minute] = options.at.split(":").map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute))
    throw new Error("Invalid schedule time");
  const sync = options.job === "portrait-sync";
  const label = sync ? "com.brainhub.sync" : "com.brainhub.upload";
  const commandArguments = sync ? ["portrait", "pull"] : ["upload"];
  const logName = sync ? "sync" : "upload";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(options.command)}</string>
${options.args.map((argument) => `    <string>${xml(argument)}</string>`).join("\n")}
${commandArguments.map((argument) => `    <string>${argument}</string>`).join("\n")}
    <string>--json</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>
  <key>StandardOutPath</key><string>${xml(`${options.logDirectory}/${logName}.log`)}</string>
  <key>StandardErrorPath</key><string>${xml(`${options.logDirectory}/${logName}-error.log`)}</string>
</dict>
</plist>
`;
}
