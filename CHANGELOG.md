# Changelog

## Unreleased

- Support Linux with Secret Service credentials and systemd user timers.

## 0.1.2 - 2026-08-25

- Add local Cursor agent transcript capture, redaction, upload, search, and complete session retrieval.
- Make new daily upload jobs source-neutral so future capture sources follow runtime defaults.
- Exclude Cursor-injected tool, MCP, and Hook context from user messages.
- Persist the approved backfill source scope so upgrades cannot silently add new sources.

## 0.1.0

- Publish the macOS-only `brainhub-mcp` package with guided setup.
- Expose five MCP tools for upload, inbox search/read, portrait read, and status.
- Store semantic search state locally and keep Drive session writes under `inbox/`.
- Add optional daily Obsidian portrait sync and complete non-destructive uninstall.
