# Engineering Standards

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 1.0 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** implementation quality and verification requirements.

## 1. Working method

Follow [DEVELOPMENT_EXECUTION_PLAN.md](../delivery/DEVELOPMENT_EXECUTION_PLAN.md): one bounded task, the smallest meaningful validation, actual results, and correction of failures before proceeding. Git records changes. Specifications describe current behavior; update affected sources together when behavior changes.

A historical document approval label does not establish implementation readiness. Use [definition-of-ready.md](definition-of-ready.md) and [definition-of-done.md](definition-of-done.md) for the task or slice being delivered. Product choices unresolved in the retained sources must be surfaced to the Product Owner.

## 2. The enforcement ladder

**Every rule is pushed as far up this ladder as it will go. A rule enforced at review level that could have been structural is a defect in the enforcement, not merely a risk carried.**

| Level| What it means| Violation is|
|---|---|---|
| **1 — Structural**| The shape forbids it. The field does not exist; the schema rejects it; the type cannot hold the wrong value| **Impossible**|
| **2 — Mechanical**| Something that runs checks it — a test, a script, a CI step| Possible, but **always caught**|
| **3 — Review**| A human must notice| Caught **only if someone is paying attention**|

Level 3 is where rules go to die quietly. It is acceptable only when 1 and 2 are genuinely unavailable, and the document carrying the rule must say so.

### 2.1 Worked examples from this programme

These are the standard, not illustrations of it.

| Rule| Level| How|
|---|---|---|
| Blind count: the declared count is never served or accepted before commit (§35.5.2)| **1**| `HubIntakePreCount` has **no** `rider_declared_count` property; the count request declares `additionalProperties: false` with `physical_count` as its only field. A conforming implementation cannot leak it|
| Money is minor-unit integers (§34.6)| **1**| Integer type plus a mandatory `_minor` suffix. A float cannot be stored and a unit error is visible at the call site|
| The client never sets a price or destination zone (§35.6.6, §42.3)| **1**| Absent from `OrderItemize`, which is `additionalProperties: false`|
| An order carries two orthogonal state fields (§36.9, §36.11)| **1**| Two enum fields. A single flattened enum cannot satisfy the schema|
| Zero collection is a failed pickup (§36.4)| **2**| Server-side guard plus a test. Cannot be structural — the count is a legitimate integer|
| `PAYMENT_REQUIRED` counts toward parity (§35.6.11)| **2**| Test case asserting an intake with a `PAYMENT_REQUIRED` order closes|
| Stop variance and hub blind count stay independent| **2**| Test asserting `rider_declared_count` is **not** derived from `collected_count`. This is an absence of coupling, which no schema can express|
| Vendor self-cancel ends at rider assignment| **2**| Cross-record guard plus tests for both paths and the charge|
| Reason metadata drives mandatory fields (§35.9.2)| **2**| Test that a reason requiring a photo rejects a submission without one|

### 2.2 Improving enforcement

Prefer schema constraints, database constraints and types where they express the actual rule; otherwise use focused executable tests. Use review for requirements that cannot be meaningfully automated. Record any material limitation with the affected task. A test proves only what it exercises.

### 2.3 Current authority

Active sections state current rules. Keep historical change narratives out of implementation instructions. Reconcile an obsolete statement in every affected source rather than appending another competing rule. Historical decision identifiers, where retained for provenance, require no external register; the operative rule must be stated in the retained document.

## 3. Test obligations

§45.4 lists the test levels. This section states what each must actually cover here.

| Level| Must cover|
|---|---|
| **Unit**| Every calculation and rule branch: service-area base fee, corridor off-day fee, the size-class surcharge **in third-party mode only**, carrier cost plus margin, payer split, credit-exposure arithmetic, attempt counters|
| **Service / domain**| Every state transition in [state-machines.md](../contracts/state-machines.md), including **invalid** transitions. A transition table with no negative tests is untested|
| **API**| Schemas, error codes, permissions, ownership, duplicates, concurrency. Every operation returns its documented codes for the documented conditions|
| **Frontend**| Component and flow tests including loading, empty, error, offline, conflict, and permission-restricted states (§45.2)|
| **Contract**| FE–BE conformance plus **drift detection** — §42.1 requires tests and schema generation to catch code diverging from the contract|
| **End-to-end**| The slice's happy path plus its material exception paths|
| **Offline sync**| Capture-time preservation, **ordering**, idempotent replay, and conflict surfacing (§35.3.9)|
| **Security / isolation**| See §3.1|
| **Performance**| High-risk paths against §40's targets: 3-second normal action, 5-second critical write|

### 3.1 Negative-access tests are mandatory, at five surfaces

§37.6 is explicit and unusually specific: "every **query, export, notification, file, and API operation** must enforce vendor ownership and hub/role scope with negative-access tests."

Five surfaces, not one. An API guarded correctly while an export or a notification leaks across vendors fails this standard. Each requires a test proving the *wrong* actor is refused — proving the right actor succeeds is not the same test and does not substitute.

### 3.2 Scope and honest results

Run the applicable test levels for the behavior changed. A small documentation or bootstrap task does not require an application-wide test run. At slice completion, the implemented slice must satisfy its relevant unit, domain, API, frontend, contract, end-to-end, security and offline obligations.

Do not report skipped, empty, mocked or not-yet-created tests as integrated proof. Any necessary test quarantine states the reason, affected behavior, owner and expiry in the task or issue. An unresolved failure is reported and fixed before proceeding with dependent work.

### 3.3 CI, coverage and static analysis

GitHub Actions is the CI platform. Introduce checks with the code they cover, following Bootstrap B0.8. Use strict TypeScript checking, linting, meaningful tests, builds and contract generation/conformance checks. No global coverage percentage is required: each implemented acceptance criterion needs meaningful test coverage, including invalid transitions and negative access.

Enforce the architecture's rules for money units, state writes and route permissions. Include dependency vulnerability scanning; high/critical findings require a fix or an explicit, time-bounded exception with its reason and owner. Performance and recovery checks run before the relevant release. Branches and commits follow the execution plan; this standard does not require a PR for every manual task.

## 4. Specification and contract checks

Check local links after navigation edits. Validate OpenAPI and resolve its references after contract edits. Compare actual API-generated schemas with the canonical contract when the API exists; copying the canonical document to the generated path is not generation. Compare only the intentionally implemented scope until the complete API exists, and identify that scope explicitly.

Preserve schema names, operation IDs, permission keys, error codes, setting keys, audit events, state values and acceptance-criterion IDs unless an intentional contract change requires otherwise. Validate examples and references against the current owning contract. Counts in prose must be derived or omitted.

The substantive invariants behind the former checks remain obligations of their owning contracts and feature tests: credential production and consumption, secret custody, permission and data-scope enforcement, RLS-safe technical identities, idempotency, payment settlement, custody, evidence lifecycle, configuration, transitions, retries, service commitments and recovery. Do not reintroduce a numbered historical check registry.

## 5. Contract conformance

§42.1: the implementation "must conform to and help maintain the approved version-controlled OpenAPI specification. Contract-visible operations, payloads, enums, errors and behaviours require reviewed contract changes; **current code does not silently override the contract**."

- A code change that alters contract-visible behaviour without a contract change is a defect regardless of test results.
- Enums come from [errors-and-enums.md](../contracts/errors-and-enums.md) and the documents it indexes. A literal string where an enum belongs is a defect.
- Error codes are **stable API surface**. Renaming one is a breaking change under §39.1's deprecation policy.
- A withdrawn code is never reused. §5.6 of the errors catalogue records two already.

## 6. Refining specifications with implementation

If implementation exposes ambiguity or requires a stronger mechanism, update the affected contract and prose before relying on it. Preserve the product outcome and surface any product-policy change to the owner. Code does not silently override the specification.

## 7. Non-negotiable

Derived from §37.1, §42.2 and §45.7. Each is a defect regardless of any other consideration.

- **Never trust the frontend** for totals, prices, OTP assertions, payment success, ownership, hub assignment or status transitions.
- **Authorization is checked against held permissions, never role names** — a check testing `role == "SENIOR_OPS"` is wrong however correct its outcome, because bundles are editable configuration.
- **Deny by default.** No permission match means refused, never permitted by framework default.
- **Permissions enforced only by hidden buttons is not enforcement** (§45.7).
- **No manual database edit is part of normal operation** (§45.7).
- **Secrets, full credentials, raw OTPs and unnecessary personal data never enter audit logs** (§38.2).
- **Nothing operational is hard-deleted.** Correction is forward-only; deactivation, not deletion.
- **Delete, archive, anonymize and retention behaviour is explicit** and never left to framework cascade defaults (§42.6).
- **Override authority follows the act, not the habit**. An override that **verifies** a fact by an alternative means sits at Ops; an override that **waives** a rule sits at Senior Ops or above. Placing a verification at Senior Ops delays field work for no control gained; placing a waiver at Ops removes a control. Ask which the act is before assigning the floor.
- **An operational or custody decision is never blocked by missing commercial configuration**. A parcel's disposition cannot wait on a price nobody has entered. Where a commercial setting sits in an operational path, an unset value produces a **recorded** absence and the operation proceeds — never a halt. `SETTING_MISSING` is correct for pricing and configuration paths and wrong for operational ones; the trap is that both call the same resolver.

## 8. Read the governing requirements

For each bounded task, read its governing operational sections, owning contracts, relevant feature criteria and surface behavior. Identify every governing section the task actually touches. Reconcile conflicts before implementing the affected behavior; avoid loading unrelated specification history.

## 9. Unresolved requirements

Keep an unresolved requirement in the document that owns it, with the missing choice or input and the work it blocks. Do not manufacture a value or an approval to obtain a passing result.
