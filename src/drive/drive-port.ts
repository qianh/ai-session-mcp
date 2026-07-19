export interface DriveEntry {
  id: string;
  path: string;
  mimeType: string;
  size: number;
  modifiedTime: string;
  etag: string;
  appProperties: Record<string, string>;
}

export interface DriveObject extends DriveEntry {
  bytes: Buffer;
}

export interface DrivePutInput {
  path: string;
  bytes: Buffer;
  mimeType: string;
  appProperties?: Record<string, string>;
  ifMatch?: string;
}

export interface DriveListQuery {
  prefix?: string;
  appProperty?: { key: string; value: string };
  modifiedAfter?: string;
}

export interface DriveQuota {
  usedBytes: number;
  totalBytes: number;
}

export interface DrivePort {
  list(query: DriveListQuery): Promise<DriveEntry[]>;
  put(input: DrivePutInput): Promise<DriveEntry>;
  upsert(input: DrivePutInput): Promise<DriveEntry>;
  read(id: string): Promise<DriveObject>;
  readPath(path: string): Promise<DriveObject | null>;
  move(id: string, path: string): Promise<DriveEntry>;
  trash(id: string): Promise<void>;
  quota(): Promise<DriveQuota>;
}
