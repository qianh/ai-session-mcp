# Make setup idempotent and resumable

`brainhub-mcp setup` is an idempotent, resumable workflow rather than an all-or-nothing transaction. It validates existing authorization and persists the outcome of each step so a rerun continues only missing or failed work. Backfill acceptance is recorded before uploading and completion is recorded only when no retryable session remains. Google authorization, model download, backfill confirmation and completion, client registration, and scheduled-task installation must tolerate retries without duplicate grants, uploads, configuration entries, or jobs.
