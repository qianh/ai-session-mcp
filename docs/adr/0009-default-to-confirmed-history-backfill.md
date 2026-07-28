# Default to confirmed history backfill

Initial BrainHub MCP setup and each newly selected account/root binding default to uploading all discovered top-level CLI session history. Before any upload BrainHub MCP shows counts and estimated bytes without message content and requires confirmation. The decision is persisted before upload: accepted but incomplete work retries without another prompt, completed work is skipped on rerun, and a decline atomically records current source watermarks so scheduled uploads process only future sessions.
