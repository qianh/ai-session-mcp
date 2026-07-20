import type { drive_v3 } from "googleapis";

import type { BrainHubConfig } from "../domain/config.js";
import { BrainHubError } from "../domain/errors.js";
import { GoogleDrive } from "../drive/google-drive.js";
import type { GoogleOAuthClient } from "./google-oauth.js";

export interface GoogleDriveAccount {
  email: string;
  displayName: string;
  permissionId: string;
}

export interface GoogleAccountConnection {
  account: GoogleDriveAccount;
  rootFolderId: string;
}

export async function readGoogleDriveAccount(
  client: drive_v3.Drive,
): Promise<GoogleDriveAccount> {
  const response = await client.about.get({
    fields: "user(displayName,emailAddress,permissionId)",
  });
  const email = response.data.user?.emailAddress?.trim();
  const displayName = response.data.user?.displayName?.trim();
  const permissionId = response.data.user?.permissionId?.trim();
  if (!email || !displayName || !permissionId) {
    throw new BrainHubError(
      "AUTH_ACCOUNT_UNAVAILABLE",
      "Google Drive did not return a complete account identity",
    );
  }
  return { email, displayName, permissionId };
}

export async function connectGoogleAccount(options: {
  authClient: GoogleOAuthClient;
  drive: (auth: GoogleOAuthClient) => drive_v3.Drive;
  rootFolderName: string;
}): Promise<GoogleAccountConnection> {
  const client = options.drive(options.authClient);
  const account = await readGoogleDriveAccount(client);
  const rootFolderId = await GoogleDrive.createRoot(
    client,
    options.rootFolderName,
  );
  return { account, rootFolderId };
}

export function applyGoogleConnection(
  config: BrainHubConfig,
  connection: GoogleAccountConnection,
): BrainHubConfig {
  return {
    ...config,
    drive: {
      ...config.drive,
      rootFolderId: connection.rootFolderId,
      accountEmail: connection.account.email,
      accountDisplayName: connection.account.displayName,
      accountPermissionId: connection.account.permissionId,
    },
  };
}

export function clearGoogleConnection(config: BrainHubConfig): BrainHubConfig {
  return {
    ...config,
    drive: {
      ...config.drive,
      rootFolderId: "",
      accountEmail: "",
      accountDisplayName: "",
      accountPermissionId: "",
    },
  };
}
