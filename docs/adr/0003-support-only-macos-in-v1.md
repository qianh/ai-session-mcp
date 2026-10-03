# Support only macOS in the first public release

Superseded for Linux by [ADR 0033](0033-support-linux-with-secret-service-and-systemd.md). Windows remains unsupported.

The first public BrainHub MCP release officially supports macOS only. Setup, credential storage, background scheduling, platform paths, packaging, documentation, and release verification target macOS Keychain and launchd. Linux and Windows support are deferred and are not implied by source-level portability or leftover prototype code; unsupported platform implementations should be removed from the v1 distribution surface.
