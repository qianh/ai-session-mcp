# Google Account Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `brain-mcp auth login` into an account-aware Google onboarding flow that selects a user, binds that user's Drive root, and reports/verifies the active account.

**Architecture:** Keep OAuth mechanics in `GoogleOAuth`, add a focused Google account connection service for Drive identity/root binding, and keep CLI actions as orchestration. Extend version 1 configuration with empty-default account identity fields so old TOML remains compatible. The implementation remains one-active-account-per-device and preserves the existing root-scoped Drive boundary.

**Tech Stack:** TypeScript, googleapis/google-auth-library, Commander, Zod, TOML, Vitest

---

### Task 1: Configuration And Credential Isolation

**Files:**

- Modify: `src/domain/config.ts`
- Modify: `src/domain/errors.ts`
- Modify: `src/domain/config-io.ts`
- Modify: `src/auth/platform-secrets.ts`
- Modify: `src/auth/secret-store.ts`
- Create: `src/auth/secret-store-factory.ts`
- Modify: `src/runtime/container.ts`
- Modify: `tests/domain/config.test.ts`
- Modify: `tests/auth/platform-secrets.test.ts`
- Modify: `tests/runtime/container.test.ts`
- Create: `src/auth/google-account.ts`
- Create: `tests/auth/google-account.test.ts`

- [ ] **Step 1: Write failing configuration and binding tests**

Add assertions that default config includes empty `accountEmail`,
`accountDisplayName`, and `accountPermissionId`. Load a temporary legacy version
1 TOML without those fields and prove it receives empty defaults. Add tests for
pure helpers that apply a connection result to config and clear account/root
state.

```ts
expect(config.drive).toMatchObject({
  rootFolderId: "",
  accountEmail: "",
  accountDisplayName: "",
  accountPermissionId: "",
});

const connected = applyGoogleConnection(config, {
  account: {
    email: "person@example.com",
    displayName: "Person",
    permissionId: "permission-1",
  },
  rootFolderId: "root-1",
});
expect(connected.drive.rootFolderId).toBe("root-1");
expect(clearGoogleConnection(connected).drive.accountEmail).toBe("");
```

Add tests that the credential account key is stable per resolved config path,
different for two configs on the same device, and migrates a legacy
device-name-keyed credential on first read.

Add a runtime regression test with an injected SecretStore factory. Prove
`BrainHubRuntime.drive()` requests the same resolved `configFile` key used by
CLI login, while two runtime instances with different config files receive
different stores even if `device.name` is identical.

Add platform-store tests proving delete ignores only a known missing-item error
and propagates other Keychain/Secret Service failures.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm vitest run tests/domain/config.test.ts tests/auth/google-account.test.ts tests/auth/platform-secrets.test.ts tests/runtime/container.test.ts`

Expected: FAIL because the config fields and account helpers do not exist.

- [ ] **Step 3: Implement minimal config and pure binding helpers**

Add the three drive fields with empty defaults, add
`AUTH_ACCOUNT_UNAVAILABLE`, and implement immutable helpers in
`src/auth/google-account.ts`. Derive the primary SecretStore account from a hash
of the resolved config-file path, wrap it with a one-time legacy credential
migration, and make platform deletion errors observable. Change `writeConfig`
to write an adjacent temporary file and atomically rename it so a failed write
cannot truncate the previous binding. Put primary/legacy store construction in
one `createConfigSecretStore` factory and use it from both CLI and
`BrainHubRuntime`; pass `loaded.configFile` into the runtime constructor.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `pnpm vitest run tests/domain/config.test.ts tests/auth/google-account.test.ts tests/auth/platform-secrets.test.ts tests/runtime/container.test.ts`

Expected: PASS.

### Task 2: Account Selection And PKCE

**Files:**

- Modify: `src/auth/google-oauth.ts`
- Create: `src/auth/oauth-loopback.ts`
- Modify: `tests/auth/google-oauth.test.ts`
- Create: `tests/auth/oauth-loopback.test.ts`

- [ ] **Step 1: Write failing OAuth request tests**

Add a pure authorization-options test requiring account selection, consent,
full Drive scope, state, PKCE S256, and a supplied challenge.

```ts
expect(googleAuthorizationOptions("state", "challenge")).toMatchObject({
  access_type: "offline",
  prompt: "select_account consent",
  state: "state",
  code_challenge: "challenge",
  code_challenge_method: "S256",
});
```

Add a public-boundary test proving `beginInteractiveAuthorization()` always
starts a new account selection even when a stored credential exists, and does
not replace that credential before `commit()`.

Use an injected OAuth client and loopback session to return a fixed
verifier/challenge. Assert the exact verifier is passed to
`getToken({ code, codeVerifier })`. Add hermetic loopback callback tests proving
an incorrect state and `error=access_denied` reject without yielding a code.

- [ ] **Step 2: Run test and verify RED**

Run: `pnpm vitest run tests/auth/google-oauth.test.ts tests/auth/oauth-loopback.test.ts`

Expected: FAIL because staged authorization, PKCE options, and the testable
loopback boundary do not exist.

- [ ] **Step 3: Implement forced selection and PKCE**

Add `beginInteractiveAuthorization()`, returning the client plus `commit()` and
`rollback()` methods. Keep issued/refreshed credentials in memory until commit;
rollback restores the previous credential and disables later token persistence.
Generate a verifier/challenge with google-auth-library, pass the S256 challenge
to `generateAuthUrl`, and pass the verifier to
`getToken({ code, codeVerifier })`. Preserve `getClient` for existing
non-interactive callers.

- [ ] **Step 4: Run test and verify GREEN**

Run: `pnpm vitest run tests/auth/google-oauth.test.ts tests/auth/oauth-loopback.test.ts`

Expected: PASS.

### Task 3: Drive Identity And Root Connection

**Files:**

- Modify: `src/auth/google-account.ts`
- Modify: `tests/auth/google-account.test.ts`
- Modify: `tests/drive/google-drive.test.ts`

- [ ] **Step 1: Write failing connection tests**

Use small in-memory fakes for the OAuth callback and Drive API. Prove that the
same newly authorized client is used for `about.get` and root creation, that
existing `brain-hub` is reused, and that incomplete account identity returns
`AUTH_ACCOUNT_UNAVAILABLE`.

```ts
const result = await connectGoogleAccount({
  authorize: async () => authClient,
  drive: (received) => {
    expect(received).toBe(authClient);
    return fakeDrive;
  },
  rootFolderName: "brain-hub",
});
expect(result.account.email).toBe("person@example.com");
expect(result.rootFolderId).toBe("root-1");
```

Add failure tests proving missing identity and root creation errors do not call
the staged authorization's credential commit.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm vitest run tests/auth/google-account.test.ts tests/drive/google-drive.test.ts`

Expected: FAIL because account introspection/connection does not exist.

- [ ] **Step 3: Implement the connection service**

Call `drive.about.get({ fields: "user(displayName,emailAddress,permissionId)" })`,
validate all identity fields, and call `GoogleDrive.createRoot` only after a
valid account is known. Return the account/root result without writing config.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `pnpm vitest run tests/auth/google-account.test.ts tests/drive/google-drive.test.ts`

Expected: PASS.

### Task 4: Transactional Guided CLI Lifecycle

**Files:**

- Modify: `src/cli/index.ts`
- Create: `src/auth/account-status.ts`
- Create: `tests/auth/account-status.test.ts`
- Create: `tests/cli/auth.test.ts`

- [ ] **Step 1: Write failing status behavior tests**

Test the status helper for missing credential, valid live account, invalid
credential, and configured/live identity mismatch without exposing token data.
Define the exact results:

```json
{
  "authenticated": false,
  "reason": "missing_credential",
  "drive": { "configured": false, "rootFolderName": "brain-hub" }
}
```

```json
{
  "authenticated": true,
  "account": { "email": "person@example.com", "displayName": "Person" },
  "configuredAccount": {
    "email": "person@example.com",
    "displayName": "Person"
  },
  "identityMatches": true,
  "drive": {
    "configured": true,
    "rootFolderId": "root-1",
    "rootFolderName": "brain-hub"
  }
}
```

Invalid credentials use `reason: "invalid_credential"`; a valid identity
mismatch returns `authenticated: true` and `identityMatches: false`.

Add command-level tests in `tests/cli/auth.test.ts` by injecting output,
SecretStore, OAuth-session, Drive, and config-writer dependencies into
`runCli`. Cover: text guidance, JSON mode emitting only final JSON, selection
always using staged interactive auth, credential commit before atomic config
write, identity/root failure leaving both old stores unchanged, config-write
failure rolling back the credential, logout deletion failure preserving config,
successful logout clearing both, legacy `drive init` recording identity, and
`drive status` showing configured email.

Also cover `commit()` itself failing: CLI must call `rollback()`, leave config
untouched, and report the error. At the staged-session boundary, prove rollback
restores the prior credential after a partial commit and ignores all later token
events from the abandoned client.

- [ ] **Step 2: Run test and verify RED**

Run: `pnpm vitest run tests/auth/account-status.test.ts tests/cli/auth.test.ts`

Expected: FAIL because the status helper does not exist.

- [ ] **Step 3: Implement CLI orchestration**

For `auth login`, print guidance in text mode, force interactive account
selection through staged authorization, connect the Drive account/root, commit
the credential, then atomically write config only after connection succeeds.
If credential commit or config write fails, call staged rollback before
returning the error; never attempt the config write after a failed credential
commit.
Return:

```json
{
  "authenticated": true,
  "account": {
    "email": "person@example.com",
    "displayName": "Person"
  },
  "drive": {
    "rootFolderId": "root-1",
    "rootFolderName": "brain-hub"
  }
}
```

For `auth status`, validate the credential live and report actual/configured
identity. For `auth logout`, delete the credential and persist
`clearGoogleConnection`; if config persistence fails, restore the prior
credential. Include account email in `drive status`. Update legacy `drive init`
to record actual account identity while retaining its command. Keep CLI tests
hermetic through narrowly scoped dependency injection in `runCli`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm vitest run tests/auth tests/cli/auth.test.ts tests/domain/config.test.ts tests/drive/google-drive.test.ts`

Expected: PASS.

### Task 5: Documentation And End-To-End Verification

**Files:**

- Modify: `README.md`
- Modify: `docs/configuration.md`

- [ ] **Step 1: Update onboarding documentation**

Document that the OAuth client identifies BrainHub, the browser-selected Google
account owns the token/root, `auth login` now includes root initialization, and
other users must never copy another account's `root_folder_id` or refresh token.

- [ ] **Step 2: Run the full quality gate**

Run:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

Expected: all commands pass with no warnings introduced by this change.

- [ ] **Step 3: Verify the real guided flow**

With the user present, run: `brain-mcp auth login --json`

Expected: Google shows the account chooser. Automation pauses at any Google
safety/consent screen so the user can review and choose the account. After the
user completes those screens, the command reports the chosen account and its
own `brain-hub` root. Then run `brain-mcp auth status --json` and
`brain-mcp drive status --json` to verify the persisted binding.

- [ ] **Step 4: Review the diff without committing**

Run: `git diff --check && git status --short`

Expected: only scoped source, test, and documentation files are modified. Do
not create a commit unless the user explicitly requests one.
