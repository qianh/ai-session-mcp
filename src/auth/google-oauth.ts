import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

import { google } from "googleapis";
import open from "open";

import { BrainHubError } from "../domain/errors.js";
import type { SecretStore } from "./secret-store.js";

export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

type GoogleOAuthClient = InstanceType<typeof google.auth.OAuth2>;
type GoogleCredentials = Parameters<GoogleOAuthClient["setCredentials"]>[0];

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
}

export function parseOAuthClientConfig(value: unknown): OAuthClientConfig {
  const root =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const candidate = (root.installed ?? root.web) as
    Record<string, unknown> | undefined;
  const clientId = candidate?.client_id;
  const clientSecret = candidate?.client_secret;
  const redirectUris = candidate?.redirect_uris;
  if (
    typeof clientId !== "string" ||
    typeof clientSecret !== "string" ||
    !Array.isArray(redirectUris) ||
    !redirectUris.every((uri) => typeof uri === "string")
  ) {
    throw new Error("OAuth client file is incomplete");
  }
  return { clientId, clientSecret, redirectUris };
}

export async function readOAuthClientConfig(
  path: string,
): Promise<OAuthClientConfig> {
  if (!path)
    throw new BrainHubError(
      "AUTH_REQUIRED",
      "Google OAuth client file is not configured",
    );
  try {
    return parseOAuthClientConfig(
      JSON.parse(await readFile(path, "utf8")) as unknown,
    );
  } catch (error) {
    if (error instanceof BrainHubError) throw error;
    throw new BrainHubError(
      "AUTH_REQUIRED",
      "Unable to read a valid Google OAuth client file",
    );
  }
}

export class GoogleOAuth {
  constructor(
    readonly clientFile: string,
    readonly secrets: SecretStore,
  ) {}

  async getClient(options: {
    interactive: boolean;
  }): Promise<GoogleOAuthClient> {
    const config = await readOAuthClientConfig(this.clientFile);
    const stored = await this.secrets.get();
    if (!stored) {
      if (!options.interactive) {
        throw new BrainHubError(
          "AUTH_REQUIRED",
          "Google Drive authentication is required",
        );
      }
      return this.#authorizeInteractive(config);
    }

    const client = new google.auth.OAuth2(config.clientId, config.clientSecret);
    try {
      const credentials = JSON.parse(stored) as GoogleCredentials;
      if (!credentials.refresh_token) throw new Error("refresh token missing");
      client.setCredentials(credentials);
      this.#persistNewTokens(client, credentials);
      await client.getAccessToken();
      return client;
    } catch {
      if (!options.interactive) {
        throw new BrainHubError(
          "AUTH_REQUIRED",
          "Stored Google authentication is invalid",
        );
      }
      return this.#authorizeInteractive(config);
    }
  }

  #persistNewTokens(client: GoogleOAuthClient, base: GoogleCredentials): void {
    client.on("tokens", (tokens) => {
      void this.secrets
        .set(JSON.stringify({ ...base, ...tokens }))
        .catch(() => undefined);
    });
  }

  async #authorizeInteractive(
    config: OAuthClientConfig,
  ): Promise<GoogleOAuthClient> {
    const state = randomBytes(24).toString("hex");
    let resolveCode: (code: string) => void = () => undefined;
    let rejectCode: (error: Error) => void = () => undefined;
    const codePromise = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const code = url.searchParams.get("code");
      if (
        url.pathname !== "/oauth/callback" ||
        url.searchParams.get("state") !== state ||
        !code
      ) {
        response.writeHead(400, {
          "content-type": "text/plain; charset=utf-8",
        });
        response.end(
          "BrainHub authorization failed. You can close this window.",
        );
        rejectCode(new Error("OAuth callback validation failed"));
        return;
      }
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end(
        "BrainHub authorization completed. You can close this window.",
      );
      resolveCode(code);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Unable to open OAuth callback server");
    const redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;
    const client = new google.auth.OAuth2(
      config.clientId,
      config.clientSecret,
      redirectUri,
    );
    const authorizationUrl = client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: [GOOGLE_DRIVE_SCOPE],
      state,
    });

    let timeout: NodeJS.Timeout | undefined;
    try {
      await open(authorizationUrl);
      const code = await Promise.race([
        codePromise,
        new Promise<never>(
          (_resolve, reject) =>
            (timeout = setTimeout(
              () => reject(new Error("OAuth callback timed out")),
              5 * 60_000,
            )),
        ),
      ]);
      const { tokens } = await client.getToken(code);
      if (!tokens.refresh_token)
        throw new Error("Google did not return a refresh token");
      client.setCredentials(tokens);
      await this.secrets.set(JSON.stringify(tokens));
      this.#persistNewTokens(client, tokens);
      return client;
    } finally {
      if (timeout) clearTimeout(timeout);
      server.close();
    }
  }
}
