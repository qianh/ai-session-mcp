import type { SessionSource } from "../domain/session.js";

export type UploadStatus = "pending" | "uploaded" | "failed";

export interface DeviceState {
  id: string;
  name: string;
  createdAt: string;
}

export interface PendingSession {
  conversationKey: string;
  source: SessionSource;
  conversationId: string;
  sourcePath: string;
  sourceUpdatedAt: string;
  contentSha256: string;
}

export interface SessionState extends PendingSession {
  status: UploadStatus;
  attempts: number;
  retryable: boolean;
  driveFileId: string | null;
  uploadedAt: string | null;
  lastErrorCode: string | null;
}

export interface StateStore {
  getOrCreateDevice(name: string): DeviceState;
  markPending(session: PendingSession): boolean;
  markFailed(
    conversationKey: string,
    errorCode: string,
    retryable: boolean,
  ): void;
  markUploaded(
    conversationKey: string,
    driveFileId: string,
    uploadedAt: string,
  ): void;
  getSession(conversationKey: string): SessionState | null;
  listPending(limit: number): SessionState[];
  getDiscoveryWatermark(source: SessionSource): string | null;
  setDiscoveryWatermark(source: SessionSource, scannedAt: string): void;
}
