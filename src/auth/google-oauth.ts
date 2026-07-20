import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import { google } from "googleapis";

import { BrainHubError } from "../domain/errors.js";
import {
  startOAuthLoopback,
  type OAuthLoopbackSession,
} from "./oauth-loopback.js";
import type { SecretStore } from "./secret-store.js";

export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

export type GoogleOAuthClient = InstanceType<typeof google.auth.OAuth2>;
type GoogleCredentials = Parameters<GoogleOAuthClient["setCredentials"]>[0];
type GoogleAuthorizationOptions = NonNullable<
  Parameters<GoogleOAuthClient["generateAuthUrl"]>[0]
>;

export interface StagedGoogleAuthorization {
  client: GoogleOAuthClient;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface GoogleOAuthDependencies {
  createClient?: (
    clientId: string,
    clientSecret: string,
    redirectUri?: string,
  ) => GoogleOAuthClient;
  startLoopback?: (state: string) => Promise<OAuthLoopbackSession>;
}

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

export function googleAuthorizationOptions(
  state: string,
  codeChallenge: string,
): GoogleAuthorizationOptions {
  return {
    access_type: "offline",
    prompt: "select_account consent",
    scope: [GOOGLE_DRIVE_SCOPE],
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256" as NonNullable<
      GoogleAuthorizationOptions["code_challenge_method"]
    >,
  };
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
  readonly #createClient: NonNullable<GoogleOAuthDependencies["createClient"]>;
  readonly #startLoopback: NonNullable<
    GoogleOAuthDependencies["startLoopback"]
  >;

  constructor(
    readonly clientFile: string,
    readonly secrets: SecretStore,
    dependencies: GoogleOAuthDependencies = {},
  ) {
    this.#createClient =
      dependencies.createClient ??
      ((clientId, clientSecret, redirectUri) =>
        new google.auth.OAuth2(clientId, clientSecret, redirectUri));
    this.#startLoopback = dependencies.startLoopback ?? startOAuthLoopback;
  }

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
      const staged = await this.#authorizeInteractive(config, null);
      await staged.commit();
      return staged.client;
    }

    const client = this.#createClient(config.clientId, config.clientSecret);
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
      const staged = await this.#authorizeInteractive(config, stored);
      await staged.commit();
      return staged.client;
    }
  }

  #persistNewTokens(client: GoogleOAuthClient, base: GoogleCredentials): void {
    client.on("tokens", (tokens) => {
      void this.secrets
        .set(JSON.stringify({ ...base, ...tokens }))
        .catch(() => undefined);
    });
  }

  async beginInteractiveAuthorization(): Promise<StagedGoogleAuthorization> {
    const config = await readOAuthClientConfig(this.clientFile);
    const previousCredential = await this.secrets.get();
    return this.#authorizeInteractive(config, previousCredential);
  }

  async #authorizeInteractive(
    config: OAuthClientConfig,
    previousCredential: string | null,
  ): Promise<StagedGoogleAuthorization> {
    const state = randomBytes(24).toString("hex");
    const loopback = await this.#startLoopback(state);
    const client = this.#createClient(
      config.clientId,
      config.clientSecret,
      loopback.redirectUri,
    );
    try {
      const { codeVerifier, codeChallenge } =
        await client.generateCodeVerifierAsync();
      if (!codeChallenge) throw new Error("Unable to generate PKCE challenge");
      const authorizationUrl = client.generateAuthUrl(
        googleAuthorizationOptions(state, codeChallenge),
      );
      const code = await loopback.authorize(authorizationUrl);
      const { tokens } = await client.getToken({ code, codeVerifier });
      if (!tokens.refresh_token)
        throw new Error("Google did not return a refresh token");
      client.setCredentials(tokens);
      let pending: GoogleCredentials = tokens;
      let active = true;
      let committed = false;
      let commitAttempted = false;
      client.on("tokens", (newTokens) => {
        pending = { ...pending, ...newTokens };
        if (active && committed) {
          void this.secrets.set(JSON.stringify(pending)).catch(() => undefined);
        }
      });
      return {
        client,
        commit: async () => {
          if (!active) throw new Error("OAuth authorization was rolled back");
          if (committed) return;
          commitAttempted = true;
          const serialized = JSON.stringify(pending);
          await this.secrets.set(serialized);
          committed = true;
          const latest = JSON.stringify(pending);
          if (latest !== serialized) await this.secrets.set(latest);
        },
        rollback: async () => {
          if (!active) return;
          active = false;
          if (!commitAttempted && !committed) return;
          if (previousCredential) await this.secrets.set(previousCredential);
          else await this.secrets.delete();
        },
      };
    } finally {
      await loopback.close();
    }
  }
}
