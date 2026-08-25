import { describe, expect, it } from "vitest";

import { renderLaunchAgent } from "../../src/scheduler/launchd.js";

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
});
