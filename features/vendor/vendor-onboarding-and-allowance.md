# Vendor onboarding and account allowance

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.3 (cleaned edition)
> **Date:** 4 October 2026
> **Domain:** vendor
> **Owns:** the behaviour and acceptance criteria for bringing a registered vendor into
> existence — Ops creating the record and its shared portal account, hub Senior Ops
> independently approving or rejecting operational activation, and the separate Platform
> Admin decision to enable or disable the account allowance
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §18.2, §29.1–§29.2, §29.5, §35.12.1–§35.12.4, §35.12.8, §36.12
> **Slice:** `SLICE-008` (unwritten; this is its first feature document)

> **Link paths in this document use `../../`** — correct from `features/vendor/<name>.md`.

## 1. What this is, and why

A business cannot self-register (§18.2, §35.12.1). Three separate acts, by three different
authorities, bring a registered vendor into existence and give it commercial standing:
**authorised Ops creates** the `VendorOrganization` and its shared portal account, **hub
Senior Ops independently approves or rejects** operational activation, and **Platform
Admin separately enables** the account allowance. This feature owns all three.

**The separation is the product rule, not an implementation detail.** §35.12.3 and §36.12
both state that operational activation and financial allowance are distinct decisions with
distinct approvers, and §36.12's first invariant is that operational `ACTIVE` does **not**
imply allowance `ENABLED`. A build that collapsed them would be wrong in the direction that
extends credit nobody approved.

**Version 1 boundary, stated plainly.** This feature does **not** build reactivation out of
suspension, termination, offboarding retention, reapplication after a rejection, the
business-verification evidence set, duplicate detection, or promotion of a saved ad-hoc
sender into a registered vendor. Every one of those was `OQ-033` or §18.2's named downstream
design, and `MSC-DEC-255` deferred `OQ-033` **to this slice being written** on the reasoning
that deciding termination mechanics against features nobody has drafted produces rules whose
edges appear on first contact with the work. §14 below is that contact: it named the edges,
and `OQ-033` closed on 21 September 2026 on what they produced.

## 2. Governing sections

| Section| What it governs here|
|---|---|
| §18.2| Account creation and activation — the five rules this feature implements verbatim, including *"approves or rejects"* and the downstream set it excludes by name|
| §29.1| Purpose and boundary — vendor administration is internal Ops capability, **not** tenant administration exposed inside Melarc Vendor|
| §29.2| Version 1 onboarding — the five numbered rules, including the creator/approver exclusion and the allowance's mandatory reason with **no probation threshold**|
| §29.5| Operational and financial states — that the record represents operational status, allowance state and payment state **separately**|
| §35.12.1–§35.12.4| No self-registration; creator ≠ approver; activation and allowance are separate decisions; the prepayment consequence until allowance is enabled|
| §35.12.8| The four conditions that may not collapse into one flag — read here, enforced by the projection this feature does not own|
| §36.12| The two lifecycles, their invariants, and *"every transition records actor, reason, timestamp, and applicable evidence"*|

**Decisions that shape this feature:** §34.6, `MSC-DEC-045` and `MSC-DEC-238` (the global vendor
account limit, **GH₵200**, one platform-wide figure with no Version 1 override),
`MSC-DEC-254`/`MSC-DEC-255` (settling reopens the day within
`vendor_credit_grace_window_minutes`, and `OQ-033`'s deferral to this slice),
§37.4, `MSC-DEC-135` (the uniform same-actor exclusion and its one code), `MSC-DEC-247` (the
maker-checker shape this feature mirrors, and `CONFLICT-036`'s lesson about an enum that
cannot hold a created-but-unapproved record), `MSC-DEC-265` (the vendor never receives a
secret an administrator has seen), `MSC-DEC-295`/`MSC-DEC-299` (the control records are
all-Hub reads, not ordinary hub-staff reads), `MSC-DEC-339` (the derived eligibility
projection that answers *may this vendor book today* without disclosing why not).

## 3. Surfaces and actors

| Surface| Actor| Can do| Gated by|
|---|---|---|---|
| Melarc Ops| Ops Staff, Senior Ops, Platform Admin| Create the vendor record and its shared portal account| `vendor.organization.create` — own hub|
| Melarc Ops| **Hub Senior Ops**, Platform Admin| Approve **or reject** operational activation| `vendor.organization.approve` — own hub, **creator ≠ approver**|
| Melarc Ops| **Platform Admin only**| Enable or disable the account allowance| `vendor.allowance.enable` / `.disable` — **all hubs**|
| Melarc Vendor| Vendor account| Nothing in this feature. **No self-registration and no tenant administration** (§29.1, §35.12.1)| —|
| Melarc Rider| Rider| **N/A.** Not a party to vendor administration| —|

## 4. Preconditions

For creation: the acting staff member holds `vendor.organization.create` at the hub that
will be the vendor's responsible hub. For the approval decision: a `VendorOrganization`
exists in `PENDING_SENIOR_OPS_REVIEW`, and the deciding actor is **not** its `created_by`.
For either allowance decision: the organization is `ACTIVE`, and the actor is Platform
Admin. Nothing here requires a probation period to have elapsed — §29.2.4 states that **no
mandatory probation threshold applies**, which is a decided absence rather than a gap.

---

## 5. Behaviour

*This section and §13 are the only sections with original content. Everything else points
elsewhere.*

### 5.1 Normal path

1. **Authorised Ops creates the record** (`createVendorOrganization`). One act creates the
   `VendorOrganization` in **`CREATED_BY_OPS`** and, per §29.2.1's *"and initial shared
   portal account"*, its `VendorAccount` and `VendorCredential` — the credential carrying a
   registered recovery channel and a **null secret**. The caller is recorded as `created_by`.
2. The record moves to **`PENDING_SENIOR_OPS_REVIEW`** and **grants nothing**. No session can
   be issued against it, because `VendorCredential.secret` is null and a sign-in proves three
   factors.
3. **Hub Senior Ops decides** (`decideVendorOrganization`). Approval moves the record to
   **`ACTIVE`** and issues **exactly one** `VENDOR_CREDENTIAL_SETUP` grant to the registered
   recovery channel, which is where [vendor-authentication.md](../identity/vendor-authentication.md)
   §12 already places it. The vendor sets its own secret; **no administrator ever learns it**.
4. Rejection is the same call with `approved: false` and a **mandatory reason**. The record
   reaches **`REJECTED`**, no grant is issued, and the record stays queryable.
5. **The allowance is a separate decision, later and by someone else.** A new organization's
   `VendorAccountAllowance` is **`DISABLED_PREPAYMENT_ONLY`** from creation. Platform Admin
   may enable it (`enableVendorAllowance`) after basic verification and **with a recorded
   reason**; Platform Admin may later disable it (`disableVendorAllowance`), also with a
   mandatory reason.
6. **What enabling changes is read elsewhere and is not restated here.** The signed commercial
   machine ([state-machines.md](../../contracts/state-machines.md) §8) already branches
   `PRICED → CREDIT_RESERVED` on *allowance enabled, account not `OVERDUE`, sufficient global
   exposure*, and `PRICED → PAYMENT_REQUIRED` when any of those is unmet. This feature moves
   the flag; §8 owns the consequence.

### 5.2 Exception paths

| Situation| Behaviour|
|---|---|
| The creator tries to decide their own record| Refused — **`SELF_APPROVAL_FORBIDDEN`** (§29.2.3, §35.12.2, `MSC-DEC-135`). The same code every other same-actor exclusion returns; one uniform rule keeps one code|
| Senior Ops at another hub tries to decide| Refused — `PERMISSION_DENIED`. `vendor.organization.approve` is **own hub**|
| Senior Ops tries to enable the allowance| Refused — `PERMISSION_DENIED`. `vendor.allowance.enable` is **Platform Admin only, all hubs** (§35.12.3)|
| Either allowance call arrives with no reason| Refused — `REASON_REQUIRED` (§29.2.4–5)|
| The decision arrives on a record not in `PENDING_SENIOR_OPS_REVIEW`| Refused — `STATE_CONFLICT`|
| A rejected vendor asks to reapply| **A new `createVendorOrganization`.** `REJECTED` stays terminal and no operation returns it to review — decided at `MSC-DEC-397`, where linking attempts is duplicate detection's job (§18.2, still downstream)|
| An approved vendor must be reactivated after suspension| **`reactivateVendor`**, built at Pass 2 and decided at `MSC-DEC-397` — symmetric or higher. Suspension and reactivation are [vendor-suspension.md](vendor-suspension.md)'s, not this feature's|

### 5.3 What this feature must never do

- **Never let approval enable the allowance.** §36.12's first invariant, §35.12.3, and the
  reason the two acts carry different permission keys with different scopes.
- **Never treat `OVERDUE` as suspension, or allowance-disabled as either.** §35.12.8 names
  **four** distinct conditions — operational suspension, `OVERDUE` financial status,
  allowance disablement, and security/risk holds — and forbids collapsing them into one flag.
  Each is a separate record; the safe operational answer is the derived projection
  `getVendorOperationalEligibility`, which is lossy on purpose.
- **Never make disablement retroactive.** §29.2.5 is explicit: after disablement, vendor-paid
  and split vendor portions calculated at itemization require payment before the affected
  order becomes dispatch-ready, **while existing confirmed itemized orders and outstanding
  obligations remain valid**. Disabling an allowance does not reprice or reverse settled work.
- **Never invent a per-vendor allowance amount.** The limit is **one platform-wide figure**,
  GH₵200, *"one figure for every vendor, largest and smallest, with no Version 1 override"*.
  The per-vendor state is a **flag**, not a number.
- **Never expose any of this inside Melarc Vendor.** §29.1: this is internal Ops capability
  and *"is not exposed as organization/user administration inside Melarc Vendor."*
- **Never build a reapplication transition.** `MSC-DEC-397` settled it: `REJECTED` is terminal and
  a reapplying business creates a **new** record. Termination and reactivation are Pass 2's.

## 6. Entities — *pointer*

`VendorOrganization` and `VendorAccountAllowance` are detailed at
[domain-model.md](../../contracts/domain-model.md) §6.16, written for this pass — both were
summary-level at §6.9 until now. `VendorAccount` and `VendorCredential` are at §6.8 and are
**unchanged by this feature**.

**One invariant is worth stating because it reads alarming and is correct.** A
`VendorAccount` may be `ACTIVE` while its `VendorOrganization` is still
`PENDING_SENIOR_OPS_REVIEW`. `VendorAccount.status` has exactly two values, `ACTIVE` and
`SUSPENDED`, and it describes **credential and session standing**, not operational approval —
§36.12's own invariant says *"shared credential/session state is separate from organization
operational status."* The account grants nothing regardless, because its secret is null until
approval issues the setup grant. This is **not** `CONFLICT-036` repeating: the maker-checker
is expressible here because the **organization** carries `PENDING_SENIOR_OPS_REVIEW`, which is
the state `StaffIdentity` was missing.

## 7. States — *pointer*

§36.12, via [state-machines.md](../../contracts/state-machines.md) §14. Both machines are in
the **deferred set** — state sets fixed, transition tables not written — and §1.1 is explicit
that **no slice may reach `READY` against one**. This pass deliberately does **not** write
those tables.
from `SUSPENDED` and entries to `TERMINATED` were `OQ-033`'s, so a table written then would
either have been incomplete or would have answered `OQ-033` by implication. **`OQ-033` closed
on 21 September 2026 and decided those transitions; the table is still
unwritten and is owed under `OQ-132`.** See §15.

## 8. Permissions — *pointer*

[permissions.md](../../contracts/permissions.md) §7. **Every key this feature needs already
exists and no key is added**: `vendor.organization.create`, `vendor.organization.approve`
(which carries **both** halves of §18.2's *"approves or rejects"*, the same way
`staff.identity.approve` does), `vendor.allowance.enable` / `.disable`, and `vendor.read`.

## 9. Settings — *pointer*

[settings.md](../../contracts/settings.md) §7.1 — `global_vendor_account_limit_amount`,
**GH₵200**. The **value and its authority were always approved** (§34.6, `MSC-DEC-045`,
`MSC-DEC-238`); the key **had no identifier** until this pass, and was the only `CONFIRMED`
row in the company-wide table without one. §7.3's `vendor_credit_grace_window_minutes` (60)
bears on the limit but is `booking_cutoff_time`'s companion, not this feature's.

## 10. Errors — *pointer*

[errors-and-enums.md](../../contracts/errors-and-enums.md) §5. **No code is added.**
`SELF_APPROVAL_FORBIDDEN`, `REASON_REQUIRED`, `STATE_CONFLICT`, `PERMISSION_DENIED`,
`VALIDATION_FAILED`, `SESSION_INVALID` and `CSRF_VALIDATION_FAILED` all already exist and
carry every refusal above.

## 11. Audit events — *pointer*

[audit.md](../../contracts/audit.md) §5.6b. Five codes, **enhanced on the same split §5.6
already established**: the maker act is ordinary because it grants nothing; every act that
confers or withdraws standing is enhanced under §38.5 categories 1 and 6.

## 12. API operations — *pointer*

`createVendorOrganization`, `decideVendorOrganization`, `enableVendorAllowance`,
`disableVendorAllowance` — [openapi.yaml](../../contracts/openapi.yaml). The read side
already existed: `getVendorOperationalEligibility` (`MSC-DEC-339`, closing `OQ-105`) answers
*may this vendor book today* without disclosing which of the four conditions is the reason.

---

## 13. Acceptance criteria

*§43.1 form. Every criterion cites its governing §, decision, or entity invariant.*

### `AC-VENDOR-01` — creation lands unapproved and grants nothing

```text
Given authorised Ops holding vendor.organization.create at the responsible hub,
When createVendorOrganization is called,
Then a VendorOrganization exists in PENDING_SENIOR_OPS_REVIEW,
And created_by records the calling actor,
And no VENDOR_CREDENTIAL_SETUP grant is issued,
And vendor.organization.created is emitted.
```
**Governs:** §18.2, §29.2.1, §35.12.1 · **Surface:** API · **Test level:** integration

### `AC-VENDOR-02` — one act creates the organisation and its shared portal account

```text
Given createVendorOrganization succeeds,
Then a VendorAccount exists for that organisation,
And a VendorCredential exists carrying at least one recovery channel,
And VendorCredential.secret is null,
And no administrator-supplied secret was accepted in the request.
```
**Governs:** §29.2.1, domain-model.md §6.8, `MSC-DEC-265` · **Surface:** API · **Test level:** integration

### `AC-VENDOR-03` — the creator cannot decide their own record

```text
Given a VendorOrganization in PENDING_SENIOR_OPS_REVIEW created by actor A,
When actor A calls decideVendorOrganization holding vendor.organization.approve,
Then the call is refused with SELF_APPROVAL_FORBIDDEN,
And the record stays in PENDING_SENIOR_OPS_REVIEW.
```
**Governs:** §29.2.3, §35.12.2, `MSC-DEC-135` · **Surface:** API · **Test level:** integration

### `AC-VENDOR-04` — approval activates and issues exactly one setup grant

```text
Given a VendorOrganization in PENDING_SENIOR_OPS_REVIEW created by actor A,
When hub Senior Ops actor B calls decideVendorOrganization with approved true,
Then operational_status reads ACTIVE,
And exactly one SetupGrant of purpose VENDOR_CREDENTIAL_SETUP is issued,
And it is delivered to the account's registered recovery channel and not to the request,
And vendor.organization.approved is emitted carrying both actors.
```
**Governs:** §18.2, §29.2.2, state-machines.md §19.1 · **Surface:** API · **Test level:** integration

### `AC-VENDOR-05` — rejection is reasoned, terminal and queryable

```text
Given a VendorOrganization in PENDING_SENIOR_OPS_REVIEW,
When hub Senior Ops calls decideVendorOrganization with approved false and a reason,
Then operational_status reads REJECTED,
And no SetupGrant is issued,
And the record remains readable through vendor.read,
And vendor.organization.rejected is emitted with the reason.
```
**Governs:** §18.2, §29.2.2, §36.1 · **Surface:** API · **Test level:** integration

### `AC-VENDOR-06` — a reason is mandatory on rejection

```text
Given a VendorOrganization in PENDING_SENIOR_OPS_REVIEW,
When decideVendorOrganization is called with approved false and no reason,
Then the call is refused with REASON_REQUIRED,
And the record stays in PENDING_SENIOR_OPS_REVIEW.
```
**Governs:** §29.2.5, §36.12 *(every transition records actor, reason, timestamp)* · **Surface:** API · **Test level:** integration

### `AC-VENDOR-07` — approval does not enable the allowance

```text
Given a VendorOrganization that decideVendorOrganization has just moved to ACTIVE,
Then its VendorAccountAllowance state reads DISABLED_PREPAYMENT_ONLY,
And no vendor.allowance.enabled event was emitted by the approval.
```
**Governs:** §29.2.4, §35.12.3, §36.12 *(operational ACTIVE does not imply allowance ENABLED)* · **Surface:** API · **Test level:** integration

### `AC-VENDOR-08` — only Platform Admin moves the allowance, in either direction

```text
Given an ACTIVE VendorOrganization and a hub Senior Ops session,
When enableVendorAllowance is called,
Then the call is refused with PERMISSION_DENIED,
And the same refusal applies to disableVendorAllowance.
```
**Governs:** §29.2.4–5, §35.12.3, permissions.md §7 · **Surface:** API · **Test level:** integration

### `AC-VENDOR-09` — enabling requires a reason and evaluates no probation threshold

```text
Given an ACTIVE VendorOrganization whose allowance is DISABLED_PREPAYMENT_ONLY,
When Platform Admin calls enableVendorAllowance with a reason,
Then the allowance state reads ENABLED,
And no elapsed-time or completed-order threshold is evaluated as a precondition,
And vendor.allowance.enabled is emitted with the reason.
```
**Governs:** §29.2.4 *(no mandatory probation threshold applies)* · **Surface:** API · **Test level:** integration

### `AC-VENDOR-10` — disabling is reasoned and never retroactive

```text
Given a VendorOrganization whose allowance is ENABLED with confirmed itemized orders
  and outstanding obligations against it,
When Platform Admin calls disableVendorAllowance with a reason,
Then the allowance state reads DISABLED_PREPAYMENT_ONLY,
And every existing confirmed itemized order keeps its commercial_state unchanged,
And every outstanding obligation remains valid and payable.
```
**Governs:** §29.2.5 *(existing confirmed itemized orders and outstanding obligations remain valid)* · **Surface:** API · **Test level:** integration

### `AC-VENDOR-11` — the commercial gate reads the flag; this feature does not restate it

```text
Given a VendorOrganization whose allowance is DISABLED_PREPAYMENT_ONLY,
When itemization resolves a vendor portion greater than zero on one of its orders,
Then the commercial machine resolves PRICED -> PAYMENT_REQUIRED,
And the order cannot reach READY_FOR_DISPATCH until that demand is SETTLED.
```
**Governs:** §35.12.4, state-machines.md §8 *(signed, `MSC-DEC-366`)* · **Surface:** API · **Test level:** integration

### `AC-VENDOR-12` — the four conditions are four records, never one flag

```text
Given a VendorOrganization that is ACTIVE, not OVERDUE, allowance DISABLED_PREPAYMENT_ONLY,
  and carries no SecurityRiskHold,
When getVendorOperationalEligibility is read,
Then requiresPrepayment is true,
And mayCreatePickup is true,
And the response discloses no security-hold existence, holder or grounds.
```
**Governs:** §29.5, §35.12.8, `MSC-DEC-339` · **Surface:** API · **Test level:** integration

### `AC-VENDOR-13` — the approval decision is own-hub

```text
Given a VendorOrganization in PENDING_SENIOR_OPS_REVIEW at hub H1,
When Senior Ops authorised only at hub H2 calls decideVendorOrganization,
Then the call is refused with PERMISSION_DENIED,
And the record stays in PENDING_SENIOR_OPS_REVIEW.
```
**Governs:** §35.12.1, permissions.md §7 *(own hub)* · **Surface:** API · **Test level:** integration

### `AC-VENDOR-14` — reapplication is a new record, never a reopened one

```text
Given a VendorOrganization in REJECTED,
When any actor attempts to return it to PENDING_SENIOR_OPS_REVIEW or ACTIVE,
Then no operation in the contract accepts that transition,
And the only route to a registered vendor is a new createVendorOrganization.
```
**Governs:** §18.2, `MSC-DEC-397` *(`REJECTED` is terminal; reapplication is a new record)* · **Surface:** API · **Test level:** integration

---

## 14. Open questions blocking this feature

| ID| What it blocks here| Type|
|---|---|---|
| ~~`OQ-033`~~| **CLOSED 21 September 2026 by `MSC-DEC-397`.** All four questions below were answered after this pass made them concrete| —|
| `OQ-030`| No Ops Portal page inventory exists for this feature yet| `ARTIFACT_REQUIRED`|

**`OQ-033` closed on what writing this pass produced, which is what `MSC-DEC-255` deferred it here for.**
The four questions this document raised on 20 September were answered on 21 September, and the
answers are recorded at `MSC-DEC-397` rather than restated here: **reapplication is a new record**
and `REJECTED` stays terminal; **reactivation is symmetric or higher** and resumes every held item
in one act; **termination is Platform Admin, from `SUSPENDED` only, with no hold still `HELD`**, and
**obligations survive it**; and **“basic verification” is the recorded reason and nothing more**,
bounded by the GH₵200 ceiling and deliberately avoiding a dependency on the never-signed `Evidence`
§17. **Offboarding retention was reassigned to `OQ-028`**, which already owns retention periods and
the legal input they need — reassignment, not a fresh deferral, which is why `OQ-033` closed rather
than narrowed.

`OQ-038` is **not** listed: it closed on 26 August at `MSC-DEC-258`.

## 15. What this feature still owes its slice

| Owed| Blocks which DoR area| Owner|
|---|---|---|
| `SLICE-008` itself is unwritten — this is the first feature document under its eventual scope| F (acceptance and delivery)| Engineering — `SLICE-008`|
| **Transition tables for `VendorOrganization` and `VendorAccountAllowance`** — both are in `state-machines.md` §14's deferred set, and **§1.1 bars `READY` against a deferred machine**. `VendorOrganization`'s transitions were decided at `MSC-DEC-397` (`OQ-033` closed 21 September 2026), so what is owed is the table itself| B (contract readiness)| `OQ-132`, then Product Owner signature|
| Vendor **suspension** and held-parcel disposition (§29.6) — confirmed by §29.6, `MSC-DEC-142`/`168`/`169`/`171` and specified at Pass 2 by [vendor-suspension.md](vendor-suspension.md), which owes the `VendorSuspensionHold` table at its §15| B, C| Engineering — `SLICE-008`|
| Saved pickup locations (§29.4) — specified at Pass 3 by [vendor-pickup-locations.md](vendor-pickup-locations.md) — and the internal profile (§29.8), which Pass 3 **reports rather than builds**| B, C| Engineering — `SLICE-008`|
| An Ops Portal screen for vendor creation, the approval queue and the allowance decision| D (frontend)| `OQ-030`|

**This feature does not make `SLICE-008` `READY` and could not.** The machines the slice
exercises remain in `state-machines.md` §14's deferred set, which is the list to read — no
count of them is kept here — and §1.1 bars `READY` against a deferred machine. What this
feature did was make `OQ-033` decidable, which is what it was deferred here for; `OQ-033`
closed on 21 September 2026 at `MSC-DEC-397`.

## 16. Build status — *honest, per surface*

| Surface| Status| Gap|
|---|---|---|
| Melarc Ops| ⚪ not built| No Ops Portal page inventory; operations are specified, not implemented|
| Melarc Vendor| N/A| Deliberately not a party — §29.1 forbids exposing this as tenant administration|
| Melarc Rider| N/A| Not a party to vendor administration|

## 17. Related

- [vendor-authentication.md](../identity/vendor-authentication.md) — owns what happens
  **after** approval: the `VENDOR_CREDENTIAL_SETUP` grant this feature issues, the shared
  secret the vendor sets, and the single-session rule. Its §5.1 boundary sentence —
  *"vendor organisation approval and business administration remain `SLICE-008`"* — is the
  seam this document fills from the other side
- [permission-enforcement.md](../identity/permission-enforcement.md) — the own-hub and
  all-hub grant-scope resolution `AC-VENDOR-08` and `AC-VENDOR-13` rely on
- [return-to-vendor.md](../returns/return-to-vendor.md) — a return's settlement path branches
  on whether the payer is a registered vendor, which is the standing this feature confers
- `delivery/IMPLEMENTATION_PLAN.md` §3 — `SLICE-008`, vendor administration
