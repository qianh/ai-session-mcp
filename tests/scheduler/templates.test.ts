import { describe, expect, it } from "vitest";

import { renderLaunchAgent } from "../../src/scheduler/launchd.js";
import {
  renderSystemdService,
  renderSystemdTimer,
} from "../../src/scheduler/systemd.js";

describe("scheduler templates", () => {
  it("renders a catch-up launch agent at 02:00", () => {
    const plist = renderLaunchAgent({
      command: "/usr/local/bin/node",
      args: ["/opt/brain hub/dist/cli/index.js"],
      at: "02:00",
      logDirectory: "/tmp/logs",
    });
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>Hour</key><integer>2</integer>");
    expect(plist).toContain("<key>Minute</key><integer>0</integer>");
    expect(plist).toContain("<string>/usr/local/bin/node</string>");
    expect(plist).toContain(
      "<string>/opt/brain hub/dist/cli/index.js</string>",
    );
    expect(plist).toContain(
      "<string>upload</string>\n    <string>--json</string>",
    );
    expect(plist).not.toContain("<string>--sources</string>");
  });

  it("renders an independent daily portrait sync launch agent", () => {
    const plist = renderLaunchAgent({
      command: "/usr/local/bin/node",
      args: ["/opt/brain hub/dist/cli/index.js"],
      at: "06:00",
      logDirectory: "/tmp/logs",
      job: "portrait-sync",
    });

    expect(plist).toContain(
      "<key>Label</key><string>com.brainhub.sync</string>",
    );
    expect(plist).toContain("<key>Hour</key><integer>6</integer>");
    expect(plist).toContain("<string>portrait</string>");
    expect(plist).toContain("<string>sync</string>");
    expect(plist).toContain("/tmp/logs/sync.log");
  });

  it("renders a persistent systemd user timer", () => {
    const service = renderSystemdService({
      command: "/usr/bin/node",
      args: ["/opt/brain hub/dist/cli/index.js", "--config", "/tmp/config"],
    });
    expect(service).toContain("Type=oneshot");
    expect(service).toContain(
      'ExecStart=/usr/bin/node "/opt/brain hub/dist/cli/index.js" --config /tmp/config upload --json',
    );
    expect(service).not.toContain("--sources");
    const timer = renderSystemdTimer({ at: "02:00" });
    expect(timer).toContain("OnCalendar=*-*-* 02:00:00");
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain("Unit=brainhub-upload.service");
    expect(timer).toContain("WantedBy=timers.target");
    expect(() => renderSystemdTimer({ at: "25:00" })).toThrow(
      "Invalid schedule time",
    );
  });

  it("renders an independent portrait sync timer", () => {
    expect(
      renderSystemdService({
        command: "/usr/bin/node",
        args: ["/opt/brainhub-mcp/dist/cli/index.js"],
        job: "portrait-sync",
      }),
    ).toContain("portrait sync --json");
    expect(renderSystemdTimer({ at: "06:00", job: "portrait-sync" })).toContain(
      "Unit=brainhub-sync.service",
    );
  });
});
