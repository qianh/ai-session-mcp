# Require an operating-system secret store

Linux Secret Service support is added by [ADR 0033](0033-support-linux-with-secret-service-and-systemd.md). Windows credential storage remains unsupported. Plaintext file fallback remains forbidden.

BrainHub MCP stores Google refresh tokens only in an operating-system secret store: macOS Keychain or Linux Secret Service. Setup verifies that store before starting OAuth and stops with a diagnostic when it is unavailable. There is no plaintext file fallback, even with restrictive file permissions.
