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
}): string {
  const [hour, minute] = options.at.split(":").map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute))
    throw new Error("Invalid schedule time");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.brainhub.upload</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(options.command)}</string>
${options.args.map((argument) => `    <string>${xml(argument)}</string>`).join("\n")}
    <string>upload</string>
    <string>--json</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>
  <key>StandardOutPath</key><string>${xml(`${options.logDirectory}/upload.log`)}</string>
  <key>StandardErrorPath</key><string>${xml(`${options.logDirectory}/upload-error.log`)}</string>
</dict>
</plist>
`;
}
