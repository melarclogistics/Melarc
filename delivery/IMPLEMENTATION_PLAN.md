# Implementation Plan

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.66 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** the slice sequence, dependencies, and the readiness verdict for each
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../PROJECT_MASTER_SPECIFICATION.md) §44, §45, §13

## 1. What a slice is

A slice delivers a demonstrable product capability across its required surfaces and backend. Implement it as bounded tasks under [DEVELOPMENT_EXECUTION_PLAN.md](DEVELOPMENT_EXECUTION_PLAN.md); a task may cover a small part of a slice. Preserve existing slice IDs.

## 2. How a slice moves

Define scope and unresolved requirements, implement bounded increments, run meaningful checks, fix failures and demonstrate the integrated capability. The readiness and completion standards apply to the actual scope. A specification status is not a build or release result.

## 3. Sequence

Ordered by dependency, not by value. A slice appears after everything it needs.

**What the slices are collectively for — §43.4.** The baseline states the acceptance gate for the whole product, and **no document cited it** until the Phase 4 audit:

> *"Version 1 cannot be accepted until the approved launch transaction can be demonstrated **from booking through a terminal delivery/return and financial outcome, including exception recovery**."*

**That is one continuous demonstration, not a sum of slice demonstrations.** `SLICE-000` through `SLICE-004` are each demonstrable alone; §43.4 asks for booking → pickup → hub → price → dispatch → delivery → payment → reconciliation **in one run, with an exception recovered along the way**. Nothing in this plan produces that until `SLICE-004` completes, and the plan should not be read as implying otherwise.

§43.4 also names what launch acceptance still depends on: payment and reconciliation detail, technical security and OTP contracts, exceptional returns and claims, reporting targets, and measurable NFRs.

| #| Slice| Covers| Depends on| Blocked by|
|---|---|---|---|---|
| **000**| **Identity and access**| Staff, rider and vendor authentication; **credential and MFA setup**; **creating and approving a staff identity (§30.8, `MSC-DEC-425`) with the reads an approver takes a version from and the read a maker takes a bundle from**; session, device and recovery lifecycle; permission enforcement. **37 operations, 31 routes and screens, 112 criteria** — re-derived 2 October 2026 at Gate PD-3R3 (Gate PD-3R1 had 36 and 108; `MSC-DEC-439` added the bundle read and `MSC-DEC-440` one criterion for the bootstrap pair); the bundle-change operations and six criteria that needed other slices' records are not in it (§4c, `MSC-DEC-433`). *The demonstration's rider and vendor account are non-production fixtures — `MIGRATION_AND_SEEDING.md` §4a and §4b*| — Specification present; implement after Bootstrap B0. Production identity inputs remain in SLICE-000 §6. |
| **001**| **Pickup → hub receiving → itemization**| The proving slice. §21, §22, §23| 000, **014** *(build only — §4a, CRIT-15)* Specification present; requires identity and the hub fee configuration path in §4a. |
| **002**| Recipient confirmation and dispatch| §24, §20.2| 001 Specification present; dispatch requires an eligible priced order and the recipient-confirmation workflow. |
| **003**| Doorstep delivery and OTP| §25, §19.6, §26.2–26.3| 002 Specification present; production payment-provider integration remains an external dependency. |
| **004**| Delivery-fee payment and reconciliation| §26| 003 Slice document unwritten. Finance/adjustment/export features retain accounting and provider gaps, including export retention and event-history completeness. |
| **005**| Outbound third-party handoff| §24.7, §39.6| 002 Slice document unwritten. Carrier-handoff feature specifies both modes and carrier/agent authorization. |
| **006**| Returns and exceptions| §28| 003 Slice document unwritten. Return feature retains claims and exceptional-disposition gaps. |
| **007**| Vendor settlement| §27| 004 Slice document unwritten. Vendor settlement and VendorBalance design remain required. |
| **008**| Vendor administration| §29| 000 Slice document unwritten. Vendor administration features exist; deferred vendor transition design remains required. |
| **009**| Rider and staff administration| §30 — *creating and approving a staff identity is built in `SLICE-000`; the rest of staff administration is here*| 000 Slice document unwritten. Rider/staff administration owns the obligations in §4c. |
| **010**| Notifications| §31, §20.3| 002 Slice document unwritten. Notification delivery, providers, templates and retention remain required. |
| **011**| Fleet, fuel and maintenance| §34.10, §35.11| 009 Slice document unwritten. Fleet/fuel/maintenance behavior and configuration require implementation. |
| **012**| Reporting and dashboards| §32| 004 Slice document unwritten. Reporting feature defines initial requirements; complete remaining formulas and scope. |
| **013**| Settings, reason and courier administration, **and background-job / dead-letter administration** *(§4b, CRIT-16)*| §33, §35.9, §17.3, **§42.5**| 000 Slice document unwritten. Include background-job/dead-letter administration (§4b). |
| **014**| **Hub, zone and pricing administration**| §34.9, §35.10, §23.3, §23.9, `MSC-DEC-217–218`| 000 Slice document unwritten. Hub/zone/pricing administration is a dependency of the first priced pickup flow (§4a). |

Cash collection remains disabled per hub until its custody, reconciliation and variance-disposition chain is operational. This is a capability condition, not merely a slice-number dependency.

## 4. Identity foundation

Authentication, credential/session/device mechanics, authorization, audit, secrets, rate limits, recovery and negative-access tests form the foundation for protected product flows. Implement this scope before integrating dependent slices. Production external inputs are listed in SLICE-000 §6.

## 4a. Hub fee configuration before priced pickup integration

The first priced pickup flow requires hub-specific fees. Missing commercial configuration must fail visibly; an ad hoc database write is not an administration path.

Two existing options remain unresolved: implement the relevant SLICE-014 administration capability before SLICE-001 integrates, or obtain the Product Owner's explicit authorization for a bounded launch-fee seed. This cleanup chooses neither. The two existing bootstrap dependencies in [MIGRATION_AND_SEEDING.md](../architecture/MIGRATION_AND_SEEDING.md) do not implicitly authorize another.

The SLICE-014 document is unwritten. This is a real integration dependency even though there is no slice file to link yet. Bootstrap workspace/API/database tasks can proceed independently.

## 4b. The dead-letter triage queue has an architecture requirement and no slice

*CRIT-16 audit remediation, 13 September 2026.*

**§42.5 requires it in the Master Specification's own words**: *"Failed jobs must be visible and recoverable without duplicating business effects."* [BACKGROUND_JOBS_AND_EVENTS.md](../architecture/BACKGROUND_JOBS_AND_EVENTS.md) §3.3 restates the requirement in operational terms — *"a queue a person can look at,"* with audited, idempotent replay — and **nothing in this table, `surfaces/ops-portal.md`, or any slice document names the screen that satisfies it.** A dead-lettered job carrying a financial or custody effect is invisible not because the architecture failed to say so, but because no slice was ever told to build what it said.

**Assigned to `SLICE-013`, engineering scope rather than a Product sequencing call.** §42.5 sits in §42's cross-cutting API/backend engineering section, not in any of the operational domains §21–§34 map to a specific slice — the same reason `SLICE-013` exists at all: **Settings, reason-catalogue and courier administration is cross-cutting platform operation that belongs to no single parcel-flow domain**, and background-job/dead-letter administration is the identical shape of concern, one layer further down the stack. `IMPLEMENTATION_PLAN.md`'s own approver line routes **sizing** to engineers and reserves only **sequence and priority** for the Product Owner; which existing slice's scope a screen falls under is a sizing call, not a priority one, and this section makes it rather than leaving the requirement unscoped indefinitely. **The Product Owner may reassign it** — to a dedicated slice, or elsewhere — at any point without this reasoning standing in the way; what this section removes is the state where nobody owns it at all.

**No new slice is opened, and no slice count changes.** `SLICE-013`'s `Depends on` (`000`) is unaffected — the dead-letter queue's own dependency is the background-job infrastructure `000` already requires nothing beyond, since audit and permission enforcement are the only cross-cutting foundations a triage-and-replay screen needs.

## 4c. What `SLICE-000` retired, and who owes it now — `MSC-DEC-433`

Gate PD-3R1, `PDA-55`. **`SLICE-000` is not widened and the sequence does not change.** Six of its criteria and four of its demonstration rows exercised records and operations that later slices build; each moved to the first slice that owns its resource or operation, or was found already covered. **What is recorded here is what a later slice must not lose.** None of these is a decision and none blocks `SLICE-000`.

| Owed by| What| Was| Why it could not stay in `SLICE-000`|
|---|---|---|---|
| **`SLICE-001`** *(delivered)*| A vendor reaches only its own pickup requests, and a rider only assigned work; neither is told another's exists| `SLICE-000` criteria 16, 28 (the request half) and 12| Pickup requests, manifests and stops are `SLICE-001`'s. **Written as `AC-SLICE-001-79` and `-80`**|
| **`SLICE-001`** *(covered)*| State is evaluated with permission: vendor self-cancellation closes at assignment| `SLICE-000` criterion 27| `cancelPickupRequest` is `SLICE-001`'s. **`AC-SLICE-001-05` and `-12` already prove it**; no criterion is added|
| **`SLICE-009`** — rider administration| **A rider's status change to `INACTIVE` or `SUSPENDED` ends the live session in the same transaction**, and the next call is `SESSION_INVALID`. It must call the same `terminateSessions` that `revokeRiderDevice` does ([SECURITY_DESIGN.md](../architecture/SECURITY_DESIGN.md) §15.3)| the status-change half of `AC-SLICE-000-46`, which now stands on the two revocation operations| **No operation in `SLICE-000` sets a rider's status.** The revocation mechanism is proved there on `revokeRiderDevice` and `revokeSession`|
| **`SLICE-009`** — staff administration| **`proposeBundleChange` and `approveBundleChange`**, with `proposeBundleChange` taking its `If-Match` from `getStaffIdentity` (built in `SLICE-000`). Two criteria are owed with them: **a reduced bundle ends every live session with `AUTHORITY_CHANGED` and the next sign-in carries the reduced snapshot**, and **removing a permission from a bundle takes effect on the holder's next session with no code change**| `SLICE-000` criterion 34, and the operation-level form of criterion 31| **No operation edits a role bundle's contents in `SLICE-000`.** The no-code-change principle is already proved there by `AC-SLICE-000-05` and `-06`|
| **`SLICE-009`** — staff offboarding| **Succession**: each of the two bootstrap administrators is offboarded only after two non-bootstrap successors are approved, credentialed, MFA-ready and have each signed in, and **neither is ever deleted** ([MIGRATION_AND_SEEDING.md](../architecture/MIGRATION_AND_SEEDING.md) §3, `MSC-DEC-440`). Its termination reason is `OFFBOARDED`| the demonstration row *Succession*| Offboarding is staff administration. The bootstrap path up to and including the first sign-in, **for both identities**, **is** `SLICE-000`'s (`AC-SLICE-000-92`, `-93`, `-118`)|
| **The first slice that returns an order to a Vendor**| A vendor asking for another vendor's **order** is refused exactly as for an order that does not exist (`NOT_FOUND`, `MSC-DEC-432`)| the order half of `SLICE-000` criterion 28| **No order-read operation exists yet**; `itemizeOrder` is Ops's. The rule is stated in the contract and tested on requests by `AC-SLICE-001-79`|
| **`SLICE-008`** — vendor administration| **`VendorAccount.account_identifier` is generated at account creation** ([SECURITY_DESIGN.md](../architecture/SECURITY_DESIGN.md) §13.7a) and delivered with the setup grant. The `SLICE-000` fixture generates one for the demonstration| — *(new at `PDA-67`)*| Vendor creation is `SLICE-008`'s; sign-in needs the identifier and no document had a producer for it|
| **Every slice that builds one of the operations that require `If-Match` and have no read that sets an ETag**| **The read that returns the record's `ETag`.** At Gate PD-3R2 that is 35 of the 54 operations that require `If-Match`: manifests (7), vendor organisations (6), pickup and delivery stops (5), delivery runs (4), order-level acts (4), saved locations (3), holds (2), cash handovers (2), evidence (1) and custody returns (1)| — *(found at the Gate PD-3R2 Backend Engineer review)*| `openapi.yaml` 5.73 states its rule 3 for the identity domain only: Gate PD-3R1 gave nine operations their read and these never had one. Each read is added with its resource|
| **`SLICE-009`** — staff administration| **`proposeBundleChange` has no reader for one of its holders**: `permission.bundle.assign` is held by Ops Staff, `getStaffIdentity` needs `staff.read`, and Ops Staff do not hold it. Decide whether the key's holders or the read's change| — *(found at the Gate PD-3R2 review)*| The operation is `SLICE-009`'s; `permissions.md` and `openapi.yaml` record the gap and leave it open|

**Two decisions the Gate PD-3R2 review recorded as open are made, and neither is an obligation** (Gate PD-3R3). **`PDA-68`** — no operation returned the `role_bundle_id` that `createStaffIdentity` requires — is closed by `listAssignableStaffRoleBundles`, built inside `SLICE-000`. **`PDA-69`** — the seed created one identity and §30.8 forbids a maker approving their own profile — is closed by a bootstrap **pair** of two Platform Admins, one creating the first profile and the other approving it. **Neither moves an obligation in the table above, and `SLICE-000`'s rows 1, 2 and 12 can be walked from a clean environment.**

**The obligations in Given/When/Then form, without identifiers** (`MSC-DEC-433` item 6). Each is numbered when its owning slice's feature is written, and each stands on operations that slice builds.

*`SLICE-009`, rider administration — a status change ends the session:*

```text
Given a rider with a live session and a valid access_token,
When an authorised officer sets the rider's status to INACTIVE or SUSPENDED,
Then every live session of that rider is terminated in the same transaction as the status change,
And the rider's next API call returns 401 SESSION_INVALID,
And no later sign-in succeeds while the status stands.
```

*`SLICE-009`, staff administration — a reduced bundle ends the session:*

```text
Given a Senior Ops user with an ACTIVE session issued four hours ago,
When a Platform Admin approves a bundle change that reduces that user's authority,
Then every live session for that identity is terminated with AUTHORITY_CHANGED,
And the next request returns 401 SESSION_INVALID,
And a fresh sign-in receives a snapshot carrying the reduced bundle.
```

*`SLICE-009`, staff administration — removing a permission needs no code change:*

```text
Given a bundle holding a permission,
When an approved bundle change removes that permission,
Then holders are refused the action on their next session with PERMISSION_DENIED,
And no deployment or code change was required.
```

*`SLICE-009`, staff offboarding — succession:*

```text
Given a bootstrap Platform Admin and two non-bootstrap successor Platform Admins who are approved, credentialed, MFA-ready and have each signed in,
When that bootstrap identity is offboarded,
Then its live sessions end with OFFBOARDED and the bootstrap-resume mechanism refuses to operate for it,
And auth.bootstrap.succeeded is written once for that identity, as an enhanced record,
And offboarding a bootstrap identity with fewer than two such successors is refused with the code the offboarding operation declares, and neither bootstrap identity is ever deleted.
```

*The first slice that returns an order to a Vendor — the order half of the existence rule:*

```text
Given two vendor organisations each holding orders,
When one requests the other's order by id,
Then the response is 404 NOT_FOUND, identical in status, code, body shape and timing class to an identifier that matches nothing,
And every order list returns only the caller's own orders.
```

*`SLICE-008`, vendor administration — the account identifier:*

```text
Given a vendor organisation approved at SLICE-008,
When its account is created,
Then account_identifier is generated once, unique, immutable and never reused,
And it is delivered with the setup grant and shown to Ops by getVendorAccount.
```

## 5. Readiness status

Slice documents 000–003 exist. Later slice documents are unwritten; feature specifications alone do not establish complete slice scope. Assess readiness for the selected bounded task using the current standards, preserving real product, configuration and provider dependencies. No historical signature or audit verdict certifies an implementation.

## 6. What Phase 2 established

The retained features and contracts define the initial identity, pickup, dispatch and delivery threads. Implement their demonstrations and acceptance criteria incrementally. Keep scope, contract conformance and cross-surface behavior aligned; specification detail is not code completion.

## 7. Pre-launch proofs — specified by Gate D, and not yet run

**Gate D closing does not mean these have passed.** It means their inputs, procedure and pass/fail criteria are fixed, so implementation cannot invent them. **Both are release blockers.**

| Proof| What must be run| Passes when|
|---|---|---|
| **Launch load tests**| Baseline **1×** · peak **3× for 30 minutes** at up to 75 concurrent staff-equivalent · soak **2× for 4 hours** · **stress to degradation** · and the eleven outage and burst scenarios at [OBSERVABILITY_AND_RECOVERY.md](../architecture/OBSERVABILITY_AND_RECOVERY.md) §5.5| p95 targets hold · **no duplicate business effect** · no lost asynchronous work · **no cross-Hub, Vendor or Rider leakage under concurrency** · queue age recoverable · §5.4's per-run criteria|
| **Pre-launch restore drill**| The full isolated restore at §4.4 of that document, on the cadence `MSC-DEC-284` set| **Calculated RPO ≤24h and calculated RTO ≤4h**, both recorded, plus PostgreSQL integrity, Evidence, KMS/TOTP, audit integrity, provider reconciliation, and proof that **no live SMS or payment credential is reachable** from the drill environment|

**A scenario is not a PASS because HTTP requests returned**, and a restore is not a PASS because it completed — **it must produce both numbers.** A drill that finishes in six hours has proved a restore is possible and disproved the RTO.

**These are launch gates, not readiness gates.** No slice's `READY` verdict depends on them, and none becomes `NOT_READY` because they are outstanding — the same distinction `SLICE-000` has carried throughout between a launch item and a readiness item.

## 8. Related

- **Slices:** [SLICE-000](slices/SLICE-000.md) · [SLICE-001](slices/SLICE-001.md) · [SLICE-002](slices/SLICE-002.md) · [SLICE-003](slices/SLICE-003.md) — **the four §3 says are specified.** `SLICE-004` to `SLICE-014` are named in §3 and have no document yet
- **Gates:** [definition-of-ready.md](../standards/definition-of-ready.md) · [definition-of-done.md](../standards/definition-of-done.md)
- **Standards:** [engineering-standards.md](../standards/engineering-standards.md) — the enforcement ladder and test obligations every slice inherits
