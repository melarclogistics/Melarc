# Definition of Ready — operational checklist

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.6 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** the runnable form of §44, plus the project-specific readiness conditions this programme adds
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../PROJECT_MASTER_SPECIFICATION.md) §44

## How to use this

§44 states the criteria. This turns them into checks with a yes-or-no answer, and adds the conditions specific to how this programme is built.

**Readiness is assessed for the complete vertical slice** — never for frontend and backend separately (§44). A slice half-ready is `NOT_READY`.

Run it once, record the verdict in the slice document, and re-run it if anything upstream changes.

---

## A. Project-specific preconditions

- [ ] The bounded scope and its relevant contracts, features, surfaces and architecture are identified.
- [ ] The retained sources agree on the behavior being implemented; unresolved conflicts are surfaced before affected work begins.
- [ ] The slice or task cites its governing requirements directly; no external traceability register is required.
- [ ] Missing values and provider inputs have explicit consequences. A missing launch value need not block unrelated development, but may block the path that needs it.
- [ ] Rules use the strongest practical enforcement described in [engineering-standards.md](engineering-standards.md) §2.

## B. Product readiness *(§44.1)*

- [ ] Objective, users, scope and business value stated
- [ ] Governing specification sections identified and cited
- [ ] Normal, alternate, failure, cancellation, retry and terminal paths **exhaustively documented. All six path types apply to every feature unless the feature document explicitly states that a given path type does not apply and names the reason.** A path type that is omitted without explanation is a readiness defect, regardless of feature scope.


- [ ] Material product choices are reflected in their owning retained specification
- [ ] Blocking questions and contradictions resolved; any accepted temporary or manual policy written explicitly
- [ ] In-scope and out-of-scope behaviour clear for this release

## C. Domain and rule readiness *(§44.2)*

- [ ] Actors, ownership, permissions, entities, fields, relationships and invariants known
- [ ] Canonical states and allowed transitions defined — **including invalid transitions**
- [ ] Reasons, settings, thresholds, calculations and snapshot rules defined
- [ ] Idempotency- and concurrency-sensitive commands identified
- [ ] Audit, notification, evidence, privacy and retention consequences identified
- [ ] Migration or backfill implications known where existing data is affected

## D. Frontend readiness *(§44.3)*

- [ ] Page, route and user-flow location known
- [ ] Approved wireframes, or an explicitly accepted low-fidelity interaction specification
- [ ] Forms, fields, tables, filters, actions and role visibility defined
- [ ] **Loading, empty, validation, error, retry, offline, stale/conflict, success and permission-restricted states specified.** Nine states — the eight §44.3 lists and `retry`, which §41.1 adds ([surfaces/overview.md](../surfaces/overview.md) §4) — a screen specified only in its success state is not ready
- [ ] Responsive and accessibility expectations stated

## E. Backend and contract readiness *(§44.4)*

- [ ] Domain or service boundary known
- [ ] OpenAPI operations and schemas defined for the intended implementation scope
- [ ] Stable enums, error codes, formats, pagination, upload and authentication behaviour known
- [ ] External integration and background-job behaviour defined where applicable
- [ ] Security and ownership tests identifiable — see [engineering-standards.md](engineering-standards.md) §3.1

## F. Acceptance and delivery readiness *(§44.5)*

- [ ] **Testable acceptance criteria exist and map to governing sections.** Criteria cite retained specification sections or named retained rules rather than relying on historical tracking identifiers.
- [ ] Criteria are in §43.1 Given/When/Then form and name surface, actor, initial state, expected state, expected error code and test level
- [ ] FE and BE responsibilities and dependencies assigned
- [ ] Test levels, seed and fixture needs, and required environments known
- [ ] Observability and operational recovery defined for material failure modes
- [ ] **The slice is small enough to complete, integrate, review and demonstrate as one coherent unit**

---

## G. Acceptance Criteria quality gate

These are readiness conditions, not code-review conditions — they are checked before a slice enters implementation.

Every acceptance criterion in a ready slice must satisfy **all four** of the following measurable properties. An AC missing any one is a readiness defect and must be corrected before the slice may be marked `READY`.

- [ ] **Specific, named initial state.** "Given a vendor account" is not a named state. "Given a `VendorAccount` with status `ACTIVE` and a live session" is. The initial state must be derivable from the domain model or state machine without inference.
- [ ] **Exact outcome including error code where applicable.** "Then the request is refused" is not exact. "Then the response is `403 PERMISSION_DENIED`" is. If the outcome involves a state change, the terminal state must be named.
- [ ] **Named surface and test level.** The AC must identify which surface (Melarc Vendor, Melarc Rider, Melarc Ops, API, contract) the criterion exercises and the test level (unit, API, integration, e2e, contract). "Surface: API · Test level: integration" meets the bar.
- [ ] **Traceable governing section reference.** The AC must cite at least one `§` reference or named rule in the retained specification set. Historical decision identifiers may appear as supplementary provenance, but they are never sufficient on their own. An AC with no retained governing citation is testing an assertion, not a specification.

---

## Verdict *(§44.6)*

Report READY for the bounded work only when its applicable requirements are defined and its blockers resolved. Otherwise state the exact missing requirement and affected work. Readiness is not a claim that code exists or that a release has passed.

