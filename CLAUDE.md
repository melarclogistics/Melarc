# Melarc

The specifications and engineering foundation of the Melarc logistics platform: a NestJS API, a React Ops Portal, PostgreSQL, a contract-generated API client and an integrated test harness, built one bounded task at a time. `apps/api/src/tools/contract/implemented-scope.ts` lists the API operations that exist.

## Start here

1. [Development Execution Plan](delivery/DEVELOPMENT_EXECUTION_PLAN.md): how work is done, the technical direction and the bootstrap roadmap. Read all of it before any task.
2. [Bootstrap B0 Runbook](delivery/planning/BOOTSTRAP_B0_RUNBOOK.md): the selected bootstrap task. Its "Carried forward" notes say what each finished task did not do.
3. Product work starts only once bootstrap is accepted ([runbook §5](delivery/planning/BOOTSTRAP_B0_RUNBOOK.md#5-product-development-handoff)): [Implementation Plan](delivery/IMPLEMENTATION_PLAN.md), then the slice it names ([delivery/slices/](delivery/slices/SLICE-000.md); the first is `SLICE-000`).
4. Running the code: [Developer setup](DEVELOPMENT.md).

## Working rules

- Execute only the bounded task requested. State the affected files and the smallest meaningful validation; report actual commands, results and blockers. Fix failures before dependent work continues.
- Read only the relevant master sections, owning contracts, feature criteria, surfaces and architecture (map below). Each fact has one owning document: link to it, do not restate it.
- Current retained specifications define the requirements. Historical identifiers (`MSC-DEC-…`, `OQ-…`) are provenance only; the current rule or unresolved input is stated locally. Do not rebuild old governance machinery.
- If sources conflict or a necessary product value is unset, surface the specific issue before implementing the affected behavior. Continue independent work; never invent defaults or product approval.
- Preserve the user's changes. No reset, broad cleanup, mass formatting, destructive database operation (`db:reset`, `db:orphans --drop`, `down --volumes`), dependency upgrade, commit, push or deployment unless the task authorizes it. Local services (Docker, PostgreSQL, WSL) are started by the developer: give the command, do not run it.
- Share source for review only with `pnpm run package:source`, never a ZIP of the folder: the folder holds populated `.env` files, dependencies and build output that `.gitignore` does not keep out of an archive. Never print, log or paste a credential value.
- Stop on the runbook's [stop conditions](delivery/planning/BOOTSTRAP_B0_RUNBOOK.md#7-stop-conditions). End each task in its [handoff format](delivery/planning/BOOTSTRAP_B0_RUNBOOK.md#8-task-handoff-format), adding the findings the Product Owner must decide (conflicts, provisional values, suggestions) and any check you did not run.
- Keep OpenAPI, permissions, errors, settings, state transitions and acceptance IDs stable unless an intentional contract change is requested. Generate the API description from the real application; never present a copy of the contract as proof.
- Apply the [engineering standards](standards/engineering-standards.md), [definition of ready](standards/definition-of-ready.md) and [definition of done](standards/definition-of-done.md) to what you deliver. Specification prose, mocks and skipped tests do not prove an integrated feature.
- Keep active documents current and concise; Git is the history. Where a row below links a `CLAUDE.md`, it holds the rules for that area: read it before changing the area.

## Where things are

| Need | Open |
|---|---|
| Product scope and cross-system requirements | [Master specification](PROJECT_MASTER_SPECIFICATION.md): read only the sections you need |
| Entities, states, permissions, errors, settings, audit, data scope | [contracts/](contracts/CLAUDE.md): [domain model](contracts/domain-model.md), [state machines](contracts/state-machines.md), [permissions](contracts/permissions.md), [errors and enums](contracts/errors-and-enums.md), [settings](contracts/settings.md), [audit](contracts/audit.md), [data scope](contracts/data-scope-registry.md) |
| HTTP API: operations, schemas, security | [contracts/openapi.yaml](contracts/openapi.yaml) |
| Workflow behavior and acceptance criteria | [features/](features/CLAUDE.md), indexed in [features/README.md](features/README.md) |
| Screens and client behavior | [surfaces/overview.md](surfaces/overview.md): [Ops](surfaces/ops-portal.md), [Vendor](surfaces/vendor-pwa.md), [Rider](surfaces/rider-android.md), [Recipient](surfaces/recipient-channel.md), [service guidelines](surfaces/service-guidelines.md) |
| Brand, design tokens, UI component patterns | [design/BRAND_FOUNDATION.md](design/BRAND_FOUNDATION.md) (active); [design/DESIGN_SYSTEM.md](design/DESIGN_SYSTEM.md) and [design/COMPONENT_PATTERNS.md](design/COMPONENT_PATTERNS.md) (all three active; the last two approved 6 October 2026) |
| Solution structure, modules, database | [architecture/SOLUTION_ARCHITECTURE.md](architecture/SOLUTION_ARCHITECTURE.md) |
| Security design; reporting a vulnerability | [architecture/SECURITY_DESIGN.md](architecture/SECURITY_DESIGN.md), [security test matrix](standards/security-test-matrix.md); [SECURITY.md](SECURITY.md) |
| Environments, secrets, release path | [architecture/DEPLOYMENT_AND_ENVIRONMENTS.md](architecture/DEPLOYMENT_AND_ENVIRONMENTS.md) |
| Migrations and seeding | [architecture/MIGRATION_AND_SEEDING.md](architecture/MIGRATION_AND_SEEDING.md) |
| Background jobs and events | [architecture/BACKGROUND_JOBS_AND_EVENTS.md](architecture/BACKGROUND_JOBS_AND_EVENTS.md) |
| Logging, metrics, backup, recovery | [architecture/OBSERVABILITY_AND_RECOVERY.md](architecture/OBSERVABILITY_AND_RECOVERY.md) |
| Terminology | [registers/GLOSSARY.md](registers/GLOSSARY.md) |
| Run, test, stop, reset locally; package the source for review | [DEVELOPMENT.md](DEVELOPMENT.md); the database service is [infrastructure/postgres/](infrastructure/postgres/compose.yaml) |
| API code | [apps/api/](apps/api/CLAUDE.md) |
| Ops Portal code | [apps/ops-web/](apps/ops-web/CLAUDE.md) |
| Generated API client | [packages/api-client/](packages/api-client/CLAUDE.md) |
| Browser, API and database tests | [e2e/](e2e/CLAUDE.md) |
| Root tooling, CI scripts, documentation checks | [scripts/](scripts/CLAUDE.md); CI is [.github/workflows/ci.yml](.github/workflows/ci.yml) |

The master specification names files that are not in this repository (`00_SPECIFICATION_CHARTER.md`, `DRAFT_PERMISSIONS_CATALOG_V0.1.md`); do not look for or recreate them. `DOMAIN_MODEL.md` is now [contracts/domain-model.md](contracts/domain-model.md).

## Commands

```text
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run build
pnpm run contract:check
pnpm run api-client:check
pnpm --filter @melarc/api run db:check
pnpm run test:db
pnpm run test:browser
pnpm run test:e2e
pnpm audit --audit-level high
```

These are the checks of CI ([ci.yml](.github/workflows/ci.yml)). `test:db` and `test:e2e` need the local database; `test:browser` and `test:e2e` need Chromium; `contract:check` needs a build. Setup, ports and reset are in [DEVELOPMENT.md](DEVELOPMENT.md).

## Never

- Trust the frontend for totals, prices, OTP, payment, ownership, hub assignment or state transitions; authorize on held permissions, never role names; deny by default ([the full list](standards/engineering-standards.md#7-non-negotiable)).
- Edit a generated file, or hand-write an API type in the Ops Portal.
- Change a contract silently: the contract and the code change together, deliberately.
- Commit a secret, a `.env` file, a local database or a log, or write a credential or token to a log.
- Add a success stub for an unimplemented operation, or fabricate data or sign-in to make a screen look finished.
- Replace opaque sessions with JWTs, merge browser and Rider authentication, or add a broker, Redis, worker or provider that no retained requirement needs ([plan §6 and §12](delivery/DEVELOPMENT_EXECUTION_PLAN.md#6-security-and-behavior-rules)).
- Depend on the git-ignored `tmp/` folder or any other machine-local state.
