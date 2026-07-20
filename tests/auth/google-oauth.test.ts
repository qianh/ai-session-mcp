import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  GOOGLE_DRIVE_SCOPE,
  GoogleOAuth,
  googleAuthorizationOptions,
  parseOAuthClientConfig,
} from "../../src/auth/google-oauth.js";
import type { SecretStore } from "../../src/auth/secret-store.js";

async function oauthClientFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "brainhub-oauth-"));
  const path = join(directory, "client.json");
  await writeFile(
    path,
    JSON.stringify({
      installed: {
        client_id: "client-id",
        client_secret: "client-secret",
        redirect_uris: ["http://127.0.0.1"],
      },
    }),
  );
  return path;
}

function fakeOAuthClient() {
  const client = new EventEmitter() as EventEmitter & {
    credentials: Record<string, unknown>;
    generateCodeVerifierAsync: () => Promise<{
      codeVerifier: string;
      codeChallenge: string;
    }>;
    generateAuthUrl: (options: Record<string, unknown>) => string;
    getToken: (options: Record<string, unknown>) => Promise<{
      tokens: Record<string, unknown>;
    }>;
    setCredentials: (tokens: Record<string, unknown>) => void;
  };
  client.credentials = {};
  client.generateCodeVerifierAsync = async () => ({
    codeVerifier: "fixed-verifier",
    codeChallenge: "fixed-challenge",
  });
  client.generateAuthUrl = () => "https://accounts.example/authorize";
  client.getToken = async () => ({
    tokens: { refresh_token: "new-refresh", access_token: "new-access" },
  });
  client.setCredentials = (tokens) => {
    client.credentials = tokens;
  };
  return client;
}

describe("Google OAuth", () => {
  it("requests the full Drive scope", () => {
    expect(GOOGLE_DRIVE_SCOPE).toBe("https://www.googleapis.com/auth/drive");
  });

  it("requests account selection, consent, state, and PKCE S256", () => {
    expect(googleAuthorizationOptions("state-1", "challenge-1")).toEqual({
      access_type: "offline",
      prompt: "select_account consent",
      scope: [GOOGLE_DRIVE_SCOPE],
      state: "state-1",
      code_challenge: "challenge-1",
      code_challenge_method: "S256",
    });
  });

  it("stages a newly selected account and uses the PKCE verifier", async () => {
    let stored = "old-credential";
    const setValues: string[] = [];
    const secrets: SecretStore = {
      get: async () => stored,
      set: async (value) => {
        stored = value;
        setValues.push(value);
      },
      delete: async () => {
        stored = "";
      },
    };
    const client = fakeOAuthClient();
    let authorizationOptions: Record<string, unknown> | undefined;
    let tokenOptions: Record<string, unknown> | undefined;
    let openedUrl = "";
    let closed = false;
    client.generateAuthUrl = (options) => {
      authorizationOptions = options;
      return "https://accounts.example/authorize";
    };
    client.getToken = async (options) => {
      tokenOptions = options;
      return {
        tokens: { refresh_token: "new-refresh", access_token: "new-access" },
      };
    };
    const oauth = new GoogleOAuth(await oauthClientFile(), secrets, {
      createClient: () => client as never,
      startLoopback: async () => ({
        redirectUri: "http://127.0.0.1:1234/oauth/callback",
        authorize: async (url) => {
          openedUrl = url;
          return "authorization-code";
        },
        close: async () => {
          closed = true;
        },
      }),
    });

    const staged = await oauth.beginInteractiveAuthorization();

    expect(stored).toBe("old-credential");
    expect(openedUrl).toBe("https://accounts.example/authorize");
    expect(authorizationOptions).toMatchObject({
      prompt: "select_account consent",
      code_challenge: "fixed-challenge",
      code_challenge_method: "S256",
    });
    expect(tokenOptions).toEqual({
      code: "authorization-code",
      codeVerifier: "fixed-verifier",
    });
    expect(closed).toBe(true);

    await staged.commit();
    expect(JSON.parse(stored)).toMatchObject({ refresh_token: "new-refresh" });
    client.emit("tokens", { access_token: "refreshed-access" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(JSON.parse(setValues.at(-1)!)).toMatchObject({
      refresh_token: "new-refresh",
      access_token: "refreshed-access",
    });
  });

  it("rollback restores an old credential and blocks later token writes", async () => {
    let stored = "old-credential";
    let failCommit = true;
    const secrets: SecretStore = {
      get: async () => stored,
      set: async (value) => {
        stored = value;
        if (failCommit) {
          failCommit = false;
          throw new Error("secret commit failed");
        }
      },
      delete: async () => {
        stored = "";
      },
    };
    const client = fakeOAuthClient();
    const oauth = new GoogleOAuth(await oauthClientFile(), secrets, {
      createClient: () => client as never,
      startLoopback: async () => ({
        redirectUri: "http://127.0.0.1:1234/oauth/callback",
        authorize: async () => "authorization-code",
        close: async () => undefined,
      }),
    });
    const staged = await oauth.beginInteractiveAuthorization();

    await expect(staged.commit()).rejects.toThrow(/secret commit failed/);
    await staged.rollback();
    expect(stored).toBe("old-credential");

    client.emit("tokens", { access_token: "must-not-persist" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stored).toBe("old-credential");
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
