export type BrainHubErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_ACCOUNT_UNAVAILABLE"
  | "DRIVE_ROOT_REQUIRED"
  | "PUBLISH_PATH_REQUIRED"
  | "SOURCE_UNAVAILABLE"
  | "INDEX_STALE"
  | "UPLOAD_BUSY"
  | "INVALID_INPUT"
  | "UPLOAD_FAILED"
  | "CLIENT_VERSION_UNSUPPORTED";

export class BrainHubError extends Error {
  constructor(
    readonly code: BrainHubErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "BrainHubError";
  }
}
