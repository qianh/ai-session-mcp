import type {
  BackfillDecisionInput,
  BackfillState,
  BackfillUploadInput,
} from "../state/store.js";

export interface BackfillSummary {
  sessions: number;
  bytes: number;
}

export interface BackfillResult extends BackfillSummary {
  confirmed: boolean;
  uploaded: number;
  completed: boolean;
}

interface BackfillStateStore {
  getBackfillState(): BackfillState | null;
  recordBackfillDecision(input: BackfillDecisionInput): void;
  recordBackfillUpload(input: BackfillUploadInput): void;
}

export interface BackfillDependencies {
  state: BackfillStateStore;
  inspect(): Promise<BackfillSummary>;
  confirm(summary: BackfillSummary): Promise<boolean>;
  upload(): Promise<{ uploaded: number; pending: number }>;
  report(summary: BackfillSummary): void;
  now?: () => string;
}

function result(state: BackfillState): BackfillResult {
  return {
    sessions: state.sessions,
    bytes: state.bytes,
    confirmed: state.decision === "accepted",
    uploaded: state.uploaded,
    completed: state.completedAt !== null,
  };
}

export class BackfillService {
  readonly #now: () => string;

  constructor(readonly dependencies: BackfillDependencies) {
    this.#now = dependencies.now ?? (() => new Date().toISOString());
  }

  async run(): Promise<BackfillResult> {
    let state = this.dependencies.state.getBackfillState();
    if (state?.completedAt) return result(state);

    if (!state) {
      const summary = await this.dependencies.inspect();
      this.dependencies.report(summary);
      const accepted =
        summary.sessions === 0 || (await this.dependencies.confirm(summary));
      this.dependencies.state.recordBackfillDecision({
        decision: accepted ? "accepted" : "declined",
        ...summary,
        decidedAt: this.#now(),
      });
      state = this.dependencies.state.getBackfillState();
      if (!state) throw new Error("Backfill decision was not persisted");
    }

    if (state.decision === "declined") return result(state);

    const uploaded = await this.dependencies.upload();
    this.dependencies.state.recordBackfillUpload({
      ...uploaded,
      recordedAt: this.#now(),
    });
    const updated = this.dependencies.state.getBackfillState();
    if (!updated) throw new Error("Backfill upload result was not persisted");
    return result(updated);
  }
}
