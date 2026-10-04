# Melarc Development Execution Plan

> **Status:** ACTIVE — manual incremental development
> **Version:** 1.0
> **Date:** 4 October 2026
> **Repository path:** `delivery/DEVELOPMENT_EXECUTION_PLAN.md`
> **Purpose:** define how Melarc is implemented from engineering bootstrap through product slices.

## 1. Development objective

Build Melarc in the existing monorepo as an integrated system, beginning with:

- `apps/api/` — NestJS backend API.
- `apps/ops-web/` — React Ops Portal.
- PostgreSQL with Drizzle ORM.
- Contract-driven client generation from `contracts/openapi.yaml`.

Vendor and Rider client applications are implemented when their approved slice requirements are reached. Their backend contracts and security boundaries must not be weakened because a client is not yet built.

The implementation must follow the retained product and technical specifications. Development convenience is never a reason to invent a business rule.

## 2. Source of truth

Use these retained project sources:

1. `PROJECT_MASTER_SPECIFICATION.md` — overall product and system baseline.
2. `contracts/` — API, domain, state-machine, permission, settings, error, audit and data-scope contracts.
3. `features/` — detailed workflow and feature behavior.
4. `surfaces/` — UI/client behavior and interaction requirements.
5. `architecture/` — solution, security, deployment, database, jobs, observability and recovery design.
6. `standards/` — engineering, security, readiness and completion requirements.
7. `delivery/IMPLEMENTATION_PLAN.md` — product delivery order.
8. `delivery/slices/` — implementation and acceptance scope for each slice.
9. `registers/GLOSSARY.md` — canonical terminology.

When two retained sources appear inconsistent, stop the affected implementation and surface the conflict to the Product Owner. Do not silently choose a new product rule.

Historical governance, audit and approval files are not part of the active development workflow.

## 3. Working method

Development is manual and incremental by default.

For every task:

1. State the purpose.
2. Define the exact files or subsystem being changed.
3. Execute only that bounded task.
4. Run the smallest meaningful validation that proves the task.
5. Report the actual output.
6. Fix any failure before proceeding.
7. Commit coherent working increments.

ChatGPT coordinates the sequence. Claude Code or another coding agent may be used for a narrowly scoped implementation task, but the task must specify the exact goal, files, constraints and validation. No agent is authorized to redesign product behavior on its own.

Do not run broad repository rewrites, mass formatting, destructive database operations or dependency upgrades unless the current task requires them.

## 4. Repository structure

The target structure is:

```text
Melarc/
├── apps/
│   ├── api/
│   └── ops-web/
├── packages/
│   ├── api-client/
│   └── shared-config/
├── infrastructure/
├── scripts/
├── e2e/
├── architecture/
├── contracts/
├── delivery/
├── features/
├── registers/
├── standards/
├── surfaces/
├── PROJECT_MASTER_SPECIFICATION.md
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
└── turbo.json
```

Create a shared package only when it has a real consumer. Do not create empty architecture for appearance.

## 5. Technical direction

### Backend

Use TypeScript, NestJS, Drizzle and PostgreSQL.

Keep Version 1 as a modular monolith. Domain modules may depend on platform services; platform infrastructure must not depend on business-domain modules.

Separate:

- transport/controllers,
- application orchestration,
- domain rules,
- persistence/infrastructure.

Do not call controllers from controllers or bypass application services for business operations.

### Frontend

Use React with Vite for the Ops Portal.

The frontend consumes the canonical API through generated wire types. UI-only form and presentation models are allowed, but parallel hand-written API DTOs are not.

The server remains authoritative for permissions, prices, state transitions, commercial eligibility, concurrency and financial outcomes.

### Database

Use one PostgreSQL database and one canonical migration history under `apps/api/migrations/`.

Application runtime credentials must not own the database or bypass row-level security. Migration and runtime identities remain distinct.

Do not use automatic destructive schema synchronization at application startup.

### API

`contracts/openapi.yaml` is the maintained HTTP contract.

Generate client types from it. Generate the backend API description from the actual NestJS application for comparison. Never copy the canonical OpenAPI file and present that copy as proof of implementation.

Use the contract's actual authentication, CSRF, header, idempotency and concurrency requirements.

## 6. Security and behavior rules

Implementation must preserve the security design in `architecture/SECURITY_DESIGN.md` and the API/security requirements in the retained contracts.

In particular:

- do not replace approved opaque sessions with JWTs;
- browser authentication and Rider authentication remain distinct where specified;
- enforce server-side authorization on every protected action;
- keep sensitive secrets and credentials out of source control and browser bundles;
- reject unknown or invalid input according to the contract;
- perform required audit writes in the same transaction as the business mutation;
- use real PostgreSQL security context and row-level-security tests where required;
- preserve idempotency and optimistic-concurrency semantics;
- never log credentials, raw recovery tokens or other protected secret material.

## 7. Contract-first implementation

For each operation being implemented:

1. Locate the operation in `contracts/openapi.yaml`.
2. Read its referenced schemas, security, errors and headers.
3. Read the corresponding feature/surface requirements.
4. Read the relevant domain/state/security architecture.
5. Implement the smallest coherent vertical behavior.
6. Add request/response validation and negative cases.
7. Test against real application registrations and, when persistence is involved, real PostgreSQL.

Unimplemented operations remain unimplemented. Do not create success stubs merely to make the frontend appear complete.

## 8. Testing strategy

Tests are introduced with the code they cover.

Use:

- unit/service tests for domain rules and application behavior;
- API integration tests for real NestJS request handling;
- PostgreSQL integration tests for constraints, transactions, roles and RLS;
- frontend component tests for important interaction states;
- Playwright for real browser-to-API workflows;
- contract-generation and client-freshness checks;
- migration smoke tests;
- lint, formatting and strict TypeScript checks.

Mocks may support isolated development but do not satisfy final integrated acceptance where the requirement depends on the actual API, database, browser, security boundary or platform behavior.

Every required test suite must contain meaningful assertions. A skipped or empty suite is not a pass.

## 9. Git workflow

Use the new development repository and its new remote.

- `main` is the integration branch.
- Make small coherent commits.
- Do not commit secrets, local databases, dependency directories, logs or transient test output.
- Prefer short-lived branches when a change is large enough to justify review isolation.
- Do not rewrite shared history after it is published unless explicitly agreed.
- A successful build is not equivalent to product completion.

Commit messages should describe the implemented change, for example:

```text
chore: establish pnpm workspace
feat(api): add application bootstrap
feat(identity): implement staff sign-in
test(identity): cover session expiry
```

## 10. Bootstrap roadmap

Bootstrap establishes the development platform before product feature implementation.

### B0.0 — Development repository reset

Goal: create the clean development repository from the retained specification set, remove retired governance/audit machinery and establish the new Git baseline.

Exit: retained specifications are internally usable, stale references are cleaned, Git hygiene is development-oriented, and the initial baseline is committed.

### B0.1 — Workspace and tooling

Create:

- root `package.json`;
- `pnpm-workspace.yaml`;
- pinned package manager/runtime declaration;
- shared TypeScript/lint/format configuration;
- Turborepo task graph where useful;
- root build/typecheck/lint/test scripts;
- initial CI checks.

Exit: clean dependency install, deterministic root commands and no application domain implementation.

### B0.2 — API skeleton

Create the NestJS API with:

- validated configuration;
- structured redacted logging;
- graceful shutdown;
- explicit technical health/readiness behavior;
- modular platform/domain structure;
- implementation-derived OpenAPI generation;
- initial API tests.

Exit: API boots, fails safely on invalid required configuration, shuts down cleanly and exposes no fake business endpoints.

### B0.3 — Ops Portal shell

Create the React/Vite Ops application with:

- routing;
- providers;
- query infrastructure;
- layout;
- error boundary;
- accessible structural components;
- same-origin `/api/v1` development proxy;
- frontend/component/browser smoke tests.

Exit: production build and smoke tests pass with no fabricated business data or fake authentication.

### B0.4 — PostgreSQL and Drizzle foundation

Create:

- local/test PostgreSQL environment;
- Drizzle configuration;
- one canonical migration history;
- runtime and migration connection roles;
- connection lifecycle handling;
- database integration test foundation.

Exit: fresh migrations work, runtime is non-owner, transaction behavior is proven and test teardown is safe.

### B0.5 — Generated API client

Pin a generator and create `packages/api-client/`.

Exit: generation is deterministic, freshness can be tested, Ops imports generated wire types and browser transport remains separate from other client transports.

### B0.6 — Contract/runtime conformance

Add semantic comparison and runtime validation around implemented routes.

Exit: deliberate schema, security, header and route mismatches fail the conformance checks.

### B0.7 — Integrated test harness

Create repeatable API/PostgreSQL/Ops test composition, sandbox/capture adapters and deterministic fixtures.

Exit: a real browser/API/database technical journey runs end to end and teardown is safe.

### B0.8 — CI consolidation

Consolidate application, database, contract and browser checks in CI.

Exit: mandatory failures propagate, artifacts correspond to the tested source revision and clean installation/build/test works on CI.

### B0.9 — Developer setup

Document and prove the local Windows/WSL2 and Linux CI workflows.

Exit: a clean checkout can install, start infrastructure, migrate, run applications, test and stop safely using documented commands.

### B0.10 — Bootstrap acceptance

Run the complete bootstrap validation on the final integrated state.

Exit: workspace, API, Ops, PostgreSQL, client generation, conformance, tests and CI foundations are ready for product slice development.

## 11. Product implementation after bootstrap

Follow `delivery/IMPLEMENTATION_PLAN.md` and the current slice files.

The first product slice is `delivery/slices/SLICE-000.md`.

For every slice:

1. identify the active acceptance criteria;
2. map them to API operations, screens, domain rules and tests;
3. implement in small vertical increments;
4. test real backend and frontend integration as applicable;
5. keep incomplete client/platform requirements visible;
6. declare a slice complete only when its required criteria are actually satisfied.

Do not widen or narrow a slice merely for implementation convenience.

## 12. External services and background processing

Do not introduce a broker, Redis, worker system or external provider merely because it is common architecture.

Add infrastructure only when a retained requirement needs it.

When asynchronous business effects are introduced, follow `architecture/BACKGROUND_JOBS_AND_EVENTS.md`: transactional intent, idempotent effects, bounded retries, unknown-result handling and operational recovery.

Local and test environments must not contact production payment, messaging or security providers.

## 13. Completion definitions

Keep these states distinct:

- **Task complete:** the bounded implementation task works and its validation passes.
- **Bootstrap complete:** B0.1–B0.10 foundations operate together.
- **Milestone complete:** a defined partial capability is integrated.
- **Slice complete:** all required slice acceptance criteria are satisfied.
- **Release ready:** the approved release scope and operational prerequisites are proven.

No partial milestone should be presented as complete product scope.

## 14. Agent usage

When using Claude Code or another coding agent, provide only the context required for the task:

- exact goal;
- exact files or paths;
- relevant retained specification sections;
- constraints;
- tests/commands to run;
- explicit stop conditions.

Do not ask an agent to "implement the whole project" or reinterpret specifications.

The default workflow remains one bounded task, one validation cycle, then the next task.
