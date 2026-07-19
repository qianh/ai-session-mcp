import type { DrivePort } from "../drive/drive-port.js";

export interface StatusOutput {
  drive: {
    reachable: boolean;
    usedBytes?: number;
    totalBytes?: number;
    usageRatio?: number;
  };
  inbox: Record<string, number>;
  distill: object;
  capacity?: object;
  adapters: object;
  scheduler: object;
  warnings: Array<{ code: string; message: string }>;
}

const defaultDistill = {
  schema_version: 1,
  daily: {
    status: "never",
    last_started_at: null,
    last_completed_at: null,
    error_code: null,
  },
  weekly: {
    status: "never",
    last_started_at: null,
    last_completed_at: null,
    error_code: null,
  },
};

export class StatusService {
  readonly #drive: () => Promise<DrivePort>;
  readonly #adapters: () => Promise<object>;
  readonly #scheduler: () => Promise<object>;

  constructor(options: {
    drive: DrivePort | (() => Promise<DrivePort>);
    adapters: () => Promise<object>;
    scheduler: () => Promise<object>;
  }) {
    this.#drive =
      typeof options.drive === "function"
        ? options.drive
        : async () => options.drive as DrivePort;
    this.#adapters = options.adapters;
    this.#scheduler = options.scheduler;
  }

  async getStatus(): Promise<StatusOutput> {
    const warnings: StatusOutput["warnings"] = [];
    const output: StatusOutput = {
      drive: { reachable: false },
      inbox: {},
      distill: defaultDistill,
      adapters: {},
      scheduler: {},
      warnings,
    };
    try {
      const drive = await this.#drive();
      const [quota, inbox, distillFile, capacityFile] = await Promise.all([
        drive.quota(),
        drive.list({ prefix: "inbox/" }),
        drive.readPath("_meta/distill-status.json"),
        drive.readPath("_meta/capacity.jsonl"),
      ]);
      output.drive = {
        reachable: true,
        usedBytes: quota.usedBytes,
        totalBytes: quota.totalBytes,
        usageRatio:
          quota.totalBytes > 0 ? quota.usedBytes / quota.totalBytes : 0,
      };
      for (const entry of inbox) {
        const device = entry.path.split("/")[1];
        if (device) output.inbox[device] = (output.inbox[device] ?? 0) + 1;
      }
      if (distillFile) {
        try {
          output.distill = JSON.parse(
            distillFile.bytes.toString("utf8"),
          ) as object;
        } catch {
          warnings.push({
            code: "MALFORMED_DISTILL_STATUS",
            message: "Distill status metadata is malformed",
          });
        }
      } else {
        warnings.push({
          code: "DISTILL_STATUS_MISSING",
          message: "Distill status metadata is missing",
        });
      }
      if (capacityFile) {
        const lines = capacityFile.bytes
          .toString("utf8")
          .split(/\r?\n/u)
          .filter(Boolean)
          .reverse();
        let malformedLines = 0;
        for (const line of lines) {
          try {
            output.capacity = JSON.parse(line) as object;
            break;
          } catch {
            malformedLines += 1;
          }
        }
        if (malformedLines > 0) {
          warnings.push({
            code: "MALFORMED_CAPACITY_LINE",
            message: `Ignored ${malformedLines} malformed trailing capacity record(s)`,
          });
        }
        if (!output.capacity)
          warnings.push({
            code: "MALFORMED_CAPACITY",
            message: "No valid capacity record was found",
          });
      }
    } catch {
      warnings.push({
        code: "DRIVE_UNAVAILABLE",
        message: "Google Drive status could not be read",
      });
    }

    try {
      output.adapters = await this.#adapters();
    } catch {
      warnings.push({
        code: "ADAPTER_STATUS_FAILED",
        message: "Source adapter status could not be read",
      });
    }
    try {
      output.scheduler = await this.#scheduler();
    } catch {
      warnings.push({
        code: "SCHEDULER_STATUS_FAILED",
        message: "Scheduler status could not be read",
      });
    }
    return output;
  }
}
