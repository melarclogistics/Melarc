# Return to Vendor

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.7 (cleaned edition)
> **Date:** 4 October 2026
> **Domain:** returns
> **Owns:** the behaviour and acceptance criteria for the core return-to-vendor workflow — how
> a parcel that has exhausted approved delivery attempts formally returns, and how the return
> fee is charged, waived and settled
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §28.1–§28.4, §5.2.4, §16.1
> **Slice:** `SLICE-006` (unwritten; this is its first feature document)

> **Link paths in this document use `../../`** — correct from `features/returns/<name>.md`.

## 1. What this is, and why

When a parcel exhausts its approved delivery attempts, Ops decides between scheduling a further
`Redelivery` (already specified, `delivery-failure.md`) or formally starting Return-to-vendor.
This feature owns the second path: the deliberate Ops act that commits a `ReturnRecord`, the
return fee's charge/waiver disposition, and the OTP-gated physical handover that closes it.
**Version 1 boundary, stated plainly**: this feature does **not** build a schema or workflow for a
vendor refusing the returned parcel (decided as policy — escalates to Senior Ops as a disputed
case under §28.7, `MSC-DEC-394` — but not represented here, pending two undecided siblings below),
an invalid or inaccessible recorded phone number, exceptional administrative OTP recovery, the
exact mechanism by which Senior Ops escalates unpaid ad-hoc-sender storage once its 14-day grace
period has run, damage or loss during return custody, or any part of the damage/loss/claims apparatus (§28.6, `OQ-004`,
`OQ-084`). **Cancellation or correction after Return starts is decided, not merely deferred**: a
committed `ReturnRecord` always runs to completion. The Master Specification's own
words place the remaining items with *"a future decision sprint or downstream security/operations
design"* — this feature does not anticipate that design.

## 2. Governing sections

| Section| What it governs here|
|---|---|
| §28.1–§28.2| Existing exception coverage and the common exception shape every material exception should define — the frame this feature fills for Return specifically|
| §28.3| Failed delivery and return to hub — the precondition this feature starts from, owned by `delivery-failure.md`|
| §28.4| Return to vendor/sender — the workflow this feature specifies in full: fee, payer split, waiver, OTP closure|
| §5.2.4| Delivery attempts and returns — the payer-split and settlement-path rule (statement vs. immediate demand) this feature reads, never restates|
| §16.1| Mode-specific terminal outcomes — *"returned to the vendor/sender through the approved return process"* is a named terminal outcome for doorstep service|
| §35| Business rules generally. None is invented here; every rule cites §28.4 or an approved decision|
| §40| Non-functional. Not applicable beyond what `delivery-failure.md`'s own doorstep OTP timing already sets — this feature adds no new target|

**Decisions that shape this feature:** `MSC-DEC-332` (the act), `MSC-DEC-231` (chargeable and
waivable), §28.4, `MSC-DEC-163` (waiver categories and approver≠requester), §28.4, `MSC-DEC-162`/`218`
(`flat_return_fee_amount` governance), `MSC-DEC-340` (the statement/immediate-demand settlement
split precedent), `MSC-DEC-385` (the `READY_FOR_REATTEMPT` exits this feature's precondition
relies on), `MSC-DEC-366` (the signed transitions this feature's operations implement),
`MSC-DEC-394` (partial waiver, no-cancellation, the CRIT-07 refund resolution, and the
vendor-refusal escalation policy — five items resolved interactively with the Product Owner),
`MSC-DEC-357` (`FinancialAdjustmentRequired`, reused for CRIT-07 rather than extended).

## 3. Surfaces and actors

| Surface| Actor| Can do| Gated by|
|---|---|---|---|
| Melarc Ops| Ops Staff, Senior Ops, Platform Admin| Commit a `ReturnRecord`; close a return the vendor collects in person; request/approve a full waiver| `returns.initiate`, `returns.close`, `returns.waiver.request`/`.approve`|
| Melarc Rider| Rider| Request the return OTP and close physical custody for their own assigned return| `returns.close`, own assigned return|
| Melarc Vendor| Vendor account| Read own return records — fee, waiver status, settlement path| `returns.read` (existing)|
| Recipient channel| —| **N/A.** The recipient is not a party to Return — the vendor/sender is (§28.4)| —|

## 4. Preconditions

The order is in fulfilment state `AT_HUB_AFTER_FAILURE` — reached either through a failed
physical delivery attempt (`delivery-failure.md`) or a `Redelivery` cancelled before departure.
The order carries exactly one of `vendor_organization_id` / `ad_hoc_sender_id`
(§6.7, always true). No `ReturnRecord` already exists for the order.

---

## 5. Behaviour

*This section and §13 are the only sections with original content. Everything else points
elsewhere.*

### 5.1 Normal path

1. An order sits `AT_HUB_AFTER_FAILURE`, eligible and unscheduled, owing nothing.
2. Authorised Ops reviews the case — never automatic on a third failed attempt — and commits a
   `ReturnRecord` (`initiateReturn`). The server derives `settlement_path` from the order's own
   vendor/ad-hoc-sender ownership, snapshots `return_fee_minor` from the hub's
   `flat_return_fee_amount`, and drives the commercial machine's
   `CREDIT_RESERVED/PREPAID/NO_VENDOR_CHARGE → REVERSED` transition, reversing the original
   delivery fee. **Where that delivery-fee demand already carries confirmed `PaymentReceipt`s**
   (a split-payment recipient portion collected before the final failed attempt), **one**
   `FinancialAdjustmentRequired` is raised with the existing `PAID_OBLIGATION_VOIDED` reason — no
   new enum value — for the **sum of the `CONFIRMED` receipts against that demand**, since a
   demand may carry several (§6.12, `MSC-DEC-363`) and a `REVERSED_BY_PROVIDER` receipt is not
   money Melarc holds. Its `source_key` is the `ReturnRecord`'s own commitment, so the retry
   `AC-RETURN-11` guarantees raises no second adjustment — the entity's own *one source
   condition, one record* invariant, satisfied rather than assumed. This decides
   refund as the resolution class; execution stays `OQ-005`'s.
   `order.return.initiated` is emitted.
3. **Where `settlement_path = IMMEDIATE_DEMAND`** (ad-hoc sender): a `RETURN_FEE`
   `OperationalPaymentDemand` line materialises on the next read (`MSC-DEC-359`'s existing
   read-resolution rule), exactly as every other obligation type already does.
4. **Where `settlement_path = STATEMENT`** (registered vendor): the fee is recorded on the
   `ReturnRecord` and settles later through the future `VendorStatement` mechanism.
   No demand is raised; handover is not gated on payment, exactly as an ordinary
   `CREDIT_RESERVED` delivery fee does not block dispatch.
5. Ops places the `ReturnRecord` on a `DeliveryRun`/`DeliveryStop` — the existing transport
   machinery, never a new one (§28.4's "assigned return movement").
6. The assigned Rider, or Ops where the vendor collects in person, requests the return OTP
   (`requestReturnOtp`), sent to the recorded vendor/sender contact. Refused with
   `RETURN_FEE_OUTSTANDING` where `settlement_path = IMMEDIATE_DEMAND` and the demand is not yet
   `SETTLED`.
7. Physical custody closes when the same actor submits a valid OTP (`closeReturnHandover`): the
   fee gate is re-checked, the OTP is validated against the recorded contact, the `ReturnRecord`
   reaches `COMPLETED`, `order.return.completed` is emitted, and the order's fulfilment machine
   reaches `RETURNED_TO_VENDOR` — terminal (§16.1).

**Waiver, where requested**, runs alongside step 2–7 rather than inside them: Ops requests a
waiver (`returns.waiver.request`) naming a `ReturnFeeWaiverReason` and proposing
`waiver_amount_minor`; a different Senior Ops or Platform Admin approves or rejects it as a whole
(`returns.waiver.approve`, approver ≠ requester) — **Senior Ops discretion, no formula**.
An `APPROVED` waiver sets `effective_return_fee_minor` to `return_fee_minor −
waiver_amount_minor` — zero for a full waiver — if this resolves before step 6, the payment gate
checks the reduced amount for the immediate-demand path.

### 5.2 Exception paths

| Path| Behaviour| Error code|
|---|---|---|
| Validation failure| Malformed OTP submission on close| `VALIDATION_FAILED`|
| Unauthorized| No `returns.initiate`/`returns.close` grant, or a Rider acting on another rider's assigned return| `PERMISSION_DENIED` / `NOT_ASSIGNED_RIDER`|
| Wrong state| `initiateReturn` on an order not `AT_HUB_AFTER_FAILURE`; OTP request/close on a `ReturnRecord` not `COMMITTED`/`IN_TRANSIT`| `STATE_CONFLICT`|
| Duplicate / replay| `Idempotency-Key` on `initiateReturn` and `closeReturnHandover` — a retry creates no second record, no duplicate fee snapshot, no duplicate reversal| `IDEMPOTENCY_KEY_CONFLICT`|
| Concurrent edit| Two concurrent `initiateReturn` calls for one order — the fulfilment transition itself is the guard, mirroring `scheduleRedelivery`'s own documented reasoning: only the first reaches `RETURN_TO_VENDOR_IN_PROGRESS`, the second finds the state already moved| `STATE_CONFLICT`|
| Retry| Idempotent by key (above); no separate retry interface state is approved for this workflow| —|
| Offline (rider surfaces)| **N/A.** §19.8 approves exactly one offline command (hub-handover queuing); return initiation and closure are not in that set, and this feature does not add to it — **return handover is online-only in Version 1**.| —|
| Missing configuration| **N/A, in practice.** `flat_return_fee_amount` is one of a hub's mandatory launch keys (§33.4) — a hub that can take bookings at all already has it configured. An operational decision is never blocked by missing commercial configuration regardless (`standards/engineering-standards.md` §7)| —|
| Cancellation / reversal| **N/A, by decision.** A committed `ReturnRecord` always runs to completion — no cancellation or correction path exists once `initiateReturn` commits (§28.5, `MSC-DEC-394`). This is confirmed design, not an unfilled gap| —|

### 5.3 What this feature must never do

- **Never derive `chargeable` from the failure reason.** Unlike `Redelivery`, the return fee is
  **charged by default** — the plausible mistake is copying `Redelivery`'s
  attribution-derived pattern here, which would waive fees the Product Owner decided should stand
  unless someone explicitly requests and gets approval to waive them.
- **Never let Ops choose `settlement_path`.** It is derived from the order's own vendor/ad-hoc
  ownership. An Ops-editable settlement path would let a registered vendor's return be routed
  around statement billing, or an ad-hoc sender's around the payment gate meant to protect it.
- **Never let Senior Ops modify the proposed waiver amount at approval.** Ops proposes
  `waiver_amount_minor` at `REQUESTED`; Senior Ops approves or rejects it as a whole, never edits
  it (§5.2.4, `MSC-DEC-394`) — a different figure is a new request, not a correction to the
  pending one.
- **Never compute a waiver fraction or percentage.** The amount is whatever Ops proposed under an
  approved reason — Senior Ops discretion, no formula. Inventing one here would be deciding a
  Product rule §5.2.4 leaves to judgement.
- **Never raise a `RETURN_FEE` demand for the statement settlement path.** A registered vendor's
  fee is earned on the `ReturnRecord` and stops there in this feature; materialising a demand for
  it would collect money through a channel `OQ-005`'s future `VendorStatement` design is meant to
  own.
- **Never gate the statement path's handover on payment.** Doing so would make a registered
  vendor's return stricter than their ordinary vendor-credit delivery fee, which §5.2.2 does not
  require to be paid before dispatch either.
- **Never accept an OTP request or submission without a committed `ReturnRecord`.** The gate
  exists precisely so custody cannot close on discretion or on payment alone (§28.4).

---

## 6. Entities — *pointer*

| Entity| Home|
|---|---|
| `ReturnRecord`| [domain-model.md](../../contracts/domain-model.md) §6.14 — new this pass|
| `Order` (`fulfilment_state`, `commercial_state`, `return_fee_minor`, `vendor_organization_id`/`ad_hoc_sender_id`)| domain-model.md §6.7|
| `OperationalPaymentDemand`, `PaymentDemandLine`| domain-model.md §6.12|
| `DeliveryRun`, `DeliveryStop`| domain-model.md §6.10 — reused transport, no new entity|
| `RedeliveryRecord`| domain-model.md §6.12 — the sibling decision at the same fork, cited for contrast (§5.3 above)|

## 7. States — *pointer*

| Machine| Home| States this feature drives|
|---|---|---|
| `Order.fulfilment_state`| [state-machines.md](../../contracts/state-machines.md) §9| `AT_HUB_AFTER_FAILURE → RETURN_TO_VENDOR_IN_PROGRESS`, `RETURN_TO_VENDOR_IN_PROGRESS → RETURNED_TO_VENDOR` — **already signed**, `MSC-DEC-366`; this feature implements them, does not amend them|
| `Order.commercial_state`| state-machines.md §8| `CREDIT_RESERVED/PREPAID/NO_VENDOR_CHARGE → REVERSED` — **already signed**|
| `ReturnRecord.status`| domain-model.md §6.14| `COMMITTED → IN_TRANSIT → COMPLETED` — new this pass, not a signed machine (no state-machine section owns it; it is a plain lifecycle field, the same treatment `Redelivery.status` receives)|

## 8. Permissions — *pointer*

| Key| Holders| Scope| Home|
|---|---|---|---|
| `returns.initiate`| Ops Staff, Senior Ops, Platform Admin| own hub| [permissions.md](../../contracts/permissions.md) §7 — new this pass|
| `returns.close`| Rider, Ops Staff, Senior Ops, Platform Admin| Rider: assigned return · Ops: own hub| permissions.md §7 — new this pass|
| `returns.waiver.request`| Ops Staff, Senior Ops, Platform Admin| own hub| permissions.md §7 — existing|
| `returns.waiver.approve`| Senior Ops, Platform Admin| own hub, approver ≠ requester| permissions.md §7 — existing|
| `returns.read`| Ops Staff, Senior Ops, Platform Admin, Vendor| own hub · own record| permissions.md §7 — existing|

**Two permission keys implement the existing routing authority** — the actors are already named by
the signed state machine (`MSC-DEC-332`'s "Authorised Ops"; the fulfilment machine's own "Rider
or Ops" for closure); naming the key that gates them decides no new authority, the same treatment
`MSC-DEC-392` gave `pickup.run.execute` for an already-approved transition.

## 9. Settings — *pointer*

| Key| Why this feature reads it| Home|
|---|---|---|
| `flat_return_fee_amount`| Snapshotted into `ReturnRecord.return_fee_minor` at commit| [settings.md](../../contracts/settings.md) §7.2|

## 10. Errors - *pointer*

| Code| When|
|---|---|
| `RETURN_FEE_OUTSTANDING`| Return handover attempted with the fee gate unsatisfied, immediate-demand path only| [errors-and-enums.md](../../contracts/errors-and-enums.md) §5|
| `OTP_INVALID`| The submitted return OTP does not validate| errors-and-enums.md §5|
| `STATE_CONFLICT`| Wrong order/`ReturnRecord` state for the attempted act| errors-and-enums.md §5|
| `PERMISSION_DENIED` / `NOT_ASSIGNED_RIDER`| No grant, or another rider's assigned return| errors-and-enums.md §5|

No new error code. `RETURN_FEE_OUTSTANDING`'s existing wording ("Return handover attempted...")
already covers both `requestReturnOtp` and `closeReturnHandover` without needing revision.

## 11. Audit events — *pointer*

| Event| Enhanced?| Home|
|---|---|---|
| `order.return.initiated`| Yes| [audit.md](../../contracts/audit.md) §5 — existing, cited for the first time from a feature|
| `order.return.completed`| No| audit.md §5 — new this pass, the completion half `order.return.initiated` never had|
| `payment.adjustment_required.created`| No (reused)| audit.md — existing, now also triggered by `initiateReturn`'s `PAID_OBLIGATION_VOIDED` case|

## 12. API operations — *pointer*

| Operation| Home|
|---|---|
| `initiateReturn`| [openapi.yaml](../../contracts/openapi.yaml)|
| `requestReturnOtp`| openapi.yaml|
| `closeReturnHandover`| openapi.yaml|

---

## 13. Acceptance criteria

*§43.1 form. Every criterion cites its governing §, decision, or entity invariant.*

### `AC-RETURN-01` — commitment reverses the original delivery fee

```text
Given an order AT_HUB_AFTER_FAILURE with commercial_state PREPAID,
When Authorised Ops calls initiateReturn,
Then the commercial machine transitions PREPAID -> REVERSED,
And a ReturnRecord is COMMITTED with return_fee_minor snapshotted from flat_return_fee_amount,
And order.return.initiated is emitted.
```
**Governs:** §28.4, `MSC-DEC-332`, state-machines.md §8 · **Surface:** API · **Test level:** integration

### `AC-RETURN-02` — ad-hoc sender settlement raises a demand

```text
Given an order owned by an AdHocSender (ad_hoc_sender_id set, vendor_organization_id null),
When initiateReturn commits the ReturnRecord,
Then settlement_path reads IMMEDIATE_DEMAND,
And a RETURN_FEE PaymentDemandLine materialises on the next read of the payer's demand.
```
**Governs:** §5.2.4, §28.4, domain-model.md §6.12 · **Surface:** API · **Test level:** integration

### `AC-RETURN-03` — registered-vendor settlement raises no demand

```text
Given an order owned by a VendorOrganization,
When initiateReturn commits the ReturnRecord,
Then settlement_path reads STATEMENT,
And no PaymentDemandLine of any obligation_type is created for the return fee,
And return_fee_minor remains readable on the ReturnRecord for the future VendorStatement
  mechanism to consume.
```
**Governs:** §5.2.4, §28.4, `MSC-DEC-340` (the statement-posting precedent) · **Surface:** API · **Test level:** integration

### `AC-RETURN-04` — charged by default, never derived from a failure reason

```text
Given a ReturnRecord committed against an order whose failure reason attributes the failure to
  MELARC,
When the ReturnRecord is read,
Then return_fee_minor is still populated at the full flat_return_fee_amount,
And waiver_status reads NOT_REQUESTED — unlike Redelivery.chargeable, nothing here derives a
  zero fee from the originating reason.
```
**Governs:** `MSC-DEC-231`, domain-model.md §6.14 · **Surface:** API · **Test level:** integration

### `AC-RETURN-05` — full waiver requires a different approver

```text
Given a ReturnRecord with return_fee_minor 2000 and waiver_status REQUESTED by Senior Ops A
  with reason MELARC_OPERATIONAL_ERROR and waiver_amount_minor 2000 — a full waiver is the
  case where the proposed amount equals the snapshotted fee,
When Senior Ops A attempts to approve their own request,
Then the response is 403 with a self-approval refusal,
And when a different Senior Ops B approves it, waiver_status reads APPROVED and
  effective_return_fee_minor reads 0.
```
**Governs:** §28.4, `MSC-DEC-163`, permissions.md §7 (`returns.waiver.approve`) · **Surface:** API · **Test level:** integration · **Expected code on rejection:** `SELF_APPROVAL_FORBIDDEN`

### `AC-RETURN-06` — handover blocked while the immediate-demand fee is outstanding

```text
Given an ad-hoc sender's ReturnRecord with an unsettled RETURN_FEE demand,
When closeReturnHandover is attempted with a valid OTP,
Then the response is 409 RETURN_FEE_OUTSTANDING,
And the ReturnRecord stays IN_TRANSIT.
```
**Governs:** §28.4, state-machines.md §9 (`RETURN_TO_VENDOR_IN_PROGRESS → RETURNED_TO_VENDOR`) · **Surface:** API · **Test level:** integration · **Expected code on rejection:** `RETURN_FEE_OUTSTANDING`

### `AC-RETURN-07` — statement path closes without a payment gate

```text
Given a registered vendor's ReturnRecord (settlement_path STATEMENT) with no demand ever raised,
When closeReturnHandover is attempted with a valid OTP,
Then the handover closes successfully,
And no RETURN_FEE_OUTSTANDING refusal occurs — the same non-gating rule an ordinary
  CREDIT_RESERVED delivery fee already follows at dispatch.
```
**Governs:** §5.2.2, §28.4 · **Surface:** API · **Test level:** integration

### `AC-RETURN-08` — the OTP goes to the recorded vendor/sender contact, never the recipient

```text
Given a committed ReturnRecord,
When requestReturnOtp is called,
Then the OTP is dispatched to the order's recorded vendor/sender contact,
And the request body carries no destination field — a caller-supplied number is inexpressible,
  the identical guard requestDeliveryOtp already uses for the recipient.
```
**Governs:** §28.4 · **Surface:** API · **Test level:** integration

### `AC-RETURN-09` — a rider cannot close another rider's return

```text
Given a ReturnRecord assigned to Rider A's DeliveryStop,
When Rider B calls closeReturnHandover for it,
Then the response is 403 NOT_ASSIGNED_RIDER.
```
**Governs:** permissions.md §7 (`returns.close`, Rider scope: assigned return) · **Surface:** API · **Test level:** integration · **Expected code on rejection:** `NOT_ASSIGNED_RIDER`

**The code is `NOT_ASSIGNED_RIDER`, and this criterion said `OWNERSHIP_VIOLATION` until 24 September 2026**. [openapi.yaml](../../contracts/openapi.yaml) declares `NOT_ASSIGNED_RIDER` on `closeReturnHandover` and not the other, and [errors-and-enums.md](../../contracts/errors-and-enums.md) separates them by which scope was violated: `OWNERSHIP_VIOLATION` is *"the record is outside the actor's ownership scope — another vendor's, an unassigned run"*, while `NOT_ASSIGNED_RIDER` is *"a rider acted on work assigned to someone else"*, which is this scenario exactly. **A criterion naming a code the operation cannot return is a test that fails against a correct implementation** — the same class the rider audit found in the contract itself.

### `AC-RETURN-10` — initiation refused outside the qualifying state

```text
Given an order in fulfilment state OUT_FOR_DELIVERY,
When Authorised Ops calls initiateReturn,
Then the response is 409 STATE_CONFLICT,
And no ReturnRecord is created.
```
**Governs:** state-machines.md §9, `MSC-DEC-332` · **Surface:** API · **Test level:** integration · **Expected code on rejection:** `STATE_CONFLICT`

### `AC-RETURN-11` — commitment is idempotent

```text
Given a successful initiateReturn call with Idempotency-Key K,
When the same request is retried with the same key K,
Then the original ReturnRecord is returned unchanged,
And no second commercial reversal, fee snapshot or audit event is produced.
```
**Governs:** §36.1, `MSC-DEC-350`'s identical reasoning for `scheduleRedelivery` · **Surface:** API · **Test level:** integration · **Expected code on rejection:** `IDEMPOTENCY_KEY_CONFLICT`

### `AC-RETURN-12` — no damage/claims path exists to invoke

```text
Given a committed ReturnRecord,
When any client attempts to attach a damage or loss claim to the return,
Then no operation in this contract accepts the request — no claim entity or endpoint exists,
And OQ-004/OQ-084 (damage, loss and claims) remain open rather than silently answered by this
  feature.
```
**Governs:** §28.5, §28.6, `OQ-004`, `OQ-084` · **Surface:** contract · **Test level:** contract

### `AC-RETURN-13` — partial waiver reduces the fee by exactly the approved amount

```text
Given a ReturnRecord with return_fee_minor 2000,
When Ops requests a waiver with waiver_amount_minor 800 and a ReturnFeeWaiverReason,
And a different Senior Ops approves it,
Then waiver_status reads APPROVED,
And effective_return_fee_minor reads 1200 — return_fee_minor minus waiver_amount_minor, never a
  formula or percentage Senior Ops did not directly approve.
```
**Governs:** §5.2.4, `MSC-DEC-394`, domain-model.md §6.14 · **Surface:** API · **Test level:** integration

### `AC-RETURN-14` — a prior partial payment on the reversed delivery fee raises a refund fact

```text
Given an order whose delivery-fee demand carries two CONFIRMED PaymentReceipts of 3000 and 500
  (a split-payment recipient portion collected across two tenders before the final failed
  attempt) and one REVERSED_BY_PROVIDER receipt of 3000,
When Authorised Ops calls initiateReturn,
Then exactly one FinancialAdjustmentRequired is raised with reason PAID_OBLIGATION_VOIDED,
  amount_minor 3500 — the sum of the CONFIRMED receipts, never the reversed one — and status
  OPEN,
And retrying initiateReturn with the same Idempotency-Key raises no second adjustment, because
  source_key is derived from the ReturnRecord commitment,
And no refund is executed by this operation — resolution stays OQ-005's.
```
**Governs:** §5.2.4, `MSC-DEC-394`, `MSC-DEC-357` (`FinancialAdjustmentRequired`) · **Surface:** API · **Test level:** integration

### `AC-RETURN-15` — a committed ReturnRecord cannot be cancelled

```text
Given a committed ReturnRecord in status IN_TRANSIT,
When any client attempts to cancel or reverse it,
Then no operation in this contract accepts the request — ReturnRecord.status has no CANCELLED
  value, by decision, not omission,
And the ReturnRecord must be carried to COMPLETED.
```
**Governs:** §28.5, `MSC-DEC-394`, domain-model.md §6.14 · **Surface:** contract · **Test level:** contract

---

## 14. Open questions blocking this feature

| ID| What it blocks here| Type|
|---|---|---|
| `OQ-042`| Failed-return adjustments and post-payment corrections — partial waiver and cancellation now decided and built| `DECISION_NEEDED` (deferred to `SLICE-006`)|
| `OQ-004`| Damage, loss, claims (§28.6), exceptional final disposition — CRIT-07's refund and the vendor-refusal policy now decided| `DECISION_NEEDED` (deferred to `SLICE-006`)|
| `OQ-084`| The late-claim acceptance audit event — claims-specific, not this feature's| `ARTIFACT_REQUIRED`|
| `OQ-030`| No Ops Portal page inventory exists for this feature yet| `ARTIFACT_REQUIRED`|

The two `DECISION_NEEDED` rows are formally deferred to `SLICE-006` under §50.4 (`MSC-DEC-255`,
`MSC-DEC-258`) — not the Product Owner's queue on a calendar, but genuinely undecided policy this
feature does not fill. **`OQ-125` closed at `MSC-DEC-396`** — the grace period is 14 days; what remains
is the escalation mechanism itself, which is `OQ-004`’s. `OQ-123` is **not** listed here: it closed with this feature's first pass,
for the settlement path this feature actually builds.

## 15. What this feature still owes its slice

| Owed| Blocks which DoR area| Owner|
|---|---|---|
| `SLICE-006` itself is unwritten — this is the first feature document under its eventual scope| F (acceptance and delivery)| Engineering — `SLICE-006`|
| An Ops Portal screen for Return review and initiation| D (frontend)| `OQ-030`|
| Failed-return adjustments and post-payment corrections| C (domain and rule readiness)| `OQ-042`|
| The unpaid-storage escalation mechanism itself (permission, trigger, final disposition) — its 14-day grace period is now valued| B, C| `OQ-004`|
| Damage, loss, claims, and the two undecided §28.5 security-design items| B, C| `OQ-004`, `OQ-084`|
| A return-fee waiver audit event — `returns.waiver.request` and `returns.waiver.approve` emit nothing today, while `pickup.cancellation_charge.waived` is Enhanced; the acts are approved and the event is the missing artifact| B, C| Engineering — `SLICE-006`, on the `MSC-DEC-392` routing class|

## 16. Build status — *honest, per surface*

| Surface| Status| Gap|
|---|---|---|
| Melarc Ops| ⚪ not built| No Ops Portal page inventory; operations are specified, not implemented|
| Melarc Rider| ⚪ not built| Same — no device build against this contract yet|
| Melarc Vendor| ⚪ not built| `returns.read` exists; no screen consumes it yet|
| Recipient channel| N/A| Not a party to Return (§3 above)|

## 17. Related

- [delivery-failure.md](../delivery/delivery-failure.md) — the failed-attempt chain and
  `Redelivery` this feature's precondition and sibling decision both come from
- [cash-collection.md](../delivery/cash-collection.md) — `RiderCashCustody` itself is unaffected
  by a Return (custody stays what was physically collected); a confirmed `PaymentReceipt` against
  the reversed delivery-fee demand now raises a `FinancialAdjustmentRequired` at commit
  rather than sitting unresolved
- [daily-operations-and-cash-report.md](../reporting/daily-operations-and-cash-report.md) — now
  shows `RETURN_FEE` revenue for the settlement path this feature builds
- `delivery/IMPLEMENTATION_PLAN.md` §3 — `SLICE-006`, depends on `SLICE-003`, blocked by `OQ-004`/`OQ-042`/`OQ-084`
