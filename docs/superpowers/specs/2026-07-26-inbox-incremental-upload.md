# Inbox-Only Daily Incremental Upload Specification

## Goal

BrainHub must upload new or changed local sessions from Claude Code, Codex, and
Grok Build every day without scanning or rebuilding unrelated remote content.

## Remote Boundary

- Scheduled and manual session uploads may create, read, reconcile, move, or
  trash only objects under `inbox/`.
- Session Markdown remains under `inbox/<device>/`.
- Embedded image artifacts live under `inbox/_assets/sha256/` so every upload
  artifact remains inside the same remote boundary.
- Candidates with the same `brainhubKey` outside `inbox/` are ignored.
- Image objects with the same `brainhubImageSha` outside `inbox/` are ignored.
- Session upload does not write `_meta/devices`, `_meta/search`, `cards/`,
  `sessions/`, or any other remote prefix.
- The upload-facing Drive boundary must not enumerate, resolve, read, move, or
  trash an object outside `inbox/`, even when an out-of-scope object has a
  matching app property.
- The upload-facing boundary validates every returned entry path before
  authorizing its ID; a buggy lower-level Drive returning an out-of-scope entry
  is rejected rather than trusted.
- Existing standalone search commands remain available, but session upload
  never invokes search indexing automatically.

## Incremental Contract

- The default source set is exactly `claude-code`, `codex`, and `grok-build`.
- Each successful scan advances its per-source local SQLite discovery
  watermark.
- A normal run discovers files modified after the previous watermark and also
  retries locally pending or retryable failed source paths.
- A repeated run with unchanged source content performs no remote write.
- `--backfill` remains the explicit mechanism for scanning all available
  history.
- Upload failures remain retryable and do not advance a session to uploaded
  state.
- Adapter and preprocessing failures cannot become invisible after a watermark
  advances: the failed source path remains pending/retryable, or that source's
  watermark remains unchanged.
- Once a verified candidate becomes the stable inbox canonical, later local
  state or loser-cleanup failures must never delete it. A subsequent run must
  converge the remaining candidates and repair local uploaded state.

## Scheduling Contract

- macOS launchd and Linux systemd jobs explicitly invoke all three sources.
- The configured daily time remains authoritative, with `02:00` as the default.
- The upload process terminates after session upload; portrait synchronization
  remains a separate job.
- Installing or repairing the scheduler regenerates the job definitions with
  the inbox-only command.

## Acceptance Criteria

1. A scheduled command contains
   `upload --sources claude-code,codex,grok-build --json`.
2. An upload containing a session and an embedded image leaves every created
   remote object under `inbox/`.
3. A newer matching object outside `inbox/` does not suppress an inbox upload.
4. A successful upload never calls `SearchService.sync()` and never emits
   `INDEX_STALE` or `INDEX_SKIPPED`.
5. Existing incremental watermark, pending retry, redaction, verification,
   concurrency, and idempotency tests continue to pass.
6. After rebuilding and reinstalling the local scheduler, one real incremental
   run finishes and reports the aggregate results for all three sources.
7. A three-source integration run advances independent watermarks; a second
   unchanged run performs zero remote writes.
   If one adapter fails, only that source's watermark remains unchanged while
   the other successful sources advance.
8. Reinstalling either a macOS or Linux scheduler over an old definition
   replaces it with the explicit three-source command without changing the
   portrait job.
