import { describe, expect, it } from "vitest";

import { renderLaunchAgent } from "../../src/scheduler/launchd.js";
import { renderSystemdUnits } from "../../src/scheduler/systemd.js";

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
    expect(plist).toContain("<string>upload</string>");
  });

  it("renders a persistent user timer and oneshot service", () => {
    const units = renderSystemdUnits({
      command: "/usr/local/bin/node",
      args: ["/opt/brain hub/dist/cli/index.js"],
      at: "02:00",
    });
    expect(units.service).toContain("Type=oneshot");
    expect(units.service).toContain(
      'ExecStart=/usr/local/bin/node "/opt/brain hub/dist/cli/index.js" upload',
    );
    expect(units.timer).toContain("OnCalendar=*-*-* 02:00:00");
    expect(units.timer).toContain("Persistent=true");
  });
});
