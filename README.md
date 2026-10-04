# Melarc

Melarc's retained product and technical specifications for manual incremental development.

Start with [Development Execution Plan](delivery/DEVELOPMENT_EXECUTION_PLAN.md), then the selected task in the [Bootstrap B0 Runbook](delivery/planning/BOOTSTRAP_B0_RUNBOOK.md). Coding-agent guidance is in [CLAUDE.md](CLAUDE.md).

| Source | Owns |
|---|---|
| [Master specification](PROJECT_MASTER_SPECIFICATION.md) | Product scope and cross-system requirements |
| [Contracts](contracts/) | API, entities, states, permissions, errors, settings, audit and data scope |
| [Feature index](features/README.md) | Workflows and acceptance criteria |
| [Surfaces](surfaces/overview.md) | Client behavior and interfaces |
| [Architecture](architecture/SOLUTION_ARCHITECTURE.md) | Technical mechanisms |
| [Engineering standards](standards/engineering-standards.md) | Implementation quality and validation |
| [Implementation plan](delivery/IMPLEMENTATION_PLAN.md) | Product-slice order and dependencies |
| [Glossary](registers/GLOSSARY.md) | Shared terminology |

The repository specifies a product; it does not claim that the application or its tests have been implemented. Historical decision/question IDs retained within detailed specifications are provenance, not dependencies on removed registers. Current rules and unresolved inputs must be stated in the owning retained source. Resolve any remaining conflict before implementing the affected behavior.

Production credentials/provider inputs, unresolved settings and later-slice design are deliberately not invented. The first priced pickup integration also needs the hub fee-configuration decision described in Implementation Plan §4a. These do not prevent independent bootstrap tasks.
