# Support concurrent multi-device uploads

BrainHub MCP supports multiple macOS installations connected to the same Google account. Setup generates an immutable device ID and initializes a separately editable display name from the hostname. Remote session identity is based on `source` plus `conversation_id`, not hostname, local file path, or device ID, so concurrent uploads of the same logical session converge instead of creating device-specific copies.
