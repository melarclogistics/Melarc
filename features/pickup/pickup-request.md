# Pickup Request

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.17 (cleaned edition)
> **Date:** 4 October 2026
> **Domain:** `pickup`
> **Owns:** the behaviour and acceptance criteria for creating, confirming, declining and cancelling a pickup request
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §21.1, §21.6, §35.2, §35.4, §36.2
> **Slice:** `SLICE-001`

## 1. What this is, and why

A pickup request is **the front door of the parcel journey** (§21.1). It records who is sending, from where, how many packages, on what date, and who is intended to pay — and nothing more. It is the only feature that can begin a parcel's life.

**Version 1 boundary.** A request carries payer **intent**, never a price. It has one origin and one scheduled pickup event. It does not create a charge, reserve credit, or promise a rider. Vendors may create a request and cancel their own `PENDING` one; **everything else is Ops**.

## 2. Governing sections

| Section| What it governs here|
|---|---|
| §21.1| Actors, required information, business rules, state direction|
| §21.6| Ops resolution and the attempt chain — reschedule as cancel-plus-clone|
| §35.2| Minimum packages, one origin, overrides, provisional senders|
| §35.4| Attempt cap, force-extension, replacement links|
| §36.2| The canonical state machine|
| §5.2| Payer intent, and why no price exists here|


## 3. Surfaces and actors

| Surface| Actor| Can do| Gated by|
|---|---|---|---|
| Melarc Ops| Ops Staff| Create for any vendor or ad-hoc sender; confirm; decline; cancel; request a one-package exception; resolve a cutoff exception; reschedule| `pickup.request.create`, `pickup.request.confirm`, `pickup.request.cancel`, `pickup.exception.request`|
| Melarc Ops| Senior Ops| All Ops actions, plus force-extension past the attempt cap| `pickup.attempt.extend`|
| Melarc Ops| **Any holder of `pickup.exception.approve`** — Senior Ops, Ops Staff explicitly granted it, or Platform Admin| All the above, plus approving a one-package exception. **The permission is authoritative, not the role**| `pickup.exception.approve`|
| Melarc Vendor| Vendor account| Create for itself; cancel **its own `PENDING`** request| `pickup.request.create`, `pickup.request.cancel` — own record only|
| Melarc Rider| Rider| **N/A** — §21.1: riders and recipients have no request-creation role| —|
| Recipient channel| —| **N/A** at this stage. The recipient is not yet known for a standard request| —|

**Vendor self-confirm and self-cancel-when-confirmed are deferred, not deleted**. Both guards are preserved in the state machine marked deferred, so re-enabling is a policy change rather than a redesign.

## 4. Preconditions

- The sender is a registered vendor that is **operationally active**, or an ad-hoc sender block captured at intake.
- A vendor with **financial allowance disabled may still create and confirm** requests (§21.1). Allowance affects itemization, not the front door.
- A **suspended** vendor cannot create requests at all, and its existing non-terminal requests go on controlled hold (§21.1).
- The responsible hub is resolvable and its service zones cover the pickup location.

---

## 5. Behaviour

### 5.0 Three intents, one record — *Gate C R1.2*

`MSC-DEC-335`. **There is no single universal pickup form.** `pickup_intent` is the discriminator, it is chosen before anything else is asked, and it decides what the rest of the form requires. All three are creatable by Ops from WhatsApp intake, and the canonical record is the same one the Vendor app produces.

#### `OWN_PACKAGES` — a known Vendor sending its own parcels

**Reuse everything already known and ask only what changes today.** The Vendor's saved pickup location, phones and business goods profile satisfy §21.1's required information; the request captures package count, requested service date, the saved location where several exist, and any transaction note.

**An established Vendor is not re-onboarded daily.** A `collection_point` or `collection_item` on this intent is mis-declared and refused.

**`resolved_pickup_location`** = the Vendor's selected or default saved location.

#### `COLLECT_FOR_VENDOR` — collecting from a third party, for a registered Vendor

**The parcel is not at the Vendor's address.** Requires `collection_point` — pickup person or business, phone, address or landmark — plus `collection_reference` (reference name, seller order number where given) and `collection_item` (description, quantity, picture).

**A destination is mandatory**: `destination_location_id`, or `use_vendor_default_destination` to resolve the Vendor's default saved location. *Collect this from X* with nowhere to take it is not an executable instruction, and the server refuses a Vendor with no default rather than accepting one.

**It is not merchandise COD**. **No rider is authorised to pay the seller** from rider, company or customer funds. No approved decision creates that settlement path.

**`resolved_pickup_location`** = **the collection point.** Sending the rider to the Vendor's address would send them where the parcel is *going*.

#### `ADHOC_SENDER` — a walk-in sender

**Exactly one identity source**: `ad_hoc_sender_id` for a return visit, found by verified phone, or `new_ad_hoc_sender` for a first use. Requiring an id made first-time senders unexecutable; permitting both made identity ambiguous. Creating the reusable profile and the request is **one idempotent act**.

**The identity is reusable and today's goods are not.** `current_item_description` is captured **every time** — *women's shoes*, *clothes*, *phone accessories*, *books*. Last month's description is not evidence about this box.

**Never auto-promoted to a registered Vendor** — §35.12.1 forbids self-registration.

**`resolved_pickup_location`** = the sender's stored location on a return visit, the supplied one on a first.

**One authoritative location, whatever the intent.** Dispatch and the rider read `resolved_pickup_location` and nothing else. The create contract expresses the address differently per intent; **the persisted record does not.**

### 5.1 Normal path

1. **Ops or the vendor creates the request.** It enters `PENDING`. Required information per §21.1: sender reference or ad-hoc block; saved pickup location or an approved request-specific override; primary phone and optional secondary; location and optional landmark; optional map link; item description; declared package count; scheduled date; payer intent.
2. **The system validates.** Package count ≥ 2 unless a one-package exception is approved. Scheduled date is Monday–Saturday. The pickup zone operates that day. The sender is not suspended.
3. **Ops confirms.** The request becomes manifest-eligible (§35.2.8). **An indicative estimate is returned** — the hub's `service_area_base_fee` × package count, assuming `SMALL` and in-area doorstep. **No credit is reserved and no charge is created** (§5.2.1). The estimate is not a quote: the size class is selected at itemization, so the authoritative price still appears there.

**The estimate's composition depends on whether the booking has a destination**. A standard multi-package request has none — §5.2.1 — so it is `service_area_base_fee` × package count, assuming in-area doorstep. **A one-package exception carries a mandatory delivery address** (§21.1), and the server resolves the service area from it:

| Known destination| Estimate|
|---|---|
| In-area doorstep| `service_area_base_fee` + `single_package_pickup_fee`|
| Corridor, **on** its batch day| `service_area_base_fee` + `single_package_pickup_fee`|
| Corridor, **off** its batch day| **`corridor_off_day_fee`** + `single_package_pickup_fee`|
| Outside Accra| **No estimate returned** — the carrier's charge is unknown until itemization|

**It is still provisional, and for a reason that survives:** the size class is selected by a receiving officer at itemization. What no longer happens is a **2.6×** surprise on a destination the system already held — a single package to Kasoa on a Tuesday showed GH₵35 and was charged GH₵90.

**The client still never sends a price.** It sends an address; the server resolves the area and computes the figure (§42.3).
4. The request waits in the unmanifested pool until a manifest claims it (§21.2).

### 5.2 Exception paths

| Path| Behaviour| Error code|
|---|---|---|
| Fewer than 2 packages, no exception| Refused. Self-booking a single package is barred for both customer types (§21.1)| `PICKUP_MINIMUM_NOT_MET`|
| Corridor destination off its batch day| **Accepted and priced at `corridor_off_day_fee`**, not refused. Only a day with no batch run *and* no configured off-day fee is refused| `CORRIDOR_DAY_NOT_PERMITTED`|
| One-package exception| Ops requests; **any holder of `pickup.exception.approve` approves** — Senior Ops, Platform Admin, or Ops Staff explicitly granted it, and never the requester. **Recipient name, phone and delivery address become mandatory** (§21.1). **Additionally carries `single_package_pickup_fee`, GH₵20** — approval decides whether Melarc goes, the fee prices the dedicated trip. The two are independent: approval does not waive the fee| `SELF_APPROVAL_FORBIDDEN`|
| Sunday, or zone not serviced that day| Refused. Uniform Monday–Saturday calendar, no zone variation (§21.1, `MSC-DEC-149`)| `SERVICE_DATE_NOT_PERMITTED`, `ZONE_NOT_SERVICED_ON_DATE`|
| **Past the hub booking cutoff**| **Confirms and queues for Ops review** — neither auto-scheduled nor blocked (§21.1). Ops approves a same-day exception or reschedules to the next operating day| **none** — a late booking is not an error|
| Suspended sender| Refused; existing non-terminal requests go on controlled hold, preserved not cancelled| `SENDER_SUSPENDED`|
| Attempt cap reached| Refused unless hub Senior Ops force-extends with a mandatory reason and immutable audit (§21.6, `MSC-DEC-116`). **Refused collection and cap exhaustion are escalation-only** (§21.6)| `PICKUP_ATTEMPT_LIMIT_REACHED`|
| Reschedule after failure| Ops cancels the source and creates a new `PENDING` clone carrying incremented attempt number and approved metadata (§21.6). Source and clone are **never simultaneously active** (§35.4.4)| `REPLACEMENT_REQUIRED`, `SOURCE_STILL_ACTIVE`|
| Vendor cancels a `CONFIRMED` request| Refused — the vendor holds no such permission. Office cancellation remains available| `PERMISSION_DENIED`|
| Concurrent edit| Deterministic rejection on the record version, never last-write-wins| `STATE_CONFLICT`|
| Undecided failure left sitting| A scheduled backstop escalates after `stale_failure_backstop_hours` (§21.6)| —|
| Offline| **N/A.** No surface creating a request operates offline; the rider app has no request-creation role| —|
| Missing configuration| An unset `booking_cutoff_time` cannot block a booking — the operation proceeds and the condition is recorded (`standards/engineering-standards.md` §7). **Still required behaviour with the Accra figure set**: §33.4 forbids inheritance, so a second hub starts with no cutoff at all| —|

### 5.3 Cancellation, and the charge that may follow

**The request never becomes uncancellable.** Office cancellation is available at every point; what changes after rider assignment is that it **may** carry a charge.

| Who| When| Charge|
|---|---|---|
| Vendor| Own `PENDING` request only| None|
| Ops| Any point, own hub| None before rider assignment|
| Ops| After rider assignment, reason attributed `CUSTOMER` or `EXTERNAL`| **Discretionary** `cancellation_charge_amount` — GH₵20 at the Accra hub|
| Ops| After rider assignment, reason attributed **`MELARC`**| **None, and not at Ops’ discretion**. Outcome records `EXEMPT`|

**Discretionary means the permission does not mandate the charge.** `MSC-DEC-197` is explicit: holding `pickup.request.cancel_chargeable` lets Ops apply the charge, it does not require them to. A build that charges automatically on every post-assignment cancellation has implemented a different policy from the approved one, and it will look correct in every test that only checks the happy path.

**A missing amount never blocks the cancellation.** Where `cancellation_charge_amount` is unset for the hub, the outcome records `UNAVAILABLE` and the cancellation proceeds. `SETTING_MISSING` was deliberately removed from this transition: **an operational or custody decision is never held hostage to missing commercial configuration.** A parcel's disposition cannot wait on a price nobody entered.

**The charge is tied to who caused the cancellation** (`MSC-DEC-388`, closing `OQ-116`). Every reason in every workflow carries a **mandatory** `attribution` — `CUSTOMER` · `MELARC` · `EXTERNAL` — at [domain-model.md](../../contracts/domain-model.md) §3.9. **Where the selected reason attributes the cancellation to Melarc** — no rider became available, a hub system fault, an internal routing error — **no charge is permitted**: `apply_charge` is ignored, the outcome records `EXEMPT`, and **the cancellation still proceeds**, on the same principle as the missing-amount rule above. **`CUSTOMER` and `EXTERNAL` attribution leave Ops discretion exactly as `MSC-DEC-197` set it** — this narrows the discretion, it does not mandate a charge, and the genuine-emergency case `MSC-DEC-197` protects is untouched.

**Why `EXEMPT` rather than `NOT_APPLIED`.** *Ops chose not to charge* and *the rule forbade charging* are different facts, and only the second measures how often Melarc cancels on its own failure. It is the same argument that already separates `UNAVAILABLE` from `NOT_APPLIED`. A waiver cannot be recorded against an `EXEMPT` outcome — there was never a charge to waive.


### 5.4 The waiver is a higher authority than the charge

Ops applies the charge. **Only Senior Ops relieves it** — `pickup.cancellation_charge.waive`, Senior Ops floor, actor and reason recorded, through `waiveCancellationCharge`.

That asymmetry is the point of `MSC-DEC-197`'s shape: **charged by default, relieved by judgement, and the waiver frequency visible in the audit trail.** A rule with no relief valve gets ignored in practice; a relief valve with no record gets used until it *is* the rule. The audit trail is what makes the difference observable rather than anecdotal.

**A waiver against no charge is refused** (`NO_CHARGE_APPLIED`). Where the outcome was `UNAVAILABLE` or `NOT_APPLIED` there is nothing to relieve, and recording a waiver anyway would corrupt the one signal this control depends on.

**A waiver is total or it is not a waiver.** `CancellationChargeWaiver` carries no amount field. A partial waiver would reprice a snapshotted charge, which [domain-model.md](../../contracts/domain-model.md) §3.7 forbids.

### 5.5 What this feature must never do

- **Never store the indicative estimate as a price.** `MSC-DEC-211` allows an estimate to be *shown*; it remains non-authoritative and creates no charge. The first authoritative price still appears at itemization, because the size class is selected there.
- **Never apply the same validation on only one booking channel.** WhatsApp bookings entered by Ops and Vendor PWA bookings must produce identical records and enforce identical rules. A rule enforced on one path and not the other is a defect, not a channel difference.
- **Never reserve credit or create a charge.** §36.11: pickup-request confirmation creates neither `CREDIT_RESERVED` nor `PAYMENT_REQUIRED`.
- **Never reject a late booking.** It is an Ops exception queue, not a validation failure. Rejecting it pushes work back onto the vendor that §21.1 deliberately keeps inside Ops.
- **Never let a per-request override rewrite a saved default.** Contact and location edits are transaction overrides (§35.2.6, §21.1).
- **Never cancel a suspended vendor's in-flight requests.** They go on hold; the records and their custody links survive.
- **Never treat reschedule as an edit.** It is cancel-plus-clone, and the chain is the evidence (§21.6, §35.4.3).

---

## 6. Entities — *pointer*

| Entity| Home|
|---|---|
| `PickupRequest`| [domain-model.md](../../contracts/domain-model.md) §6.2|
| `Approval` (one-package exception)| [domain-model.md](../../contracts/domain-model.md) §6.8|
| `AdHocSender`| [domain-model.md](../../contracts/domain-model.md) §6.8 — `PROVISIONAL` until a physical pickup completes|

Fields whose behaviour here is non-obvious: `attempt_number` (capped at 3), `replaces_request_id` (the chain), `cutoff_exception_state` (queued, not refused), `one_package_exception_id` (presence relaxes the minimum).

## 7. States — *pointer*

| Machine| Home| Transitions this feature drives|
|---|---|---|
| `PickupRequest.state`| [state-machines.md](../../contracts/state-machines.md) §3| `PENDING → CONFIRMED`, `→ DECLINED`, `→ CANCELLED`; cutoff-exception resolution; force-extension|

## 8. Permissions — *pointer*

| Key| Holders| Scope| Home|
|---|---|---|---|
| `pickup.request.create`| Ops, Senior Ops, Platform Admin, Vendor| Vendor: own only| [permissions.md](../../contracts/permissions.md) §7|
| `pickup.request.confirm`| Ops, Senior Ops, Platform Admin| own hub — **Ops only in V1**||
| `pickup.request.cancel`| Ops, Senior Ops, Platform Admin, Vendor| Vendor: own `PENDING` only||
| `pickup.exception.request`| Ops| own hub||
| `pickup.exception.approve`| **S P, and Ops Staff explicitly granted it**| own hub · P: all hubs| Widened off `P only` at Gate C. **The permission is authoritative, not the role**|
| `pickup.request.cancel_chargeable`| Ops, Senior Ops, Platform Admin| own hub. **Never a vendor**||
| `pickup.cancellation_charge.waive`| **Senior Ops, Platform Admin**| own hub. **Above the charge in authority — Ops applies, Senior Ops relieves**||
| `pickup.attempt.extend`| Senior Ops, Platform Admin| own hub, reason mandatory||

## 9. Settings — *pointer*

| Key| Why this feature reads it| Home|
|---|---|---|
| `booking_cutoff_time`| **10:00** at the Accra hub. Decides whether a request queues for Ops review — **never whether it is refused**| [settings.md](../../contracts/settings.md) §7.3|
| `MELARC_MAX_PICKUP_ATTEMPTS`| The attempt cap, 3||
| `stale_failure_backstop_hours`| **24** — one full service day before a backstop escalates an undecided failure||
| `cancellation_charge_amount`| **GH₵20** at the Accra hub. **Hub-scoped**, effective-dated, snapshotted. An unset value does **not** block a cancellation| [settings.md](../../contracts/settings.md) §7.2|

## 10. Errors — *pointer*

`PICKUP_MINIMUM_NOT_MET`, `SERVICE_DATE_NOT_PERMITTED`, `ZONE_NOT_SERVICED_ON_DATE`, `SENDER_SUSPENDED`, `PICKUP_ATTEMPT_LIMIT_REACHED`, `REPLACEMENT_REQUIRED`, `SOURCE_STILL_ACTIVE`, `REASON_REQUIRED`, `SELF_APPROVAL_FORBIDDEN`, `PERMISSION_DENIED`, `STATE_CONFLICT`, `NO_CHARGE_APPLIED` — all defined in [errors-and-enums.md](../../contracts/errors-and-enums.md).

**`BOOKING_CUTOFF_PASSED` is withdrawn** and must not be reintroduced.

## 11. Audit events — *pointer*

`pickup.request.created`, `pickup.request.confirmed`, `pickup.request.declined`, `pickup.request.cancelled`, `pickup.request.cancelled_chargeable`, `pickup.cancellation_charge.waived` *(enhanced)*, `pickup.exception.requested`, `pickup.exception.approved` *(enhanced)*, `pickup.attempt.extended` *(enhanced)*, `pickup.request.escalated` *(enhanced — CRIT-09 audit remediation)* — [audit.md](../../contracts/audit.md) §5.1.

**Every code is spelled in full here deliberately.** This section previously used the suffix form — `` `.confirmed` ``, `` `.declined` `` — which is not a resolvable identifier: it cannot be checked mechanically, and it would still read correctly after the event it points at was renamed.

## 12. API operations — *pointer*

`createPickupRequest`, `listPickupRequests`, `getPickupRequest`, `confirmPickupRequest`, `cancelPickupRequest`, `waiveCancellationCharge`, `escalatePickupRequest`, `extendPickupAttempts`, `requestOnePackageException`, `approveOnePackageException` — [openapi.yaml](../../contracts/openapi.yaml).

**The last three were added on 23 August**. Their permissions had existed since the catalogue was written; the calls had not.

---

## 13. Acceptance criteria

### `AC-SLICE-001-01` — Standard request confirms with an indicative estimate and no charge

```text
Given an Ops user with pickup.request.confirm and a PENDING request of 3 declared packages,
When the user confirms it,
Then the request state becomes CONFIRMED and it appears in the unmanifested pool,
And an indicative estimate of base fee times 3 is returned,
And it is labelled provisional rather than presented as a quote,
And no credit reservation or charge exists on the request or its sender,
And the same request entered from WhatsApp by Ops produces an identical record.
```

**Governs:** §21.1, §5.2.1, `MSC-DEC-211`, `MSC-DEC-215` · **Surface:** Melarc Ops, Melarc Vendor · **Test level:** API

### `AC-SLICE-001-02` — Single package is refused

```text
Given a vendor account holding pickup.request.create,
When it submits a request declaring one package with no approved exception,
Then the backend rejects it with PICKUP_MINIMUM_NOT_MET,
And no request is created.
```

**Governs:** §21.1, §35.2.3 · **Surface:** Melarc Vendor · **Test level:** API · **Code:** `PICKUP_MINIMUM_NOT_MET`

### `AC-SLICE-001-03` — One-package exception needs the permission and recipient details

```text
Given an Ops user has requested a one-package exception,
When a user WITHOUT pickup.exception.approve attempts to approve it,
Then the backend rejects the approval with PERMISSION_DENIED,
And when any holder of pickup.exception.approve approves it - Senior Ops, Platform Admin,
  or an Ops Staff member explicitly granted it - recipient name, phone and delivery
  address are mandatory,
And the drafting user may not approve their own request,
And the approved GH20 single-package fee becomes due on acceptance.
```

**Governs:** §21.1, §11.4 · **Surface:** Melarc Ops · **Test level:** API · **Code:** `PERMISSION_DENIED`, `SELF_APPROVAL_FORBIDDEN`

### `AC-SLICE-001-04` — A late booking queues, it does not fail

```text
Given the responsible hub booking cutoff has passed for the requested service date,
When an Ops user confirms the request,
Then the request state becomes CONFIRMED,
And cutoff_exception_state is PENDING_OPS_REVIEW,
And no error is returned and the booking is not rejected.
```

**Governs:** §21.1, `MSC-DEC-147–148`, `CONFLICT-024` · **Surface:** Melarc Ops · **Test level:** API

### `AC-SLICE-001-05` — Vendor cannot self-cancel a confirmed request

```text
Given a vendor account and its own request in CONFIRMED,
When the vendor attempts to cancel it,
Then the backend rejects with PERMISSION_DENIED,
And the request remains CONFIRMED,
And office cancellation of the same request still succeeds.
```

**Governs:** `MSC-DEC-196` · **Surface:** Melarc Vendor · **Test level:** API · **Code:** `PERMISSION_DENIED`

### `AC-SLICE-001-06` — Reschedule creates a linked clone, never an edit

```text
Given a request whose pickup attempt failed,
When Ops reschedules it,
Then the source request becomes CANCELLED with its reason preserved,
And a new PENDING request exists with attempt_number incremented and replaces_request_id set,
And the source and the clone are never both active.
```

**Governs:** §21.6, §35.4.3–4 · **Surface:** Melarc Ops · **Test level:** service · **Code:** `SOURCE_STILL_ACTIVE`

### `AC-SLICE-001-07` — Attempt cap holds without Senior Ops

```text
Given a request whose attempt_number is 3,
When an Ops user attempts a further reschedule,
Then the backend rejects with PICKUP_ATTEMPT_LIMIT_REACHED,
And when hub Senior Ops force-extends with a reason the reschedule succeeds,
And the extension records actor, reason, before and after values, and an audit event.
```

**Governs:** §21.6, §35.4.5, `MSC-DEC-116` · **Surface:** Melarc Ops · **Test level:** API · **Code:** `PICKUP_ATTEMPT_LIMIT_REACHED`

### `AC-SLICE-001-08` — Suspension holds, it does not cancel

```text
Given a vendor with non-terminal pickup requests,
When the vendor is suspended,
Then request creation is refused with SENDER_SUSPENDED,
And every non-terminal existing request is placed on controlled hold,
And no existing request is moved to CANCELLED.
```

**Governs:** §21.1, §35.12.7 · **Surface:** Melarc Ops · **Test level:** service · **Code:** `SENDER_SUSPENDED`

### `AC-SLICE-001-09` — Overrides never rewrite saved defaults

```text
Given a registered vendor with a saved default pickup location,
When a request is created carrying a request-specific location override,
Then the request carries the override,
And the vendor saved location and default are unchanged.
```

**Governs:** §21.1, §35.2.6 · **Surface:** Melarc Vendor · **Test level:** service

### `AC-SLICE-001-10` — Concurrent confirmation is rejected deterministically

```text
Given two Ops users have both read the same PENDING request,
When both submit a confirmation using their read ETag,
Then exactly one succeeds,
And the second receives STATE_CONFLICT rather than silently overwriting.
```

**Governs:** §36.1 · **Surface:** Melarc Ops · **Test level:** API · **Code:** `STATE_CONFLICT`

---

### `AC-SLICE-001-60` — The post-assignment charge is discretionary, not automatic

```text
Given a CONFIRMED request whose manifest already has an assigned rider,
When an Ops user cancels it without electing to charge,
Then the cancellation succeeds with no charge applied,
And the outcome is recorded as NOT_APPLIED rather than left null.
```

**Governs:** §21.6, `MSC-DEC-197` · **Surface:** Melarc Ops · **Test level:** API

### `AC-SLICE-001-61` — An unset amount does not block the cancellation

```text
Given a hub whose cancellation_charge_amount is unset,
When an Ops user cancels a post-assignment request electing to charge,
Then the cancellation still succeeds,
And cancellation_charge_outcome records UNAVAILABLE,
And no SETTING_MISSING error is returned.
```

**Governs:** §21.6, `MSC-DEC-197` · **Surface:** Melarc Ops · **Test level:** API

### `AC-SLICE-001-62` — Only Senior Ops may waive an applied charge

```text
Given a cancellation with a charge applied,
When an Ops Staff user attempts to waive it,
Then the waiver is refused,
And the same request waived by a Senior Ops user succeeds with actor and reason recorded.
```

**Governs:** §21.6, `MSC-DEC-197` · **Surface:** Melarc Ops · **Test level:** API · **Code:** `PERMISSION_DENIED`

### `AC-SLICE-001-63` — A waiver against no charge is refused

```text
Given a cancellation whose charge outcome is UNAVAILABLE or NOT_APPLIED,
When a Senior Ops user attempts to waive the charge,
Then the waiver is refused,
And no waiver event is written to the audit trail.
```

**Governs:** §21.6, `MSC-DEC-197` · **Surface:** Melarc Ops · **Test level:** API · **Code:** `NO_CHARGE_APPLIED`

### `AC-SLICE-001-64` — A waiver is total, and the charge stays snapshotted

```text
Given a cancellation with a GH₵20 charge applied and snapshotted,
When a Senior Ops user waives it,
Then the charge is relieved in full,
And the original snapshotted amount and version remain readable on the record,
And no request carrying a partial waiver amount is accepted.
```

**Governs:** §3.7, §21.6, `MSC-DEC-197` · **Surface:** Melarc Ops · **Test level:** API

---

### `AC-SLICE-001-69` — An `OWN_PACKAGES` request reuses the Vendor and asks only what changed

```text
Given a registered Vendor with a saved pickup location and a business goods profile,
When Ops or the Vendor creates a pickup request with pickup_intent OWN_PACKAGES,
Then the request is accepted without re-capturing sender identity, phones or address,
And resolved_pickup_location is the Vendor's selected or default saved location,
And a request supplying collection_point or collection_item is REJECTED as mis-declared,
And a transaction-specific description is accepted where this shipment differs from the profile.
```

### `AC-SLICE-001-70` — A `COLLECT_FOR_VENDOR` request sends the rider to the collection point

```text
Given a registered Vendor and a third-party seller holding the parcel,
When a request is created with pickup_intent COLLECT_FOR_VENDOR, a collection_point,
     a collection_reference and a collection_item,
Then resolved_pickup_location is the COLLECTION POINT and not the Vendor's address,
And a request carrying neither destination_location_id nor use_vendor_default_destination
     is REJECTED,
And use_vendor_default_destination against a Vendor with no default is REJECTED,
And no operation exists by which a rider pays or collects for the merchandise.
```

### `AC-SLICE-001-71` — A first-time ad-hoc sender is creatable, and a returning one is reused

```text
Given a walk-in sender who has never used Melarc,
When a request is created with pickup_intent ADHOC_SENDER and new_ad_hoc_sender,
Then the sender profile and the request are created as one idempotent act,
And the sender is NOT promoted to a registered Vendor,
And a request supplying both ad_hoc_sender_id and new_ad_hoc_sender is REJECTED,
And a request supplying neither is REJECTED.
```

### `AC-SLICE-001-72` — Today's goods are captured for every ad-hoc booking

```text
Given a returning ad-hoc sender identified by verified phone,
When a new request is created with pickup_intent ADHOC_SENDER,
Then their identity, contact and locations are reused from the stored profile,
And current_item_description is REQUIRED on this request,
And the description from their previous shipment is not carried forward as this one's,
And resolved_pickup_location is non-null.
```

### `AC-SLICE-001-79` — A vendor reaches only its own requests, and is never told another's exists

```text
Given two vendor organisations each holding pickup requests,
When one requests the other's request by id with getPickupRequest, or attempts cancelPickupRequest on it,
Then the response is 404 NOT_FOUND,
And its status, code, body shape and timing class are identical to those for an identifier that matches nothing,
And listPickupRequests for each vendor returns only that vendor's own requests,
And an Ops user who reads an existing request outside their hubs is told HUB_SCOPE_VIOLATION and one who reads a request that does not exist is told NOT_FOUND.
```

**Governs:** §37.3, §37.6, §43.2, `MSC-DEC-432` · **Surface:** Melarc Vendor, Melarc Ops · **Test level:** API · **Code:** `NOT_FOUND`, `HUB_SCOPE_VIOLATION`

## 14. Open questions blocking this feature

| ID| What it blocks here| Type|
|---|---|---|
| —| **Both figures set on 23 August** by `MSC-DEC-237` — cutoff 10:00, backstop 24 hours. `OQ-051` no longer bears on this feature| —|

**No `DECISION_NEEDED` question blocks this feature.** That is why the pickup thread was chosen as the proving slice, and the choice held.

## 15. What this feature still owes its slice

**Nothing outstanding.** Every dependency this feature named has closed. It contributes no blocker to its slice's Definition of Ready.

**Both surface documents exist** — this section said `surfaces/ops-portal.md` and `surfaces/vendor-pwa.md` did not. Their page inventories were accepted under `MSC-DEC-223`. `booking_cutoff_time` and the cancellation charge were set on 23 August, and chargeable cancellation is now specified at §5.3–§5.4 with five criteria.

**Readiness is not assessed here.** [definition-of-ready.md](../../standards/definition-of-ready.md) assesses it **for the complete vertical slice** and records the verdict in the slice document; a feature cannot answer §44.3 or §44.4 alone. This section feeds that assessment instead of duplicating it (`MSC-DEC-239`, closing `CONFLICT-029`).

## 16. Build status — *honest, per surface*

| Surface| Status| Gap|
|---|---|---|
| Melarc Ops| ⚪ not built| Everything|
| Melarc Vendor| ⚪ not built| Everything|
| Melarc Rider| N/A| No request-creation role (§21.1)|
| Recipient channel| N/A| Recipient unknown at this stage for a standard request|

## 17. Related

- **Downstream:** `features/pickup/pickup-manifest.md`, `features/pickup/pickup-collection.md` — a confirmed request enters the unmanifested pool
- **Contracts:** all seven, `APPROVED`
- **Slice:** `SLICE-001` in `delivery/IMPLEMENTATION_PLAN.md` *(not yet written)*
- **Surfaces:** `surfaces/ops-portal.md`, `surfaces/vendor-pwa.md` *(not yet written — see §15)*
