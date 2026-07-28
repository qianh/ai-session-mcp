# Cache redacted text chunks in the local index

The per-device search index stores redacted session text chunks, vectors, references, and the Drive change cursor in a user-private local SQLite database. This enables fast semantic retrieval, keyword fallback, excerpts, and stale-index operation without rescanning the complete inbox for every query. It does not cache image binaries and is never an authoritative source for `get_session`, which reads the complete session from Drive. Complete uninstall deletes the database.
