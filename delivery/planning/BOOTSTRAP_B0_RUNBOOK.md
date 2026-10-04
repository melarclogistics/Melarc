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

---

## B0.10 — Bootstrap acceptance

### Objective

Verify the combined bootstrap before beginning product implementation.

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
