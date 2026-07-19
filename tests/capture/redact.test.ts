import { describe, expect, it } from "vitest";

import { redactText } from "../../src/capture/redact.js";

describe("redaction", () => {
  it("removes high-confidence credentials and configured internal hosts", () => {
    const input = [
      "Authorization: Bearer secret-token-value",
      "password=hunter2",
      "https://alice:secret@example.com/path",
      "sk-abcdefghijklmnopqrstuvwxyz123456",
      "service.corp.example",
      "10.2.3.4",
      "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
    ].join("\n");

    const result = redactText(input, {
      internalDomains: ["corp.example"],
      internalCidrs: ["10.0.0.0/8"],
    });

    expect(result.text).not.toContain("hunter2");
    expect(result.text).not.toContain("secret-token-value");
    expect(result.text).not.toContain("10.2.3.4");
    expect(result.text).not.toContain("service.corp.example");
    expect(result.count).toBeGreaterThanOrEqual(6);
    expect(result.version).toBe(1);
  });

  it("does not redact ordinary numbers, public hosts, or prose", () => {
    const input =
      "Build 12345 is available at example.com and the score is 10.2.";
    expect(redactText(input).text).toBe(input);
  });

  it("redacts quoted password assignments without breaking structured data", () => {
    const input = `{"password":"hunter2","pwd": "two words"}`;

    const result = redactText(input);

    expect(result.text).toBe(`{"password":"[REDACTED]","pwd": "[REDACTED]"}`);
    expect(result.count).toBe(2);
  });
});
