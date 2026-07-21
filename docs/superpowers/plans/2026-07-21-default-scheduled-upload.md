# Default Scheduled Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MCP client installation enable the configured daily session upload automatically, while retaining an explicit opt-out for advanced users.

**Architecture:** Keep client registration and scheduler management as separate services, but compose them in the `clients install` CLI workflow. Inject both service factories at the CLI boundary so command behavior can be tested without changing real MCP registrations or OS scheduler state.

**Tech Stack:** TypeScript, Commander, Vitest, macOS launchd, Linux systemd user timers

---

### Task 1: Specify the default installation behavior

**Files:**

- Create: `tests/cli/clients.test.ts`
- Modify: `src/cli/index.ts`

- [x] **Step 1: Write a failing CLI test**

Test `clients install --all --json` with injected client and scheduler services. Assert that every requested MCP client is registered, `SchedulerManager.install` receives the configured `02:00` time, and JSON output reports the enabled daily upload.

- [x] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run tests/cli/clients.test.ts`

Expected: FAIL because the CLI has no injectable client/scheduler factories and does not install the scheduler from `clients install`.

- [x] **Step 3: Implement the minimal default composition**

Add injected factories to `CliDependencies`, route existing CLI construction through them, and install the scheduler after successful client registration using `config.scheduler.at`.

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm vitest run tests/cli/clients.test.ts`

Expected: PASS.

### Task 2: Preserve an explicit advanced opt-out

**Files:**

- Modify: `tests/cli/clients.test.ts`
- Modify: `src/cli/index.ts`

- [x] **Step 1: Write a failing opt-out test**

Test `clients install codex --no-scheduler --json`. Assert that Codex registration still occurs, no scheduler install occurs, and output clearly reports that daily uploads were not installed.

- [x] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run tests/cli/clients.test.ts`

Expected: FAIL because `--no-scheduler` is not accepted.

- [x] **Step 3: Implement the minimal option handling**

Expose `--no-scheduler` only on `clients install` and make the command output include the scheduler result.

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm vitest run tests/cli/clients.test.ts`

Expected: PASS.

### Task 3: Make the default discoverable

**Files:**

- Modify: `README.md`
- Modify: `docs/configuration.md`

- [x] **Step 1: Update onboarding commands**

Remove the separate scheduler-install step from the normal deployment flow and state that `clients install` enables the configured daily upload automatically.

- [x] **Step 2: Document lifecycle and opt-out**

Explain the `02:00` default, wake-up catch-up behavior, the `--no-scheduler` escape hatch, and the standalone `scheduler` commands for advanced management.

- [x] **Step 3: Run repository verification**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`

Expected: all commands pass.
