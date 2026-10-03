import { createServer } from "node:http";

import open from "open";

export interface OAuthLoopbackSession {
  redirectUri: string;
  authorize(authorizationUrl: string): Promise<string>;
  close(): Promise<void>;
}

export interface OAuthLoopbackOptions {
  openUrl?: (url: string) => Promise<unknown>;
  printUrl?: (url: string) => void;
  timeoutMs?: number;
}

export async function startOAuthLoopback(
  state: string,
  options: OAuthLoopbackOptions = {},
): Promise<OAuthLoopbackSession> {
  let resolveCode: (code: string) => void = () => undefined;
  let rejectCode: (error: Error) => void = () => undefined;
  let settled = false;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const settleError = (error: Error): void => {
    if (settled) return;
    settled = true;
    rejectCode(error);
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (
      url.pathname !== "/oauth/callback" ||
      url.searchParams.get("state") !== state
    ) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("BrainHub authorization failed. You can close this window.");
      settleError(new Error("OAuth callback validation failed"));
      return;
    }
    if (url.searchParams.has("error")) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end(
        "BrainHub authorization was cancelled. You can close this window.",
      );
      settleError(new Error("OAuth authorization was cancelled"));
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("BrainHub authorization failed. You can close this window.");
      settleError(new Error("OAuth callback validation failed"));
      return;
    }
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end(
      "BrainHub authorization completed. You can close this window.",
    );
    if (!settled) {
      settled = true;
      resolveCode(code);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Unable to open OAuth callback server");
  }
  const redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;
  let timeout: NodeJS.Timeout | undefined;
  return {
    redirectUri,
    async authorize(authorizationUrl: string): Promise<string> {
      // xdg-open can be missing or silently do nothing on headless Linux,
      // so the URL is always printed for manual copying.
      (options.printUrl ?? printAuthorizationUrl)(authorizationUrl);
      await (options.openUrl ?? open)(authorizationUrl).catch(() => undefined);
      timeout = setTimeout(
        () => settleError(new Error("OAuth callback timed out")),
        options.timeoutMs ?? 5 * 60_000,
      );
      try {
        return await codePromise;
      } finally {
        clearTimeout(timeout);
        timeout = undefined;
      }
    },
    async close(): Promise<void> {
      if (timeout) clearTimeout(timeout);
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function printAuthorizationUrl(url: string): void {
  process.stderr.write(
    `If the browser does not open, visit this URL to authorize BrainHub:\n${url}\n`,
  );
}
