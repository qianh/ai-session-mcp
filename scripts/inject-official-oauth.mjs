import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";

const clientId = process.env.BRAINHUB_GOOGLE_OAUTH_CLIENT_ID ?? "";
const clientSecret = process.env.BRAINHUB_GOOGLE_OAUTH_CLIENT_SECRET ?? "";
if (!clientId.endsWith(".apps.googleusercontent.com") || !clientSecret) {
  throw new Error(
    "Release build requires BRAINHUB_GOOGLE_OAUTH_CLIENT_ID and BRAINHUB_GOOGLE_OAUTH_CLIENT_SECRET",
  );
}

const path = new URL("../dist/auth/official-oauth-client.js", import.meta.url);
const source = await readFile(path, "utf8");
const output = source
  .replace("__BRAINHUB_GOOGLE_OAUTH_CLIENT_ID__", clientId)
  .replace("__BRAINHUB_GOOGLE_OAUTH_CLIENT_SECRET__", clientSecret);
if (output === source || output.includes("__BRAINHUB_GOOGLE_OAUTH_CLIENT_")) {
  throw new Error("Unable to inject the official Google OAuth client");
}
await writeFile(path, output);
