# BrainHub MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-ready Node.js/TypeScript stdio MCP server that captures Claude Code, Codex CLI, and Grok Build sessions, uploads normalized and redacted snapshots to Google Drive, provides portrait/status tools, and supports hybrid semantic session search.

**Architecture:** Keep source adapters and domain transformations pure, then inject state, Drive, secret-store, embedding, scheduler, and client-registration ports at the application boundary. Google Drive remains the canonical data store; local persistence is limited to upload watermarks, hashes, device metadata, OAuth secrets, and the embedding model cache. The first delivery ends at a real local dry-run; OAuth, Drive writes, client registration, and scheduler installation require a second explicit approval.

**Tech Stack:** Node.js 22, TypeScript, pnpm, `@modelcontextprotocol/sdk`, Zod, Google APIs, SQLite, Sharp, Transformers.js/ONNX, Vitest, ESLint, Prettier.

---

## Resolved Product Decisions

- Capture Claude Code, Codex CLI, and Grok Build; do not capture Gemini CLI yet.
- Never delete source-owned CLI history. Delete only BrainHub temporary files after verified upload.
- Archive top-level user and visible assistant text plus explicit message images. Exclude system/developer prompts, internal reasoning, tool arguments/results, shell output, environment snapshots, and subagents by default.
- Redact high-confidence credentials locally before anything reaches Drive. Leave semantic customer-name redaction to the future cloud ingest stage.
- Perform a resumable full-history backfill, then upload only new or changed canonical snapshots.
- Keep one canonical latest snapshot per `source + conversation_id`; do not create revision files.
- Store only non-content upload state locally and mirror the device watermark to Drive.
- Use `googleapis` OAuth. Store refresh tokens in macOS Keychain or Linux Secret Service. Restrict code operations to one configured BrainHub root folder.
- Discover the active Obsidian vault first; otherwise use a configured writable fallback. Pull both `portrait.md` and `weekly-latest.md`.
- Register with Claude Code, Codex CLI, and Grok Build through their official commands; support Claude Desktop as an explicit optional target.
- Search `cards`, then `sessions`, then `inbox`, deduplicating by conversation ID.
- Support hybrid semantic search with local `multilingual-e5-small` embeddings. This is an explicitly approved exception to the literal C6 wording: C6 means no metered model API; a local non-generative retrieval model is allowed. Cache only the model locally; store versioned vector shards in Drive and stream them into memory for queries.
- Schedule upload for 02:00 local time, with installation-time and missed-run catch-up.
- This implementation turn may scan local data and run `--dry-run`, but must not authenticate to Drive, upload files, modify MCP client configs, or install an OS scheduler.

## Frozen Runtime Contracts

### Configuration

Configuration precedence is `one-shot CLI flag > environment variable > config.toml > auto-discovery/default`. The one user-requested exception is portrait output: `active Obsidian vault/BrainHub > configured publish.fallback_path`; the configured path is used only when no active vault is found.

Config locations:

- macOS: `~/Library/Application Support/BrainHub/config.toml`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/brain-mcp/config.toml`
- macOS state: `~/Library/Application Support/BrainHub/state.sqlite`
- Linux state: `${XDG_STATE_HOME:-~/.local/state}/brain-mcp/state.sqlite`
- macOS model cache: `~/Library/Caches/BrainHub/models`
- Linux model cache: `${XDG_CACHE_HOME:-~/.cache}/brain-mcp/models`

```toml
version = 1

[device]
# id is generated once in state.sqlite; name defaults to os.hostname()
name = ""

[drive]
root_folder_id = ""                # required for live tools after `drive init`
root_folder_name = "brain-hub"
oauth_client_file = ""             # env: BRAINHUB_GOOGLE_OAUTH_CLIENT_FILE

[capture]
claude_paths = ["~/.claude/projects"]
codex_paths = ["~/.codex/sessions"]
grok_paths = ["~/.grok/sessions"]
include_subagents = false
internal_domains = []
internal_cidrs = []

[publish]
fallback_path = ""

[upload]
batch_size = 100
concurrency = 4

[search]
model = "Xenova/multilingual-e5-small"
model_revision = "ae61bf0193ce3851dc8a45147e459b04ed783d8a"
dimensions = 384
chunk_tokens = 448
chunk_overlap = 64
default_limit = 10
max_limit = 50

[scheduler]
at = "02:00"
```

OAuth tokens are never stored in TOML or environment variables. `device.id` and state paths may be overridden only in tests through an injected platform-path object, not through MCP tool input.

Environment overrides are frozen as `BRAINHUB_CONFIG`, `BRAINHUB_DEVICE_NAME`, `BRAINHUB_DRIVE_ROOT_ID`, `BRAINHUB_GOOGLE_OAUTH_CLIENT_FILE`, `BRAINHUB_PUBLISH_FALLBACK_PATH`, `BRAINHUB_CLAUDE_PATHS`, `BRAINHUB_CODEX_PATHS`, `BRAINHUB_GROK_PATHS`, `BRAINHUB_INCLUDE_SUBAGENTS`, `BRAINHUB_UPLOAD_BATCH_SIZE`, `BRAINHUB_UPLOAD_CONCURRENCY`, `BRAINHUB_MODEL_CACHE`, and `BRAINHUB_SCHEDULE_AT`. List values use the platform path delimiter. Matching CLI flags use kebab-case on the command that consumes them, for example `upload --batch-size`, `upload --include-subagents`, `scheduler install --at`, and `config --file`.

### Source Event Mapping

- Claude Code: discover `~/.claude/projects/**/*.jsonl`; group by file/session ID; accept records with `type=user|assistant`, read `message.role` and string content or `message.content[]` text/image blocks; decode only explicit `source.type=base64` image blocks; derive start/update from min/max record `timestamp`; skip a file by default when its conversation records are `isSidechain=true`; ignore queue/title/summary/tool/thinking records.
- Codex CLI: discover `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`; read ID/timestamp/source from `type=session_meta`; accept only `type=response_item`, `payload.type=message`, `payload.role=user|assistant`, and `input_text|output_text|input_image` content; ignore duplicate `event_msg`, reasoning, function calls/results, and turn context; skip when `session_meta.payload.source` is an object containing `subagent`; treat string sources `cli|exec|mcp|vscode|unknown` as top-level.
- Grok Build: discover `~/.grok/sessions/<encoded-cwd>/<session-id>/`; read timestamps and `session_kind` from `summary.json`; parse `chat_history.jsonl` records with `type=user|assistant`, accepting string content or array text/image blocks; ignore `system`, `reasoning`, `tool_result`, and `tool_calls`; skip when `summary.session_kind=subagent`; `agent_name` values such as `cursor` and `grok-build-plan` remain top-level unless `session_kind` says otherwise.
- Every adapter tolerates invalid/truncated final JSONL lines, reports them as aggregate warnings, and never prints or modifies source content.

### Drive Layout and Multi-Device Arbitration

```text
brain-hub/
  inbox/<device-name>/<source>-<YYYYMMDD>-<id-prefix>.md
  images/sha256/<first-two>/<sha256>.webp
  cards/YYYY-MM/*.md
  sessions/YYYY-MM/*.md
  publish/portrait.md
  publish/weekly-latest.md
  _meta/devices/<device-id>.json
  _meta/search/v1/manifest.json
  _meta/search/v1/objects/<kind>/<YYYY-MM>/<content-sha>.vec
```

Every uploaded conversation candidate carries Drive `appProperties`: `brainhubKey=sha256(source + NUL + conversation_id)`, `source`, `conversationId`, `deviceId`, `updatedAt`, and `contentSha256`. The uploader first lists all files with the same `brainhubKey`; an older local snapshot is skipped. A new/changed snapshot is uploaded under its device inbox with a unique temporary name, downloaded or checksummed for verification, and then reconciled globally. All devices choose the same winner by `(updatedAt, contentSha256, Drive fileId)` descending, rename that winner to the stable filename, and trash only losing BrainHub-owned inbox candidates. This deterministic reconciliation is repeated by upload/status runs to repair Drive listing races; no device updates another candidate in place, so an older writer cannot overwrite newer content.

Source files are always read-only. Normalized content is streamed from memory; any OS temporary image file is removed in `finally` after success or failure because the unchanged source is the recovery record. State is marked uploaded only after Drive content verification and reconciliation.

Image candidates use the same create/verify/reconcile pattern keyed by SHA-256. Device watermarks are independent, while search and the future ingest stage deduplicate by `brainhubKey`.

Status metadata is also frozen for the independently developed cloud pipeline:

```json
// _meta/distill-status.json
{
  "schema_version": 1,
  "daily": { "status": "success|running|failed|never", "last_started_at": null, "last_completed_at": null, "error_code": null },
  "weekly": { "status": "success|running|failed|never", "last_started_at": null, "last_completed_at": null, "error_code": null }
}

// each line of _meta/capacity.jsonl
{
  "schema_version": 1,
  "timestamp": "2026-07-19T00:00:00.000Z",
  "used_bytes": 0,
  "total_bytes": 0,
  "usage_ratio": 0,
  "directories": { "inbox": 0, "sessions": 0, "images": 0, "cards": 0, "weekly": 0, "publish": 0, "_meta": 0 }
}
```

`hub_status` computes live Drive quota and inbox counts, reads the last valid capacity JSONL line and the distill status document, and reports malformed/missing metadata as warnings rather than failing the whole tool.

### OAuth and Tool Output

Live authentication requests `https://www.googleapis.com/auth/drive`, not `drive.file`, because the MCP must read files created by Codex Cloud and other clients. The broad token is constrained operationally: every read/write resolves from the configured root ID, mutations verify root ancestry, and the implementation refuses arbitrary Drive file IDs supplied by MCP callers.

All MCP tools return a concise human-readable text block plus `structuredContent`. List results default to 10, cap at 50, and truncate the text response before 64 KiB. Stable error codes include `AUTH_REQUIRED`, `DRIVE_ROOT_REQUIRED`, `PUBLISH_PATH_REQUIRED`, `SOURCE_UNAVAILABLE`, `INDEX_STALE`, `UPLOAD_BUSY`, and `INVALID_INPUT`; errors never include tokens or message bodies.

Structured output contracts:

```ts
type UploadOutput = {
  dryRun: boolean;
  scanned: number;
  eligible: number;
  uploaded: number;
  unchanged: number;
  skippedSubagents: number;
  malformed: number;
  redactions: number;
  images: number;
  estimatedBytes: number;
  warnings: Warning[];
};
type SearchOutput = {
  query: string;
  indexStatus: "fresh" | "stale";
  results: Array<{
    score: number;
    kind: "card" | "session" | "inbox";
    source: string;
    conversationId: string;
    startedAt: string;
    updatedAt: string;
    excerpt: string;
    driveFileId: string;
  }>;
  warnings: Warning[];
};
type PortraitOutput = {
  portrait: string;
  localRefreshed: boolean;
  localPath?: string;
  diff?: string;
  weeklyRefreshed?: boolean;
  warnings: Warning[];
};
type StatusOutput = {
  drive: {
    reachable: boolean;
    usedBytes?: number;
    totalBytes?: number;
    usageRatio?: number;
  };
  inbox: Record<string, number>;
  distill: object;
  capacity?: object;
  adapters: object;
  scheduler: object;
  warnings: Warning[];
};
type Warning = { code: string; message: string };
```

### Semantic Index Production

- Upload embeds the final redacted normalized conversation around its verified Drive write and writes a content-addressed vector object under `_meta/search/v1/objects/inbox/YYYY-MM/`.
- Moving inbox content to `sessions/` does not require re-embedding when `content_sha256` is unchanged; the manifest adds the new Drive file reference to the existing vector object.
- Before every semantic query, index sync lists changed `cards`, `sessions`, and `inbox` Markdown since the manifest cursor, reuses vectors by `content_sha256`, and locally embeds only new/changed content. This makes cards produced by the cloud pipeline searchable without requiring a model API.
- `brain-mcp search sync` performs incremental refresh; `search reindex` rebuilds a corrupt/missing version from canonical Drive Markdown. Scheduled upload also runs incremental sync after success.
- If sync cannot finish, search returns existing hybrid results with `INDEX_STALE`; it never silently claims complete semantic coverage.
- Manifest updates use Drive version/ETag preconditions and retry on conflict. Corrupt objects fail checksum validation and are rebuilt from Drive source content.

### Portrait and Client Registration

`get_portrait` has no refresh switch: it always reads `publish/portrait.md`, always attempts an atomic local refresh, and still returns the Drive content with a warning if no writable output exists. `pull_portrait` always fetches and atomically replaces both publish files, and returns the Diff section.

Pinned command contracts discovered from the installed client CLIs; tests assert argument arrays, not shell strings:

```text
claude mcp add --scope user brain-hub -- <absolute-brain-mcp> serve
codex mcp add brain-hub -- <absolute-brain-mcp> serve
grok mcp add --scope user brain-hub -- <absolute-brain-mcp> serve
```

Removal uses each client's `mcp remove brain-hub` command (and Claude's user scope option when supported). Before mutation, registration code checks `<client> mcp add --help` for required syntax and returns `CLIENT_VERSION_UNSUPPORTED` instead of guessing. Claude Desktop is handled by lossless JSON merge with backup and is opt-in.

## File Map

```text
package.json                         scripts, dependencies, bin entry
tsconfig.json                        strict Node ESM build
eslint.config.js                     lint rules
src/domain/session.ts                normalized session and turn contracts
src/domain/config.ts                 validated configuration contracts
src/domain/errors.ts                 stable user-facing error codes
src/adapters/{claude,codex,grok}.ts  source discovery and pure parsing
src/capture/normalize.ts             Markdown/frontmatter rendering
src/capture/redact.ts                deterministic high-confidence redaction
src/capture/images.ts                image extraction, hashing, WebP conversion
src/state/store.ts                   state-store port
src/state/sqlite-store.ts            SQLite watermarks and upload attempts
src/drive/drive-port.ts              testable Drive interface
src/drive/google-drive.ts            Drive folders/files/quota implementation
src/auth/secret-store.ts             secret-store interface
src/auth/platform-secrets.ts         Keychain/Secret Service implementation
src/auth/google-oauth.ts             browser OAuth and token refresh
src/upload/upload-service.ts         backfill, incremental upload, idempotency
src/search/embedder.ts               embedding interface and local E5 provider
src/search/vector-format.ts          versioned content-addressed vector-object codec
src/search/search-service.ts         hybrid retrieval and deduplication
src/portrait/portrait-service.ts     Drive reads, atomic local writes, Diff extraction
src/status/status-service.ts         local/Drive/scheduler status aggregation
src/mcp/server.ts                    five MCP tool schemas and handlers
src/cli/index.ts                     auth/config/upload/search/scheduler/client commands
src/clients/registry.ts              official CLI registration adapters
src/scheduler/{launchd,systemd}.ts   generated service definitions
src/scheduler/manager.ts             install/status/uninstall boundary
src/runtime/container.ts             dependency assembly
tests/fixtures/**                    synthetic source and Drive fixtures only
tests/**/*.test.ts                   unit and integration behavior
docs/configuration.md                setup, OAuth, paths, scheduling, privacy
README.md                            install, dry-run, tools, second deployment gate
```

### Task 1: Project Contract and Configuration

**Files:**

- Create: `package.json`, `tsconfig.json`, `eslint.config.js`, `.gitignore`
- Create: `src/domain/session.ts`, `src/domain/config.ts`, `src/domain/errors.ts`
- Test: `tests/domain/session.test.ts`, `tests/domain/config.test.ts`

- [ ] Write failing tests for the normalized source enum, stable conversation key, ISO timestamps, every field/default/path/precedence in the frozen configuration contract, and invalid writable/search settings.
- [ ] Run `pnpm vitest run tests/domain` and verify failures are caused by missing domain modules.
- [ ] Add the smallest strict TypeScript contracts and Zod schemas that satisfy the tests.
- [ ] Re-run the domain tests, then run `pnpm typecheck`.
- [ ] Record the checkpoint in this plan; this directory is not a Git repository, so do not create commits unless the user later requests Git initialization.

Core contract:

```ts
type SessionSource = "claude-code" | "codex" | "grok-build";
type Turn = { role: "user" | "assistant"; text: string; images: ImageRef[] };
type NormalizedSession = {
  source: SessionSource;
  conversationId: string;
  device: string;
  startedAt: string;
  updatedAt: string;
  turns: Turn[];
  sourcePath: string;
};
```

### Task 2: Source Adapters

**Files:**

- Create: `src/adapters/types.ts`, `src/adapters/claude.ts`, `src/adapters/codex.ts`, `src/adapters/grok.ts`, `src/adapters/index.ts`
- Create: `tests/fixtures/claude/*.jsonl`, `tests/fixtures/codex/*.jsonl`, `tests/fixtures/grok/*`
- Test: `tests/adapters/claude.test.ts`, `tests/adapters/codex.test.ts`, `tests/adapters/grok.test.ts`

- [ ] Add synthetic fixtures mirroring every field in the frozen real-event mapping and covering visible messages, reasoning, tools, images, malformed trailing JSON, and subagent markers without copying any real conversation content.
- [ ] Write failing adapter tests asserting discovery paths, top-level filtering, visible-text extraction, timestamp derivation, and stable IDs.
- [ ] Run each adapter test separately and verify expected missing-implementation failures.
- [ ] Implement streaming JSONL readers from the frozen paths/fields that tolerate an incomplete final line and never mutate source files.
- [ ] Implement Claude `isSidechain`, Codex `session_meta.source`, and Grok `session_kind/agent_name` filtering, with an opt-in `includeSubagents` flag.
- [ ] Run adapter tests and a typecheck.

### Task 3: Normalization, Redaction, and Images

**Files:**

- Create: `src/capture/normalize.ts`, `src/capture/redact.ts`, `src/capture/images.ts`
- Test: `tests/capture/normalize.test.ts`, `tests/capture/redact.test.ts`, `tests/capture/images.test.ts`

- [ ] Write failing tests for YAML frontmatter, stable collision-safe filenames, User/Assistant Markdown, and logical BrainHub image references.
- [ ] Write failing tests for private keys, bearer tokens, cookies, credential URLs, configured CIDRs/domains, false-positive resistance, rule version, and hit count.
- [ ] Write failing image tests for data/base64 decode, SHA-256 addressing, WebP quality 80, repeated-image deduplication, and remote URL preservation.
- [ ] Run capture tests and verify RED.
- [ ] Implement pure normalization and redaction first; then implement Sharp-backed image conversion behind an injected image store.
- [ ] Re-run capture tests and ensure source fixture bytes remain unchanged.

Normalized frontmatter extends the manual only with operational fields:

```yaml
source: codex
conversation_id: 019ac608-...
device: macbook-hong
started_at: 2026-07-19T01:00:00.000Z
updated_at: 2026-07-19T02:00:00.000Z
turn_count: 12
content_sha256: ...
redaction_version: 1
redaction_count: 2
```

### Task 4: State and Upload Planning

**Files:**

- Create: `src/state/store.ts`, `src/state/sqlite-store.ts`, `src/upload/upload-service.ts`, `src/upload/lock.ts`
- Test: `tests/state/sqlite-store.test.ts`, `tests/upload/upload-service.test.ts`

- [ ] Write failing tests for device identity, watermarks, attempts, resumable batches, changed sessions, unchanged sessions, deterministic multi-device candidate arbitration, listing-race repair, and retryable/permanent failures.
- [ ] Write failing layout tests proving conversations land in `inbox/<device>/`, images in `images/sha256/`, device mirrors in `_meta/devices/`, and vector data only in `_meta/search/v1/`.
- [ ] Write failing recovery tests proving source files are never deleted, successful state is recorded only after remote verification, and BrainHub temporary files/buffers do not persist after either success or failure.
- [ ] Write failing concurrency tests proving a scheduled upload and MCP upload cannot overlap.
- [ ] Run state/upload tests and verify RED.
- [ ] Implement SQLite migrations and the upload planner without storing message bodies.
- [ ] Add a process/file lock, bounded concurrency, retry with jitter, and state transitions `pending -> uploaded|failed`.
- [ ] Prove a failed batch resumes from its first incomplete session and a repeated successful run plans zero writes.

### Task 5: Google OAuth and Drive Boundary

**Files:**

- Create: `src/drive/drive-port.ts`, `src/drive/google-drive.ts`
- Create: `src/auth/secret-store.ts`, `src/auth/platform-secrets.ts`, `src/auth/google-oauth.ts`
- Test: `tests/drive/google-drive.test.ts`, `tests/auth/platform-secrets.test.ts`, `tests/auth/google-oauth.test.ts`

- [ ] Define a complete in-memory Drive test implementation before writing the Google adapter.
- [ ] Write failing tests for root-folder scoping, folder creation, canonical upsert, app properties, image race reconciliation, content verification, portrait reads, quota reads, watermark mirrors, incremental changed-file listing, Markdown reads, vector-object reads/writes, manifest reads, and ETag-conditional manifest updates.
- [ ] Write failing secret-store tests against temporary fake `security`/`secret-tool` executables rather than a mocked high-level store.
- [ ] Write failing OAuth tests for the exact full-Drive scope, missing client config, first login, refresh, revoked token, and non-interactive scheduler use.
- [ ] Implement Google Drive operations with shared-drive flags where applicable and enforce parent ancestry before every mutation.
- [ ] Implement platform secret commands without ever printing token values.
- [ ] Keep all network tests hermetic; do not perform real OAuth or Drive calls in this delivery phase.

### Task 6: Vector and Hybrid Search

**Files:**

- Create: `src/search/embedder.ts`, `src/search/e5-embedder.ts`, `src/search/vector-format.ts`, `src/search/search-service.ts`
- Modify: `src/drive/drive-port.ts`, `src/drive/google-drive.ts`
- Test: `tests/search/vector-format.test.ts`, `tests/search/search-service.test.ts`, `tests/search/e5-smoke.test.ts`
- Modify test: `tests/drive/google-drive.test.ts`

- [ ] Write failing tests for 512-token-safe chunking, overlap, query/passage prefixes, normalized 384-dimensional vectors, model versioning, and deterministic chunk IDs.
- [ ] Write failing codec tests for one content-addressed `.vec` object per `content_sha256` under kind/month directories, checksums, corrupt object rejection, and streaming top-k cosine search without local persistence.
- [ ] Write failing hybrid-ranking tests for semantic-only matches, keyword boosts, source priority (`cards`, `sessions`, `inbox`), time/source filters, conversation deduplication, and `INDEX_STALE` disclosure.
- [ ] Write failing index lifecycle tests proving upload indexes redacted inbox content, moved sessions reuse content-addressed vectors, newly generated cards are indexed before search, and corrupt/missing indexes rebuild from Drive Markdown.
- [ ] Implement the embedder interface and fake deterministic embedder for behavior tests.
- [ ] Implement the E5 provider with explicit quantized model selection and an overridable cache directory.
- [ ] Add an opt-in smoke test that downloads/loads the real model only when `BRAINHUB_RUN_MODEL_TEST=1`; normal CI remains offline.
- [ ] Implement real Google Drive incremental listing, vector-object I/O, and manifest ETag compare-and-swap so concurrent devices retry rather than lose index references.

### Task 7: Portrait and Hub Status

**Files:**

- Create: `src/portrait/portrait-service.ts`, `src/portrait/obsidian.ts`, `src/status/status-service.ts`
- Test: `tests/portrait/portrait-service.test.ts`, `tests/status/status-service.test.ts`

- [ ] Write failing tests for active-vault discovery on macOS/Linux, configured fallback, writable-path validation, and missing-path behavior.
- [ ] Write failing tests for atomic replacement of both publish files and robust extraction of `变更 Diff`, `本期变化`, or `Diff` sections.
- [ ] Write failing status tests against the exact `_meta/distill-status.json` and `_meta/capacity.jsonl` schemas, including inbox counts, quota percentages, adapter watermarks, scheduler state, malformed trailing capacity lines, and graceful missing metadata.
- [ ] Implement `get_portrait` so every call reads Drive and attempts local refresh by default, while still returning Drive content with a warning when refresh is unavailable; make `pull_portrait` require a valid discovered/fallback destination.
- [ ] Implement status aggregation with partial results and stable warning codes.

### Task 8: MCP Server and CLI

**Files:**

- Create: `src/mcp/server.ts`, `src/cli/index.ts`, `src/runtime/container.ts`
- Test: `tests/mcp/server.test.ts`, `tests/cli/dry-run.test.ts`, `tests/cli/commands.test.ts`

- [ ] Write failing MCP protocol tests for `upload_sessions`, `search_sessions`, `get_portrait`, `pull_portrait`, and `hub_status`, including Zod input errors and bounded response sizes.
- [ ] Write failing CLI routing tests for `serve`, `config`, `auth login|status`, `drive init|status`, `upload --dry-run|--backfill`, `search model status|clear`, `search sync|reindex`, `clients install|uninstall|status`, `scheduler install|uninstall|status`, and machine-readable JSON output.
- [ ] Implement thin MCP/CLI handlers that delegate to application services and map domain errors to actionable messages.
- [ ] Ensure stdio stdout contains protocol messages only; route diagnostics to stderr with structured redaction.
- [ ] Run MCP and CLI tests using isolated HOME/XDG directories.

Tool inputs:

```ts
upload_sessions({ sources?, backfill?, include_subagents?, dry_run? })
search_sessions({ query, from?, to?, sources?, limit?, include_original? })
get_portrait({})
pull_portrait({})
hub_status({ include_local?: true })
```

### Task 9: Client Registration and OS Scheduling

**Files:**

- Create: `src/clients/registry.ts`
- Create: `src/scheduler/launchd.ts`, `src/scheduler/systemd.ts`, `src/scheduler/manager.ts`
- Modify: `src/cli/index.ts`, `src/runtime/container.ts`
- Test: `tests/clients/registry.test.ts`, `tests/scheduler/launchd.test.ts`, `tests/scheduler/systemd.test.ts`
- Modify test: `tests/cli/commands.test.ts`

- [ ] Write failing tests for detection, help-based version guards, and the exact frozen argument arrays for Claude Code, Codex CLI, and Grok Build; test Claude Desktop JSON merging without deleting unrelated entries.
- [ ] Write failing launchd tests for 02:00, `RunAtLoad`, absolute executable paths, metadata-only logs, and idempotent install/uninstall.
- [ ] Write failing systemd tests for `Type=oneshot`, `OnCalendar=*-*-* 02:00:00`, `Persistent=true`, and user-unit reload/enable behavior.
- [ ] Implement generators as pure functions, then inject the actual process/filesystem boundary.
- [ ] Wire all client/scheduler subcommands through the runtime container. In this delivery phase, test generated files and print planned mutations only; do not call client add/remove or scheduler install.

### Task 10: End-to-End Dry Run and Documentation

**Files:**

- Create: `README.md`, `docs/configuration.md`
- Modify: all files only as required by defects reproduced with a failing test

- [ ] Write an end-to-end test that scans synthetic histories, filters subagents/tools, redacts, extracts/deduplicates images, plans canonical Drive writes in memory, builds content-addressed vector objects, and reports dry-run totals.
- [ ] Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build` in parallel after focused tests pass.
- [ ] Run the built CLI against the real local source directories using `upload --backfill --dry-run --json`; confirm it performs zero Drive/client/scheduler mutations.
- [ ] Inspect the dry-run report for source counts, skipped subagents, malformed sessions, redactions, image estimates, and estimated upload bytes without printing message content.
- [ ] Document Google OAuth client creation, Drive root binding, privacy boundaries, vector model storage, Obsidian discovery/fallback, scheduler behavior, and the second deployment gate commands.
- [ ] Do not run the live commands below until the user approves the dry-run report:

```bash
brain-mcp auth login
brain-mcp drive init
brain-mcp upload --backfill
brain-mcp clients install --all
brain-mcp scheduler install --at 02:00
```

## Verification Commands

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
node dist/cli/index.js upload --backfill --dry-run --json
```

Expected final state: all automated checks pass; the real dry-run emits only aggregate metadata; no Drive writes, OAuth login, MCP client configuration changes, or scheduler installation has occurred.
