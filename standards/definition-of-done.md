# Definition of Done — operational checklist

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.8 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** the runnable form of §45 for a feature or slice
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../PROJECT_MASTER_SPECIFICATION.md) §45

## What the specification requires of a feature — §43.3

A feature must deliver its business outcome across the necessary surfaces and backend, including material exception paths. Completion covers business rules, permissions, states, errors, interface states, concurrency, audit, notifications, evidence, tests and updated documentation. A bounded bootstrap task reports its own result; it does not claim an entire feature complete.

## How to use this

Apply the relevant items below to the delivered scope. Unimplemented client surfaces and unexecuted release checks must be reported as such. Product maker-checker controls and user acceptance remain requirements where specified.

## 0. Disqualifiers — check these first

§45.7 lists conditions under which a feature is **not** Done regardless of everything below. Checking them first saves working a full checklist on something already disqualified.

- [ ] More than the happy path works
- [ ] FE and BE are integrated
- [ ] Permissions are enforced **server-side**, not by hidden buttons
- [ ] No manual database edit is required for normal operation
- [ ] No known blocking defect has been relabelled as future work without Product Owner approval
- [ ] Documentation, tests and production code describe the **same** behaviour

Any unticked box here means stop. The feature is not Done and the rest of the checklist is moot.

## A. Product completion *(§45.1)*

- [ ] Approved acceptance criteria pass
- [ ] The Product Owner can **demonstrate** the normal and material exception paths
- [ ] No in-scope requirement silently omitted or replaced by developer preference
- [ ] Any scope change, assumption or follow-up recorded in the owning specification or task

## B. Frontend completion *(§45.2)*

- [ ] Approved screens and interactions implemented for authorized roles
- [ ] Loading, empty, validation, error, **retry**, offline, conflict, success and permission states all work, or are recorded as not applicable to the surface — nine, per [surfaces/overview.md](../surfaces/overview.md) §4
- [ ] Responsive and accessibility requirements verified
- [ ] The frontend uses canonical contract enums and **does not duplicate authoritative calculations**
- [ ] Sensitive data not exposed in UI, storage, analytics or logs beyond approved need
- [ ] **No hidden server value is echoed back** — the blind declared count, authoritative price, ownership identifier or permission decision (§42.3)

## C. Backend completion *(§45.3)*

- [ ] Business rules, state guards, ownership and permissions enforced **server-side**
- [ ] Commands atomic; retry, idempotency and concurrency behaviour tested where applicable
- [ ] Audit events, notifications, files, integrations and background effects behave as specified
- [ ] Migrations, indexes, constraints, backfills and rollback reviewed
- [ ] **OpenAPI and domain documentation match the implementation** — drift detection passes (§42.1)

## D. Test completion *(§45.4)*

Coverage obligations per level are in [engineering-standards.md](engineering-standards.md) §3.

- [ ] Unit tests for calculations and rule branches
- [ ] Service and domain tests for transitions and invariants, **including invalid transitions**
- [ ] API tests for schemas, errors, permissions, ownership, duplicates and concurrency
- [ ] Frontend component and flow tests
- [ ] FE–BE contract and end-to-end tests
- [ ] Offline synchronization tests — capture time, **ordering**, idempotency, conflict status
- [ ] **Negative-access tests at all five surfaces**: query, export, notification, file, API (§37.6)
- [ ] Performance and reliability tests for high-risk paths
- [ ] Product Owner or UAT evidence recorded
- [ ] Applicable CI and task checks pass; skipped or not-run checks are disclosed with their consequences

## E. Operational completion *(§45.5)*

- [ ] Logs, metrics, alerts and dashboards cover the new failure modes
- [ ] Support and operations users have appropriate status visibility and recovery procedures
- [ ] Configuration, secrets, provider setup, migrations, deployment and rollback documented
- [ ] Required runbooks and release notes updated
- [ ] Backup, restore or reconciliation consequences addressed

## F. Documentation completion *(§45.6)*

- [ ] Affected master, feature, surface and architecture text agrees with current behavior.
- [ ] Domain model, states, OpenAPI and client generation agree.
- [ ] Implementation notes, setup instructions, runbooks and deprecation notes are updated where affected.
- [ ] Local links and relevant contract checks pass.
- [ ] Actual commands, results and remaining limitations are reported. Coherent commits follow the execution plan; no document approval package is required.

## Verdict

Report the bounded task's outcome and any remaining blocker. A slice is complete only when its applicable requirements and criteria are satisfied. Documentation completion, implementation completion and release verification are distinct claims. A load test or restore drill remains not run until it actually executes; retain useful results without creating a separate approval bureaucracy.
