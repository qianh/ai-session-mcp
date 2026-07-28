import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ pipeline: vi.fn() }));

vi.mock("@huggingface/transformers", () => ({ pipeline: mocks.pipeline }));

import { E5Embedder } from "../../src/search/e5-embedder.js";
import { isModelReady } from "../../src/search/model-cache.js";

describe("E5 model cache completion", () => {
  beforeEach(() => {
    mocks.pipeline.mockReset();
  });

  it("marks the configured model ready only after it loads successfully", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "brainhub-model-"));
    const identity = {
      model: "test/model",
      revision: "revision-1",
      dimensions: 3,
    };
    mocks.pipeline.mockResolvedValue(async () => ({
      tolist: () => [[1, 0, 0]],
    }));
    const embedder = new E5Embedder({ ...identity, cacheDir });

    await expect(isModelReady(cacheDir, identity)).resolves.toBe(false);
    await embedder.prepare();
    await expect(isModelReady(cacheDir, identity)).resolves.toBe(true);
  });

  it("leaves no ready marker when model loading fails", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "brainhub-model-"));
    const identity = {
      model: "test/model",
      revision: "revision-1",
      dimensions: 3,
    };
    mocks.pipeline.mockRejectedValue(new Error("incomplete model"));
    const embedder = new E5Embedder({ ...identity, cacheDir });

    await expect(embedder.prepare()).rejects.toThrow(/incomplete model/);
    await expect(isModelReady(cacheDir, identity)).resolves.toBe(false);
  });
});
