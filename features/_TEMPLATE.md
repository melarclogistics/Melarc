# Feature name

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Owns:** one workflow outcome
> **Slice:** the owning delivery slice

Copy this template to `features/<domain>/<feature-name>.md`. Replace all placeholders and use `../../` rather than `../` for the root-level links below after copying. Remove this instruction from the completed feature.

## 1. Purpose and scope

State the user/business outcome, in-scope work and exclusions.

## 2. Governing requirements

Cite the relevant sections of the [master specification](../PROJECT_MASTER_SPECIFICATION.md) and current owning contracts. State any unresolved conflict explicitly.

## 3. Actors and surfaces

List the actors, their permitted actions and the relevant surface specification.

## 4. Preconditions

State required state, ownership, configuration, predecessor capabilities and provider inputs.

## 5. Behavior

Describe normal, alternative, failure, cancellation, retry and terminal paths. Explain any inapplicable path. Include atomicity, idempotency, concurrency, offline effects, custody, money and notifications where relevant.

## 6. Entities

Point to [domain-model.md](../contracts/domain-model.md); do not copy field definitions.

## 7. States

Point to [state-machines.md](../contracts/state-machines.md). Identify transitions exercised, including invalid paths.

## 8. Permissions and scope

Point to [permissions.md](../contracts/permissions.md) and [data-scope-registry.md](../contracts/data-scope-registry.md). Cover negative access.

## 9. Settings

Point to [settings.md](../contracts/settings.md); state the effects of missing configuration.

## 10. Errors

Point to [errors-and-enums.md](../contracts/errors-and-enums.md).

## 11. Audit and side effects

Point to [audit.md](../contracts/audit.md); identify notifications, files and asynchronous effects.

## 12. API operations

Name the operations in [openapi.yaml](../contracts/openapi.yaml). Every required identifier must have an authorized producer/read path.

## 13. Acceptance criteria

Use stable, unique identifiers and Given/When/Then outcomes. Include failure, permission, retry and concurrency criteria as applicable. Link implementation tests to the criteria they prove.

## 14. Unresolved requirements

State the missing decision/value/input, the affected behavior and when it is needed. Write “None identified” only after checking the relevant inputs. Do not invent a default.

## 15. Related documents

Link actual retained dependencies; do not invent links to unwritten files.

## 16. Implementation status

Describe what exists and what remains by surface/backend. Specification prose and mocks are not integrated implementation evidence.
