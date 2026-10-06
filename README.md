# Melarc

Melarc's retained product and technical specifications for manual incremental development.

Start with [Development Execution Plan](delivery/DEVELOPMENT_EXECUTION_PLAN.md), then the selected task in the [Bootstrap B0 Runbook](delivery/planning/BOOTSTRAP_B0_RUNBOOK.md). To run the code on your machine, follow [Developer setup](DEVELOPMENT.md). [CLAUDE.md](CLAUDE.md) is the map for coding agents and for anyone returning to the repository: where each thing is, which rules apply, and what is expected.

| Source | Owns |
|---|---|
| [Master specification](PROJECT_MASTER_SPECIFICATION.md) | Product scope and cross-system requirements |
| [Contracts](contracts/) | API, entities, states, permissions, errors, settings, audit and data scope |
| [Feature index](features/README.md) | Workflows and acceptance criteria |
| [Surfaces](surfaces/overview.md) | Client behavior and interfaces |
| [Architecture](architecture/SOLUTION_ARCHITECTURE.md) | Technical mechanisms |
| [Engineering standards](standards/engineering-standards.md) | Implementation quality and validation |
| [Implementation plan](delivery/IMPLEMENTATION_PLAN.md) | Product-slice order and dependencies |
| [Design](design/BRAND_FOUNDATION.md) | Brand foundation, design system tokens and UI component patterns |
| [Glossary](registers/GLOSSARY.md) | Shared terminology |
| [Developer setup](DEVELOPMENT.md) | Install, local database, running the applications, tests, shutdown and reset |

The repository specifies a product; it does not claim that any product slice has been implemented. Under `apps/`, `packages/` and `e2e/` is the engineering foundation built by Bootstrap B0. Historical decision/question IDs retained within detailed specifications are provenance, not dependencies on removed registers. Current rules and unresolved inputs must be stated in the owning retained source. Resolve any remaining conflict before implementing the affected behavior.

Production credentials/provider inputs, unresolved settings and later-slice design are deliberately not invented. The first priced pickup integration also needs the hub fee-configuration decision described in Implementation Plan §4a. These do not prevent independent bootstrap tasks.
