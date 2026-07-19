import { pipeline } from "@huggingface/transformers";

import { normalizeVector, type Embedder } from "./embedder.js";

interface TensorOutput {
  tolist(): number[][];
}

type Extractor = (
  texts: string[],
  options: { pooling: "mean"; normalize: true },
) => Promise<TensorOutput>;

export class E5Embedder implements Embedder {
  readonly model: string;
  readonly revision: string;
  readonly dimensions: number;
  readonly #cacheDir: string;
  #extractor: Promise<Extractor> | null = null;

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

  async #load(): Promise<Extractor> {
    this.#extractor ??= (
      pipeline as unknown as (
        task: "feature-extraction",
        model: string,
        options: { revision: string; dtype: "q8"; cache_dir: string },
      ) => Promise<Extractor>
    )("feature-extraction", this.model, {
      revision: this.revision,
      dtype: "q8",
      cache_dir: this.#cacheDir,
    });
    return this.#extractor;
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
