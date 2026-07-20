# Google Account Onboarding Specification

## Goal

Make Google Drive authorization a guided, account-aware flow. A user runs one
command, chooses the Google account they want to connect, grants access, and
receives confirmation that BrainHub is bound to that account's Drive root.

## Scope

- Support one active Google account per local BrainHub configuration.
- Keep the existing Desktop OAuth client JSON configuration.
- Keep the existing full Drive scope and root-bound Drive safety checks.
- Keep `drive init` for backward compatibility, while making it unnecessary
  after a successful `auth login`.
- Do not add multi-profile account management in this change.
- Do not change Google Cloud publishing or verification status in this change.

## User Experience

1. `brain-mcp auth login` prints a concise message explaining that a browser
   will open and that the selected Google account will become the active
   BrainHub account. JSON mode prints only the final JSON result.
2. The browser always shows Google's account chooser, even when a valid token
   already exists.
3. The authorization-code flow uses state validation and PKCE S256.
4. After consent, BrainHub calls Drive `about.get` to read the actual account's
   display name, email address, and permission ID.
5. BrainHub creates or reuses `brain-hub` in that authenticated account's
   Drive, then persists the account identity and root folder ID.
6. The command returns the selected account and bound Drive root. It never
   prints OAuth credentials.
7. Re-running login is the supported account-switch flow. Configuration is
   updated only after identity lookup and root binding succeed.
8. A newly issued credential remains staged in memory until identity lookup and
   root binding succeed. Committing the credential and configuration is treated
   as one operation; a failed configuration write restores the previous
   credential.

## Status And Logout

- `auth status` validates the stored credential against Google and reports the
  actual account identity plus the configured root binding. A successful result
  includes `identityMatches`, comparing permission IDs rather than display text.
- A missing or invalid credential reports `authenticated: false` with a stable
  `reason` of `missing_credential` or `invalid_credential`, without exposing
  stored credential data.
- `auth logout` deletes the credential and clears account identity and Drive
  root binding so a later user cannot inherit a stale folder ID.
- `drive status` includes the configured account email when available.

## Configuration

The `drive` section adds backward-compatible string fields with empty defaults:

```toml
account_email = ""
account_display_name = ""
account_permission_id = ""
```

Existing version 1 TOML files continue to load through the default merge.

Credentials are keyed by the resolved configuration-file path, not the device
name, so two `--config` files on the same computer cannot overwrite each other.
The first read migrates an existing device-name-keyed credential to the new
configuration key. CLI commands and the long-running MCP runtime use the same
SecretStore factory and resolved config path.

## Failure Behavior

- OAuth cancellation or timeout does not update account/root configuration.
- OAuth success alone does not replace the stored credential; the credential is
  committed only after Drive identity and root binding succeed.
- Missing Drive account identity returns a stable `AUTH_ACCOUNT_UNAVAILABLE`
  error.
- Root creation failure does not update account/root configuration.
- Credential or atomic configuration commit failure restores the previous
  account binding. Logout reports deletion failures and does not clear config
  when the credential could not be removed.
- A successful new login replaces the previous active account binding.

## Acceptance Checks

- Unit tests prove account selection and PKCE are included in the auth request.
- Unit tests prove PKCE verifier is supplied during token exchange through the
  Google auth-library-supported flow.
- Loopback tests prove invalid state and Google cancellation never exchange an
  authorization code.
- Unit tests prove Drive identity lookup and root binding use the same newly
  authorized client.
- Unit tests prove account/root config application and clearing.
- Existing configuration files and `drive init` continue to work.
- Command-level tests cover login, status, logout, and Drive status/init output
  without opening a real browser.
- `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build` pass.
- A user-assisted real login shows the account chooser and reports the selected
  account; automation stops at any Google safety or consent screen for the user
  to review.
