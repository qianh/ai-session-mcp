import type { BrainHubConfig } from "../domain/config.js";
import type { GoogleDriveAccount } from "./google-account.js";

function configuredAccount(config: BrainHubConfig) {
  if (!config.drive.accountEmail || !config.drive.accountDisplayName) {
    return undefined;
  }
  return {
    email: config.drive.accountEmail,
    displayName: config.drive.accountDisplayName,
  };
}

function driveStatus(config: BrainHubConfig) {
  return {
    configured: Boolean(config.drive.rootFolderId),
    ...(config.drive.rootFolderId
      ? { rootFolderId: config.drive.rootFolderId }
      : {}),
    rootFolderName: config.drive.rootFolderName,
  };
}

export async function resolveGoogleAccountStatus(options: {
  config: BrainHubConfig;
  credential: string | null;
  loadAccount: () => Promise<GoogleDriveAccount>;
}) {
  const configured = configuredAccount(options.config);
  const drive = driveStatus(options.config);
  if (!options.credential) {
    return {
      authenticated: false as const,
      reason: "missing_credential" as const,
      ...(configured ? { configuredAccount: configured } : {}),
      drive,
    };
  }
  try {
    const account = await options.loadAccount();
    return {
      authenticated: true as const,
      account: { email: account.email, displayName: account.displayName },
      ...(configured ? { configuredAccount: configured } : {}),
      identityMatches:
        Boolean(options.config.drive.accountPermissionId) &&
        options.config.drive.accountPermissionId === account.permissionId,
      drive,
    };
  } catch {
    return {
      authenticated: false as const,
      reason: "invalid_credential" as const,
      ...(configured ? { configuredAccount: configured } : {}),
      drive,
    };
  }
}
