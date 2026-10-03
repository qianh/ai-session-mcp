# Contributing

BrainHub MCP accepts focused issues and pull requests that preserve its local-first scope on macOS and Linux.

Before submitting a change:

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

Do not commit OAuth credentials, refresh tokens, raw user sessions, generated model files, SQLite indexes, Keychain or Secret Service exports, or maintainer release artifacts. New behavior should include tests and update the public contract when it changes.

Official OAuth credentials are injected only by the release workflow. Fork maintainers are responsible for their own Google Cloud project, consent screen, verification, and data-use disclosures.
