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
- **Full supported-browser acceptance.** The B0.3 browser smoke test runs Chromium only; the browsers and widths in [surfaces/ops-portal.md](../../surfaces/ops-portal.md) §11 are accepted separately.

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
- **Not covered.** Windows and macOS runners, browsers other than Chromium, a cache of the downloaded browser (the pnpm store is the only cache), coverage thresholds, deployment or release, scheduled runs, and automatic bumps of the pinned action SHAs.

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
| B-05 CI and setup evidence | **Partly closed: item 1 done, items 2 to 7 open** | the hosted run of `7509f51` is green (see B0.8's notes); the list below says what is still owed |
| D-01 to D-07 design documents | **Reconciled, with open decisions** | layout families, supported colour pairings and recipes, the accessibility baseline and its test matrix, the nine states and the error-copy boundary, the existing-code map and bounded first scope, asset, token and font ownership, formatting boundaries. `scripts/design-contrast.test.ts` holds the colour tables to their hex values |

**Decisions this pass leaves to the Product Owner.** Whether the setup routes use the neutral frame or a bare layout
(DESIGN_SYSTEM §13.1); whether to darken `border.control`, which passes on white by 0.06 (§4.6); the proposed inverse
focus, inverse link and Ink-shell indicator values; the proposed bounded first implementation (COMPONENT_PATTERNS
§42.2); the typeface, still Inter as a recommendation; the source of the signed-in navigation entries, for which no
contract exists; whether the surface documents' accessibility wording moves from 2.1 to 2.2 AA (§14 states how the two
agree meanwhile); and whether the local passwords in the earlier review archive are to be replaced
([DEVELOPMENT.md](../../DEVELOPMENT.md) section 9 says how).

### Re-audit before acceptance (6 October 2026, second pass)

Made on the committed `7509f51`, from a fresh forced run of every gate step on Windows, six independent read-only
reviews of the code, probes against the built application and a mutation check of the highest-stakes existing logic.
Nothing was committed. After the repairs below, with every step forced past Turbo's cache (Node 24.21.0, pnpm 11.1.3),
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
the contract's open response schemas where it promises a field never appears (`HubIntakePreCount`, `Session`); no HTTP
status for `CSRF_VALIDATION_FAILED`; `IDEMPOTENCY_KEY_CONFLICT` absent from the operations' responses; the role-posture
check not covering schema modification (SECURITY_DESIGN §14.6) and the context check not pairing a surface with a
principal type (§14.1b, which names no pairing); no statement or idle-in-transaction timeouts; the browser client not
pinned to `location.origin`; the retry policy's reliance on an error `status` nobody defines yet; a possible start-up
race when `SIGTERM` arrives before the server listens (not reproduced, Linux only); no injectable API clock; the UI
foundation (COMPONENT_PATTERNS §42.2) is on no roadmap line; SLICE-000 lists Vendor and Rider screens for which no
client exists.

### Evidence still owed (audit B-05)

These are not code failures. They need the owner's GitHub repository, a clean supported machine or WSL2, and the
bootstrap is not accepted without them. Record each result with its date and the commit.

1. **A hosted CI run of the intended commit. Done 6 October 2026.** The bootstrap and the audit repairs are commit
   `7509f51` on `main`. In [its Actions run](https://github.com/melarclogistics/Melarc/actions/runs/37412013040),
   `Static checks`, `Unit, component and process tests`, `Database tests`, `Build, contract and browser tests`,
   `Dependency audit` and `CI result` all succeeded, and it was the first run of the Linux-only parts. GitHub shows a
   job's log only to a signed-in user, so read the two test jobs' logs once and confirm that the POSIX-only tests ran
   and that nothing else was skipped. Repeat this item for whichever commit is finally accepted, if it is not
   `7509f51`.
2. **The failure rehearsal.** Run the workflow by hand with `rehearse-failure` ticked: `Static checks` fails, `CI result`
   fails with it, and the other four jobs succeed.
3. **The branch rule.** For `main`, require the check `CI result` with GitHub Actions as its source, and decide and
   record who may bypass it. Prove it: a pull request whose run is red cannot be merged.
4. **A downloaded build verifies.** Download `melarc-build-<sha>-1` from the passing run, unpack it at the root of a
   checkout of that commit and run `node scripts/ci-revision.ts verify build-manifest.json`: it passes. Then the
   negative cases: change one byte of a file, add a file, and edit the manifest to an empty file list; each is refused
   with a reason. `verify` checks contents only, so also check the run, the commit and `source.ref` (`refs/heads/main`)
   yourself.
5. **A clean supported setup from the committed instructions only.** On a clean Windows machine and in WSL2 or Linux,
   follow DEVELOPMENT.md from clone to safe stop: `setup:env`, `infra:up` from nothing, `infra:status`, `infra:check`,
   `db:bootstrap`, `db:migrate`, the API's `/readyz`, the Ops proxy, the tests, `infra:stop`. In WSL2 run
   `pnpm run infra:check` first and record which of the two setups applied. Re-run the machine-local Linux check
   (`.\tmp\linux-check.cmd`), which now ends its database step with `infra:check` and has not been run since.
6. **The disposable reset**, `db:reset` and `down --volumes`, only in a deliberately disposable environment (a clean
   machine or a throwaway Docker volume), never against a database that holds data you want.
7. **The latest suites on the final commit:** `pnpm test`, `pnpm run test:db`, `pnpm run test:browser` and
   `pnpm run test:e2e`, with the tests that Windows skips accounted for by a Linux, WSL2 or CI run: five API process
   tests, one under `test:db`, one harness test and the symlink test in `package-source.test.ts`.

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
