# Review Remediation Round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the eleven account, setup, Drive refresh, model readiness, and local-search correctness defects found in review without changing the documented BrainHub data contract.

**Architecture:** Treat a Google account plus its selected BrainHub root as one durable Drive binding. Keep upload/backfill state in that binding's SQLite database, make legacy state migration globally claimable exactly once, and share one resumable backfill workflow between setup and account switching. Make Drive refresh transactional with respect to its cursor, rebuild on folder changes, and make the search index self-heal from missing vectors or incompatible index parameters.

**Tech Stack:** TypeScript, Node.js 22+, better-sqlite3, Google Drive API v3, Vitest, Transformers.js.

---

### Task 1: Partition And Migrate Binding State Safely

**Files:**

- Modify: `src/domain/config-io.ts`
- Modify: `src/state/sqlite-store.ts`
- Test: `tests/domain/config.test.ts`
- Test: `tests/state/sqlite-store.test.ts`

- [ ] **Step 1: Write failing binding-partition tests**

Assert that the same `accountPermissionId` with two different `rootFolderId` values resolves to different upload and search SQLite paths.

- [ ] **Step 2: Write a failing two-account legacy migration test**

Create one legacy state database, open two new binding databases with that legacy path, and assert that only the first database receives the legacy uploaded session and watermark.

- [ ] **Step 3: Verify the new tests fail**

Run: `pnpm exec vitest run tests/domain/config.test.ts tests/state/sqlite-store.test.ts`

Expected: the root paths are equal and the second binding incorrectly contains the legacy state.

- [ ] **Step 4: Implement binding identity and source-side migration claim**

Hash a length-prefixed pair of permission ID and root ID for bound configurations. During legacy migration, create a migration-claim table in the attached legacy database and claim the migration inside the same transaction before copying rows; a failed copy must roll back the claim.

- [ ] **Step 5: Verify the tests pass**

Run: `pnpm exec vitest run tests/domain/config.test.ts tests/state/sqlite-store.test.ts`

Expected: all tests pass.

### Task 2: Persist And Resume First Backfill

**Files:**

- Create: `src/setup/backfill-service.ts`
- Modify: `src/setup/setup-service.ts`
- Modify: `src/state/store.ts`
- Modify: `src/state/sqlite-store.ts`
- Create: `tests/setup/backfill-service.test.ts`
- Modify: `tests/setup/setup-service.test.ts`
- Modify: `tests/state/sqlite-store.test.ts`

- [ ] **Step 1: Write failing backfill state tests**

Cover accepted-and-completed, accepted-but-upload-failed, accepted-with-pending-items, and declined decisions. Assert that a completed or declined rerun does not inspect or prompt again, an interrupted or partially failed accepted run retries upload without prompting, and declining atomically sets all source watermarks to the decision time.

- [ ] **Step 2: Verify the tests fail**

Run: `pnpm exec vitest run tests/setup/backfill-service.test.ts tests/setup/setup-service.test.ts tests/state/sqlite-store.test.ts`

Expected: no durable backfill state API or reusable workflow exists.

- [ ] **Step 3: Add durable backfill state**

Add one singleton `setup_backfill` row per binding containing decision, inspected session count/bytes, uploaded count, decision time, and optional completion time. Expose a setup-specific persistence interface implemented by `SqliteStateStore` rather than expanding the upload-only `StateStore` contract; recording a decline sets the three discovery watermarks in the same SQLite transaction.

- [ ] **Step 4: Add the reusable backfill workflow**

Implement a `BackfillService` that only inspects/prompts when no decision exists, records acceptance before upload, retries incomplete accepted uploads, and returns stored output immediately after completion. The upload dependency must return both uploaded and remaining pending counts; only `pending === 0` may mark the workflow complete. A normally returned upload with pending work remains incomplete and produces a setup warning instead of silently completing. Make `SetupService` delegate its backfill step to this workflow result.

- [ ] **Step 5: Verify the tests pass**

Run: `pnpm exec vitest run tests/setup/backfill-service.test.ts tests/setup/setup-service.test.ts tests/state/sqlite-store.test.ts`

Expected: all tests pass.

### Task 3: Complete Setup And Account-Switch Orchestration

**Files:**

- Modify: `src/cli/index.ts`
- Modify: `src/runtime/container.ts`
- Modify: `src/auth/google-account.ts` only if a small identity-validation helper is needed
- Modify: `tests/cli/auth.test.ts`
- Modify: `tests/clients/registry.test.ts`
- Modify: `tests/setup/setup-service.test.ts`

- [ ] **Step 1: Write failing CLI behavior tests**

Assert that a newly selected binding invokes first backfill, a known completed binding returns without a rescan, setup validates a stored credential/account before reusing it, invalid stored credentials start interactive authorization, and setup client registration includes `--config <resolved-path>` before `serve`.

- [ ] **Step 2: Verify the tests fail**

Run: `pnpm exec vitest run tests/cli/auth.test.ts tests/clients/registry.test.ts tests/setup/setup-service.test.ts`

Expected: account switching skips backfill, setup trusts any non-empty credential, and registered launch arguments omit the custom config.

- [ ] **Step 3: Reuse the backfill workflow from setup and auth switch**

After a successful account/root commit, load the new binding state and run backfill. Add `--yes` to `auth login`/`auth switch`; in non-interactive JSON mode require it only when discovered history needs a new decision. Include the count of remaining retryable upload items in the runtime upload result so the shared workflow cannot mark a partial backfill complete.

- [ ] **Step 4: Validate stored setup credentials**

Call non-interactive OAuth client validation and read the live Drive account. Reuse the binding only when the permission ID matches; otherwise continue into interactive authorization.

- [ ] **Step 5: Register clients with the resolved config**

Construct the setup `ClientRegistry` launch command with `--config` and the resolved configuration path, matching launchd argument ordering.

- [ ] **Step 6: Verify the tests pass**

Run: `pnpm exec vitest run tests/cli/auth.test.ts tests/clients/registry.test.ts tests/setup/setup-service.test.ts`

Expected: all tests pass.

### Task 4: Keep Drive Changes Lossless

**Files:**

- Modify: `src/drive/google-drive.ts`
- Modify: `tests/drive/google-drive.test.ts`

- [ ] **Step 1: Write failing Drive tests**

Assert that a 429/5xx failure while resolving changed-file metadata rejects the refresh instead of returning a removal, and that a folder change returns a full reset snapshot containing the current inbox descendants.

- [ ] **Step 2: Verify the tests fail**

Run: `pnpm exec vitest run tests/drive/google-drive.test.ts`

Expected: transient errors become removals and folder descendants are absent.

- [ ] **Step 3: Implement classified errors and folder resets**

Only map explicit out-of-root/not-found conditions to removal. Re-throw transient errors so the caller cannot persist a new cursor. If any changed item is a folder, consume the change pages to obtain the new cursor, then return a fresh `inbox/` snapshot with `reset: true`.

- [ ] **Step 4: Verify the tests pass**

Run: `pnpm exec vitest run tests/drive/google-drive.test.ts`

Expected: all tests pass.

### Task 5: Self-Heal And Version The Search Index

**Files:**

- Modify: `src/search/search-service.ts`
- Modify: `tests/search/search-service.test.ts`

- [ ] **Step 1: Write failing recovery and compatibility tests**

Assert that documents written with null vectors are embedded on the next sync after model recovery even with no Drive changes. Parameterize compatibility tests over dimensions, chunk token count, and chunk overlap, asserting each change causes a complete rebuild.

- [ ] **Step 2: Verify the tests fail**

Run: `pnpm exec vitest run tests/search/search-service.test.ts`

Expected: recovery stays in keyword mode and structural configuration changes reuse the old cursor.

- [ ] **Step 3: Implement a complete index fingerprint**

Persist a deterministic fingerprint containing model, revision, dimensions, chunk tokens, and chunk overlap. Reuse the Drive cursor only for an exact fingerprint match; older indexes without the fingerprint rebuild once.

- [ ] **Step 4: Retry missing vectors**

Before applying changes, load indexed documents that contain null vectors and merge them into the work set unless the current Drive page removes or replaces them. A failed retry must leave the old index usable and retry again later.

- [ ] **Step 5: Verify the tests pass**

Run: `pnpm exec vitest run tests/search/search-service.test.ts`

Expected: all tests pass.

### Task 6: Report Model Readiness From A Completion Marker

**Files:**

- Create: `src/search/model-cache.ts`
- Modify: `src/search/e5-embedder.ts`
- Modify: `src/runtime/container.ts`
- Create: `tests/search/model-cache.test.ts`
- Modify: `tests/runtime/container.test.ts`

- [ ] **Step 1: Write failing readiness tests**

Assert that arbitrary partial cache bytes do not report ready, a matching successful-load marker does report ready, and markers for a different model/revision/dimension fingerprint do not report ready.

- [ ] **Step 2: Verify the tests fail**

Run: `pnpm exec vitest run tests/search/model-cache.test.ts tests/runtime/container.test.ts`

Expected: partial bytes currently report ready.

- [ ] **Step 3: Write and consume the completion marker**

After Transformers.js successfully loads the extractor, atomically write a marker keyed by model, revision, and dimensions. Add a no-download readiness check and use it from `hub_status`; continue reporting cache byte size separately.

- [ ] **Step 4: Verify the tests pass**

Run: `pnpm exec vitest run tests/search/model-cache.test.ts tests/runtime/container.test.ts`

Expected: all tests pass.

### Task 7: Align User Documentation And Verify The Patch

**Files:**

- Modify: `README.md`
- Modify: `docs/configuration.md`

- [ ] **Step 1: Update user-facing behavior**

Document that first use of a Drive binding performs confirmed history backfill, `auth switch --yes` accepts that default non-interactively, root rebinding creates independent local state, and setup remembers completed or declined backfill.

- [ ] **Step 2: Run focused tests**

Run: `pnpm exec vitest run tests/state/sqlite-store.test.ts tests/domain/config.test.ts tests/setup tests/cli/auth.test.ts tests/clients/registry.test.ts tests/drive/google-drive.test.ts tests/search tests/runtime/container.test.ts`

Expected: all focused tests pass.

- [ ] **Step 3: Run the full repository verification**

Run: `pnpm verify`

Expected: tests, typecheck, lint, format check, build, and package dry-run all pass.

- [ ] **Step 4: Inspect the final diff**

Run: `git diff --check` and review only the files named above. Do not commit because this is an existing shared dirty worktree and the user did not request a commit.
