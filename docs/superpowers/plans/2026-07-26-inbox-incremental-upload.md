# Inbox-Only Daily Incremental Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the daily job incrementally upload Claude Code, Codex, and Grok Build sessions while limiting every session-upload remote operation to `inbox/`.

**Architecture:** Keep local SQLite watermarks and `UploadService` as the incremental planner. Narrow the upload remote boundary to inbox sessions and inbox assets, remove automatic search-index work from the upload transaction, and make scheduler source coverage explicit on macOS and Linux. Standalone search commands remain separate.

**Tech Stack:** Node.js 22+, TypeScript, Vitest, better-sqlite3, Google Drive API, macOS launchd, Linux systemd

---

### Task 1: Enforce the inbox-only upload boundary

**Files:**

- Modify: `tests/upload/upload-service.test.ts`
- Modify: `tests/capture/images.test.ts`
- Modify: `tests/drive/google-drive.test.ts`
- Modify: `src/upload/upload-service.ts`
- Modify: `src/capture/images.ts`
- Create: `src/drive/scoped-drive.ts`
- Modify: `src/drive/google-drive.ts`

- [ ] **Step 1: Write failing tests for inbox-only artifacts**

Add tests that upload an embedded image and assert every remote path begins
with `inbox/`. Update the image contract to expect
`inbox/_assets/sha256/<prefix>/<sha>.webp`.

Record every Drive method invocation during the upload and assert no operation
targets or returns an out-of-scope path/ID.

Wrap an adversarial Drive that ignores the requested prefix and returns a
`sessions/...` entry. Assert the scoped boundary rejects it and never
authorizes its ID for read/move/trash.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm vitest run tests/upload/upload-service.test.ts tests/capture/images.test.ts`

Expected: FAIL because images use `images/sha256/` and the device mirror uses
`_meta/devices/`.

- [ ] **Step 3: Write the failing candidate-scope test**

Seed a newer `sessions/...` object with the same `brainhubKey`, upload the local
session, and expect a new canonical object under `inbox/<device>/` while the
out-of-scope object remains untouched.

Seed an `images/sha256/...` object with the same `brainhubImageSha`; expect a
new inbox asset, an inbox asset reference in Markdown, and no read/move/trash
of the out-of-scope image.

- [ ] **Step 4: Run the candidate test and verify RED**

Expected: FAIL because global app-property reconciliation currently treats the
newer `sessions/` object as canonical.

- [ ] **Step 5: Implement the minimal inbox-only behavior**

Introduce an upload-facing scoped Drive wrapper that:

- forces every list to the `inbox/` prefix;
- allows `read`, `move`, and `trash` only for IDs obtained through an inbox
  list/write/readPath operation;
- normalizes and validates every returned entry path before registering its ID,
  rejecting any out-of-scope result from the lower-level Drive;
- rejects every put, upsert, readPath, or move destination outside `inbox/`.

Change image paths to `inbox/_assets/sha256/` and remove the `_meta/devices`
upsert.

- [ ] **Step 6: Write a failing GoogleDrive prefix-boundary test**

Use a fake Google client containing matching app-property objects inside and
outside inbox. Assert a combined prefix/app-property query starts traversal at
the inbox folder and makes no metadata request for the outside object.

- [ ] **Step 7: Run the Drive test and verify RED**

Run: `pnpm vitest run tests/drive/google-drive.test.ts`

Expected: FAIL because the current app-property branch queries globally and
resolves every matching object's ancestry.

- [ ] **Step 8: Implement prefix-rooted GoogleDrive listing**

Resolve a prefix segment with a parent-and-name Drive query rather than listing
all siblings, then traverse only that prefix subtree. When both `prefix` and
`appProperty` are present, filter app properties within that scoped traversal;
never issue a global app-property query first.

- [ ] **Step 9: Run focused tests and verify GREEN**

Run: `pnpm vitest run tests/upload/upload-service.test.ts tests/capture/images.test.ts tests/drive/google-drive.test.ts`

Expected: PASS.

### Task 2: Make candidate promotion and preprocessing retry-safe

**Files:**

- Modify: `tests/upload/upload-service.test.ts`
- Modify: `tests/runtime/container.test.ts`
- Modify: `src/upload/upload-service.ts`

- [ ] **Step 1: Write failing preprocessing retry tests**

For a non-dry upload with an invalid embedded image, assert the source path is
stored as retryable before processing continues. Then fix the source input,
explicitly reset its filesystem mtime to before the already-advanced watermark,
and prove a normal incremental run retries it solely because the pending path
is included. Assert discovery would return zero without `includePaths` and one
with that pending path.

- [ ] **Step 2: Run the preprocessing tests and verify RED**

Expected: FAIL because preprocessing currently continues before `markPending`.

- [ ] **Step 3: Implement retryable preprocessing state**

Before preprocessing, persist a deterministic provisional content identity for
non-dry runs. On preprocessing failure mark it retryable; successful rendering
replaces the provisional identity with the real content SHA. Keep dry runs
state-free.

- [ ] **Step 4: Write failpoint tests for candidate promotion**

Inject failures at move, loser trash, and `markUploaded`. Verify:

- move failure may clean only the temporary candidate;
- once the candidate reaches its stable inbox path it is never deleted;
- loser cleanup failure preserves the canonical;
- a subsequent run reconciles leftovers and repairs local uploaded state.

- [ ] **Step 5: Run failpoint tests and verify RED**

Expected: FAIL on `markUploaded` because the current catch path trashes the
already-promoted candidate, and FAIL on retry because the remote-winner path
does not repair local state.

- [ ] **Step 6: Implement promotion ownership transfer and state repair**

Clear temporary-candidate cleanup ownership immediately after that candidate
is successfully moved to the stable path. Persist/repair local uploaded state
when an inbox winner already supersedes the local snapshot. Treat loser cleanup
as convergent work that can be retried without deleting the winner.

- [ ] **Step 7: Run focused upload/runtime tests and verify GREEN**

Run: `pnpm vitest run tests/upload/upload-service.test.ts tests/runtime/container.test.ts`

Expected: PASS.

### Task 3: Decouple session upload from search indexing

**Files:**

- Modify: `tests/runtime/container.test.ts`
- Modify: `tests/e2e/dry-run.test.ts`
- Modify: `src/runtime/container.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Write a failing runtime integration test**

Run a real fixture discovery and `UploadService` against an injected
`MemoryDrive`, spy on the public `searchService()` boundary, and assert that a
successful upload never calls it.

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm vitest run tests/runtime/container.test.ts`

Expected: FAIL because `searchService()` is called whenever `uploaded > 0`.

- [ ] **Step 3: Write and run a failing CLI contract test**

Assert `upload --help` no longer exposes `--skip-index` and that providing the
removed option is rejected. Run the focused CLI test and verify RED because the
option currently exists.

- [ ] **Step 4: Remove automatic index refresh**

Delete the `shouldRefreshSearchIndex` policy and the post-upload `sync()` call.
Remove `skipIndex` from runtime input and the CLI `--skip-index` option because
indexing is no longer part of session upload. Preserve standalone
`search sync` and `search reindex` commands.

- [ ] **Step 5: Run runtime and CLI tests and verify GREEN**

Run: `pnpm vitest run tests/runtime/container.test.ts tests/e2e/dry-run.test.ts`

Expected: PASS with no index warning codes in upload output.

### Task 4: Make all local sources explicit in daily jobs

**Files:**

- Modify: `tests/scheduler/templates.test.ts`
- Modify: `tests/scheduler/manager.test.ts`
- Modify: `tests/e2e/client-install.test.ts`
- Modify: `src/scheduler/launchd.ts`
- Modify: `src/scheduler/systemd.ts`

- [ ] **Step 1: Write failing scheduler command tests**

Assert both scheduler formats contain the exact ordered arguments:

```text
upload --sources claude-code,codex,grok-build --json
```

- [ ] **Step 2: Run scheduler tests and verify RED**

Run: `pnpm vitest run tests/scheduler/templates.test.ts tests/scheduler/manager.test.ts tests/e2e/client-install.test.ts`

Expected: FAIL because scheduled commands currently rely on implicit defaults.

- [ ] **Step 3: Write failing scheduler repair tests**

For both darwin and linux managers, pre-create an obsolete job, run install
twice, and assert the final upload definition has the exact source arguments,
configured time, and unchanged independent portrait command.

- [ ] **Step 4: Run repair tests and verify RED**

Expected: FAIL because the regenerated definitions still contain the implicit
source command.

- [ ] **Step 5: Implement explicit source arguments**

Use one shared constant for the three CLI source names and render the same
argument vector for launchd and systemd. Do not alter the portrait-sync job.

- [ ] **Step 6: Run scheduler tests and verify GREEN**

Expected: PASS for macOS and Linux renderers.

- [ ] **Step 7: Add a three-source incremental runtime regression test**

Establish an earlier independent watermark for each source, then create/touch
one Claude Code, one Codex, and one Grok Build fixture after that baseline. Run
a normal incremental upload with a scoped in-memory Drive, assert all three
adapter summaries and independent watermarks, clear the Drive operation log,
then run again unchanged and assert zero remote writes.

- [ ] **Step 8: Add a per-source failure-isolation regression test**

Start from three earlier watermarks, make Grok's `summary.json` invalid so its
adapter parser throws and `status.errors > 0`, and leave Claude/Codex valid.
Assert the Grok watermark is unchanged and the other two advance. Add a
separate control fixture containing a tolerated malformed JSONL line plus a
captured session, and assert malformed-line accounting does not block that
source watermark. Separately assert a preprocessing failure is retained as a
retryable source path while unrelated sources complete.

- [ ] **Step 9: Run the integration tests as a regression baseline**

If the first run already satisfies discovery semantics, retain it as a
regression test and verify Task 1-3 changes do not break it. Otherwise implement
only the missing incremental behavior and rerun to GREEN.

### Task 5: Update operator documentation

**Files:**

- Modify: `README.md`
- Modify: `docs/configuration.md`
- Modify: `BrainHub-开发手册-v0.2.md`

- [ ] **Step 1: Remove obsolete automatic-index guidance**

Remove `--skip-index`, `INDEX_SKIPPED`, and claims that scheduled upload
refreshes the search index.

- [ ] **Step 2: Document the new remote layout and source coverage**

Document inbox sessions, inbox assets, all three scheduled sources, local
watermarks, retry behavior, and explicit standalone search maintenance.

- [ ] **Step 3: Run documentation consistency searches**

Run: `rg -n "skip-index|INDEX_SKIPPED|images/sha256|_meta/devices|automatic search" README.md docs src tests BrainHub-开发手册-v0.2.md`

Expected: no obsolete upload contract remains outside historical plans/specs.

### Task 6: Full verification and local deployment

**Files:**

- Generated: `dist/**`
- Regenerated: `~/Library/LaunchAgents/com.brainhub.upload.plist`
- Regenerated: `~/Library/LaunchAgents/com.brainhub.sync.plist`

- [ ] **Step 1: Run focused and full quality checks**

Run in parallel:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

Expected: all pass.

- [ ] **Step 2: Inspect the final diff**

Run: `git diff --check && git status --short`

Expected: only scoped source, test, and documentation changes.

- [ ] **Step 3: Reinstall the local scheduler**

Run: `node dist/cli/index.js scheduler install --json`

Expected: launchd regenerates and bootstraps the upload and portrait jobs.

- [ ] **Step 4: Verify the installed command and one real run**

Inspect `com.brainhub.upload.plist`, monitor `launchctl`, then verify the upload
log, SQLite watermarks, and remote paths. The real upload must terminate, cover
all three adapters, and create no object outside `inbox/`.

No git commit is created unless the user separately requests one.
