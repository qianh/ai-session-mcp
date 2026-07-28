import type { DrivePort } from "../drive/drive-port.js";

export interface StatusOutput {
  account: object;
  root: object;
  upload: {
    driveReachable: boolean;
    inbox: Record<string, number>;
    adapters: object;
  };
  model: object;
  index: object;
  launchd: object;
  portrait: object;
  obsidian: object;
  update: object;
  warnings: Array<{ code: string; message: string }>;
}

type StatusReader = () => Promise<object>;

export class StatusService {
  readonly #account: object;
  readonly #root: object;
  readonly #drive: () => Promise<DrivePort>;
  readonly #upload: StatusReader;
  readonly #model: StatusReader;
  readonly #index: StatusReader;
  readonly #launchd: StatusReader;
  readonly #portrait: StatusReader;
  readonly #obsidian: StatusReader;
  readonly #update: StatusReader;

  constructor(options: {
    account: object;
    root: object;
    drive: DrivePort | (() => Promise<DrivePort>);
    upload: StatusReader;
    model: StatusReader;
    index: StatusReader;
    launchd: StatusReader;
    portrait: StatusReader;
    obsidian: StatusReader;
    update: StatusReader;
  }) {
    this.#account = options.account;
    this.#root = options.root;
    this.#drive =
      typeof options.drive === "function"
        ? options.drive
        : async () => options.drive as DrivePort;
    this.#upload = options.upload;
    this.#model = options.model;
    this.#index = options.index;
    this.#launchd = options.launchd;
    this.#portrait = options.portrait;
    this.#obsidian = options.obsidian;
    this.#update = options.update;
  }

  async getStatus(): Promise<StatusOutput> {
    const warnings: StatusOutput["warnings"] = [];
    const upload: StatusOutput["upload"] = {
      driveReachable: false,
      inbox: {},
      adapters: {},
    };
    try {
      const inbox = await (await this.#drive()).list({ prefix: "inbox/" });
      upload.driveReachable = true;
      for (const entry of inbox) {
        const device = entry.path.split("/")[1];
        if (!device || device === "_assets") continue;
        upload.inbox[device] = (upload.inbox[device] ?? 0) + 1;
      }
    } catch {
      warnings.push({
        code: "DRIVE_UNAVAILABLE",
        message: "Google Drive status could not be read",
      });
    }
    try {
      upload.adapters = await this.#upload();
    } catch {
      warnings.push({
        code: "UPLOAD_STATUS_FAILED",
        message: "Local upload source status could not be read",
      });
    }

    const read = async (
      name: "model" | "index" | "launchd" | "portrait" | "obsidian" | "update",
      reader: StatusReader,
    ): Promise<object> => {
      try {
        return await reader();
      } catch {
        warnings.push({
          code: `${name.toUpperCase()}_STATUS_FAILED`,
          message: `${name} status could not be read`,
        });
        return {};
      }
    };
    const [model, index, launchd, portrait, obsidian, update] =
      await Promise.all([
        read("model", this.#model),
        read("index", this.#index),
        read("launchd", this.#launchd),
        read("portrait", this.#portrait),
        read("obsidian", this.#obsidian),
        read("update", this.#update),
      ]);
    return {
      account: this.#account,
      root: this.#root,
      upload,
      model,
      index,
      launchd,
      portrait,
      obsidian,
      update,
      warnings,
    };
  }
}
