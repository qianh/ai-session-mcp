export interface Embedder {
  readonly model: string;
  readonly revision: string;
  readonly dimensions: number;
  embedQuery(text: string): Promise<number[]>;
  embedPassages(texts: string[]): Promise<number[][]>;
}

export function normalizeVector(vector: number[]): number[] {
  const norm = Math.hypot(...vector);
  return norm === 0 ? [...vector] : vector.map((value) => value / norm);
}
