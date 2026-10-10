# SLICE-000 Implementation Plan

> **Status:** Written on 9 October 2026 as step R4 of the reconciliation, corrected the same day against the R4 audit and its follow-ups, and **approved in its open decisions by the Product Owner the same day** ([§10](#10-owner-resolutions--the-status-of-every-item), [§11](#11-decisions-of-9-october-2026-and-where-each-is-recorded)). It is committed with the reconciliation as the P0 checkpoint. **No SLICE-000 task had been started when it was committed.**
> **Repository path:** `delivery/planning/SLICE-000-IMPLEMENTATION-PLAN.md`
> **Owns:** the order, bounds, dependencies and evidence of the work that builds [SLICE-000](../slices/SLICE-000.md), and the register of the checks that work still owes.
> **Does not own:** any product rule. The slice, the [features](../../features/README.md), the [contracts](../../contracts/CLAUDE.md) and the [architecture](../../architecture/SECURITY_DESIGN.md) own those, and a task links to them and never restates them.
> **Companions:** [owner decisions of 8 October 2026](SLICE-000-FINAL-DECISIONS.md) · [readiness audit](MELARC_SLICE_000_READINESS_AUDIT_2026-10-08.md) · [Development Execution Plan](../DEVELOPMENT_EXECUTION_PLAN.md) · [Bootstrap B0 Runbook](BOOTSTRAP_B0_RUNBOOK.md) (the handoff format and stop conditions this plan extends)

## 1. How to use this plan

Work on **one task at a time**, in the order of [§4](#4-stages-gates-and-the-order-of-work). Hand a coding agent one block of [§5](#5-the-tasks), never the slice:

```text
Implement task S0.NN of delivery/planning/SLICE-000-IMPLEMENTATION-PLAN.md.
Read the block, the documents it names and nothing else.
Change only the files it lists; add no operation, table or dependency it does not name.
Write the failing tests first, run the commands it lists, and report the actual results.
Stop at its stop conditions. Do not start another task.
```

Avoid *Implement SLICE-000*, *Build identity* and *Finish the backend*. A coding agent executes a task; it does not decide Melarc product policy, and a value this plan calls provisional is a measurement or an owner decision, not an agent's choice.

**What a task block is.** Each block names what the task needs, what it builds on that **already exists and is tested**, what it **newly builds**, the files, the smallest meaningful validation, the evidence state it reaches, the obligations it carries, what it does **not** do and when it must stop. A task that needs a database check is not done on `pnpm test` alone: the run codes of [§3](#3-rules-every-task-keeps) say which commands count.

**What this plan is not.** It is not an approval, a schedule, a claim that any check has run, or a replacement for the criteria. A criterion is met by integrated behaviour ([definition of done](../../standards/definition-of-done.md)); a task, a fixture or a green unit test is not.

### 1.1 Baseline of this plan

| Fact| Value|
|---|---|
| Branch and base| `docs/slice-000-reconciliation`, based on `9c34b69a75c58be4dc4131a0be0b78967a69594e`, which is `main` and `origin/main`|
| The reconciliation (Stage R, R0 to R3)| Brings the specifications, `contracts/openapi.yaml` (version 5.77) and the generated client into line with the [owner decisions](SLICE-000-FINAL-DECISIONS.md) and with the decisions of 9 October 2026 ([§11](#11-decisions-of-9-october-2026-and-where-each-is-recorded)). Committed as **one scoped checkpoint commit (P0)** on the Product Owner's instruction of 9 October 2026; **not pushed**. Its hash is reported with the handoff and not written here, because a document cannot contain the hash of the commit that holds it|
| Precondition **P0**| **Satisfied by that checkpoint commit.** Every task below reads the reconciled documents|
| Separate commit| `12ba443` (runbook-only, closes B-05 items 2 and 3) sits on `docs/close-b05-item-2`, a child of `9c34b69`, unmerged. It touches no file this plan relies on|
| Contract| 172 operations, of which the slice builds **38**; **126** criteria `AC-SLICE-000-nn`; 175 schemas; 19 Ops Portal routes|
| Verification of the P0 state (9 October 2026, Windows)| Uncached (`TURBO_FORCE=true`). All exit 0: `format:check`, `lint`, `typecheck`, `build`, `contract:check` (0 operations compared: that proves the checking machinery and says nothing about future identity conformance), `api-client:check` (after `api-client:generate` from contract 5.77), `db:check`, `pnpm test` (root 1179 passed and 2 skipped, API 1699 passed and 5 skipped, Ops 220, api-client 250, harness 191 passed and 1 skipped) and `pnpm run test:browser` over Chromium, Firefox and WebKit (74 passed, 1 skipped: WebKit cannot emulate forced colours); `pnpm audit --audit-level high` exits 0 and reports one moderate advisory (GHSA-67mh-4wv8-2f99, `esbuild` 0.18.20 through `drizzle-kit`, a development tool; open for the owner, see [§1.2](#12-current-position), not changed here). The pinned wording tests prove wording only; seven deliberate breaks of the contract and documents were each caught by the new I24 tests. **Not run:** `test:db` and `test:e2e` (PostgreSQL was not reachable; it is the developer's to start with `pnpm run infra:up`); every Linux-only test (five API process tests, one `test:db` test, one harness test, the symlink test, the POSIX-mode test), which need Linux, WSL2 or CI; and every Slice-000 task|
| The R4 audit| `MELARC_R4_PLAN_AUDIT_2026-10-09.md`, supplied by the owner and held outside the repository (not in the archive). This plan was corrected against it the same day; [§10](#10-owner-resolutions--the-status-of-every-item) gives the status of every item it raised|
| The R4 correction review| `MELARC_R4_CORRECTION_REVIEW_2026-10-09.md` was **not available** to the follow-up pass (searched in the owner's Downloads, Desktop and Documents, `E:/Projects`, the repository and the session files). The pass followed the five directions of the owner's prompt, which name C-01 to C-04; any finding of that review beyond them is unknown to this plan|

### 1.2 Current position

The one place that says where the work stands. Git holds the history and the code the detail; update this section when a task closes.

- **Done:** S0.1 to S0.10 are built, so Stage 1 is complete in code: S0.1 (ports and the composition root), S0.2 (configuration, key material, the describe composition), S0.3 (cryptography, the credential rule, the `ARGON2_*` settings), S0.4 (`SecurityContext` v2, the capability access matrix, the closed `db` handle), S0.5 (the worker and provisioning roles, the posture checks, the role and `SECURITY DEFINER` lint rules), S0.6 (the bounded connection queue, the server's time bounds, the execution-budget mechanism with its database half, and the production `Clock`, [§7.7](#77-carried-from-s06)), S0.7 (the policy-coordination toolkit, [§7.8](#78-carried-from-s07)), S0.8 (the seven reference-data tables, [§7.9](#79-carried-from-s08)), S0.9 (the seed: since the correction batch, two database functions that are the only way to write those tables, and the reference seeds with the `db:seed` command, [§7.10](#710-carried-from-s09)) and S0.10 (the integration kit, [§7.11](#711-carried-from-s010)). S0.3's adapters exist and are tested, and **none of them is bound in the runtime composition yet** (OB-38; the production `Clock` is, since S0.6). Evidence reached: *fixture/platform verified* (the checks ran against a real PostgreSQL as the technical logins; none is a real operation, because no operation exists yet, and no configuration was proved by its validation alone). S0.3's gate B D E passed on Windows, and S0.4 and S0.5 passed one consolidated gate after a correction batch of their own (probe, mandatory capability test, `SET ROLE`). S0.4 and S0.5 are committed as `fd5f696` (not pushed). **S0.6 to S0.10 and their correction batch are committed as the Stage 1 checkpoint commit** `feat(api): complete Slice-000 Stage 1 database foundation` (the child of `fd5f696`; its hash is reported with the handoff and not written here, because a document cannot contain the hash of the commit that holds it; not pushed). `melarc_dev` has not been updated.
- **Stage 1 is accepted for continued development (owner's review, 10 October 2026), as *fixture/platform verified*.** It is **not** accepted as production-ready and **not** as Linux-, WSL2- or CI-verified. The owner's review of the Stage 1 report raised six findings (F01 to F06) and gave directions on the decisions that report listed; the correction batch of 10 October 2026 repaired S0.6 (the commit answer, the acquisition, cancellation and readiness deadlines, the closed budget), S0.9 and the database half of the seed (initialization enforced by the database), the policy checker of S0.4 and S0.5 (an ordinary policy is the principal `CASE`) and the kit of S0.10 (cleanup), and recorded the directions. Its disposition, the checks of the final tree with what was skipped or not run, and the limitations that remain with their owners are in [§7.12](#712-stage-1-correction-batch-10-october-2026-disposition). The review of the corrected tree found one lifecycle gap (F05: closure did not follow the ancestry of a budget), corrected afterwards; on the final tree the commands that need no database ran uncached, and then `test:db` (694 passed, 1 skipped, 23 files) and `test:e2e` (16 passed) ran once with the Turbo cache bypassed (both exit 0). **Gate 1 as a stage gate rests on that evidence on Windows only:** the Linux, WSL2, CI, B-05 and release obligations stay pending, and the intermittent timer failures of `execution-budget.db.test.ts` stay unexplained (OB-91 and the limitations of [§7.12](#712-stage-1-correction-batch-10-october-2026-disposition)).
- **Evidence still owed:** every Linux, WSL2 or CI run that Windows skips (OB-24, OB-25, OB-26, OB-62: none has run); the B-05 items the owner holds; the checks S0.3 to S0.10 handed to later tasks ([§7.4](#74-carried-from-s03) to [§7.11](#711-carried-from-s010)); the Product Owner's confirmation of the deployed Argon2id floor (OB-42); the hosted run of the pipeline (not made); and the stage gates after Gate 1.
- **Next:** the owner's instruction of 10 October 2026 authorized this checkpoint commit and then S0.11 to S0.16 as one bounded batch, to be left uncommitted and unpushed for the owner's review. S0.17 and every later task await authorization. Nothing in this section authorizes a push, a merge, a deployment or a dependency change.
- **Open owner items:** the 7 October finding about this development machine (do not create the local test CA of S0.23, the custody files of S0.30 or real credentials on it until the owner resolves it); the esbuild advisory GHSA-67mh-4wv8-2f99 (moderate; patched from 0.25.0; reached only through the latest `drizzle-kit`; no override applied); and the owner-unconfirmed items of [§10](#10-owner-resolutions--the-status-of-every-item).

## 2. What exists today, and what is future behaviour

Read from the repository on 9 October 2026 (HEAD `9c34b69` plus the uncommitted reconciliation), not from the documents. **This section is the baseline of that date and is not updated as tasks land: what exists now is in [§1.2](#12-current-position) and in the carried-obligation tables of [§7](#7-deferred-obligations--what-is-owed-and-not-yet-run).** **Nothing in 2.2 or 2.3 existed in code at that date.** A task in [§5](#5-the-tasks) says which of 2.1 it reuses and which of 2.2 it creates.

### 2.1 Existing and tested — reuse it, do not rebuild it

| Area| What exists| Where| How it is held today|
|---|---|---|---|
| Application shell| `createApp`: JSON only, `bodyParser` off, UTF-8 and `__proto__` refusal, case-sensitive strict routing, a server-made `X-Request-Id`, `Cache-Control: no-store` on **every** response, a global `AllExceptionsFilter`, prefix `api/v1`, unmatched paths answered in the contract envelope| `apps/api/src/create-app.ts`, `platform/http/*`| Unit and process tests; `error-handling.test.ts`|
| Configuration| `loadConfig` over **nine keys** (`NODE_ENV`, `APP_ENV`, `HTTP_HOST`, `HTTP_PORT`, `LOG_LEVEL`, `SHUTDOWN_TIMEOUT_MS`, `SHUTDOWN_DRAIN_DELAY_MS`, `DATABASE_URL`, `DATABASE_POOL_MAX`); refuses a bad value and a migration credential; `.env.example` must document every key and no other| `platform/config/*`| `load-config.test.ts`, `env-example.test.ts`, process tests|
| Contract machinery| `ContractValidator` (Ajv 2020, request and response, headers and cookies by `x-cookies`, `x-set-cookies*`), `@ContractOperation`, a global validation interceptor (responses validated outside production), `declareAnswerPrincipal`, and the `contract:check` drift check against **0 implemented operations**| `platform/contract/*`, `tools/contract/*`| The validator, consistency, real-contract, comparison and `identity-decisions` tests, which read the real `contracts/openapi.yaml`|
| Deny by default| `AccessDeclaration` is `'technical'` only; a global `DenyByDefaultGuard`; `assertRoutesAreSound` at start| `platform/routes/*`| `route-inventory.test.ts`, `deny-by-default.test.ts`|
| Health and lifecycle| `/livez`, `/readyz` (reasons `starting`, `shutting_down`, `dependency_unavailable`), one shutdown budget with forced exit, a LIFO shutdown registry, fault handlers| `platform/health/*`, `platform/lifecycle/*`| Unit tests; five real-`SIGTERM` process tests that run only on Linux|
| Logging| pino with central redaction (password, token, cookie, csrf, session, totp, recovery, setup grant, `melarc_vendor_device`), a completion line per request, never query, headers or body| `platform/logging/*`| `redaction.test.ts`, `request-logging.test.ts`|
| Database access| `DatabaseService.transactionWithContext` (validates the context first, one pooled connection, transaction-local `melarc.*` settings, refuses a nested transaction, destroys a connection whose `BEGIN`, `COMMIT` or `ROLLBACK` failed); `SecurityContext` v1; `postgresConnectionSettings`; a role-posture readiness check| `platform/database/*`| Unit tests and `test:db`: pooled-context isolation (GBT-A1 to A5), the runtime role's refusals|
| Migrations| One migration, `0000_database_foundation.sql`: schema `melarc`, five STABLE accessor functions (principal type, hub scope mode, authorised hubs, vendor organisation, rider); **no table**. Forward-only history guard, destructive-statement lint, 12 catalogue invariants| `apps/api/migrations`, `tools/database/*`| `migrations.db.test.ts`, `catalog-invariants.db.test.ts`; `db:check`|
| Roles| `melarc_owner` (NOLOGIN, owns everything), `melarc_migration_elevated`, `melarc_api_runtime`; `provisionRoles` creates exactly these three| `tools/database/provisioning.ts`| `provisioning.db.test.ts`, `runtime-role.db.test.ts`|
| Generated client| `createBrowserApiClient`: same-origin `/api/v1`, no redirects, no `Authorization`, the CSRF echo from `melarc_csrf`, `unwrap`, `ApiError` with `endsSession`| `packages/api-client/src/browser/*`| The transport and conformance tests; `api-client:check`|
| Ops Portal| The shell, tokens, `Button`, `Link`, `Alert` (danger and success), `Field`, `Input`, `LoadingIndicator`, `PageHeader`, `SkipLink`, a dev-only showcase; ESLint bans `fetch`, storage and `window.open`; the production build holds no showcase| `apps/ops-web/src/*`| Component and node tests; 74 browser tests over three engines (the [runbook](BOOTSTRAP_B0_RUNBOOK.md#acceptance-record-6-october-2026) acceptance record)|
| Integrated harness| Managed processes, a disposable migrated database per run, an outbound TCP guard, a browser guard that reaches the Ops origin only, a frozen browser clock, failure artifacts| `e2e/*`| Harness unit tests and 16 integrated tests (the same acceptance record)|
| Root tooling and CI| `package:source`, `setup:env`, `infra:*`, `agent-docs`, `markdown-links`, an explicit 18-file `test:root`, `test-inventory`, `dependency-policy`; CI of five jobs and the aggregate `CI result`| `scripts/*`, `.github/workflows/ci.yml`| `test:root`: 1179 passed, 2 skipped|

### 2.2 Does not exist — future behaviour

Confirmed by search of the code (apps, packages, e2e, scripts, workflows), not assumed:

| Capability| State| Built by|
|---|---|---|
| Clock port, Hasher or Argon2, `SecretCipher`, `TokenService`, TOTP, UUIDv7, any cookie writer| None. Crypto in production code is `randomUUID` for the request id and one SHA-256 for migration history. `TestClock` exists only in the harness| S0.1, S0.3, S0.21|
| `RateLimiter`, `HashAdmission`, `Metrics`, `IdempotencyStore`, `AuditWriter`, `SessionStore`, `UnitOfWork`, a settings reader| None| S0.1, S0.11 to S0.16|
| Any table (`schema/index.ts` is empty), the seed helper, an audit, session, grant, delivery or limiter table| None| S0.8 and each table's first task|
| A delivery job, a worker process, a capture adapter, a substitute attestation verifier| None. "Capture" in the harness today means only the outbound TCP guard's blocked-connection log| S0.17, S0.18, S0.54|
| Authentication, permission and CSRF guards; `Origin` and CORS handling; trusted proxy; request-size limit; statement, lock and idle-in-transaction timeouts; a pool waiter bound| None. Express trusts no proxy; the default body limit applies; the pool has an idle and a connect timeout only| S0.6, S0.20, S0.22 to S0.26|
| The error catalogue on the wire| `ErrorCode` holds 3 of the contract's 121 codes; the platform emits only 400, 403, 404, 415 and 500 (and 503 from `/readyz` alone), never 401, 409, 422 or 429; `buildOpenApiDocument` defines no security scheme| S0.21|
| `melarc.task_capability`, `melarc.scope_probe_id`, `existingRecordHub()`, the principal-and-surface pairing check| None, though [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §14.1 describes them. The test fixture policy has no `SYSTEM` branch| S0.4|
| The worker role, `melarc_worker_cap_<task>`, a scheduler role, a provisioning role| None; the strings appear in code only as names to refuse| S0.5, S0.18, S0.30|
| Trusted HTTPS and a certificate authority for tests| None. The Ops preview and the harness are plain `http://127.0.0.1`, the e2e journey runs Chromium only, and `repository-shape.test.ts` forbids a tracked key or certificate store. The contract's cookies are `Secure`| S0.23|
| Ops screens and flows| One placeholder page. `PrimaryNavigation` exists but is not mounted; `useApiClient` and `unwrap` have no application caller; `AppProviders` sits outside `RouterProvider`, so a session end cannot yet navigate; the client generates no `Idempotency-Key` or `If-Match`; the components of the next table are unbuilt| S0.38 to S0.44, S0.52, S0.60|
| Unbuilt UI components| This plan builds `PasswordInput`, `CodeInput`, `AuthenticatedOpsShell`, `ForbiddenState`, `EmptyState`, `StatusBadge`, `Table`, one dialog primitive (`Dialog` and `AlertDialog`), `Select`, `Textarea` and `QrCode`. `Skeleton`, `Toast`, `IconButton`, `Checkbox`, `Radio` and `Tabs` stay unbuilt unless a screen's states need one, and then that screen's task builds it| S0.39 to S0.42, S0.60|
| The verifier service, the JDK, any JVM job in CI| None| S0.55|

### 2.3 Statements a reader may take as true and are not

Surfaced for the owner; none is edited here. [SLICE-000-FINAL-DECISIONS.md](SLICE-000-FINAL-DECISIONS.md) calls the limiter, the metrics port and the worker capability model "existing": they are specification only. [apps/ops-web/CLAUDE.md](../../apps/ops-web/CLAUDE.md) implies the navigation is wired and that `onSessionEnded` is passed: neither is. Three engines run only under `test:browser` (the Ops shell and components); `test:e2e` is one Chromium project, as [e2e/CLAUDE.md](../../e2e/CLAUDE.md) says, so the journeys of the slice widen it (S0.23). [permissions.md](../../contracts/permissions.md) §14 names runtime grants on tables (rate-limit admission, idempotency, outbox, delivery job) that have no migration.

### 2.4 Traps a task author meets

- **The describe composition has no database.** `contract:check`, `openapi:generate` and the default test application run without `config.database`, and `DatabaseModule` is registered only when it is set. A provider that injects `DatabaseService` fails to resolve there unless the wiring accommodates it (S0.1, S0.2).
- **Ports in `platform/`, adapters outside it.** The platform may not import a domain, so the wiring lives in `src/app.module.ts` or beside it (S0.1). Where each kind of code lives is in [§3](#3-rules-every-task-keeps).
- **Exact dependencies only.** `dependency-policy.test.ts` forbids ranges, overrides, patches and `allowBuilds` true, so a package that needs an install script cannot be added. [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.4c names Node's built-in `crypto.argon2` as the candidate to qualify on the pinned Node 24.21.0 (S0.3).
- **A new root test must be added to `test:root`**, and `test-inventory.test.ts` fails when a test file is run by no runner. A new Ops browser spec must be added to a project's `testMatch`. A new mandatory CI check goes in the workflow, `REQUIRED_COMMANDS` and the aggregate.
- **Each new Ops component** needs keyboard tests in jsdom and a showcase browser pass (keyboard, 320 px, 200% text, forced colours, reduced motion, axe WCAG 2.2) ([apps/ops-web/CLAUDE.md](../../apps/ops-web/CLAUDE.md)).
- **What not to rebuild:** `Cache-Control: no-store` on every answer, the server-made request id, the request and response validation, the cookie checks and the client's CSRF echo already exist.

## 3. Rules every task keeps

These hold for every block of [§5](#5-the-tasks) without being repeated there.

**Work.** One bounded task; the smallest change that does it; **failing test first**. No skipped test, no weakened assertion, no inflated timeout, no retry added to get green. Fix a failure before dependent work continues; independent work may go on. Preserve the owner's uncommitted changes: no reset, clean, mass formatting, dependency upgrade, commit, push or deployment unless the task is authorised to do it. **Local services** (Docker, PostgreSQL, WSL, a browser install) are started by the developer: give the command and do not run it.

**Contracts.** Contract-first ([plan §7](../DEVELOPMENT_EXECUTION_PLAN.md#7-contract-first-implementation)). An operation exists only when its `operationId` is in `IMPLEMENTED_OPERATIONS` and its handler carries `@ContractOperation(id)`, in the same change, and `pnpm run contract:check` agrees. Stable identifiers do not change: `operationId`s, error codes, permission keys, setting keys, audit codes, state values, criterion ids. A needed contract change is a deliberate, reviewed change made with its code and every owning document, never a silent one. The generated client is regenerated with `pnpm run api-client:generate` and never edited. The Ops Portal declares no API type of its own.

**Tables.** A migration creates a table in the **first task whose code reads or writes it**; later tasks add columns in new migrations. Migrations only go forward. Every table ships in the same migration with its owner `melarc_owner`, forced row-level security, policies, grants, a [data-scope-registry.md](../../contracts/data-scope-registry.md) row and a Family S classification ([MIGRATION_AND_SEEDING.md](../../architecture/MIGRATION_AND_SEEDING.md) §5.1, §5.3).

**Authority.** Authorise on held permissions and never on a role name; deny by default; the frontend decides no total, ownership, state transition or hub. A refusal reveals only what its axis allows ([SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §4): a Vendor and a Rider are never told that another party's record exists.

**Negative-access tests.** Each operation ships its own at the five surfaces ([engineering-standards.md](../../standards/engineering-standards.md) §3.1), with its headers, cookies and declared status-and-error pairs ([apps/api/CLAUDE.md](../../apps/api/CLAUDE.md)). S0.66 is the sweep and the existence-rule comparison, never the first place they appear.

**Placement** ([SOLUTION_ARCHITECTURE.md](../../architecture/SOLUTION_ARCHITECTURE.md) §5 as this plan reads it). `src/platform/` holds the ports and what is cross-cutting: `auth/` (sign-in, setup, recovery, sessions, MFA, device enrolment, guards and cookies), `authorization/`, `audit/`, `idempotency/`, `settings/`, `limiter/`, `delivery/`, `metrics/` and the technical folders that exist. A domain folder holds the persistence adapters and the administration operations of the data it owns: `src/staff/` (staff and rider identities and devices), `src/vendor/`, `src/permission/`, and `src/dispatch/` for the two rider reads. What a principal does for itself lives in `platform/auth`; what an officer does to another principal lives in the domain of the permission key's first segment. **Domain controllers are thin** (Product decision, 9 October 2026, [§11.6](#116-where-officer-operations-live)): the shared session, MFA and recovery logic stays in `platform/auth` behind the S0.1 ports, and `dispatch` reads the staff-owned rider data through a read port, so there is no second identity store and no duplicated business logic. The first use of one of the 17 existing permission-domain folders is not a new domain.

**Secrets.** No credential, token, seed, hash input, QR payload or destination in a log, audit event, metric label, query cache, storage, trace, screenshot, error or `package:source`. Every task that touches one carries a sentinel test. Share source for review only with `pnpm run package:source`.

**Time.** A persisted expiry is judged on **one fresh database wall-clock value taken after the required locks** (valid means `now < expires_at`); TOTP uses an injected UTC wall clock; process budgets use a monotonic clock; a test ages a row with SQL. There is no production time-travel switch.

**Engineering parameters.** A *measured engineering parameter* — the Argon2id cost, hash-admission slots, pool size, the statement, lock, idle and transaction deadlines, the policy-lock restart bound and its total deadline, HTTP admission limits, the limiter's capacity bound — is **qualified at its first consumer**. That task chooses a concrete development or test value, records the environment (machine, Node and PostgreSQL versions) and the test that exercises it, and labels it *development-qualified, not production-qualified*. S0.65 later does the integrated measurement, calibrates those values and proposes release-capacity values for the owner's approval; **no earlier task waits for S0.65, and S0.65 depends on them**. An unresolved *product decision* is different and is never invented by an agent: the six rate-limit launch values are [settings.md](../../contracts/settings.md) §7.7's, and the edge ceiling, transport and hash capacity are measurement deliverables the owner approves.

**Evidence states.** A criterion is in exactly one of five states, and only the last is acceptance ([SLICE-000.md](../slices/SLICE-000.md) §7): *not implemented* · *fixture/platform verified* (a fixture operation, a mock, a unit test or a platform test) · *real-operation verified* (the real operation, a real database, the real contract check) · *client/manual evidence pending* (a Vendor PWA, Rider app, handset, owner or hosted-CI clause not yet seen) · *fully accepted*. A criterion with any mandatory clause still awaiting client or manual evidence is **not** fully accepted. The tables of [§6](#6-traceability) name the task where **real-operation evidence completes**, which is the first task at which **every clause** of a criterion can be shown with the operations and principals that exist (a clause that needs a vendor or a rider session is not complete before one exists); fixture and client evidence are listed beside the operations. The citation inventory (S0.67) shows only that a test cites a criterion; assertion quality is reviewed in each handoff.

**Run codes.** The block says which commands count.

| Code| Meaning| Command and who starts what|
|---|---|---|
| **B**| Base set| `pnpm run format:check`, `lint`, `typecheck`, `pnpm test`, `build`, `contract:check`, `api-client:check`, `pnpm --filter @melarc/api run db:check`. No service needed|
| **D**| Database tests| `pnpm run test:db`. The developer starts PostgreSQL ([DEVELOPMENT.md](../../DEVELOPMENT.md))|
| **W**| Browser tests| `pnpm run test:browser`. Needs the browsers Playwright installs|
| **E**| Integrated tests| `pnpm run test:e2e`. Needs the database and a browser|
| **L**| Linux, WSL2 or CI| The tests Windows skips: five API process tests, one `test:db` test and one harness test (a real `SIGTERM`), and anything POSIX-only|
| **J**| JVM verifier| The verifier service's build and tests, once S0.55 exists|
| **M**| Manual or owner| Evidence a person gives; the task says what is recorded|

`pnpm test` alone is **never** the gate for a task that lists D, W, E, L or J. Turbo caches `test`: a verifying run uses `TURBO_FORCE=true pnpm test`.

**Testing cadence.** While a task is edited: the tests of the files being changed and the affected `format:check`, `lint` and `typecheck`, not the whole suite after each edit. At the end of a task or batch: the commands of its run codes, **once, uncached, on the final state**, with every skip and every unrun check reported exactly. At a stage boundary: the full gates (B, and D, W, E, L, J where the stage's blocks list them). No routine mutation campaign and no routine repeat runs: break the real tree only to prove a guard that is new or whose logic changed, and restore each file by hash. A mandatory gate is never waived silently; an instruction that conflicts with one is reported as a conflict.

**Dependencies, gates and evidence classes.** A task starts when everything it **Needs** is done; no task waits for its own gate. Three things are kept apart. A **task's exit criteria** are its *Evidence*. A **gate** is the recorded exit check of the last mandatory task of a stage; later tasks depend on it by naming that task in their Needs. **Independent owner evidence** (S0.28 and S0.61) can be produced at any time and certifies no task. Evidence that the owner has permitted to follow local acceptance is **deferred, listed on S0.70 and never reported as passed** ([§7.2](#72-release-gates--not-acceptance-of-this-slices-code)). A package or tool that is not already approved is a stop condition, not a decision.

**Subtasks.** A parent task too large for one hand-off names suffix subtasks (S0.3a, S0.3b and so on) with their own *Also needs*, *Run* and evidence. Parent IDs never change. A parent keeps its operations, criteria and gate, and a subtask's fixture proof never completes the parent's real-operation criterion.

## 4. Stages, gates and the order of work

Eight stages and eight gates. **A gate is the recorded exit check of a stage's last mandatory task, and that task's Needs reach every other mandatory task of the stage**, so passing it certifies the stage; a later task depends on a gate by naming that task in its Needs. **No task waits for its own gate.** Two items are **independent owner evidence** and certify no task: **S0.28** (accessibility; its one dependant is S0.43) and **S0.61** (the hardware handset; no task needs it, so S0.70 carries it as *deferred*, never as passed, [§7.2](#72-release-gates--not-acceptance-of-this-slices-code)). Stage R (reconciliation of the specifications, contract and client) is complete and committed as the P0 checkpoint, so it is not repeated here.

| Stage| Tasks| Gate (exit task)| Passes when|
|---|---|---|---|
| 1 Foundations| S0.1 to S0.10| **Gate 1** (S0.10)| A real application and database can be driven from a test as the runtime login; `test:db` green|
| 2 Cross-cutting services| S0.11 to S0.19| **Gate 2** (S0.19)| Audit, idempotency, settings, limiter, hash admission, metrics, durable delivery **and retention cleanup** are tested; the worker's real `SIGTERM` test has run on Linux, WSL2 or CI (**pending, not deferred**, until it has)|
| 3 Pipeline, sessions, authorization| S0.20 to S0.27 (S0.28 independent)| **Gate 3** (S0.27)| The refusal order is proved on a fixture operation; the bundle-change primitive and its races pass|
| 4 Staff API| S0.29 to S0.37| **Gate 4** (S0.37)| All 16 staff operations and the reason catalogue read are real-operation verified; `GBT-B14` passes|
| 5 Ops staff screens| S0.38 to S0.46| **Gate 5** (S0.46)| The staff journeys pass in every supported engine, locally and in CI|
| 6 Vendor and recovery| S0.47 to S0.52| **Gate 6** (S0.52)| Vendor and recovery operations and screens pass; `GBT-B15` passes|
| 7 Rider and attestation| S0.53 to S0.60 (S0.61 independent)| **Gate 7** (S0.60)| Rider operations pass against the substitute verifier and the JVM verifier is qualified|
| 8 Close| S0.62 to S0.70| **Gate 8** (S0.70)| The combined concurrency and privilege run, the sweeps and the owner's local walk are recorded|

**Graph check (generated by a script kept outside the repository, run on the day this section was written).** The graph has 70 parent tasks and 40 suffix subtasks (385 dependency edges when the script ran; one edge, S0.6 to S0.20, was added by [§11.8](#118-deadline-ownership-and-the-execution-budget) on 9 October 2026, which makes 386, and the script was not re-run: S0.6 needs only S0.4, whose ancestors do not depend on S0.20, so the edge cannot close a cycle. A parent depends on all its subtasks and a subtask on the parent's Needs plus its own). It has no cycle, no unknown or later reference, and no orphaned mandatory task: every task reaches S0.70 except S0.61, which is deferred evidence by design. Retention cleanup (S0.19) is an ancestor of S0.29, the first task that builds grant-issuing code, and so of the bootstrap seed, the MFA continuation grants and every later issuing task, and of S0.70. Nothing is deferred by inference: S0.61 alone sits outside S0.70's ancestry, by the explicit decision of [SLICE-000-FINAL-DECISIONS.md](SLICE-000-FINAL-DECISIONS.md) §20. Every task of a stage is an ancestor of that stage's gate task, apart from the two independent items. Each of the 38 operations and the 126 criteria is owned by exactly one parent task.

**The order follows the decisions of 8 October 2026**: reconcile, then ports, configuration, cryptography, database boundaries and the test kit; then audit, idempotency, authoritative limiting and bounded hashing; then **durable credential delivery and its retention before any operation that issues a credential**; then the request pipeline, trusted HTTPS and the accessibility baseline; then the staff vertical path, administration and recovery; then the vendor API; then the attestation verifier and the rider; then the composed UI, the sweeps and the walk. Independent preparation is kept: within a stage a task may start as soon as its Needs are done, and the owner evidence of S0.28 can run beside everything.

| Task| Title| Needs| Run|
|---|---|---|---|
| | **Stage 1 — Foundations**| | |
| [S0.1](#s01--ports-placement-and-the-composition-root)| Ports, placement and the composition root| P0| B|
| [S0.2](#s02--configuration-key-material-and-the-describe-composition)| Configuration, key material and the describe composition| S0.1| B D E|
| [S0.3](#s03--cryptography-and-credential-normalisation)| Cryptography and credential normalisation| S0.2| B D E|
| S0.3a| ↳ Qualify `crypto.argon2` on the pinned Node, then `Hasher`, the credential rule and the email canonical form| parent's| B D E|
| S0.3b| ↳ `TokenService` (tokens, SHA-256 at rest, constant-time compare) and `randomUUIDv7`| parent's| B|
| S0.3c| ↳ `TotpVerifier` (RFC 6238, injected UTC clock, replay-step tracking)| parent's| B|
| S0.3d| ↳ `SecretCipher` (AES-GCM, purpose-separated keys, key version, rotation)| parent's| B|
| [S0.4](#s04--database-context-capabilities-and-the-closed-db-handle)| Database context, capabilities and the closed `db` handle| S0.1, S0.2| B D|
| S0.4a| ↳ `SecurityContext` v2 (task capability, scope probe, principal-and-surface pairing) and its accessors, with their migration| parent's| B D|
| S0.4b| ↳ The access matrix per capability and GRANT-based separation; the `SYSTEM` principal mapped to the audit's null actor| S0.4a| B D|
| S0.4c| ↳ Close the public context-free `db` handle and `transaction()`; port `e2e-main.mjs` off `db.$client`| S0.4a| B D E|
| [S0.5](#s05--database-roles-posture-and-migration-lint)| Database roles, posture and migration lint| S0.4| B D|
| [S0.6](#s06--resource-deadlines)| Resource deadlines| S0.4| B D|
| [S0.7](#s07--policy-coordination-toolkit)| Policy-coordination toolkit| S0.4, S0.6| B D|
| [S0.8](#s08--reference-data-schema-and-registry)| Reference-data schema and registry| S0.5, S0.7| B D|
| [S0.9](#s09--seed-helper-and-reference-seeds)| Seed helper and reference seeds| S0.8, S0.3| B D|
| [S0.10](#s010--integration-kit-gate-1)| Integration kit (Gate 1)| S0.9, S0.6| B D|
| | **Stage 2 — Cross-cutting services**| | |
| [S0.11](#s011--audit-writer)| Audit writer| S0.10| B D|
| [S0.12](#s012--idempotency-and-replay-store)| Idempotency and replay store| S0.10, S0.3| B D|
| [S0.13](#s013--settings-reader-and-reason-validator)| Settings reader and reason validator| S0.9, S0.10| B D|
| [S0.14](#s014--postgresql-authoritative-rate-limiter)| PostgreSQL-authoritative rate limiter| S0.13, S0.5, S0.3, S0.6| B D|
| [S0.15](#s015--metrics-registry)| Metrics registry| S0.1, S0.2| B|
| [S0.16](#s016--bounded-hash-admission)| Bounded hash admission| S0.14, S0.3, S0.15| B D|
| [S0.17](#s017--durable-credential-delivery-schema-enqueue-state-machine)| Durable credential delivery: schema, enqueue, state machine| S0.11, S0.5, S0.3| B D|
| [S0.18](#s018--delivery-worker-process)| Delivery worker process| S0.17, S0.15, S0.6| B D L|
| [S0.19](#s019--retention-cleanup-gate-2)| Retention cleanup (Gate 2)| S0.18, S0.12, S0.16| B D|
| | **Stage 3 — Pipeline, browsers, sessions, authorization**| | |
| [S0.20](#s020--transport-admission)| Transport admission| S0.2, S0.6, S0.14, S0.16| B D|
| [S0.21](#s021--http-primitives-and-the-description-composition)| HTTP primitives and the description composition| S0.1, S0.10| B|
| [S0.22](#s022--access-declarations-and-the-guard-chain)| Access declarations and the guard chain| S0.20, S0.21, S0.11, S0.12, S0.14, S0.16| B D|
| [S0.23](#s023--trusted-https-harness)| Trusted HTTPS harness| S0.2, S0.20| B W E|
| [S0.24](#s024--sessions-and-the-authentication-guard)| Sessions and the authentication guard| S0.22, S0.3, S0.7, S0.8| B D|
| [S0.25](#s025--csrf-origin-and-fetch-metadata)| CSRF, Origin and Fetch Metadata| S0.24, S0.11, S0.23| B D W E|
| [S0.26](#s026--authorization)| Authorization| S0.25, S0.9, S0.4, S0.7| B D|
| [S0.27](#s027--the-bundle-change-primitive-and-its-races-gate-3)| The bundle-change primitive and its races (Gate 3)| S0.24, S0.26, S0.11| B D|
| [S0.28](#s028--accessibility-baseline-evidence-independent-owner-evidence)| Accessibility baseline evidence (independent owner evidence)| none| M|
| | **Stage 4 — Staff identity through the API**| | |
| [S0.29](#s029--setup-grants-and-mfa-factors)| Setup grants and MFA factors| S0.27, S0.19, S0.17, S0.3| B D|
| [S0.30](#s030--bootstrap-seed-and-resume-command)| Bootstrap seed and resume command| S0.29, S0.9| B D L|
| [S0.31](#s031--staff-credential-setup-and-mfa-enrolment-operations)| Staff credential setup and MFA enrolment operations| S0.30| B D|
| [S0.32](#s032--staffsignin)| `staffSignIn`| S0.31, S0.16, S0.14| B D|
| [S0.33](#s033--completestaffmfasignin)| `completeStaffMfaSignIn`| S0.32| B D|
| [S0.34](#s034--getcurrentsession-and-signout)| `getCurrentSession` and `signOut`| S0.33| B D|
| [S0.35](#s035--staff-reads-and-the-reason-catalogue-read)| Staff reads and the reason catalogue read| S0.34, S0.26| B D|
| [S0.36](#s036--create-approve-and-re-issue)| Create, approve and re-issue| S0.35, S0.29, S0.12, S0.18, S0.27, S0.19| B D|
| [S0.37](#s037--sessions-administration-and-mfa-reset-gate-4)| Sessions administration and MFA reset (Gate 4)| S0.36, S0.27| B D|
| | **Stage 5 — Ops Portal, staff screens**| | |
| [S0.38](#s038--ops-session-foundation)| Ops session foundation| S0.34| B W E|
| [S0.39](#s039--forms-and-transient-secret-hygiene)| Forms and transient-secret hygiene| S0.38| B W|
| S0.39a| ↳ Label, help and error relations, first-invalid focus, pending state, duplicate-submit prevention, `PasswordInput` and `CodeInput`| parent's| B W|
| S0.39b| ↳ The one-time secret display and transient-credential hygiene (a sentinel absent from every cache, storage and trace)| S0.39a| B W|
| S0.39c| ↳ **Local QR primitive (Product decision, 9 October 2026, [§11.2](#112-the-local-qr-primitive-before-staff-enrolment)): a reviewed, exactly pinned encoder, CSP-safe SVG, and an independent test-only decoder. Reused by S0.60.** The payload is a transient credential: no remote QR service, analytics, persistence or navigable `otpauth` link| S0.39b| B W|
| [S0.40](#s040--table-and-read-states)| Table and read states| S0.38| B W|
| [S0.41](#s041--confirmation-and-reason-workflow)| Confirmation and reason workflow| S0.39, S0.40, S0.35| B W|
| [S0.42](#s042--authenticated-shell-and-navigation)| Authenticated shell and navigation| S0.38| B W|
| [S0.43](#s043--the-five-pre-sign-in-screens)| The five pre-sign-in screens| S0.39, S0.42, S0.31, S0.32, S0.33, S0.34, S0.28| B W|
| S0.43a| ↳ `/sign-in` and `/sign-in/mfa`| parent's| B W|
| S0.43b| ↳ `/setup/credential`| parent's| B W|
| S0.43c| ↳ `/setup/mfa` (the S0.39c QR and the secret for manual entry) and `/setup/mfa/complete`| S0.39c| B W|
| [S0.44](#s044--the-six-signed-in-screens)| The six signed-in screens| S0.40, S0.41, S0.42, S0.35, S0.36, S0.37| B W|
| S0.44a| ↳ `/` and `/admin/staff` (with the approver queue)| parent's| B W|
| S0.44b| ↳ `/admin/staff/new` and `/admin/staff/{id}`| S0.44a| B W|
| S0.44c| ↳ `/admin/staff/{id}/mfa/reset` and `/admin/sessions`| S0.44a| B W|
| [S0.45](#s045--harness-extension-over-https)| Harness extension over HTTPS| S0.23, S0.43, S0.44| B E|
| [S0.46](#s046--staff-journeys-gate-5)| Staff journeys (Gate 5)| S0.45| B E M|
| | **Stage 6 — Vendor and credential recovery**| | |
| [S0.47](#s047--vendor-fixture-reads-setup-grant-and-setup)| Vendor fixture, reads, setup grant and setup| S0.36, S0.29| B D|
| S0.47a| ↳ The vendor tables, the non-production fixture and `listVendorAccounts`, `getVendorAccount`| parent's| B D|
| S0.47b| ↳ `reissueVendorCredentialSetup` and `completeVendorCredentialSetup`| S0.47a| B D|
| [S0.48](#s048--vendorsignin)| `vendorSignIn`| S0.47, S0.16, S0.37| B D|
| [S0.49](#s049--vendor-browsers)| Vendor browsers| S0.48| B D|
| S0.49a| ↳ `requestAdditionalDeviceGrant` and `completeAdditionalDeviceEnrolment`| parent's| B D|
| S0.49b| ↳ `listVendorDevices` and `revokeVendorDevice`| S0.49a| B D|
| [S0.50](#s050--requestcredentialrecovery)| `requestCredentialRecovery`| S0.47, S0.37, S0.18, S0.14| B D|
| [S0.51](#s051--completing-recovery-and-administrator-initiated-recovery)| Completing recovery, and administrator-initiated recovery| S0.50, S0.48| B D|
| S0.51a| ↳ `completeCredentialRecovery` judged under the identity lock, with the eligibility recheck| parent's| B D|
| S0.51b| ↳ `recoverStaffCredential` and `recoverVendorCredential` (coalescing, ineligible target)| S0.51a| B D|
| [S0.52](#s052--recovery-and-vendor-screens-gate-6)| Recovery and vendor screens (Gate 6)| S0.51, S0.49, S0.44, S0.41, S0.45| B W E|
| S0.52a| ↳ `/recovery` and `/recovery/complete`| parent's| B W E|
| S0.52b| ↳ `/admin/vendors`, `/admin/vendors/{id}` and the recovery action on the staff detail| S0.52a| B W E|
| | **Stage 7 — Rider and device attestation**| | |
| [S0.53](#s053--rider-fixture-roster-and-the-registration-operations)| Rider fixture, roster and the registration operations| S0.37, S0.12, S0.18, S0.51| B D|
| S0.53a| ↳ The rider tables, the non-production fixture and `listRiders`, `getRider`| parent's| B D|
| S0.53b| ↳ `registerRiderDevice` with the sealed-replay exception| S0.53a| B D|
| S0.53c| ↳ `reregisterRiderDevice` with its reason and verification note| S0.53b| B D|
| [S0.54](#s054--device-key-protocol-and-the-substitute-verifier)| Device-key protocol and the substitute verifier| S0.3, S0.2, S0.53| B|
| [S0.55](#s055--the-private-jvm-verifier-service)| The private JVM verifier service| S0.54, S0.2| B J L|
| S0.55a| ↳ Qualify the pinned `android/keyattestation` release against a real chain (including the extension nearest the root)| parent's| J|
| S0.55b| ↳ The service: versioned request and response, bounded input, concurrency and deadline limits, restricted network, no database credential| S0.55a| B J|
| S0.55c| ↳ The reproducible Gradle build on a pinned JDK, dependency verification, the local Windows and Linux start and stop scripts, the CI job and its `CLAUDE.md`| S0.55b| B J L|
| S0.55d| ↳ Independently generated adversarial fixtures (wrong roots, revoked, malformed, duplicate extensions, limits)| S0.55b| J|
| [S0.56](#s056--trust-data-and-policy)| Trust data and policy| S0.55, S0.15| B D J|
| [S0.57](#s057--completeriderdeviceenrolment)| `completeRiderDeviceEnrolment`| S0.53, S0.54, S0.56, S0.29, S0.17, S0.47, S0.49, S0.51| B D J|
| S0.57a| ↳ First enrolment: the verifier call outside the transaction, the evidence classes, the atomic change, the 503 outcome (AC-13, 40, 60 to 70, 75, 76)| parent's| B D J|
| S0.57b| ↳ Replacement and its refusals: old device `REPLACED`, session `DEVICE_REPLACED`, a refused replacement leaves the old device as it was (AC-71, 72)| S0.57a| B D J|
| S0.57c| ↳ The races (AC-73), the setup-bucket checks of AC-125 and the production-refusal assertions of AC-55| S0.57b| B D J|
| [S0.58](#s058--revokeriderdevice)| `revokeRiderDevice`| S0.57| B D|
| [S0.59](#s059--rider-challenge-and-sign-in)| Rider challenge and sign-in| S0.58, S0.26, S0.34, S0.16| B D|
| S0.59a| ↳ `requestRiderSignInChallenge` and the `RiderSignInChallenge` table: single use, short life, no enumeration (AC-39, 52, 53)| parent's| B D|
| S0.59b| ↳ The signature check before the PIN, the six-digit PIN and its lockout (AC-8, 9, 38, 48 to 51, 109 to 111)| S0.59a| B D|
| S0.59c| ↳ `riderSignIn` session issue, the root signal, the one-live-session rule (AC-10, 11, 35, 46, 47, 56 to 59, 102)| S0.59b| B D|
| S0.59d| ↳ AC-54 for `getCurrentSession` and `signOut` under stale trust data, with the residual recorded; and the Rider-session clause of AC-132 (`listReasonDefinitions` is `PERMISSION_DENIED` while no stop or run exists)| S0.59c| B D|
| [S0.60](#s060--the-rider-screens-gate-7)| The rider screens (Gate 7)| S0.59, S0.52, S0.41| B W|
| S0.60a| ↳ `/admin/riders` and `/admin/riders/{id}`| parent's| B W|
| S0.60b| ↳ `/admin/riders/{id}/device/register` and `/admin/riders/{id}/device`, displaying the QR through the S0.39c primitive (`Textarea` for the verification note)| S0.60a| B W|
| [S0.61](#s061--real-device-evidence-deferred-evidence)| Real-device evidence (deferred evidence)| S0.57, S0.60| M|
| | **Stage 8 — Close**| | |
| [S0.62](#s062--browser-journeys-for-rows-7-to-15)| Browser journeys for rows 7 to 15| S0.60, S0.46| B E|
| [S0.63](#s063--two-build-fixed-policy-proof)| Two-build fixed-policy proof| S0.59, S0.48, S0.27| B D|
| [S0.64](#s064--concurrency-and-privilege-acceptance-run)| Concurrency and privilege acceptance run| S0.63, S0.37, S0.51, S0.49| B D|
| [S0.65](#s065--benchmark-and-capacity)| Benchmark and capacity| S0.59, S0.48, S0.32| B D|
| [S0.66](#s066--security-matrix-and-negative-access-sweep)| Security matrix and negative-access sweep| S0.59, S0.60| B D|
| [S0.67](#s067--contract-sweep-and-the-citation-inventory)| Contract sweep and the citation inventory| S0.66, S0.62| B|
| [S0.68](#s068--private-metrics-endpoint-alerts-and-rehearsal)| Private metrics endpoint, alerts and rehearsal| S0.56, S0.50, S0.18, S0.15| B D|
| [S0.69](#s069--documentation-sweep)| Documentation sweep| S0.67, S0.68, S0.64, S0.65| B|
| [S0.70](#s070--local-functional-acceptance-walk-gate-8)| Local functional acceptance walk (Gate 8)| S0.69, S0.66, S0.65, S0.64, S0.62| M E|

## 5. The tasks

Each block gives: **Needs** (what must be done first), **Run** (the commands that count, [§3](#3-rules-every-task-keeps)), **Operations** and **Criteria** (where real-operation evidence completes), a **Subtasks** table where the task is too large for one hand-off, then what the task **builds on** that exists and is tested, what it **newly builds**, the **files**, the **evidence** it reaches, the **obligations carried**, what it **does not** do and when it must **stop**. Where a block says *fixture/platform verified*, no real operation has proved the behaviour yet.

### Stage 1 — Foundations: ports, configuration, cryptography, database boundaries, test kit

No product route is added. The stage ends at **Gate 1** (S0.10): a real application and a real PostgreSQL can be driven from a test, as the runtime login, with a clock and a capture reader the test controls.

#### S0.1 — Ports, placement and the composition root

| | |
|---|---|
| **Needs**| P0 |
| **Run**| B |
| **Operations**| none |
| **Criteria**| none |

**Builds on (exists, tested).** `src/platform/` with its nine folders; `src/app.module.ts`, the composition root, which imports only `PlatformModule` (no domain module exists); `platform.module.ts` and `platform.tokens.ts`; and `src/architecture.test.ts`, which fails when a production file in `platform/` imports outside it.
**Newly builds.** The named interfaces of [SOLUTION_ARCHITECTURE.md](../../architecture/SOLUTION_ARCHITECTURE.md) §5 under `src/platform/auth/ports/`: `Clock`, `Hasher`, `SecretCipher`, `TokenService`, `TotpVerifier`, `RateLimiter`, `HashAdmission`, `IdempotencyStore`, `AuditWriter`, `SessionStore`, `IdentityDirectory` (staff, vendor and rider), `UnitOfWork`, `DeliveryQueue`, `DeliveryProvider`, `AttestationVerifier` and `Metrics`. Each carries a typed descriptor naming its inputs, outputs, failure outcomes, owner and transaction requirement (inside the caller's transaction, outside any transaction, or independent), written **before any persistence exists**. Each port also gets an injection token. The composition root (`src/app.module.ts` and what it imports; the platform may not import a domain) is where adapters are bound to tokens, and nothing else imports an adapter. **S0.1 owns the interfaces, tokens, descriptors and this composition boundary and adds no adapter, inert or otherwise.** The describe-time adapters that let every port resolve in a composition with no database (`contract:check`, `openapi:generate` and the default test application run without `config.database`) are S0.2's.
**Files.** `apps/api/src/platform/auth/ports/*.ts`, `apps/api/src/app.module.ts`, `apps/api/src/architecture.test.ts`, [apps/api/CLAUDE.md](../../apps/api/CLAUDE.md) (one line pointing at the ports).
**Evidence.** The architecture test fails on (a) a platform file importing a domain module, (b) a port without an interface, a token and a complete descriptor, (c) an adapter imported outside the composition root, (d) any class that implements a port inside `platform/`. **Exit condition:** every port in the list has all three, the test enforces placement, and no adapter exists. State reached: *fixture/platform verified*. No criterion moves.
**Does not.** Add an adapter, a table, a route, a dependency or a domain folder. Identity creates no eighteenth domain (§5).
**Stop if.** A port cannot be placed without importing a domain from `platform/`.

#### S0.2 — Configuration, key material and the describe composition

| | |
|---|---|
| **Needs**| S0.1 |
| **Run**| B D E |
| **Operations**| none |
| **Criteria**| none |

**Builds on.** `platform/config/load-config.ts` (nine keys today, validated at start, refuses a bad value and a migration credential), `report-config-problems.ts` (key names and fixed text only), `tools/describe-config.ts` (the describe configuration, which has no database), `.env.example` with `env-example.test.ts` (every key documented and no other, no secret-looking value), and `setup:env`.
**Newly builds.** Purpose-separated, versioned key material (TOTP seeds, delivery payloads, replay payloads, limiter pseudonymisation, the password pepper); the Ops and Vendor origins and link templates; trusted-proxy setting (default off); body limits and deadlines; the database deadline relations ([SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §14.6) validated at start; the worker and verifier endpoints; production refusal of an absent key, a test adapter, the capture adapter and the in-memory limiter ([DEPLOYMENT_AND_ENVIRONMENTS.md](../../architecture/DEPLOYMENT_AND_ENVIRONMENTS.md) §12.3); the **inert describe adapters** for every S0.1 port and their wiring into the describe composition (the S0.1 tokens bound to adapters that never connect to a database or a provider, never deliver and never resolve a secret). Each fails clearly, with a named error, if a runtime operation is invoked on it, and each is **refused by production configuration** exactly as a test adapter is, so none can be used as a production adapter; redaction of every new key. Every resource bound this task introduces gets a concrete **provisional default, validated by configuration only** (its bounds and, for the database deadlines, their nesting): not measured, not applied to a server or a database, and not yet qualified. The qualification the engineering-parameter rule of §3 requires stays with each value's first consumer: S0.6 for the database deadlines and waiters, S0.20 for the HTTP limits and deadlines, S0.18 for the provider timeouts. The two HTTP deadlines are **receipt limits** (how long the server waits for a client to send) and do not bound a handler's execution; no setting yet bounds a request's whole execution: S0.6 builds the shared execution-budget mechanism and S0.20 integrates it into the request pipeline ([§11.8](#118-deadline-ownership-and-the-execution-budget)). The DEPLOYMENT document (§12.5, "Deadlines") maps each retained requirement to its setting and owning task.
**Files.** `platform/config/*`, `.env.example`, `apps/api/src/tools/describe-config.ts`, `scripts/setup-env*` and its tests, the harness environment in `e2e/`, the DEPLOYMENT configuration table.
**Evidence.** Unit tests per refusal; `env-example.test.ts` fails when a key is missing from the example; describe output is asserted free of values. **Exit condition:** a test invokes every describe adapter and sees the clear failure with no socket opened; `contract:check`, `openapi:generate` and the default test application resolve every S0.1 port; production configuration refuses a describe adapter. *Fixture/platform verified*.
**Obligations carried.** **OB-36:** production stays refused until managed key custody exists, and its implementation, rotation proof and recovery proof are a prerequisite of release gate **G3**, not a task of this slice. The first-consumer qualification of every provisional default (above) and S0.65's calibration (OB-31) are unchanged.
**Does not.** Generate or print a production key; open a connection; read a secret during describe; build managed key custody (production stays refused); enforce any deadline, limit or trusted-proxy setting it validates; or let staging's local custody, capture adapter and substitute verifier stand as real-provider, real-secret or release evidence: they are for controlled fixture acceptance, and no waiver is extended by them.
**Stop if.** A key purpose needs a value the documents leave unset (surface it; never default it).

#### S0.3 — Cryptography and credential normalisation

| | |
|---|---|
| **Needs**| S0.2 |
| **Run**| B D E |
| **Operations**| none |
| **Criteria**| none |

**Subtasks.** The parent is done when every subtask is, and keeps the parent's operations, criteria and gate; a subtask's fixture proof never completes a parent criterion. The parent's *Needs* apply to every subtask; *Also needs* adds to them.

| Subtask| Delivers| Also needs| Run| Evidence it reaches|
|---|---|---|---|---|
| S0.3a| Qualify `crypto.argon2` on the pinned Node, then `Hasher`, the credential rule and the email canonical form| none| B D E| fixture/platform verified|
| S0.3b| `TokenService` (tokens, SHA-256 at rest, constant-time compare) and `randomUUIDv7`| none| B| fixture/platform verified|
| S0.3c| `TotpVerifier` (RFC 6238, injected UTC clock, replay-step tracking)| none| B| fixture/platform verified|
| S0.3d| `SecretCipher` (AES-GCM, purpose-separated keys, key version, rotation)| none| B| fixture/platform verified|

**Builds on.** Nothing: production code uses `randomUUID` for the request id and one SHA-256 for migration history, and `TestClock` exists only in the harness. `dependency-policy.test.ts` allows exact versions only and no install scripts, so the Argon2id implementation is **qualified first**: Node's built-in `crypto.argon2`, which [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.4c names, is checked to exist on the pinned Node 24.21.0 and measured before any package is proposed (a new package is a stop condition).
**Newly builds.** The `Hasher` adapter (asynchronous Argon2id, versioned pepper, parameters from configuration), `TokenService` (high-entropy tokens, SHA-256 at rest, constant-time compare), `TotpVerifier` (RFC 6238, injected UTC wall clock, replay-step tracking), `SecretCipher` (AES-GCM envelopes with purpose-separated keys, key version and authenticated data), `randomUUIDv7`; the **credential rule** of [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.4a (NFKC, raw and normalised bounds of 12 to 128 code points, lone surrogates rejected, never trimmed or case-folded) and the **work-email canonical form** (trim, NFKC, whole-address lower case, no dot or plus folding).
**Files.** `src/platform/auth/crypto/*`, `src/platform/auth/credentials/*` and their tests; a single-hash benchmark script under `apps/api/src/tools/`; and, for the Argon2id profile "from configuration" (settings `ARGON2_*`, validated at start, with a floor for deployed environments), `platform/config/*`, `.env.example`, the harness environment where it needs one and the DEPLOYMENT configuration table (corrected on review, 9 October 2026: the deliverable names configuration, so the files that carry a setting are this task's, and the run codes are those of a task that changes configuration). The `SealedSecret` port carries the envelope version.
**Evidence.** Published known-answer vectors (RFC 6238, Argon2id), key-rotation tests (old version decrypts, new version encrypts), the U+FB03 arithmetic of the 12/128 bounds, security-matrix Families V8 to V10. *Fixture/platform verified*.
**Does not.** Claim production Argon2id parameters. S0.3a chooses and records a development-qualified cost from a measurement on the development machine (environment recorded); S0.65 proposes the deployment values for the owner.
**Stop if.** A published vector disagrees with the library.

#### S0.4 — Database context, capabilities and the closed `db` handle

| | |
|---|---|
| **Needs**| S0.1, S0.2 |
| **Run**| B D |
| **Operations**| none |
| **Criteria**| none |

**Subtasks.** The parent is done when every subtask is, and keeps the parent's operations, criteria and gate; a subtask's fixture proof never completes a parent criterion. The parent's *Needs* apply to every subtask; *Also needs* adds to them.

| Subtask| Delivers| Also needs| Run| Evidence it reaches|
|---|---|---|---|---|
| S0.4a| `SecurityContext` v2 (task capability, scope probe, principal-and-surface pairing) and its accessors, with their migration| none| B D| fixture/platform verified|
| S0.4b| The access matrix per capability and GRANT-based separation; the `SYSTEM` principal mapped to the audit's null actor| S0.4a| B D| fixture/platform verified|
| S0.4c| Close the public context-free `db` handle and `transaction()`; port `e2e-main.mjs` off `db.$client`| S0.4a| B D E| fixture/platform verified|

**Builds on.** `DatabaseService.transactionWithContext` (validates the context, one pooled connection, transaction-local `melarc.*` settings, refuses a nested transaction, destroys a connection whose `BEGIN`, `COMMIT` or `ROLLBACK` failed), `transaction-context.ts` (`SecurityContext` v1: principal type and id, session, surface, authorization key, hub scope mode and hubs, vendor organisation, rider, correlation id), `postgresConnectionSettings`, the pool of the runtime login `melarc_api_runtime`, the migration `0000_database_foundation.sql` (five accessor functions, no table), and the pooled-context DB tests (`GBT-A1` to `A5`), which passed in the runbook's acceptance record (not re-run for this plan).
**Newly builds.** `SecurityContext` v2: a **task capability** from a closed list (`melarc.task_capability`), the scope probe (`melarc.scope_probe_id`) and a principal-and-surface pairing check, none of which exists though [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §14.1 describes them; the accessors for them; the **access matrix per capability** (technical principal, tables, statements, lookup predicates, returned fields, composition root) in §14.17 terms; GRANT-based separation instead of `SYSTEM OR` blanket policies; the `SYSTEM` principal id mapped to the audit's null actor; the public context-free `db` handle and `transaction()` closed, and `apps/api/test/support/e2e-main.mjs`, which writes through `db.$client`, ported off it.
**Files.** `platform/database/*`, `migrations/` (a new migration for the accessors), `test/support/e2e-main.mjs`, [data-scope-registry.md](../../contracts/data-scope-registry.md) rows for any table touched. Also, as the deliverables require (corrected at the close of S0.4, 9 October 2026, on the precedent of S0.3): `tools/database/migration-lint.ts`, `catalog-invariants.ts` and a new `system-branch.ts` for the rule that a `SYSTEM` branch names one capability; `src/test-support/database-door.ts` and `src/architecture.test.ts` for the guards on who opens a capability, who writes the probe id and who may reach the pool; and the database tests with their fixtures under `test/database/`.
**Evidence.** DB tests under the runtime login: the existing Family A suite extended to the new settings (a pool of one never leaks context), Family B-partial (a malformed principal fails closed by abort, `GBT-B10`, `B11`), Families E and J. *Fixture/platform verified*; real-operation evidence waits for the first operation. **Corrected after the review of 9 October 2026, which found four gaps in what the first pass claimed:**
- *The probe is read-only by command.* Its predicate is in a separate policy `FOR SELECT` and in no other (the earlier disjunct in a policy for ALL let an `UPDATE` move a record of another hub into one's own). Runtime-login tests, with the probe id set by hand and `DELETE` granted so that the policy is what decides: the probed record is readable; an `UPDATE` (a move into an authorized hub included, with and without `RETURNING`), a `DELETE`, a locking read and an upsert change or find nothing; an `INSERT` of the probed identifier into another hub is refused; ordinary operations in one's own hub still work. The lint and the catalogue refuse the predicate in any policy that is not `FOR SELECT`.
- *The probe holds its transaction.* While the probe id is set no other statement of the transaction runs, and a second probe may not start. Deterministic tests: unit tests with a real service over a recording connection, and a runtime-login test in which a normal read and a second probe are issued while the probe's read waits on a table lock held by another connection (state-based, no sleeps for ordering).
- *The capability test is mandatory.* A `SYSTEM` arm is accepted only as the arm of one `CASE melarc.principal_type()` with `ELSE false`, in which one `AND` conjunct is exactly the positive capability test (`system-branch.ts`). The three reproduced bypasses (a negated test, `(test OR true) AND true`, `(CASE ...) OR true`), an `ELSE` that admits everyone, and the other unsupported shapes are refused by the lint and by the catalogue, and a table written with the negation is shown to admit a context under the wrong capability. **A second review found one more defect in the same checker, fixed:** `AND` binds tighter than `OR`, and the extraction of mandatory conjuncts split on `AND` before respecting an `OR`, so `(melarc.task_capability() = 'seed' AND false OR true) AND true`, which is true for every capability, passed. A level that has an `OR` of its own is now one disjunction at every depth of parentheses, and nothing is extracted from inside it; an arm that uses `BETWEEN`, whose `AND` is not a conjunction, is refused rather than read. Regressions: the reviewed expression, its nested-parenthesis and `pg_get_expr` forms, the disjunction first, last and alone, a reversed comparison and an Outbox call; the supported form (a mandatory test beside an unrelated parenthesized `OR`, in either order) stays accepted. A table written with the reviewed expression is shown to admit a context under `authentication` and under `rate_limit`, and is refused by the lint and by the catalogue. The database prints its own grouping back with explicit parentheses, so the catalogue path was never exposed to the unparenthesized form: the defect was in the lint's reading of the migration text, and both are pinned. The narrow structure is unchanged.
- *Surface pairing.* The four pairs (`STAFF`/`OPS_PORTAL`, `VENDOR`/`VENDOR_PWA`, `RIDER`/`RIDER_ANDROID`, `SYSTEM`/`SYSTEM`) are recorded in [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §14.1b; no other pairing is permitted or inferred.
- *Opener directories* are an architecture convention checked by a text scan; they are not proof against a context built dynamically, and the grant set is what holds.
**Obligations carried.** `GBT-B10`, `B11`, `E2` to `E4`, `E6` and `E7` ran at S0.4 on **fixture tables** under the runtime login; what remains of Families E and J, and the repeats on real tables and real roles, are in [§7.5](#75-carried-from-s04): **D, not run**.
**Does not.** Add a business table.
**Stop if.** A capability needs a grant that would let the runtime role bypass row-level security.

#### S0.5 — Database roles, posture and migration lint

| | |
|---|---|
| **Needs**| S0.4 |
| **Run**| B D |
| **Operations**| none |
| **Criteria**| none |

**Builds on.** `tools/database/catalog-invariants.ts` (12 checks against a migrated database; they held at acceptance), `migration-lint.ts` (reads migration text; cannot see `EXECUTE`), `run-migrations.ts` (refuses an edited, removed or reordered migration), `provisioning.ts` (`provisionRoles` creates exactly `melarc_owner`, `melarc_migration_elevated` and `melarc_api_runtime`), `DatabaseService.check()` (a role-posture readiness check that does **not** yet test `CREATE` on a schema or the database, or owning a schema or function; its own comment says so), `db:check` and `db:orphans`.
**Newly builds.** The worker base role (`melarc_worker_runtime`) and `melarc_worker_cap_credential_delivery`; a **provisioning role** outside API and worker configuration; the posture checks the existing invariants lack — `CREATE` on a schema or the database, owning a schema or function, role membership and privileged-function `EXECUTE` — for the runtime, worker and provisioning logins, in the readiness check and in `catalog-invariants.ts` (schema and function owner, `PUBLIC` `EXECUTE` and `CREATE`, default privileges and the `SECURITY DEFINER` search path are already checked); lint rules for `CREATE ROLE`, `GRANT <role>` and `SECURITY DEFINER` (fixed `search_path`, minimal `EXECUTE`). The roles named in [permissions.md](../../contracts/permissions.md) §14 do not exist today.
**Files.** a new migration, `tools/database/provisioning.ts`, `catalog-invariants.ts`, `migration-lint.ts`, `platform/database/database.service.ts` and their tests, [MIGRATION_AND_SEEDING.md](../../architecture/MIGRATION_AND_SEEDING.md) §5.1 only if the roles differ from it. Also, as the deliverables require (corrected at the close of S0.5, 9 October 2026): `platform/database/technical-roles.ts` and `role-posture.ts` (the one posture query that the readiness check and the catalogue check share), `tools/database/local-logins.ts` (the passwords of the two logins that have no setting), `capability-access.ts` (it names the roles), the test kit's login list, [DEVELOPMENT.md](../../DEVELOPMENT.md) and [apps/api/CLAUDE.md](../../apps/api/CLAUDE.md). §5.1 differs from the lint as built and was corrected: it flagged `CREATE FUNCTION`, which the committed migrations create and cannot be edited to annotate.
**Evidence.** Catalogue tests run **as each actual login**, never as the owner (Families J, K, Y). *Fixture/platform verified*. **Corrected after the review of 9 October 2026:** the posture asks about every role a login can become, not only what it inherits. A membership granted `INHERIT FALSE, SET TRUE` gives none of a role's privileges as they stand and all of them after `SET ROLE`; `CREATE` on a schema or the database and `EXECUTE` on an unapproved `SECURITY DEFINER` function are therefore judged for the login and for every role it is a member of, directly or through others, whatever the options. Tests as real probe logins show the route is real (the login cannot create a table, then can after `SET ROLE`), the readiness check and the catalogue (for the real worker, provisioning and API logins) refuse it, directly and through an intermediate role, and a harmless grant-set role granted in every option combination is accepted (the capability role of S0.18 will be one).
**Obligations carried.** `GBT-J1` to `J5`, `J12`, `J13` and `J16`, `GBT-K5` and `K6` (a running login cannot become the migration identity), `GBT-Y5` and `Y9`, and the readiness check ran at S0.5 as each of the API, worker and provisioning logins, against fixture tables. The rest of Families J, K and Y, and every repeat on real tables and later roles, are in [§7.6](#76-carried-from-s05): **D, not run**.
**Does not.** Give any login a privilege the access matrix of S0.4 does not list.
**Stop if.** The pinned PostgreSQL cannot express a posture check the specification requires.

#### S0.6 — Resource deadlines

| | |
|---|---|
| **Needs**| S0.4 |
| **Run**| B D |
| **Operations**| none |
| **Criteria**| none |

**Builds on.** The shutdown budget and forced exit in `platform/lifecycle/`, `within-budget.ts`, and the pool of `database.module.ts`, which today sets a maximum, a 30-second idle timeout and a 5-second connect timeout and **nothing else**: no statement, lock or idle-in-transaction timeout and no waiter bound. `createApp` sets no request-size limit.
**Newly builds.** Per-connection statement, lock and idle-in-transaction timeouts (lock inside statement inside transaction, [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §14.6); bounded pool waiters; a connection whose state is uncertain is discarded; and the **shared execution-budget mechanism** ([§11.8](#118-deadline-ownership-and-the-execution-budget)): one per-request budget that the database layer and, through S0.20, the request pipeline both consume, so that database timeouts are not the only bound on a request. A request that exceeds its budget answers the platform's generic operational failure, **after** the mechanism has cancelled what can be cancelled, rolled back the open transaction, discarded a connection of uncertain state and made a late side effect impossible or recorded; racing a response against a timer is not enforcement. Concrete development and test values are chosen here, each recorded with its environment and the test that exercises it (development-qualified, not production-qualified); S0.65 proposes the deployment values.
**Files.** `platform/database/database.module.ts`, `platform/config/*`, the budget mechanism under `platform/` (its place is chosen here), `.env.example`, and their tests. The HTTP header, body and admission limits are S0.20's and are not set here. **The production `Clock` adapter is this task's** (assigned on the review of S0.3, 9 October 2026; `TestClock` is harness-only and no earlier task builds one): a `*.adapter.ts` file under `platform/auth/`, listed in `architecture.test.ts` and bound in the composition root before the deadline machinery needs it, providing the UTC wall clock and monotonic elapsed time. A persisted expiry decision keeps using the database's time (§3, "Time"), and the `TotpVerifier` and `randomUUIDv7` take their time from this port.
**Evidence.** DB tests that hold a lock past the timeout and assert the failure and the connection's disposal; tests that expire a budget **mid-work** and assert the cancellation, the rollback, the disposal of the connection and that no side effect (a commit, an outbound call, an audit or delivery enqueue) takes effect after the caller was told the request failed. *Fixture/platform verified*. **Reached (10 October 2026), all as `melarc_api_runtime` and observed from the administrator's connection, never from the one that did the work:**
- *A bounded line in front of the pool, and waiters that are removed.* `ConnectionQueue` holds one permit per pooled connection, at most `DATABASE_POOL_MAX_WAITERS` callers wait, a caller whose acquire timeout or request budget ran out leaves the line at that moment, and a connection that comes free goes to nobody who has gone. Unit tests (fake timers) prove first come first served, the cap, removal on timeout and on abort, no timer or listener left behind and closing; the runtime-login test shows a pool of one never opens a second session however many callers wait, a further caller is refused without a session, and an acquire timeout and an expired request budget each remove their waiter. A connection attempt abandoned at expiry keeps its permit until it ends and returns the late connection unused.
- *The server's time bounds are on every connection.* `statement_timeout`, `lock_timeout` and `idle_in_transaction_session_timeout` are start-up parameters of the pool, and each transaction sets `transaction_timeout` to its budget plus the disposal bound (one round trip with `BEGIN`). Read back from the server as the runtime login. A lock wait ended by `lock_timeout`, a statement by `statement_timeout` and a transaction idling past `idle_in_transaction_session_timeout` each fail with a typed `DatabaseDeadlineError` (kind `lock`, `statement`, `idle-in-transaction`; the last is named although the driver only reports a closed connection), and the connection that raised it is destroyed and seen gone from `pg_stat_activity`, though its rollback worked.
- *A budget that expires mid-work (OB-37, the mechanism and its database half).* With a 500 ms request budget: a statement waiting for a table lock is cancelled (`pg_cancel_backend` from another connection), the waiting backend is gone, nothing was committed and the caller was told within the budget plus a cancel and a rollback; a running `pg_sleep(30)` after an `INSERT` leaves no row, then or 400 ms later; work outside the database that finishes late is not committed and its later statement is refused before it reaches any connection; a transaction with no request is bounded by `DATABASE_TRANSACTION_TIMEOUT_MS`; the next transaction runs on a new backend with no leftover context, no open transaction and no leaked row; a request that had already run out takes no connection. The clean-up is itself bounded by `DISPOSAL_BOUND_MS` (a failing cancel and a hanging rollback end in the connection destroyed).
- *An uncertain commit is reported as uncertain.* A budget that ran out while COMMIT was in flight, a connection lost during it, and a FATAL error from the server give `CommitOutcomeUnknownError`: no rollback is sent and none is claimed; a commit the server refused is that refusal. A deferred trigger that sleeps at commit shows it is real: the caller was told at 400 ms, nothing was visible then, and the row **was** committed 1.5 s later although the connection had been destroyed.
- *The cancel needs no privilege beyond the runtime login's own,* and cannot reach another role's session or an unknown process id (`PgStatementCanceller`; at most four cancel connections at once, so a stall that expires every request is not a storm of connections).
- *The production `Clock`* (`SystemClock`: the UTC wall clock and `performance.now()`) is bound in the runtime composition (`RUNTIME_PORT_BINDINGS`), listed in `architecture.test.ts`, and offers no way to set or freeze time; a guard refuses `Date.now()`, `performance.now()` and `new Date()` in `platform/execution/` and `platform/database/`, so every budget measures on the injected `Clock`. OB-43 is closed.
- *Parameters.* The database deadlines, the pool waiters, the request budget (`REQUEST_EXECUTION_BUDGET_MS`, 15000) and two constants (the disposal bound, 2000 ms; four cancel connections) are **development-qualified, not production-qualified**: DEPLOYMENT_AND_ENVIRONMENTS.md §12.5, "What S0.6 applied and where it was exercised", records each figure, the tests that exercise it and the environment (Windows 11 on an Intel Core i7-8750H, Node 24.21.0, PostgreSQL 18.6 in a local container, `pg` 8.23.1) with indicative timings over 20 runs. S0.65 proposes the release values.
- *Targeted breaks.* Twenty-three single breaks of the new guards (a wall clock for the monotonic one, a timer that holds the process open, a waiter left in line, an unbounded line, late work committed, every commit error treated as a refusal, the server's margin dropped, a running statement not cancelled, a deadline connection kept, an unbounded rollback, a leaked late connection, an errored connection returned to the pool, a cancel that reaches other roles, a missing start-up timeout, the server's transaction bound dropped, a clock read in the budget, a lock timeout named as another kind, the server's explanation lost) were each caught by a test, and each file was restored and its hash checked.
- *Gate (B D E, uncached, Windows, once on the final state of S0.6; superseded by the gate on the final tree of the correction batch, [§7.12](#712-stage-1-correction-batch-10-october-2026-disposition)).* `format:check`, `lint`, `typecheck`, `build`, `contract:check`, `api-client:check` and `db:check` exit 0; `pnpm test` exits 0 (root 1189 with 2 skipped, API 3385 with 5 skipped, Ops 220, api-client 250, harness 199 with 1 skipped); `pnpm run test:db` exits 0 (442 passed and 1 skipped in 14 files, the new `execution-budget.db.test.ts` being 15 tests as the runtime login); `pnpm run test:e2e` exits 0 (16 passed). **Not run:** the Linux, WSL2 and CI runs (OB-62), `test:browser` (nothing in the Ops Portal changed) and `pnpm audit` (run once at the end of the stage).
**Files (as built).** `platform/execution/` (`execution-budget.ts`, `execution-parameters.ts`), `platform/database/` (`database.service.ts`, `database.module.ts`, `connection-queue.ts`, `statement-canceller.ts`, `database-failures.ts`), `platform/auth/clock/system.clock.adapter.ts`, `platform/platform.tokens.ts`, `platform/config/*` (the `REQUEST_EXECUTION_BUDGET_MS` setting and `execution` in `AppConfig`), `app.module.ts`, `.env.example`, `src/test-support/` (`manual-clock.ts`, `fake-pg.ts`, `budget-time.ts`), the unit and database tests (`execution-budget.test.ts`, `connection-queue.test.ts`, `statement-canceller.test.ts`, `database-deadlines.test.ts`, `test/database/execution-budget.db.test.ts`, `test/database/support/runtime.ts`), `architecture.test.ts` (the Clock adapter and the time guard), [DEPLOYMENT_AND_ENVIRONMENTS.md](../../architecture/DEPLOYMENT_AND_ENVIRONMENTS.md) §12.5 with its guard `deployment-table.test.ts`, [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §14.6 (one sentence on the unknown commit) and [apps/api/CLAUDE.md](../../apps/api/CLAUDE.md).
- *Corrected on 10 October 2026 (F01, F04, F05; [§7.12](#712-stage-1-correction-batch-10-october-2026-disposition)).* A COMMIT the server answers with the tag `ROLLBACK` (the work caught a failed statement and carried on) is `TransactionRolledBackError`, never success; the wait for a permit and the connecting share **one** acquisition deadline (so the whole wait for a connection is at most `DATABASE_ACQUIRE_TIMEOUT_MS`, not twice it), and a connection that arrives after it is not handed over; the cancel has one bound for the wait for its turn, the connection, the statement and the close, and the clean-up after an expiry sends nothing once its bound has passed; `DatabaseService.check` takes the readiness registry's deadline and destroys its connection and gives back its permit when it passes; and a finished `ExecutionBudget` is closed, and so is every budget below it (`BudgetClosedError`, which is not expiry): it starts no effect and no child, and none can be constructed under it.
**Obligations carried.** Deadline relations at the deployed topology (G2); **OB-37**: the mechanism and its database half are proved here, the pipeline half is S0.20's; the rest are in [§7.7](#77-carried-from-s06). Not claimed: that the figures hold at the deployed topology, or under load.
**Does not.** Choose production values; set an HTTP receipt or admission limit.
**Stop if.** A relation between deadlines cannot be satisfied with the pool size configured.

#### S0.7 — Policy-coordination toolkit

| | |
|---|---|
| **Needs**| S0.4, S0.6 |
| **Run**| B D |
| **Operations**| none |
| **Criteria**| none |

**Builds on.** Nothing exists: no lock helper, no planner, no isolation guard.
**Newly builds.** The mechanism of [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.10a and nothing that uses a policy table: the **lock-keys module** (two fixed 32-bit classes, `AUTH_POLICY_BUNDLE` with a stable digest of the bundle id, `AUTH_POLICY_FIXED` with the principal-type ordinal; a test that no two advisory classes in the codebase share a value); wrappers for the transaction-scoped shared and exclusive advisory functions only; the **planner** (discover, merge duplicates and digest collisions in the strongest mode, sort by class then key, acquire before any data statement, revalidate under the locks, bounded whole-transaction restart inside one total deadline, no shared-to-exclusive upgrade); the **isolation guard** (a transaction not at `READ COMMITTED` is refused); an application-code check forbidding the session-level advisory functions and any unbounded `pg_try_` loop.
**Files.** `src/platform/database/policy-lock/*`, `transaction-context.ts` (transaction configuration may precede the locks), architecture test additions.
**Evidence.** Unit tests for merge, order and collision handling; DB tests under the runtime login for the leaked-lock check (Family A), `lock_timeout` expiry, the isolation guard and a concrete restart bound, chosen and recorded here with its environment, whose attempts together fit **one total operation deadline**; this task does not wait for S0.65. *Fixture/platform verified*. **Reached (10 October 2026), as `melarc_api_runtime`, with the locks observed in `pg_locks` and `pg_stat_activity` from the administrator's connection and the policy tables as fixtures (a table the runtime can read and cannot lock or change):**
- *The lock-keys module.* Two fixed 32-bit classes (`AUTH_POLICY_BUNDLE` 1296843313, `AUTH_POLICY_FIXED` 1296844337) in one frozen registry, a bundle digest (the first four bytes of the SHA-256 of the lower-case id, a signed big-endian integer) and the Vendor and Rider ordinals, all pinned by test vectors; a test that no two classes share a value, and an architecture guard that refuses any advisory call outside `policy-lock/`, so a class cannot be added anywhere the test cannot see. The command-line tools keep their session-level locks on a connection of their own (a one-integer key space, disjoint from the two-integer classes).
- *The planner.* Duplicates and digest collisions merge into one `(class, key)` in the strongest mode, sorted by class then key; every ordering of the same requests gives one plan; unknown classes, non-32-bit keys and unknown modes are refused.
- *Acquisition.* `acquirePolicyLocks` takes the plan once per transaction, one statement per lock in the plan's order, with the transaction-scoped functions only, **first**: only the security context may precede it (the service counts the statements the work issues and marks the context), a statement issued beside it is caught and fails the transaction, and a transaction at any level but READ COMMITTED is refused before the first lock (shown with the level set on the role, as a misconfigured database would set it). A second acquisition, how a shared key would be asked for exclusive, is refused.
- *The coordinator.* Discovery in its own short transaction; the plan; the locks; revalidation under them; the act only after the revalidation passed. A reassigned identity between discovery and lock rolls the whole transaction back and restarts, with nothing written meanwhile (the effects table is unchanged under the lock of each attempt); attempts are bounded at three; every attempt runs inside one total deadline (a child of the request's budget when there is one), so a restart never grants a fresh one; an act that needs a key exclusive restarts with the stronger plan from the start; a lock timeout is the database's deadline error and is not retried.
- *Family A, as the runtime login.* After a commit, a rollback, an aborted transaction and a connection destroyed by an expired budget, no advisory lock remains, and the next transaction on the same pooled connection holds none. A reader pair shares a key, a writer waits for both, and a distinct key is not blocked. A held lock makes the wait end at `lock_timeout` with a `lock` deadline error, no effect and the waiting backend gone.
- *Recorded bound.* The restart bound (3 attempts), the total deadline and the lock wait are recorded with the environment and timings in DEPLOYMENT_AND_ENVIRONMENTS.md §12.5, "What S0.7 applied and where it was exercised": an operation took 12.5 ms at the median, 30.5 ms with all three attempts used.
- *Targeted breaks.* Twenty-two single breaks (a shared class, a changed byte order, a case-sensitive digest, the weaker mode kept, the class ignored in the sort, a second acquisition, a lock after another statement, an interleaved statement unnoticed, an unenforced isolation level, a session-level function, the context counted as data, a fresh deadline per attempt, changed facts acted on, a restart that loses the stronger plan, a session-level function, a try-lock or a transaction-scoped call outside the toolkit missed by the guard, an exclusive lock that outlives its transaction, and the locks taken after a read) were each caught, and each file was restored and its hash checked.
- *Gate (B D E, uncached, Windows, once on the final state of S0.7).* `format:check`, `lint`, `typecheck`, `build`, `contract:check`, `api-client:check` and `db:check` exit 0; `pnpm test` exits 0 (root 1189 with 2 skipped, API 3480 with 5 skipped, Ops 220, api-client 250, harness 199 with 1 skipped); `pnpm run test:db` exits 0 (457 passed and 1 skipped in 15 files, the new `policy-lock.db.test.ts` being 15 tests as the runtime login); `pnpm run test:e2e` exits 0 (16 passed). **Not run:** the Linux, WSL2 and CI runs (OB-62) and `pnpm audit` (once, at the end of the stage).
**Files (as built).** `platform/database/policy-lock/` (`lock-keys.ts`, `plan.ts`, `acquire.ts`, `coordinate.ts`), `platform/database/transaction-facts.ts` and `database.service.ts` (the statements the work issues, counted from the point the context is applied), `transaction-context.ts` (a header note: the context is configuration and may precede the locks), `src/test-support/advisory-locks.ts` and `architecture.test.ts` (the application-code check), the unit tests beside each file, `test/database/policy-lock.db.test.ts` and `test/database/support/service.ts`, DEPLOYMENT_AND_ENVIRONMENTS.md §12.5 with its guard, SECURITY_DESIGN.md §13.10a (what the toolkit proves and what stays owed) and [apps/api/CLAUDE.md](../../apps/api/CLAUDE.md).
**Obligations carried (§13.10a).** Obligations 1 (on fixture tables), 5, 6, 7, 9, 11 and 12 ran at the toolkit; **repeated on the real policy tables and rows, and with the real sign-in, mutation and reduction: D, not run** until S0.27 and S0.64. Obligations 2, 3, 4, 8, 10 and 13 are not claimed. The rest are in [§7.8](#78-carried-from-s07).
**Does not.** Read or write `role_bundle`, `role_bundle_grant` or `fixed_permission_policy`: they do not exist yet.
**Stop if.** Keeping the runtime role at `SELECT` only turns out to need a table grant ([§13.10a](../../architecture/SECURITY_DESIGN.md) forbids one).

#### S0.8 — Reference-data schema and registry

| | |
|---|---|
| **Needs**| S0.5, S0.7 |
| **Run**| B D |
| **Operations**| none |
| **Criteria**| none |

**Builds on.** The empty Drizzle schema (`schema/index.ts`), `drizzle-kit generate` and `db:check`, and the migration lint and catalogue invariants, which refuse a table without its owner, enabled and forced row-level security, role-free policies and explicit grants.
**Newly builds.** The tables `hub`, `permission`, `role_bundle` (with `revision` and `reduction_floor`), `role_bundle_grant` (permission key, hub scope, ownership scope, tier), `fixed_permission_policy` (`revision`, `minimum_revision`, one row per `VENDOR` and `RIDER`), `setting`, `reason_code` (with the closed `permitted_operations` attribute, whose entries are an `operationId` or an `operationId#BRANCH`, [domain-model.md](../../contracts/domain-model.md) §3.9). Each table ships with its owner, forced row-level security, policies, grants and a [data-scope-registry.md](../../contracts/data-scope-registry.md) row and Family S classification **in the same migration**. The runtime role holds **SELECT only** on the three policy tables.
**Files.** a new migration, `platform/database/schema/*`, the registry, `catalog-invariants.ts` tests.
**Evidence.** Under the runtime login: `UPDATE` on `role_bundle`, `role_bundle_grant`, `fixed_permission_policy` is refused, `SELECT … FOR SHARE` is refused, the advisory functions run, and the catalogue shows no `UPDATE` grant on them (§13.10a obligation 1). Families F, K, S. *Fixture/platform verified*. **Reached (10 October 2026), as `melarc_api_runtime` and, for constraints, the cluster administrator (a constraint binds a superuser; row-level security does not):**
- *The seven tables.* `hub`, `permission`, `role_bundle`, `role_bundle_grant`, `fixed_permission_policy`, `setting` and `reason_code`, in schema `public`, in one migration (`0003_reference_data.sql`: the generated `CREATE TABLE` and foreign keys, and by hand the owner `melarc_owner`, `ENABLE` and `FORCE ROW LEVEL SECURITY`, the read policies and the grants). Each is class `PLATFORM` in data-scope-registry.md §4.1; the registry already holds the rows, and a test now reads them from the document (below). The shape is the contracts': a bundle's `audience`, `revision`, `reduction_floor` and `privileged` (domain-model.md §6.9), a grant's key, hub scope (`none` · `own` · `all`), ownership scope (`own` · `assigned` · `any`) and tier (`A` · `S` · `P`), one `fixed_permission_policy` row per `VENDOR` and `RIDER`, and the reason catalogue's fields (§3.9) with `permitted_operations` as a closed text array of `operationId` or `operationId#BRANCH`.
- *Who reads, who does not.* A staff context reads every table; a SYSTEM context reads them under the `authentication` capability and under no other; a Vendor, a Rider and a request with no context read nothing (the closed `ELSE`). Nobody writes: the runtime login holds `SELECT` and nothing else, so an `INSERT`, an `UPDATE` and a `DELETE` under a staff context and under the `authentication` capability are refused at the privilege (`42501`), and a row lock (`FOR SHARE`, `FOR KEY SHARE`, `FOR UPDATE`, `FOR NO KEY UPDATE`) is refused on every table. The catalogue shows the runtime, worker and provisioning logins holding no `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES` or `TRIGGER` on any of them, at table or column level (obligation 1, on the real tables). The seed's SYSTEM branch and the provisioning grants are S0.9's.
- *The advisory locks work beside the real tables.* The toolkit takes the bundle and fixed locks, then the policy rows are read, as a sign-in does.
- *Constraints, written as the administrator.* Closed sets (audience, scopes, tier, principal type, domain, attribution, setting scope and type); revision and floor ranges (`reduction_floor ≤ revision`, `minimum_revision ≤ revision`); key grammars (permission, setting, reason code); a permission's domain is the key's first part and one of the seventeen; the recipient-contact checkpoint rule and the identity-domain rule for `permitted_operations` (a non-empty list of well-formed entries there, null elsewhere); uniqueness of bundle names, hub names, codes and keys; and no cascade (a bundle with grants, and a permission a grant uses, cannot be removed: `restrict`). **The counters are guarded at the table** (two triggers, `melarc.role_bundle_guard` and `melarc.fixed_permission_policy_guard`): a revision rises by exactly one, the floor moves only together with a raise of the revision and then to the new revision, a bundle never changes audience. They bind the owner and a mistaken seed as well as the primitive that raises them.
- *Family S and the grants, against the document.* `data-scope-registry.md` is parsed by the test support (the table counts it states, 18 · 47 · 10 · 2 · 2 · 4, are asserted), and a test over the migrated database asserts that every table is classified in §4 and that no technical login holds a privilege the registry does not give its identity (the "Read identity" and "Write identity" cells, and the statements the capabilities of `capability-access.ts` list). It is shown to fire (an unclassified table; `UPDATE` on a policy table, `INSERT` on the catalogue, `SELECT` on `hub` and `INSERT` on `setting` for the base worker; a column-level `UPDATE`). The tables only a seed writes are on `SEED_ONLY_TABLES` (`registry-grants.ts`), so the API and the workers read them and the seed alone inserts, whatever the registry's "Write identity" will say once an operation exists.
- *Targeted breaks.* Twelve single breaks (`FORCE` left off, a closed `ELSE` opened, `UPDATE` granted on a policy table, a SYSTEM arm that loses its capability test, either counters trigger missing, a cascade, a floor that moves without a reduction, the identity-domain rule dropped, the grants check without its ceiling and without column privileges, and the registry reader mis-reading a cell) were each caught, and each file was restored and its hash checked.
- *Gate (B D E, uncached, Windows, on the final state of S0.8).* `format:check`, `lint`, `typecheck`, `build`, `contract:check`, `api-client:check` and `db:check` exit 0; `pnpm run test:db` exits 0 (555 passed and 1 skipped in 17 files, the two new files being `reference-data.db.test.ts`, 89 tests, and `registry-grants.db.test.ts`, 9); `pnpm run test:e2e` exits 0 (16 passed). **`pnpm test` failed once, on a documentation guard, and was fixed and rerun:** `agent-docs.test.ts` refused a path in `apps/api/CLAUDE.md` that did not resolve (`schema/reference-data.ts` for `src/platform/database/schema/reference-data.ts`); the line was corrected and `pnpm test` was run again in full, uncached, and exits 0 (root 1189 with 2 skipped, API 3495 with 5 skipped, Ops 220, api-client 250, harness 199 with 1 skipped). **Not run:** the Linux, WSL2 and CI runs (OB-62) and `pnpm audit` (once, at the end of the stage).
**Files (as built).** `migrations/0003_reference_data.sql` with its snapshot and journal entry, `platform/database/schema/reference-data.ts` and `schema/index.ts` (the shape and the closed sets, exported for the seed), `src/test-support/data-scope-registry.ts` and `registry-grants.ts` with the unit test of the reader, `test/database/reference-data.db.test.ts` and `registry-grants.db.test.ts`, `capability-access.ts` (a comment), [apps/api/CLAUDE.md](../../apps/api/CLAUDE.md). No registry row changed: the rows were already right.
**Obligations carried.** §13.10a 1: **ran at S0.8 on the real tables**; repeated for the final surface in S0.64: **D, not run**. The rest are in [§7.9](#79-carried-from-s08).
**Does not.** Insert a row (S0.9) or add an operation.
**Stop if.** The registry classification of a table is ambiguous between hub-scoped and platform-wide.

#### S0.9 — Seed helper and reference seeds

| | |
|---|---|
| **Needs**| S0.8, S0.3 |
| **Run**| B D |
| **Operations**| none |
| **Criteria**| none |

**Builds on.** The migration tooling; [apps/api/CLAUDE.md](../../apps/api/CLAUDE.md) says the helper and its `SYSTEM` policy branches arrive here.
**Newly builds.** The seed helper (writes as `SYSTEM` under the `seed` capability, refuses when the table is not empty); the closed permission catalogue as inert data; the confirmed staff bundles and the fixed Vendor and Rider bundles with per-grant explicit hub scope; the two `FixedPermissionPolicy` rows; settings with approved values (a Family Z comparison with [settings.md](../../contracts/settings.md)); one hub (its default zone is not seeded: no zone table exists, OB-77); the **twelve identity reason rows** of [domain-model.md](../../contracts/domain-model.md) §3.9, four of them with a branch-qualified `permitted_operations` entry. Every key created is taken **exclusive** by the seed (§13.10a). Test-only fixtures live apart, are named as fixtures and are refused in production.
**Files.** `platform/database/seed/*` (the helper and its `SYSTEM` policy branches), `tools/seed/*` (the data and the command), `apps/api/package.json`, a new migration for the policy branches, [apps/api/CLAUDE.md](../../apps/api/CLAUDE.md), and tests.
**Evidence.** Seeding twice refuses; a production configuration refuses the fixtures; the seeded catalogue equals [permissions.md](../../contracts/permissions.md) (a derived comparison, not a copied count). *Fixture/platform verified*. **Reached (10 October 2026), as the provisioning login for the seed and as `melarc_api_runtime` for what it may not do:**
- *The helper.* `runSeed` (`platform/database/seed/seed-helper.ts`) runs a plan in one transaction as `SYSTEM` under the `seed` capability, which the service opens only over the provisioning login (over the API runtime's connection it is refused before anything is read or written). It takes every policy key **exclusive** and first (a key a plan asked for shared is taken exclusive all the same), then calls the database function the plan names (`melarc.initialize_reference_data` for the seven tables, `melarc.add_reason_fixtures` for the fixtures: two fixed statements, the rows travelling as one JSON parameter) and makes the database's refusal (SQLSTATE `55000`, naming the table) a `SeedRefusedError`. **Since the correction batch the count, the refusal, the serialization and the inserts are the database's** (migration 0005, below); the helper keeps the policy locks and a second check that each table received the rows it planned. Against a real server: a reader holding a bundle key shared makes the seed wait and end at `lock_timeout` with the lock deadline error and nothing written; a second seed refuses and a snapshot of every row is unchanged; one filled table (a setting) refuses the whole seed and leaves the other six empty; a row the last table refuses leaves all seven empty.
- *The policy branches and the grants (`0004_seed_policies.sql`).* Each of the seven tables has a `_seed_read` policy (so the helper can count and refuse; "No lookup" in the registry is read as no lookup beyond that count, finding OB-79) and a `_seed_insert` policy, each a `SYSTEM` arm of the one supported structure that names the `seed` capability alone; `role_bundle` and `fixed_permission_policy` also require revision 1 (the table's range check then makes the floor 1). `SELECT` and `INSERT` went to the provisioning login in 0004 and to nobody else; **0005 took both back** (F02), so that login holds no privilege on the seven tables, and nobody holds `UPDATE`, `DELETE` or `TRUNCATE`. `role_bundle_grant.tier` becomes nullable (finding OB-75: null means not applicable). **`GBT-E6` on the real tables:** the API runtime sets the `seed` label by hand and is refused `INSERT` on each of the seven by the privilege (`permission denied for table`), not by a policy; **`GBT-E7`:** every seed policy is read from the catalogue, passes the `SYSTEM`-branch checker, names `seed` and no other capability; the provisioning login under `bootstrap`, `authentication`, a staff, a vendor or no context is refused by the row-level security policy of every table.
- *Initialization enforced by the database (F02, `0005_seed_initialization.sql`).* Two `SECURITY DEFINER` functions owned by `melarc_owner`, executable by the provisioning login alone (revoked from `PUBLIC`; on the posture allow-list `APPROVED_DEFINER_EXECUTE`), name every table and column in their own text and take their rows as one JSON document. `melarc.initialize_reference_data` locks the seven tables in one order, counts every one, refuses (`55000`) unless all seven are empty, sets the `SYSTEM` principal and the `seed` capability itself for its own statements (the policies of 0004 stay the second line; nothing the caller sets is proof) and puts back what the caller had set, starts bundles and fixed policies at revision 1 and floor 1 whatever the document says, runs at read committed only, and is one statement of the caller's transaction, so a failure at any table leaves nothing. `melarc.add_reason_fixtures` writes `FIXTURE_` reason codes and nothing else, once, and has the same read committed guard (`FIXTURE_` is a naming restriction, not an environment restriction). Shown against a real server by `seed-initialization.db.test.ts`: the first run fills an empty database; a repeat, and a database with only one table filled, refuse and change nothing; a failure part-way (a trigger on the last table) leaves nothing and the next run succeeds; two runs at once cannot both fill the tables (the second waits for the first, then refuses; with a lock timeout it is ended by it; if the first is rolled back the second fills the database once); and **the provisioning login, with the seed label asserted, is refused an `INSERT` of a grant into an existing bundle by the privilege**, which was reproduced as succeeding on the migrations up to 0004. The runtime and the base worker are refused both functions.
- *The reference seeds against their documents (`tools/seed/`).* 127 permission keys, equal to the keys parsed from `permissions.md` section 7 and to the total that document states; 1 hub; 6 bundles (Ops Staff, Senior Ops, Platform Admin, Finance/Reconciliation, Rider, Vendor) with 36 grants, each with an explicit hub scope, ownership scope and tier, and revision 1 / floor 1; the two fixed policy rows; 31 settings (the `CONFIRMED` keys of `settings.md` sections 7.1, 7.5 and 7.7, each value compared with the cell of the document, money in pesewas, per-tier values as named objects; no `OPEN` key); the twelve identity reasons equal to the table of `domain-model.md` section 3.9 (code, domain, label, operations; four branch-qualified), every operation checked against the operations of `openapi.yaml` (OB-74). The database test reads the rows back and compares them with the same documents, and the API runtime reads them as a staff context and as the `authentication` capability.
- *The command and the fixtures.* `pnpm --filter @melarc/api run db:seed` (`DATABASE_SEED_URL` for the provisioning login, with `APP_ENV`; without them the local development database with the local provisioning login, refused when `APP_ENV` names a deployed environment). The URL's user must be the provisioning login; the URL and its password are never printed. `DATABASE_SEED_URL` is **forbidden in the API's environment**, like `DATABASE_MIGRATION_URL`. `--fixtures` writes two test-only reasons through `melarc.add_reason_fixtures` (`tools/fixtures/`: `FIXTURE_REASON_INACTIVE`, `FIXTURE_REASON_OTHER_OPERATION`, labelled `Fixture:`) and **refuses production, and any value that is not a known non-production environment, before it connects** (the database does not know its environment, so that refusal stays the command's; the function itself writes nothing but `FIXTURE_` codes). The built tool was run as a process against a disposable database: it seeded (exit 0), refused a second run (exit 1, nothing on stdout), refused `--fixtures` with `APP_ENV=production` (exit 1) and wrote the fixtures with `APP_ENV=staging`, each ending by itself, with no password in any output. `melarc_dev` was not touched.
- *Targeted breaks.* Twenty-eight single breaks were run (a shared key kept shared, no emptiness check, no locks, a short insert kept, a table named twice, another capability opened, a table written as soon as it is counted, a grant before its bundle, the fixed-policy keys not taken, no `INSERT` for the provisioning login, `UPDATE` granted to it, an insert policy without its capability test or naming another, a seed read policy missing or with an `ELSE true`, `INSERT` granted to the API runtime, the tier left `NOT NULL`, production allowed for the fixtures, an unescaped fixture pattern, the command without its fixtures guard, its login check, its `APP_ENV` requirement or its local-default refusal, the API accepting `DATABASE_SEED_URL`, the matrix without the seed's `SELECT`, the seed wiring off the composition-root list). Twenty-seven were caught at once. The twenty-eighth, the floor condition of the fixed-policy insert policy, could not be: with revision 1 the table's own range check already makes the floor 1, so it was an equivalent mutant; the redundant floor conditions were removed from both policies, and the revision condition of each was then broken and caught (two more). Every file was restored and its hash checked.
- *Gate (B D E, uncached, Windows, once on the final state of S0.9; superseded by the gate on the final tree of the correction batch, [§7.12](#712-stage-1-correction-batch-10-october-2026-disposition)).* `format:check`, `lint`, `typecheck`, `build`, `contract:check`, `api-client:check` and `db:check` exit 0; `pnpm test` exits 0 (root 1189 with 2 skipped, API 3576 with 5 skipped, Ops 220, api-client 250, harness 199 with 1 skipped); `pnpm run test:db` exits 0 (583 passed and 1 skipped in 18 files, the new `seed.db.test.ts` being 28 tests as the provisioning and runtime logins); `pnpm run test:e2e` exits 0 (16 passed). **Not run:** the Linux, WSL2 and CI runs (OB-62), `db:seed` against `melarc_dev` (the owner runs `db:migrate` and then `db:seed`; OB-82) and `pnpm audit` (once, at the end of the stage).
**Files (as built).** `migrations/0004_seed_policies.sql` with its snapshot and journal entry, `platform/database/schema/reference-data.ts` (tier nullable), `platform/database/seed/seed-helper.ts`, `tools/seed/` (`permission-keys.ts`, `bundles.ts`, `hubs.ts`, `reasons.ts`, `settings.ts`, `reference-seed.ts`, `seed-command.ts`, `seed-runtime.ts`), `tools/fixtures/`, `tools/db-seed.ts` and the `db:seed` script, `platform/config/load-config.ts` (`DATABASE_SEED_URL` forbidden), `platform/database/capability-access.ts` (the seed's `SELECT`), `src/test-support/seed-documents.ts`, `architecture.test.ts` (the composition-root list now names `tools/seed/seed-runtime.ts`), the unit tests beside each file, `test/database/seed.db.test.ts` (and `reference-data.db.test.ts`, whose provisioning pin changed deliberately), `test/support/api-process.ts`, DEVELOPMENT.md, DEPLOYMENT_AND_ENVIRONMENTS.md, MIGRATION_AND_SEEDING.md and [apps/api/CLAUDE.md](../../apps/api/CLAUDE.md).
**Obligations carried.** `GBT-E6` and `GBT-E7`: **ran at S0.9 on the real seed tables and the real provisioning role**; repeated for the final surface in S0.64: **D, not run**. §13.10a obligation 5 (the seed follows the one lock protocol) ran at S0.9 against the real policy keys; the rest are in [§7.10](#710-carried-from-s09).
**Does not.** Seed an identity (S0.30) or invent a setting value the documents leave unset.
**Stop if.** A setting has no approved value.

#### S0.10 — Integration kit (Gate 1)

| | |
|---|---|
| **Needs**| S0.9, S0.6 |
| **Run**| B D |
| **Operations**| none |
| **Criteria**| none |

**Builds on.** `src/test-support/` (test application, test configuration, captured logs, contract fixtures), the `database` Vitest project and its `test-database.ts`, which migrates a fresh disposable `melarc_test_<hex>` database for each file and removes only what it made, and the test-only `rls-fixture.ts` table.
**Newly builds.** A real application and real PostgreSQL per file, extending that mechanism (a template database only if the measured migration cost justifies it); an injectable `Clock`; a `TestClient` (cookie jar, CSRF echo, bearer); `admin()` SQL (age rows, break a write, change a status); `observe()`, a second-connection reader; the capture reader; a work-shape tracer; a pool of one.
**Files.** `src/test-support/*`, `apps/api/test/database/support/*`, the Vitest configuration, and the kit's own tests.
**Evidence.** The kit's own tests: aging a row by SQL, a refusal read from a second connection, the capture reader empty by default. **Gate 1:** `pnpm run test:db` green on the developer's database. **Reached (10 October 2026), as `melarc_api_runtime` for the application and the cluster administrator for `admin()` and `observe()`:**
- *The application, real, over a real database of its own.* `startIntegrationKit(database)` (`test/database/support/integration.ts`) loads the runtime configuration (`loadConfig` over `validEnv`), starts the real application through `startTestApp` and `AppModule` on an ephemeral port, connected as `melarc_api_runtime` over a **pool of one** (the pool's `max` is 1, and the second connection sees one backend of that login), and gives a `TestClient` for it. `/readyz` answers 200 through the client; a path nothing serves answers the contract's envelope with `Cache-Control: no-store`; two requests in a row on the pool of one both succeed. Several kits run at once, each over a database of its own.
- *An injectable `Clock`, and no production time-travel switch.* The kit's `ManualClock` is bound through the `ports` option of `AppModule.register`, in the kit's composition only; the application resolves that instance, and the client's cookie jar reads it. Three tests pin the other half: no production source file imports `src/test-support/` (an import, a side-effect import, a dynamic import and a `require` are all found), no configuration key names a clock, a fake time, an offset or a time-travel, and `main.ts` passes the module no `ports`.
- *`TestClient` (`src/test-support/test-client.ts`).* A cookie jar that keeps name, path, `Max-Age` and `Expires` (judged by the injected clock), withholds a `Secure` cookie from plain http except to loopback, keeps and sends an `HttpOnly` cookie without being able to echo it; the CSRF echo (`melarc_csrf` in `X-CSRF-Token`, and `Origin`, on every unsafe request, and none on a safe one) with a wrong token, no token, no origin and another origin on demand; a bearer mode that sends `Authorization` and none of a browser's cookie, token or origin and keeps no cookie; no redirect followed.
- *`admin()` and `observe()`.* **Aging a row by SQL:** a hub made now is not two days old by the database's clock; after `ageRows('hub', 'created_at', '2 days', { id })` the second connection reads that it is, and another row is untouched. **A refusal read from a second connection:** the application's login is refused `INSERT` into `hub` (`42501`) and the second connection counts the same rows and none named for the refused insert. `breakWrites('reason_code')` makes the real seed fail with `P0001` in its last step, every table written before it is rolled back (read from the second connection), and after `mend` the seed completes. `observe()` is read-only at the server (`25006`) and does not wait for the application's connection. Both refuse a table or column name that is not a plain identifier, and take every value as a parameter.
- *The capture reader.* Empty by default; read-only (the reader has no `push` or `clear`); a copy on every read. Nothing writes to its `captureSink` until the capture adapter of S0.17 is bound.
- *The work-shape tracer (`src/test-support/work-shape.ts`).* Records the statements the application's login sent while some work ran, each with its values taken out, and none of the administrator's or the observer's; the driver is put back on return and on a throw; one trace at a time. Against the real service: a transaction reads as `begin … commit` with the statement between, two runs that differ only in a value have one shape, and a run that issues one more statement has another.
- *Stop if: parallel files cannot each have a disposable database.* They can: two `createTestDatabase()` calls made at the same moment give two migrated databases, an application over each, and neither sees the other's rows. The `database` project still runs its files one at a time, for the reason stated in `vitest.config.ts` (the roles are cluster-wide and some tests change them and put them back); that is a choice, not a limit. **A template database is not justified:** creating and migrating a database costs a median of 205 ms and 215 ms (six runs on this machine, Windows, PostgreSQL 18.6 in the local container) and dropping it 85 ms, so a template would save about 0.2 s a file of a run of about 150 s. The Vitest configuration is unchanged.
- *Targeted breaks.* Twenty-three single breaks (no CSRF echo, `Secure` always withheld, expiry read from the machine's clock, an `HttpOnly` token echoed, a path matched by prefix alone, redirects followed, the tracer recording every login, the driver left patched, two traces at once, values left in the shape, the capture store handed out or not cleared, a writable observer, an unchecked identifier, aging that reaches every row, a broken write that does not fail or is never mended, the clock not injected, a larger pool, a production file importing test support, a time setting among the configuration keys, a port binding in `main.ts`). Twenty-two were caught at once; the twenty-third, a bearer client keeping the cookies it is sent, was not, because its test looked only at what the client *sent*; the test now looks at the jar, and the break is caught. Every file was restored and its hash checked.
- *The adversarial review of Stage 1.* Three independent reviewers read S0.6, S0.7 to S0.8 with the policy part of S0.9, and S0.9 with S0.10, without editing anything. They were stopped after a few minutes by the instruction to wrap up, found no critical or high defect in the code they read, and proved nothing by running it; every lead below was checked against the code and the database before anything was changed, and each one fixed has a test that failed first. **Fixed:** (1) a statement sent by a continuation the work left behind, while a failed transaction was being rolled back or while the commit was in flight, queued behind it and ran on the connection with no transaction and no context (`database.service.ts` now closes the handle when the work settles); (2) a cancel connection that never finished closing kept its place for ever (its close has the cancel's bound); (3) the guard on `role_bundle` let the `privileged` flag change without a raised revision and the `id` change at all, and `permitted_operations` accepted a NULL element (all three in `0004_seed_policies.sql`, with the drizzle schema and snapshot in step); (4) the grants check did not look for `TRUNCATE`, `REFERENCES`, `TRIGGER` or `MAINTAIN` (PostgreSQL 17 on), which no login may hold on any table; (5) the `db:seed` local default did not refuse a server that is not on this machine, and a pool that failed to close could hide why the seed refused; (6) the seed-data test could not tell a Senior Ops grant from a Platform Admin one on the rows that state two reaches; (7) `DATABASE_ACQUIRE_TIMEOUT_MS` is documented as two bounds, as it is. **Recorded for the owner and not closed at that time:** OB-83 and OB-84 (the workflow reasons; the emptiness of a seed target is not the database's rule), OB-85 to OB-87 below. OB-83 to OB-85 are closed or decided by the correction batch ([§7.12](#712-stage-1-correction-batch-10-october-2026-disposition)). **Verified sound by reading, per the reviewers:** the execution budget (timers, listeners, children), the connection queue, the lease and the abandoned connect, the commit-in-flight path, the lock planner, acquisition and the statement counting, the policy NULL handling, the 127 permission keys, the 36 grants, the 31 settings and the 12 reasons against their documents. Nine more single breaks were run on the fixes (the handle left open, an unbounded close, the guard without its two new conditions, no NULL check, the grants check without the four privileges, the local default without its host check, a close that hides the reason, a Platform Admin scope narrowed) and each was caught.
- *Corrected on 10 October 2026 (F06; [§7.12](#712-stage-1-correction-batch-10-october-2026-disposition)).* A start that fails part-way closes what it had opened (the application, the administrator's connection, the observer's), last opened first, and reports the failure itself or, if a close failed too, both; `stop()` attempts every close whatever an earlier one did, reports every failure (one as itself, several as an `AggregateError`) and does nothing a second time; `Admin.close()` ends its connection even when a table cannot be mended; `startTestApp` closes the application it built when it is refused. The database the kit was given is never closed or dropped by it.
- *Gate 1 (B D E, uncached, Windows, once on the final state of S0.10, after the adversarial review of the stage; superseded by the gate on the final tree of the correction batch, [§7.12](#712-stage-1-correction-batch-10-october-2026-disposition)).* `format:check`, `lint`, `typecheck`, `build`, `contract:check`, `api-client:check` and `db:check` exit 0; `pnpm test` exits 0 (root 1189 with 2 skipped, API 3631 with 5 skipped, Ops 220, api-client 250, harness 199 with 1 skipped); `pnpm run test:db` exits 0 (606 passed and 1 skipped in 19 files, the new `integration-kit.db.test.ts` being 16 tests as the runtime login and the administrator; Gate 1's condition held on that tree: a real application and a real PostgreSQL are driven from a test as `melarc_api_runtime`, on the Windows machine's local PostgreSQL 18.6 container, which is the developer's database service); `pnpm run test:e2e` exits 0 (16 passed). `pnpm audit --audit-level high` exits 0 (one moderate advisory, the esbuild one of the open owner items). **Not run:** the Linux, WSL2 and CI runs (OB-62), `test:browser`, `db:seed` against `melarc_dev` (OB-82).
**Files (as built).** `src/test-support/test-client.ts`, `work-shape.ts` and `capture.ts` with their tests, `src/test-support/integration-kit.test.ts`, `test/database/support/admin.ts`, `observe.ts` and `integration.ts`, `test/database/integration-kit.db.test.ts`, [apps/api/CLAUDE.md](../../apps/api/CLAUDE.md) (the kit, in its Tests paragraph).
**Obligations carried.** None of the §13.10a obligations belongs to this task. The kit's own are in [§7.11](#711-carried-from-s010).
**Does not.** Add a production time-travel switch.
**Stop if.** Parallel test files cannot each have a disposable database of their own.

### Stage 2 — Cross-cutting services

Everything a credential-issuing operation needs exists, tested, before the first operation: audit, idempotency, settings and reasons, the authoritative limiter, hash admission, metrics and the **durable delivery path**. Ends at **Gate 2** (S0.19).

#### S0.11 — Audit writer

| | |
|---|---|
| **Needs**| S0.10 |
| **Run**| B D |
| **Operations**| none |
| **Criteria**| none |

**Builds on.** `platform/logging/redaction.ts` (redaction of log lines); nothing writes an audit row today.
**Newly builds.** `audit_event` and the `AuditWriter` adapter: append-only (`GBT-T1`), enhanced writes fail closed (`GBT-T10`), stable event ids and a canonical serialisation version, the object-type catalogue and the hub-boundary event, and the **committed-failure shape** authentication bookkeeping needs: a failed sign-in commits its counter and its `auth.session.failed` event, then answers the error outside the transaction ([audit.md](../../contracts/audit.md) §2.1, §5.4).
**Files.** a new migration, `platform/audit/*`, registry row, `contracts/audit.md` only if the catalogue differs.
**Evidence.** DB tests: an `UPDATE` or `DELETE` of an audit row is refused for every login; an enhanced write that cannot be stored aborts the act; redaction removes a planted secret (Family U sentinel). *Fixture/platform verified*.
**Obligations carried.** Signed checkpoints, independent storage and monitoring are release gate **G1** and are not built here.
**Does not.** Write any event of a later operation.
**Stop if.** The canonical serialisation cannot be made byte-stable across Node versions.

#### S0.12 — Idempotency and replay store

| | |
|---|---|
| **Needs**| S0.10, S0.3 |
| **Run**| B D |
| **Operations**| none |
| **Criteria**| none |

**Newly builds.** `idempotency_record` and the `IdempotencyStore`: principal- and operation-bound keys, fingerprint conflict (`IDEMPOTENCY_KEY_CONFLICT`), an in-progress marker, byte-stable business replay; the **one bounded exception** of [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §14.16 for `registerRiderDevice` (an encrypted secret replayed under a time-limited exception with a 24-hour tombstone and expiry on read); version and ETag helpers. Family I.
**Files.** `platform/idempotency/*`, a new migration, the registry row, and tests.
**Evidence.** DB tests: same key and body replays the stored response; same key and a changed body conflicts; another principal's key never collides; a replayed secret expires on read. *Fixture/platform verified*.
**Does not.** Apply the exception to any other operation, or cache a business response beyond its record.
**Stop if.** A second operation appears to need the exception (it is a contract change).

#### S0.13 — Settings reader and reason validator

| | |
|---|---|
| **Needs**| S0.9, S0.10 |
| **Run**| B D |
| **Operations**| none |
| **Criteria**| none |

**Newly builds.** A typed `Settings` reader over `setting` (a missing key is `SETTING_MISSING`, never a borrowed default, [settings.md](../../contracts/settings.md)); the **reason validator**: `REASON_REQUIRED` when empty, `REASON_NOT_ACTIVE` for an unknown, retired, foreign-domain or not-permitted-for-this-operation code, from the closed `permitted_operations` attribute, a branch-qualified entry (`operationId#BRANCH`) matching only the branch the use case passes, which it derives from recorded state under the identity lock and never from the client. Family O5.
**Files.** `platform/settings/*` and tests.
**Evidence.** DB tests per refusal; a reason of the wrong domain on each identity operation's list is refused, and a branch-qualified reason on the other branch is `REASON_NOT_ACTIVE`. *Fixture/platform verified*.
**Does not.** Build `upsertReasonDefinition` or any reason-management operation (a later slice); the identity domains are system-managed.
**Stop if.** A setting the slice reads has no approved value.

#### S0.14 — PostgreSQL-authoritative rate limiter

| | |
|---|---|
| **Needs**| S0.13, S0.5, S0.3, S0.6 |
| **Run**| B D |
| **Operations**| none |
| **Criteria**| none |

**Newly builds.** The `RateLimitAdmission` table (one row per admitted request, keyed by a digest, `DELETE` of expired rows only) and the `RateLimiter` over the **six canonical buckets** of [settings.md](../../contracts/settings.md) §7.7 and no seventh: a rolling 60-second window, per-key decisions serialised on database time, keyed digests under the limiter key with key-rotation overlap, bounded capacity that never evicts a live penalty, a request refused before it is counted when it should not count, **fail closed on a store outage**. It runs in its own short transaction and takes none of the policy locks. An in-memory adapter exists for unit tests only and production refuses it.
**Files.** `platform/limiter/*`, a new migration, the registry row, `.env.example` and tests.
**Evidence.** Two-process tests on one database (neither double-admits); an outage test asserting the refusal; a rotation test. *Fixture/platform verified*.
**Obligations carried.** Shared limiter at the deployed topology and trusted-proxy behaviour: release gate **G2**. The bucket launch values are those of [settings.md](../../contracts/settings.md) §7.7 and are not invented here; the limiter's own capacity bounds are development-qualified here.
**Does not.** Key on a source address (there is no IP bucket).
**Stop if.** Serialising decisions per key costs more than the benchmark of S0.65 allows.

#### S0.15 — Metrics registry

| | |
|---|---|
| **Needs**| S0.1, S0.2 |
| **Run**| B |
| **Operations**| none |
| **Criteria**| none |

**Newly builds.** The `Metrics` adapter with **bounded labels** (an outcome class, never an identifier, address or token) and a test that fails when a label value is unbounded; the counters the specification names, for example `credential_recovery_requests_excluded_total{outcome}` ([OBSERVABILITY_AND_RECOVERY.md](../../architecture/OBSERVABILITY_AND_RECOVERY.md) §3). The private endpoint that serves them is S0.68.
**Files.** `platform/metrics/*` and tests.
**Evidence.** Unit tests on label cardinality and redaction. *Fixture/platform verified*.
**Obligations carried.** **OB-35, from the S0.1 review (9 October 2026):** the `Metrics` port raises `LABEL_UNBOUNDED` in development and test only, to fail a test on a programming defect. This task must define, implement and test what production does with a sample whose label value is outside its bounded set, record the choice in this block and report it in its handoff for the Product Owner. It must not leave production behaviour implicit.
**Does not.** Expose metrics publicly.
**Stop if.** A required metric needs an identifier as a label.

#### S0.16 — Bounded hash admission

| | |
|---|---|
| **Needs**| S0.14, S0.3, S0.15 |
| **Run**| B D |
| **Operations**| none |
| **Criteria**| none |

**Newly builds.** `HashAdmission`: admission before any identity-dependent work, a bounded number of concurrent password hashes, and when full an immediate `429 RATE_LIMITED` **without verifying and without incrementing a counter**; a test-only workload fixture. The slot count is a development-qualified engineering value chosen and recorded here; deployed capacity is S0.65's proposal.
**Files.** `platform/limiter/hash-admission*` and tests.
**Evidence.** Saturation test: the refused request does no hash and writes no counter; admitted work completes. *Fixture/platform verified*.
**Does not.** Add dummy hashing to a rate-limited or admission-refused request (a locked request still does one, S0.32).
**Stop if.** Admission limits starve legitimate sign-in at the benchmark's expected load.

#### S0.17 — Durable credential delivery: schema, enqueue, state machine

| | |
|---|---|
| **Needs**| S0.11, S0.5, S0.3 |
| **Run**| B D |
| **Operations**| none |
| **Criteria**| none |

**Newly builds.** `credential_delivery_job` ([state-machines.md](../../contracts/state-machines.md) §22: `QUEUED`, `LEASED`, `ACCEPTED`, `RETRYABLE`, `FAILED`, `EXPIRED`, `CANCELLED`); lease owner and version fencing; a stable delivery identity (the dedupe id) that every attempt of the job reuses, so a retry is the same message to the provider; an **encrypted minimal payload** bound to its row by authenticated data; enqueue inside the caller's transaction beside the hash-only redemption record; cancellation and invalidation; the capability and registry rows ([SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.9a).
**Files.** `platform/delivery/*`, a new migration, the registry row, and tests.
**Evidence.** DB tests against a stand-in redemption record (a test table, because the real `setup_grant` and `recovery_request` arrive in S0.29 and S0.50; the `PENDING` check of the state machine runs against it): an enqueue rolls back with its transaction; a job's state never changes the redemption record; a fenced-out claimant cannot finish a job. *Fixture/platform verified*.
**Does not.** Call a provider, or write a `RecoveryRequest` or `SetupGrant` (S0.29, S0.50).
**Stop if.** The redemption record would need to hold the destination.

#### S0.18 — Delivery worker process

| | |
|---|---|
| **Needs**| S0.17, S0.15, S0.6 |
| **Run**| B D L |
| **Operations**| none |
| **Criteria**| none |

**Newly builds.** A separate worker process: claim with a lease in a short transaction, release the connection, re-read cancellation and expiry, call `DeliveryProvider` with no transaction open, and record the outcome in another short transaction as *accepted*, *rejected* or **unknown**. **An unknown outcome is a normal case, not a stop**: a timeout or a lost acknowledgement may mean the provider accepted the message ([SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.9a), so the job is retried with the **same link and the same stable delivery identity**, or reconciled where the provider offers a status query, on the bounded schedule cut off at the redemption record's expiry. Lease ownership and version **fence** a stale worker from overwriting a later outcome; a send already in flight after a cancellation is dead because redemption rejects it; diagnostics are redacted (no token, destination or message body). Exactly-once delivery is **not** promised, and a fresh credential is **never** generated merely because an acknowledgement was lost. Shutdown stops claiming and relinquishes leases within the budget; the **capture adapter** (a sink outside the repository, restricted, never inside `package:source`) is the default in Local and Staging; ciphertext is erased after acceptance, or at terminal expiry or cancellation; the `DESTINATION_NOT_ALLOWED` outcome class serves the controlled real-provider window ([DEPLOYMENT_AND_ENVIRONMENTS.md](../../architecture/DEPLOYMENT_AND_ENVIRONMENTS.md) §4.1).
**Files.** `platform/delivery/worker/*`, a worker entry point beside `main.ts`, `apps/api/package.json`, `.env.example`, [DEVELOPMENT.md](../../DEVELOPMENT.md), and tests.
**Evidence.** Crash-after-commit, lease-expiry, duplicate-claim and timeout-then-late-acceptance tests, and **the accepted-but-unacknowledged send** (the provider keeps the message, the acknowledgement is lost): the retry carries the same link and delivery identity, nothing new is issued, and a second delivery is tolerated because redemption is single-use; stale-worker fencing; cancellation before and after the send; redacted diagnostics (a planted token never appears in a log line or an error); no connection held during a send; a terminal failure is counted by a metric (the alerts and their rehearsal are S0.68). A real `SIGTERM` stop **needs Linux, WSL2 or CI** (skipped on Windows).
**Obligations carried.** `L`: the shutdown test on Linux. The real-provider window and credentials are release gate **G3**; no provider is contacted here.
**Does not.** Contact a real provider, or hold a transaction across a send.
**Stop if.** The worker cannot give the guarantees above — fencing, same-link retry under a stable delivery identity, cancellation checks, redacted diagnostics — with the pinned PostgreSQL and the provider port. Ordinary provider ambiguity is not a stop: it is the case this design is for.

#### S0.19 — Retention cleanup (Gate 2)

| | |
|---|---|
| **Needs**| S0.18, S0.12, S0.16 |
| **Run**| B D |
| **Operations**| none |
| **Criteria**| none |

**Newly builds.** A durable cleanup task for replay ciphertext, expired and terminal jobs and tombstones, under its own capability.
**Files.** `platform/delivery/retention/*` and tests.
**Evidence.** DB tests: only expired material is removed; a live row survives; the task is idempotent. **Gate 2 exit:** S0.11 to S0.19 green under `pnpm run test:db`, and the worker's real `SIGTERM` shutdown test run on Linux, WSL2 or CI. That Linux evidence is **new** and, by the Product Owner's decision of 9 October 2026 (§10 row 13), **required at this gate with no waiver**: until it is run Gate 2 is **pending**, not passed. **Retention cleanup is mandatory and comes first:** S0.29, the first task that builds grant-issuing code, needs this task, so the bootstrap seed (S0.30), the MFA continuation grants (S0.31), S0.36 and every later issuing task cannot be accepted without it.
**Does not.** Delete an audit row.
**Stop if.** Retention periods are unset in [settings.md](../../contracts/settings.md).

### Stage 3 — Request pipeline, browsers, sessions and authorization

The refusal order of [permission-enforcement.md](../../features/identity/permission-enforcement.md) §5 is built once, proved on a **fixture operation**, and only then do real operations arrive: transport admission, rate limit, authentication, CSRF and Origin, surface, permission, tier, scope, validation, idempotency, version, state, then maker-checker. Ends at **Gate 3** (S0.27, the exit check of the stage). S0.28 is independent owner evidence, not the gate.

#### S0.20 — Transport admission

| | |
|---|---|
| **Needs**| S0.2, S0.6, S0.14, S0.16 |
| **Run**| B D |
| **Operations**| none |
| **Criteria**| none |

**Builds on.** S0.6's execution-budget mechanism ([§11.8](#118-deadline-ownership-and-the-execution-budget)). `createApp` (the Nest body parser is off; JSON only), `platform/http/json-body.ts` (`requireUtf8Json` answers `415` for a non-UTF-8 charset, the `__proto__` reviver, a byte-count recorder), `not-found-fallback.ts` and `all-exceptions.filter.ts`. There is **no** size limit, no compression refusal, no header or body deadline and no trusted-proxy setting today.
**Newly builds.** The admission layer **before** routing and guards: JSON only, compressed bodies rejected, byte limits including chunked bodies, header and body deadlines (receipt limits that end a slow sender and do not bound a handler's execution; [DEPLOYMENT_AND_ENVIRONMENTS.md](../../architecture/DEPLOYMENT_AND_ENVIRONMENTS.md) §12.5, "Deadlines"), admission concurrency, bounded extraction of the identifier a limiter needs, a parse failure carried as a marker to the validation stage (a malformed body is `VALIDATION_FAILED`, not an early reply), and code-less `413` and `415` ([SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §14.8). S0.20 owns the HTTP receipt limits and admission; it also **integrates S0.6's execution-budget mechanism into the request pipeline**, so that a request has a budget from admission to answer, and the database timeouts are not the only bound on it.
**Files.** `create-app.ts`, `platform/http/admission/*`, `platform/config/*` and tests.
**Evidence.** Real-HTTP tests (not mocks) for each refusal, including a slow-header client and a chunked body over the limit; and, for the budget, a real-HTTP request whose handler outlasts its budget, with the answer, the rollback and the absence of any late side effect asserted on a second connection. *Fixture/platform verified*.
**Obligations carried.** Edge and trusted-proxy behaviour: release gate **G2**. **OB-37** for the pipeline half.
**Does not.** Authenticate or authorize.
**Stop if.** Rejecting inflate changes a client the Ops Portal build already uses.

#### S0.21 — HTTP primitives and the description composition

| | |
|---|---|
| **Needs**| S0.1, S0.10 |
| **Run**| B |
| **Operations**| none |
| **Criteria**| none |

**Builds on.** `http/error-codes.ts` (**three** of the contract's 121 codes; the platform answers only 400, 403, 404, 415 and 500 and never 401, 409, 422, 429 or 503), `api-exception.ts`, `platform/openapi/build-openapi-document.ts` (OpenAPI 3.1, one server, **no security scheme**), `ContractValidator`, `platform/contract/cookies.ts` (parses and checks cookies; **nothing writes one**), `declareAnswerPrincipal` for `x-set-cookies-when`, and the `contract:check` drift check (the B0.6 carried-forward items that the identity slice must supply).
**Newly builds.** `ErrorCode` extended to the contract's full set with statuses; `ApiException` declared headers; a **cookie writer** that sets `Max-Age=0` literally on expiry; the security schemes registered in `buildOpenApiDocument`, `browserSession` and `csrfToken` AND-composed, `x-set-cookies`, `x-set-cookies-for` and `-when`, and operation `servers` for the dedicated Rider host ([BOOTSTRAP_B0_RUNBOOK.md](BOOTSTRAP_B0_RUNBOOK.md#carried-forward-from-b06)). Proven on the **fixture contract**, not on a real operation.
**Files.** `platform/http/*`, `platform/openapi/build-openapi-document.ts`, `platform/auth/cookies/*` (the writer) and tests.
**Evidence.** Conformance tests that must fail for security drift, cookie drift and server drift when the description omits them. *Fixture/platform verified*.
**Does not.** Add an operation to `IMPLEMENTED_OPERATIONS`.
**Stop if.** `@nestjs/swagger` cannot state a required composition (supply an explicit schema, as the carried-forward notes say).

#### S0.22 — Access declarations and the guard chain

| | |
|---|---|
| **Needs**| S0.20, S0.21, S0.11, S0.12, S0.14, S0.16 |
| **Run**| B D |
| **Operations**| none |
| **Criteria**| none |

**Builds on.** `routes/access-declaration.ts` (`AccessDeclaration` is `'technical'` only), the global `DenyByDefaultGuard` (anything not `technical` is `403`), `route-inventory.ts` (`assertRoutesAreSound` runs at start and fails on an undeclared, outside-Nest or unserved route), and `deny-by-default.test.ts` and `route-inventory.test.ts`, which pin "exactly the two probes" ([apps/api/CLAUDE.md](../../apps/api/CLAUDE.md): "the first slice adds the permission declaration and updates `route-inventory.test.ts`"). The interceptor of the contract validator runs **after** guards.
**Newly builds.** The four declarations (technical, anonymous, self, permission); the **rate-limit guard real**, the later slots (authentication, CSRF, authorization) failing closed until their tasks; the route inventory rebuilt. A route with no declaration still stops the API at start.
**Files.** `platform/routes/*` and its tests, `route-inventory.test.ts`.
**Evidence.** The inventory test enumerates every live route; a fixture route without a declaration is refused; a fixture anonymous route reaches the limiter first. AC-25 and AC-43 are *fixture/platform verified* here.
**Does not.** Authenticate; the slots after the limiter refuse by default.
**Stop if.** A bootstrap route cannot be reached without an anonymous declaration the contract does not give it.

#### S0.23 — Trusted HTTPS harness

| | |
|---|---|
| **Needs**| S0.2, S0.20 |
| **Run**| B W E |
| **Operations**| none |
| **Criteria**| none |

**Builds on.** `e2e/`: managed processes, the disposable database, an outbound TCP guard, a browser guard that reaches the Ops origin only, one worker and **one Chromium project**, with the Ops `vite preview` on plain `http://127.0.0.1` proxying `/api/v1` to the API. `test:browser` runs the Ops shell and components in three engines, also over plain HTTP. There is no certificate tooling, and `repository-shape.test.ts` forbids a tracked key or certificate store. The contract's cookies are `Secure`, which the decisions ([SLICE-000-FINAL-DECISIONS.md](SLICE-000-FINAL-DECISIONS.md)) say a plain-HTTP origin cannot test in every engine.
**Newly builds.** A time-boxed **spike first** (approved on 9 October 2026, [§11.5](#115-test-ca-and-browser-trust)): how each engine trusts the test CA in a **disposable test environment or an isolated browser profile or context**, with real certificate validation and a negative test that an untrusted CA fails, recording per engine which mechanism works and what it proves. The approval is for that isolated mechanism only and **authorizes no persistent machine-wide trust change**. [SLICE-000-FINAL-DECISIONS.md](SLICE-000-FINAL-DECISIONS.md) allows "trusted by the test browser/OS as appropriate", but a machine trust-store change is a stop condition here, so an engine that cannot be done without one needs the owner's ruling before the rest (§10). Then one browser-facing **HTTPS** origin serving the Ops Portal and proxying `/api/v1`; a locally generated test CA **kept outside the repository** and trusted by the browser, never `ignoreHTTPSErrors`; Chromium, Firefox and WebKit plus a branded Chrome and Edge smoke; trace, video and screenshots **off** for any step that shows a secret; an unavailable engine is reported **blocked**, never green ([e2e/CLAUDE.md](../../e2e/CLAUDE.md)).
**Evidence.** The harness's own tests; `pnpm run test:e2e` on the developer's browsers. The engine matrix actually run is recorded in the handoff.
**Obligations carried.** **W**: engines not installed locally are run in CI (S0.46). `GBT-W9` (CSP, `frame-ancestors`, `nosniff`, a restrictive referrer policy and HSTS) is asserted on this test origin; the deployed edge is release gate G2. Cookie evidence for AC-127 needs this origin. A change to the integrated CI job goes into `ci.yml`, `REQUIRED_COMMANDS` and the aggregate together.
**Files.** `e2e/playwright.config.ts`, `e2e/harness/*`, `.github/workflows/ci.yml`, `scripts/ci-workflow.ts`, [DEVELOPMENT.md](../../DEVELOPMENT.md), `e2e/CLAUDE.md` (the sentence on engines).
**Does not.** Change the bootstrap journey; S0.45 retires it.
**Stop if.** A supported engine cannot trust the test CA without a machine trust-store change (surface it with the spike's result; do not make one).

#### S0.24 — Sessions and the authentication guard

| | |
|---|---|
| **Needs**| S0.22, S0.3, S0.7, S0.8 |
| **Run**| B D |
| **Operations**| none |
| **Criteria**| none |

**Newly builds.** A minimal `staff_identity` (with the immutable `origin`) and `session` (`bundle_id`, `bundle_revision`, and `policy_revision` for Vendor and Rider); cookie and bearer lookup by hash; absolute and idle expiry judged **after** the locks on one fresh database time; activity coalescing; ambiguous credentials (a cookie and a bearer together) refused; the invalidation primitives by principal and by bundle; and the **session-issue protocol** of [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.10a on the S0.7 toolkit (discover, plan the shared bundle key and, for Vendor and Rider, the fixed key, lock, revalidate, restart within one deadline). A staff persona factory for tests.
**Files.** `platform/auth/sessions/*`; and, as the first use of the `staff` domain folder (an existing permission domain, not a new one), `src/staff/*` for the minimal `staff_identity` table and the staff `IdentityDirectory` adapter; a new migration for `staff_identity` and `session`, the registry rows, and tests.
**Evidence.** DB tests under the runtime login: a session records the locked bundle's content and revision; an identity reassigned between discovery and lock revalidates and restarts, and nothing was written before the revalidation passed (§13.10a 11); an expired session is refused on fresh time. *Fixture/platform verified*.
**Obligations carried.** §13.10a 2 (issue against a reduction, both orders) is exercised in S0.27; the fixed-policy half in S0.63.
**Obligations carried (Family E).** `GBT-E5`: the `authentication` capability reads no business table and its port offers by-key lookups and no scan: **D, not run**.
**Does not.** Build a sign-in operation (S0.32) or the authorization guard (S0.26).
**Stop if.** An idle-expiry rule needs a value [settings.md](../../contracts/settings.md) leaves unset.

#### S0.25 — CSRF, Origin and Fetch Metadata

| | |
|---|---|
| **Needs**| S0.24, S0.11, S0.23 |
| **Run**| B D W E |
| **Operations**| none |
| **Criteria**| none |

**Newly builds.** Browser and native credential modes; the exact allow-listed `Origin` on every browser pre-session mutation (a missing, `null` or unlisted `Origin` is `403` `CSRF_VALIDATION_FAILED`); exact-origin CORS; the rider bearer path excluded; `auth.csrf.rejected` written without a principal that does not exist. Family W.
**Files.** `platform/auth/csrf/*`, `platform/http/*`, `platform/config/*` (the origin allow-list), an `e2e/tests/` spec, and tests.
**Evidence.** Real-HTTP tests for each refusal; the 16 tests of Family W that apply; one browser spec in the supported engines (S0.23). *Fixture/platform verified*.
**Obligations carried.** **W**: browser-origin and cookie evidence is completed by S0.46.
**Does not.** Issue a cookie (S0.32).
**Stop if.** The Ops origin cannot be told apart from the Vendor origin in configuration.

#### S0.26 — Authorization

| | |
|---|---|
| **Needs**| S0.25, S0.9, S0.4, S0.7 |
| **Run**| B D |
| **Operations**| none |
| **Criteria**| none |

**Builds on.** `readiness.registry.ts` (reasons for `/readyz`), `SecurityContext` and the row-level policies from S0.4.
**Newly builds.** The bundle snapshot read once under the locks; grant scope intersected with the session's reach; tiers read from authoritative grant metadata; the surface gate; the staff-only scope probe that tells `HUB_SCOPE_VIOLATION` from `NOT_FOUND`; the permission guard and `x-permission` emission; the lock order against revocation; and the **fixed-policy request check** for Vendor and Rider — an instance below `minimum_revision` or older than the session's `policy_revision` answers the operational `503` and ends no session, and `/readyz` reports `policy_superseded` ([SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.10). A **fixture operation** proves the whole refusal order.
**Files.** `platform/authorization/*`, `platform/health/readiness.registry.ts`, `platform/routes/*` and tests.
**Evidence.** AC-26, AC-29 and AC-44 *fixture/platform verified*; the order of AC-130 on the fixture; Families B and GS. The fixed-policy check is unit- and DB-tested with fixture sessions; the two-build proof needs real Vendor and Rider sessions (S0.63).
**Obligations carried.** §13.10a 13: **D, not run**, owed by S0.63.
**Does not.** Add a real operation.
**Stop if.** A refusal needs to reveal more than the existence rule of [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §4 allows.

#### S0.27 — The bundle-change primitive and its races (Gate 3)

| | |
|---|---|
| **Needs**| S0.24, S0.26, S0.11 |
| **Run**| B D |
| **Operations**| none |
| **Criteria**| none |

**Newly builds.** The one primitive that the seed, a migration and SLICE-009's future edit all call ([SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.10a). **This task decides and records whether it is a SQL function (callable from a migration) or an application function run by a provisioning command**, and moves S0.9's seed onto it (until now the seed takes the exclusive key itself). It runs as one transaction: exclusive lock on the bundle key, read the current revision, write content and revision, and on a **reduction** also raise `reduction_floor` and end every `ACTIVE` session recorded below it with `AUTHORITY_CHANGED` and one `auth.session.authority_revoked` each, **in the same transaction**; an addition raises the revision and ends nothing; a name-only change raises nothing. The matching compiled-policy floor raise for `FixedPermissionPolicy`. It runs as the seed or migration login, because the runtime role cannot write these tables.
**Files.** `platform/authorization/policy-change/*`, the seed helper of S0.9, a migration if it is SQL, and tests.
**Evidence (real PostgreSQL, the runtime login for sign-in and mutation, the elevated login for the change).** `GBT-B12` (a reduction racing a sign-in and racing a state-changing request, both orders, no deadlock, a lock-timeout leaves nothing half applied), `GBT-B13` (an addition retains snapshots, a later reduction ends every session below its floor including those issued after the addition), §13.10a 2, 3, 4, 5 and 6. AC-05 *fixture/platform verified*. **Gate 3 exit:** S0.20 to S0.27 are green under `test:db` and `test:browser`; S0.27 reaches each of them through its Needs. S0.28 is independent owner evidence that S0.43 needs and is no part of this gate.
**Obligations carried.** §13.10a 8 and 10 (randomised interleavings, starvation on the pinned PostgreSQL): S0.64. The edit **operation** and its two criteria are owed to SLICE-009 ([IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md) §4c).
**Does not.** Add an operation that edits a bundle.
**Stop if.** A reduction cannot be told from an addition for a change of scope or tier, or one primitive cannot serve both a migration and the seed.

#### S0.28 — Accessibility baseline evidence (independent owner evidence)

| | |
|---|---|
| **Needs**| none (run in parallel) |
| **Run**| M |
| **Operations**| none |
| **Criteria**| none |

**Owner evidence, no code.** Keyboard-only, screen-reader, Windows forced-colours and Safari or Edge and previous-major checks on the **existing** shell and UI foundation, closing the runbook's accessibility item (B-05 item 8) and giving the interim baseline the Ops screens are accepted against ([SLICE-000.md](../slices/SLICE-000.md) §6).
**Files.** none in the repository; the owner's note is recorded in the runbook's evidence item 8 ([BOOTSTRAP_B0_RUNBOOK.md](BOOTSTRAP_B0_RUNBOOK.md#evidence-still-owed-audit-b-05)).
**Evidence.** A signed note from the owner with browsers, versions, assistive technologies and findings. **This is independent owner evidence, not a gate:** it can be produced at any time, certifies nothing about S0.20 to S0.27 (Gate 3 is S0.27's exit) and has one dependant, S0.43, which needs it.
**Does not.** Change the shell.
**Stop if.** A blocking defect is found in the foundation; it becomes its own task.

### Stage 4 — Staff identity through the API

The first real routes. Each operation task adds its `operationId` to `IMPLEMENTED_OPERATIONS` and binds its handler with `@ContractOperation` in the same change, and `pnpm run contract:check` must pass. Sign-in, setup, recovery and session operations live in `src/platform/auth/`; an administration operation lives in the domain that owns the first segment of its permission key ([SOLUTION_ARCHITECTURE.md](../../architecture/SOLUTION_ARCHITECTURE.md) §5). Ends at **Gate 4** (S0.37).

#### S0.29 — Setup grants and MFA factors

| | |
|---|---|
| **Needs**| S0.27, S0.19, S0.17, S0.3 |
| **Run**| B D |
| **Operations**| none |
| **Criteria**| none |

**Newly builds.** `setup_grant` (the eight purposes, one `PENDING` per purpose and principal) and `mfa_factor` (one `ACTIVE` per identity), with the **lineage columns** in two classes. **Immutable after insert:** the grant's `episode_id`, `supersedes_grant_id` and `continued_from_grant_id`, and a factor's `staff_identity_id`, `created_by_purpose` and `created_episode_id` (no `UPDATE` privilege, and a trigger refuses a change by any login), with composite principal foreign keys. **Assigned once, later:** a factor's `revocation_episode_id`, whose one legal write is null to a reset episode of the same identity, in the statement that sets `status` to `REVOKED` and `revoked_by`, inside `resetStaffMfa`'s transaction; the runtime login holds `UPDATE` only on the columns a factor's life changes, never table-wide, and the API never uses a migration or provisioning credential; a `BEFORE UPDATE` trigger refuses overwriting, clearing and any other write, and a constraint trigger deferred to commit requires a `SetupGrant` of that principal and episode ([domain-model.md](../../contracts/domain-model.md) §6.8); atomic consume on fresh database time; enqueue to the delivery path of S0.17; only a `PENDING` grant ever becomes `SUPERSEDED` ([domain-model.md](../../contracts/domain-model.md) §6.8, [state-machines.md](../../contracts/state-machines.md) §18, §19).
**Files.** a new migration (`setup_grant`, `mfa_factor`), `platform/auth/setup-grants/*`, `platform/auth/mfa/*`, the registry rows, and tests.
**Evidence.** `GBT-B14`, constraint half, under the runtime login: a lineage reference to another principal's grant is refused by the constraint; no `UPDATE` privilege exists on grant lineage, `created_episode_id`, `created_by_purpose`, `staff_identity_id` or `origin`, and a change by any login is refused; **the valid reset write (`revocation_episode_id` null to the episode, with the revocation) succeeds, and each illegal write is refused** — overwrite, clear, a value without an administrative revocation, another principal's episode, a table-wide `UPDATE`; two grants of one episode keep their lineage. *Fixture/platform verified*.
**Obligations carried.** `GBT-B14`: the behaviour half is S0.37 (**D, not run**).
**Does not.** Issue a grant to a person (S0.30, S0.36). **It needs S0.19:** the cleanup that bounds what issuance stores exists before any grant is issued, so the bootstrap seed (S0.30), the `MFA_ENROLMENT` continuation grants (S0.31) and every later issuing task inherit it.
**Stop if.** The lineage cannot be expressed with composite keys without a table the registry does not list.

#### S0.30 — Bootstrap seed and resume command

| | |
|---|---|
| **Needs**| S0.29, S0.9 |
| **Run**| B D L |
| **Operations**| none |
| **Criteria**| none |

**Newly builds.** The bootstrap seed ([MIGRATION_AND_SEEDING.md](../../architecture/MIGRATION_AND_SEEDING.md) §3.2): **exactly two** identities of `origin = BOOTSTRAP`, each with its own work email and an explicit all-hub grant, `created_by` and `approved_by` the reserved system actor, the enhanced `staff.identity.created` and `approved` events, created in one transaction; the two custody bundles written outside any source or archive root with exclusive creation, on POSIX with restrictive mode, on Windows with an access-control-list inspection that refuses broad or inherited access, two distinct custodian identifiers, never printed, an orphan bundle removed on the next run; and the **resume command** of §3.3a (run by the provisioning identity, refuses once the identity holds an `ACTIVE` factor or is not a bootstrap identity, no API operation or screen can invoke it).
**Files.** `tools/bootstrap/*` (the seed and the resume command), `apps/api/package.json`, `src/staff/*` for the identity rows, [MIGRATION_AND_SEEDING.md](../../architecture/MIGRATION_AND_SEEDING.md) only if it differs, and tests.
**Evidence.** Seeding on a non-empty table refuses; an interrupted run leaves no pair, or a pair with its bundles; the custody file is checked on the platform it ran on (the ACL check on Windows, the mode check on Linux); the sentinel secret never appears in output, logs or `package:source`.
**Obligations carried.** `GBT-E8` (the `bootstrap` capability inserts only the bootstrap shape and refuses a non-empty staff table): **D, not run**. **L**: the POSIX mode inspection runs on Linux or CI (the repository's existing mode-bit test is skipped on Windows). The two designated custodians are an owner input ([SLICE-000.md](../slices/SLICE-000.md) §6.1).
**Does not.** Complete setup (S0.31) or create a third privileged identity.
**Stop if.** The two custodians collapse to one canonical email.

#### S0.31 — Staff credential setup and MFA enrolment operations

| | |
|---|---|
| **Needs**| S0.30 |
| **Run**| B D |
| **Operations**| `completeStaffCredentialSetup`, `completeMfaEnrolment`, `beginMfaReenrolment` |
| **Criteria**| 25, 43, 88, 92, 93 |

**Builds on.** The first-route obligations of the B0.6 notes: `IMPLEMENTED_OPERATIONS` is empty, and these pins say so and are edited here, on purpose: `route-inventory.test.ts` ("exactly the two probes"), `openapi.test.ts` (`paths` is `{}`), `contract-check.process.test.ts` (it matches "0 operations in the implemented scope"). `createApp` already sends `Cache-Control: no-store` on every answer; the contract also declares it on the responses that carry a secret and the validator checks it.
**Newly builds.** The three routes in `platform/auth/`: the password established under the one credential rule (`VALIDATION_FAILED` names the field, never the value); the bootstrap secret consumed at password establishment with the `MFA_ENROLMENT` continuation grant returned **in the same transaction**; `BOOTSTRAP_SETUP` refused at `completeMfaEnrolment` (`SETUP_GRANT_INVALID`); `beginMfaReenrolment` returning a new seed (the declared `no-store` is checked, not assumed); all three in the recovery bucket, keyed by the presented grant.
**Files.** `platform/auth/staff/*` (controllers and services), `tools/contract/implemented-scope.ts`, the three pinned tests named above, and tests.
**Evidence.** Real-operation tests of AC-25, 43, 88 (two completions of one grant have one winner), 92 and 93 and the drift check; the response headers and the declared status and error pairs of each operation. Updates `route-inventory.test.ts`, `openapi.test.ts`, `contract-check.process.test.ts`, `implemented-scope.ts` and `apps/api/CLAUDE.md`.
**Obligations carried.** `W`: the screens come in S0.43.
**Does not.** Sign in, or issue a session.
**Stop if.** The continuation cannot be returned atomically with the consumption.

#### S0.32 — `staffSignIn`

| | |
|---|---|
| **Needs**| S0.31, S0.16, S0.14 |
| **Run**| B D |
| **Operations**| `staffSignIn` |
| **Criteria**| 1, 4, 77, 78, 81 |

**Newly builds.** The `MfaChallenge` table and the credential columns of the failed-attempt count and `locked_until` (a new migration); canonical email; the limiter, then hash admission, then **one Argon2id per password branch** (including an unknown identity and a locked one); the atomic lockout on database time with the counter **committed before the refusal is answered**; the `202` `MfaChallenge` for a privileged identity whether or not a factor exists, with no cookie; the `200` session and cookies for a non-privileged one; `auth.session.failed` with the factor reached and one precise cause.
**Files.** `platform/auth/staff/*`, a new migration (`MfaChallenge`, credential columns), the registry row, and tests.
**Evidence.** A **work-shape** trace comparing outwardly equivalent failure branches (unknown email, wrong password, suspended, pending, locked) in status, body and statement shape; the five wrong passwords lock and nobody is told; a rate-limited request is neither verified nor counted (AC-81).
**Obligations carried.** Timing distributions are a diagnostic, not proof; the capacity numbers wait for S0.65.
**Does not.** Complete a second factor (S0.33).
**Stop if.** A branch cannot do the same order of work without an unbounded dummy.

#### S0.33 — `completeStaffMfaSignIn`

| | |
|---|---|
| **Needs**| S0.32 |
| **Run**| B D |
| **Operations**| `completeStaffMfaSignIn` |
| **Criteria**| 2, 3, 32, 79, 80, 91, 94, 123, 126 |

**Newly builds.** The five-minute single-use challenge; three attempts then `CHALLENGE_UNUSABLE`; TOTP at plus or minus one step, each step single-use; the shared failure counter; a lock announced **only after the password is proven**; `MFA_ENROLMENT_REQUIRED` with its own audit cause and no counter; the session issued by the S0.24 protocol.
**Files.** `platform/auth/staff/*` and tests.
**Evidence.** AC-02/03/32/79/80/91/94/123/126; a replayed code and a code two steps away are `MFA_PROOF_INVALID`; no session exists for a privileged identity before the factor is proven (rows 2, 3 and 5 of the demonstration).
**Does not.** Read the clock from anything but the injected UTC wall clock.
**Stop if.** The challenge lifetime or the attempt count conflicts with [settings.md](../../contracts/settings.md).

#### S0.34 — `getCurrentSession` and `signOut`

| | |
|---|---|
| **Needs**| S0.33 |
| **Run**| B D |
| **Operations**| `getCurrentSession`, `signOut` |
| **Criteria**| 82, 83, 84 |

**Newly builds.** `getCurrentSession` returning the closed **`CurrentSession`** projection (a `SessionRecord` plus the display fields `principal_display_name` and `authorized_hubs`, both present) with the permission keys the session holds and no token or bundle contents; `signOut` ending the session `SIGNED_OUT` with the cookies expired by a literal `Max-Age=0`; idle expiry at request time; `auth.csrf.rejected` on a cookie write with no token.
**Files.** `platform/auth/session/*` and tests.
**Evidence.** AC-82, 83 and 84 on the real routes; AC-35's idle expiry of a privileged browser session (its rider clause is S0.59); response validation fails when either display field is missing; a second `signOut` is `401`.
**Obligations carried.** These are `self` operations: they hold no permission, so they cannot return `403 PERMISSION_DENIED`. AC-44 and AC-29 therefore complete at S0.35 and S0.37, where the first permission-gated operations exist, and AC-26 at S0.48, where a vendor session exists.
**Does not.** Show a hub count (capacity measurement is owed, S0.65).
**Stop if.** The display fields need data the session does not hold.

#### S0.35 — Staff reads and the reason catalogue read

| | |
|---|---|
| **Needs**| S0.34, S0.26 |
| **Run**| B D |
| **Operations**| `listAssignableStaffRoleBundles`, `listStaffIdentities`, `getStaffIdentity`, `listReasonDefinitions` |
| **Criteria**| 7, 30, 44, 128 |

**Newly builds.** In `src/permission/` and `src/staff/` (domains of the first key segments, no new domain): the assignable-bundle list; the staff list and read with the `ETag` that `If-Match` operations take; the scope probe in use (an existing record in another hub is `HUB_SCOPE_VIOLATION`, one that does not exist is `NOT_FOUND`); one `auth.hub_boundary.crossed` per read of a foreign record and one bounded event per foreign hub a list represents. The fourth read, `listReasonDefinitions` (in `src/settings/`, permission `settings.reason.read`; the 38th operation, [§11.1](#111-listreasondefinitions-as-the-38th-slice-000-operation)), with its `domain`, `checkpoint`, `operation` and `branch` filters: a `branch` without an `operation`, or a value outside an enumeration, is `VALIDATION_FAILED`; results are ordered by `code`; `permittedOperations` is read from the registry. Authorization reads the session's immutable permission snapshot under the lock protocol: an Ops caller needs the key with a non-empty hub reach, a Rider's scope stays assignment-based and is false while no stop or run exists (`PERMISSION_DENIED`), and a Vendor does not hold the key. The task also builds the **one eligibility function** that derives `StaffIdentity.mfa_reset_state` from the recorded factor, grant and identity rows ([state-machines.md](../../contracts/state-machines.md) §18); every `StaffIdentity` response carries it, and S0.37's `resetStaffMfa` calls the same function.
**Files.** `src/permission/*`, `src/staff/*`, `src/settings/*` (the reason read), the reset-readiness function in `platform/auth/mfa/*`, and tests.
**Evidence.** AC-07, 30 and 128; every clause of **AC-132** on the real operation except its Rider-session clause, which completes at S0.59 (the filters and their `VALIDATION_FAILED`, the ordering, `permittedOperations` and `null` for other domains, `PERMISSION_DENIED` for a Vendor, `SESSION_INVALID` without a session, and `mfa_reset_state` for each of its categories, including every `NOT_ELIGIBLE` one); **AC-44** (no session is `401 SESSION_INVALID`, a held session without the key is `403 PERMISSION_DENIED`, a missing session never `403`); the permission-gate half of AC-26; a missing key is `PERMISSION_DENIED`; a version moves on a change and never on a failed sign-in.
**Does not.** Return a credential, a hash, a factor or a failed-attempt count, or write the reason catalogue (`upsertReasonDefinition` is SLICE-013's, [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md) §4c).
**Stop if.** A read would return a field the contract marks secret, the scope probe would answer a list differently from a single read, or the reset-readiness state is not derivable from recorded rows.

#### S0.36 — Create, approve and re-issue

| | |
|---|---|
| **Needs**| S0.35, S0.29, S0.12, S0.18, S0.27, S0.19 |
| **Run**| B D |
| **Operations**| `createStaffIdentity`, `approveStaffIdentity`, `reissueStaffCredentialSetup` |
| **Criteria**| 6, 33, 85, 86, 89, 90, 116, 117, 118, 120, 122, 129 |

**Newly builds.** `createStaffIdentity` (always `origin = MAKER_CHECKER`, `PENDING_APPROVAL`, no credential supplied); `approveStaffIdentity` for approve and reject (approver not the maker, tier by bundle, reason code, the work email released on rejection); `reissueStaffCredentialSetup` (refused for a bootstrap identity and for one that already holds a credential); maker-checker last in the refusal order; the setup message **queued durably** (an unqueueable message rolls the act back with `CREDENTIAL_DELIVERY_FAILED`; a provider rejection after the commit is a job outcome); `WORK_EMAIL_IN_USE` on the canonical form. Every `StaffIdentity` these operations return carries `mfa_reset_state` from the S0.35 function (a new `PENDING_APPROVAL` identity is `NOT_ELIGIBLE`).
**Files.** `src/staff/*`, the delivery enqueue of S0.17, and tests.
**Evidence.** Each operation's own refusal-order test (AC-130 completes at S0.67); AC-116 (`createStaffIdentity` is refused `PERMISSION_DENIED` for a holder of `permission.assignable_bundle.read` alone); AC-06 (the snapshot is read from a bundle S0.27 changes); AC-118 from a clean environment (one bootstrap administrator creates, the other approves); a re-issue kills the earlier grant and an identity that already holds a credential is refused (AC-89).
**Obligations carried.** Offboarding and bundle edits are SLICE-009's.
**Does not.** Accept a `status` field, or let a Senior Ops approve a privileged bundle.
**Stop if.** The first profile cannot be approved by the second administrator for lack of a hub grant.

#### S0.37 — Sessions administration and MFA reset (Gate 4)

| | |
|---|---|
| **Needs**| S0.36, S0.27 |
| **Run**| B D |
| **Operations**| `listSessions`, `revokeSession`, `resetStaffMfa` |
| **Criteria**| 29, 37, 119 |

**Newly builds.** `listSessions` and `revokeSession` (tiered by the **target** principal, the existence rule applied); `resetStaffMfa` in its three recorded states (an `ACTIVE` factor; a stranded `PENDING` factor with no usable grant; an unfinished reset), deciding eligibility with the S0.35 function and the reason's branch from the recorded state under the identity lock (a reason of the other branch is `REASON_NOT_ACTIVE`), refusing a self-reset (`SELF_APPROVAL_FORBIDDEN`), a non-privileged identity, an identity with no factor record and a bootstrap administrator outside the first state (`STATE_CONFLICT`); old grants superseded **only if `PENDING`**, sessions ended `MFA_RESET`, a new `MFA_REENROLMENT` grant queued to the verified work email only, `auth.mfa.reset` with state, episode, factor and grants.
**Files.** `src/staff/*` (an officer acting on another principal), the MFA-reset service in `platform/auth/mfa/*`, and tests.
**Evidence.** The first real-operation evidence of AC-05 (a bundle reduced through S0.27 ends the session `AUTHORITY_CHANGED` and the next request is `SESSION_INVALID`; AC-05 completes at S0.64, where its two-build and race clauses are proved); **AC-29** (authorization returns only its own codes, `INSUFFICIENT_AUTHORITY` from `revokeSession` beside `PERMISSION_DENIED`, `HUB_SCOPE_VIOLATION` and `NOT_FOUND`); AC-37, AC-119; `mfa_reset_state` and `resetStaffMfa` agreeing for every recorded state, and a reset submitted after the factor changed being `STATE_CONFLICT` or `REASON_NOT_ACTIVE` and never a success with the wrong reason (the race clause of AC-132); **`GBT-B14` behaviour half** on real PostgreSQL under the runtime login. **Gate 4:** S0.29 to S0.37 green under `test:db`.
**Obligations carried.** `GBT-B14`: **D, not run** until this task. §13.10a 12, last clause: a target revocation takes no policy lock for the target's sessions and neither blocks nor is blocked by a reduction beyond the session-row order; proved here and again in S0.64.
**Does not.** Create a factor or a session for the reset identity.
**Stop if.** An eligible state is not derivable from a recorded value.

### Stage 5 — Ops Portal, staff screens

The Ops Portal reaches the API only through the generated client, with no hand-written API type ([apps/ops-web/CLAUDE.md](../../apps/ops-web/CLAUDE.md), [packages/api-client/CLAUDE.md](../../packages/api-client/CLAUDE.md)). Eleven of the slice's 19 routes are built here (five before sign-in, six after); the recovery, vendor and rider routes follow their operations in Stages 6 and 7. Ends at **Gate 5** (S0.46).

#### S0.38 — Ops session foundation

| | |
|---|---|
| **Needs**| S0.34 |
| **Run**| B W E |
| **Operations**| none |
| **Criteria**| none |

**Builds on.** The Ops Portal shell and UI foundation (tokens, `Button`, `Link`, `Alert`, `Field`, `Input`, `LoadingIndicator`, `PageHeader`, `SkipLink`, the dev-only showcase and its guards), `createBrowserApiClient` with `unwrap` and `ApiError.endsSession`, `createQueryClient`'s `onSessionEnded` option and `endSession`, and the placeholder `/` route. **Today** no application code calls the client; `AppProviders` calls `createQueryClient` with no options and sits **outside** `RouterProvider`, so a session end cannot navigate; route loaders cannot reach the client (the router is built before the providers), so a page fetches for itself; the client generates no `Idempotency-Key` or `If-Match`.
**Newly builds.** A session provider; a **bounded client response abstraction** that keeps the status, the `ETag` and the declared error details; wiring `onSessionEnded` to a router navigation; route guards (a missing session goes to sign-in, a missing key to the forbidden state); `/` becomes the landing; the generation of the `Idempotency-Key` for a command and its reuse when an outcome is unknown.
**Files.** `apps/ops-web/src/**`, `test/no-duplicate-wire-types.test.ts` (it pins the exact files that may import the browser client), [apps/ops-web/CLAUDE.md](../../apps/ops-web/CLAUDE.md), and the tests that pin the placeholder: `App.test.tsx` (the "shell only" text, no navigation, no fetch, no storage), `shell.spec.ts` (no request under `/api`, no storage, focus on the heading), `journey.spec.ts` (heading on `/`) and `components.spec.ts` (the showcase frame).
**Evidence.** Component and route tests; the pinned `/` tests are edited here and nowhere else. *Fixture/platform verified*.
**Does not.** Hold a token or a credential in script-readable storage (the session is an `HttpOnly` cookie).
**Stop if.** The generated client cannot expose the response metadata without being edited by hand.

#### S0.39 — Forms and transient-secret hygiene

| | |
|---|---|
| **Needs**| S0.38 |
| **Run**| B W |
| **Operations**| none |
| **Criteria**| none |

**Subtasks.** The parent is done when every subtask is, and keeps the parent's operations, criteria and gate; a subtask's fixture proof never completes a parent criterion. The parent's *Needs* apply to every subtask; *Also needs* adds to them.

| Subtask| Delivers| Also needs| Run| Evidence it reaches|
|---|---|---|---|---|
| S0.39a| Label, help and error relations, first-invalid focus, pending state, duplicate-submit prevention, `PasswordInput` and `CodeInput`| none| B W| fixture/platform verified|
| S0.39b| The one-time secret display and transient-credential hygiene (a sentinel absent from every cache, storage and trace)| S0.39a| B W| fixture/platform verified|
| S0.39c| **Local QR primitive (Product decision, 9 October 2026, [§11.2](#112-the-local-qr-primitive-before-staff-enrolment)): a reviewed, exactly pinned encoder, CSP-safe SVG, and an independent test-only decoder. Reused by S0.60.** The payload is a transient credential: no remote QR service, analytics, persistence or navigable `otpauth` link| S0.39b| B W| fixture/platform verified|

**Builds on.** `Field` and `Input` (label, help, error, required) and `Button` (loading, no submit while loading).
**Newly builds.** Label, help and error relations; focus on the first invalid field; a pending state that prevents a duplicate submit; `PasswordInput` and `CodeInput` (unbuilt today); a **one-time secret display** (TOTP seed and the enrolment material). A secret never enters a query cache, local or session storage, a log or analytics; it is cleared on navigation, completion and expiry.
**Files.** `apps/ops-web/src/components/ui/*` and `apps/ops-web/src/showcase/*` with their tests.
**Evidence.** Component tests with a planted sentinel asserted absent from every cache and storage; keyboard and focus tests in jsdom; and, for each new interactive component, the showcase browser pass (keyboard, 320 px, 200% text, forced colours, reduced motion, axe WCAG 2.2) that [apps/ops-web/CLAUDE.md](../../apps/ops-web/CLAUDE.md) requires, in the engines `test:browser` runs. *Fixture/platform verified*.
**Does not.** Echo a value in a validation message.
**Stop if.** A component needs a dependency the project has not approved.

#### S0.40 — Table and read states

| | |
|---|---|
| **Needs**| S0.38 |
| **Run**| B W |
| **Operations**| none |
| **Criteria**| none |

**Builds on.** `Alert` (danger and success only), `LoadingIndicator`, `PageHeader`. `Table`, `EmptyState`, `StatusBadge`, `ForbiddenState` and `Skeleton` are unbuilt.
**Newly builds.** The table, the empty state that tells *none* from *filtered to nothing*, the status badge and the forbidden state that names the permission and never a role; the nine states of [COMPONENT_PATTERNS.md](../../design/COMPONENT_PATTERNS.md) applied per real screen or marked inapplicable in the screen's test.
**Files.** `apps/ops-web/src/components/ui/*` and `apps/ops-web/src/showcase/*` with their tests.
**Evidence.** Component tests and an accessibility check per state, plus the showcase browser pass for each new component. *Fixture/platform verified*.
**Does not.** Show a hidden control as security (hidden is not enforcement).
**Stop if.** A state in the pattern library conflicts with the screen text in [ops-portal.md](../../surfaces/ops-portal.md).

#### S0.41 — Confirmation and reason workflow

| | |
|---|---|
| **Needs**| S0.39, S0.40, S0.35 |
| **Run**| B W |
| **Operations**| none |
| **Criteria**| none |

**Builds on.** Nothing: `Dialog`, `AlertDialog` and `Select` are unbuilt, the reason catalogue's reader, `listReasonDefinitions` with `settings.reason.read`, is the 38th operation and is built in S0.35 ([§11.1](#111-listreasondefinitions-as-the-38th-slice-000-operation); [ops-portal.md](../../surfaces/ops-portal.md) makes the reason mandatory on the reset and session screens), and [packages/api-client/CLAUDE.md](../../packages/api-client/CLAUDE.md) says the client generates no `Idempotency-Key` or `If-Match` ("the slice that sends the command does").
**Newly builds.** An accessible confirmation dialog (the primitive is chosen deliberately and recorded), the reason select over `listReasonDefinitions` (the `operation` and `branch` filters; the branch a screen passes comes from the action it is on or from `StaffIdentity.mfa_reset_state`, never from `mfa_enrolled`, and the server revalidates at submit), and retention of the `Idempotency-Key` (from S0.38) and the `If-Match` version across a retry.
**Files.** `apps/ops-web/src/**`, `packages/api-client/CLAUDE.md` (the line on what the client does not do).
**Evidence.** Focus trap, escape, return-focus and screen-reader name tests, the showcase browser pass; a retry keeps its key. *Fixture/platform verified*.
**Does not.** Invent a reason code or hard-code a second catalogue.
**Stop if.** The reason select cannot be filled from `listReasonDefinitions`, or the dialog primitive is a new dependency.

#### S0.42 — Authenticated shell and navigation

| | |
|---|---|
| **Needs**| S0.38 |
| **Run**| B W |
| **Operations**| none |
| **Criteria**| none |

**Builds on.** `PrimaryNavigation`, which renders nothing for an empty list and is **not mounted** anywhere; the frame has no menu or session data.
**Newly builds.** `AuthenticatedOpsShell` and navigation built from the permission keys the session holds and the routes that are implemented: an unbuilt route has no entry, and a route a key does not allow has none either.
**Files.** `apps/ops-web/src/components/*`, `apps/ops-web/src/app/*` and their tests.
**Evidence.** Navigation tests per bundle. *Fixture/platform verified*.
**Does not.** Link to a screen that does not exist.
**Stop if.** Navigation would need a role name.

#### S0.43 — The five pre-sign-in screens

| | |
|---|---|
| **Needs**| S0.39, S0.42, S0.31, S0.32, S0.33, S0.34, S0.28 |
| **Run**| B W |
| **Operations**| none |
| **Criteria**| none |

**Subtasks.** The parent is done when every subtask is, and keeps the parent's operations, criteria and gate; a subtask's fixture proof never completes a parent criterion. The parent's *Needs* apply to every subtask; *Also needs* adds to them.

| Subtask| Delivers| Also needs| Run| Evidence it reaches|
|---|---|---|---|---|
| S0.43a| `/sign-in` and `/sign-in/mfa`| none| B W| fixture/platform verified|
| S0.43b| `/setup/credential`| none| B W| fixture/platform verified|
| S0.43c| `/setup/mfa` (the S0.39c QR and the secret for manual entry) and `/setup/mfa/complete`| S0.39c| B W| fixture/platform verified|

**Newly builds.** `/setup/mfa` shows the QR from the S0.39c primitive ([§11.2](#112-the-local-qr-primitive-before-staff-enrolment)) **and** the secret for manual entry, which stays as the accessible alternative; both are transient credentials, never persisted, never sent to a remote service or analytics, and never offered as a navigable `otpauth` link. `/sign-in`, `/sign-in/mfa`, `/setup/credential`, `/setup/mfa` and `/setup/mfa/complete`; the grant token is read **once** from the URL fragment and cleared; no application shell on a grant page; one error for an unknown, expired, consumed or superseded grant; copy chosen by operation, context and code ([ops-portal.md](../../surfaces/ops-portal.md)).
**Files.** `apps/ops-web/src/pages/*` (or the folder the Ops code already uses for routes), `apps/ops-web/src/app/routes.tsx`, and tests.
**Evidence.** Screen tests per state and a fragment test; the owner's accessibility note (S0.28) is the baseline.
**Obligations carried.** `GBT-W16` (the grant read once from the fragment, the history entry replaced, nothing in a request, referrer, storage, log or analytics) is run in the engines at S0.46: **E, not run**.
**Does not.** Offer an account-existence hint.
**Stop if.** The interim accessibility baseline is not filed.

#### S0.44 — The six signed-in screens

| | |
|---|---|
| **Needs**| S0.40, S0.41, S0.42, S0.35, S0.36, S0.37 |
| **Run**| B W |
| **Operations**| none |
| **Criteria**| none |

**Subtasks.** The parent is done when every subtask is, and keeps the parent's operations, criteria and gate; a subtask's fixture proof never completes a parent criterion. The parent's *Needs* apply to every subtask; *Also needs* adds to them.

| Subtask| Delivers| Also needs| Run| Evidence it reaches|
|---|---|---|---|---|
| S0.44a| `/` and `/admin/staff` (with the approver queue)| none| B W| fixture/platform verified|
| S0.44b| `/admin/staff/new` and `/admin/staff/{id}`| S0.44a| B W| fixture/platform verified|
| S0.44c| `/admin/staff/{id}/mfa/reset` and `/admin/sessions`| S0.44a| B W| fixture/platform verified|

**Newly builds.** `/`, `/admin/staff` (with the approver queue), `/admin/staff/new` (bundle chosen from the assignable list), `/admin/staff/{id}` (the `ETag` the actions take), `/admin/staff/{id}/mfa/reset` (a mandatory reason from `listReasonDefinitions` for the branch `mfa_reset_state` names, the action hidden for `NOT_ELIGIBLE`; the grant never displayed) and `/admin/sessions`.
**Files.** `apps/ops-web/src/pages/*`, `apps/ops-web/src/app/routes.tsx`, and tests.
**Evidence.** Screen tests per state, including the stale-version and forbidden states; the reset screen has no field that could show a grant.
**Does not.** Offer staff offboarding or a bundle edit (SLICE-009).
**Stop if.** A screen needs an operation that is not among the 38, or the reason select of S0.41 has no source.

#### S0.45 — Harness extension over HTTPS

| | |
|---|---|
| **Needs**| S0.23, S0.43, S0.44 |
| **Run**| B E |
| **Operations**| none |
| **Criteria**| none |

**Builds on.** The harness as it is: managed processes, the disposable database, the outbound TCP guard (the only "capture" that exists today is its blocked-connection log), the browser guard, `freezeBrowserClock`, failure artifacts.
**Newly builds.** Seeded bootstrap identities for a run, a TOTP helper, the **message capture reader** over S0.18's sink, aged-row helpers; the **technical journey is retired**: the three `/api/v1/e2e/*` routes in `apps/api/test/support/e2e-main.mjs`, the `e2e_harness.notes` table that `HARNESS_SCHEMA_SQL` creates in `e2e/harness/database.ts` (it is not a migration and has no row-level security) and the specs that use them, `journey.spec.ts` and `sandbox.spec.ts` ([e2e/CLAUDE.md](../../e2e/CLAUDE.md): the first slice replaces them).
**Files.** `e2e/harness/*`, `e2e/tests/*`, `apps/api/test/support/e2e-main.mjs`, `e2e/playwright.config.ts`, [e2e/CLAUDE.md](../../e2e/CLAUDE.md).
**Evidence.** The harness's own tests; `pnpm run test:e2e` runs the first real journey.
**Does not.** Add retries or weaken an assertion.
**Stop if.** A run leaves a database it did not create (`db:orphans`).

#### S0.46 — Staff journeys (Gate 5)

| | |
|---|---|
| **Needs**| S0.45 |
| **Run**| B E M |
| **Operations**| none |
| **Criteria**| 115 |

**Newly builds.** The journeys of the demonstration rows 1 to 6, 12, 13 (staff) and 14 in the supported engines, from the two bootstrap administrators through a first profile created by one and approved by the other; the Ops half of the AC-127 cookie evidence on the trusted HTTPS origin; AC-115.
**Files.** `e2e/tests/*`, `e2e/playwright.config.ts`.
**Evidence.** `pnpm run test:e2e` in Chromium, Firefox and WebKit with the branded smoke; traces off on secret-bearing steps. **Gate 5:** the journeys green in CI as well as locally.
**Obligations carried.** **W**: any engine not run is recorded as blocked, never as passed.
**Stop if.** A journey passes only with a manual database edit (the demonstration forbids it).

### Stage 6 — Vendor and credential recovery

The Vendor PWA does not exist: the vendor operations are built and verified **at API level**, and the vendor clauses of AC-15 and AC-18 stay *client/manual pending* until that client does ([SLICE-000.md](../slices/SLICE-000.md) §5). Recovery is eligibility-first ([credential-recovery.md](../../features/identity/credential-recovery.md) §5.7). Ends at **Gate 6** (S0.52).

#### S0.47 — Vendor fixture, reads, setup grant and setup

| | |
|---|---|
| **Needs**| S0.36, S0.29 |
| **Run**| B D |
| **Operations**| `listVendorAccounts`, `getVendorAccount`, `reissueVendorCredentialSetup`, `completeVendorCredentialSetup` |
| **Criteria**| 42, 101 |

**Subtasks.** The parent is done when every subtask is, and keeps the parent's operations, criteria and gate; a subtask's fixture proof never completes a parent criterion. The parent's *Needs* apply to every subtask; *Also needs* adds to them.

| Subtask| Delivers| Also needs| Run| Evidence it reaches|
|---|---|---|---|---|
| S0.47a| The vendor tables, the non-production fixture and `listVendorAccounts`, `getVendorAccount`| none| B D| real-operation verified for the reads|
| S0.47b| `reissueVendorCredentialSetup` and `completeVendorCredentialSetup`| S0.47a| B D| completes the parent criteria|

**Newly builds.** A minimal `vendor_organization` (with its lifecycle `status`, which the recovery guard of S0.50 reads), `vendor_account`, the credential columns and the vendor part of `registered_device`; the **non-production vendor fixture** of [MIGRATION_AND_SEEDING.md](../../architecture/MIGRATION_AND_SEEDING.md) §4b (refused in production; no secret, no browser, no grant); the two reads, narrowed by the organisation's responsible hub; the re-issue (Senior Ops or Platform Admin, own hub; refused when a secret exists); the setup that stores the vendor's own secret and issues the device credential through a real `Set-Cookie`. In `src/vendor/`, the domain of the first key segment.
**Files.** `src/vendor/*`, `platform/auth/vendor/*`, a new migration (`VendorOrganization` minimal, `VendorAccount`, `VendorCredential`, the vendor part of `RegisteredDevice`), the fixture command in `tools/fixtures/*`, the registry rows, and tests.
**Evidence.** AC-42 and 101; the staff-side clauses of AC-102 (its Vendor and Rider session clauses complete at S0.59); the other-hub half of AC-102 uses a second hub and a vendor of that hub **as a test fixture** that the Staging seed does not carry; no response carries a hash, a secret or the recovery address.
**Does not.** Create or approve a vendor (SLICE-008).
**Stop if.** The responsible hub of the fixture organisation is unset.

#### S0.48 — `vendorSignIn`

| | |
|---|---|
| **Needs**| S0.47, S0.16, S0.37 |
| **Run**| B D |
| **Operations**| `vendorSignIn` |
| **Criteria**| 14, 18, 19, 26, 41, 95, 96, 98, 99, 127 |

**Newly builds.** The three factors (account identifier, secret, registered-browser credential); an unregistered browser neither signs in nor counts toward a lock; a new login ends the earlier one with `SUPERSEDED_BY_NEW_LOGIN`; the shared lockout; the edge ceiling keyed on account and device; the session issued with the S0.24 protocol, recording the fixed bundle's `bundle_revision` and the Vendor `policy_revision`; cookie lifetimes (`melarc_vendor_device` for 400 days, the session cookies with no `Max-Age`).
**Files.** `platform/auth/vendor/*`, `src/vendor/*`, and tests.
**Evidence.** **AC-26** (a vendor session calling an Ops-only operation is refused at the surface gate, a staff session without the key at the permission gate); AC-29, 35, 44 and 82 to 84 **re-verified for vendors**; AC-99 (a Platform Admin ends a vendor session with `listSessions` and `revokeSession`); the work-shape trace; the indistinguishable refusal of a wrong secret and a wrong browser; AC-127's vendor part at API level (`melarc_vendor_device` `Max-Age=34560000`, the session cookies with none; the Vendor PWA's browser clause is G5).
**Obligations carried.** Vendor PWA clauses of AC-15/18: **G5**. §13.10a 13 for Vendor: S0.63.
**Does not.** Issue a device credential at sign-in.
**Stop if.** Sign-in cannot tell a registered from an unregistered browser without an identifier the client types.

#### S0.49 — Vendor browsers

| | |
|---|---|
| **Needs**| S0.48 |
| **Run**| B D |
| **Operations**| `requestAdditionalDeviceGrant`, `completeAdditionalDeviceEnrolment`, `listVendorDevices`, `revokeVendorDevice` |
| **Criteria**| 45, 100 |

**Subtasks.** The parent is done when every subtask is, and keeps the parent's operations, criteria and gate; a subtask's fixture proof never completes a parent criterion. The parent's *Needs* apply to every subtask; *Also needs* adds to them.

| Subtask| Delivers| Also needs| Run| Evidence it reaches|
|---|---|---|---|---|
| S0.49a| `requestAdditionalDeviceGrant` and `completeAdditionalDeviceEnrolment`| none| B D| real-operation verified|
| S0.49b| `listVendorDevices` and `revokeVendorDevice`| S0.49a| B D| completes the parent criteria|

**Newly builds.** The additional-browser grant keyed on the **authenticated vendor account** in `rate_limit_recovery` (and the authenticated API ceiling), queued durably (`202`); its completion; the vendor's own list; revocation of another browser but not the one in use, with the `If-Match` version.
**Files.** `platform/auth/vendor/devices/*` and tests.
**Evidence.** AC-45/100; the key of the limiter is the account, not a presented value.
**Does not.** Let a vendor register a browser without the grant.
**Stop if.** The browser in use cannot be identified server-side.

#### S0.50 — `requestCredentialRecovery`

| | |
|---|---|
| **Needs**| S0.47, S0.37, S0.18, S0.14 |
| **Run**| B D |
| **Operations**| `requestCredentialRecovery` |
| **Criteria**| 20, 21, 104, 107 |

**Newly builds.** `recovery_request`; the uniform `202` with **no provider call on the response path**; **eligibility** read under the identity lock (§5.7: `ACTIVE` or `SUSPENDED` with an established credential and a registered channel, and for a vendor a linked `VendorOrganization` that is also `ACTIVE` or `SUSPENDED` (Product decision of 9 October 2026, [§11.4](#114-vendor-organisation-lifecycle-eligibility)); a rejected, offboarded, pending, credential-less or terminated-organisation principal is answered as unknown). The vendor-organisation guard is built here and tested with a fixture whose organisation status the test kit changes through a second connection, which is **not** proof of a termination endpoint (`SLICE-008`); at most two live links per credential, never invalidating a usable one, a guard window of `recovery_request_supersede_guard_seconds`, every request counting toward `rate_limit_recovery`; exactly one `auth.recovery.requested` (`ISSUED` or `COALESCED`) for an eligible principal and none for an excluded one, counted by `credential_recovery_requests_excluded_total{outcome}`; a supplied destination rejected (`VALIDATION_FAILED`).
**Files.** `platform/auth/recovery/*`, a new migration (`recovery_request`), the registry row, and tests.
**Evidence.** AC-20, 21, 104 and 107, and the request half of AC-121 (it completes at S0.51); two requests arriving together yield at most two live links; the work-shape bound across branches; **`GBT-B15`, request half** (a request racing an offboarding, both orders) on real PostgreSQL under the runtime login.
**Obligations carried.** `GBT-B15`: **D, not run** until this task (request half) and S0.51 (completion half).
**Does not.** Store or label a raw identifier, token or destination.
**Stop if.** The uniform answer needs unbounded dummy work to hold.

#### S0.51 — Completing recovery, and administrator-initiated recovery

| | |
|---|---|
| **Needs**| S0.50, S0.48 |
| **Run**| B D |
| **Operations**| `completeCredentialRecovery`, `recoverStaffCredential`, `recoverVendorCredential` |
| **Criteria**| 17, 22, 24, 36, 87, 97, 103, 105, 106, 121 |

**Subtasks.** The parent is done when every subtask is, and keeps the parent's operations, criteria and gate; a subtask's fixture proof never completes a parent criterion. The parent's *Needs* apply to every subtask; *Also needs* adds to them.

| Subtask| Delivers| Also needs| Run| Evidence it reaches|
|---|---|---|---|---|
| S0.51a| `completeCredentialRecovery` judged under the identity lock, with the eligibility recheck| none| B D| real-operation verified|
| S0.51b| `recoverStaffCredential` and `recoverVendorCredential` (coalescing, ineligible target)| S0.51a| B D| completes the parent criteria|

**Newly builds.** The completion judged under the identity lock (a `PENDING`, unexpired request **and** an eligible identity, otherwise `RECOVERY_TOKEN_INVALID`); the credential replaced, **every session ended `CREDENTIAL_CHANGED`**, every outstanding link invalidated and its job cancelled, the lock cleared, the suspension left standing, the MFA factor untouched, and for a vendor the browser credential rotated; the two administrator operations (an ineligible target, a vendor account whose organisation is `REJECTED` or `TERMINATED` included, is `STATE_CONFLICT`; inside the guard or at the cap they return the existing request's non-secret metadata with `coalesced` true).
**Files.** `platform/auth/recovery/*`, `src/staff/*` and `src/vendor/*` for the administrator operations, and tests.
**Evidence.** AC-17/22/24/36/87/97/103/105/106 and **AC-121** (the administrator operations return the existing request's metadata, completion invalidates every outstanding link and cancels its job); **`GBT-B15`, completion half**: completion against an offboarding, against a suspension and against the termination of a vendor account's organisation, each order, the status change made through the test kit (no Slice-000 operation offboards or terminates); an expired, consumed, malformed, superseded and offboarded-identity link are one byte-identical answer.
**Obligations carried.** The offboarding transaction's own half is SLICE-009's and the vendor termination or rejection transaction's is SLICE-008's ([IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md) §4c); a fixture is proof of neither endpoint. Recovery reactivates nothing and restores no authority.
**Does not.** Create a session or reveal the new credential.
**Stop if.** A completion would need a lock outside the order of §13.10a.

#### S0.52 — Recovery and vendor screens (Gate 6)

| | |
|---|---|
| **Needs**| S0.51, S0.49, S0.44, S0.41, S0.45 |
| **Run**| B W E |
| **Operations**| none |
| **Criteria**| 15 |

**Subtasks.** The parent is done when every subtask is, and keeps the parent's operations, criteria and gate; a subtask's fixture proof never completes a parent criterion. The parent's *Needs* apply to every subtask; *Also needs* adds to them.

| Subtask| Delivers| Also needs| Run| Evidence it reaches|
|---|---|---|---|---|
| S0.52a| `/recovery` and `/recovery/complete`| none| B W E| fixture/platform verified|
| S0.52b| `/admin/vendors`, `/admin/vendors/{id}` and the recovery action on the staff detail| S0.52a| B W E| completes the parent criterion|

**Newly builds.** `/recovery`, `/recovery/complete`, `/admin/vendors`, `/admin/vendors/{id}` and the recovery action on the staff detail: the success state identical for a known and an unknown account, no destination field, one error for a bad link that does not re-open the form, the 12-to-128 rule stated, and a success message that says every session has ended.
**Files.** `apps/ops-web/src/pages/*`, `apps/ops-web/src/app/routes.tsx`, `e2e/tests/*`, and tests.
**Evidence.** Screen tests and the recovery journeys (rows 10a and 11) in the supported engines. **Gate 6:** S0.47 to S0.52 green under `test:db` and `test:e2e`.
**Obligations carried.** AC-15's Vendor PWA half: **G5**.
**Stop if.** A screen would reveal whether an account exists.

### Stage 7 — Rider and device attestation

The Rider Android app does not exist: the rider operations are verified **at API level against the substitute verifier and the capture adapter**; the real handset is owner evidence (S0.61). The attestation verifier is a separate, private JVM service, qualified before it is relied on ([SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §15.2). Ends at **Gate 7** (S0.60, the exit check of the stage). S0.61 is independent, deferred owner evidence, not the gate.

#### S0.53 — Rider fixture, roster and the registration operations

| | |
|---|---|
| **Needs**| S0.37, S0.12, S0.18, S0.51 |
| **Run**| B D |
| **Operations**| `listRiders`, `getRider`, `registerRiderDevice`, `reregisterRiderDevice` |
| **Criteria**| 23, 108, 113, 114 |

**Subtasks.** The parent is done when every subtask is, and keeps the parent's operations, criteria and gate; a subtask's fixture proof never completes a parent criterion. The parent's *Needs* apply to every subtask; *Also needs* adds to them.

| Subtask| Delivers| Also needs| Run| Evidence it reaches|
|---|---|---|---|---|
| S0.53a| The rider tables, the non-production fixture and `listRiders`, `getRider`| none| B D| real-operation verified for the reads|
| S0.53b| `registerRiderDevice` with the sealed-replay exception| S0.53a| B D| real-operation verified|
| S0.53c| `reregisterRiderDevice` with its reason and verification note| S0.53b| B D| completes the parent criteria|

**Newly builds.** The minimal `RiderIdentity` table, the rider part of `RegisteredDevice` and the **non-production rider fixture** ([MIGRATION_AND_SEEDING.md](../../architecture/MIGRATION_AND_SEEDING.md) §4a: at least two `ACTIVE` riders, no PIN, no device, refused in production); the roster and detail reads (readiness only); `registerRiderDevice` returning the **versioned enrolment URI** (127-character payload, 43-character token and challenge) under the sealed-replay exception of S0.12 and refused for a rider who has an `ACTIVE` or a revoked device (`STATE_CONFLICT`); `reregisterRiderDevice` with a reason code and a verification note, taking the `ETag`. Placement follows the first key segment (`dispatch.read`, `staff.device.*`).
**Files.** `src/staff/*` (rider identity and device operations), `src/dispatch/*` (the two reads), a new migration, `tools/fixtures/*`, the registry rows, and tests.
**Evidence.** AC-23/108/113/114; same key and body replays the original grant, a changed body is `IDEMPOTENCY_KEY_CONFLICT`, a consumed or expired grant is `STATE_CONFLICT` with no secret; authority is re-checked before a replay.
**Does not.** Create a rider (SLICE-009) or accept a PIN.
**Stop if.** The owning domain folder of `listRiders` and `getRider` is not settled (a recorded finding).

#### S0.54 — Device-key protocol and the substitute verifier

| | |
|---|---|
| **Needs**| S0.3, S0.2, S0.53 |
| **Run**| B |
| **Operations**| none |
| **Criteria**| none |

**Newly builds.** The wire protocol of [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.6: ECDSA P-256 with SHA-256, the SPKI public key as canonical base64, a DER signature, a 32-byte base64url challenge, signed bytes `MELARC-RIDER-SIGNIN-V1\n` followed by the challenge; **published byte vectors** a Node test and the future Android client both verify; the `AttestationVerifier` port with the **substitute** adapter that yields each outcome repeatably and that production refuses to start with (AC-55).
**Files.** `platform/auth/device-key/*`, the byte vectors under `apps/api/test/vectors/`, and tests.
**Evidence.** Vector tests; the substitute yields every outcome class; a startup test refuses it in production.
**Does not.** Parse an attestation chain (S0.55).
**Stop if.** A vector disagrees between Node and the documented Android encoding.

#### S0.55 — The private JVM verifier service

| | |
|---|---|
| **Needs**| S0.54, S0.2 |
| **Run**| B J L |
| **Operations**| none |
| **Criteria**| none |

**Subtasks.** The parent is done when every subtask is, and keeps the parent's operations, criteria and gate; a subtask's fixture proof never completes a parent criterion. The parent's *Needs* apply to every subtask; *Also needs* adds to them.

| Subtask| Delivers| Also needs| Run| Evidence it reaches|
|---|---|---|---|---|
| S0.55a| Qualify the pinned `android/keyattestation` release against a real chain (including the extension nearest the root)| none| J| qualification record|
| S0.55b| The service: versioned request and response, bounded input, concurrency and deadline limits, restricted network, no database credential| S0.55a| B J| fixture/platform verified|
| S0.55c| The reproducible Gradle build on a pinned JDK, dependency verification, the local Windows and Linux start and stop scripts, the CI job and its `CLAUDE.md`| S0.55b| B J L| fixture/platform verified|
| S0.55d| Independently generated adversarial fixtures (wrong roots, revoked, malformed, duplicate extensions, limits)| S0.55b| J| fixture/platform verified|

**Newly builds.** A persistent service around the pinned `android/keyattestation` release (the release is qualified first, including which extension is read: the one nearest the root); a versioned request and response, bounded input, a concurrency and deadline limit, a restricted network and **no database credentials**; a reproducible Gradle build on a pinned JDK with dependency verification, a CI job, and local start and stop on Windows and Linux; its folder mapped from a new `CLAUDE.md` (root `CLAUDE.md` has 78 of its 90 lines by the guard's count, and every top-level folder must be mapped); **independently generated adversarial fixtures**. A new CI job goes into `ci.yml`, `REQUIRED_COMMANDS` in `scripts/ci-workflow.ts` and the aggregate's `needs` and command line.
**Files.** a new folder under `apps/` for the service (its name is settled in the task and mapped in the root `CLAUDE.md`), its own `CLAUDE.md`, `.github/workflows/ci.yml`, `scripts/ci-workflow.ts`, `scripts/workspace-pins.ts`, [DEVELOPMENT.md](../../DEVELOPMENT.md).
**Evidence.** The JVM tests (`J`), the CI job green, the service started and stopped from the repository's scripts. The verifier's own replay cache never replaces the database's single use.
**Obligations carried.** **J** and **L**: the JDK and the service need Linux or CI as well as Windows. Hardware-attestation trust roots are release inputs (G3).
**Does not.** Reach the API database or the public network beyond the revocation list.
**Stop if.** The pinned release cannot read a chain a real handset produces.

#### S0.56 — Trust data and policy

| | |
|---|---|
| **Needs**| S0.55, S0.15 |
| **Run**| B D J |
| **Operations**| none |
| **Criteria**| none |

**Newly builds.** Fixed trust sources with size, network and freshness limits; a last-known-good snapshot within the permitted age; package and signing-certificate allow-lists; debug signers refused in production; `TRUST_DATA_UNAVAILABLE` for stale data, no data yet or a verifier that cannot answer in time — distinct from `DEVICE_INTEGRITY_FAILED` and from an API outage; the production startup refusals (empty roots, empty digest set, missing package name, missing endpoint or caller authentication, an unset or too-long maximum age).
**Files.** the verifier folder, `platform/auth/attestation/*`, `platform/config/*`, `.env.example`, and tests.
**Evidence.** Startup-refusal tests (AC-55); freshness tests against a controllable clock; the trust-data alert raised at its two thresholds.
**Obligations carried.** The accepted roots, package name and first signing digest are release inputs (G3).
**Does not.** Relabel a verifier fault as a verdict.
**Stop if.** The maximum age and the refresh cadence conflict.

#### S0.57 — `completeRiderDeviceEnrolment`

| | |
|---|---|
| **Needs**| S0.53, S0.54, S0.56, S0.29, S0.17, S0.47, S0.49, S0.51 |
| **Run**| B D J |
| **Operations**| `completeRiderDeviceEnrolment` |
| **Criteria**| 13, 40, 55, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 75, 76, 125 |

**Subtasks.** The parent is done when every subtask is, and keeps the parent's operations, criteria and gate; a subtask's fixture proof never completes a parent criterion. The parent's *Needs* apply to every subtask; *Also needs* adds to them.

| Subtask| Delivers| Also needs| Run| Evidence it reaches|
|---|---|---|---|---|
| S0.57a| First enrolment: the verifier call outside the transaction, the evidence classes, the atomic change, the 503 outcome (AC-13, 40, 60 to 70, 75, 76)| none| B D J| real-operation verified for those criteria|
| S0.57b| Replacement and its refusals: old device `REPLACED`, session `DEVICE_REPLACED`, a refused replacement leaves the old device as it was (AC-71, 72)| S0.57a| B D J| real-operation verified for those criteria|
| S0.57c| The races (AC-73), the setup-bucket checks of AC-125 and the production-refusal assertions of AC-55| S0.57b| B D J| completes the parent criteria|

**Newly builds.** First enrolment and replacement: the verifier is called **outside** the transaction; then the transaction locks and re-reads the grant, its expiry, the actor's authority and the device state, and makes one atomic change (device registered or `REPLACED`, session ended `DEVICE_REPLACED`, grant consumed, PIN set privately, no session issued); the operation's own `servers` entry; the outcome classes `DEVICE_SECURITY_UNSUPPORTED`, `DEVICE_INTEGRITY_FAILED`, `SETUP_GRANT_INVALID` and `503` `TRUST_DATA_UNAVAILABLE` with `Retry-After`; a refused replacement leaves the old device exactly as it was; a race has one winner; a revoked device stays revoked.
**Files.** `platform/auth/rider/*`, `platform/auth/attestation/*`, and tests.
**Evidence.** AC-13, 40, 60 to 73, 75, 76 and 125. For **each evidence class** (wrong app, untrusted or revoked chain, different challenge, unlocked or unverified device, key that is not the attested one, signing-certificate rotation: AC-61 to 66, 69, 70) one test drives the API against the **real JVM service** with the independently generated fixtures of S0.55; the substitute covers only how the API handles each verdict, and is a mock (*fixture/platform verified*). **AC-55** completes here: every production startup refusal the criterion lists (each earlier task added its own) is asserted together, and the unreachable, overloaded or late verifier answers `503 TRUST_DATA_UNAVAILABLE` with nothing written and the grant not consumed. The replacement races run on real PostgreSQL. AC-125 needs S0.47, S0.49 and S0.51 to exist.
**Obligations carried.** AC-40's QR render is S0.60 and its handset clause S0.61; the Rider-app clauses are **G5**.
**Does not.** Hold a transaction across the verifier call.
**Stop if.** A signing-certificate rotation (AC-70) cannot be tested with two digests.

#### S0.58 — `revokeRiderDevice`

| | |
|---|---|
| **Needs**| S0.57 |
| **Run**| B D |
| **Operations**| `revokeRiderDevice` |
| **Criteria**| 74, 112, 124 |

**Newly builds.** Revocation with a reason code and no identity verification, hub-bounded (`HUB_SCOPE_VIOLATION` or `NOT_FOUND`), the live session ended `DEVICE_REVOKED` in the same transaction with no cache consulted; a revoked device stays revoked through a replacement.
**Files.** `src/staff/*` and tests.
**Evidence.** AC-74, 112 and 124; the stolen-handset row of the demonstration.
**Does not.** Set a rider's status (SLICE-009).
**Stop if.** A revocation can be reordered after a replacement without a lock.

#### S0.59 — Rider challenge and sign-in

| | |
|---|---|
| **Needs**| S0.58, S0.26, S0.34, S0.16 |
| **Run**| B D |
| **Operations**| `requestRiderSignInChallenge`, `riderSignIn` |
| **Criteria**| 8, 9, 10, 11, 35, 38, 39, 46, 47, 48, 49, 50, 51, 52, 53, 54, 56, 57, 58, 59, 102, 109, 110, 111, 132 |

**Subtasks.** The parent is done when every subtask is, and keeps the parent's operations, criteria and gate; a subtask's fixture proof never completes a parent criterion. The parent's *Needs* apply to every subtask; *Also needs* adds to them.

| Subtask| Delivers| Also needs| Run| Evidence it reaches|
|---|---|---|---|---|
| S0.59a| `requestRiderSignInChallenge` and the `RiderSignInChallenge` table: single use, short life, no enumeration (AC-39, 52, 53)| none| B D| fixture/platform verified|
| S0.59b| The signature check before the PIN, the six-digit PIN and its lockout (AC-8, 9, 38, 48 to 51, 109 to 111)| S0.59a| B D| fixture/platform verified|
| S0.59c| `riderSignIn` session issue, the root signal, the one-live-session rule (AC-10, 11, 35, 46, 47, 56 to 59, 102)| S0.59b| B D| real-operation verified for those criteria|
| S0.59d| AC-54 for `getCurrentSession` and `signOut` under stale trust data, with the residual recorded; and the Rider-session clause of AC-132 (`listReasonDefinitions` is `PERMISSION_DENIED` while no stop or run exists)| S0.59c| B D| completes the parent criteria|

**Newly builds.** The `RiderSignInChallenge` table; the challenge (single-use, short-lived) and the signature check **before** the PIN is examined (nothing is counted on a bad signature); the six-digit PIN and its lockout; the root signal recorded and never relaxing a check; the one-live-session rule with `REPLACED_BY_NEW_SESSION` and a plain `401` for the old handset; the session issued with the Rider fixed bundle and policy revision; AC-54 for `getCurrentSession` and `signOut` under stale trust data, with the residual recorded.
**Files.** `platform/auth/rider/*`, a new migration (`RiderSignInChallenge`), the registry row, and tests.
**Evidence.** The listed criteria (**AC-132** completes here, on its Rider-session clause), including **AC-35**'s rider clause (a rider session has no idle rule) and **AC-102**'s Vendor and Rider session clauses; AC-26/29/44/82-84 **re-verified for riders**; work-shape for the equivalent failure branches.
**Obligations carried.** `GBT-W7` (a Rider bearer request needs no CSRF token) and `GBT-W12` (a native Rider request with no `Origin` succeeds; a browser session cookie on a Rider-only operation is refused): **D, not run**. The Rider app's own clauses: **G5**. §13.10a 13 for Rider: S0.63.
**Does not.** Accept a PIN alone.
**Stop if.** A signature check cannot precede the PIN lookup.

#### S0.60 — The rider screens (Gate 7)

| | |
|---|---|
| **Needs**| S0.59, S0.52, S0.41 |
| **Run**| B W |
| **Operations**| none |
| **Criteria**| none |

**Subtasks.** The parent is done when every subtask is, and keeps the parent's operations, criteria and gate; a subtask's fixture proof never completes a parent criterion. The parent's *Needs* apply to every subtask; *Also needs* adds to them.

| Subtask| Delivers| Also needs| Run| Evidence it reaches|
|---|---|---|---|---|
| S0.60a| `/admin/riders` and `/admin/riders/{id}`| none| B W| fixture/platform verified|
| S0.60b| `/admin/riders/{id}/device/register` and `/admin/riders/{id}/device`, displaying the QR through the S0.39c primitive (`Textarea` for the verification note)| S0.60a| B W| fixture/platform verified|

**Builds on.** The S0.39c QR primitive and its independent decoder.
**Newly builds.** `Textarea` for the verification note of `reregisterRiderDevice`; `/admin/riders`, `/admin/riders/{id}`, `/admin/riders/{id}/device/register` and `/admin/riders/{id}/device`; the QR displayed through the S0.39c primitive, held in memory only and cleared on navigation, expiry and completion.
**Files.** `apps/ops-web/src/components/ui/*`, `apps/ops-web/src/pages/*`, `apps/ops-web/src/showcase/*`, and tests.
**Evidence.** The test decodes the rendered output back to the enrolment URI; a sentinel check shows no URI in storage or the query cache. *AC-40 render clause fixture/platform verified*. **Gate 7 exit:** S0.53 to S0.60 are green; the JVM verifier is qualified; the handset evidence of S0.61 is independent and not part of this gate.
**Does not.** Send the URI to any third party or log it.
**Stop if.** The S0.39c primitive cannot render the 127-character enrolment payload at a scannable size.

#### S0.61 — Real-device evidence (deferred evidence)

| | |
|---|---|
| **Needs**| S0.57, S0.60 |
| **Run**| M |
| **Operations**| none |
| **Criteria**| none |

**Owner and hardware evidence.** An internally signed APK on an eligible hardware-backed handset scans the QR and completes enrolment. A handset is a device, not a document.
**Files.** none in the repository; the walk is recorded in the acceptance record.
**Evidence.** A recorded walk with the handset model, the Android version and the result. **This is independent, deferred-permitted evidence, not a gate:** no task needs it; it blocks Rider enrolment rollout and not local acceptance ([SLICE-000-FINAL-DECISIONS.md](SLICE-000-FINAL-DECISIONS.md) §20), and until it exists S0.70 carries it as *deferred*, never as passed.
**Stop if.** No eligible handset is available (record it; do not substitute).

### Stage 8 — Close

Nothing here adds an operation. It proves the whole slice together, runs the concurrency and privilege obligations on the final schema, replaces provisional values with measurements, and accepts the slice locally. Ends at **Gate 8** (S0.70).

#### S0.62 — Browser journeys for rows 7 to 15

| | |
|---|---|
| **Needs**| S0.60, S0.46 |
| **Run**| B E |
| **Operations**| none |
| **Criteria**| none |

**Newly builds.** The Ops halves of demonstration rows 7 to 15 in the supported engines (rider registration with the QR decoded from the rendered output, device replacement, vendor setup and recovery as the officer sees them, exceptional recovery by three authorities, the lapsed grant, the shared vendor session cut); the Vendor and Rider halves drive the operations **at API level**.
**Files.** `e2e/tests/*`.
**Evidence.** `pnpm run test:e2e` green in each engine, CI included; a blocked engine is reported as blocked.
**Stop if.** A row can only be walked with a manual database edit.

#### S0.63 — Two-build fixed-policy proof

| | |
|---|---|
| **Needs**| S0.59, S0.48, S0.27 |
| **Run**| B D |
| **Operations**| none |
| **Criteria**| none |

**Newly builds.** The runtime proof of the fixed-policy rule ([SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.10, §13.10a obligation 13): **two real application builds with different compiled revisions and an actually different predicate** (a required key or an ownership predicate) against **one** database under the runtime login. Below the floor the older build refuses issuance and every authenticated request of that type with the operational `503`, writes nothing and leaves the session `ACTIVE`, and the current build then serves it; a session newer than the build is refused by that build with the same failure; an older session above the floor is served by the current build; a session below the floor is refused and terminated by the current build and by the reduction, never by the obsolete one; a bundle snapshot holding a key the older build does not know is denied on it; `/readyz` reports `policy_superseded`.
**Files.** `apps/api/test/database/*` and `src/test-support/*` (two builds against one database).
**Evidence.** The obligation's test, for Vendor and for Rider.
**Obligations carried.** This is the proof the specification says is **not yet run**.
**Does not.** Add a compatibility exception (none exists in Slice-000).
**Stop if.** Two builds cannot run against one database under the same login in the test kit.

#### S0.64 — Concurrency and privilege acceptance run

| | |
|---|---|
| **Needs**| S0.63, S0.37, S0.51, S0.49 |
| **Run**| B D |
| **Operations**| none |
| **Criteria**| 5 |

**Newly builds.** The combined run of [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.10a on the **final schema** with every real operation present, as the actual runtime login: obligation 8 (randomised interleavings of issue, mutation, reduction, revocation, sign-out and multi-principal operations complete without a deadlock), obligation 10 (a continuous stream of sign-ins does not starve a reduction within its deadline **on the pinned PostgreSQL version**), obligation 11 under load (bounded restarts, nothing written before revalidation), obligation 1 again (no `UPDATE` grant on the policy tables, `FOR SHARE` refused) and the Family A lock-leak check across the whole surface; plus `GBT-B12`, `B13`, `B14` and `B15` re-run together.
**Files.** `apps/api/test/database/concurrency/*`.
**Evidence.** **AC-05 completes here**: its two-build clause (S0.63), its race clauses and its lock-protocol clause are proved on the final schema. A recorded run with the PostgreSQL version, the machine and the seeds of the randomised runs.
**Obligations carried.** The deployed-topology load evidence is release gate **G2**.
**Stop if.** A deadlock is found; the lock order is a specification defect and goes to the owner.

#### S0.65 — Benchmark and capacity

| | |
|---|---|
| **Needs**| S0.59, S0.48, S0.32 |
| **Run**| B D |
| **Operations**| none |
| **Criteria**| none |

**Newly builds.** The integrated measurement of hashing, database contention, the limiter, the deadlines and NAT behaviour on a **recorded machine**. It calibrates the development-qualified values of S0.3, S0.6, S0.7, S0.14, S0.16, S0.18 and S0.20 (S0.2 only set provisional, configuration-validated defaults; the first consumer qualifies each, and the execution budget of [§11.8](#118-deadline-ownership-and-the-execution-budget) is among them) and proposes, for the owner's approval ([settings.md](../../contracts/settings.md) §9), the release-capacity values: the Argon2id parameters, hash-admission capacity, the edge ceiling, the transport capacity and the deadline values. It **depends on** those tasks and none of them waits for it. A measured engineering parameter is proposed here; an unresolved product decision (for example the value of the edge ceiling) is the owner's and is never invented. A hub count in the session display is measured here and not before.
**Files.** `apps/api/src/tools/benchmark/*` and a report under `delivery/planning/`.
**Evidence.** A report with the numbers and the machine; settings proposals, not settings changes.
**Obligations carried.** External authentication exposure waits for the approved values (**G2**).
**Stop if.** The measured cost exceeds what the specification allows a sign-in.

#### S0.66 — Security matrix and negative-access sweep

| | |
|---|---|
| **Needs**| S0.59, S0.60 |
| **Run**| B D |
| **Operations**| none |
| **Criteria**| none |

**Newly builds.** Negative-access tests at the five surfaces for every one of the 38 operations; the existence rule compared between a Vendor's or Rider's refusal and a nonexistent record's — status, `Error.code`, fixed message, body schema and security-relevant headers equal, after excluding only the per-response `request_id` and `Date` and checking that each response's request id is consistent within it; an exclusion is never widened to hide a difference; the Family U sentinel across every sink (logs, audit, traces, metrics, errors, `package:source`); the identity-row parts of Families C, D and L; the matrix status updated.
**Files.** tests across `apps/api/test/*` and `e2e/tests/*`, [security-test-matrix.md](../../standards/security-test-matrix.md) (status only).
**Evidence.** The matrix rows that now run, listed with their run codes; rows still owed are listed as owed.
**Stop if.** A refusal differs from the nonexistent answer in any compared field.

#### S0.67 — Contract sweep and the citation inventory

| | |
|---|---|
| **Needs**| S0.66, S0.62 |
| **Run**| B |
| **Operations**| none |
| **Criteria**| 130, 131 |

**Newly builds.** The sweep over all 38 operations (`contract:check` green, every declared code returned for its documented condition, no undeclared code returned); the inventory check that every one of the 126 criteria is cited by at least one test with no hidden skip, **registered in the explicit `test:root` list** (so `test-inventory.test.ts` finds it run by a runner; an inventory only, assertion quality is reviewed in each task's handoff); AC-130 (every operation refuses in one order: each task carried its own order test, and the sweep runs them together against all 38 operations, the `registerRiderDevice` replay clause and the native Rider request with no `Origin` included) and AC-131 (statuses).
**Files.** `scripts/slice-000-citations.ts` and its test, `package.json` (the explicit `test:root` list).
**Evidence.** The check fails when a citation is removed.
**Stop if.** A criterion is cited only by a skipped test.

#### S0.68 — Private metrics endpoint, alerts and rehearsal

| | |
|---|---|
| **Needs**| S0.56, S0.50, S0.18, S0.15 |
| **Run**| B D |
| **Operations**| none |
| **Criteria**| none |

**Newly builds.** The private metrics endpoint, the alerts (delivery backlog, terminal failure, expired leases, trust-data staleness at its two thresholds, provider failure) and their **rehearsal**: each alert fires on a deliberately failed credential message and on stale trust data ([OBSERVABILITY_AND_RECOVERY.md](../../architecture/OBSERVABILITY_AND_RECOVERY.md) §3).
**Files.** `platform/metrics/*`, the alert rules and the rehearsal record.
**Evidence.** A recorded rehearsal.
**Obligations carried.** Production alert routing: **G3**.
**Stop if.** An alert needs an identifier as a label.

#### S0.69 — Documentation sweep

| | |
|---|---|
| **Needs**| S0.67, S0.68, S0.64, S0.65 |
| **Run**| B |
| **Operations**| none |
| **Criteria**| none |

**Newly builds.** [DEVELOPMENT.md](../../DEVELOPMENT.md) (the new processes, the verifier, the HTTPS origin), the area `CLAUDE.md` files, the runbook's carried-forward notes, the matrix status, and the stale prose in [ops-portal.md](../../surfaces/ops-portal.md) (needs the owner's say-so). Counts in prose are derived or omitted.
**Files.** [DEVELOPMENT.md](../../DEVELOPMENT.md), the area `CLAUDE.md` files, the runbook, [security-test-matrix.md](../../standards/security-test-matrix.md).
**Evidence.** `test:root` (links, agent-docs) green.
**Stop if.** A document and the code disagree and neither is obviously right.

#### S0.70 — Local functional acceptance walk (Gate 8)

| | |
|---|---|
| **Needs**| S0.69, S0.66, S0.65, S0.64, S0.62 |
| **Run**| M E |
| **Operations**| none |
| **Criteria**| none |

**Owner evidence.** The Product Owner walks [SLICE-000.md](../slices/SLICE-000.md) §5 locally, rows 1, 2 and 12 from a clean environment, and the acceptance record is written. This is the precondition for, and **never a substitute for**, the Staging walk and the release gates of §7.2.
**Files.** the acceptance record under `delivery/planning/`.
**Deferred evidence carried, not passed.** Only evidence the owner has **explicitly** permitted to follow local acceptance is deferred, and it stays in the acceptance record as *deferred*, never as passed: S0.61, the hardware handset, before Rider enrolment rollout ([SLICE-000-FINAL-DECISIONS.md](SLICE-000-FINAL-DECISIONS.md) §20); release gates G1 to G5 and the Staging walk ([§20](SLICE-000-FINAL-DECISIONS.md), [SLICE-000.md](../slices/SLICE-000.md) §7 items 5 and 6); and the bootstrap waivers the runbook names — evidence items 4, 5, 6 and the Linux part of item 7, for the existing tests it lists, at their milestones. **Not deferred:** the Linux, WSL2 or CI runs of OB-24 to OB-26 are **required at the gates that name them** (Product decision of 9 October 2026, with no new waiver; §10 row 13), and every other piece of new evidence this plan creates stays **pending** until it is run. S0.70 is not complete while any is open. Everything else in the plan is mandatory, and the graph check of §4 shows each mandatory task reaches this one.
**Evidence.** The acceptance record, with every criterion in its evidence state, every open obligation named and every deferred item listed as deferred.
**Stop if.** A row cannot be walked.

## 6. Traceability

Generated from the task blocks and verified: each of the **38 operations** and each of the **126 criteria** appears **exactly once**, at the **parent** task where its real-operation evidence completes (a subtask's fixture proof never completes a parent criterion). Fixture-level and client or manual evidence are named in the blocks and in [§7](#7-deferred-obligations--what-is-owed-and-not-yet-run). A criterion is not fully accepted until every mandatory clause has its evidence ([§3](#3-rules-every-task-keeps)). The counts are the approved ones: the 38th operation and the 126th criterion are those of [§11.1](#111-listreasondefinitions-as-the-38th-slice-000-operation), approved on 9 October 2026.

### 6.1 Operations

Placement follows [SOLUTION_ARCHITECTURE.md](../../architecture/SOLUTION_ARCHITECTURE.md) §5 as this plan reads it: what a principal does for itself (sign-in, setup, recovery, session and own-device operations) lives in `src/platform/auth/`; what an officer does to another principal lives in the domain that owns the first segment of the permission key. Domain controllers are thin and the shared logic stays in `platform/auth` behind the S0.1 ports ([§11.6](#116-where-officer-operations-live), approved on 9 October 2026).

| Operation| Method and path| Permission| Placement| Real-operation evidence completes at|
|---|---|---|---|---|
| `completeStaffCredentialSetup`| `POST /auth/staff/setup/credential`| none| `src/platform/auth/`| S0.31|
| `completeMfaEnrolment`| `POST /auth/staff/setup/mfa`| none| `src/platform/auth/`| S0.31|
| `beginMfaReenrolment`| `POST /auth/staff/setup/mfa/begin`| none| `src/platform/auth/`| S0.31|
| `staffSignIn`| `POST /auth/staff/sign-in`| none| `src/platform/auth/`| S0.32|
| `completeStaffMfaSignIn`| `POST /auth/staff/sign-in/mfa`| none| `src/platform/auth/`| S0.33|
| `getCurrentSession`| `GET /auth/session`| self| `src/platform/auth/`| S0.34|
| `signOut`| `DELETE /auth/session`| self| `src/platform/auth/`| S0.34|
| `listAssignableStaffRoleBundles`| `GET /staff-role-bundles/assignable`| `permission.assignable_bundle.read`| `src/permission/`| S0.35|
| `listStaffIdentities`| `GET /staff-identities`| `staff.read`| `src/staff/`| S0.35|
| `getStaffIdentity`| `GET /staff-identities/{id}`| `staff.read`| `src/staff/`| S0.35|
| `listReasonDefinitions`| `GET /reason-definitions`| `settings.reason.read`| `src/settings/`| S0.35|
| `createStaffIdentity`| `POST /staff-identities`| `staff.identity.create`| `src/staff/`| S0.36|
| `approveStaffIdentity`| `POST /staff-identities/{id}/approve`| `staff.identity.approve`| `src/staff/`| S0.36|
| `reissueStaffCredentialSetup`| `POST /ops/staff/{id}/credential/setup/reissue`| `staff.identity.approve`| `src/staff/`| S0.36|
| `listSessions`| `GET /auth/sessions`| `staff.read`| `src/staff/`| S0.37|
| `revokeSession`| `POST /auth/sessions/{id}/revoke`| `staff.session.revoke`| `src/staff/`| S0.37|
| `resetStaffMfa`| `POST /ops/staff/{id}/mfa/reset`| `staff.mfa.reset`| `src/staff/`| S0.37|
| `listVendorAccounts`| `GET /ops/vendors`| `vendor.read`| `src/vendor/`| S0.47|
| `getVendorAccount`| `GET /ops/vendors/{id}`| `vendor.read`| `src/vendor/`| S0.47|
| `reissueVendorCredentialSetup`| `POST /ops/vendors/{id}/credential/setup/reissue`| `vendor.organization.approve`| `src/vendor/`| S0.47|
| `completeVendorCredentialSetup`| `POST /auth/vendor/setup/credential`| none| `src/platform/auth/`| S0.47|
| `vendorSignIn`| `POST /auth/vendor/sign-in`| none| `src/platform/auth/`| S0.48|
| `requestAdditionalDeviceGrant`| `POST /auth/vendor/device/grant`| self| `src/platform/auth/`| S0.49|
| `completeAdditionalDeviceEnrolment`| `POST /auth/vendor/device/enrol`| none| `src/platform/auth/`| S0.49|
| `listVendorDevices`| `GET /auth/vendor/devices`| self| `src/platform/auth/`| S0.49|
| `revokeVendorDevice`| `POST /auth/vendor/devices/{id}/revoke`| self| `src/platform/auth/`| S0.49|
| `requestCredentialRecovery`| `POST /auth/recovery/request`| none| `src/platform/auth/`| S0.50|
| `completeCredentialRecovery`| `POST /auth/recovery/complete`| none| `src/platform/auth/`| S0.51|
| `recoverStaffCredential`| `POST /ops/staff/{id}/credential/recover`| `staff.credential.recover`| `src/staff/`| S0.51|
| `recoverVendorCredential`| `POST /ops/vendors/{id}/credential/recover`| `vendor.credential.recover`| `src/vendor/`| S0.51|
| `listRiders`| `GET /ops/riders`| `dispatch.read`| `src/dispatch/`| S0.53|
| `getRider`| `GET /ops/riders/{riderId}`| `dispatch.read`| `src/dispatch/`| S0.53|
| `registerRiderDevice`| `POST /ops/riders/{riderId}/device/register`| `staff.device.register`| `src/staff/`| S0.53|
| `reregisterRiderDevice`| `POST /ops/riders/{riderId}/device/reregister`| `staff.device.reregister`| `src/staff/`| S0.53|
| `completeRiderDeviceEnrolment`| `POST /auth/rider/device/enrol`| none| `src/platform/auth/`| S0.57|
| `revokeRiderDevice`| `POST /ops/riders/{riderId}/device/revoke`| `staff.device.revoke`| `src/staff/`| S0.58|
| `requestRiderSignInChallenge`| `POST /auth/rider/sign-in/challenge`| none| `src/platform/auth/`| S0.59|
| `riderSignIn`| `POST /auth/rider/sign-in`| none| `src/platform/auth/`| S0.59|

### 6.2 Criteria

| Criterion| Title| Feature| Completes at|
|---|---|---|---|
| `AC-SLICE-000-01`| Ops staff sign in with email and password| staff-authentication| S0.32|
| `AC-SLICE-000-02`| A privileged role cannot sign in without a second factor| staff-authentication| S0.33|
| `AC-SLICE-000-03`| The challenge is single-use, short-lived and grants nothing| staff-authentication| S0.33|
| `AC-SLICE-000-04`| Sign-in failure does not disclose account existence| staff-authentication| S0.32|
| `AC-SLICE-000-05`| Authorization tests permissions, never role names| staff-authentication| S0.64|
| `AC-SLICE-000-06`| The bundle is snapshotted at session issue| staff-authentication| S0.36|
| `AC-SLICE-000-07`| Ordinary staff cannot reach another hub, and are told why| staff-authentication| S0.35|
| `AC-SLICE-000-08`| Phone, PIN and registered device are all required| rider-authentication| S0.59|
| `AC-SLICE-000-09`| A caller who has not proved the PIN learns nothing about a rider's device| rider-authentication| S0.59|
| `AC-SLICE-000-10`| One live session per rider| rider-authentication| S0.59|
| `AC-SLICE-000-11`| Inactive riders cannot sign in, and cannot tell why| rider-authentication| S0.59|
| `AC-SLICE-000-13`| Re-registration is never self-service| rider-authentication| S0.57|
| `AC-SLICE-000-14`| A new login displaces the old one, and says so| vendor-authentication| S0.48|
| `AC-SLICE-000-15`| No surface claims person-level attribution| vendor-authentication| S0.52|
| `AC-SLICE-000-17`| A credential change terminates every session| vendor-authentication| S0.51|
| `AC-SLICE-000-18`| The vendor surface exposes no permission management| vendor-authentication| S0.48|
| `AC-SLICE-000-19`| The vendor sign-in ceiling is keyed on the account and its browser| vendor-authentication| S0.48|
| `AC-SLICE-000-20`| Recovery goes only to a registered channel, and a supplied destination is rejected| credential-recovery| S0.50|
| `AC-SLICE-000-21`| Recovery does not disclose whether an account exists| credential-recovery| S0.50|
| `AC-SLICE-000-22`| Completing recovery terminates every session| credential-recovery| S0.51|
| `AC-SLICE-000-23`| Recovery authority is split and enforced| credential-recovery| S0.53|
| `AC-SLICE-000-24`| Recovery does not lift a suspension| credential-recovery| S0.51|
| `AC-SLICE-000-25`| A route with no declared permission is refused| permission-enforcement| S0.31|
| `AC-SLICE-000-26`| Both gates are independent| permission-enforcement| S0.48|
| `AC-SLICE-000-29`| Authorization returns only its own codes, never an authentication code| permission-enforcement| S0.37|
| `AC-SLICE-000-30`| Hub scope is enforced structurally| permission-enforcement| S0.35|
| `AC-SLICE-000-32`| An approved privileged identity cannot sign in before MFA is proven| staff-authentication| S0.33|
| `AC-SLICE-000-33`| The maker never supplies a credential| staff-authentication| S0.36|
| `AC-SLICE-000-35`| A browser session expires on idle| staff-authentication| S0.59|
| `AC-SLICE-000-36`| Password recovery leaves the MFA factor untouched| credential-recovery| S0.51|
| `AC-SLICE-000-37`| MFA reset requires another Platform Admin and cannot disable MFA| credential-recovery| S0.37|
| `AC-SLICE-000-38`| A rider's phone and PIN without the registered key do not authenticate| rider-authentication| S0.59|
| `AC-SLICE-000-39`| The challenge endpoint does not enumerate riders| rider-authentication| S0.59|
| `AC-SLICE-000-40`| First registration never exposes the PIN to the officer| rider-authentication| S0.57|
| `AC-SLICE-000-41`| Nobody types a device identifier| vendor-authentication| S0.48|
| `AC-SLICE-000-42`| The administrator never learns the shared secret| vendor-authentication| S0.47|
| `AC-SLICE-000-43`| Anonymity is declared, never inferred| permission-enforcement| S0.31|
| `AC-SLICE-000-44`| 401 and 403 are different answers to different questions| permission-enforcement| S0.35|
| `AC-SLICE-000-45`| A second browser can be registered without displacing the first| vendor-authentication| S0.49|
| `AC-SLICE-000-46`| A revoked rider session is invalid on the very next request| rider-authentication| S0.59|
| `AC-SLICE-000-47`| Sign-in does not depend on how the APK was installed| rider-authentication| S0.59|
| `AC-SLICE-000-48`| A revoked device cannot sign in| rider-authentication| S0.59|
| `AC-SLICE-000-49`| A replaced handset can no longer sign in| rider-authentication| S0.59|
| `AC-SLICE-000-50`| A rider's credentials from another rider's device are refused| rider-authentication| S0.59|
| `AC-SLICE-000-51`| A sign-in with no device proof is refused| rider-authentication| S0.59|
| `AC-SLICE-000-52`| A replayed challenge is refused| rider-authentication| S0.59|
| `AC-SLICE-000-53`| An expired challenge is refused| rider-authentication| S0.59|
| `AC-SLICE-000-54`| A signed-in rider is never stranded by an attestation outage| rider-authentication| S0.59|
| `AC-SLICE-000-55`| No test substitute, for attestation or for message delivery, can run in production| rider-authentication| S0.57|
| `AC-SLICE-000-56`| A root signal of DETECTED is recorded and blocks nothing| rider-authentication| S0.59|
| `AC-SLICE-000-57`| A root signal of NOT_DETECTED relaxes nothing| rider-authentication| S0.59|
| `AC-SLICE-000-58`| A root signal of UNKNOWN is valid and is recorded as UNKNOWN| rider-authentication| S0.59|
| `AC-SLICE-000-59`| A sign-in with no root signal is refused| rider-authentication| S0.59|
| `AC-SLICE-000-60`| A hardware-attested key is enrolled| rider-authentication| S0.57|
| `AC-SLICE-000-61`| A handset that cannot hold a hardware-backed key is refused| rider-authentication| S0.57|
| `AC-SLICE-000-62`| Evidence for the wrong application is refused| rider-authentication| S0.57|
| `AC-SLICE-000-63`| An untrusted attestation chain is refused| rider-authentication| S0.57|
| `AC-SLICE-000-64`| Evidence for a different challenge is refused| rider-authentication| S0.57|
| `AC-SLICE-000-65`| An unlocked or unverified device is refused| rider-authentication| S0.57|
| `AC-SLICE-000-66`| A key that is not the attested key is refused| rider-authentication| S0.57|
| `AC-SLICE-000-67`| An expired, consumed or superseded grant is refused before any evidence is read| rider-authentication| S0.57|
| `AC-SLICE-000-68`| An enrolment with no attestation is refused| rider-authentication| S0.57|
| `AC-SLICE-000-69`| Stale trust data fails enrolment closed and touches nothing else| rider-authentication| S0.57|
| `AC-SLICE-000-70`| The signing certificate can be rotated| rider-authentication| S0.57|
| `AC-SLICE-000-71`| A replacement supersedes the old device atomically| rider-authentication| S0.57|
| `AC-SLICE-000-72`| A failed replacement leaves the existing device untouched| rider-authentication| S0.57|
| `AC-SLICE-000-73`| A replayed or concurrent replacement has one winner| rider-authentication| S0.57|
| `AC-SLICE-000-74`| A revoked device stays revoked through a replacement| rider-authentication| S0.58|
| `AC-SLICE-000-75`| The substitute verifier produces each outcome deterministically| rider-authentication| S0.57|
| `AC-SLICE-000-76`| A rider never holds two ACTIVE devices| rider-authentication| S0.57|
| `AC-SLICE-000-77`| A fifth wrong password locks the credential and nobody is told| staff-authentication| S0.32|
| `AC-SLICE-000-78`| A lock ends on its own and a correct sign-in resets the count| staff-authentication| S0.32|
| `AC-SLICE-000-79`| A wrong MFA code is refused and counted twice| staff-authentication| S0.33|
| `AC-SLICE-000-80`| A lock reached at the second factor is announced only to someone who proved the password| staff-authentication| S0.33|
| `AC-SLICE-000-81`| A rate-limited request is neither verified nor counted| staff-authentication| S0.32|
| `AC-SLICE-000-82`| Signing out ends the session| staff-authentication| S0.34|
| `AC-SLICE-000-83`| The current-session read returns no credential and no bundle contents| staff-authentication| S0.34|
| `AC-SLICE-000-84`| An unsafe request without the synchronizer token is refused and audited| staff-authentication| S0.34|
| `AC-SLICE-000-85`| The maker cannot approve, and a bundle above the approver's tier needs a Platform Admin| staff-authentication| S0.36|
| `AC-SLICE-000-86`| An approver finds a pending identity and approves the version they read| staff-authentication| S0.36|
| `AC-SLICE-000-87`| A password outside 12 to 128 characters is refused, and nothing else is required| staff-authentication| S0.51|
| `AC-SLICE-000-88`| A setup grant is single-use, and two completions have one winner| staff-authentication| S0.31|
| `AC-SLICE-000-89`| A lapsed setup grant is re-issued, and an identity that already has a credential is refused| staff-authentication| S0.36|
| `AC-SLICE-000-90`| An approval whose message cannot be queued rolls back, and a later provider failure does not| staff-authentication| S0.36|
| `AC-SLICE-000-91`| A failed sign-in is audited with its precise cause and answers the same to everyone| staff-authentication| S0.33|
| `AC-SLICE-000-92`| The bootstrap secret is consumed when the password is set and can never start MFA enrolment| staff-authentication| S0.31|
| `AC-SLICE-000-93`| An expired continuation grant is recovered by a provisioning mechanism no API operation or screen can invoke| staff-authentication| S0.31|
| `AC-SLICE-000-94`| A wrong enrolment code leaves the factor PENDING| staff-authentication| S0.33|
| `AC-SLICE-000-95`| Five wrong secrets from a registered browser lock the credential for everyone| vendor-authentication| S0.48|
| `AC-SLICE-000-96`| An unregistered browser can neither sign in nor lock the account| vendor-authentication| S0.48|
| `AC-SLICE-000-97`| A shared secret outside 12 to 128 characters is refused| vendor-authentication| S0.51|
| `AC-SLICE-000-98`| The account identifier arrives with the grant and is not a secret| vendor-authentication| S0.48|
| `AC-SLICE-000-99`| Platform Admin can end a shared vendor session, and Senior Ops cannot| vendor-authentication| S0.48|
| `AC-SLICE-000-100`| A vendor sees and removes its own browsers, never the one it is using| vendor-authentication| S0.49|
| `AC-SLICE-000-101`| A lapsed vendor setup grant is re-issued by approval authority| vendor-authentication| S0.47|
| `AC-SLICE-000-102`| An Ops reader sees an account's readiness within their grant, and never a credential| vendor-authentication| S0.59|
| `AC-SLICE-000-103`| An expired, consumed or malformed recovery link is one answer| credential-recovery| S0.51|
| `AC-SLICE-000-104`| Recovery requests are rate-limited without disclosure| credential-recovery| S0.50|
| `AC-SLICE-000-105`| Platform Admin starts staff recovery, and the new password reaches nobody| credential-recovery| S0.51|
| `AC-SLICE-000-106`| A completed recovery clears a lock| credential-recovery| S0.51|
| `AC-SLICE-000-107`| A failed recovery message is invisible to the caller and is a job outcome| credential-recovery| S0.50|
| `AC-SLICE-000-108`| A device re-registration records why, and how identity was verified| credential-recovery| S0.53|
| `AC-SLICE-000-109`| Five wrong PINs from the registered handset lock the PIN| rider-authentication| S0.59|
| `AC-SLICE-000-110`| A handset that cannot sign can neither guess the PIN nor lock the rider| rider-authentication| S0.59|
| `AC-SLICE-000-111`| A PIN that is not six digits is refused by the schema| rider-authentication| S0.59|
| `AC-SLICE-000-112`| Revocation is bounded to the actor's hubs| rider-authentication| S0.58|
| `AC-SLICE-000-113`| The rider roster shows readiness and never a credential| rider-authentication| S0.53|
| `AC-SLICE-000-114`| A missing key is PERMISSION_DENIED and a held key at too low a tier is INSUFFICIENT_AUTHORITY| permission-enforcement| S0.53|
| `AC-SLICE-000-115`| The creation screen offers the bundles the contract returns, and none of its own| staff-authentication| S0.46|
| `AC-SLICE-000-116`| The bundle read needs its own key, and neither staff.identity.create nor permission.read substitutes| staff-authentication| S0.36|
| `AC-SLICE-000-117`| Choosing a privileged bundle grants nothing, and the list reveals no authority| staff-authentication| S0.36|
| `AC-SLICE-000-118`| The bootstrap is exactly two identities, and the first profile one makes only the other approves| staff-authentication| S0.36|
| `AC-SLICE-000-119`| MFA reset refuses a self-reset and a non-privileged identity, and reaches a stranded or unfinished enrolment| credential-recovery| S0.37|
| `AC-SLICE-000-120`| A bootstrap identity cannot be re-issued a setup grant, and the resume command is not a standing way in| credential-recovery| S0.36|
| `AC-SLICE-000-121`| A repeated recovery request changes nothing it should not and reveals nothing| credential-recovery| S0.51|
| `AC-SLICE-000-122`| A pending profile is rejected by a different approver, at the tier its bundle needs, and its email is released| staff-authentication| S0.36|
| `AC-SLICE-000-123`| A privileged identity with no ACTIVE factor reaches the second step and is stopped there| staff-authentication| S0.33|
| `AC-SLICE-000-124`| A rider who has had a device revoked is not registered again by registerRiderDevice| rider-authentication| S0.58|
| `AC-SLICE-000-125`| The credential setup operations share the recovery bucket| credential-recovery| S0.57|
| `AC-SLICE-000-126`| A TOTP code is six digits, single-use and accepted one step either side| staff-authentication| S0.33|
| `AC-SLICE-000-127`| The session cookies carry no lifetime of their own and the vendor device credential lasts 400 days| staff-authentication| S0.48|
| `AC-SLICE-000-128`| A staff read outside the actor's primary hub is audited once, without contents| permission-enforcement| S0.35|
| `AC-SLICE-000-129`| A work email has one canonical form| staff-authentication| S0.36|
| `AC-SLICE-000-130`| Every operation refuses in one order| permission-enforcement| S0.67|
| `AC-SLICE-000-131`| Statuses follow one rule| permission-enforcement| S0.67|
| `AC-SLICE-000-132`| The reason catalogue is readable for the operations and branches that take a reason, and by no one else| permission-enforcement| S0.59|

### 6.3 Evidence outside the API

The state stays *client/manual pending* until it exists: AC-15 and AC-18 on the Vendor PWA (G5); AC-40's QR render (S0.60) and handset (S0.61, deferred); AC-127's browser evidence (S0.46); AC-115's screen (S0.46); the Rider-app clauses of AC-08 to 11, 38, 40 and 47 to 59 (G5). AC-25, 26, 29, 43 and 44 are *fixture/platform verified* at S0.22 and S0.26; their first real-operation evidence is S0.31 (25, 43), S0.35 (44) and S0.37 (29), and AC-26 completes at S0.48, where a vendor session exists; all are re-verified for riders at S0.59. AC-05 has its first real-operation evidence at S0.37 and completes at S0.64; AC-130 completes at S0.67 after every operation has carried its own order test; AC-132 completes at S0.59, where a Rider session exists, its staff, Vendor and filter clauses having their first real-operation evidence at S0.35. AC-54 stays *partially accepted* until the later slices that build collection, evidence, payment and handover.

## 7. Deferred obligations — what is owed and not yet run

**Nothing in this section has been run.** Each row is an obligation the specifications state and no code yet satisfies. A task that builds the behaviour owes the check, and it is closed only by a recorded run in the environment named, never by a green unit test. The rows are cross-checked against the task blocks.

### 7.1 Acceptance obligations

| ID| Kind| Obligation| Source| Built and proved by| Run| State|
|---|---|---|---|---|---|---|
| OB-01| Privilege| The runtime role cannot `UPDATE` `RoleBundle`, `RoleBundleGrant` or `FixedPermissionPolicy`, cannot `SELECT … FOR SHARE` them, can run the advisory functions, and the catalogue shows no `UPDATE` grant| [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.10a 1| S0.8, repeated on the final schema in S0.64| D| Not run|
| OB-02| Concurrency| Session issue against a reduction, both orders: no session with the old snapshot is left `ACTIVE`; a fixed-policy floor raise likewise| §13.10a 2| S0.27 (bundle), S0.63 (fixed policy)| D| Not run|
| OB-03| Concurrency| A mutation against a reduction, both orders; a mutation already past its lock finishes first| §13.10a 3; `GBT-B12`| S0.27| D| Not run|
| OB-04| Concurrency| An addition raises `revision` and ends no session; a later reduction ends every session below its floor, including those issued after the addition| §13.10a 4; `GBT-B13`| S0.27| D| Not run|
| OB-05| Concurrency| Two writers on one bundle serialise; a writer does not block an issue on a bundle with a distinct lock key| §13.10a 5| S0.27| D| Not run|
| OB-06| Concurrency| An expired `lock_timeout` yields the generic failure, no session and no half-applied reduction| §13.10a 6| S0.7, S0.27| D| Not run|
| OB-07| Concurrency| No advisory lock survives `COMMIT`, `ROLLBACK` or an aborted transaction on a pooled connection (Family A)| §13.10a 7| S0.7, S0.64| D| Not run|
| OB-08| Concurrency| Randomised interleavings of issue, mutation, reduction, revocation, sign-out and multi-principal operations never deadlock| §13.10a 8| S0.64| D| Not run|
| OB-09| Concurrency| A transaction at a stricter isolation level is refused for these operations| §13.10a 9| S0.7| D| Not run|
| OB-10| Concurrency| A continuous stream of sign-ins does not starve a reduction within its deadline, on the **pinned PostgreSQL version**| §13.10a 10| S0.64| D| Not run|
| OB-11| Concurrency| Discovery and restart: an identity reassigned to another bundle between discovery and lock revalidates, restarts within one total deadline and a concrete tested bound, and nothing is written before the revalidation passes| §13.10a 11| S0.7, S0.24, S0.64| D| Not run|
| OB-12| Concurrency| The planned set: duplicates and digest collisions merge to the strongest mode, canonical order, no shared-to-exclusive upgrade, no deadlock for overlapping sets in opposite orders| §13.10a 12| S0.7; the last clause (a target revocation takes no policy lock for the target's sessions) S0.37 and S0.64| B D| Not run|
| OB-13| Concurrency| Two real builds with different compiled revisions and a different predicate, against one database under the runtime login (Vendor and Rider)| §13.10 and §13.10a 13| S0.63| D| Not run|
| OB-14| Concurrency| `resetStaffMfa` against each recorded state, the lineage and the immutable `origin`: constraints and runtime-login behaviour, including the one legal later write of `revocation_episode_id` and each illegal write| `GBT-B14`| S0.29 (constraints), S0.37 (behaviour)| D| Not run|
| OB-15| Concurrency| A recovery request or completion racing an offboarding or a suspension, both orders (the status change made through the test kit)| `GBT-B15`; [credential-recovery.md](../../features/identity/credential-recovery.md) §5.7| S0.50 (request), S0.51 (completion)| D| Not run|
| OB-16| Concurrency| The limiter admits no more than its ceiling across two processes and fails closed on a store outage; the delivery worker survives a crash after commit, lease expiry, a duplicate claim, a late acceptance and an accepted-but-unacknowledged send (same link, same delivery identity)| [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §14.12, §13.9a| S0.14, S0.18| D| Not run|
| OB-17| Concurrency| One winner for two completions of one grant, for a replayed or concurrent replacement, and for a revocation against a replacement| AC-88, AC-73, AC-74| S0.31, S0.57, S0.58| D| Not run|
| OB-18| Privilege| Database roles and posture as each actual login: worker capability, provisioning role, `SECURITY DEFINER` and default privileges (Families E, J, K, Y: `GBT-E5` to `E8` for the `authentication`, `seed` and `bootstrap` capabilities)| [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §14.6, §14.17| S0.4, S0.5, S0.9, S0.18, S0.24, S0.30, S0.64| D| Not run|
| OB-19| Privilege| Every new table is forced-RLS, registered and classified in its own migration (Family S); a row of another hub, vendor or rider is never disclosed| [data-scope-registry.md](../../contracts/data-scope-registry.md)| each table's task, S0.66| D| Not run|
| OB-20| Browser| The trusted HTTPS origin in Chromium, Firefox and WebKit plus a branded Chrome and Edge smoke, with no `ignoreHTTPSErrors`| AC-127; [SLICE-000-FINAL-DECISIONS.md](SLICE-000-FINAL-DECISIONS.md)| S0.23, S0.46| W E| Not run|
| OB-21| Browser| Browser-origin, cookie and CSRF behaviour (Family W: W5, W6, W11 and W15 at S0.25; W7 and W12 at S0.59; W9 at S0.23 on the test origin and at G2 on the deployed edge; W16 at S0.43 and S0.46) and the cookie lifetimes of AC-127| [security-test-matrix.md](../../standards/security-test-matrix.md) Family W| S0.23, S0.25, S0.43, S0.46, S0.48, S0.59| W E D| Not run|
| OB-22| Browser| The staff and Ops journeys of demonstration rows 1 to 15 in each supported engine| [SLICE-000.md](../slices/SLICE-000.md) §5| S0.46, S0.62| E| Not run|
| OB-23| Browser| No secret, QR payload or setup token in any browser storage, cache, trace or screenshot (sentinel)| Family U| S0.39, S0.60 (browser), S0.66 (all sinks)| W D| Not run|
| OB-24| Linux| The real-`SIGTERM` tests Windows skips: five API process tests, one `test:db` test and one harness test; plus the worker's shutdown| [apps/api/CLAUDE.md](../../apps/api/CLAUDE.md)| before Gate 2 (S0.19), S0.18| L| Not run. **Required before Gate 2 passes** (Product decision, 9 October 2026); no waiver|
| OB-25| Linux| The POSIX mode inspection of the bootstrap custody files; the Windows ACL inspection on Windows| [MIGRATION_AND_SEEDING.md](../../architecture/MIGRATION_AND_SEEDING.md) §3.2| S0.30| L| Not run. **Required at S0.30** (Product decision, 9 October 2026); no waiver|
| OB-26| Linux| The verifier service's JDK build and tests on Linux or CI, and its CI job| §15.2.3| S0.55| J L| Not run. **Required at S0.55** (Product decision, 9 October 2026); no waiver|
| OB-27| JVM| Independently generated adversarial attestation fixtures; the pinned `android/keyattestation` release qualified against a real chain| §15.2.1, §15.2.3| S0.55, S0.56, S0.57| J| Not run|
| OB-28| Manual| Accessibility passes on the existing shell: keyboard, screen reader, forced colours, Safari and Edge, previous majors| Runbook, evidence item 8; DESIGN_SYSTEM §14| S0.28| M| Not done|
| OB-29| Manual| An internally signed APK on a hardware-backed handset completes enrolment from the QR| AC-40; [SLICE-000.md](../slices/SLICE-000.md) §6.1| S0.61| M| Not done|
| OB-30| Manual| The Product Owner's local functional walk of the demonstration script| [SLICE-000.md](../slices/SLICE-000.md) §7 item 5| S0.70| M E| Not done|
| OB-31| Measurement| Integrated measurement and calibration of the development-qualified engineering parameters, and proposed release-capacity values (Argon2id, hash-admission and transport capacity, the edge ceiling, deadlines, NAT behaviour) for approval| [settings.md](../../contracts/settings.md) §9| S0.65| D| Not done|
| OB-32| Rehearsal| The trust-data alert at its two thresholds, and the provider-failure and credential-delivery alerts on a failed message| [OBSERVABILITY_AND_RECOVERY.md](../../architecture/OBSERVABILITY_AND_RECOVERY.md) §3| S0.68| D| Not done|
| OB-33| Offboarding and vendor termination| The offboarding transaction (SLICE-009) and the vendor rejection or termination transaction (SLICE-008) take the identity lock, end every outstanding recovery request and setup grant, cancel their jobs and end the sessions; the race of OB-15 is repeated against each real operation| [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md) §4c| **SLICE-009** and **SLICE-008**, not this slice| D| Owed there|
| OB-34| Reason administration| `upsertReasonDefinition` creates no row in, and changes nothing but `label` and `active` of, an identity reason domain; only a Platform Admin holding `settings.reason.manage` explicitly may, and a Senior Ops holder is `INSUFFICIENT_AUTHORITY`; a body carrying `permittedOperations` (not in `ReasonDefinitionWrite`) is `VALIDATION_FAILED`; each change writes `settings.reason.catalog_changed`| [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md) §4c; [permissions.md](../../contracts/permissions.md) §7| **SLICE-013**, not this slice| D| Owed there|
| OB-35| Metrics| What production does with a metric sample whose label value is outside its bounded set is defined, implemented and tested, and the choice recorded; `LABEL_UNBOUNDED` is the development and test validation only| S0.1 review, 9 October 2026; [OBSERVABILITY_AND_RECOVERY.md](../../architecture/OBSERVABILITY_AND_RECOVERY.md) §3| S0.15| B| Not built|
| OB-36| Key custody| Managed key custody (the KMS-backed production adapter behind `KEY_CUSTODY`) is implemented, with a rotation proof for every key purpose and a recovery proof, as a prerequisite of release gate G3. Until it exists the API refuses a production start (`KEY_CUSTODY=local` is refused when `APP_ENV` is `production`); S0.2 keeps that refusal and builds no custody| S0.2 review, 9 October 2026; [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §14.9; [DEPLOYMENT_AND_ENVIRONMENTS.md](../../architecture/DEPLOYMENT_AND_ENVIRONMENTS.md) §12.5| G3 (release gate; no SLICE-000 task)| D| Not built|
| OB-37| Execution budget| **(Mechanism and database half proved at S0.6; the pipeline half is open: OB-55.)** A request's execution budget is enforced, not raced: on expiry the mechanism cancels what can be cancelled, rolls back the open transaction, discards a connection of uncertain state, and prevents a late side effect (a commit, an outbound call, an audit or delivery enqueue) or records it; proved with a budget that expires mid-work and read on a second connection. Database timeouts alone do not bound a request| The Product Owner's instruction of 9 October 2026 (§11.8); [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §14.6| S0.6 (the mechanism), S0.20 (the pipeline)| D| Mechanism and database half done (S0.6); pipeline half not built|

### 7.2 Release gates — not acceptance of this slice's code

Each gate must exist before the exposure it names. **None blocks the local walk** (S0.70), and the local walk **waives none of them** ([SLICE-000.md](../slices/SLICE-000.md) §7 items 5 and 6).

| Gate| Needed before| What it is| Owner input|
|---|---|---|---|
| **G1**| Production identity use| Signed audit checkpoints with independent storage and monitoring ([audit.md](../../contracts/audit.md) §2.1)| Backend Engineer; storage choice|
| **G2**| External authentication exposure| Edge, trusted-proxy and load evidence; the shared limiter at the deployed topology; the measured capacity values approved (OB-31)| Product Owner approves values|
| **G3**| Staging release evidence| **Prerequisite (OB-36): managed key custody is implemented, with a rotation proof and a recovery proof for every key purpose; until it exists the API refuses a production start.** Real secrets and providers, a restore and key-rotation rehearsal, the controlled real-provider window of [DEPLOYMENT_AND_ENVIRONMENTS.md](../../architecture/DEPLOYMENT_AND_ENVIRONMENTS.md) §4.1 (a non-production credential, allow-listed recipients, a recorded approval; a refused destination is `DESTINATION_NOT_ALLOWED`), and the release inputs: an SMS and an email provider (`OQ-048`), the accepted Android attestation roots, the Rider package name and first signing-certificate digest, the KMS key and the Argon2id pepper| Product Owner; Release owner|
| **G4**| The milestone of each bootstrap waiver| Hosted CI, artifact and branch evidence ([§7.3](#73-inherited-from-the-bootstrap))| Product Owner|
| **G5**| Claiming a client's clauses| The Vendor PWA and Rider app journeys: the clauses of AC-08 to 11, 15, 18, 38, 40 and 47 to 59 that need a client| Frontend Engineer|
| **SW**| Slice acceptance| The Product Owner walks §5 in **Staging** against the substitute verifier and the capture adapter, rows 1, 2 and 12 included, and records it. The Vendor and Rider rows are walked at API level until their clients exist| Product Owner|

**Permitted deferrals — only what an owner decision or waiver names.** These may follow the local walk (S0.70), stay on its record as *deferred*, and are never reported as passed:

| Deferred item| The explicit permission| Must exist before|
|---|---|---|
| S0.61, the hardware handset (OB-29)| [SLICE-000-FINAL-DECISIONS.md](SLICE-000-FINAL-DECISIONS.md) §20: “API substitutes allowed for development”| Rider enrolment rollout|
| Runbook evidence items 4, 5, 6 and the Linux part of 7, for the existing tests the runbook lists (five API process tests, one `test:db` test, one harness test, the symlink test)| The runbook: “Waived 7 October 2026 until release”, with an owner and a milestone for each| Each item's milestone|
| G1 to G5 and the Staging walk (SW)| [SLICE-000-FINAL-DECISIONS.md](SLICE-000-FINAL-DECISIONS.md) §20 and [SLICE-000.md](../slices/SLICE-000.md) §7 items 5 and 6: release obligations, not acceptance of this slice's code| The exposure each names|

**Not deferred.** The bootstrap waivers name existing tests and milestones; they are **not** extended by inference to the worker's `SIGTERM` test (OB-24), the custody-file permission checks (OB-25), the JVM verifier build and tests on Linux or CI (OB-26), or any other evidence this plan creates. The Product Owner decided on 9 October 2026 that they are **required at the gate that names them** (OB-24 at Gate 2, OB-25 at S0.30, OB-26 at S0.55), with no new waiver (§10 row 13); a gate or task that needs them is not passed until the evidence exists. The failure rehearsal (runbook item 2) is open, not waived.

### 7.3 Inherited from the bootstrap

From the runbook's [evidence still owed](BOOTSTRAP_B0_RUNBOOK.md#evidence-still-owed-audit-b-05): the **failure rehearsal** (item 2) is open; the downloaded-build check, the clean supported setup in WSL2 or Linux, the disposable reset and the Linux suite run (items 4 to 7) are **waived until release** and remain unproven; the accessibility passes (item 8) are S0.28. A waiver is not a proof. **A known hazard for every `B` and `D` run:** a Vitest worker that fails to start has recurred on the owner's Windows machine without an explanation; rerun the one project, report both outcomes and never raise a timeout to hide it.

### 7.4 Carried from S0.3

What S0.3 built is correct in isolation and is owed to the tasks that use it. The formats named here are persisted contracts: their owner is the header of the file that implements them, under `apps/api/src/platform/auth/crypto/`, and changing one after a record exists means re-hashing or re-sealing it.

| ID| Kind| Obligation| Source| Built and proved by| Run| State|
|---|---|---|---|---|---|---|
| OB-38| Binding| Each S0.3 adapter (`Argon2Hasher`, `Sha256TokenService`, `Rfc6238TotpVerifier`, `AesGcmSecretCipher`) is bound in the runtime composition by the first task that consumes its port, from `config.keys`, `config.credentialHashing` and the `Clock`, and the S0.2 test "binds no port in the runtime composition while no real adapter exists" is changed deliberately (S0.6 changed it for the `Clock` alone: the runtime composition now binds `SystemClock` and every other port stays unbound)| S0.3 review, 9 October 2026| The first task that consumes each port| B| Not done|
| OB-39| Conventions| Every store of a session, grant, recovery token, CSRF token, device secret or attestation challenge hashes through `TokenService.hash` (the SHA-256 of the 32 decoded bytes), never the displayed text. Every store of a sealed value keeps `envelopeVersion` beside the key version, nonce and ciphertext, and builds its context with `sealedContext()` from the record and never from the request. Credential and email refusals are mapped from the returned results, and "is an email address" is checked after canonicalising (a zero-width space is not trimmed). A credential hash is rewritten only when the Hasher says so, which is forward-only| S0.3 review; [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.4a, §14.9| S0.12, S0.17, S0.24, S0.29, S0.31, S0.32, S0.36, S0.51| D| Not done|
| OB-40| Concurrency| The TOTP step is checked and recorded as one atomic conditional update on the factor, so that of two requests presenting one code exactly one is accepted; the verifier alone does not stop a concurrent replay| [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.5| S0.31, S0.33| D| Not done|
| OB-41| Capacity| Hash admission budgets the **largest supported profile** (the write profile and `ARGON2_ACCEPTED_PROFILES`) against the libuv pool of 4 threads shared with other work. The cost difference between a real and a dummy verification while a cost migration is under way is assessed before any change of profile is enabled| [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.4b, §13.4c| S0.16, S0.65| D| Not done|
| OB-42| Decision| The deployed Argon2id floor (19456 KiB and 2 passes, the OWASP minimum named at the S0.3 review and taken as the initial policy) is confirmed or changed| S0.3 review| The Product Owner| M| Open|
| OB-43| Clock| The production `Clock` adapter (wall time and monotonic elapsed time; persisted expiry decisions keep using database time) is built and bound| S0.3 review| S0.6| B| Done (S0.6): `SystemClock`, bound in `RUNTIME_PORT_BINDINGS`|

### 7.5 Carried from S0.4

S0.4 built the mechanism and proved it on fixture tables under the runtime login; the tables, the roles and the first operations it serves do not exist yet. Each row is owed by the task that creates what it applies to. The mechanism's own files name their rules in their headers: `platform/database/transaction-context.ts`, `capability-access.ts`, `scope-probe.ts`, `audit-actor.ts` and `tools/database/system-branch.ts`.

| ID| Kind| Obligation| Source| Built and proved by| Run| State|
|---|---|---|---|---|---|---|
| OB-44| Privilege| S0.5 granted the worker base and the provisioning identity `USAGE` on schema `melarc` and `EXECUTE` on the eight accessors (`0002_technical_identity_grants.sql`), to named roles and not to `PUBLIC`, and nothing else, and ran `GBT-E6` with the real provisioning login holding the write grant on a fixture. What remains: each table's grants for these roles follow the access matrix, are made in that table's migration, and are read back as each login, and a catalogue check of a capability's grant set against the registry row (`GBT-Y8`) is built with the first tables that the matrix names| S0.4; [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §14.6, §14.17| S0.9 and each table's task| D| Partly run (accessors and `GBT-E6` on fixtures)|
| OB-45| Policy template| Every hub-scoped table gets, in its own migration: its ordinary policy for every command (the old row in `USING`, the new row in `WITH CHECK`) with **no probe predicate in it**, and beside it a second policy `FOR SELECT` that holds `melarc.principal_type() = 'STAFF' AND id = melarc.scope_probe_id()` and nothing else ([§14.4b](../../architecture/SECURITY_DESIGN.md), corrected after the review of 9 October 2026: the earlier "one further disjunct" in a policy for ALL let an `UPDATE` move a record of another hub into one's own and would let a `DELETE` remove it); its row in `HUB_SCOPED_ENTITIES`; `SYSTEM` arms in the one supported structure (a mandatory positive capability test, `ELSE false`); DML grants that equal its rows in `CAPABILITY_ACCESS`. The runtime-login tests of S0.4 are repeated on the real table for `UPDATE`, `DELETE` under a grant that permits it, a locking read and an upsert. A catalogue check of grants against the matrix is built with the first tables the matrix names, and `GBT-E6` and `GBT-E7` run on real tables. A policy expression outside the supported structures is refused by the lint and the catalogue: the author writes the plain form, and S0.8 does not widen the checker to accept a table| §14.1, §14.4b; registry §5.2| S0.8, S0.9 and each table's task| D| Not run|
| OB-46| Probe use| `existingRecordHub` is called only after a staff read by id found nothing and never by a list, and never concurrently with another statement or probe of the same transaction (the probe holds its transaction and refuses an overlap, so a caller sequences its awaits and never puts the probe in a `Promise.all` with other work); the four properties of §14.4b are asserted on the real operations (staff only, after a filtered miss, the hub id and nothing more, a Vendor or Rider answered byte for byte as for a record that does not exist)| §14.4b| S0.35, S0.36, S0.37| D| Not run|
| OB-47| Audit| The audit writer takes its actor from `auditActorOf` (`SYSTEM` is the null `actor_id`) and never copies the context's principal id into an event| §14.1b; [audit.md](../../contracts/audit.md) §3| S0.11| D| Not built|
| OB-48| Identity| A stable principal id for each `SYSTEM` capability, for the idempotency record (`GBT-I7`: non-null, never a wildcard, never one worker identity), is defined by its first consumer within §14.16, **before the first persisted or idempotent use of a `SYSTEM` principal**; S0.4 sets none. The task classes of an `Outbox` envelope join the closed list in `task-capabilities.ts` with `outbox_task_permits` when the `Outbox` table exists (`GBT-E1`)| §14.16, §14.7| S0.12; the slice that builds the `Outbox`| D| Not built|
| OB-49| Matrix| A capability opened outside the directories `CAPABILITY_ACCESS` lists changes the matrix in the same change (the directories are an architecture convention checked by a text scan of `taskCapability: '<name>'`, not proof against a context built dynamically: what holds is the grant set), and its tables follow the registry (the registry names the seed fixture's vendor records only in prose: they are listed when S0.47 builds them). The port half of `GBT-E5` (by-key lookups and no scan on the credential repository port) and `GBT-E8` (the `bootstrap` branch's `WITH CHECK` and the refusal of a non-empty staff table) are proved by the tasks that build the port and the command| registry §5.2| S0.29, S0.30, S0.47| D| Not run|
| OB-54| Session| The general `SecurityContext` keeps `sessionId` optional, because legitimate pre-session `SYSTEM` work has no session and must not invent one. The session guard (S0.24) builds a `STAFF`, `VENDOR` or `RIDER` context only from an authenticated `Session` and always supplies its `sessionId`, and a test shows that a context built from a session carries it| [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §14.1b| S0.24| D| Not built|

### 7.6 Carried from S0.5

S0.5 created the roles and the checks; what the roles may touch is decided table by table, and no table exists yet. The files that say how are named in S0.5's block.

| ID| Kind| Obligation| Source| Built and proved by| Run| State|
|---|---|---|---|---|---|---|
| OB-50| Capability| A worker process is given its capability by whoever starts it: `melarc_worker_cap_credential_delivery` is put in front of the delivery worker's identity in that task's own provisioning, not by default, and `provisionRoles` (which today removes every membership of the worker base) is extended there with the intended membership. The task decides whether the process runs as the base with the capability or as a login of its own, and keeps `capabilityPermittedFor` and the `credential_delivery` row of the matrix true. S0.5 leaves this foundation **inactive** (the base holds no capability and the capability role holds nothing): S0.18 implements and tests the provisioning explicitly, and nothing claims a working authorized worker before it does. `GBT-Y1` to `Y4`, `Y6` to `Y8` and `J6` to `J11` are run when the tables they name exist| [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §14.17b| S0.18, S0.17 and each table's task| D| Not run|
| OB-51| Roles| The scheduler and the outbox-relay roles of §14.6 are not created: no Slice-000 task uses them. The slice that builds the scheduler or the relay creates its role in `technical-roles.ts` and `provisioning.ts`, adds it to `RUNTIME_LOGIN_ROLES` and to the catalogue check, and runs `GBT-J9` to `J11`| §14.6, §14.17| The slice that builds each| D| Not built|
| OB-52| Credentials| The worker and provisioning logins have no setting: on a local cluster their passwords are derived from the administrator's (`local-logins.ts`). The derivation is for the guarded local and test tooling only, and **runtime worker configuration never requires the administrator password**. A deployed environment gives each a secret of its own (G3), and the first task that connects as one adds its setting to `.env.example`, `env-example.test.ts`, the harness environment and the DEPLOYMENT table. The provisioning identity's credential stays out of the API's and every worker's configuration (`GBT-J17`, configuration half)| §14.17; [DEPLOYMENT_AND_ENVIRONMENTS.md](../../architecture/DEPLOYMENT_AND_ENVIRONMENTS.md) §12.5| S0.9, S0.18, S0.30; G3| D| Not built|
| OB-53| Definer functions| `APPROVED_DEFINER_EXECUTE` in `role-posture.ts` is empty because no `SECURITY DEFINER` function exists. A migration that creates one adds its role and function there in the same change, and the catalogue test gains the positive case. **A fixed `search_path` is necessary and not sufficient** (the lint checks that one is set, not that it is safe): before the first such function exists, its trusted schemas, its treatment of the temporary schema and its exact executable signature are validated and recorded, and no such function exists in Slice-000 yet| §14.6| The first task that needs a definer function| D| Not built|

### 7.7 Carried from S0.6

S0.6 built the mechanism and the database half; the request pipeline, the workers and the outbound calls that consume it are later tasks. The rules of the mechanism are in the headers of `platform/execution/execution-budget.ts` and `platform/database/database.service.ts`, and in [apps/api/CLAUDE.md](../../apps/api/CLAUDE.md).

| ID| Kind| Obligation| Source| Built and proved by| Run| State|
|---|---|---|---|---|---|---|
| OB-55| Pipeline| The pipeline creates each request's `ExecutionBudget` from `config.execution.requestBudgetMs` once the request has been received and admitted, sets it with `runWithBudget`, and finishes it when the response is sent (a finished budget never fires; an unfinished one is a leaked timer). It answers the platform's generic operational failure for `BudgetExpiredError`, `DatabaseDeadlineError`, `PoolSaturatedError`, `AcquireTimeoutError` and `PoolClosedError`, reading the typed error from the rejection of `transactionWithContext` (inside the work, drizzle wraps what a statement throws and keeps it as `cause`). **`CommitOutcomeUnknownError` must not be answered as an ordinary retryable failure:** the transaction may have committed, so a retry is safe only through the operation's idempotency key. The status and wording for it are a **decision for the Product Owner** (finding 1 of the S0.6 handoff), and **a contract-compatible HTTP mapping for it is an explicit prerequisite of this task**: the correction batch added no public error code and changed no part of `openapi.yaml`. `TransactionRolledBackError` (a COMMIT the server answered with `ROLLBACK`: definite, nothing kept) is an ordinary failure and is answered as the platform's generic one. Proved over real HTTP with a budget that expires mid-work| OB-37; plan §11.8| S0.20| D| Not built|
| OB-56| Effects| Every outbound call or enqueue that a request or a worker makes while a budget is current runs under `currentBudget()?.effect(name, …)`, or records why it cannot: a call not yet started when the budget ran out is refused, and one that ends late is recorded (`lateEffects`, `onLateEffect`) and logged. No provider or verifier call holds a transaction open (SECURITY_DESIGN.md §13.9a, §15.2.1)| OB-37| S0.18, S0.55, S0.57 and every task that calls out| D| Not built|
| OB-57| Workers| A background task makes its own `ExecutionBudget` per job and sets it with `runWithBudget`; without one `DatabaseService` bounds a transaction by `DATABASE_TRANSACTION_TIMEOUT_MS` alone. A worker's login repeats the cancel test as itself (the cancel is `pg_cancel_backend` on the login's own role)| S0.6| S0.18| D| Not built|
| OB-58| Privilege| The cancel relies on every runtime login being able to execute `pg_cancel_backend` on its own role's sessions (a default of PostgreSQL). A migration or posture change that revokes it degrades the cancel to `failed` and leaves only the server's time bounds; the runtime-login test fails first. Repeat the cancel test as `melarc_worker_runtime`| S0.6| S0.18 (worker login)| D| Not built|
| OB-59| Transport| The cancel connects from the same checked settings as the pool (`postgresConnectionSettings`), so a TLS option added there reaches it with the pool. The first deployment that sets one runs the cancel test over it| S0.6| The task that adds TLS to the connection settings; G2| D| Not built|
| OB-60| Calibration| The figures of DEPLOYMENT_AND_ENVIRONMENTS.md §12.5, "What S0.6 applied and where it was exercised" (the deadlines, the waiters, `REQUEST_EXECUTION_BUDGET_MS`, the disposal bound and the four cancel connections) are development-qualified on one machine. S0.65 calibrates them and proposes release values; G2 checks the relations at the deployed topology. The server's `max_connections` is sized for the pool plus the sessions a failed cancel leaves behind until their statement or transaction timeout| S0.6; OB-31| S0.65; G2| D| Not built|
| OB-61| Server version| `transaction_timeout` needs PostgreSQL 17 or later (the pinned version is 18.6). On an older server every transaction fails at `BEGIN`, loudly. A change of the pinned major version re-runs `execution-budget.db.test.ts`| S0.6| Any change of the pinned PostgreSQL| D| Not built|
| OB-62| Linux| The runtime-login tests of S0.6 ran on Windows with PostgreSQL in a local container. They have not run on Linux or CI (with OB-24 to OB-26)| S0.6| The Linux and CI runs| D| Not run|

### 7.8 Carried from S0.7

S0.7 built the mechanism of SECURITY_DESIGN.md §13.10a and nothing that uses a policy table; the tables arrive in S0.8 and the first operations that coordinate on them in S0.27. The rules are in the headers of the files under `platform/database/policy-lock/`.

| ID| Kind| Obligation| Source| Built and proved by| Run| State|
|---|---|---|---|---|---|---|
| OB-63| Consumers| Every operation that relies on policy content, or changes it, uses the toolkit and does not take an advisory lock of its own: a sign-in that issues a session, a state-changing request, an administrator's act on another principal, a bundle or floor change, a compiled-policy change and the seed (§13.10a, "Who takes which mode"). It plans from a discovery, runs in `PolicyCoordinator` (or takes `acquirePolicyLocks` first in its own transaction), and answers the platform's generic operational failure for `PolicyCoordinationError`, `DatabaseDeadlineError` and `BudgetExpiredError`. The coordinator is a plain class: the task that first needs it provides it from the configuration (`config.execution.requestBudgetMs` as its total deadline)| §13.10a| S0.24, S0.27 and every task of the table in §13.10a| D| Not built|
| OB-64| Seed| The seed takes each key it creates **exclusive** through the toolkit (§13.10a: one protocol, no special case), as the provisioning login. The toolkit's service is built for the runtime login; the seed builds its own over the provisioning login's pool| §13.10a| S0.9| D| Done (S0.9): the helper takes every key exclusive before it calls the seed function; `seed.db.test.ts` waits on a key a reader holds shared|
| OB-65| Real rows| Obligation 1 (the runtime holds no `UPDATE` and no row lock on `RoleBundle`, `RoleBundleGrant` and `FixedPermissionPolicy`, and the catalogue shows no `UPDATE` grant), 5, 6, 7, 9, 11 and 12 are repeated on the real tables and operations; obligations 2, 3, 4, 8, 10 (starvation on the pinned server) and 13 (two builds, one database) are proved there| §13.10a| S0.8 (obligation 1), S0.27, S0.63, S0.64| D| Not run|
| OB-66| Calibration| The restart bound (3), the total deadline and the lock wait are development-qualified on one machine. S0.65 proposes release values; G2 checks the relations at the deployed topology| S0.7; OB-31| S0.65; G2| D| Not built|
| OB-67| Guard| The architecture guard refuses `pg_try_advisory_*` everywhere and any advisory call outside `platform/database/policy-lock/`. The limiter's per-key serialisation (S0.14) takes its class from `lock-keys.ts` and adds its wrapper in the same change as an allow-list entry for its directory, with its own test that the class differs from the policy classes| §13.10a| S0.14| B| Not built|
| OB-68| Limit| The toolkit cannot stop a statement being sent beside the acquisition (`Promise.all`); it catches it afterwards and fails the transaction, which rolls back. Code that acquires the locks awaits them before anything else| S0.7| Every consumer| B| Accepted|

### 7.9 Carried from S0.8

S0.8 built the seven reference tables empty. They are filled by the seed (S0.9) and read by the first tasks that use them; the rules of their shape are in `platform/database/schema/reference-data.ts` and `0003_reference_data.sql`.

| ID| Kind| Obligation| Source| Built and proved by| Run| State|
|---|---|---|---|---|---|---|
| OB-69| Grants| `SEED_ONLY_TABLES` (`src/test-support/registry-grants.ts`) lists the tables only a seed writes: the API and the base worker read them and nothing more. The first slice that builds an operation writing one removes it from the list in the same change as that operation's grant, row-level policy and test. The three policy tables never leave it (SECURITY_DESIGN.md §13.10a)| MIGRATION_AND_SEEDING.md §5.1| The task that adds the first writing operation| B| Accepted|
| OB-70| Workers| The base worker (`melarc_worker_runtime`) reads `setting` and `reason_code` (registry "Read identity": `api` `worker`). It holds no grant yet, because no worker exists; S0.18 grants `SELECT` on the two, with a row-level branch for its context, and adds the cases to `reference-data.db.test.ts`| data-scope-registry.md §4.1, §5.1| S0.18| D| Not built|
| OB-71| Shape| `setting` holds a key, scope (`COMPANY` or `PLATFORM`), value type, a JSON value, a unit and a description, and `hub` an id, a name and a creation time: the minimum the seed and the first readers need (decision D-10, minimal tables at first real use). The editing permission, effective dating, versioning, the audit trail of a change and the hub-scoped values (`HubSetting`) arrive with the first operation that edits a setting; a hub's fields beyond its name with slice 014 (hub, zone and pricing administration)| settings.md §4; D-10| The first settings-editing operation; slice 014| B| Not built|
| OB-72| Counters| The primitives that raise `role_bundle.revision` and `reduction_floor`, and `fixed_permission_policy.revision` and `minimum_revision`, run under the exclusive policy lock as the seed or a migration (SLICE-009's edit operation as the migration or a privileged path: see the conflict below), and they must satisfy the guards: one step at a time, the floor only with a reduction. The seed inserts revision 1 and floor 1 (the table defaults; **built at S0.9**, the seed policy admitting revision 1 only), under the exclusive locks| SECURITY_DESIGN.md §13.10a| S0.9 (seed half), SLICE-009, any release that reduces policy| D| Seed half built; the raising primitive not built|
| OB-73| Finding| **Decided by the owner on 10 October 2026; recorded in [§7.12](#712-stage-1-correction-batch-10-october-2026-disposition).** The registry's "Write identity" for `RoleBundle` and `RoleBundleGrant` is `api`, and SECURITY_DESIGN.md §13.10a says the runtime roles hold `SELECT` only on the policy tables "and that stays true" (a row lock needs `UPDATE`). The SLICE-009 edit operation therefore cannot write them as the runtime login. Decision: the runtime stays `SELECT`-only on the policy tables; the registry's Write identity for `RoleBundle` and `RoleBundleGrant` is now `seed` and `migration`; and the controlled primitive that changes a bundle after the seed (which identity runs it, and whether it is a SQL function or application code) is S0.27's, which adds its identity to the registry in the change that builds it (finding 3 of the S0.8 handoff)| data-scope-registry.md §4.1; §13.10a| The Product Owner; SLICE-009| M| Closed (the registry is reconciled; the primitive is S0.27's)|
| OB-74| Closed sets| The database checks the *form* of `permitted_operations` (an `operationId` or `operationId#BRANCH`), not that the operation exists in the contract. S0.9's seed test derives the closed set from `openapi.yaml` and refuses a reason that names an operation the contract does not have| domain-model.md §3.9| S0.9| B| Accepted (`seed-data.test.ts`)|

### 7.10 Carried from S0.9

S0.9 filled the seven reference tables from the documents and gave the provisioning login the only write there is. The findings below are choices the documents leave open or contradict, made the smallest way and recorded for the Product Owner; none is a default for a value a document leaves unset.

| ID| Kind| Obligation| Source| Built and proved by| Run| State|
|---|---|---|---|---|---|---|
| OB-75| Finding| **Decided by the owner on 10 October 2026; recorded in [§7.12](#712-stage-1-correction-batch-10-october-2026-disposition).** `role_bundle_grant.tier` is **nullable**, and the grants of the Finance/Reconciliation, Rider and Vendor holders carry no tier: `permissions.md` gives the tier letters `A`, `S` and `P` to staff holders only. A null tier satisfies no rule that compares tiers. Decision: they have none; null means *not applicable*, is never coerced into a ranked tier and never satisfies an action restricted by tier, and the first task that compares tiers owes the test that proves it| permissions.md §5, §7; domain-model.md §6.9| The first task that compares tiers (S0.27)| M| Decided: not applicable; the first tier consumer owes the proof|
| OB-76| Finding| **Decided by the owner on 10 October 2026; recorded in [§7.12](#712-stage-1-correction-batch-10-october-2026-disposition).** The bundles hold **only the fifteen keys the operations of this slice need** (decision D-11), each with the holder's reach as the catalogue words it. Three consequences: the Platform Admin grants whose catalogue scope reads "own hub" are seeded `own`, not `all`; **Fleet Manager, Auditor and Executive are not seeded** (Auditor and Executive are `PROPOSED`, and Fleet Manager is named only as a holder of `fleet.read`); the Vendor bundle holds no key yet. A key of a later slice is added to its bundle by that slice's migration, which raises the bundle's revision as an addition. Decision: the three are confirmed (the bundles keep only the approved permissions this slice needs, the "own hub" scope is preserved for Platform Admin, and Fleet Manager, Auditor and Executive may stay deferred), and a later addition is a controlled revision of the bundle, never a direct insert| permissions.md §7, §8; MIGRATION_AND_SEEDING.md §4| Each slice that adds a key to a bundle| M| Decided; later additions are controlled revisions|
| OB-77| Finding| **Decided by the owner on 10 October 2026; recorded in [§7.12](#712-stage-1-correction-batch-10-october-2026-disposition).** **One hub, named `Accra`, and no default zone.** The migration document asks for "at least one hub with its default zone", and no zone table exists: service zones are slice 014's (hub, zone and pricing administration). The name is the only one the documents give (settings.md calls it "the Accra hub"). Decision: the name stands, and one hub without a zone is acceptable for identity development; no zone-dependent operation is accepted until zone data exists, and the zone is seeded by slice 014| MIGRATION_AND_SEEDING.md §4; settings.md §7.2| Slice 014| M| Decided; the zone arrives with slice 014|
| OB-78| Finding| **Settings not seeded:** every `OPEN` key (the accounting-export file retention, the evidence upload ceiling and MIME types, the retention periods); the notification and handshake keys of section 7.4, whose scope the document does not state and several of whose values are source defaults that meet the definition of `PROVISIONAL`; and the hub-scoped values (fees, cut-off times, windows), a `HubSetting` table that does not exist. Where one is needed it fails visibly as `SETTING_MISSING`, as the document intends. **Decide** each when the task that needs it names it| settings.md §7, §9; MIGRATION_AND_SEEDING.md §4| The Product Owner; the task that first reads each| M| Open|
| OB-79| Finding| **Decided by the owner on 10 October 2026; recorded in [§7.12](#712-stage-1-correction-batch-10-october-2026-disposition).** The registry's `seed` row says "INSERT into an empty set" and "No lookup. Refuses when its target is not empty". A seed cannot refuse a target it may not look at: the helper reads **a count of rows** under a `_seed_read` policy, and `SELECT` is granted to the provisioning login on the seven tables. `capability-access.ts` says so; the registry text was left unchanged because a contract change is the owner's. Decision: the wording follows the access. After the correction (F02) the identity holds no privilege on the tables and the initialization function counts inside the database, so the registry row now says "No lookup: the identity reads nothing of these tables" and the function returns the number of rows it inserted| data-scope-registry.md §5.2| The Product Owner| M| Closed (the registry row is amended)|
| OB-80| Engineering choice| **Decided by the owner on 10 October 2026; recorded in [§7.12](#712-stage-1-correction-batch-10-october-2026-disposition).** Names no specification gives, chosen the smallest way: `DATABASE_SEED_URL` (the provisioning login's connection, forbidden in the API's environment) with `APP_ENV` required beside it; `--fixtures` as a separate invocation that adds the fixtures to a seeded database; the two fixture reasons; the seed's `SYSTEM` principal id and correlation id; the seed pool's `application_name` (it is `melarc-api`, which a reader of `pg_stat_activity` would take for the API: give the pool the command's name when a second pool needs a name of its own)| MIGRATION_AND_SEEDING.md §4, §5.1| S0.9| M| Accepted (`DATABASE_SEED_URL`, `--fixtures`)|
| OB-81| Not built| The demonstration rider and vendor fixtures (MIGRATION_AND_SEEDING.md §4a and §4b) write tables that do not exist yet; the `bootstrap` capability's seed (the two bootstrap administrators) is S0.30's. Both use `runSeed` and the same policy pattern (`_seed_read`, `_seed_insert`), and `tools/fixtures/` is where the first belongs| MIGRATION_AND_SEEDING.md §3, §4a, §4b| S0.30; the tasks that build `RiderIdentity` and the vendor tables| D| Not built|
| OB-82| Run| `pnpm --filter @melarc/api run db:migrate` and then `db:seed` against the owner's `melarc_dev`, which this session did not touch. The seed of a database that already holds rows refuses; `db:reset` returns it to empty| DEVELOPMENT.md section 4| The owner| M| Not run|
| OB-83| Finding| **Decided by the owner on 10 October 2026; recorded in [§7.12](#712-stage-1-correction-batch-10-october-2026-disposition).** **The reasons of the workflow domains are not seeded.** `domain-model.md` §3.9 says the contents of the recipient-contact (5), pickup-stop-skip (4) and handoff-failure (5) domains "are seeded", and MIGRATION_AND_SEEDING.md §4 lists the reason pills as required reference data. This task seeds the twelve identity reasons the plan names, and the workflow reasons belong to the slices that use them (`reasons.ts` says so); the table accepts them (their checkpoints and the null operations list are constraints). Decision: the deferral stands, and the general seeding text no longer claims that those reasons exist now| domain-model.md §3.9; MIGRATION_AND_SEEDING.md §4| The slices that read them| M| Decided; the general seeding text is aligned|
| OB-84| Finding| **Closed by the correction batch of 10 October 2026 (F02).** "INSERT into an empty set" is now the database's rule: migration 0005 takes every privilege on the seven tables from the provisioning login and gives it two definer functions, one of which fills the seven tables once, serialized, and refuses unless all seven are empty ([§7.12](#712-stage-1-correction-batch-10-october-2026-disposition))| SECURITY_DESIGN.md §13.10a; data-scope-registry.md §5.2| S0.9 (corrected)| D| Closed|

### 7.11 Carried from S0.10

The first rows are what the review of Stage 1 (S0.6 to S0.10) found; OB-85 is closed by the correction batch ([§7.12](#712-stage-1-correction-batch-10-october-2026-disposition)), and what the review found and closed is in the S0.10 block above. The rest are the kit's own.

| ID| Kind| Obligation| Source| Built and proved by| Run| State|
|---|---|---|---|---|---|---|
| OB-85| Finding| **Closed by the correction batch of 10 October 2026 (F03).** The policy reader and the catalogue check refuse every ordinary policy expression that is not the principal `CASE`, whether it names `SYSTEM` or not; the scope probe policy FOR SELECT is the one named exception, validated by its own check ([§7.12](#712-stage-1-correction-batch-10-october-2026-disposition))| SECURITY_DESIGN.md §14.1b| S0.4, S0.5 (corrected)| D| Closed|
| OB-86| Finding| **Accepted, low-severity items of the database layer.** `55P03` is always reported as a lock deadline, so a future `NOWAIT` conflict would read as a lock timeout; `57014` is always a statement timeout, so an operator's own cancel reads as one; the cancel names the backend by process id, role and database, not by `backend_start`, so on a machine that reuses process ids quickly it could reach another session of the same role if the client's backend had died unnoticed; an ordinary failure with other statements still running sends no cancel, so the server's `statement_timeout` bounds them; a connection released with a statement still in flight makes the next caller's first statement wait behind it; the lint's tokenizer does not read a dollar-quoted string (the catalogue check does); no constraint ties a setting's JSON type to its `value_type`. None is reachable by the code that exists| the review of Stage 1| Whoever first needs one of them| B| Open|
| OB-87| Kit limit| `TestClient` reads `SameSite` and does not apply it, stores a `Secure` cookie set over plain http to a host that is not loopback, sends no `Sec-Fetch-*` header and treats every cookie as host-only; the header of `test-client.ts` says so. A test of the `Origin` check therefore shows the check and not the path a browser takes (S0.25 and S0.26 add the browser's half in the end-to-end project)| SECURITY_DESIGN.md §12, §13.8| S0.25, S0.45| D| Open|
| OB-88| Capture| The capture reader is empty because no adapter writes to its `captureSink`. S0.17 binds the capture delivery adapters to the sink, narrows the entry type (it is `unknown`) and adds the cases that read a setup link or a code from it| DEPLOYMENT_AND_ENVIRONMENTS.md §4| S0.17| D| Not built|
| OB-89| Transport| `TestClient` models a browser on plain http to loopback (a `Secure` cookie is sent there, as Chromium does). The browser-facing HTTPS origin and its test CA are S0.23's: the client then needs an HTTPS `fetch` that trusts that CA, and the cookie cases re-run over it| SLICE-000-FINAL-DECISIONS.md §11| S0.23| D| Not built|
| OB-90| Tracer| `traceStatements` wraps `pg.Client.prototype.query` in the process that runs it and reads `connectionParameters.user`; it sees the in-process application and nothing of the built API in another process, and a `pg` upgrade can change the property. Its use against the real service is in `integration-kit.db.test.ts`, which fails first. The sign-in equivalence tests (S0.27, the work-shape trace) run in process| SECURITY_DESIGN.md §13.4c| S0.27| D| Built; used from S0.27|
| OB-91| Parallelism| Files of the `database` project run one at a time, because the roles are cluster-wide and some tests change them and put them back. Two disposable databases can be made at once (shown); running files in parallel needs those role-changing tests set apart, and is worth doing only if the suite's time makes it| vitest.config.ts| Whoever needs the time| B| Open|
| OB-92| Kit growth| The kit knows no operation of the contract. The first route (S0.31) adds the helpers it needs (a signed-in client, a snapshot of a session) beside it and not in it, each with a test, and nothing adds a way to move the application's time other than the `ports` option of a test composition| S0.31| S0.31 onward| D| Not built|

### 7.12 Stage 1 correction batch (10 October 2026): disposition

The owner's review of the Stage 1 report (S0.6 to S0.10) raised six findings and gave directions on the decisions that report listed. This is the disposition of both. **Stage 1 stays under correction until the owner has reviewed this batch's evidence.** Nothing here is a blanket security approval or a statement that Stage 1 is ready for production, and S0.11 is not started. Every finding was reproduced before it was fixed (a unit test that failed on the committed behaviour, or, for F02, a database migrated only to 0004), then fixed test first where a unit test can hold it, and every new guard was broken on purpose, one break at a time, with the file restored and its hash checked. No finding failed to reproduce. A review of the correction (10 October 2026) accepted F01, F02, F03, F04 and F06 on source review, asked for one follow-up, F05 (below), asked that two statements of this record be corrected (the fixtures function's isolation guard; the cause of the timing failures), and made the decisions listed after the limitations.

**Baseline.** Branch `docs/slice-000-reconciliation`, HEAD `fd5f696` (S0.4 and S0.5; everything later is uncommitted), nothing staged; 102 changed paths when the batch began (35 modified, 67 untracked) and 124 when it ended; `melarc_dev` not touched; no dependency changed; no migration that might have been applied was edited (0005 is new, and 0003 and 0004 are uncommitted).

**What kind of evidence this is.** Configuration validation (a setting parsed and refused at start) proves that a value is accepted and nothing about what it bounds; that is how the deployment figures stand until S0.65. *Fixture/platform* evidence is everything below: a real PostgreSQL 18.6, the technical logins, the test fixtures and the kit. *Real-operation* evidence does not exist yet, because no operation of the contract is built (the first route is S0.31): none of this batch is it.

| Finding| What was wrong, and how it was reproduced| Correction| Regression evidence|
|---|---|---|---|
| F01 The commit answer| A COMMIT of a transaction in which a statement had failed and the work had carried on is answered by the server with the tag `ROLLBACK` and no error; the service returned the work's value as success. Reproduced: a unit test saw the value returned, and a real-database test (a row written, an aborting statement caught, a success-shaped return) saw the row absent from a second connection| `database.service.ts` reads the command tag of the COMMIT: `COMMIT` is success; `ROLLBACK` is `TransactionRolledBackError` (definite: nothing kept; the cause is the first statement failure; the connection is destroyed); a missing or unexpected tag is `CommitOutcomeUnknownError` (`unrecognized-completion`); a connection lost or a budget spent in flight is unknown as before. No public error code, no `openapi.yaml` change| `database-deadlines.test.ts`, `database.service.test.ts`, `scope-probe.test.ts`; `test/database/commit-outcome.db.test.ts` (the ordinary commit, the headline case, a refusal the work did not catch, a commit refused by a deferred trigger, a savepoint that recovers). The old behaviour put back by a break is caught by both|
| F02 Initialization| "INSERT into an empty set" was the helper's rule, and the provisioning login held `INSERT` on the seven tables. Reproduced on the migrations up to 0004: after the seed, that login, with the `seed` label asserted, inserted a grant into the Ops Staff bundle and committed| Migration `0005_seed_initialization.sql`. The login holds **no privilege** on the seven tables. Two `SECURITY DEFINER` functions owned by `melarc_owner`, executable by that login alone and listed in `APPROVED_DEFINER_EXECUTE`, are the only way in: `melarc.initialize_reference_data` locks the seven tables in one order, counts every one and refuses (`55000`, naming the table) unless all seven are empty, then inserts, in one statement of the caller's transaction; `melarc.add_reason_fixtures` writes `FIXTURE_` codes only. Fixed `search_path`, every table qualified, no dynamic statement, rows as one JSON document, revision and floor never taken from it, read committed only, the caller's context put back. A policy with a self-referencing "is the table empty" subquery was not used: it cannot see rows of its own statement, takes no lock, and a second transaction sees the same empty table. `registry-grants.ts` now caps the provisioning login at nothing on these tables| `test/database/seed-initialization.db.test.ts` (53 tests: the 51 of the first gate and two for the fixtures function's read committed guard, which ran green on the corrected tree): first run, repeat, one table filled, a failure part-way then a retry, two runs at once (wait then refuse; lock timeout; first rolled back), the direct `INSERT` refused with the label asserted, the runtime and the base worker refused both functions, the catalogue and the allow-list; `registry-grants.db.test.ts`, `reference-data.db.test.ts`, `seed.db.test.ts`. 19 breaks of the migration and its checks: 18 caught; the nineteenth, the emptiness check of `role_bundle_grant`, is an **equivalent mutant**: a grant row needs a row in `permission` and in `role_bundle`, which are counted first, so it can never decide alone (kept as defence in depth)|
| F03 The policy checker| `true`, `melarc.principal_type() <> 'VENDOR'` and `NOT IN ('VENDOR', 'RIDER')` named no `SYSTEM`, so the reader and the catalogue check passed them, and each admits a `SYSTEM` context under any capability. Reproduced: the committed reader returned no problem for them; against a real database a `SYSTEM` context under `authentication` and under `rate_limit` read all three tables| `system-branch.ts` supports two structures and refuses the rest: the principal `CASE` (arms for `STAFF`, `VENDOR`, `RIDER`, `SYSTEM` only, `ELSE false` or none, a mandatory positive capability test in each `SYSTEM` arm), and, in the `USING` of a policy `FOR SELECT`, exactly `melarc.principal_type() = 'STAFF' AND <column> = melarc.scope_probe_id()`. Each clause that is present is judged for its command, in the migration text (the lint passes the command) and in the catalogue (`pg_get_expr` and `polcmd`); the scope probe's `FOR SELECT` rule and its command restrictions are unchanged. No directory, fixture or policy is exempt. Two fixtures were rewritten into the `CASE` (`owned_records`, whose policy admitted `SYSTEM`, and the catalogue test's `widgets`)| `system-branch.test.ts`, `migration-lint.test.ts`, `catalog-invariants.db.test.ts` (eight new cases, among them a second permissive policy beside a safe one), `policy-structure.db.test.ts` (the three expressions read as `pg_get_expr` prints them, the behaviour against a real database, both checks refusing them, and what an absent clause does). 11 breaks, all caught|
| F04 Deadlines| (A) the wait for a permit and the connecting each had the acquire timeout, up to twice it, and a request-less connect had no bound of the service's. (B) the cancel's close got a fresh bound after the first (a 60 ms configuration took about 121 ms with the connect and the close stalled), a connection that arrived late sent its statement, and the clean-up sent its rollback after its bound. (C) `DatabaseService.check` was bounded by the server's statement timeout only, so a probe the database never answered held a connection and a permit. All reproduced by failing tests| (A) `lease()` runs both under one acquisition budget (the acquire timeout, capped by the request), maps its own expiry to `AcquireTimeoutError` and the request's to the request's error, keeps the permit while an abandoned attempt lives, and hands over no connection that arrives after the deadline. (B) `PgStatementCanceller` has one `ExecutionBudget` on the injected clock for its turn, its connection, its statement and its close; the turn is given back at the bound at the latest; no statement is sent on a late connection; `dispose()` shares one budget between the cancel and the rollback. (C) the registry passes each check its deadline (`check({ timeoutMs })`); the database check draws its wait and its query on it and destroys its connection and gives back its permit when it passes. A cancel is still a request that was sent, never proof that the statement stopped| `statement-canceller.test.ts`, `database-deadlines.test.ts`, `readiness.registry.test.ts`; fake timers and the manual clock, no exact-millisecond assertion. 14 breaks, all caught|
| F05 Finished budgets| `finish()` stopped the timer and nothing else: an effect or a child could still start under a finished budget, with expired false and nothing recorded. **The review found the first correction incomplete:** it closed the budget that was finished and left its descendants free. A child made before its parent finished still authorized new effects after the request was answered, and the public constructor built a budget under a finished parent. Both reproduced by failing tests| A finished budget is closed, **and so is every budget below it**: closure is read through the ancestry (`closedBy`), so `effect()`, `child()`, `assertOpen()` and `remainingMilliseconds()` see a finished ancestor, and the constructor refuses a parent whose line is closed before it arms anything. The error names the budget that was finished. Expiry stays a different fact: a child that ran out by its own deadline, or under a parent that ran out, reports expiry, never closure. An effect already in flight settles and is still recorded on the budget it ran under. A transaction and the coordinator refuse to begin under a closed line; `finish()` is idempotent; nothing claims a started effect was cancelled| `execution-budget.test.ts` (parent, child and grandchild; the constructor; expiry and closure kept apart; the in-flight effect recorded; a continuation that kept the child's scope through `runWithBudget`; a sibling left open), `database-deadlines.test.ts` (work that outlives its request), `coordinate.test.ts`. 4 breaks of the first correction and 6 of the ancestry, all caught|
| F06 The kit| A start that failed part-way left the application and the connections open; `stop()` ended at the first failure; `Admin.close()` skipped the end of its connection when a table could not be mended; `startTestApp` left the application running when it was refused| `src/test-support/cleanup.ts` (`Opened`, `closeEach`: last opened first, every close attempted, the failures kept, closing once); the kit, `Admin.close()` and `startTestApp` use it. The database the kit was given is never closed or dropped| `src/test-support/cleanup.test.ts`, `test-app.test.ts`, `test/database/integration-kit-cleanup.db.test.ts` (the application's `stop` watched and made to fail; the connections counted on the server). 10 breaks, all caught|

**The owner's directions of 10 October 2026, and where each is recorded.**

| Direction| Recorded in|
|---|---|
| A null tier means *not applicable*, never a ranked tier and never satisfies an action restricted by tier; the first tier consumer owes the proof| [domain-model.md](../../contracts/domain-model.md) §6.9 (the grants row); OB-75; S0.27|
| Initial bundles keep only the approved permissions this slice needs; later additions are controlled revisions| [MIGRATION_AND_SEEDING.md](../../architecture/MIGRATION_AND_SEEDING.md) §4 (the bundles row); OB-76|
| The explicit "own hub" catalogue scope is preserved, Platform Admin included; Fleet Manager, Auditor and Executive may stay deferred| `seed-data.test.ts` (the `staff.device.reregister` rows); OB-76|
| One Accra hub without a zone is acceptable for identity development; no zone-dependent operation is accepted until zone data exists| MIGRATION_AND_SEEDING.md §4 (the hub row); OB-77|
| No invented setting value; the first consumer settles each value it needs| OB-78 and the limitations below|
| Workflow reasons may be deferred| MIGRATION_AND_SEEDING.md §4 (the reason pills row); OB-83|
| `DATABASE_SEED_URL` and `--fixtures` are accepted names; credential separation and the production refusal of the fixtures are kept| OB-80; [DEVELOPMENT.md](../../DEVELOPMENT.md)|
| The timeout and restart constants stay development values, not production-qualified| [DEPLOYMENT_AND_ENVIRONMENTS.md](../../architecture/DEPLOYMENT_AND_ENVIRONMENTS.md) §12.5 (the rows added for the cancel and the readiness deadline); S0.65|
| The runtime stays `SELECT`-only on the policy tables; the registry is reconciled; S0.27 owns the controlled change| [data-scope-registry.md](../../contracts/data-scope-registry.md) §4.1 (the Write identity of `RoleBundle` and `RoleBundleGrant` is `seed` and `migration`) and §5.2; OB-72, OB-73|
| "No lookup" is true only if the database exposes nothing but a count| data-scope-registry.md §5.2 (the `seed` row), `capability-access.ts`: the identity holds no privilege on the tables and the function returns the number it inserted; OB-79|
| The unknown-commit distinction stays; its contract-compatible HTTP mapping is a prerequisite of S0.20; no new public error code, no OpenAPI change| OB-55|

**Checks of the tree before the review follow-up** (the gate of 10 October; Windows 11, Node 24.21.0, pnpm 11.1.3, PostgreSQL 18.6 in the local container; uncached with `TURBO_FORCE=true`; each command once on the final tree of the code; real exit codes):

| Command| Result|
|---|---|
| `pnpm run format:check`, `lint`, `typecheck`, `build`| exit 0 each|
| `pnpm test`| exit 0: root 1189 (1187 passed, 2 skipped); API 3784 passed and 5 skipped in 111 files; Ops Portal 220; api-client 250; harness 199 passed and 1 skipped|
| `pnpm run contract:check`| exit 0, **0 operations compared**: it proves the checking machinery and says nothing about future identity conformance|
| `pnpm run api-client:check`, `pnpm --filter @melarc/api run db:check`| exit 0 each|
| `pnpm run test:db`| exit 0: 692 passed and 1 skipped in 23 files (the skipped one needs Linux)|
| `pnpm run test:e2e`| exit 0: 16 passed|

**After the review follow-up** (F05 ancestry closure: `execution-budget.ts`, its tests, one database test and documents), the commands that need no database were run again, uncached, each once:

| Command| Result|
|---|---|
| `pnpm run format:check`, `lint`, `typecheck`, `build`| exit 0 each|
| `pnpm test`| exit 0: root 1189 (1187 passed, 2 skipped); API 3792 passed and 5 skipped in 111 files; Ops Portal 220; api-client 250; harness 199 passed and 1 skipped|
| `pnpm run contract:check`, `pnpm run api-client:check`, `pnpm --filter @melarc/api run db:check`| exit 0 each (`contract:check` still compares 0 operations)|

**Then, on the corrected tree, with PostgreSQL running** (the same tree as the no-database run above; HEAD `fd5f696`, 124 changed paths, nothing staged; Turbo cache bypassed with `TURBO_FORCE=true`, `0 cached`; each command once):

| Command| Result|
|---|---|
| `pnpm run test:db`| exit 0: **694 passed and 1 skipped in 23 files** (692 and 1 before the follow-up; the one skipped needs Linux). `seed-initialization.db.test.ts` ran 53 tests (51 before), the two new ones being `the reason fixtures function > refuses to run at repeatable read isolation, and writes nothing` and the same at `serializable`; `execution-budget.db.test.ts` ran its 15 tests against the corrected `ExecutionBudget`, and every other database test that builds a budget through `DatabaseService` ran with the corrected constructor|
| `pnpm run test:e2e`| exit 0: 16 passed|

Nothing failed and nothing was rerun. The targeted break of the fixtures guard was not made (no further mutation campaign was asked for), so the two new tests are known to pass and are not known to fail when the guard is removed.

**Not run, and not claimed:** `pnpm run test:browser` (nothing in the Ops Portal changed); `pnpm audit` (no dependency changed; the last run is recorded under S0.10); every Linux, WSL2 and CI run (OB-62), including the tests that Windows skips, which stay **pending**; the hosted run of the pipeline; the B-05 items the owner holds, which stay **pending**; the release obligations (production provisioning access among them), which stay **pending**; `db:migrate` and `db:seed` against `melarc_dev` (OB-82); any behaviour of an identity operation. **Timing failures, cause unresolved.** During development `execution-budget.db.test.ts`, whose tests depend on the server's own timers, failed once inside a whole-project run and once as a file, a different test each time; other work was loading this workstation at the time, which is an observation and not an established cause. It passed alone eight times (the idle-in-transaction test), six times as a file, in the gate of 10 October and in the run on the corrected tree (a pass is not a diagnosis). These are intermittent failures observed under load: no root cause has been shown, no timeout was raised and no suite was repeated to obtain green. The cause stays open (see the limitations).

**Decisions of the review (10 October 2026).** Rejecting an arm for an unknown principal type: kept, it fits the closed security-context model. Requiring a non-empty array for all seven seed tables: accepted for this reference seed, every current table has required content. The seed content as JSON: accepted for this gate with the trust boundary stated below. Production fixture protection: `FIXTURE_` is a naming restriction, the limitation is explicit below and production provisioning access is settled before release. The unknown-commit HTTP mapping: due before S0.20 (OB-55). The orphan databases: untouched. Expressionless policies (a policy with no `USING` or no `WITH CHECK`): investigated and ruled out as a bypass, PostgreSQL default-denies when no permissive expression grants access; no repair is requested.

**Limitations that remain, and who owns each.**

| Limitation| Owner and milestone|
|---|---|
| **Trust boundary of the seed.** The authorized provisioner chooses the initial content (the JSON document); the database enforces the rules of an initialization (once, into empty tables, atomically, serialized, at revision 1) and **does not verify that the content is the approved catalogue**, which the seed data's Family Z tests and the owner's review hold to its documents. Whether the first content must also be fixed in a migration is decided with the controlled primitive| S0.27 (bundle-change primitive)|
| **`FIXTURE_` is a naming restriction, not an environment restriction.** `melarc.add_reason_fixtures` stays callable with the provisioning credentials wherever they are held, so a production database can receive fixture reasons from anyone who holds them; the production refusal is the command's only. Who holds the provisioning credentials in production, and whether the function exists there, is settled before release| The Product Owner, before release (deployment and release gates)|
| **Orphan test databases.** Four `melarc_test_*` databases with no session remain on the local server (`db:orphans` lists them, nothing was dropped); ownership is not established and cleanup is not authorized| The owner (leave untouched until ownership is established and cleanup is authorized)|
| The unknown-commit outcome has no HTTP mapping yet| The Product Owner, then S0.20 (OB-55)|
| The policy reader accepts two structures; a form a later table needs (the policy template of the first hub-scoped table) is added to the reader with its own safety test| The first slice with a hub-scoped table|
| The readiness probe sends no server-side cancel when its deadline passes; its connection is destroyed and the server's statement timeout bounds the query (a catalogue lookup)| Accepted; revisit with S0.65|
| Settings needed and not settled: the retention periods per category (`OQ-028`), first read by S0.19; the notification and handshake keys (settings.md §7.4), first read by S0.17 and S0.18; the evidence limits and the accounting-export retention are not used by this slice| The Product Owner, at the named task|
| A null tier is unproved against a tier-restricted action until a task compares tiers| S0.27 (OB-75)|
| The workflow reasons are seeded by the slices that use them| Those slices (OB-83)|
| `melarc_dev` has not had migrations 0003 to 0005 or the seed applied| The owner (OB-82)|
| The timeout, restart and cancel figures are development values| S0.65 (benchmark and capacity)|
| Intermittent failures of the timer-based tests in `execution-budget.db.test.ts`, observed twice under load; **the cause is unresolved** (no timeout raised, no repeat-until-green)| The owner; investigate before those tests are relied on as a gate, S0.65 at the latest (OB-91)|

## 8. Pinned tests and documents, and the task that edits each

These say something that becomes untrue when the task named below lands. Edit them in that task, deliberately, and nowhere earlier.

| Pinned thing| Says today| Edited by|
|---|---|---|
| `route-inventory.test.ts` and the sentence in [apps/api/CLAUDE.md](../../apps/api/CLAUDE.md) about the inventory| The inventory holds only the two probes; the first slice adds the permission declaration| S0.22; first real route S0.31|
| `IMPLEMENTED_OPERATIONS` (`implemented-scope.ts`), `openapi.test.ts` (`paths` is `{}`) and `contract-check.process.test.ts` ("0 operations in the implemented scope")| No operation is implemented| S0.31, then each operation's task|
| [e2e/CLAUDE.md](../../e2e/CLAUDE.md), `/api/v1/e2e/*`, the `e2e_harness` table, `journey.spec.ts`| The technical journey exists until the first slice replaces it| S0.45|
| The Ops placeholder `/` tests (`App.test.tsx`, `shell.spec.ts`, `journey.spec.ts`, `components.spec.ts`), [apps/ops-web/CLAUDE.md](../../apps/ops-web/CLAUDE.md), and the list of files that may import the browser client in `no-duplicate-wire-types.test.ts`| `/` is a placeholder; nothing calls the client| S0.38|
| `scripts/` registrations: the explicit `test:root` list and `test-inventory.test.ts`, `REQUIRED_COMMANDS` in `ci-workflow.ts`, the root `CLAUDE.md` line budget (78 of 90 by the guard's count) and the folder map checked by `agent-docs`| A new root test, CI job or top-level folder must be added in each| S0.55 (JVM folder and job), S0.67 (citation inventory)|
| `.env.example`, `env-example.test.ts`, `load-config.ts` and its test, the process-test and harness environments, the DEPLOYMENT configuration table| The keys that exist| S0.2 and every later task that adds a key|
| `identity-decisions`, `contract-consistency`, `real-contract` and `compare-real-operation` tests| The contract of 9 October 2026| Only an intentional contract change, with the contract|
| `ci.yml`, `ci-workflow.test.ts`, `ci-aggregate.ts`, `workspace-pins.ts`, the agent-docs folder map, [DEVELOPMENT.md](../../DEVELOPMENT.md)| Five jobs, one browser origin, no JVM| S0.23 (HTTPS), S0.55 (JVM job and JDK pin)|
| Playwright `testMatch` and `watchPage`| The bootstrap journey| S0.45, S0.46|
| `SEED_ONLY_TABLES` in `src/test-support/registry-grants.ts`| Seven tables only a seed writes| The task that builds the first operation writing each (OB-69)|
| `capability-access.test.ts` ("lets seed read to count and insert") and the provisioning pin of `reference-data.db.test.ts` (`SELECT` and `INSERT` on the seven tables and nothing else)| The seed reads a count and inserts into an empty set; only `RiderIdentity` (a fixture) is insert only| S0.30 and the tasks that build the fixture tables; any task that gives the provisioning login more|
| `COMPOSITION_ROOT` in `src/architecture.test.ts`| `app.module.ts` and `tools/seed/seed-runtime.ts`| A task that adds another process that binds an adapter|
| `integration-kit.test.ts` (no production import of `src/test-support/`, no time setting, no `ports` in `main.ts`)| The application has no time-travel switch| Never relaxed: a task that needs another way to set time changes the design first|
| The lists of `src/tools/seed/` (`permission-keys.ts`, `settings.ts`, `reasons.ts`, `bundles.ts`) and their tests in `seed-data.test.ts`| Each equals the document that owns it: a key, a confirmed setting or a reason added to the document fails the test until the list follows, in one change| Whoever changes `permissions.md`, `settings.md` or `domain-model.md` §3.9|
| The runtime-composition pins of `app.module.test.ts` and the "applied" column of the deadlines map in DEPLOYMENT_AND_ENVIRONMENTS.md §12.5 (`deployment-table.test.ts`)| The runtime composition binds only the `Clock`; the shutdown budget and the database deadlines are applied, the HTTP limits, provider and verifier timeouts and the request budget are not| The task that binds each adapter (OB-38); S0.20, S0.18, S0.55|
| [packages/api-client/CLAUDE.md](../../packages/api-client/CLAUDE.md)| What the client does not do| S0.41|

## 9. Stop conditions and the task handoff

**Stop conditions** are those of the [runbook](BOOTSTRAP_B0_RUNBOOK.md#7-stop-conditions), and also stop the task when: a decision contradicts a retained document it does not override; a product value a task needs is unset (surface it, never default it); a change would break a stable identifier; `contract:check` or `api-client:check` fails for a reason not traceable to the task's own edit; a step needs a machine trust-store or global tool change; the task would touch unrelated work; a port cannot be placed without a new domain; a deadlock appears in a concurrency run (the lock order is then a specification defect for the owner); a package or tool is not already approved.

**Handoff.** End each task in the runbook's [format](BOOTSTRAP_B0_RUNBOOK.md#8-task-handoff-format), extended for this slice:

```text
Task: S0.NN, title
Git: HEAD, branch, and the scope of uncommitted change
Files changed:
Decisions implemented (document and section):
Commands run (exact) and exit codes:
Result: counts; every skipped test with its reason and the environment it needs
Evidence reached, per criterion: fixture/platform verified, or real-operation verified
Obligations closed, and obligations carried (OB-nn)
Checks not run, and why (services, browser, platform)
Problem or blocker, if any:
Findings the Product Owner must decide: conflicts, provisional values, suggestions
```

Raw logs are kept only when they help debugging or CI.

## 10. Owner resolutions — the status of every item

**Nothing is called approved here unless an owner message or a retained owner decision is cited.** The Product Owner's message of 9 October 2026 approved five decisions and authorized one scoped P0 checkpoint commit followed by S0.1 only; it is cited below as *the message of 9 October* with its decision number. The auditor's recommendations in the R4 audit (MELARC_R4_PLAN_AUDIT_2026-10-09.md §3, held outside the repository) were never approval by themselves; the message is. Each approved item is recorded in the document that owns it and is only linked from [§11](#11-decisions-of-9-october-2026-and-where-each-is-recorded).

| #| Item| Status| Authority, and where it is recorded|
|---|---|---|---|
| 1| Reason picker: `listReasonDefinitions` as the 38th operation, its branch applicability and the authoritative `mfa_reset_state` projection| **Approved and applied**| The message of 9 October, decision 1; W1 (a separate `ReasonDefinitionWrite` for the PUT request) is decision 2. [§11.1](#111-listreasondefinitions-as-the-38th-slice-000-operation)|
| 2| Commit of the reconciliation (P0)| **Authorized**| The message of 9 October: one scoped checkpoint commit, not pushed, then S0.1 only. [§11.3](#113-the-reconciliation-commit)|
| 3| Recovery eligibility| **Staff rule: recorded on the owner's instruction. Vendor-organisation extension: approved**| Staff: the instruction of 9 October 2026, “Record the recovery-eligibility decision above in the owning specifications and acceptance criteria, including completion-versus-offboarding races”; the retained specifications held no decision text, so the rule is the one their terminal states entail. Vendor organisation: the message of 9 October, decision 3. [§11.4](#114-vendor-organisation-lifecycle-eligibility)|
| 4| Test CA and browser trust| **Harness authorized; the isolated, disposable spike approved; a persistent machine-wide trust change NOT authorized**| [SLICE-000-FINAL-DECISIONS.md](SLICE-000-FINAL-DECISIONS.md) §11 (F09) and D-17 for the harness; the message of 9 October, decision 4, for the spike. [§11.5](#115-test-ca-and-browser-trust)|
| 5| TOTP QR before staff enrolment acceptance (S0.39c)| **Approved**| The message of 9 October, decision 3; F12 (§14) for the small reviewed encoder. [§11.2](#112-the-local-qr-primitive-before-staff-enrolment)|
| 6| Domain placement| **Approved**| F14 (§16) and D-24 for ports and the composition root; the message of 9 October, decision 3, for thin domain controllers over shared platform authentication logic. [§11.6](#116-where-officer-operations-live)|
| 7| Large tasks as suffix subtasks| **Authorized**| The correction pass of 9 October 2026 (“Use suffix subtasks rather than renumbering the 70 parent IDs”) and D-02 (bounded tasks over a fixed count). The subtask boundaries in [§5](#5-the-tasks) are the plan's and open to review|
| 8| Four tasks added to the approved catalogue (S0.7, S0.27, S0.63, S0.64)| **Obligations authorized; task structure not separately confirmed**| The obligations are the owner's R2 review directions (record the concurrency and actual-runtime-role tests as acceptance obligations; SECURITY_DESIGN §13.10a). That four tasks carry them is the plan's proposal, reviewed by the audit. The message of 9 October authorizes executing S0.1 against this plan, which does not by itself confirm those four tasks|
| 9a| `auth.recovery.requested` as a new audit code| **Authorized**| The owner's R2 correction list (“keep `auth.recovery.requested` with precise semantics”) and the later direction for an unambiguous recovery audit|
| 9b| Refusal codes for identity-reason management| **Approved**| The message of 9 October, decision 3 (“the names/token representation proposed in plan §11.7”): a lower tier is `INSUFFICIENT_AUTHORITY` and an added row or protected field is `VALIDATION_FAILED`, as [permissions.md](../../contracts/permissions.md) §7 and `upsertReasonDefinition` read. Direction: the R2 list item “Platform-Admin-only identity reason management” and D-12|
| 9c| QR payload, field order and sizes| **Approved**| C-08 and C-09 (the exact URI, a 32-byte challenge) and the R2 list item on the exact QR size and encoding; the grant and recovery **token** at 32 random bytes shown as 43 base64url characters (SECURITY_DESIGN §14.9) by the message of 9 October, decision 3|
| 9d| When a reducing release raises the floor| **Approved**| The owner's R2 follow-up review accepted the conservative fixed-policy rule; the sentence “the floor is raised no later than the step that first lets an instance with the new revision serve traffic” (SECURITY_DESIGN §13.10) by decision 3|
| 9e| `DESTINATION_NOT_ALLOWED` outcome class| **Approved**| The controlled real-provider validation window (R2 review direction; DEPLOYMENT §4.1); the closed, non-secret outcome class `DESTINATION_NOT_ALLOWED` for a send to a destination outside the allow-list, a terminal job outcome, by decision 3|
| 9f| `policy_superseded` as a `/readyz` reason| **Approved**| The instance refusing a type is “not ready”; the reason string `policy_superseded`, by decision 3|
| 9g| `credential_delivery_job` table and its worker capability `credential_delivery`| **Approved**| F02 (§4: a durable encrypted delivery job in PostgreSQL, a separate Node worker) and F06 (§8: an explicit credential-delivery capability); the names by decision 3|
| 10| Owner inputs the plan waits on| **Awaited**| The two bootstrap custodians (S0.30, SLICE-000 §6.1); the accessibility passes (S0.28); an eligible hardware-backed handset (S0.61); approval of the measured capacity values (S0.65); for the release gates, the providers, attestation roots, package name, signing digest, KMS key and pepper (§7.2). These are inputs, not decisions|
| 11| Values called provisional until S0.65| **Resolved by correction (R4-05)**| Measured engineering parameters are development-qualified at their first consumer; S0.65 calibrates and proposes release values and depends on them ([§3](#3-rules-every-task-keeps)). Product decisions stay the owner's|
| 12| Stale task numbers in the decisions file| **Resolved by correction (R4-07)**| Active references updated, history labelled, map in [§12](#12-old-to-new-task-numbers)|
| 13| **Linux, WSL2 or CI evidence for the new worker, custody-file and JVM tests (OB-24 to OB-26)**| **Decided: required at the named gates, no new waiver**| The message of 9 October, decision 5: OB-24 before Gate 2 (S0.19) passes, OB-25 at S0.30, OB-26 at S0.55. The bootstrap's waivers (runbook items 4 to 7) name existing tests and their milestones only and are not extended. Until the evidence exists the gate that needs it is not passed|
| 14| Checks this plan has not run| **Stated**| `test:db`, `test:browser`, `test:e2e` and the Linux-only tests are reported with each task's results; no Slice-000 task had been started when this plan was committed as the P0 checkpoint|
| 15| Deadline ownership and the execution budget (S0.6, S0.20, S0.65)| **Decided**| The Product Owner's instruction of 9 October 2026 closing S0.2. [§11.8](#118-deadline-ownership-and-the-execution-budget); OB-37|
| 16| S0.2's provisional-default wording, and managed key custody as a prerequisite of G3| **Accepted**| The same instruction. The wording is in the S0.2 block and in DEPLOYMENT_AND_ENVIRONMENTS.md §12.5; OB-36 and the G3 row of [§7.2](#72-release-gates--not-acceptance-of-this-slices-code)|

## 11. Decisions of 9 October 2026 and where each is recorded

The Product Owner approved the decisions below on 9 October 2026. Each fact has one owning document, so this section names the document and states only what the plan itself does with the decision; it does not restate the rule. The earlier pending proposals and their exact diffs are replaced by the applied text.

### 11.1 `listReasonDefinitions` as the 38th Slice-000 operation

**Approved (decisions 1 and 2).** `listReasonDefinitions` (`GET /reason-definitions`, permission `settings.reason.read`) is the 38th operation the slice builds, with its branch applicability and the authoritative `StaffIdentity.mfa_reset_state` projection. The request body of `upsertReasonDefinition` is a separate `ReasonDefinitionWrite` schema (**W1**) that carries every writable field and none of the response-only metadata; the general `ContractValidator` is unchanged.

**Where it is recorded.** [contracts/openapi.yaml](../../contracts/openapi.yaml) (version 5.77: the `operation` and `branch` filters, the `400`, `ReasonDefinition.permittedOperations`, `ReasonDefinitionWrite`, `StaffIdentity.mfa_reset_state`); [domain-model.md](../../contracts/domain-model.md) §3.9 (the branch-qualified registry entries and the four changed seed rows) and §6.8 (the projection); [state-machines.md](../../contracts/state-machines.md) §18 (one rule decides both the projection and `resetStaffMfa`); [permissions.md](../../contracts/permissions.md) §7 (scope in practice); [ops-portal.md](../../surfaces/ops-portal.md) (the five routes that take a reason); [SLICE-000.md](../slices/SLICE-000.md) §1.1 and §7; [permission-enforcement.md](../../features/identity/permission-enforcement.md) (`AC-SLICE-000-132`); [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md) §4c (what `SLICE-013` owes).

**What the plan does with it.** The operation joins **S0.35** as a fourth read, in `src/settings/`; S0.35 also builds the one eligibility function behind `mfa_reset_state`, which S0.36 returns on every `StaffIdentity` and S0.37's `resetStaffMfa` calls. **S0.41 Needs S0.35**, and S0.44, S0.52 and S0.60 reach it through S0.41. `AC-SLICE-000-132` completes at **S0.59**, because its Rider-session clause needs a Rider session. The slice's counts are now **38 operations and 126 criteria**; the contract has **172 operations and 175 schemas**. No catalogue mutation is added and `upsertReasonDefinition` is out of scope: the refusals it owes are obligation OB-34 and the `SLICE-013` row of §4c.

**One clarification the projection made explicit.** `NOT_ELIGIBLE` includes an identity that is not `ACTIVE` or `SUSPENDED`. A `PENDING_APPROVAL` or `REJECTED` identity holds no factor and was already not eligible; `OFFBOARDED` is terminal and was not named by the earlier text of `resetStaffMfa`. [state-machines.md](../../contracts/state-machines.md) §18 now states it, and the Product Owner should confirm it (it is listed in the handoff of the P0 commit).

### 11.2 The local QR primitive before staff enrolment

**Approved (decision 3).** The reusable QR encoder and its independent test decoder are **S0.39c**, built before S0.43 and reused at S0.60. Staff enrolment shows the QR and the secret for manual entry together (the manual secret is the accessible alternative). Both are transient credentials: no remote QR service, no analytics, no persistence, no ordinary navigable `otpauth` link, cleared on navigation, completion and expiry, and covered by the sentinel tests of S0.39b.

### 11.3 The reconciliation commit

**Authorized (the message of 9 October).** One scoped P0 checkpoint commit of the reconciliation, preserving unrelated work and excluding secrets, local evidence and archives, **not pushed**; then **S0.1 only**, which is not committed and is not followed by S0.2. The commit hash is reported in the handoff and not written here, because a document cannot contain the hash of the commit that holds it.

### 11.4 Vendor-organisation lifecycle eligibility

**Approved (decision 3).** A vendor account may recover only while its linked `VendorOrganization` is `ACTIVE` or `SUSPENDED`; `REJECTED`, `TERMINATED` and the pre-approval states are answered like an unknown identifier (an administrator gets `STATE_CONFLICT`); recovery reactivates nothing. The rule is recorded in [credential-recovery.md](../../features/identity/credential-recovery.md) §5.7 and AC-121, [state-machines.md](../../contracts/state-machines.md) (the `VendorOrganization` note), [domain-model.md](../../contracts/domain-model.md) (the `RecoveryRequest` invariant), [audit.md](../../contracts/audit.md) §5.4, [openapi.yaml](../../contracts/openapi.yaml) (`requestCredentialRecovery`, `recoverVendorCredential`), [security-test-matrix.md](../../standards/security-test-matrix.md) `GBT-B15`, [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.9a and [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md) §4c. `SLICE-008` owes the real transition that rejects or terminates an organisation and ends the account's recovery material in its own transaction; Slice-000 builds and tests the consumer-side guard with a fixture, which is not proof of a termination endpoint. Staff offboarding is unchanged and owed to `SLICE-009`.

### 11.5 Test CA and browser trust

**Approved (decision 4), for an isolated, disposable spike only.** S0.23 opens with a bounded spike that records, per engine (Chromium, Firefox, WebKit, branded Chrome and Edge), which mechanism works and what it proves: a disposable test environment or an isolated browser profile or context that trusts the locally generated CA, with real certificate validation (a negative test with an untrusted CA must fail) and never `ignoreHTTPSErrors` as trust evidence. **This does not authorize a persistent machine-wide trust change**; one needs the owner's authorization of an exact installation and removal plan first. Safari itself stays a manual check.

### 11.6 Where officer operations live

**Approved (decision 3).** Controllers for what an officer does to another principal are thin and live in the permission domain that owns the key's first segment (`staff`, `vendor`, `settings`); `dispatch` serves the two rider reads. The shared session, MFA and recovery logic stays in `platform/auth` behind the S0.1 ports. `dispatch` reads the staff-owned rider data through a read port; there is no second identity store and no duplicated business logic. This is the placement of [§3](#3-rules-every-task-keeps) and [§6.1](#61-operations).

### 11.7 The names and sizes in rows 9b to 9g of §10

**Approved together (decision 3).** The refusal codes for identity-reason management as written in `permissions.md` §7 and `upsertReasonDefinition`; the token of 32 random bytes shown as 43 base64url characters; the floor-timing sentence of SECURITY_DESIGN §13.10; the outcome class `DESTINATION_NOT_ALLOWED`; the readiness reason `policy_superseded`; the table `credential_delivery_job` and its worker capability `credential_delivery`. Each is written in the owning document and in the contract; S0.5, S0.17 and S0.26 use these names.

### 11.8 Deadline ownership and the execution budget

**Decided by the Product Owner on 9 October 2026, closing S0.2** (row 15 of §10; nothing here is implemented yet). The settings are in [DEPLOYMENT_AND_ENVIRONMENTS.md](../../architecture/DEPLOYMENT_AND_ENVIRONMENTS.md) §12.5, "Deadlines", which owns their meaning; this section records who builds what.

- **S0.20 owns the HTTP header and body receipt limits and HTTP admission** (the byte limit, the admission deadline and concurrency, the trusted-proxy setting). They end a slow sender and bound nothing a handler does.
- **S0.6 owns the database and resource deadlines and the shared execution-budget mechanism. S0.20 integrates that mechanism into the request pipeline** (S0.20 therefore needs S0.6).
- **Database timeouts alone do not bound a whole request.** Time outside the database (a provider or verifier call, hashing, the application's own work) is outside them, so a request needs a budget of its own.
- **Enforcing an execution budget is not racing a response against a timer.** The mechanism must say what an expiry does to work already running: cancel what can be cancelled; roll back the open transaction and discard a connection of uncertain state ([SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §14.6); and keep a late side effect (a commit, an outbound call, an audit or delivery enqueue) from taking effect, or record it, after the caller was told the request failed. Its tests (S0.6 for the mechanism with a real database, S0.20 for the pipeline over real HTTP) expire a budget mid-work and observe the result on a second connection. This is **OB-37**.
- **Concrete values are qualified at their first use** (§3) and **calibrated in S0.65**, which proposes release values for the owner's approval. S0.2's numbers are provisional, configuration-validated defaults and nothing more.
- **Accepted as written:** S0.2's provisional-default wording, and managed key custody (implementation, rotation proof, recovery proof) as a prerequisite of G3 (OB-36).
- **Not implemented by S0.2:** any future deadline task. No execution-budget setting exists yet; S0.6 chooses it with its mechanism.

### 11.9 The review of S0.3 (9 October 2026)

The owner's review of S0.3 corrected it before it was committed. What the plan itself does with the decisions:

- **The Argon2id profile comes from configuration.** `ARGON2_*` are settings validated at start, with a floor for deployed environments, so S0.3's files include `platform/config/*`, `.env.example` and the DEPLOYMENT table, and its run codes are B D E. The profile, its measurement and the floor are in [DEPLOYMENT_AND_ENVIRONMENTS.md](../../architecture/DEPLOYMENT_AND_ENVIRONMENTS.md) §12.5; confirming the floor is OB-42.
- **Verifying a hash and permitting its replacement are separate decisions.** A stored hash is derived only at a supported profile, and is rewritten only forward: a newer pepper at an unchanged cost, or a larger cost at the same lanes. A changed profile is never assumed to be a stronger one.
- **The envelope version is stored** with every sealed value (the `SealedSecret` port carries it), before any record exists.
- **The production `Clock` adapter is S0.6's**, not left unowned.
- **The real-versus-dummy verification cost difference during a cost migration is documented, not hidden**, and is assessed before a migration is enabled (OB-41). Counting derivations proves their number and not equal work, and nothing sleeps or hashes twice to make branches look alike.

## 12. Old-to-new task numbers

[SLICE-000-FINAL-DECISIONS.md](SLICE-000-FINAL-DECISIONS.md) and the [readiness audit](MELARC_SLICE_000_READINESS_AUDIT_2026-10-08.md) use the numbers of the draft plan they reviewed. Active references in the decisions file are updated; the audit's body is history and is labelled as such. **The identifiers of this plan are stable from here: a split adds a suffix (S0.3a) and never renumbers a parent.**

| Draft| Subject| Now| Draft| Subject| Now|
|---|---|---|---|---|---|
| 0, 1| Reconciliation and contract amendments| done (Stage R)| 27| `resetStaffMfa` and sessions administration| S0.37|
| 2| Ports, configuration, metrics| S0.1, S0.2, S0.15| 28| Ops session foundation| S0.38|
| 3| Cryptography| S0.3| 29| Forms and secret hygiene| S0.39|
| 4| Database context, roles, deadlines| S0.4, S0.5, S0.6| 30| Table, confirmation, shell| S0.40 to S0.42|
| 5| Reference-data schema| S0.8 (and S0.7, new)| 31| Pre-sign-in screens| S0.43|
| 6| Seeds| S0.9| 32| Signed-in screens| S0.44|
| 7| Integration kit| S0.10| 33| Harness over HTTPS| S0.45|
| 8| Audit writer| S0.11| 34| Staff journeys| S0.46|
| 9| Idempotency and replay| S0.12| 35| Vendor fixture, reads, setup| S0.47|
| 10| Settings and reasons| S0.13| 36| `vendorSignIn`| S0.48|
| 11| Limiter and hash admission| S0.14, S0.16| 37| Vendor browsers| S0.49|
| 12| Accessibility evidence| S0.28| 38| `requestCredentialRecovery`| S0.50|
| 13| Detached delivery (replaced)| S0.17 to S0.19| 39| Completion and administrator recovery| S0.51|
| 14| Transport admission, HTTP primitives| S0.20, S0.21| 40| Recovery and vendor screens| S0.52|
| 15| Guard chain| S0.22| 41| Rider fixture and registration| S0.53|
| 16| Sessions| S0.24| 42| Device-key protocol, verifier (custom DER dropped)| S0.54, S0.55|
| 17| CSRF and Origin| S0.25| 43| Trust data| S0.56|
| 18| Authorization| S0.26| 44| `completeRiderDeviceEnrolment`| S0.57|
| 19| Setup grants and MFA factors| S0.29| 45| `revokeRiderDevice`| S0.58|
| 20| Bootstrap seed| S0.30| 46| Rider sign-in| S0.59|
| 21| Setup operations| S0.31| 47| QR and rider screens| S0.60 (QR primitive: S0.39c)|
| 22| `staffSignIn`| S0.32| 48| Browser journeys 7 to 15| S0.62|
| 23| `completeStaffMfaSignIn`| S0.33| 49| Security-matrix sweep| S0.66|
| 24| Session read and sign-out| S0.34| 50| Contract sweep and citations| S0.67|
| 25| Staff reads| S0.35| 51| Metrics endpoint and alerts| S0.68|
| 26| Create, approve, re-issue| S0.36| 52, 53| Documentation sweep, local walk| S0.69, S0.70|

New since the draft: S0.7 (policy toolkit), S0.23 (trusted HTTPS harness), S0.27 (bundle-change primitive), S0.61 (handset evidence), S0.63 (two-build proof), S0.64 (concurrency and privilege run), S0.65 (benchmark) and the suffix subtasks of [§5](#5-the-tasks).

