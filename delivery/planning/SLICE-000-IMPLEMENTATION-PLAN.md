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
| Verification of the P0 state (9 October 2026, Windows)| Uncached (`TURBO_FORCE=true`). All exit 0: `format:check`, `lint`, `typecheck`, `build`, `contract:check` (0 operations compared: that proves the checking machinery and says nothing about future identity conformance), `api-client:check` (after `api-client:generate` from contract 5.77), `db:check`, `pnpm test` (root 1179 passed and 2 skipped, API 1699 passed and 5 skipped, Ops 220, api-client 250, harness 191 passed and 1 skipped) and `pnpm run test:browser` over Chromium, Firefox and WebKit (74 passed, 1 skipped: WebKit cannot emulate forced colours); `pnpm audit --audit-level high` exits 0 and reports one moderate advisory (GHSA-67mh-4wv8-2f99, `esbuild` 0.18.20 through `drizzle-kit`, a development tool; analysed in the handoff, not changed here). The pinned wording tests prove wording only; seven deliberate breaks of the contract and documents were each caught by the new I24 tests. **Not run:** `test:db` and `test:e2e` (PostgreSQL was not reachable; it is the developer's to start with `pnpm run infra:up`); every Linux-only test (five API process tests, one `test:db` test, one harness test, the symlink test, the POSIX-mode test), which need Linux, WSL2 or CI; and every Slice-000 task|
| The R4 audit| `MELARC_R4_PLAN_AUDIT_2026-10-09.md`, supplied by the owner and held outside the repository (not in the archive). This plan was corrected against it the same day; [§10](#10-owner-resolutions--the-status-of-every-item) gives the status of every item it raised|
| The R4 correction review| `MELARC_R4_CORRECTION_REVIEW_2026-10-09.md` was **not available** to the follow-up pass (searched in the owner's Downloads, Desktop and Documents, `E:/Projects`, the repository and the session files). The pass followed the five directions of the owner's prompt, which name C-01 to C-04; any finding of that review beyond them is unknown to this plan|

## 2. What exists today, and what is future behaviour

Read from the repository on 9 October 2026 (HEAD `9c34b69` plus the uncommitted reconciliation), not from the documents. **Nothing in 2.2 or 2.3 exists in code.** A task in [§5](#5-the-tasks) says which of 2.1 it reuses and which of 2.2 it creates.

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

**Graph check (generated by a script kept outside the repository, run on the day this section was written).** The graph has 70 parent tasks and 40 suffix subtasks (385 dependency edges; a parent depends on all its subtasks and a subtask on the parent's Needs plus its own). It has no cycle, no unknown or later reference, and no orphaned mandatory task: every task reaches S0.70 except S0.61, which is deferred evidence by design. Retention cleanup (S0.19) is an ancestor of S0.29, the first task that builds grant-issuing code, and so of the bootstrap seed, the MFA continuation grants and every later issuing task, and of S0.70. Nothing is deferred by inference: S0.61 alone sits outside S0.70's ancestry, by the explicit decision of [SLICE-000-FINAL-DECISIONS.md](SLICE-000-FINAL-DECISIONS.md) §20. Every task of a stage is an ancestor of that stage's gate task, apart from the two independent items. Each of the 38 operations and the 126 criteria is owned by exactly one parent task.

**The order follows the decisions of 8 October 2026**: reconcile, then ports, configuration, cryptography, database boundaries and the test kit; then audit, idempotency, authoritative limiting and bounded hashing; then **durable credential delivery and its retention before any operation that issues a credential**; then the request pipeline, trusted HTTPS and the accessibility baseline; then the staff vertical path, administration and recovery; then the vendor API; then the attestation verifier and the rider; then the composed UI, the sweeps and the walk. Independent preparation is kept: within a stage a task may start as soon as its Needs are done, and the owner evidence of S0.28 can run beside everything.

| Task| Title| Needs| Run|
|---|---|---|---|
| | **Stage 1 — Foundations**| | |
| [S0.1](#s01--ports-placement-and-the-composition-root)| Ports, placement and the composition root| P0| B|
| [S0.2](#s02--configuration-key-material-and-the-describe-composition)| Configuration, key material and the describe composition| S0.1| B D E|
| [S0.3](#s03--cryptography-and-credential-normalisation)| Cryptography and credential normalisation| S0.2| B|
| S0.3a| ↳ Qualify `crypto.argon2` on the pinned Node, then `Hasher`, the credential rule and the email canonical form| parent's| B|
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
| [S0.20](#s020--transport-admission)| Transport admission| S0.2, S0.14, S0.16| B D|
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
**Newly builds.** Purpose-separated, versioned key material (TOTP seeds, delivery payloads, replay payloads, limiter pseudonymisation, the password pepper); the Ops and Vendor origins and link templates; trusted-proxy setting (default off); body limits and deadlines; the database deadline relations ([SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §14.6) validated at start; the worker and verifier endpoints; production refusal of an absent key, a test adapter, the capture adapter and the in-memory limiter ([DEPLOYMENT_AND_ENVIRONMENTS.md](../../architecture/DEPLOYMENT_AND_ENVIRONMENTS.md) §12.3); the **inert describe adapters** for every S0.1 port and their wiring into the describe composition (the S0.1 tokens bound to adapters that never connect to a database or a provider, never deliver and never resolve a secret). Each fails clearly, with a named error, if a runtime operation is invoked on it, and each is **refused by production configuration** exactly as a test adapter is, so none can be used as a production adapter; redaction of every new key. Every resource bound this task introduces gets a concrete development value, qualified as the engineering-parameter rule of §3 requires.
**Files.** `platform/config/*`, `.env.example`, `apps/api/src/tools/describe-config.ts`, `scripts/setup-env*` and its tests, the harness environment in `e2e/`, the DEPLOYMENT configuration table.
**Evidence.** Unit tests per refusal; `env-example.test.ts` fails when a key is missing from the example; describe output is asserted free of values. **Exit condition:** a test invokes every describe adapter and sees the clear failure with no socket opened; `contract:check`, `openapi:generate` and the default test application resolve every S0.1 port; production configuration refuses a describe adapter. *Fixture/platform verified*.
**Does not.** Generate or print a production key; open a connection; read a secret during describe.
**Stop if.** A key purpose needs a value the documents leave unset (surface it; never default it).

#### S0.3 — Cryptography and credential normalisation

| | |
|---|---|
| **Needs**| S0.2 |
| **Run**| B |
| **Operations**| none |
| **Criteria**| none |

**Subtasks.** The parent is done when every subtask is, and keeps the parent's operations, criteria and gate; a subtask's fixture proof never completes a parent criterion. The parent's *Needs* apply to every subtask; *Also needs* adds to them.

| Subtask| Delivers| Also needs| Run| Evidence it reaches|
|---|---|---|---|---|
| S0.3a| Qualify `crypto.argon2` on the pinned Node, then `Hasher`, the credential rule and the email canonical form| none| B| fixture/platform verified|
| S0.3b| `TokenService` (tokens, SHA-256 at rest, constant-time compare) and `randomUUIDv7`| none| B| fixture/platform verified|
| S0.3c| `TotpVerifier` (RFC 6238, injected UTC clock, replay-step tracking)| none| B| fixture/platform verified|
| S0.3d| `SecretCipher` (AES-GCM, purpose-separated keys, key version, rotation)| none| B| fixture/platform verified|

**Builds on.** Nothing: production code uses `randomUUID` for the request id and one SHA-256 for migration history, and `TestClock` exists only in the harness. `dependency-policy.test.ts` allows exact versions only and no install scripts, so the Argon2id implementation is **qualified first**: Node's built-in `crypto.argon2`, which [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.4c names, is checked to exist on the pinned Node 24.21.0 and measured before any package is proposed (a new package is a stop condition).
**Newly builds.** The `Hasher` adapter (asynchronous Argon2id, versioned pepper, parameters from configuration), `TokenService` (high-entropy tokens, SHA-256 at rest, constant-time compare), `TotpVerifier` (RFC 6238, injected UTC wall clock, replay-step tracking), `SecretCipher` (AES-GCM envelopes with purpose-separated keys, key version and authenticated data), `randomUUIDv7`; the **credential rule** of [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.4a (NFKC, raw and normalised bounds of 12 to 128 code points, lone surrogates rejected, never trimmed or case-folded) and the **work-email canonical form** (trim, NFKC, whole-address lower case, no dot or plus folding).
**Files.** `src/platform/auth/crypto/*`, `src/platform/auth/credentials/*` and their tests; a single-hash benchmark script under `apps/api/src/tools/`.
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
**Files.** `platform/database/*`, `migrations/` (a new migration for the accessors), `test/support/e2e-main.mjs`, [data-scope-registry.md](../../contracts/data-scope-registry.md) rows for any table touched.
**Evidence.** DB tests under the runtime login: the existing Family A suite extended to the new settings (a pool of one never leaks context), Family B-partial (a malformed principal fails closed by abort, `GBT-B10`, `B11`), Families E and J. *Fixture/platform verified*; real-operation evidence waits for the first operation.
**Obligations carried.** `GBT-B10`, `B11`, `E`, `J` for the capabilities added here: **D, not run**.
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
**Files.** a new migration, `tools/database/provisioning.ts`, `catalog-invariants.ts`, `migration-lint.ts`, `platform/database/database.service.ts` and their tests, [MIGRATION_AND_SEEDING.md](../../architecture/MIGRATION_AND_SEEDING.md) §5.1 only if the roles differ from it.
**Evidence.** Catalogue tests run **as each actual login**, never as the owner (Families J, K, Y). *Fixture/platform verified*.
**Obligations carried.** Families J, K, Y for the roles added: **D, not run**.
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
**Newly builds.** Per-connection statement, lock and idle-in-transaction timeouts (lock inside statement inside transaction, [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §14.6); bounded pool waiters; HTTP header and request timeouts; a connection whose state is uncertain is discarded; a request that exceeds a deadline answers the platform's generic operational failure. Concrete development and test values are chosen here, each recorded with its environment and the test that exercises it (development-qualified, not production-qualified); S0.65 proposes the deployment values.
**Files.** `platform/database/database.module.ts`, `platform/config/*`, `create-app.ts` and `main.ts` for the HTTP timeouts, `.env.example`, and their tests.
**Evidence.** DB tests that hold a lock past the timeout and assert the failure and the connection's disposal. *Fixture/platform verified*.
**Obligations carried.** Deadline relations at the deployed topology (G2).
**Does not.** Choose production values.
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
**Evidence.** Unit tests for merge, order and collision handling; DB tests under the runtime login for the leaked-lock check (Family A), `lock_timeout` expiry, the isolation guard and a concrete restart bound, chosen and recorded here with its environment, whose attempts together fit **one total operation deadline**; this task does not wait for S0.65. *Fixture/platform verified*.
**Obligations carried (§13.10a).** 5, 6, 7, 9, 11, 12: **D, not run** until S0.27 and S0.64 apply them to real policy rows.
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
**Evidence.** Under the runtime login: `UPDATE` on `role_bundle`, `role_bundle_grant`, `fixed_permission_policy` is refused, `SELECT … FOR SHARE` is refused, the advisory functions run, and the catalogue shows no `UPDATE` grant on them (§13.10a obligation 1). Families F, K, S. *Fixture/platform verified*.
**Obligations carried.** §13.10a 1: **D, not run**; repeated for the final surface in S0.64.
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
**Newly builds.** The seed helper (writes as `SYSTEM` under the `seed` capability, refuses when the table is not empty); the closed permission catalogue as inert data; the confirmed staff bundles and the fixed Vendor and Rider bundles with per-grant explicit hub scope; the two `FixedPermissionPolicy` rows; settings with approved values (a Family Z comparison with [settings.md](../../contracts/settings.md)); one hub with its default zone; the **twelve identity reason rows** of [domain-model.md](../../contracts/domain-model.md) §3.9, four of them with a branch-qualified `permitted_operations` entry. Every key created is taken **exclusive** by the seed (§13.10a). Test-only fixtures live apart, are named as fixtures and are refused in production.
**Files.** `platform/database/seed/*` (the helper and its `SYSTEM` policy branches), `tools/seed/*` (the data and the command), `apps/api/package.json`, a new migration for the policy branches, [apps/api/CLAUDE.md](../../apps/api/CLAUDE.md), and tests.
**Evidence.** Seeding twice refuses; a production configuration refuses the fixtures; the seeded catalogue equals [permissions.md](../../contracts/permissions.md) (a derived comparison, not a copied count). *Fixture/platform verified*.
**Obligations carried.** Family E: `GBT-E6` (the API runtime sets the `seed` label and still cannot write a seed-only table) and `GBT-E7` (every `SYSTEM` policy branch names one capability): **D, not run**.
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
**Evidence.** The kit's own tests: aging a row by SQL, a refusal read from a second connection, the capture reader empty by default. **Gate 1:** `pnpm run test:db` green on the developer's database.
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
| **Needs**| S0.2, S0.14, S0.16 |
| **Run**| B D |
| **Operations**| none |
| **Criteria**| none |

**Builds on.** `createApp` (the Nest body parser is off; JSON only), `platform/http/json-body.ts` (`requireUtf8Json` answers `415` for a non-UTF-8 charset, the `__proto__` reviver, a byte-count recorder), `not-found-fallback.ts` and `all-exceptions.filter.ts`. There is **no** size limit, no compression refusal, no header or body deadline and no trusted-proxy setting today.
**Newly builds.** The admission layer **before** routing and guards: JSON only, compressed bodies rejected, byte limits including chunked bodies, header and body deadlines, admission concurrency, bounded extraction of the identifier a limiter needs, a parse failure carried as a marker to the validation stage (a malformed body is `VALIDATION_FAILED`, not an early reply), and code-less `413` and `415` ([SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §14.8).
**Files.** `create-app.ts`, `platform/http/admission/*`, `platform/config/*` and tests.
**Evidence.** Real-HTTP tests (not mocks) for each refusal, including a slow-header client and a chunked body over the limit. *Fixture/platform verified*.
**Obligations carried.** Edge and trusted-proxy behaviour: release gate **G2**.
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

**Newly builds.** The integrated measurement of hashing, database contention, the limiter, the deadlines and NAT behaviour on a **recorded machine**. It calibrates the development-qualified values of S0.2, S0.3, S0.6, S0.7, S0.14 and S0.16 and proposes, for the owner's approval ([settings.md](../../contracts/settings.md) §9), the release-capacity values: the Argon2id parameters, hash-admission capacity, the edge ceiling, the transport capacity and the deadline values. It **depends on** those tasks and none of them waits for it. A measured engineering parameter is proposed here; an unresolved product decision (for example the value of the edge ceiling) is the owner's and is never invented. A hub count in the session display is measured here and not before.
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

### 7.2 Release gates — not acceptance of this slice's code

Each gate must exist before the exposure it names. **None blocks the local walk** (S0.70), and the local walk **waives none of them** ([SLICE-000.md](../slices/SLICE-000.md) §7 items 5 and 6).

| Gate| Needed before| What it is| Owner input|
|---|---|---|---|
| **G1**| Production identity use| Signed audit checkpoints with independent storage and monitoring ([audit.md](../../contracts/audit.md) §2.1)| Backend Engineer; storage choice|
| **G2**| External authentication exposure| Edge, trusted-proxy and load evidence; the shared limiter at the deployed topology; the measured capacity values approved (OB-31)| Product Owner approves values|
| **G3**| Staging release evidence| Real secrets and providers, a restore and key-rotation rehearsal, the controlled real-provider window of [DEPLOYMENT_AND_ENVIRONMENTS.md](../../architecture/DEPLOYMENT_AND_ENVIRONMENTS.md) §4.1 (a non-production credential, allow-listed recipients, a recorded approval; a refused destination is `DESTINATION_NOT_ALLOWED`), and the release inputs: an SMS and an email provider (`OQ-048`), the accepted Android attestation roots, the Rider package name and first signing-certificate digest, the KMS key and the Argon2id pepper| Product Owner; Release owner|
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

## 8. Pinned tests and documents, and the task that edits each

These say something that becomes untrue when the task named below lands. Edit them in that task, deliberately, and nowhere earlier.

| Pinned thing| Says today| Edited by|
|---|---|---|
| `route-inventory.test.ts` and the sentence in [apps/api/CLAUDE.md](../../apps/api/CLAUDE.md) about the inventory| The inventory holds only the two probes; the first slice adds the permission declaration| S0.22; first real route S0.31|
| `IMPLEMENTED_OPERATIONS` (`implemented-scope.ts`), `openapi.test.ts` (`paths` is `{}`) and `contract-check.process.test.ts` ("0 operations in the implemented scope")| No operation is implemented| S0.31, then each operation's task|
| `apps/api/test/support/e2e-main.mjs` use of the public `db` handle| The harness reaches the pool directly| S0.4|
| [apps/api/CLAUDE.md](../../apps/api/CLAUDE.md) on the seed helper| The helper and its `SYSTEM` branches arrive with the first slice that has a table| S0.9|
| [e2e/CLAUDE.md](../../e2e/CLAUDE.md), `/api/v1/e2e/*`, the `e2e_harness` table, `journey.spec.ts`| The technical journey exists until the first slice replaces it| S0.45|
| The Ops placeholder `/` tests (`App.test.tsx`, `shell.spec.ts`, `journey.spec.ts`, `components.spec.ts`), [apps/ops-web/CLAUDE.md](../../apps/ops-web/CLAUDE.md), and the list of files that may import the browser client in `no-duplicate-wire-types.test.ts`| `/` is a placeholder; nothing calls the client| S0.38|
| `scripts/` registrations: the explicit `test:root` list and `test-inventory.test.ts`, `REQUIRED_COMMANDS` in `ci-workflow.ts`, the root `CLAUDE.md` line budget (78 of 90 by the guard's count) and the folder map checked by `agent-docs`| A new root test, CI job or top-level folder must be added in each| S0.55 (JVM folder and job), S0.67 (citation inventory)|
| `.env.example`, `env-example.test.ts`, `load-config.ts` and its test, the process-test and harness environments, the DEPLOYMENT configuration table| The keys that exist| S0.2 and every later task that adds a key|
| `identity-decisions`, `contract-consistency`, `real-contract` and `compare-real-operation` tests| The contract of 9 October 2026| Only an intentional contract change, with the contract|
| `ci.yml`, `ci-workflow.test.ts`, `ci-aggregate.ts`, `workspace-pins.ts`, the agent-docs folder map, [DEVELOPMENT.md](../../DEVELOPMENT.md)| Five jobs, one browser origin, no JVM| S0.23 (HTTPS), S0.55 (JVM job and JDK pin)|
| Playwright `testMatch` and `watchPage`| The bootstrap journey| S0.45, S0.46|
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

