# Vendor suspension and held-parcel disposition

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.7 (cleaned edition)
> **Date:** 4 October 2026
> **Domain:** vendor
> **Owns:** the behaviour and acceptance criteria for suspending a registered vendor — the
> authority and the four grounds, the controlled hold that stops non-terminal work while
> preserving custody, money and history, and the hub Senior Ops disposition of each held
> item, including escalation to a manual claims or security hold
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §29.6, §29.5, §35.12.7–§35.12.9, §36.12, §37.3
> **Slice:** `SLICE-008` Pass 2

> **Link paths in this document use `../../`** — correct from `features/vendor/<name>.md`.

## 1. What this is, and why

A vendor may be suspended for non-payment, suspected fraud, a safety or legal violation, or
repeated service-quality failure (§29.6, `MSC-DEC-168`–`169`). Suspension **blocks the shared
login and stops all non-terminal ordinary work through an explicit hold, while preserving
records, money and physical custody** (§35.12.7). It is not deletion, not termination, and
not an `OVERDUE` status.

**The hold is per work item, and that is the point.** §29.6 requires that *"the system must
identify where each held item physically is"*. A suspension that stopped the account without
accounting for the parcels already in Melarc's hands would lose custody of other people's
goods, which is the failure this section exists to prevent.

**Version 1 boundary, stated plainly.** **Reactivation and termination are built** — `MSC-DEC-397`
settled them on 21 September, after this pass made the questions concrete. **`RETURN_TO_VENDOR` as
a held-parcel disposition is confirmed policy and is still not built**, for a structural reason given in full at §14: the signed
fulfilment machine cannot express it for most held parcels, and extending a signed machine is
the Product Owner's act. **Offboarding retention stays out and is `OQ-028`'s** — retention periods
need qualified legal input, and `MSC-DEC-397` reassigned it to the question that already owns them
rather than deferring it again. The vendor-level `SecurityRiskHold`'s write authority is also out,
raised as **`OQ-128`**, because it was tracked by nothing at all.

## 2. Governing sections

| Section| What it governs here|
|---|---|
| §29.6| Suspension in full — the controlled hold, the custody requirement, the confirmed disposition set, the authority and the four grounds, the return-fee rule, and the sentence that leaves reactivation to `OQ-033`|
| §29.5| That operational status, financial allowance state and payment state are represented **separately**|
| §35.12.7| Suspension blocks the shared login and stops non-terminal work **in an explicit hold**, preserving records and physical custody|
| §35.12.8| The four conditions that may not collapse into one flag. Suspension is one of them; this feature moves only that one|
| §35.12.9| Reactivation or exceptional disposition of held parcels must be **privileged, reasoned and audited**|
| §36.12| *"Vendor work during suspension: `NON_TERMINAL_WORK → SUSPENSION_HOLD → RESUMED| AUTHORIZED_EXCEPTION_DISPOSITION`"* — **the machine whose subject is the work item**, which is what fixes this entity's grain|
| §37.3| Suspension terminates sessions; the three authentication models never mix|

**Decisions that shape this feature:** §29.6, `MSC-DEC-142` (held-parcel disposition confirmed
— hold or return, hub-scoped, reason and audit mandatory, escalation to Platform Admin),
§29.6, `MSC-DEC-168`–`169` (the authority and the four grounds categories),
§29.6, `MSC-DEC-171` (a suspension-triggered return uses **the same flat return fee**, no cause-based
carve-out, and a Melarc-caused suspension error is a candidate for the **existing** §5.3
waiver category rather than a new blanket exemption), `MSC-DEC-295`/`MSC-DEC-299` (the hold is
an all-Hub read, not an ordinary hub-staff read).

## 3. Surfaces and actors

| Surface| Actor| Can do| Gated by|
|---|---|---|---|
| Melarc Ops| **Hub Senior Ops**| Suspend a vendor **within their own hub**, with mandatory grounds and reason| `vendor.suspension.create` — own hub|
| Melarc Ops| **Platform Admin**| Suspend a vendor **directly**, any hub| `vendor.suspension.create` — all hubs|
| Melarc Ops| **Hub Senior Ops**, Platform Admin| Decide each held item: continue the hold, or return to vendor| `vendor.held_parcel.decide` — the order's **`responsible_hub_id`**, which is **authority, not custody**|
| Melarc Ops| **Platform Admin only**| Escalate a held item to a manual claims or security hold| `vendor.held_parcel.escalate` — all hubs|
| Melarc Ops| **Platform Admin only**| **Open or clear a vendor-level security/risk hold**, with a mandatory reason each way — §35.12.8's fourth condition, distinct from suspension| `vendor.security_hold.manage` — all hubs|
| Melarc Ops| **Holders of all-Hub `vendor.read`**| Read the holds on a vendor| `vendor.read` — all-Hub. **Never the vendor**: the scope registry denies it its own row|
| Melarc Ops| **Hub Senior Ops**, Platform Admin| **Lift a suspension**, resuming every held item| `vendor.suspension.lift` — **symmetric or higher**: a P suspension is liftable only by P|
| Melarc Ops| **Platform Admin only**| **Terminate** a suspended vendor with no hold still `HELD`| `vendor.organization.terminate` — all hubs|
| Melarc Vendor| Vendor account| **Nothing. The login is blocked** (§29.6, §37.3). The vendor reads its own hold records only after reactivation, which does not exist yet| —|
| Melarc Rider| Rider| **N/A** to the decision. A rider may be carrying a held parcel — see §5.3| —|

## 4. Preconditions

The `VendorOrganization` is `ACTIVE`. The acting staff member holds
`vendor.suspension.create` — hub Senior Ops at the vendor's responsible hub, or Platform
Admin anywhere. For a disposition: a `VendorSuspensionHold` exists in `HELD`, and the actor
holds `vendor.held_parcel.decide` **for the order's `responsible_hub_id`** — **authority scope, not physical custody.** The parcel may still be with a rider; §14 says why that is deliberate.

---

## 5. Behaviour

*This section and §13 are the only sections with original content. Everything else points
elsewhere.*

### 5.1 Normal path

1. **Authorised Senior Ops suspends the vendor** (`suspendVendor`), citing **one of §29.6's
   four grounds categories** and a mandatory free-text reason. The grounds set is fixed:
   non-payment or overdue beyond policy, suspected fraud or abuse, safety or legal violation,
   repeated service-quality failure. **No fifth ground is created here.**
2. `VendorOrganization.operational_status` moves to **`SUSPENDED`** and
   `VendorAccount.status` to **`SUSPENDED`**. **Every live session terminates** with
   `SUSPENDED` — already specified at [domain-model.md](../../contracts/domain-model.md) §6.8
   and not restated here.
3. **One `VendorSuspensionHold` is created per non-terminal work item**, each recording
   **where that item actually is**, in `custody_location` — which for an `OUT_FOR_DELIVERY` item
   records rider custody, not a hub (§29.6). Terminal orders are untouched: a delivered
   parcel is history, and history is preserved rather than held.
4. **Nothing is charged, reversed or repriced by the suspension itself.** Outstanding
   obligations stay valid and payable — the same non-retroactivity the allowance decision
   follows (§29.2.5, [vendor-onboarding-and-allowance.md](vendor-onboarding-and-allowance.md)).
5. **Hub Senior Ops disposes of each held item** (`decideHeldParcelDisposition`), with a
   mandatory reason and an audit record (§35.12.9). **`CONTINUE_HOLD`** leaves the item
   `HELD`; there is **no maximum hold duration** (§29.6), so an indefinite hold is a
   legitimate steady state rather than a gap.
6. **Platform Admin may escalate** (`escalateHeldParcel`) where neither hold nor return
   resolves the case — §29.6's examples are suspected fraud and an abandoned or undeliverable
   parcel. The hold reaches **`AUTHORIZED_EXCEPTION_DISPOSITION`**.
7. **The vendor or sender contact is always notified of a return or an escalation, and the
   recipient is also notified where a delivery attempt had already started** (§29.6). The
   notification machinery is `SLICE-010`'s; the obligation is recorded here, at §11.

### 5.2 Exception paths

| Situation| Behaviour|
|---|---|
| The reason cites no grounds category, or one outside the four| Refused — `VALIDATION_FAILED`. §29.6 fixes the set and this feature adds none|
| Either call arrives with no reason| Refused — `REASON_REQUIRED` (§29.6, §35.12.9)|
| Hub Senior Ops disposes of an item accountable to another hub| Refused — `PERMISSION_DENIED`. Scoped to the order's **`responsible_hub_id`** (§29.6, `MSC-DEC-142`) — **authority, not custody**|
| Hub Senior Ops attempts an escalation| Refused — `PERMISSION_DENIED`. Escalation is **Platform Admin only**|
| Suspension is attempted on an already-`SUSPENDED` vendor| Refused — `STATE_CONFLICT`|
| A held item is disposed return-to-vendor| **Representable from 21 September 2026**, when §9 gained the suspension route. It commits a `ReturnRecord` with the **same flat fee** and closes through `return-to-vendor.md`'s OTP handover. **§9 is re-signed** (`MSC-DEC-400`, 21 September 2026), so the disposition is reachable — §14|
| The vendor must be reactivated| **No path exists to invoke.** `OQ-033`|

### 5.3 What this feature must never do

- **Never lose a parcel to a status change.** §29.6's custody requirement is the reason the
  hold is per item and records a physical location. A suspension that recorded only the
  vendor's state would leave Melarc holding goods it could not enumerate.
- **Never recall a rider mid-round.** An `OUT_FOR_DELIVERY` parcel belonging to a suspended
  vendor is **held as a record, not retrieved as an act** — §29.6 requires the system to
  *identify where each held item is*, not to move it. What happens to that parcel afterwards
  is a disposition decision, and today the only representable one is `CONTINUE_HOLD`.
- **Never treat suspension as `OVERDUE`, allowance-disablement or a security hold.** §35.12.8
  names four distinct conditions. This feature writes exactly one of them.
- **Never invent a fifth grounds category**, and never widen one by interpretation. §29.6
  calls them *"four starting grounds categories"* — starting, and still four.
- **Never carve out the return fee.** §29.6, `MSC-DEC-171`: a suspension-triggered return uses the
  same flat fee as any other, with **no cause-based exemption**; a Melarc-caused suspension
  error is a **candidate** for the existing §5.3 waiver category, case by case, decided by the
  waiver machinery `return-to-vendor.md` already owns.
- **Never resume held items one at a time.** `MSC-DEC-397`: reactivation moves **every** remaining
  `HELD` hold in one act, because §29.6 already makes reactivation the resolution of a hold. A
  per-item resume would reintroduce the decision that decision rejected.
- **Never let termination close a balance.** It ends the relationship and the access, not the debt.
  Nothing here writes off, zeroes or settles an obligation.

## 6. Entities — *pointer*

`VendorSuspensionHold` is detailed at [domain-model.md](../../contracts/domain-model.md)
§6.17, written for this pass. `VendorOrganization` and `VendorAccount` are at §6.16 and §6.8
and gain no field.

**A suspension hold represents one held work item**, as defined in the domain model. Its hub and custody fields apply to that item.

## 7. States — *pointer*

§36.12, via [state-machines.md](../../contracts/state-machines.md) §14 — `HELD` · `RESUMED` ·
`AUTHORIZED_EXCEPTION_DISPOSITION`, a **deferred** machine with no transition table, which
§1.1 states bars `READY`. **All three states are now reachable**: `MSC-DEC-397` gave `RESUMED` its
reactivation, and `AUTHORIZED_EXCEPTION_DISPOSITION` is reached by escalation, which this feature
builds. **No table is written here all the same** — completing a transition table is required before implementing the affected operations, and this pass already owes one for §9. §15 carries it.

## 8. Permissions — *pointer*

[permissions.md](../../contracts/permissions.md) §7. **Every key already exists and none is
added**: `vendor.suspension.create`, `vendor.held_parcel.decide`, `vendor.held_parcel.escalate`
and `vendor.read`.

## 9. Settings — *pointer*

**None.** §29.6 states that *"no fixed maximum hold duration applies"* — a decided absence, so
there is no key to add and no value to invent.

## 10. Errors — *pointer*

[errors-and-enums.md](../../contracts/errors-and-enums.md) §5. **No code is added.**
`REASON_REQUIRED`, `STATE_CONFLICT`, `PERMISSION_DENIED`, `VALIDATION_FAILED`,
`SESSION_INVALID` and `CSRF_VALIDATION_FAILED` carry every refusal above.

## 11. Audit events — *pointer*

[audit.md](../../contracts/audit.md) §5.6c. Three codes, **all enhanced** under §38.5
category 6 and §35.12.9's explicit *"privileged, reasoned and audited"*.

**The notification obligation is recorded and not built.** §29.6 requires the vendor or sender
contact to be notified of a return or escalation, and the recipient too where a delivery
attempt had started. `Notification` is summary-level at §6.9 and deferred to `SLICE-010`;
this feature adds no notification type, and §15 carries the debt.

## 12. API operations — *pointer*

`suspendVendor`, `decideHeldParcelDisposition`, `escalateHeldParcel` —
[openapi.yaml](../../contracts/openapi.yaml).

---

## 13. Acceptance criteria

*§43.1 form. Every criterion cites its governing §, decision, or entity invariant.*

### `AC-VSUSP-01` — suspension cites one of four grounds and a reason

```text
Given an ACTIVE VendorOrganization and hub Senior Ops at its responsible hub,
When suspendVendor is called with grounds NON_PAYMENT_OVERDUE and a reason,
Then operational_status reads SUSPENDED,
And vendor.suspension.created is emitted carrying the grounds and the reason.
```
**Governs:** §29.6, `MSC-DEC-168`–`169` · **Surface:** API · **Test level:** integration

### `AC-VSUSP-02` — a grounds value outside the four is refused

```text
Given an ACTIVE VendorOrganization,
When suspendVendor is called with a grounds value not among the four §29.6 categories,
Then the call is refused with VALIDATION_FAILED,
And operational_status is unchanged.
```
**Governs:** §29.6 *(four starting grounds categories)* · **Surface:** API · **Test level:** integration

### `AC-VSUSP-03` — suspension blocks the login

```text
Given a vendor with a live session,
When suspendVendor succeeds,
Then VendorAccount.status reads SUSPENDED,
And every live Session for that principal is terminated with reason SUSPENDED,
And a subsequent vendorSignIn is refused.
```
**Governs:** §29.6, §37.3, domain-model.md §6.8 · **Surface:** API · **Test level:** integration

### `AC-VSUSP-04` — every non-terminal work item is held, and located

```text
Given a vendor with orders in READY_FOR_DISPATCH, OUT_FOR_DELIVERY and DELIVERED,
When suspendVendor succeeds,
Then a VendorSuspensionHold in HELD exists for the READY_FOR_DISPATCH order,
And one exists for the OUT_FOR_DELIVERY order,
And none exists for the DELIVERED order,
And each hold records responsible_hub_id, the hub accountable for the item,
And custody_location, which is where the item actually is,
And for the OUT_FOR_DELIVERY order custody_location records rider custody, not a hub.
```
**Governs:** §29.6 *(the system must identify where each held item physically is)*, §35.12.7 · **Surface:** API · **Test level:** integration

### `AC-VSUSP-05` — suspension charges, reverses and reprices nothing

```text
Given a suspended vendor with outstanding obligations and confirmed itemized orders,
Then every obligation remains valid and payable,
And no order's commercial_state changed as an effect of the suspension,
And no ReturnRecord was created by the suspension itself.
```
**Governs:** §29.6 *(preserving custody, money, and history)* · **Surface:** API · **Test level:** integration

### `AC-VSUSP-06` — a hub Senior Ops suspension is own-hub

```text
Given an ACTIVE VendorOrganization whose responsible hub is H1,
When Senior Ops authorised only at H2 calls suspendVendor,
Then the call is refused with PERMISSION_DENIED,
And operational_status is unchanged.
```
**Governs:** §29.6, `MSC-DEC-168` · **Surface:** API · **Test level:** integration

### `AC-VSUSP-07` — Platform Admin may suspend directly, at any hub

```text
Given an ACTIVE VendorOrganization whose responsible hub is H1,
When Platform Admin calls suspendVendor with grounds and a reason,
Then operational_status reads SUSPENDED,
And no hub restriction is applied to the call.
```
**Governs:** §29.6 *(Platform Admin may also suspend a vendor directly)* · **Surface:** API · **Test level:** integration

### `AC-VSUSP-08` — continuing a hold is reasoned, audited and unbounded

```text
Given a VendorSuspensionHold in HELD,
When hub Senior Ops calls decideHeldParcelDisposition with CONTINUE_HOLD and a reason,
Then the hold stays HELD,
And vendor.held_parcel.decided is emitted with the reason,
And no expiry or maximum duration is set on the hold.
```
**Governs:** §29.6 *(no fixed maximum hold duration applies)*, §35.12.9 · **Surface:** API · **Test level:** integration

### `AC-VSUSP-09` — a disposition is refused outside the item's own hub

```text
Given a VendorSuspensionHold whose order has responsible_hub_id H1,
And whose custody_location records rider custody on an in-progress run,
When Senior Ops authorised only at H2 calls decideHeldParcelDisposition,
Then the call is refused with PERMISSION_DENIED,
And the hold stays HELD,
And when Senior Ops authorised at H1 calls it, the call is accepted despite the parcel not being at H1.
```
**Governs:** §29.6, `MSC-DEC-142` *(scoped to the accountable hub, not to custody)* · **Surface:** API · **Test level:** integration

### `AC-VSUSP-10` — escalation is Platform Admin only

```text
Given a VendorSuspensionHold in HELD,
When hub Senior Ops calls escalateHeldParcel,
Then the call is refused with PERMISSION_DENIED,
And when Platform Admin calls it with a reason,
Then the hold reads AUTHORIZED_EXCEPTION_DISPOSITION,
And vendor.held_parcel.escalated is emitted.
```
**Governs:** §29.6, `MSC-DEC-142` *(escalation requires Platform Admin)* · **Surface:** API · **Test level:** integration

### `AC-VSUSP-11` — reactivation is symmetric or higher

```text
Given a vendor suspended by Platform Admin,
When hub Senior Ops calls reactivateVendor with a reason,
Then the call is refused with INSUFFICIENT_AUTHORITY,
And when Platform Admin calls it with a reason,
Then operational_status reads ACTIVE,
And vendor.suspension.lifted is emitted carrying both the suspending and lifting actors.
```
**Governs:** §29.6, `MSC-DEC-397` · **Surface:** API · **Test level:** integration

### `AC-VSUSP-12` — reactivation resumes every held item in one act

```text
Given a suspended vendor with three VendorSuspensionHold rows in HELD,
When reactivateVendor succeeds,
Then all three read RESUMED,
And no per-item resume decision was required,
And exactly one vendor.suspension.lifted event was emitted.
```
**Governs:** §29.6 *(persists until reactivation or a disposition decision)*, `MSC-DEC-397` · **Surface:** API · **Test level:** integration

### `AC-VSUSP-13` — reactivation does not restore the allowance

```text
Given a vendor suspended while its allowance was DISABLED_PREPAYMENT_ONLY,
When reactivateVendor succeeds,
Then the allowance state is still DISABLED_PREPAYMENT_ONLY,
And no vendor.allowance.enabled event was emitted.
```
**Governs:** §35.12.3, §36.12 *(separate lifecycles, separate approvers)* · **Surface:** API · **Test level:** integration

### `AC-VSUSP-14` — termination requires SUSPENDED and no open hold

```text
Given an ACTIVE VendorOrganization,
When Platform Admin calls terminateVendor,
Then the call is refused with STATE_CONFLICT,
And given the same vendor SUSPENDED with one VendorSuspensionHold still HELD,
When terminateVendor is called,
Then the call is refused with STATE_CONFLICT.
```
**Governs:** §29.6, `MSC-DEC-397` · **Surface:** API · **Test level:** integration

### `AC-VSUSP-15` — termination ends the relationship, not the debt

```text
Given a SUSPENDED vendor with no hold HELD and an outstanding unpaid obligation,
When Platform Admin calls terminateVendor with a reason,
Then operational_status reads TERMINATED,
And the outstanding obligation is unchanged and still payable,
And no balance was closed, written off or zeroed by the call.
```
**Governs:** §29.6, `MSC-DEC-397` · **Surface:** API · **Test level:** integration

### `AC-VSUSP-16` — a rejected vendor reapplies as a new record

```text
Given a VendorOrganization in REJECTED,
When the business reapplies,
Then the only accepted path is a new createVendorOrganization producing a new id,
And no operation returns the REJECTED record to PENDING_SENIOR_OPS_REVIEW.
```
**Governs:** §18.2, `MSC-DEC-397` · **Surface:** API · **Test level:** integration

### `AC-VSUSP-17` — a suspension return charges the same fee as any other

```text
Given a VendorSuspensionHold in HELD whose order is READY_FOR_DISPATCH,
When decideHeldParcelDisposition is called with outcome RETURN_TO_VENDOR and a reason,
Then the order reaches RETURN_TO_VENDOR_IN_PROGRESS,
And a ReturnRecord is committed with originating_delivery_stop_id null,
And return_fee_minor is snapshotted from flat_return_fee_amount with no cause-based reduction,
And closure requires the same vendor or sender OTP as any other return.
```
**Governs:** §29.6, `MSC-DEC-142`, §29.6, `MSC-DEC-171`, `state-machines.md` §9.1 · **Surface:** API · **Test level:** integration

---

### `AC-VSUSP-18` — a security/risk hold stops new business and nothing else

```text
Given an active vendor with one parcel out for delivery,
When Platform Admin opens a security/risk hold with a reason,
Then getVendorOperationalEligibility reports mayCreatePickup false and mayConfirmVendorPaidOrder false,
And restrictionCategory does not disclose that a hold exists,
And the parcel out for delivery continues to delivery,
And the vendor can still sign in,
And the vendor cannot read the hold,
And no VendorSuspensionHold is created for any work item.
```

**Governs:** §35.12.8, §35.12.7, `MSC-DEC-414`, `MSC-DEC-339`, state-machines.md §21 · **Surface:** Melarc Ops, Melarc Vendor, backend · **Test level:** integration

### `AC-VSUSP-19` — only Platform Admin opens and clears, and the last open hold lifts the restriction

```text
Given a vendor with two OPEN security/risk holds,
When hub Senior Ops attempts to open or clear a hold,
Then the request is refused with PERMISSION_DENIED,
And when Platform Admin clears one hold with a reason,
Then mayCreatePickup is still false, because the other hold is OPEN,
And when Platform Admin clears the second with a reason,
Then mayCreatePickup and mayConfirmVendorPaidOrder recover,
And both cleared holds remain on the record with who cleared them and why,
And clearing a hold already CLEARED is refused with STATE_CONFLICT.
```

**Governs:** `MSC-DEC-414`, state-machines.md §21 · **Surface:** Melarc Ops, backend · **Test level:** integration · **Expected code on rejection:** `PERMISSION_DENIED`, `STATE_CONFLICT`

## 14. Open questions blocking this feature

| ID| What it blocks here| Type|
|---|---|---|
| ~~`OQ-033`~~| **CLOSED 21 September 2026 by `MSC-DEC-397`** — reactivation, reapplication, termination, obligations at termination and *“basic verification”*, all decided after this pass made them concrete. Offboarding retention reassigned to `OQ-028`| —|
| **`OQ-128`**| The vendor-level `SecurityRiskHold` has **no write authority and no operation** — §35.12.8's fourth condition is unwritable. Raised by this pass| `DECISION_NEEDED`|
| `OQ-030`| No Ops Portal page inventory exists for this feature yet| `ARTIFACT_REQUIRED`|

### `RETURN_TO_VENDOR` is confirmed policy with no contract path, and the blocker is a signature

**§29.6 confirms it**: *"hub Senior Ops decides continued hold or return-to-vendor (reusing the
Section 28.4 OTP-based closure)"*, §29.6, `MSC-DEC-142`. §29.6, `MSC-DEC-171` goes further and fixes its fee.
It is not deferred, not optional, and not open — it is **approved product policy this pass
could not build**.

**The obstruction is structural.** `RETURNED_TO_VENDOR` is a terminal fulfilment outcome
(§16.1), so a returned parcel must reach it through the fulfilment machine. That machine —
[state-machines.md](../../contracts/state-machines.md) §9, **SIGNED**, re-signed at
`MSC-DEC-366` — has **exactly one** entry into `RETURN_TO_VENDOR_IN_PROGRESS`, and it is
`AT_HUB_AFTER_FAILURE → RETURN_TO_VENDOR_IN_PROGRESS`.

**A suspended vendor's parcels are in every non-terminal state**, and only one of them is
`AT_HUB_AFTER_FAILURE`. A parcel sitting `READY_FOR_DISPATCH`, `ASSIGNED` or `OUT_FOR_DELIVERY`
has **no signed transition to a return**, so for the common case the confirmed disposition
cannot be expressed. **This is not an edge case; it is most held parcels.**

**Two things would close it, and both are the Product Owner's.** Either §9 gains transitions
into `RETURN_TO_VENDOR_IN_PROGRESS` from the other non-terminal states — **amending a signed
machine, requiring an explicit product/contract resolution**, exactly as `SetupGrant` §19 does — or §29.6's disposition is
read as requiring the parcel to reach `AT_HUB_AFTER_FAILURE` first, which is a **product rule
nobody has stated** and which this feature will not invent.

**`RETURN_TO_VENDOR` is therefore absent from the request enum rather than rejected at
runtime**, so the gap is a contract fact a machine can check, not a behaviour that fails in
production. `AC-VSUSP-12` asserts exactly that, and it is written to be deleted the day the
signature lands.

### `OQ-128`, raised here

`SecurityRiskHold` has a scope class, read restrictions, a two-value state set and an entry in
the glossary. It has **no permission key, no operation and no named authority anywhere in the
repository** — nothing can create or clear it. §35.12.8 names it as one of four conditions
that *"must not be collapsed into one flag"*, so the model carries it deliberately; what is
missing is who writes it. **§29.6's escalation is not the same thing**: that escalates a
**parcel** to a claims or security hold, while `SecurityRiskHold` is **vendor-scoped**. Nothing
tracked this before this pass, which is why it is raised rather than answered.

## 15. What this feature still owes its slice

| Owed| Blocks which DoR area| Owner|
|---|---|---|
| **The `RETURN_TO_VENDOR` disposition** — confirmed by §29.6, `MSC-DEC-142`/`171` and unbuildable against the signed §9 machine| B (contract readiness)| **Product Owner** — resolve the missing transition/precondition in the current contract|
| **`VendorSuspensionHold`'s transition table** — the states are now all reachable, so the machine can be tabled; it stays deferred at §14 because tabling it is a separate act needing a signature| B (contract readiness)| Product Owner signature|
| **`VendorOrganization`'s own transition table** — `suspendVendor`, `reactivateVendor` and `terminateVendor` move `operational_status`, and `state-machines.md` §14 still holds that machine as state sets only, so three live operations drive transitions no signed table describes| B (contract readiness)| **`OQ-132`** — Engineering tables it, then Product Owner signature (§36.13)|
| `SecurityRiskHold`'s write authority| B, C| **`OQ-128`**|
| The notification types §29.6 requires on return and escalation| C| `SLICE-010`|
| Saved pickup locations (§29.4) and the internal profile (§29.8)| B, C| Engineering — `SLICE-008`|
| An Ops Portal screen for suspension and the held-parcel queue| D (frontend)| `OQ-030`|

## 16. Build status — *honest, per surface*

| Surface| Status| Gap|
|---|---|---|
| Melarc Ops| ⚪ not built| No page inventory; operations specified, not implemented|
| Melarc Vendor| N/A| The login is blocked by the act this feature performs|
| Melarc Rider| ⚪ not built| A rider may carry a held parcel; no rider-facing behaviour is specified, and none is invented|

## 17. Related

- [vendor-onboarding-and-allowance.md](vendor-onboarding-and-allowance.md) — Pass 1, the
  standing this feature withdraws, and the `ACTIVE` precondition it starts from
- [return-to-vendor.md](../returns/return-to-vendor.md) — owns the return workflow, its flat
  fee and its OTP closure. §29.6 reuses that **closure**; what it cannot reuse is an
  initiation path, which is §14
- [vendor-authentication.md](../identity/vendor-authentication.md) — owns the session
  termination this feature triggers
- `delivery/IMPLEMENTATION_PLAN.md` §3 — `SLICE-008`, vendor administration
