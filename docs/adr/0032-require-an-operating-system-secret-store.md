# Require an operating-system secret store

BrainHub MCP stores Google refresh tokens only in macOS Keychain. Setup verifies Keychain access before starting OAuth and stops with a diagnostic when it is unavailable. There is no plaintext file fallback, even with restrictive file permissions. Linux and Windows credential stores are deferred with those platforms rather than included as unverified v1 paths.
