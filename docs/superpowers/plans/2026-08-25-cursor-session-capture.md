# Cursor Session Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Cursor as a first-class local session source that is discovered, normalized, incrementally uploaded, searched, and retrieved through BrainHub MCP.

**Architecture:** Read Cursor's exported agent transcripts from `~/.cursor/projects/**/agent-transcripts/*/*.jsonl` instead of coupling capture to Cursor's private SQLite/KV stores. A focused adapter converts `user` and `assistant` message records into the existing normalized session model; the existing redaction, image, upload, Drive, search, and retrieval pipeline remains unchanged.

**Tech Stack:** TypeScript, Node.js filesystem APIs, fast-glob, Zod, Vitest, pnpm.

---

### Task 1: Define Cursor adapter behavior

**Files:**

- Create: `tests/fixtures/cursor/top-level.jsonl`
- Create: `tests/fixtures/cursor/tool-only.jsonl`
- Modify: `tests/adapters/adapters.test.ts`
- Create: `src/adapters/cursor.ts`

- [ ] **Step 1: Add a representative Cursor transcript fixture**

Use Cursor's local record shape, including visible text, hidden reasoning, a tool call that must be omitted, a terminal `turn_ended` event, and one malformed line. Add a second fixture containing only non-visible records:

```json
{"role":"user","message":{"content":[{"type":"text","text":"Review the query. Authorization: Bearer cursor-secret-value"}]}}
{"role":"assistant","message":{"content":[{"type":"thinking","text":"private reasoning"},{"type":"text","text":"Use the indexed path."},{"type":"tool_use","name":"read_file","input":{"path":"secret"}}]}}
{"type":"turn_ended","status":"completed"}
not-json
```

- [ ] **Step 2: Write a failing adapter test**

Import `parseCursorSession`, parse the fixture, and assert source `cursor`, conversation ID from the filename, only two visible turns, the visible fake bearer credential is still present before the upload layer, one malformed line, no leaked reasoning/tool arguments, valid ordered timestamps derived from filesystem metadata, and no subagent skip. Assert the tool-only fixture returns `session: null`.

- [ ] **Step 3: Run the adapter test and verify RED**

Run: `pnpm test tests/adapters/adapters.test.ts`

Expected: FAIL because `src/adapters/cursor.ts` does not exist.

- [ ] **Step 4: Implement the minimal adapter**

Read JSONL with `readJsonLines`; for `user` records, extract only explicit `<user_query>` blocks so Cursor-injected tool, MCP, and Hook contexts never become user turns; pass assistant content through `visibleTurnContent`. Derive `conversationId` from the JSONL basename, use file `birthtime`/`mtime` as timestamp bounds, and return `null` for transcripts with no visible turns.

- [ ] **Step 5: Run the adapter test and verify GREEN**

Run: `pnpm test tests/adapters/adapters.test.ts`

Expected: PASS.

### Task 2: Add Cursor to discovery and configuration

**Files:**

- Modify: `src/domain/session.ts`
- Modify: `src/domain/config.ts`
- Modify: `src/domain/config-io.ts`
- Modify: `src/adapters/index.ts`
- Modify: `tests/domain/session.test.ts`
- Modify: `tests/domain/config.test.ts`
- Modify: `tests/adapters/discovery.test.ts`

- [ ] **Step 1: Write failing domain, config, and discovery tests**

Assert that `SessionSourceSchema` includes `cursor`, default configuration uses `~/.cursor/projects`, an old v1 TOML without `cursor_paths` still loads with the new default, `BRAINHUB_CURSOR_PATHS` overrides and expands paths, and discovery finds `agent-transcripts/<id>/<id>.jsonl` while reporting `status.cursor`. Place another JSONL one level deeper and assert the exact `agent-transcripts/*/*.jsonl` boundary excludes it.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm test tests/domain/session.test.ts tests/domain/config.test.ts tests/adapters/discovery.test.ts`

Expected: FAIL on the missing source, config property, and discovery status.

- [ ] **Step 3: Implement the minimal discovery/config integration**

Add `cursor` to `SessionSourceSchema`; add `cursorPaths` to config schema/defaults, environment loading, and home expansion; extend `DiscoveryOptions.paths` and `DiscoveryResult.status`; glob `**/agent-transcripts/*/*.jsonl` and parse each match with `parseCursorSession`.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `pnpm test tests/domain/session.test.ts tests/domain/config.test.ts tests/adapters/discovery.test.ts`

Expected: PASS.

### Task 3: Carry Cursor through runtime, state, MCP, and scheduling

**Files:**

- Modify: `src/runtime/container.ts`
- Modify: `src/state/sqlite-store.ts`
- Modify: `src/cli/index.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/scheduler/jobs.ts`
- Modify: `tests/runtime/container.test.ts`
- Modify: `tests/state/sqlite-store.test.ts`
- Modify: `tests/mcp/protocol.test.ts`
- Modify: `tests/search/search-service.test.ts`
- Modify: `tests/scheduler/templates.test.ts`
- Modify: `tests/scheduler/manager.test.ts`
- Modify: `tests/e2e/dry-run.test.ts`
- Modify: `tests/e2e/client-install.test.ts`

- [ ] **Step 1: Write failing integration tests**

Extend source lists and fixtures to require all four sources. Assert the Cursor fixture's visible `Authorization: Bearer cursor-secret-value` is replaced by `[REDACTED]` and uploaded to inbox without reasoning/tool parameters; search filtered to `sources: ["cursor"]` returns its reference; `getSession` with that reference reads the full Drive markdown; and a declined fresh-install backfill initializes Cursor's watermark. Through the real in-memory MCP transport, require `upload_sessions` and `get_session` to accept `cursor`. Through the real CLI process, run `--sources cursor --backfill --dry-run` against a temporary Cursor root and assert no Drive/state writes.

Add an old-install compatibility test that seeds account state with a completed pre-Cursor accepted or declined backfill and only the three legacy discovery watermarks, then places an old Cursor transcript before the first ordinary upload. Assert that the first ordinary upload does not backfill that transcript but establishes a Cursor watermark; update or add a Cursor transcript after that watermark and assert the next ordinary upload captures it. This protects the no-silent-history-upload upgrade rule for both prior decisions.

For scheduling, change new launchd jobs to call plain `upload` and rely on runtime defaults, so future source additions do not require another static argument edit. Seed the scheduler test with a legacy three-source plist and assert `SchedulerManager.install` replaces it with the source-neutral job.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm test tests/runtime/container.test.ts tests/state/sqlite-store.test.ts tests/mcp/protocol.test.ts tests/search/search-service.test.ts tests/scheduler/templates.test.ts tests/scheduler/manager.test.ts tests/e2e/dry-run.test.ts tests/e2e/client-install.test.ts`

Expected: FAIL until production source lists and runtime path/status mappings include Cursor.

- [ ] **Step 3: Implement the minimal full-pipeline integration**

Add Cursor to runtime default sources and adapter status mapping, pass `config.capture.cursorPaths` to discovery, initialize Cursor's declined-backfill watermark, and accept Cursor in CLI/MCP source validation. Make the daily uploader source-neutral so it uses those runtime defaults. Keep MCP client registration unchanged because Cursor capture does not require mutating Cursor's MCP client configuration.

- [ ] **Step 4: Run focused integration tests and verify GREEN**

Run the command from Step 2.

Expected: PASS.

### Task 4: Document and verify the public behavior

**Files:**

- Modify: `README.md`
- Modify: `docs/configuration.md`
- Modify: `docs/privacy.md`
- Modify: `CONTEXT.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update source and privacy documentation**

Document Cursor as a supported local source, the default transcript path, `BRAINHUB_CURSOR_PATHS`, the top-level transcript boundary, and the continued exclusion of tool calls/hidden reasoning from normalized sessions. For existing installations, require one `brainhub-mcp setup` or `brainhub-mcp scheduler install` run to replace the legacy three-source launchd plist. Preserve prior accepted/declined backfill decisions: do not silently upload historical Cursor data during upgrade; document `brainhub-mcp upload --sources cursor --backfill` as the explicit opt-in for old Cursor history, while ordinary scheduled capture starts from the first upgraded Cursor scan.

- [ ] **Step 2: Run repository-wide verification**

Run: `pnpm verify`

Expected: all tests, type checking, lint, formatting, build, and package checks pass.

- [ ] **Step 3: Run a real local dry run scoped to Cursor**

Run: `pnpm dev upload --sources cursor --backfill --dry-run --json`

Expected: Cursor transcripts are discovered and normalized without Drive or local state writes.
