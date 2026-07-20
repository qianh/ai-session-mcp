import { describe, expect, it } from "vitest";

import { startOAuthLoopback } from "../../src/auth/oauth-loopback.js";

describe("OAuth loopback callback", () => {
  it("rejects an invalid state without yielding a code", async () => {
    const loopback = await startOAuthLoopback("expected-state", {
      openUrl: async () => undefined,
      timeoutMs: 1_000,
    });
    try {
      const code = expect(
        loopback.authorize("https://accounts.example/authorize"),
      ).rejects.toThrow(/validation failed/);
      const response = await fetch(
        `${loopback.redirectUri}?state=wrong-state&code=must-not-return`,
      );
      expect(response.status).toBe(400);
      await code;
    } finally {
      await loopback.close();
    }
  });

  it("rejects Google cancellation without yielding a code", async () => {
    const loopback = await startOAuthLoopback("expected-state", {
      openUrl: async () => undefined,
      timeoutMs: 1_000,
    });
    try {
      const code = expect(
        loopback.authorize("https://accounts.example/authorize"),
      ).rejects.toThrow(/cancelled/);
      const response = await fetch(
        `${loopback.redirectUri}?state=expected-state&error=access_denied`,
      );
      expect(response.status).toBe(400);
      await code;
    } finally {
      await loopback.close();
    }
  });
});
