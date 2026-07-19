# Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and execute each task inline. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve all eleven P1/P2 review findings without weakening the existing privacy, upload, status, or publishing contracts.

**Architecture:** Keep redaction and adapter behavior pure, isolate per-session upload preprocessing failures, and move incremental discovery state into the existing SQLite operational store. Represent background CLI launches as a command plus argument vector so clients and schedulers invoke Node explicitly. Use staged pair replacement with rollback for the two local publish documents.

**Tech Stack:** Node.js 22, TypeScript ESM, SQLite, Sharp, Vitest.

---

### Task 1: Close privacy leaks

**Files:**

- Modify: `src/capture/redact.ts`
- Modify: `src/upload/upload-service.ts`
- Test: `tests/capture/redact.test.ts`
- Test: `tests/upload/upload-service.test.ts`

- [x] Add failing tests for quoted JSON password values and signed/internal remote image URLs.
- [x] Run the focused tests and confirm the exposed values remain present.
- [x] Redact quoted assignments, signed query credentials, and every remote image URL before rendering.
- [x] Run focused tests and confirm uploaded Markdown contains none of the sensitive values.

### Task 2: Make upload execution resilient

**Files:**

- Modify: `src/upload/lock.ts`
- Modify: `src/upload/upload-service.ts`
- Test: `tests/upload/lock.test.ts`
- Test: `tests/upload/upload-service.test.ts`

- [x] Add failing tests for a dead-PID lock and a corrupt image followed by a valid session.
- [x] Run the focused tests and confirm stale locks remain busy and corrupt images abort the batch.
- [x] Reclaim locks whose owner PID no longer exists and isolate preprocessing errors per session.
- [x] Run focused tests and confirm later sessions still complete.

### Task 3: Make registration and configuration mutation safe

**Files:**

- Modify: `src/cli/index.ts`
- Modify: `src/clients/registry.ts`
- Modify: `src/runtime/container.ts`
- Modify: `src/scheduler/manager.ts`
- Modify: `src/scheduler/launchd.ts`
- Modify: `src/scheduler/systemd.ts`
- Test: `tests/clients/registry.test.ts`
- Test: `tests/scheduler/templates.test.ts`

- [x] Add failing tests that require `process.execPath + script path` argument vectors and reject malformed Claude Desktop JSON without overwriting it.
- [x] Run the focused tests and confirm the built script is still treated as an executable and malformed JSON is swallowed.
- [x] Introduce a shared command specification for client/desktop/scheduler registration and narrow missing-config recovery to `ENOENT`.
- [x] Run focused tests and build the project to validate generated launch commands.

### Task 4: Restore local status and incremental discovery contracts

**Files:**

- Modify: `src/status/status-service.ts`
- Modify: `src/runtime/container.ts`
- Modify: `src/adapters/index.ts`
- Modify: `src/adapters/grok.ts`
- Modify: `src/state/store.ts`
- Modify: `src/state/sqlite-store.ts`
- Test: `tests/status/status-service.test.ts`
- Test: `tests/adapters/adapters.test.ts`
- Test: `tests/adapters/discovery.test.ts`
- Test: `tests/state/sqlite-store.test.ts`
- Create: `tests/runtime/container.test.ts`

- [x] Add failing tests for lazy Drive failure, `session_kind: main`, persisted source watermarks, and exclusion of unchanged historical files.
- [x] Run focused tests and confirm current eager Drive initialization, Grok filtering, and full parsing behavior fail them.
- [x] Resolve Drive inside status error handling, compare Grok kind exactly, and filter discovery candidates by file mtime plus pending source paths unless `backfill` is true.
- [x] Advance per-source scan watermarks only after a completed live batch, preserving retry paths for pending uploads.
- [x] Run focused tests and the dry-run end-to-end test.

### Task 5: Publish portrait documents consistently

**Files:**

- Modify: `src/portrait/portrait-service.ts`
- Test: `tests/portrait/portrait-service.test.ts`

- [x] Add failing tests for a multi-line Diff section and a failed pair replacement preserving both old documents.
- [x] Run the focused tests and confirm Diff truncation and mixed-state behavior.
- [x] Fix absolute-end matching and replace both files through staged writes, backups, and rollback.
- [x] Run focused tests and confirm both files report a single coherent refresh outcome.

### Task 6: Full verification

- [x] Run the complete Vitest suite.
- [x] Run TypeScript type checking and ESLint.
- [x] Run the production build and verify `dist/cli/index.js` is launched through the absolute Node executable in generated registrations/templates.
- [x] Run Prettier check and format only touched files if necessary.
