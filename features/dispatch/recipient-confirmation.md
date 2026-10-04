# Recipient confirmation

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.11 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** the delivery-day confirmation call, its four outcomes, and the gate it places on dispatch
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §24.2, §20.2, §20.4, and cross-cutting §35.7, §16, §40
> **Slice:** `SLICE-002`

## 1. What this is, and why

Before a doorstep parcel enters a delivery run, **the assigned Rider or authorised Ops contacts the recipient.** Both act under `dispatch.recipient_confirmation.work` and both write **the same canonical record** — and **where Ops has already confirmed, the rider does not call again**: the result is shown, not the task. The contact records one of four outcomes, and only one of them lets the parcel move.

**This is the dispatch gate, not a courtesy.** §20.2 makes the call *"mandatory before a doorstep parcel enters a delivery run, regardless of payer"* — and it is the phrase *regardless of payer* that carries the weight. A fully vendor-paid parcel still requires the call.

**Version 1 boundary.** This feature owns the call and its outcomes. It does not build runs — that is [delivery-run-build](delivery-run-build.md) — and it does not deliver. The recipient has no account and no portal (§20.1, §10.1).

## 2. Governing sections

| Section| What it governs here|
|---|---|
| §24.2| The confirmation queue, the four outcomes, attempt logging, escalation|
| §20.2| The call as a mandatory dispatch gate, regardless of payer; the refined-location note|
| §20.4| Content rules — identify Melarc, expose nothing unnecessary|
| §35.7| **Cross-cutting.** Rules 1 and 2: not dispatch-eligible until satisfied; attempts persisted|
| §16| **Cross-cutting.** Where this sits in the parcel lifecycle|
| §40| **Cross-cutting.** Non-functional targets|


## 3. Surfaces and actors

| Surface| Actor| Can do| Gated by|
|---|---|---|---|
| Melarc Ops| Ops Staff| Work the confirmation queue; record an attempt and outcome| `dispatch.recipient_confirmation.work`|
| **Melarc Rider**| **Rider**| **Performs `PRE_DISPATCH` contact on assigned parcels and records the outcome — the same canonical record Ops writes**. **Where Ops has already confirmed, the rider does not call again**: the result is shown, not the task. Also receives the refined-location note on the stop| `dispatch.recipient_confirmation.work`|
| Melarc Ops| Senior Ops| Decide orders **Ops has escalated as contact-exhausted**. **There is no attempt cap to be past**| `dispatch.recipient_confirmation.work`|
| Recipient channel| Recipient| **Receives a phone call.** No account, no portal, no screen (§20.1). Supplies **availability, location confirmation, and reschedule or location requests**| —|
| **Melarc Vendor**| **Vendor account**| **Party to the exception, not to the call**. Where contact fails, the number is wrong, an alternative contact is needed or the vendor must simply know — the Vendor **submits information on their own order**. **Ops applies the authoritative correction**; the submission is an input and never a mutation| `vendor.contact_assistance.submit`|

## 4. Preconditions

- The order exists, itemization has closed, and `delivery_confirmation_status = pending` (§24.2).
- `lane = DOORSTEP`. Outbound third-party lanes do not take this gate (§24.8).
- **No provider is a precondition of the call or of its record.** The call is a human act and the attempt record saves without one (§5.4); `OQ-048`'s telephony and SMS provider is a **launch** dependency for any supporting message, not a precondition of recording an attempt.

## 5. Behaviour

### 5.1 Normal path

1. **The order enters the confirmation queue** at itemization close, `AWAITING_ATTEMPT`.
2. **The assigned Rider or authorised Ops contacts the recipient** and records the attempt with one of four outcomes — **one record, whoever made the call**. Ops typically works the queue before dispatch; a rider clears what remains on their own assigned parcels. **Neither repeats what the other has already confirmed.**
3. **`confirmed` makes the order run-eligible.** It joins the doorstep ready pool.
4. **Anything else holds the parcel at the hub** — `reschedule`, `address_correction` and `unreachable` all keep it there, and **a held parcel is not loaded**. Holding is a routine outcome, not a failure.
5. **Where contact fails or the number is wrong, the Vendor is notified and may help** — a corrected number, an alternative contact, or simply the awareness that their delivery is stuck. The Vendor **submits information**; **Ops applies the authoritative correction**.
6. **A refined-location note may be captured** and is **copied onto the delivery stop** (§24.2, §24.4).

### 5.2 Four outcomes, and only one advances the order

| Outcome| Effect| Canonical `outcome` (§6.12)| `reason_code`|
|---|---|---|---|
| `confirmed`| **Run-eligible**| `SUCCESSFUL`| Not carried|
| `reschedule`| Held| `SUCCESSFUL` — **the person was reached**| Not carried; a `delivery_commitment_id` records it|
| `address_correction`| Held| `SUCCESSFUL` — **the person was reached**| Not carried; a `location_change_request_id` records it|
| `unreachable`| Held| **`UNSUCCESSFUL`**| **Mandatory**, and valid for `PRE_DISPATCH`|

**The mapping is `MSC-DEC-409`'s and it is the reason three of these four carry no reason code.** A reschedule is a held order, not a failed call. **`unreachable` is the only outcome that failed to reach a person**, and §11's signed row guards it on *"an `active` `PRE_DISPATCH` reason"*.

**The seeded `PRE_DISPATCH` reasons** (`MSC-DEC-409`, closing `OQ-142`) — **seeded defaults in a controlled catalogue, not a closed enum**:

| `code`| Routes to| `attribution`| Vendor notified|
|---|---|---|---|
| `NO_ANSWER`| Retry; no Ops action| `CUSTOMER`| Not independently — **§11's own effect still notifies with the recipient's name where assistance helps**|
| `NUMBER_INCORRECT`| **The Vendor, for a correction**| `EXTERNAL`| **Yes**|
| `RECIPIENT_DECLINED`| **Ops decision queue** — §11's `REFUSED` path| `CUSTOMER`| **Yes**|
| `CONTACT_NOT_POSSIBLE_MELARC`| Rider-support follow-up. **No customer consequence**| `MELARC`| **No** — the failure is Melarc-side|

**`RECIPIENT_NOT_AT_LOCATION` is not selectable here.** It is `DOORSTEP`-only, because it asserts physical presence at the authorised location, and `REASON_NOT_VALID_FOR_CHECKPOINT` refuses it at this checkpoint.

**No contact reason consumes a physical delivery attempt** — `consumes_delivery_attempt` is `false` across the domain, and nobody has travelled at this checkpoint anyway.

**Three of the four hold the order, and none of them is a failure.** A held order is waiting, not broken — and a surface that renders `unreachable` as an error state will train Ops to treat a routine outcome as an incident.

**There is no fixed call ceiling**. Retry whenever it is operationally useful — a Vendor-supplied number, an alternative contact, another try before the run departs — and **no force-extension is required**. Where **Ops judges the contact avenues exhausted**, Ops escalates through `escalateRecipientConfirmation` with a mandatory reason and **no count in the request**; `escalated_at` is set and the order enters a **senior decision queue**: **held, not lost**. **A rider may not escalate** — they call, record and ask for help; the judgement is Ops's. **A call count is audit history, never a gate.**

**The escalation queue has exactly two exits**, and hub Senior Ops chooses:

| Exit| Effect|
|---|---|
| **Return the order to the working queue**, mandatory reason| Order returns to `AWAITING_ATTEMPT` and contact may continue.|
| **Start the return**, reason required| §28.4 return-to-vendor. **`flat_return_fee_amount` applies** — waivable by Ops with a reason, Senior Ops approving|

**Dispatching without confirmation is not an exit, and the reason survives the OTP fallback** *(Gate C C1.2)*. It would be easy to conclude that pre-dispatch confirmation no longer matters because Ops can authorise a fallback at the door. **It does not follow.** The fallback is a **doorstep exception for a recipient who is physically present**; pre-dispatch confirmation exists to **avoid carrying a parcel to someone who will not be there at all**. One recovers a delivery in progress, the other prevents a wasted trip, and **neither substitutes for the other**.

**The purpose is to reduce wasted dispatch and find delivery problems before the parcel leaves the hub** — an unreachable recipient, a wrong number, an unavailability, a date or location change. That is the whole justification and it stands alone.

### 5.3 Why *regardless of payer* is the rule most at risk

§20.2 and §24.3 both say it: confirmation is required **regardless of payer**.

The plausible-but-wrong reasoning goes: *a fully vendor-paid parcel needs no money at the door, so why call?* The answer is that the call is not about money. It establishes that **someone will be there** — and an unconfirmed doorstep delivery is a wasted rider trip whoever paid.

An implementation that skips the call for prepaid parcels has optimised away the dispatch gate for exactly the orders Melarc has already been paid for.

### 5.4 Exception paths

| Path| Behaviour| Error code|
|---|---|---|
| Attempt recorded with no outcome| Refused. The four outcomes are fixed (§24.2)| `VALIDATION_FAILED`|
| Order not `DOORSTEP`| Refused. Outbound lanes do not take this gate (§24.8)| `VALIDATION_FAILED`|
| Attempt on an already-confirmed order| Refused| `STATE_CONFLICT`|
| **Ops judges the contact avenues exhausted**| `escalated_at` set; **senior decision queue** with two exits (`MSC-DEC-230`, refined by `MSC-DEC-351`). Not terminal, and **not triggered by a count**| —|
| Return started on an unreachable recipient| **`flat_return_fee_amount` charged by default**, waivable by Ops with a reason| `REASON_REQUIRED`|
| Address correction crossing a service area| Held, and **controlled repricing** — Ops requests, hub Senior Ops approves, **both price versions preserved** (§23.6, `MSC-DEC-207`)| `NO_PRICING_CHANGE`|
| Address correction within one service area| Corrected, **no repricing** — nothing moved| —|
| Provider unavailable| The call is a human act; the *record* still saves. **A telephony outage must not block recording an attempt already made**| `DELIVERY_CHANNEL_FAILED` — on any supporting message only, never on the attempt record|
| Concurrent attempts by two officers| One wins; the other sees the conflict, never a silent overwrite| `STATE_CONFLICT`|

### 5.5 What this feature must never do

- **Never skip the call because the parcel is prepaid.** §20.2, §24.3: regardless of payer. See §5.3.
- **Never store attempts as a counter.** §24.2 requires them persisted, *"not kept only in transient UI state."* A count cannot answer *when* or *what was said*, which is what a dispute needs.
- **Never treat `unreachable` as terminal.** It holds the order, and **where Ops judges the contact avenues exhausted** it escalates to a human. There is no automatic write-off and **no count that triggers one**.
- **Never reintroduce a call ceiling under another name.** A retry limit, a throttle or a *maximum attempts* setting would restore the retired rule by implication — retries happen whenever they are operationally useful.
- **Never reprice on an address correction that stays within a service area.** Under flat pricing most corrections move no money, and firing a maker-checker workflow plus a customer notification for a price that did not change is worse than doing nothing.
- **Never expose vendor or internal context to the recipient** (§20.4). A recipient learns about their own delivery, nothing about the vendor's other parcels.
- **Never let the refined-location note stop here.** Its entire value is reaching the rider's stop detail (§24.4, §19.3).

## 6. Entities — *pointer*

| Entity| Home|
|---|---|
| `RecipientConfirmation`| [domain-model.md](../../contracts/domain-model.md) §6.10|
| `Order`| §6.7 — `fulfilment_state`, `lane`|

## 7. States — *pointer*

| Machine| Home| States this feature drives|
|---|---|---|
| `RecipientConfirmation.state`| [state-machines.md](../../contracts/state-machines.md) §11| `AWAITING_ATTEMPT → ATTEMPTED_NO_ANSWER`, `→ CONFIRMED`, `→ ESCALATED`|
| `Order.fulfilment_state`| §9| `AWAITING_RECIPIENT_CONFIRMATION → READY_FOR_DISPATCH`|

## 8. Permissions — *pointer*

| Key| Holders| Scope| Home|
|---|---|---|---|
| `dispatch.recipient_confirmation.work`| A S P, **Rider**| own hub · **Rider: assigned parcels**. Escalation and the location-change decision are Ops-only acts under it| [permissions.md](../../contracts/permissions.md) §7|
| `vendor.contact_assistance.submit`| Vendor| own order — an input, never a mutation| §7|
| `delivery.commitment.revise`| A S P| own hub — the reschedule Ops applies with `CUSTOMER` attribution| §7|
| `dispatch.read`| A S P, Rider| own hub · assigned| §7|

## 9. Settings — *pointer*

| Key| Why this feature reads it| Home|
|---|---|---|
| ~~`delivery_confirmation_max_attempts`~~| **Retired by `MSC-DEC-351`** — `PRE_DISPATCH` has no fixed call ceiling, and the key must not be repurposed as a throttle.| [settings.md](../../contracts/settings.md) §7.3|
| `flat_return_fee_amount`| Charged when an unreachable-recipient order returns| §7.2|

## 10. Errors — *pointer*

`VALIDATION_FAILED`, `STATE_CONFLICT`, `NO_PRICING_CHANGE`, `REASON_REQUIRED`, `DELIVERY_CHANNEL_FAILED` — [errors-and-enums.md](../../contracts/errors-and-enums.md).

## 11. Audit events — *pointer*

| Event| Enhanced?| Home|
|---|---|---|
| `dispatch.confirmation.attempted`|| [audit.md](../../contracts/audit.md) §5.3|
| `dispatch.confirmation.confirmed`|| §5.3|
| `dispatch.confirmation.escalated`|| §5.3|
| `delivery.dispatch.cleared` / `delivery.dispatch.held`|| §5.3|
| `vendor.contact_exception.notified`|| §5.3|

## 12. API operations — *pointer*

`getRecipientConfirmation`, `recordConfirmationAttempt` (Rider or Ops), **`escalateRecipientConfirmation`** (Ops judgement, reason mandatory), `submitVendorContactAssistance` (Vendor), `requestDeliveryLocationChange` and `decideDeliveryLocationChange`, `reviseDeliveryCommitment` (Ops applies a reschedule with `CUSTOMER` attribution) — [openapi.yaml](../../contracts/openapi.yaml).

## 13. Acceptance criteria

### `AC-SLICE-002-01` — Confirmation is required regardless of payer

```text
Given a doorstep order that is fully vendor-paid with no amount due at the door,
When dispatch eligibility is evaluated before any confirmation attempt,
Then the order is not run-eligible,
And it does not appear in the doorstep ready pool,
And a recipient-paid order in the same state behaves identically.
```

**Governs:** §20.2, §24.3 · **Surface:** Melarc Ops · **Test level:** integration

### `AC-SLICE-002-02` — Every attempt is a record, not a counter

```text
Given an order with two prior confirmation attempts,
When the confirmation record is read,
Then both attempts are returned with their timestamps, actors and outcomes,
And no response exposes only a count,
And an attempt persists even if the call itself achieved nothing.
```

**Governs:** §24.2, §35.7 · **Surface:** Melarc Ops · **Test level:** API

### `AC-SLICE-002-03` — Only `confirmed` advances the order

```text
Given a pending doorstep order,
When the outcome recorded is reschedule, address_correction or unreachable,
Then the order remains held and is not run-eligible,
And none of the three is presented as an error,
And when confirmed is recorded the order becomes run-eligible.
```

**Governs:** §24.2 · **Surface:** Melarc Ops · **Test level:** API

### `AC-SLICE-002-04` — Ops-judged exhaustion escalates rather than fails

```text
Given an order whose recipient has not been reached after operationally reasonable contact,
When Ops escalates it as contact-exhausted with a reason — a judgement, and no count in the request,
Then escalated_at is set,
And the order enters the senior decision queue,
And the order reaches no terminal failure state,
And Senior Ops can still act on it.
```

**Governs:** §24.2, §20.2 · **Surface:** Melarc Ops · **Test level:** integration

### `AC-SLICE-002-05` — An address correction reprices only across a service area

```text
Given a confirmed-price order whose recipient corrects the address,
When the corrected address resolves within the same service area,
Then no repricing workflow is triggered and the price is unchanged,
And when it resolves to a different service area the controlled repricing path runs,
And both price versions are preserved.
```

**Governs:** §24.2, §23.6, `MSC-DEC-207` · **Surface:** Melarc Ops · **Test level:** integration

### `AC-SLICE-002-06` — The refined-location note reaches the rider

```text
Given a confirmation call that captured a refined-location note,
When the order is added to a delivery run,
Then the note appears on the delivery stop,
And the rider sees it in the stop detail,
And it is not lost between the call and the doorstep.
```

**Governs:** §24.2, §24.4, §19.3 · **Surface:** Melarc Ops, Melarc Rider · **Test level:** e2e

### `AC-SLICE-002-21` — A reason is mandatory where the call failed, and only where it failed

```text
Given an order awaiting its PRE_DISPATCH checkpoint,
When the outcome unreachable is recorded with no reason_code,
Then the request is refused with REASON_REQUIRED,
And when it is recorded with RECIPIENT_NOT_AT_LOCATION,
Then it is refused with REASON_NOT_VALID_FOR_CHECKPOINT, because that reason is DOORSTEP-only,
And when it is recorded with NO_ANSWER, the attempt is written and the parcel is held at the hub,
And a confirmed outcome carries no reason_code and is accepted.
```

**Governs:** §24.2, `MSC-DEC-409`, `MSC-DEC-407`, state-machines.md §11 · **Surface:** Melarc Rider, Melarc Ops, backend · **Test level:** integration · **Expected code on rejection:** `REASON_REQUIRED`, `REASON_NOT_VALID_FOR_CHECKPOINT`

### `AC-SLICE-002-22` — The Vendor is told what the Vendor can act on

```text
Given a PRE_DISPATCH contact recorded unreachable with NUMBER_INCORRECT,
Then vendor_notification_state is REQUIRED and the notice carries the recipient name, the order,
  the checkpoint, the reason and the requested Vendor action,
And given the same contact recorded with CONTACT_NOT_POSSIBLE_MELARC,
Then vendor_notification_state is NOT_REQUIRED and no Vendor notice is raised,
And a failed send is recorded as FAILED and never erases the contact attempt.
```

**Governs:** `MSC-DEC-409`, `MSC-DEC-348` · **Surface:** Melarc Vendor, backend · **Test level:** integration

### `AC-SLICE-002-23` — A reschedule is a reached recipient, not a failed call

```text
Given a PRE_DISPATCH call where the recipient asks for a different day,
When the outcome reschedule is recorded,
Then the canonical attempt outcome is SUCCESSFUL and no reason_code is carried,
And the order is held at the hub rather than cleared for dispatch,
And Ops makes the commitment revision; no rider screen offers a date picker.
```

**Governs:** `MSC-DEC-409`, `MSC-DEC-348`, `MSC-DEC-347` · **Surface:** Melarc Ops, backend · **Test level:** integration

## 14. Open questions blocking this feature

| ID| What it blocks here| Type|
|---|---|---|
| —| **No call ceiling exists**. `MSC-DEC-230`'s two escalation exits are reached by **Ops judgement** that the avenues are exhausted — `escalateRecipientConfirmation` — never by a count.| —|
| `OQ-048`| The telephony or SMS provider. The call is a human act, but attempt logging and any supporting message need one| `EXTERNAL_INPUT`|
| ~~`OQ-003`~~| **Closed for this feature** by `MSC-DEC-230` — the queue has two exits. What remains in `OQ-003` is refusal and unavailability **at the door**, which belongs to `SLICE-003`| —|

**`OQ-003` bit here and no longer does.** Escalation used to put an order in front of a human with no defined choices; `MSC-DEC-230` gave the queue two exits on 21 August. **A queue whose exits are unspecified is where orders accumulate**, and nobody notices, because each individual order looks like it is being handled.

## 15. What this feature still owes its slice

| Owed| Blocks which DoR area| Owner|
|---|---|---|
| Telephony and notification provider| **E — launch, not specification**| `OQ-048`|

**One item, and it does not block readiness.** `OQ-048` is `EXTERNAL_INPUT`: it gates launch, it gated launch through the twelve days `SLICE-002` was `READY` before Gate C C1.9, and it gates launch now.


## 16. Build status — *honest, per surface*

| Surface| Status| Gap|
|---|---|---|
| Melarc Ops| ⚪ not built| Queue and attempt screens are `OQ-030`|
| Melarc Vendor| ⚪ not built| **Contact-assistance submission on the vendor's own order**; routes are `OQ-030`|
| Melarc Rider| ⚪ not built| **Performs `PRE_DISPATCH` contact on assigned parcels** and receives the refined-location note. Screen family L at [rider-android.md](../../surfaces/rider-android.md)|
| Recipient channel| ⚪ not built| Provider is `OQ-048`|

## 17. Related

- **Siblings:** [delivery-run-build](delivery-run-build.md) · [atomic-dispatch](atomic-dispatch.md)
- **Surfaces:** [ops-portal.md](../../surfaces/ops-portal.md) · [recipient-channel.md](../../surfaces/recipient-channel.md)
- **Slice:** `SLICE-002` in [IMPLEMENTATION_PLAN.md](../../delivery/IMPLEMENTATION_PLAN.md)
