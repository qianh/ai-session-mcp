import { pipeline } from "@huggingface/transformers";

import { normalizeVector, type Embedder } from "./embedder.js";
import { markModelReady } from "./model-cache.js";

interface TensorOutput {
  tolist(): number[][];
}

type Extractor = (
  texts: string[],
  options: { pooling: "mean"; normalize: true },
) => Promise<TensorOutput>;

interface ModelProgress {
  status?: string;
  progress?: number;
  file?: string;
}

export class E5Embedder implements Embedder {
  readonly model: string;
  readonly revision: string;
  readonly dimensions: number;
  readonly #cacheDir: string;
  #extractor: Promise<Extractor> | null = null;
  #readyMarker: Promise<void> | null = null;

  constructor(options: {
    model: string;
    revision: string;
    dimensions: number;
    cacheDir: string;
  }) {
    this.model = options.model;
    this.revision = options.revision;
    this.dimensions = options.dimensions;
    this.#cacheDir = options.cacheDir;
  }

  async #load(
    progress?: (value: { percent?: number; file?: string }) => void,
  ): Promise<Extractor> {
    this.#extractor ??= (
      pipeline as unknown as (
        task: "feature-extraction",
        model: string,
        options: {
          revision: string;
          dtype: "q8";
          cache_dir: string;
          progress_callback?: (value: ModelProgress) => void;
        },
      ) => Promise<Extractor>
    )("feature-extraction", this.model, {
      revision: this.revision,
      dtype: "q8",
      cache_dir: this.#cacheDir,
      ...(progress
        ? {
            progress_callback: (value: ModelProgress) => {
              if (!value.status?.startsWith("progress")) return;
              progress({
                ...(typeof value.progress === "number"
                  ? { percent: value.progress }
                  : {}),
                ...(value.file ? { file: value.file } : {}),
              });
            },
          }
        : {}),
    });
    const extractor = await this.#extractor;
    this.#readyMarker ??= markModelReady(this.#cacheDir, {
      model: this.model,
      revision: this.revision,
      dimensions: this.dimensions,
    });
    await this.#readyMarker;
    return extractor;
  }

  async prepare(
    progress?: (value: { percent?: number; file?: string }) => void,
  ): Promise<void> {
    await this.#load(progress);
  }

  async #embed(texts: string[]): Promise<number[][]> {
    const extractor = await this.#load();
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    return output.tolist().map((vector) => {
      if (vector.length !== this.dimensions) {
        throw new Error(
          `Embedding dimensions mismatch: expected ${this.dimensions}, received ${vector.length}`,
        );
      }
      return normalizeVector(vector);
    });
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.#embed([`query: ${text}`]);
    if (!vector) throw new Error("Embedding model returned no query vector");
    return vector;
  }

  async embedPassages(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    return this.#embed(texts.map((text) => `passage: ${text}`));
  }
}
