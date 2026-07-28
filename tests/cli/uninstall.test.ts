import { describe, expect, it } from "vitest";

import { isAffirmativeConfirmation } from "../../src/cli/index.js";

describe("uninstall confirmation", () => {
  it("requires an explicit affirmative answer", () => {
    expect(isAffirmativeConfirmation("y")).toBe(true);
    expect(isAffirmativeConfirmation("YES")).toBe(true);
    expect(isAffirmativeConfirmation("")).toBe(false);
    expect(isAffirmativeConfirmation("no")).toBe(false);
  });
});
