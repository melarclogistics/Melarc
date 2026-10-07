# Melarc Bootstrap B0 Runbook

> **Status:** ACTIVE
> **Version:** 1.0
> **Date:** 4 October 2026
> **Repository path:** `delivery/planning/BOOTSTRAP_B0_RUNBOOK.md`
> **Companion:** `delivery/DEVELOPMENT_EXECUTION_PLAN.md`

## 1. Purpose

This runbook turns the Bootstrap roadmap into a simple manual development workflow.

Work on one bootstrap task at a time.

For each task:

1. understand the purpose;
2. run only the requested commands or edits;
3. return the actual result;
4. fix any failure before proceeding;
5. commit a coherent working increment when instructed.

Do not execute later bootstrap steps early because their commands are visible here.

## 2. Current development baseline

The project has been moved to a new Git repository for implementation.

The active repository retains the product and technical specification set:

- `PROJECT_MASTER_SPECIFICATION.md`;
- `architecture/`;
- `contracts/`;
- `features/`;
- `surfaces/`;
- `standards/`;
- `delivery/IMPLEMENTATION_PLAN.md`;
- `delivery/slices/`;
- `registers/GLOSSARY.md`;
- this execution plan and runbook.

Historical governance, approval, audit and tracking machinery is outside the active development repository.

### B0.0 — repository reset and cleanup

B0.0 consists of:

- establishing the new repository;
- keeping the development-authoritative specification set;
- removing stale links and references to retired process files;
- updating Git ignore/attribute rules for application development;
- validating the retained documents;
- making the initial development-baseline commit;
- connecting the new remote.

No application code belongs in B0.0.

B0.1 starts only after the cleaned baseline is committed.

## 3. Manual execution rule

ChatGPT provides the next bounded task.

A task response should normally contain:

- the exact command output requested;
- any error text;
- a short note if the observed result differs from the expected result.

Do not hide or paraphrase failures.

If a task fails, stop dependent work. Independent investigation or a narrowly scoped fix may proceed.

## 4. Bootstrap sequence

## B0.1 — Workspace and tooling

### Objective

Create the TypeScript monorepo foundation without implementing business behavior.

### Expected additions

- root `package.json`;
- `pnpm-workspace.yaml`;
- `pnpm-lock.yaml`;
- runtime/package-manager pinning;
- TypeScript configuration;
- lint/format configuration;
- Turborepo configuration when introduced;
- root scripts;
- initial CI workflow;
- `apps/` and `packages/` only where immediately useful.

### Validation

At minimum:

- package manager version is known;
- dependency installation succeeds;
- frozen install succeeds after the lockfile exists;
- root typecheck/lint/test commands are real and non-vacuous where applicable;
- no retired Python governance tooling is reintroduced;
- no product/business endpoint is created.

### Exit

Workspace commands are reproducible and ready for the API skeleton.

---

## B0.2 — API skeleton

### Objective

Create a production-shaped NestJS application without implementing Melarc business operations.

### Required foundation

- validated environment configuration;
- structured logging with secret redaction;
- graceful shutdown;
- platform/module boundaries;
- explicit health/readiness treatment;
- implementation-derived OpenAPI generation;
- route inventory;
- unit/integration tests for the technical behavior.

### Validation

Prove:

- valid configuration boots;
- required invalid/missing configuration fails startup;
- shutdown closes resources;
- representative secrets are not emitted to logs;
- the generated API description reflects actual registered routes;
- no accidental business success route exists.

### Exit

A real API process exists and is safe to extend.

---

## B0.3 — Ops Portal shell

### Objective

Create the React/Vite operational application shell.

### Required foundation

- application router;
- providers;
- query/client infrastructure;
- layout;
- error boundary;
- accessible navigation/shell primitives;
- `/api/v1` development proxy;
- component tests;
- browser smoke test.

### Validation

Prove:

- production build succeeds;
- application shell renders;
- keyboard navigation/focus works for the tested shell;
- proxy uses the correct relative API base;
- no secrets are bundled;
- no fake authentication or operational data is presented as working functionality.

### Exit

Ops shell is ready for real identity workflows.

### Carried forward from B0.2 and B0.3

These are not implemented by either task, and later tasks must not assume them:

- **Caller-capability discovery for signed-in navigation.** `Session` carries no permissions and no operation returns what the caller may do, so the shell's navigation takes a plain list and shows none. The identity slice decides the source ([surfaces/ops-portal.md](../../surfaces/ops-portal.md) §4).
- **DTO validation and schema conformance.** The API validates only its own configuration. Request and response validation against the contract belongs to B0.6 and must exist before the first business route; B0.6 provides it (see its carried-forward notes for what remains).
- **Trusted proxy topology.** The API trusts no proxy and ignores a client-supplied request id ([DEPLOYMENT_AND_ENVIRONMENTS.md](../../architecture/DEPLOYMENT_AND_ENVIRONMENTS.md) §12.5).
- **Explicit business request and upload limits.** Only the framework's default body limit applies today (same section).
- **Full supported-browser acceptance.** The B0.3 browser smoke test ran Chromium only. The browser suite now runs Chromium, Firefox and WebKit in CI (see B0.10, UI foundation). Safari and Edge as products, and the previous major release of each, are accepted by hand (owed item 8 in B0.10); the widths in [surfaces/ops-portal.md](../../surfaces/ops-portal.md) §11 are tested at 320, 768 and 1280 px.

---

## B0.4 — PostgreSQL and Drizzle

### Objective

Establish real persistence infrastructure.

### Required foundation

- local/test PostgreSQL service;
- Drizzle configuration;
- database connection service;
- canonical migration directory;
- migration command;
- distinct migration/runtime credentials;
- disposable database test setup;
- generic RLS/context test foundation where required.

### Validation

Prove:

- empty database migration works;
- repeat migration behavior is safe;
- runtime connection is not database owner;
- runtime cannot bypass RLS where RLS applies;
- transaction rollback works;
- pooled/transaction-scoped context does not leak;
- teardown/reset commands refuse unsafe targets.

### Exit

Database infrastructure is ready for domain schemas.

---

## B0.5 — Generated API client

### Objective

Create the canonical generated wire client/types from `contracts/openapi.yaml`.

### Required foundation

- pinned generator;
- deterministic configuration;
- `packages/api-client/`;
- browser transport boundary;
- generation command;
- freshness check;
- Ops import proof.

### Validation

Prove:

- generation is unchanged when inputs are unchanged;
- a deliberate contract change makes freshness checking fail;
- browser credentials/CSRF/header handling matches the retained contract;
- Ops does not maintain duplicate wire DTOs.

### Exit

Frontend can consume canonical contract types.

### Carried forward from B0.5

These are not implemented by B0.5, and later tasks must not assume them:

- **Result-to-error conversion.** The client returns `{ data, error, response }` and never throws on an HTTP error, and `error` is a plain string when the body is not JSON (a gateway failure, for example). The first slice that connects it to TanStack Query converts a failure into a thrown error carrying `status`, which `shouldRetryQuery` reads.
- **Other transports.** The Rider Bearer transport (the dedicated host that eight operations list) and the evidence-object upload transport (presigned URLs on another origin) are not built. The browser transport refuses to reach either, by design.
- **Call options.** A call may use only `params`, `body`, `parseAs`, `signal` and `headers` (`CALL_OPTIONS`); any other option, such as `credentials`, `redirect`, `baseUrl`, `fetch` or `middleware`, is a type error and is refused by name at run time, and the client has no `use`. The rules are applied to the request that is about to leave, not to the options that built it. A path parameter that is not one real segment (empty, `.` or `..`) is refused too, because the URL would read it as another route inside `/api/v1`. A slice that needs another option (a custom query serializer, `keepalive`) adds it to `CALL_OPTIONS` on purpose; the contract uses none today.
- **`Idempotency-Key` and `If-Match`.** The types require them where the contract does. Generating them, reusing a key across retries and keeping the ETag from the last read belong to the slice that sends the command.
- **Closed request bodies.** The call signatures do not reject an unknown property in a body the contract closes with `additionalProperties: false`. B0.6's runtime validation and the server enforce it.
- **Generator range.** openapi-typescript declares TypeScript `^5.x` and is run under the pinned 6.0.3 ([pnpm-workspace.yaml](../../pnpm-workspace.yaml)). Revisit it when the generator's own range includes 6.


---

## B0.6 — Contract and runtime conformance

### Objective

Ensure implemented API behavior cannot silently drift from the canonical contract.

### Required foundation

- implementation-derived API description;
- independently enumerated live routes;
- semantic operation comparison;
- runtime request/response validation where appropriate;
- security/header/extension checks.

### Validation

Deliberately demonstrate failure for representative:

- required-field drift;
- enum drift;
- additional-property drift;
- error-response drift;
- authentication/security drift;
- header/cookie drift;
- undocumented route;
- declared implemented operation with no live route.

### Exit

Contract enforcement is demonstrated rather than assumed.

### Carried forward from B0.6

These are not implemented by B0.6, and later tasks must not assume them:

- **Scope and binding.** `IMPLEMENTED_OPERATIONS` ([implemented-scope.ts](../../apps/api/src/tools/contract/implemented-scope.ts)) is empty. A slice adds its operation ids there and binds each handler with `@ContractOperation(id)` in the same change; `pnpm --filter @melarc/api run contract:check` then fails when the list, the router, the application's description or the binding disagree.
- **Security scheme definitions.** The application's description carries none, so any secured operation reports `SECURITY_DRIFT` until the identity slice registers them in `buildOpenApiDocument`. Decorators also cannot state two schemes that must both hold (`browserSession` and `csrfToken`) or a response's `x-set-cookies` and `x-set-cookies-for`; the identity slice decides how those reach the description. The comparator does compare both, so a description that sets the sign-out cookies for every caller is `COOKIE_DRIFT`.
- **What a decorated class cannot say.** A DTO class cannot state `additionalProperties: false`, `if`/`then` rules or `allOf`. The comparator compares those exactly and fails closed, so a slice supplies them with an explicit schema (`@ApiBody({ schema })`). The runtime validator enforces them from the contract itself.
- **Not compared.** Undeclared query parameters and request bodies (ignored); error bodies made by the platform's exception filter (checked against the code enumeration only); `readOnly` and `writeOnly` (annotations to the validator).
- **Compared, and what that asks of a slice.** A parameter's effective serialization (`style`, `explode`, `allowReserved`, `allowEmptyValue`, with OpenAPI's defaults filled in), `deprecated`, and operation-level `servers` are compared. `@nestjs/swagger` has no decorator for `servers`, so the first Rider slice must make the application's description carry the eight Rider operations' hosts; until then such an operation reports `OPERATION_ROUTE_DRIFT`. A statement the comparison has no field for (a link, an encoding, a callback) is reported as `OPERATION_UNMODELLED` when only one side makes it or the two differ, and never dropped; prose and `x-` extensions are ignored. A repeated `oneOf` branch is a difference (exactly one branch must match), and `const: null` is not the same as no `const`.
- **Bound handlers leave the response to the framework.** A handler bound with `@ContractOperation` that takes the response over (`@Res()` without `{ passthrough: true }`, `@Next()`, `@Sse()`, `@Redirect()`, `@Render()`) stops the application at start, because what it sends never reaches the validator. With `@Res({ passthrough: true })` a handler may choose its status (200 or 202) and set cookies: the interceptor judges the status that is on the response after the handler has run, and a status range such as `2XX` is honoured. An answer a handler already sent is reported as `sent-by-handler`, not validated.
- **Who checks headers and cookies.** The contract declares them: response headers with schemas, every cookie's attributes once in the root `x-cookies`, the cookies a response sets in its `x-set-cookies`, and cookie parameters. `ContractValidator` checks the value of each declared response header, that a response sets exactly the cookies it declares with the attributes `x-cookies` states (a session cookie on the 202 answer that asks for a second factor is a defect), and that a request carries the cookie parameters its operation declares. It never decides who the caller is: a session cookie that is present and well formed says nothing about whether it is a valid session, which is the guard's. Response checks are off in production and the exception filter's bodies are not intercepted, so each operation's own integration test must still check its real headers and cookies and its declared error and status pairs.
- **Dictionary keys and violation paths.** A violation names a property only where the schema declares it at that place (through references, `allOf`, `anyOf`, `oneOf` or a conditional) and an array position; every other key, such as a dictionary's, is `*`. A cookie is named only when `x-cookies` knows it.
- **Deployment.** The runtime reads `contracts/openapi.yaml` when a handler is bound, so a deployment must ship it beside the API. Response validation is off in production.
- **Contract corrections made after the audit (task 4).** Each is held by a test in [real-contract.test.ts](../../apps/api/src/platform/contract/real-contract.test.ts).
  - `Cache-Control: no-store` is a required header with the constant value `no-store` on the shared `CacheControlNoStore` component (the two enrolment grants) and on the evidence and accounting-export retrieval authorizations; no other response declares a cache policy.
  - Sign-out declares what it does to cookies. A browser sign-out expires `melarc_session` and `melarc_csrf` (`x-set-cookies`, set again with `Max-Age=0` and the attributes they were issued with); a Rider bearer sign-out sets none; `melarc_vendor_device` is never cleared. `x-set-cookies-for: browserSession` limits the declaration to a request that presented that scheme's credential, so `ContractValidator.validateResponse` takes the request and fails if it is not given one for such a response. A request that presented both credentials is judged as a browser one. The declaration cannot tell an expiry from a fresh cookie of the same name and attributes, so the identity slice's own test must check `Max-Age=0` and that the server-side session is ended.
  - `CollectionRecord` repeats the creation fields beside the server's own and is closed; the closed `CollectionRecordCreate` is unchanged, and a test holds the repeated fields identical to it.
  - The 58 `nullable: true` are `type: [T, 'null']`, and the two with an `enum` (`requestedByParty`, `commercialMode`) list `null` in it as well, which the old spelling never did: an enum is checked apart from the type, so those two refused the null their descriptions document. Generated types are unchanged by this.
  - The header comment counts the eight Rider operations that name the dedicated host.


---

## B0.7 — Integrated test harness

### Objective

Create a repeatable real-system test environment.

### Required foundation

- API + PostgreSQL + Ops test composition;
- deterministic fixtures;
- test clock/helpers where required;
- sandbox/capture adapters for external effects;
- Playwright harness;
- failure artifact capture;
- safe teardown.

### Validation

Run a real browser → API → database technical smoke path.

No production-only provider is contacted.

### Exit

Product slices can add integrated acceptance tests without rebuilding the harness.

### Carried forward from B0.7

These are not implemented by B0.7, and later tasks must not assume them:

- **Harness-only routes.** The journey uses `/api/v1/e2e/*` routes and an `e2e_harness` table that exist only in [e2e-main.mjs](../../apps/api/test/support/e2e-main.mjs) and the harness's own setup; no product route exists to take a journey through. The first slice replaces them with its real screens and operations.
- **External-effect adapters.** There are no provider ports yet, so the sandbox is a guard on every non-loopback TCP connection of the API process, which refuses and records it ([outbound-guard.mjs](../../e2e/harness/outbound-guard.mjs)). It does not cover UDP, DNS or child processes. A slice that adds a provider port adds its own sandbox or capture adapter and asserts on it.
- **Leftovers of a killed run.** A run removes only the database it made, and nothing removes another run's, so harnesses can share a PostgreSQL server. A runner that is killed hard leaves its database behind and can leave the API and Ops child processes running until they are ended by hand. `pnpm --filter @melarc/api db:orphans` lists the marked `melarc_test_*` databases with their session counts and changes nothing; `db:orphans --drop <name>…` removes the ones named, refusing any with a session connected unless `--disconnect` is added. The listing cannot tell an abandoned database from one in use (it records no creation time or owner), so the person naming it decides. A stop that cannot confirm a process ended fails and names the process and its pid, instead of treating a kill signal as proof. Only an `exit` is proof: an `error` event from a process that is running (Node emits one when a signal cannot be delivered, EPERM for one) is recorded and reported in the failed stop's message, and the process stays tracked until it really exits. An `error` from a command that cannot be spawned at all (no pid, no `exit` will come) is the one `error` that means the process is not running.
- **Browser boundary.** The browser context reaches the Ops origin, compared as a parsed origin, and nothing else; popups and WebSockets are covered. Service workers are blocked by configuration and that is not proven by a test. Only the Chromium project is covered, and a context a spec creates by hand with `browser.newContext()` is outside the boundary.
- **Not in `pnpm test`.** `pnpm run test:e2e` needs the built applications, a PostgreSQL service and Chromium, so it stays out of `pnpm test`. The `integrated` CI job (B0.8) provides all three.
- **Narrow coverage.** One Chromium project and one worker. The generated client's browser transport is not yet driven from a real page, because Ops has no call site for it. The SIGKILL escalation test of the process runner is skipped on Windows, which cannot trap SIGTERM; it runs on Linux.


---

## B0.8 — CI consolidation

### Objective

Run the established development checks reliably on the remote CI environment.

### Required foundation

- dependency install;
- static checks;
- builds;
- API tests;
- database/migration tests;
- frontend tests;
- contract/client freshness checks;
- browser smoke where practical;
- required aggregation result.

### Validation

Demonstrate that an intentionally failing mandatory check fails the aggregate pipeline.

### Exit

CI is a trustworthy development gate for the new repository.

### Carried forward from B0.8

These are not implemented by B0.8, and later tasks must not assume them:

- **First run on GitHub.** [ci.yml](../../.github/workflows/ci.yml) was checked with actionlint and the GitHub workflow and action schemas, by the repository's own tests, and by running every job's commands from a clean Git clone on Windows with CI's environment. It first ran on GitHub on 6 October 2026, push of `7509f51` to `main` ([run 37412013040](https://github.com/melarclogistics/Melarc/actions/runs/37412013040)): all five jobs and `CI result` succeeded on `ubuntu-24.04` (62, 129, 92, 121, 21 and 5 seconds), the only skipped steps were the two that are meant to be (the failure rehearsal, which needs a manual run, and the failure-diagnostics upload, which runs only on failure), and `melarc-build-7509f514cee73d026525e11baaba419fa749c9cd-1` (442,261 bytes) was kept until 20 October. That run exercised the Linux-only parts: the PostgreSQL service container, the Chromium download with its system packages, the artifact upload, and the POSIX-only tests that Windows skips. The rehearsal, the branch rule and a check of the downloaded build are still to do (B0.10).
- **The branch rule is a repository setting.** Require the check named `CI result` (job `ci`), and only that one, for `main`, and choose GitHub Actions as its source so that no other status with that name can satisfy it. Until it is set, a red run blocks nothing.
- **Shape.** Five jobs run in parallel: `static` (formatting, lint, strict types, migration history, generated client is current), `unit` (every workspace's tests and the repository's own tooling tests), `database` (PostgreSQL tests against a service container), `integrated` (build, contract conformance, the Ops browser smoke test, the browser, API and database journey, then the kept build) and `audit`. The sixth, `ci`, runs whatever happened (`if: always()`), needs the other five and fails unless each result is `success`: a failure, a cancellation and a skip all fail it, because GitHub counts a skipped required check as passed. [ci-aggregate.ts](../../scripts/ci-aggregate.ts) is that judgment.
- **The workflow is held to this design.** [ci-workflow.test.ts](../../scripts/ci-workflow.test.ts) fails when a mandatory command (`REQUIRED_COMMANDS` in [ci-workflow.ts](../../scripts/ci-workflow.ts)) is no longer run, when a step or job can absorb a failure (`continue-on-error`, `|| true`, `exit 0`) or be skipped (a condition, other than the failure-time artifact upload), when a job has no timeout or checks out anything but `${{ github.sha }}`, when the token can write, when the aggregate's `needs`, its command line and the workflow's jobs name different jobs, when the kept build is not preceded, after the browser tests, by the clean-tree check and a manifest that lists exactly what is uploaded, or when the rehearsal's input or its guarded step is gone. The same rules on failures apply to the steps of the composite action. A new job or check is added to the workflow, to that list and to the aggregate command together, and the test names whichever was forgotten. The Node.js, pnpm, frozen-install and action-SHA pins stay with [workspace-pins.ts](../../scripts/workspace-pins.ts), which now reads the composite action [setup](../../.github/actions/setup/action.yml) the jobs share. The database image is held equal to [compose.yaml](../../infrastructure/postgres/compose.yaml).
- **Rehearsal of a failing check.** Once the workflow file is on the default branch, run it by hand (`workflow_dispatch`) with `rehearse-failure` ticked: `static` fails on purpose, `CI result` must fail with it and the other four jobs pass. That is the live proof of this task's validation, and it has not been run on GitHub. The local proof is the aggregate's own tests and a rehearsal from a clean clone in which every job passed and `ci-aggregate.ts` exited 0, then a deliberately failing test failed its job and `ci-aggregate.ts` exited 1. A step that fails on purpose must be guarded by that manual input; the rules test refuses one that is not, and requires the input and a guarded step to exist.
- **One commit per run.** Every job checks out `ref: ${{ github.sha }}`, and every job that runs the repository's commands then runs `scripts/ci-revision.ts checkout`, which fails unless HEAD is that commit, so the jobs of one run cannot test different commits when a pull request's merge ref moves (the `ci` job runs only the aggregate script and needs no checkout check). A push is never cancelled or replaced by a later one (a pull request's older run is).
- **The kept build.** After the browser tests, `scripts/ci-revision.ts clean` fails if any tracked file differs from the commit or an unignored file exists (a tool rewrote a file, or generated output was not committed). The job then keeps `melarc-build-<sha>-<attempt>` for 14 days: `apps/api/dist`, `apps/ops-web/dist`, `contracts/openapi.yaml` and `build-manifest.json`, which records the revision, the run and ref, the Node.js and pnpm versions, the lockfile and contract hashes and the SHA-256 of every file. It describes the files uploaded, which are the build output on disk after the browser tests ran; the Ops smoke test rebuilds `apps/ops-web/dist` and `test:e2e` restores the cached build, so that they are also what each test ran against rests on the build being deterministic (two from-scratch builds on Windows gave identical hashes; not yet shown on a Linux runner). Only the `integrated` job tested it, and it is kept only when every earlier step of that job succeeded (a failed run keeps the diagnostics instead), pull requests included, whose `<sha>` is then the merge commit: a later deployment task must use an artifact only when `CI result` succeeded for the same commit and `source.ref` is `refs/heads/main`. To check one, unpack it at the root of a checkout of that commit and run `node scripts/ci-revision.ts verify build-manifest.json`. It refuses a manifest that is empty, malformed or inconsistent (every field, path and hash is validated, and nothing unknown is accepted), reports files that changed, went missing or were added, and, in a Git checkout, requires HEAD to be the manifest's revision (outside a checkout it says that the revision was not checked). It establishes file contents and checkout only: matching checksums do not authenticate the artifact and do not show that CI succeeded, which is checked separately through the run and the branch. It does not compare the checkout's own files with the manifest's recorded inputs, because a Windows working copy can hold CRLF where CI held LF. It is build output, not a release package: it carries no dependencies, container image or signature, and the contract hash is of the file as checked out (LF on Linux; the baseline commit stores LF although some Windows working copies hold CRLF).
- **Diagnostics.** When `integrated` fails it keeps `melarc-diagnostics-<sha>-<attempt>` for 7 days: `e2e/test-results` and `apps/ops-web/test-results` (process logs, the outbound-connection record, traces). The other jobs print their output only.
- **Dependency audit.** `pnpm audit --audit-level high` fails `audit` for a high or critical advisory ([engineering-standards.md](../../standards/engineering-standards.md) section 3.3). It reads the registry's live advisory data, so a new advisory can turn an unchanged commit red and a registry outage fails it closed (re-run it). A recorded, time-bounded exception has no mechanism yet. At this commit it reports one moderate advisory and passes: esbuild 0.24.2 or older, reached only through drizzle-kit's `@esbuild-kit` packages.
- **Not covered.** Windows and macOS runners, browsers other than Playwright's three engines (Safari and Edge as products), a cache of the downloaded browsers (the pnpm store is the only cache), coverage thresholds, deployment or release, scheduled runs, and automatic bumps of the pinned action SHAs.

---

## B0.9 — Developer setup

### Objective

Make local setup reproducible.

### Required documentation/scripts

Document the actual commands for:

1. dependency installation;
2. infrastructure startup;
3. migration;
4. development startup;
5. tests/smoke checks;
6. safe shutdown;
7. disposable local reset.

### Validation

Follow the instructions from a clean checkout/environment.

### Exit

Development setup does not depend on undocumented machine state.

### Carried forward from B0.9

These are not implemented by B0.9, and later tasks must not assume them:

- **Where it lives.** [DEVELOPMENT.md](../../DEVELOPMENT.md), linked from the [README](../../README.md). [local-setup.test.ts](../../scripts/local-setup.test.ts) fails when it shows a pnpm or node command that does not exist, links a file that is missing, names a port the settings examples do not use, or when it, the README, the compose file or a settings example sends a developer to the git-ignored `tmp/` folder. [setup-env.test.ts](../../scripts/setup-env.test.ts) holds `setup:env` and [infra-check.test.ts](../../scripts/infra-check.test.ts) holds `infra:check`. `local-setup.test.ts` also fails if the WSL2 section again promises that WSL2 reaches a database on Windows at `127.0.0.1`, drops the two supported setups or the statement of what is unverified, calls a volume reset the only way to change a password, or presents a longer download timeout as the fix for the IPv6 failure.
- **What was added.** `pnpm run setup:env` ([setup-env.ts](../../scripts/setup-env.ts)) creates `infrastructure/postgres/.env` with random, distinct passwords and `apps/api/.env` with a `DATABASE_URL` for the runtime identity and the same password, host and port. It never overwrites, prints no password, writes nothing unless it can write everything it was asked to, and names an existing `apps/api/.env` that has no readable `DATABASE_URL` or a mismatched password. `pnpm run infra:up`, `infra:status` and `infra:stop` run the compose file, and `start:local` in `apps/api` starts the build with `apps/api/.env`. `pnpm run infra:check` ([infra-check.ts](../../scripts/infra-check.ts), added after the 5 October audit, B-03) opens one connection to the address the database tools use, sends only the PostgreSQL SSL request (no user or password) and says whether PostgreSQL answers; when nothing does it says why, and in WSL2 it explains the two supported setups. It refuses any host that is not this machine, as the database tools do. `pnpm run package:source` ([package-source.ts](../../scripts/package-source.ts), audit B-04) makes the ZIP for source review from what Git knows, refuses settings files, keys, dependency and output directories by name even where Git would include them, fails when a credential read from the local settings files appears inside a file it would pack, writes `SOURCE_PACKAGE.json` (revision, whether the working tree is modified, every file with its SHA-256) and never changes the working tree or prints a value. [package-source.test.ts](../../scripts/package-source.test.ts) holds it. It is not a signed or reproducible-across-Node-versions artifact, and it does not replace the CI artifact of B0.8. They replace the git-ignored helpers setup used to need (`tmp\db-up.cmd`, `tmp\db-env.mjs`); the Linux check and the Chromium download workaround stay machine-local helpers, and DEVELOPMENT.md depends on neither.
- **Proven from a clean clone on Windows** (a Git clone of the working tree with no dependencies, settings or build; commands run through `cmd.exe`; Node 24.21.0, pnpm 11.1.3, Docker Desktop, the `melarc-db` container on PostgreSQL 18.6): install; `setup:env` creating both files, then leaving them alone; `infra:status`; the compose command resolving to the same configuration hash as the running container; build; `db:bootstrap`; `db:migrate`; `db:reset` of `melarc_dev`, then an up-to-date `db:migrate`; the API and the Ops dev server starting, `/livez` and `/readyz` answering, `/api/v1` through the Ops origin giving the API's own answer, the API's probes not reachable from the Ops origin; the documented port change made in the settings files only; both processes ending and leaving no API session on the database; then `pnpm test` (root 318, Ops 114, api-client 214, API 1077 passed and 5 skipped on Windows, harness 136 passed and 1 skipped), `test:db` (140 passed, 1 skipped), `test:browser` (7) and `test:e2e` (16). These are the counts at the end of B0.9. After the 6 October audit repairs, with every step forced past Turbo's cache on Windows (Node 24.21.0, pnpm 11.1.3): root 626 passed and 1 skipped (the symlink test in `package-source.test.ts`), Ops 114, api-client 214, API 1077 passed and 5 skipped, harness 142 passed and 1 skipped, `test:db` 140 passed and 1 skipped, `test:browser` 7 and `test:e2e` 16; build, `contract:check`, `api-client:check`, `db:check` and `pnpm audit --audit-level high` all exited 0.
- **Not proven by B0.9.** `infra:up` and `infra:stop` were not run from nothing: the database was already running and starting or stopping local services is the developer's to do, so the evidence is the equal configuration hash and a healthy `infra:status`. The full reset (`down --volumes`) was not exercised because it deletes the machine's local data. Shutdown on Ctrl+C and `SIGTERM` is not proven on Windows, which cannot deliver `SIGTERM`; the Linux check (`tmp\linux-check.cmd`, extended to start the documented way, send `SIGTERM` and require `shutdown complete`, and to check that `setup:env` makes files with mode 600) must be run in WSL2 and has not been. Neither WSL2 setup in DEVELOPMENT.md (the database inside WSL2, or on Windows with mirrored networking) has been run on a WSL2 machine, and Docker Desktop's WSL integration has not been tested for reaching a port published on `127.0.0.1` from a distribution; the Linux check's database step now runs `infra:check` and has not been re-run. macOS is not covered.
- **Found while proving it.** This machine's `apps/api/.env`, made by hand before the API required `DATABASE_URL`, had no `DATABASE_URL`, so `start:local` would have refused to start; `setup:env` now reports that, and deleting the file and running it again is the documented fix (done in the clone, not on the real file). Another project's server held port 3000 while the proof ran, so a port change through the settings files is documented and was proven. After a reboot Docker Desktop started by itself and the container returned (`restart: unless-stopped`). Three steps failed once or twice and then passed unchanged, with nothing diagnosed: `pnpm test` twice (seven Ops test files could not start a Vitest worker within its 60 s limit; the Ops tests alone pass in 16 s) and `test:db` once (two API process tests missed their 8 s readiness deadline). A bare `cmd.exe` (pid 13932, started at the reboot, about 2.75 CPU-seconds per second) was running throughout. No deadline was changed. The Ops failure happened a third time on 6 October, in the first `pnpm run test` after a fresh clone of `7509f51` on Windows (the root suite and the harness passed; 6 of the 13 Ops files ran and 7 could not start a worker; its report was dominated by import time, with four workspaces' Vitest runs going at once and cold caches). Vitest 5.0.3 fixes those limits in code (90 s to start a worker, 60 s for it to respond) and has no option for them, so a timeout cannot be tuned and none was. The same job passed on the hosted Ubuntu run.
- **Not covered.** Seeded fixtures and capture adapters (no product data or provider exists yet), a watch mode for the API, and staging or production setup.

---

## B0.10 — Bootstrap acceptance

### Objective

Verify the combined bootstrap before beginning product implementation.

Close the findings of the [5 October bootstrap and design audit](MELARC_BOOTSTRAP_AND_DESIGN_AUDIT_2026-10-05.md) first.

### Audit closure (6 October 2026)

Each finding was reproduced on its own before it was changed, and each repair is held by tests that fail without it
(a test that passed on the old code was strengthened until it did not). The repairs are in commit `7509f51`.

| Finding | Status | What was done |
|---|---|---|
| B-01 `ManagedProcess` | **Repaired** | A start failure (no pid) ends the process; an `error` from a process that is still running (a failed signal) does not, and only `exit` proves termination. `stop()` reports what Node said |
| B-02 manifest verification | **Repaired** | `ci-revision.ts` validates the manifest strictly (schema, fields, canonical paths, git object names, hashes, non-empty files and roots, consistency with the contract) and `verify` states what it proves and what it does not |
| B-03 WSL2 setup | **Repaired; WSL2 not run** | [DEVELOPMENT.md](../../DEVELOPMENT.md) names the two supported WSL2 setups and says what is unverified; `pnpm run infra:check` is the non-destructive check; the password and Playwright statements are corrected |
| B-04 review archives | **Repaired** | `pnpm run package:source` (see B0.9). The earlier archive carried populated settings files: whether to replace those local passwords is the owner's decision, see below |
| B-05 CI and setup evidence | **Closed for bootstrap acceptance on 7 October 2026 except item 2**: items 1, 3 and 9 done, 2 waits for three manual rehearsal runs, 4 to 7 waived with a milestone, 8 gates the first identity flow | the list "Evidence still owed" below says what each item became |
| D-01 to D-07 design documents | **Reconciled and approved by the Product Owner on 6 October 2026** | layout families, supported colour pairings and recipes, the accessibility baseline and its test matrix, the nine states and the error-copy boundary, the existing-code map and bounded first scope, asset, token and font ownership, formatting boundaries. `scripts/design-contrast.test.ts` holds the colour tables to their hex values |

**Decisions this pass left to the Product Owner** were all taken on 6 October 2026 (see "Product Owner decisions"
below), except one: whether the local passwords in the earlier review archive are to be replaced
([DEVELOPMENT.md](../../DEVELOPMENT.md) section 9 says how).

### Re-audit before acceptance (6 October 2026, second pass)

Made on the committed `7509f51`, from a fresh forced run of every gate step on Windows, six independent read-only
reviews of the code, probes against the built application and a mutation check of the highest-stakes existing logic.
These repairs were committed as `36f7b22`, whose [hosted run](https://github.com/melarclogistics/Melarc/actions/runs/37423750540) is green in all six jobs. After the repairs below, with every step forced past Turbo's cache (Node 24.21.0, pnpm 11.1.3),
all 13 steps exit 0: root 627 passed and 1 skipped, Ops 114, api-client 214, harness 142 passed and 1 skipped, API
1093 passed and 5 skipped, `test:db` 142 passed and 1 skipped, `test:browser` 7, `test:e2e` 16, `pnpm audit` one
moderate advisory as before. Each repair has a test that failed on the old code first.

| Found | Repaired |
|---|---|
| A connection lost while a transaction held it (restart, failover, terminated backend) was an `error` event nobody listened to, so the fault handler ended the whole API | `DatabaseService` keeps an error listener on every pooled client; the transaction fails alone (tests with a fake pool and against the real server, between statements and mid-statement) |
| The session credential (`melarc_session`, `sessionId`) and the CSRF cookie in text were not redacted, against OBSERVABILITY §2.3 | key and text patterns now cover `session` and `csrf` |
| A failed query's message carried its bound values (drizzle-orm ends it with `params: …`), so the first failing insert of a credential would have logged it | `describeError` keeps the statement and drops everything after `params:`, in the message and the stack |
| Nest parsed form-encoded bodies although every contract request body is JSON, and a cross-site form can send one without a preflight | only the JSON parser is registered, after the request-id middleware (a bad or oversized body still answers with a request id) |
| `setup:env` replaced `CHANGE_ME` inside the example's own comment as well, and its test asserted exactly that | only the three password lines change; the test pins the draws and the untouched lines |
| The disposable-database-name check had no test for text before the name; a mutant without the `^` anchor survived | cases added for `prod_melarc_dev` and similar; the mutant is killed |
| The CI comment and this runbook said the build is kept "for every run, passing or not"; the step has no `always()` | both say what the workflow does. The B0.8 bullet is retitled "First run on GitHub", and B-05 is "items 2 to 7" |

A reviewer's claim that the request id is lost after the body parser did not reproduce on the real application and is
not a defect. The Ops worker-start timeout recurred once while a process unrelated to this repository was using about
five of twelve cores; the Ops suite passes alone and passed in the final full run. After that process was stopped, three
consecutive forced `pnpm test` runs passed in 142 to 158 seconds with no worker-start failure (244 to 267 seconds, and two
failures, while it ran). Check machine load before touching a timeout.

**Left for decisions and for the first slice** (none changes what bootstrap delivers):
the contract's open response schemas where it promises a field never appears (`HubIntakePreCount`); the role-posture
check not covering schema modification (SECURITY_DESIGN §14.6) and the context check not pairing a surface with a
principal type (§14.1b, which names no pairing); no statement or idle-in-transaction timeouts; the browser client not
pinned to `location.origin`; no injectable API clock; the UI
foundation (COMPONENT_PATTERNS §42.2) is on no roadmap line. (The retry policy's reliance on an error `status` and the possible start-up race on `SIGTERM`, both listed
here when this pass was written, were repaired in the third pass below.)

### UI foundation (6 October 2026)

Built to [COMPONENT_PATTERNS §42.2](../../design/COMPONENT_PATTERNS.md) after the Product Owner settled the setup layout (the
neutral frame), the typeface (the fallback stack at the time; Inter is self-hosted since), the control border (`#7C879B`), the inverse tokens
(approved as proposed), the scope (§42.2 in three increments), the accessibility target (tested to WCAG 2.2 AA) and the
browser coverage (Chromium, Firefox and WebKit in CI); each is recorded in DESIGN_SYSTEM §36. What exists, and where it
differs from the plan, is COMPONENT_PATTERNS §42.3: the token file `apps/ops-web/src/styles/tokens.css`, Button, Link,
Alert, Field, Input, LoadingIndicator, PageHeader, the restyled neutral frame, the error and not-found screens on the new
components (copy unchanged), and a development-only showcase that the production build provably lacks. No navigation entry
or permission-driven menu was built: the source of the entries (the `Session` resource's permission keys) was decided
later the same day, and the identity slice supplies it.

It is held by `scripts/design-tokens.test.ts` (the token file equals the document and defines nothing else but three
recorded tokens, the pairings the components use meet their thresholds, no colour written outside the file whether hex,
named, quoted or derived, no `var()` of an undefined property, every focus rule draws an outline and no rule removes
one), by tests of each component, and by browser tests of the real components: the exact keyboard order and the
specified focus ring on every stop, Enter and Space, a failed submit that moves focus to the first invalid field, no
sideways scrolling at 320, 768 and 1280 px, text enlarged to 200%, forced colours, reduced motion, hover states, and axe
with WCAG 2.2 in the resting, invalid and success states. An independent review of the work found no blocker; its
findings were fixed test-first (an `id` passed to an `Input` inside a `Field` orphaned the label; the guard let a quoted
hex, a named colour and an `outline: none` on a non-focus rule through; an alert's action link changed colour on hover; a
loading button changed fill under the pointer; the Button overwrote ARIA the caller set). Two mutation batches of the new
logic left no survivor except one equivalent: the forced-colours border colour, which the browsers force themselves.

With every step forced past Turbo's cache on Windows: root 651 passed and 1 skipped, Ops 165 (it was 114), `test:browser`
24 on Chromium, and the other steps unchanged. The browser suite also passes on Firefox (24) and on WebKit (23 and one
skip: Playwright cannot emulate forced colours there). WebKit for Windows never moves focus to a link on Tab, as Safari
does by default, so the keyboard tests ask the engine and follow its real order; whether the Linux WebKit of CI does is
unknown until it runs.

Not proven: the three-engine run in CI (it runs locally here on Windows, which is not the CI runner), and anything that
needs a person (the passes listed below). WebKit is Safari's engine, not Safari. Known and left: read-only and editable
inputs look alike under forced colours, and a button that starts loading grows by its spinner.

### Adversarial review before acceptance (6 October 2026, third pass)

Made on `36f7b22` with the UI foundation on top, at the Product Owner's request, before this task's acceptance. Seven
independent read-only reviews were told to break something: the HTTP runtime (against the built code and the libraries'
source), the data layer and isolation, the client boundary, supply chain and CI, test integrity (52 mutants of the
highest-stakes logic), the contract and SLICE-000's readiness, and completeness against this runbook. The lead also
probed the built API over raw HTTP, timed the redaction and ran a Turbo probe. Every claim was reproduced or refuted
before anything changed. Each repair has a test that failed on the old code, or a mutant of the new code that the tests
kill; the mutation tool applies a change to the real file, runs the tests and restores the file byte for byte.

**Test integrity.** Of the reviewer's 52 mutants, 42 were suspected survivors and 10 were controls. The 10 controls were
killed, which shows that the commands run tests; all 42 survived, each a real gap (a boundary, an assertion that only
looked, a branch only the database project reached). All 52 are killed now, in a re-run on the final tree. The lead's own
mutants of the new code and guards (about 90) are killed too, after six of them survived at first and their tests were
strengthened (a test that sat in a file the mutant's command did not run, a branch the end state could not tell apart, an
array parameter, a line-ending case, a probe that Prettier had moved). Three helper agents closed the other gaps and ran
about 300 mutants of their own; the lead re-ran every third mutant of each of their lists (102): all are killed except one,
which the agent had already reported as equivalent (a branch that cannot change the result). One test I believed I had
added was not in the file; a surviving mutant showed it, so every edit is now checked to have applied.

| Found | Repaired |
|---|---|
| Redaction took cubic time on text such as `password-` repeated (20 s for 144 KB, the event loop blocked) | `scrub-text.ts` is linear scanners; 40,000 generated texts agree with the old expressions; half a megabyte of each hostile shape finishes in milliseconds. A JSON value cut short is now scrubbed to its end |
| A path outside `/api/v1`, or a method a technical route does not take, got Express's HTML page, echoing the path and with no request id | `NotFoundFallback` answers every unmatched request with the contract envelope; routing is case-sensitive and strict |
| A JSON body in UTF-7, UTF-16 or UTF-32 was decoded and handed to a handler | refused with 415 before it is read; a `__proto__` key anywhere in a body is refused; an empty chunked body no longer counts as `{}` |
| Ajv's coercion accepted `0x10`, ` 5` and `1e1` as the integer, so `parseInt` and `Number` disagreed in a handler; its `uuid` accepted `urn:uuid:` and PostgreSQL then answered 500 | the text must be what the value is written as; strict uuid text |
| A stop signal during start-up left a listener nobody closed, a process that answered 503 for ever and ignored a second signal | `listenAndMarkReady` does not listen when the instance is draining and closes the listener if it began draining while opening |
| After `shutdown complete` a handle nobody registered could keep the process alive for the platform's whole grace period | the process is ended, non-zero and with a line saying why, if it has not ended by itself in five seconds |
| `/readyz` ran its queries once per probe on the business pool; the error filter took any thrown object's 4xx `status` for the API's; stdout was asynchronous, so a fatal line could be lost at exit | probes share one run; only an `HttpException` or an error that says it is meant for the client keeps its status; stdout is synchronous |
| The migrator skips a migration dated before the latest applied one and never notices an edited one | `migration-history.ts` refuses an edited or removed applied migration, a non-increasing `when`, a file the journal does not name and a new migration dated before one that ran |
| drizzle's own transaction leaks the connection when BEGIN fails, returns a connection whose ROLLBACK failed to the pool and lets the transaction object work after it ended | `DatabaseService` owns its transaction: it destroys a connection it cannot trust, ends the object when the transaction ends and refuses a nested transaction (two connections per request would starve the pool) |
| The migration lint read text, and its holes (`--` in a string, combined `ALTER TABLE` actions, a later owner change, `ALTER POLICY`, `GRANT … TO PUBLIC`, default privileges) let a table through; the database tests pinned exactly the B0 objects | a string-aware, statement-aware lint, and `catalog-invariants.ts`, which asks the migrated database for owner, row-level security, policies, PUBLIC and default privileges and is shown to fire on 14 deliberate violations; a first product-shaped table passes both |
| The role posture missed replication, a predefined role (`pg_*`) and a `melarc.*` setting stored on the role or the database | all three are unsafe flags, proved with real roles |
| A disposable database half made was left behind, the three local passwords could be one, a NUL in a URL part reached the driver, the environment guard let `Production` through, and `new Pool(url)` and `drizzle(url)` passed the lint that forbids a connection string | cleaned up, distinct, refused, allow-listed, linted |
| `if (error)` is false for a 403 or 502 with an empty body, a JSON `null` or `0` and a 304, so a failed command could be shown as done; a 200 HTML page rejected with a bare `SyntaxError` | `unwrap` reads the status; the transport refuses a success that is not the contract's JSON (the contract has no other, and a test says so) and turns a missing answer into an `ApiError` of kind `network`; `ApiError` never carries server text |
| Nothing owned the end of a session, and a failed query's "Try again" re-threw the cached failure without asking the server | `createQueryClient({ onSessionEnded })` and `endSession` clear the cache on `SESSION_INVALID` and `SESSION_SUPERSEDED`; the error page resets the failed queries first |
| Nothing forbade raw `fetch`, XHR, web storage, `window.open`, `dangerouslySetInnerHTML` or `eval` in the Ops Portal | ESLint refuses them there, and `eslint-rules.test.ts` runs the real configuration over snippets, 37 checks. The token guard also refuses `@import`, a remote `url()`, `!important` and a token redeclared outside the token file |
| CI guards could be satisfied by text that did not run: `pnpm install --frozen-lockfile=false` and `echo "pnpm ci"` passed; a mandatory command could sit inside a longer script; a test file could be run by nothing; dependency, lockfile and `.gitignore` policy had no test; the three-engine browser matrix was not pinned | each is held (`ci-workflow`, `workspace-pins`, `test-inventory`, `dependency-policy`, `gitignore`, `package-source`, `setup-env` and `turbo.json` tests); `setup-env` writes each file whole or not at all; the PostgreSQL image is pinned by digest |

**Refuted.** A reviewer's claim that `forbidOnly` is dead under Turbo's strict environment: a probe shows `CI` passes
through and an ordinary variable does not. Two reviewer items were design choices, not defects, and are in the decisions
below.

**Left, with the reason.** Validation work on a hostile body is dominated by Ajv, which collects every error; capping what
is reported (already done) and bounding the contract's arrays (the contract's, not this repository's, to change) are the
remedies. Response checks and cookie attributes are off in production by design; `no-store` is now sent on every response
(decision 3 below). Ajv runs with `strict: false`, so a mistyped keyword in the contract is silent: a strict compile of the contract
needs its extension keywords registered, which no test does yet. A route loader cannot reach the API client (the router
is built before the providers). `Form` and `SecretInput` wait for the identity slice. `TechnicalEndpoint` is not limited
to the two probes at run time, only by a test. Log lines from a logged user object can collide with `level`, `msg` and
`request_id`. Node's own 400 and 431 answers are not logged. An `ApiException` cannot yet set a header (`Retry-After`).

### Product Owner decisions (6 October 2026)

The Product Owner approved the two design documents and then answered every open question the third pass had listed. Each
decision is written into the document that owns it; this section says where, so that nothing is restated. None of them
changed what bootstrap delivers.

**Platform**

| # | Decision | Recorded in |
|---|---|---|
| 1 | A seed or a backfill writes a forced-RLS table as the `SYSTEM` principal under an explicit seed task capability; each table's policy has a `SYSTEM` branch for it, and no accessor is tied to the migration login | [MIGRATION_AND_SEEDING.md](../../architecture/MIGRATION_AND_SEEDING.md) §3.2 and §5.1, [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §14.4. The helper and each table's branch arrive with the first slice that has a table |
| 2 | The API's database role can set the security context itself: accepted as a residual risk, with four mitigations | [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §14.1 |
| 3 | `Cache-Control: no-store` on every API response, as a platform rule | `create-app.ts` and its tests; [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §14.8 |
| 4 | `CSRF_VALIDATION_FAILED` is 403; `IDEMPOTENCY_KEY_CONFLICT` is 409 and declared on every operation that takes a key; `VALIDATION_FAILED` is always 400 and a named business-rule code 422 | [errors-and-enums.md](../../contracts/errors-and-enums.md) §4; the contract was corrected |
| 5 | The migration lint refuses `ON DELETE CASCADE`, `TRUNCATE` and a `DELETE` grant unless a comment on the statement gives the reason (`-- allow-delete: <reason>`) | `migration-lint.ts` and its tests; [MIGRATION_AND_SEEDING.md](../../architecture/MIGRATION_AND_SEEDING.md) §5.1 |
| 6 | pnpm is not bumped now (11.1.3 stays); bump when an advisory needs a time-bounded exception | the pin |
| 7 | Public-repository hygiene: `LICENSE` (all rights reserved), `SECURITY.md` (melarclogistics@gmail.com), `.github/dependabot.yml` (weekly: npm, GitHub Actions, the PostgreSQL image). `CODEOWNERS` is skipped for now | the files. Secret scanning, push protection and the ruleset are GitHub settings (owed item 3) |
| 8 | The PostgreSQL image stays pinned by digest | `compose.yaml`, `ci.yml`; Dependabot proposes updates |
| 9 | Both design documents are approved and active. Inter is the typeface, self-hosted; WCAG 2.2 AA is the working target in the two surface documents (the one sentence the Product Owner authorised) | [DESIGN_SYSTEM.md](../../design/DESIGN_SYSTEM.md) §5.1, §14 and §36; `apps/ops-web/src/assets/fonts/`; `ops-portal.md` §11, `vendor-pwa.md` §9 |
| 10 | Owed items 8 and 9 below gate the first identity flow, not bootstrap acceptance. Item 9 is done | the list below |

**Contract and specification** (items 11 to 17 of the third pass, and the questions beneath item 16)

| # | Decision | Recorded in |
|---|---|---|
| 11 | A privileged identity with no `ACTIVE` factor gets the same `202` challenge, then `403` `MFA_ENROLMENT_REQUIRED` at `completeStaffMfaSignIn`, which counts toward no lock | [state-machines.md](../../contracts/state-machines.md) §13, [staff-authentication.md](../../features/identity/staff-authentication.md), `AC-SLICE-000-32` and `-123` |
| 12 | `completeCredentialRecovery` declares the vendor device cookie only for the vendor branch (`x-set-cookies-when`); the runtime validator honours it, and the recovery slice's handler must call `declareAnswerPrincipal` (`answer-context.ts`) or the response check fails | the contract, `contract-validator.ts`, `credentials.test.ts` |
| 13 | Each bootstrap Platform Admin holds an explicit all-hub grant; `reissueStaffCredentialSetup` refuses a bootstrap identity; the provisioning resume command works for a stranded identity until that identity itself holds an `ACTIVE` factor, whether or not the other is ready | [MIGRATION_AND_SEEDING.md](../../architecture/MIGRATION_AND_SEEDING.md) §3.2 and §3.3a |
| 14 | `riderSignIn` checks status before the lock | the contract text |
| 15 | `SESSION_SUPERSEDED` is a contract-wide rule for vendor sessions; the seven operations that belonged to no bucket join the credential setup and recovery bucket, and a per-address ceiling at the edge bounds attacker-chosen keys | [errors-and-enums.md](../../contracts/errors-and-enums.md) §4, [settings.md](../../contracts/settings.md) §7.7, [DEPLOYMENT_AND_ENVIRONMENTS.md](../../architecture/DEPLOYMENT_AND_ENVIRONMENTS.md) §12.2 |
| 16 | `reason_code` comes from the reason catalogue in six new identity domains; only Senior Ops and Platform Admin are privileged; the vendor `delivery_channel` is chosen at approval; a revoked rider is re-bound only by `reregisterRiderDevice`; `resetStaffMfa` refuses self-reset, a `PENDING`-only target and a non-privileged one; a rejected profile releases its email and a privileged one is rejected by a Platform Admin; a bundle edit applies at the next sign-in; the recovery supersede guard is 60 seconds; the `Session` carries its permission keys; TOTP is 6 digits, 30 s, SHA-1, one step either side, single use; session and CSRF cookies end with the browser and the vendor device cookie lasts 400 days; one audit event per cross-hub read; the email canonical form is trim, NFKC, lower-case, applied before the address is checked (the schema has no `format: email`); the rider challenge and sign-in bucket is keyed on the submitted phone number; one refusal order of twelve steps | [domain-model.md](../../contracts/domain-model.md), [settings.md](../../contracts/settings.md) §7.5, [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13, [audit.md](../../contracts/audit.md) §5.4, [permission-enforcement.md](../../features/identity/permission-enforcement.md) §5.1, and acceptance criteria `AC-SLICE-000-119` to `-131` |
| 17 | The live-code count is stated as 121 | [errors-and-enums.md](../../contracts/errors-and-enums.md) §5.5 |

`SLICE-000` builds the API for all 37 operations and the Ops Portal screens; the Vendor and Rider rows of its walkthrough
are verified at API level until those clients exist ([SLICE-000.md](../slices/SLICE-000.md)). It now has 125 criteria.

**Still open, and the Product Owner's to settle.** None of these was invented; each is recorded where it belongs.

1. **The seeded reasons and their wording** for the six identity reason domains, and approval of their proposed names
   (`SESSION_REVOCATION`, `STAFF_PROFILE_REJECTION`, `STAFF_MFA_RESET`, `CREDENTIAL_ADMINISTRATION`,
   `RIDER_DEVICE_REPLACEMENT`, `RIDER_DEVICE_REVOCATION`). Until they exist every identity operation that takes a
   `reason_code` answers `REASON_NOT_ACTIVE`, so the demonstration rows that use one cannot be walked.
2. **An ordinary privileged identity stranded in the same way** (a password, a `PENDING` factor, a lapsed enrolment
   grant). The seeded pair has the provisioning command (decided); an ordinary identity has none, and `resetStaffMfa`
   refuses a `PENDING`-only target, so no route reaches it. Recommended: let `resetStaffMfa` accept a `PENDING`-only
   privileged target that is not a bootstrap identity, because an approval verified its work email.
3. **Keys still unset.** The key of `requestAdditionalDeviceGrant` (it presents no grant) and the value of the edge
   ceiling. The rider key is decided: the submitted phone number.
4. **Smaller points** recorded in the owning documents: the audit cause for the no-factor refusal; whether HQ roles and
   cross-vendor reads emit the cross-hub audit event; which channel `VENDOR_DEVICE_ENROLMENT` uses when both exist;
   whether the supersede guard covers administrator-initiated recovery; which slices build the Vendor PWA and Rider app
   screens; and that "bundle edit" was read as a change of a bundle's contents (assigning another bundle still ends
   sessions with `AUTHORITY_CHANGED`).
5. **Points the contract work raised.** (a) The contract does not say what `decideVendorOrganization` does when the
   chosen `delivery_channel` is one the account holds no address for. (b) `vendorSignIn` now renews the
   `melarc_vendor_device` cookie (the same credential with a fresh `Max-Age`), which reverses the old "never
   re-issued" wording; the decision asked for the renewal. (c) `SELF_APPROVAL_FORBIDDEN` has no documented status and
   stays under 422, while `MFA_ENROLMENT_REQUIRED` is the one named code at 403, as the decision about it said. (d)
   Sign-in operations keep a 422 response that no declared code uses any more. (e) `listSessions` does not carry
   `permissions`: only the caller's own session does. (f) The three work-email fields had no `maxLength`, and none
   was added: the address is checked after it is canonicalised.

### Acceptance record (6 October 2026)

What the bootstrap is, on the evidence one Windows machine can give. Every step ran forced past Turbo's cache
(`TURBO_FORCE`) on one tree, after the repairs above: Node 24.21.0, pnpm 11.1.3, Windows 11, PostgreSQL 18.6 in Docker
Desktop, Chromium, Firefox and WebKit through Playwright 1.63.0 (`MELARC_BROWSERS=chromium,firefox,webkit`, as CI sets
it). The counts are those of the run after the Product Owner's decisions of 6 October were applied. That run's
`test:db` failed once, and for a true reason: the new delete rule of the migration lint refused the database tests' own
fixture, which grants DELETE with no recorded reason. The fixture now records one, and `test:db` passed when run again
(170 passed). The clean copy below ran all thirteen steps on the final files.

| Step | Observed |
|---|---|
| frozen install, `format:check`, `lint`, `typecheck` (root and four workspaces) | exit 0 |
| `api-client:check`, `build`, `contract:check`, `db:check` | exit 0; `contract:check` compared 0 operations, because none is implemented |
| `pnpm test` | root 1181 (1179 passed, 2 skipped: the symlink test of `package-source` and the POSIX-mode test of `setup-env`), Ops 220, api-client 250, API 1554 passed and 5 skipped (the real `SIGTERM` tests Windows cannot run), harness 191 passed and 1 skipped |
| `test:db` | 170 passed, 1 skipped (a real `SIGTERM`) |
| `test:browser` | 74 passed, 1 skipped (WebKit cannot emulate forced colours), over three engines |
| `test:e2e` | 16 passed |
| `pnpm audit --audit-level high` | exit 0; one moderate advisory, as before |

The gate leaves the tree as it found it (`git status` is the same before and after).

**From a clean copy.** The same thirteen steps, forced, ran on a copy of the working tree: 433 files, tracked and untracked,
nothing ignored (no `node_modules`, build output or `tmp/`), made into a Git repository of its own, with the two
git-ignored settings files copied in and nothing generated or rotated. Every step exited 0 with the same counts as above,
with one exception that is not a test result: the first `pnpm test` there stopped on Vitest's worker-start timeout in
the Ops Portal (12 of 23 files ran and none failed an assertion) while a stray process of the session's own was using
one core, and the same step run again on the same copy passed with the counts above (Ops 220 in 23 files, API 1554). No timeout
was changed. That shows that nothing machine-local is needed (the git-ignored `tmp/`, a cache, a built `dist`); it is the same
machine and operating system, so it is not the Linux or WSL2 proof, and it ran on files that were not yet committed.

| Task | The plan's exit criterion | Evidence | Held |
|---|---|---|---|
| B0.1 | clean install, deterministic root commands, no domain implementation | frozen install; the pin, dependency-policy and repository-shape tests; `IMPLEMENTED_OPERATIONS` is empty and the route inventory holds only the two probes | proven here, and by the hosted runs of `7509f51` and `36f7b22` |
| B0.2 | boots, refuses bad configuration, shuts down cleanly, no fake endpoints | configuration, process, shutdown and route-inventory tests; every unmatched request answers in the contract envelope | proven here; the five real-`SIGTERM` tests ran only on hosted Linux, whose logs nobody has read (owed item 1) |
| B0.3 | production build and smoke tests pass, nothing fabricated | build; 74 browser tests on three engines; no navigation, user menu or session data | proven here; the three-engine run on the Linux runner is not yet seen |
| B0.4 | fresh migrations, a non-owner runtime, proven transactions, safe teardown | `test:db`: migrations from empty and repeated, the history check, the catalogue invariants, the runtime role's refusals, pooled context, the transaction runner, the reset tools' refusals | proven here against a real server |
| B0.5 | deterministic generation, freshness, Ops imports generated types, a separate browser transport | `api-client:check`, 250 client tests, `unwrap` and `ApiError`, the no-duplicate-wire-types test | proven |
| B0.6 | deliberate mismatches fail the conformance checks | the comparator tests, now including a real contract operation, the runtime validator tests, the 52 mutants | proven for the machinery; there is no live product operation to compare |
| B0.7 | a real browser, API and database journey, safe teardown | `test:e2e` 16, the harness's 191 | proven here |
| B0.8 | failures propagate, artifacts match the tested revision, CI works from clean | the workflow's guard tests; hosted runs of `7509f51`, `36f7b22`, `4683bf5` and `25c1e05`, all jobs green; one real failure propagated (item 2) | **proven by a real failure; the manual rehearsals are still to be recorded (item 2)**; the branch rule is in force (item 3), the downloaded-build check is waived to release (item 4) |
| B0.9 | a clean checkout installs, starts, migrates, runs, tests and stops | the clean-clone proof of B0.9 and the one below | proven on Windows; WSL2, Linux, `infra:up` from nothing and `down --volumes` are waived to release (items 5 and 6) |
| B0.10 | the foundations are ready for product slices | everything above | **accepted by the Product Owner on 7 October 2026**, with the waivers below |

**Where this leaves the bootstrap.** The code, the tests and the guards are complete and green on this machine, and the
review above left no known defect in them. **The Product Owner accepted the bootstrap on 7 October 2026**, at
commit `25c1e05`, on the evidence above and with the waivers in the list below. The specification and
contract findings that blocked `SLICE-000` (decisions 11 to 16) are answered; what stays with the Product Owner is the
list under "Still open" above (the identity reason seeds, a stranded ordinary privileged identity, the keys still
unset and the smaller points), each to be settled before the behaviour it touches is implemented, because an
implementation would have to invent it. Hosted run [37503211249](https://github.com/melarclogistics/Melarc/actions/runs/37503211249)
of `25c1e05` succeeded in every job.

### Evidence still owed (audit B-05)

Each item is recorded with its date and commit. Acceptance on 7 October 2026 closed or waived every item but 2 and 8,
each with an owner and the milestone it must meet. A waiver is not a proof: the item stays unproven until it is done.

1. **A hosted CI run of the intended commit. Done 6 and 7 October 2026.** The bootstrap and the audit repairs are
   commit `7509f51` on `main`. In [its Actions run](https://github.com/melarclogistics/Melarc/actions/runs/37412013040),
   `Static checks`, `Unit, component and process tests`, `Database tests`, `Build, contract and browser tests`,
   `Dependency audit` and `CI result` all succeeded, and it was the first run of the Linux-only parts. The run of the
   third-pass commit `4683bf5`, [37472521664](https://github.com/melarclogistics/Melarc/actions/runs/37472521664), also
   succeeded, with only the two designed skips, and so did the run of the accepted commit `25c1e05`,
   [37503211249](https://github.com/melarclogistics/Melarc/actions/runs/37503211249). GitHub shows a
   job's log only to a signed-in user, so nobody has read the two test jobs' logs to confirm that the POSIX-only tests
   ran and that nothing else was skipped: that reading is waived with item 7. Repeat this item for each commit that
   changes code.
2. **The failure rehearsal. Open: the Product Owner asked on 7 October 2026 for three manual runs before it is
   recorded.** Run the workflow by hand with `rehearse-failure` ticked, three times; each must show `Static checks`
   failed, `CI result` failed and the other four jobs succeeded. Record the three run links here, with their dates, when
   they exist. A real failure already showed the same outcome and is kept as supporting evidence, not as the record:
   Dependabot's pull request #1 (`@types/node` 24.19.1 to 26.6.4),
   [run 37503470626](https://github.com/melarclogistics/Melarc/actions/runs/37503470626) at `eef428d`, where `Static
   checks` failed (its Typecheck step), `CI result` failed at "Require every mandatory job to have succeeded", and the
   other four jobs succeeded. That pull request is the owner's to close (it needs a Node 26 decision that the pinned
   Node 24.21.0 does not make).
3. **The branch rule. Done 7 October 2026.** `main` requires the check `CI result`, with GitHub Actions as its source,
   and **nobody bypasses it, the owner included** (the Product Owner's decision). The owner applied it in "Melarc
   ruleset" (id 24650051; Settings, Rules, Rulesets), which at first was saved with enforcement `disabled` and no
   required check, and was corrected the same day. Proven from outside on 7 October: the rules endpoint
   (`/repos/melarclogistics/Melarc/rules/branches/main`) lists `required_status_checks` with the context `CI result`
   and `integration_id` 15368 (GitHub Actions), beside `deletion` and `non_fast_forward` (no deleting `main`, no force
   push); and Dependabot's pull request #1, whose `CI result` failed on `eef428d`, shows its merge button disabled
   with "Merging is blocked due to failing merge requirements". The bypass list is not public: the owner's merge box
   offered no way around the rule, which is consistent with an empty list, but nobody has yet confirmed the list itself
   (open: the owner reads it in the ruleset's edit page and records it here). Consequence to
   accept: with the check required and no bypass, GitHub refuses a direct push to `main`, so every change reaches it
   through a pull request whose run succeeded.
4. **A downloaded build verifies. Waived 7 October 2026 until release.** Download `melarc-build-<sha>-1` from the
   passing run, unpack it at the root of a checkout of that commit and run `node scripts/ci-revision.ts verify
   build-manifest.json`: it passes. Then the negative cases: change one byte of a file, add a file, and edit the manifest
   to an empty file list; each is refused with a reason. `verify` checks contents only, so also check the run, the commit
   and `source.ref` (`refs/heads/main`) yourself. Owner: Product Owner. Milestone: before any deployment uses the
   artifact.
5. **A clean supported setup from the committed instructions only. Waived 7 October 2026 until release.** On a clean
   Windows machine and in WSL2 or Linux, follow DEVELOPMENT.md from clone to safe stop: `setup:env`, `infra:up` from
   nothing, `infra:status`, `infra:check`, `db:bootstrap`, `db:migrate`, the API's `/readyz`, the Ops proxy, the tests,
   `infra:stop`. In WSL2 run `pnpm run infra:check` first and record which of the two setups applied. Re-run the
   machine-local Linux check (`.\tmp\linux-check.cmd`), which now ends its database step with `infra:check` and has not
   been run since. Owner: Product Owner. Milestone: before the first Staging deployment, and before a second developer
   or a CI-like machine is relied on.
6. **The disposable reset, waived 7 October 2026 until release**: `db:reset` and `down --volumes`, only in a deliberately
   disposable environment (a clean machine or a throwaway Docker volume), never against a database that holds data you
   want. Owner and milestone as item 5.
7. **The latest suites on the final commit. Waived 7 October 2026 for the Linux part.** `pnpm test`, `pnpm run test:db`,
   `pnpm run test:browser` and `pnpm run test:e2e`, with the tests that Windows skips accounted for by a Linux, WSL2 or
   CI run: five API process tests, one under `test:db`, one harness test and the symlink test in
   `package-source.test.ts`. On Windows on 7 October, on the uncommitted tree: root 1179 passed and 2 skipped, API 1563
   passed and 5 skipped, api-client 250, harness 191 passed and 1 skipped, Ops 220 when run alone (in a full forced
   `pnpm test` 11 of its 23 files could not start a Vitest worker, with no failed assertion, at 5 to 25 percent CPU and
   without the stray process earlier runs blamed: the flake recurs and is not yet explained); `test:db`, `test:e2e` and
   `test:browser` were not run that day (the database was down), their last counts being those of 6 October above.
   Owner: Product Owner. Milestone: the Linux log reading and the Linux run by the first Staging deployment.
8. **The recorded passes the design system requires before the first identity flow is accepted** (DESIGN_SYSTEM §14).
   They gate that flow and not bootstrap acceptance (decided 6 October 2026), so **`SLICE-000`'s first Ops screen is
   not accepted until they are recorded**:
   one keyboard-only pass and one screen-reader pass (a desktop screen reader with its usual browser, for example NVDA
   with Firefox or Chrome) of the showcase and the shell, with the versions used and what was done; a pass in Windows
   high-contrast mode; and Safari and Edge as products, and the previous major release of each browser, checked by hand.
9. **The surface-document wording. Done 6 October 2026.** `surfaces/ops-portal.md` §11 and `surfaces/vendor-pwa.md` §9
   now say "WCAG 2.2 level AA is the working target; it is not a conformance claim", the one edit the Product Owner
   authorised. Two statements of `ops-portal.md` are stale and were left alone, because the document is approved: §11
   says the bootstrap browser smoke test runs Chromium only (it runs on three engines), and §4 says signed-in navigation
   depends on a capability discovery that is not specified (the `Session` resource now carries permission keys).

### Validation scope

Run the final applicable:

- install;
- typecheck;
- lint/format checks;
- API build/tests;
- Ops build/tests;
- database migration/integration checks;
- API client freshness;
- contract conformance controls;
- browser/API/database smoke;
- CI checks.

### Exit

Bootstrap is complete and `SLICE-000` can begin.

Bootstrap completion does not mean any product slice is complete.

## 5. Product development handoff

After B0.10:

1. open `delivery/IMPLEMENTATION_PLAN.md`;
2. start with the first current slice;
3. read that slice's active acceptance criteria;
4. load only the relevant contracts/features/surfaces/architecture;
5. implement one vertical increment;
6. test it;
7. fix failures;
8. commit;
9. continue.

Do not implement a later slice simply because its specification is available.

## 6. Using Claude Code

Claude Code is optional.

Use it only for a specific bounded task such as:

```text
Implement the NestJS configuration module described in this task.
Modify only apps/api/src/platform/config and its tests.
Do not add business routes.
Run the listed tests and report exact results.
```

Avoid prompts such as:

```text
Implement Bootstrap.
Build the backend.
Finish SLICE-000.
```

A coding agent executes the task; it does not decide Melarc product policy.

## 7. Stop conditions

Stop the dependent task when:

- a retained specification conflicts with another retained requirement;
- a command fails for an unexplained reason;
- a migration would destroy non-disposable data;
- a requested dependency or tool is incompatible with the selected stack;
- a security requirement cannot be implemented as specified;
- an external/provider value is required but not available;
- the implementation would require inventing product behavior.

Surface the exact problem and resolve it before continuing.

## 8. Task handoff format

For normal manual development, no audit package is required.

Return only what the current task needs, usually:

```text
Task:
Files changed:
Commands run:
Result:
Tests:
Problem/blocker, if any:
```

Raw logs are kept only when useful for debugging or CI artifacts.

## 9. What is not part of this workflow

The active development process does not require:

- Charter admission;
- Working-State snapshots;
- decision-register bookkeeping;
- approval-package generation;
- repository ZIP handoffs after every task;
- pre-development audit reports;
- historical integrity-check numbering;
- full repository re-audits after ordinary coding changes.

The retained specification set and Git history provide the development record. Product changes are made deliberately in the appropriate retained specification before code relies on them.
