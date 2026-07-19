import { describe, expect, it } from "vitest";

import {
  GOOGLE_DRIVE_SCOPE,
  parseOAuthClientConfig,
} from "../../src/auth/google-oauth.js";

describe("Google OAuth", () => {
  it("requests the full Drive scope", () => {
    expect(GOOGLE_DRIVE_SCOPE).toBe("https://www.googleapis.com/auth/drive");
  });

  it("parses installed and web client files", () => {
    expect(
      parseOAuthClientConfig({
        installed: {
          client_id: "id",
          client_secret: "secret",
          redirect_uris: ["http://127.0.0.1/callback"],
        },
      }),
    ).toMatchObject({ clientId: "id", clientSecret: "secret" });
  });

  it("rejects incomplete client files without leaking data", () => {
    expect(() => parseOAuthClientConfig({ web: { client_id: "id" } })).toThrow(
      /OAuth client file is incomplete/,
    );
  });
});
