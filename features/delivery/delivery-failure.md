# Delivery failure and reattempt

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.21 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** the unsuccessful doorstep attempt — which checkpoint failed and whether a physical attempt was consumed, custody afterwards, the Ops disposition that follows (hold, Redelivery or formal Return), and the hub return that is mandatory rather than preferred
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §25.3, §25.4, §34.5, §36.9, and cross-cutting §35.8, §16, §40
> **Slice:** `SLICE-003`

## 1. What this is, and why

An attempt at the door did not end in delivery. This feature owns what happens next: **which checkpoint failed and whether that consumes a physical attempt at all**, where the parcel goes, **what authorised Ops may decide next** — hold, redelivery or formal Return — and what must be recorded for the attempt chain to stay auditable.

**The rule with the sharpest edge is custody.** §25.4: *"Riders may not retain delivery parcels overnight."* The parcel goes back to its responsible hub after the run, every time. §25.4 permits downstream design to decide the mechanics and says in terms that they *"may not contradict the mandatory hub-return rule"* — a sentence written because someone will propose an exception for a rider whose next run starts at the same address tomorrow.

**Version 1 boundary.** The successful path is [doorstep-delivery](doorstep-delivery.md). Money already collected is [cash-collection](cash-collection.md). **Formal return-to-vendor is `SLICE-006`** and begins only when authorised Ops commits a `ReturnRecord`.

## 2. Governing sections

| Section| What it governs here|
|---|---|
| §25.3||
| §25.4| Custody after an unsuccessful attempt, and the mandatory hub return|
| §34.5| The attempt counter. **Its ceiling is superseded** — the counter is history, not a gate|
| §36.9| `DeliveryStop → FAILED` and the order's attempt chain. **Also records that delivery failure reasons "remain to be canonicalized"** — the gap named in the specification itself|
| §21.5| **Cited for contrast** — it fixes four pickup failure categories; delivery uses a **controlled extensible catalogue** with five seeded defaults instead|
| §26.3| Cash returning with the rider from a failed stop|
| **§25.6**| **Surface responsibilities** — the Rider does hub return and reattempt work; Ops owns the failed-attempt and hub-return **queues**|
| **§25.7**| Names the preserved follow-ups, including the **failure-reason catalogue** — the most direct citation for `OQ-093`|


## 3. Surfaces and actors

| Surface| Actor| Can do| Gated by|
|---|---|---|---|
| Melarc Rider| Rider| Record a failed attempt with a reason| `delivery.stop.close`, assigned stop only|
| Melarc Ops| Ops Staff| Work the **failed-attempt and hub-return queues**; schedule a `Redelivery` (`scheduleRedelivery`), which creates the charge where chargeable; assign the next run (§25.4, §25.6)| `dispatch.run.create`, `dispatch.read`, `delivery.read`.|
| Melarc Ops| Senior Ops| Commit a **formal Return** — a deliberate act with a reason, never a counter's consequence| The Return-initiation operation lands with `SLICE-006`; `returns.waiver.request` / `.approve` exist for the fee|
| Melarc Ops| Ops Staff| Receive the parcel back into hub custody| `hub.handover.submit`|
| Melarc Vendor| Vendor| **Attempt history, return state and return-fee/account effects** on its own order (§25.6)| `delivery.read`, own record|

## 4. Preconditions

- The stop is `ARRIVED` and belongs to the executing rider.
- **The stop is a physical `DOORSTEP` attempt.** `PRE_DISPATCH` and `NEXT_STOP` contact failures are handled at their own checkpoints and **consume no physical attempt**.
- **No attempt-count precondition applies.**

## 5. Behaviour

### 5.0 Three contact checkpoints, one physical attempt — *Gate C C1.2*

`MSC-DEC-346`. **The three are chances to reach a person, not three journeys.**

|| Checkpoint| Who| A physical attempt?|
|---|---|---|---|
| 1| **`PRE_DISPATCH`** — before the parcel leaves the hub| Assigned Rider **or** authorised Ops| **No.** Nobody has travelled|
| 2| **`NEXT_STOP`** — when the recipient becomes the next stop| Rider, Ops exceptionally| **No.** The rider has not reached the door|
| 3| **`DOORSTEP`** — the rider has arrived| Rider, with Ops assistance| **Yes** — this is the physical attempt|

**A recipient may exhaust all three checkpoints with zero physical delivery attempts against them.** That is the ordinary unreachable-number case. The old single counter called it three failed deliveries and started a return.

**The `NEXT_STOP` and `DOORSTEP` contact reasons are seeded** (`MSC-DEC-409`, closing `OQ-142`) — `NO_ANSWER`, `NUMBER_INCORRECT`, `RECIPIENT_DECLINED` and `CONTACT_NOT_POSSIBLE_MELARC` at both, and **`RECIPIENT_NOT_AT_LOCATION` at `DOORSTEP` only**, because it is the one code that asserts physical presence at the authorised location. They are **seeded defaults in a controlled catalogue**, admitted on the same routing test as the failure reasons.

**No contact reason consumes a physical delivery attempt, including at the door.** `consumes_delivery_attempt` is `false` on all five and nothing reads it for this domain: `Order.delivery_attempts` is incremented by a **`DeliveryStop` outcome**, which reads a **Delivery Failure Reason**. **Arriving is the physical attempt; whether it is consumed is read from the failure reason when `failDeliveryStop` closes the stop** — so a `DOORSTEP` contact failure followed by a recipient who appears before expiry consumes nothing at all.

**A skipped parcel's order now has somewhere to go** (`MSC-DEC-411`, closing `OQ-143`). A `NEXT_STOP` skip leaves the order `OUT_FOR_DELIVERY` with a terminal `SKIPPED` stop, and when the parcel reaches the hub on the end-of-run parcel return **Hub Ops' confirmation moves it to `AT_HUB_AFTER_FAILURE`** — **no attempt consumed**, and the skip is not rewritten as a physical attempt. Before that route existed the parcel was **stranded**: `OUT_FOR_DELIVERY`'s three exits each require something a hub-held parcel cannot supply, and a redelivery can only be scheduled from `AT_HUB_AFTER_FAILURE`. **Where a live `VendorSuspensionHold` covers the order the rule is the opposite** — the hold decides the fulfilment state and the return moves physical custody only.

**`PRE_DISPATCH` failure holds the parcel at the hub** — it is not carried, and *assigned to a run* does not mean *cleared to leave*. **`NEXT_STOP` failure skips the stop**: the rider continues, and **the parcel stays in rider custody** until the ordinary end-of-run transfer. Nothing may record it at the hub while it is in a pannier.

**`DOORSTEP` failure waits.** A failed contact starts a **server-timed 10-minute** window; retries inside it are the same checkpoint; a recipient who appears is delivered to. Only after expiry, unrecovered, may the **physical delivery attempt** be marked failed — `DOORSTEP_WAIT_NOT_ELAPSED` refuses it early.

### 5.0.1 Redelivery, and what it costs today

`MSC-DEC-349`. A **redelivery** is a **new physical trip after a failed physical doorstep attempt**. It is not a contact retry, a next-stop call, a doorstep retry, or an Ops recovery inside the same trip.

**A redelivery is charged where it is chargeable**: **the applicable delivery fee for the new trip plus the hub's `redelivery_fee_minor`** — GH₵35 + GH₵20 = GH₵55 at Accra launch — payer **recipient**, snapshotted **when authorised Ops schedules the trip**, and **not charged at all where Melarc caused the failure**. The Return Fee remains a different charge for a different act and is **not** applied here by analogy.


**A failed physical delivery is not a Return.** The parcel goes back to the hub and **Ops owns the next disposition** — redeliver, hold, or begin formal Return, which still requires a committed `ReturnRecord`.


### 5.1 Normal path

1. **The rider selects an active reason from the Delivery Failure Reason Catalog**. The **seeded defaults** are `RECIPIENT_UNAVAILABLE`, `ACCESS_DENIED`, `RECIPIENT_REFUSED`, `PAYMENT_NOT_COMPLETED` and `OTP_NOT_VERIFIED`, and an authorised administrator may add an approved operational reason beside them. **Whether the failure consumes a physical delivery attempt is read from the reason's `consumes_delivery_attempt` metadata**, and both the code and that outcome are snapshotted onto the record. **A consumed attempt is history, not a ceiling** — there is no maximum to count against. A free-text note may accompany it and never replaces it.
2. **The stop closes `FAILED`.** The order's attempt chain extends; the order becomes `ATTEMPT_FAILED`.
3. **The parcel stays with the rider for the remainder of the run only** (§25.4).
4. **The parcel returns to its responsible hub** at the end of the run. Hub receipt restores explicit Melarc hub custody.
5. **The parcel enters the failed-attempt queue**, and **Ops decides the disposition** — hold, schedule a `Redelivery`, or commit a formal Return (§5.3).
6. **Any money already collected returns with the rider** into hub reconciliation — [cash-collection](cash-collection.md).

### 5.2 A refusal counts as an attempt, and Ops decides what follows

`RECIPIENT_REFUSED` **consumes a physical delivery attempt** and lands in the Ops decision queue. It does not end the doorstep workflow by itself, **and no count of consumed attempts ends it either**.

**The case this protects against is the wrong person answering the door.** A refusal from someone who is not the recipient, or who is not expecting this parcel, is a misunderstanding rather than a decision — and treating it as terminal converts that misunderstanding into an **earned vendor-paid return fee** (§25.5) on a parcel nobody had actually declined.

**Ops is not obliged to reattempt.** Where the refusal is unambiguous, Ops starts the return immediately. What the rule removes is the *system* making that call on the rider's word alone.

### 5.3 A failed physical attempt is an Ops decision, not a countdown

**Three is the number of contact checkpoints, not of journeys** *(Gate C C1.2, `MSC-DEC-346`)*, and **no number of journeys is fixed** *(Gate C C1.3, `MSC-DEC-350`)*.

After a qualifying failed physical `DOORSTEP` attempt the parcel **returns to the hub**, and **authorised Ops owns the next disposition**:

| Disposition||
|---|---|
| **Hold**| The parcel stays in hub custody while the exception is worked|
| **Redelivery**| A **new physical trip** with its own `PRE_DISPATCH`, `NEXT_STOP` and `DOORSTEP` checkpoints, its own commitment and — **where chargeable** — its own charge. **No maximum trip count exists** unless future Product authority sets one. **HIGH-13 audit remediation, corrected on review:** two Ops users racing to schedule against the same failed stop cannot both succeed — scheduling drives `AT_HUB_AFTER_FAILURE → READY_FOR_REATTEMPT` ([state-machines.md](../../contracts/state-machines.md) §9), a transition available only from `AT_HUB_AFTER_FAILURE`, so the loser of the race finds the state already moved and gets `STATE_CONFLICT`. **It is a state guard, not a one-per-stop rule**: §20.5 allows cancelling a trip that never departed and sets no maximum trip count, so a later redelivery legitimately answers the same failed stop.|
| **Formal Return**| Begins only when authorised Ops **commits a `ReturnRecord`**. §25.5 then reverses the original delivery fee and earns the flat vendor-paid return fee. Return-to-vendor is `SLICE-006`, which is also where any partial cash already collected against the parcel (§5.4, below) gets its financial resolution — `OQ-004` (CRIT-07 audit remediation)|


### 5.4 Exception paths

| Condition| Behaviour| Code|
|---|---|---|
| No reason supplied| Refused| `REASON_REQUIRED`|
| A reason that is **inactive, unknown or of the wrong checkpoint**| Refused. **Not because the list is closed** — it is a controlled catalogue with five seeded defaults — but because the code must be a live one valid at this checkpoint| `REASON_NOT_ACTIVE`, `REASON_NOT_VALID_FOR_CHECKPOINT`|
| **A further physical trip**| **Permitted.** Ops schedules a Redelivery; **there is no fourth-attempt rejection**.| —|
| Stop not assigned to this rider| Refused| `NOT_ASSIGNED_RIDER`|
| Run closed with a failed stop's parcel not returned| Refused| `CUSTODY_NOT_RETURNED`|
| Money collected before the failure| **Held, not refunded at the door**. Travels to hub reconciliation ([cash-collection.md](cash-collection.md) §5.3). **If the parcel is later formally returned rather than redelivered, that money's fate is `OQ-004`'s to decide, not this feature's** (CRIT-07 audit remediation)| —|

### 5.5 What this feature must never do

- **Never let a rider keep a parcel overnight** (§25.4). This is stated as an absolute and `CUSTODY_NOT_RETURNED` exists to enforce it.
- **Never refund at the door.** `MSC-DEC-229`: asking a rider to reverse a mobile-money transaction standing at a stranger's door is not a control.

- **Never infer what the rider is holding from the stop's state.** A `FAILED` delivery stop and a `FAILED` pickup stop are identical in their machines and different in fact — consult the payment record ([state-machines.md](../../contracts/state-machines.md) §12.1.1).

- **Never let a checkpoint failure consume a physical attempt.** `PRE_DISPATCH` and `NEXT_STOP` outcomes are contact facts; **only a qualifying `DOORSTEP` failure is a physical trip**.

### 5.0.2 The redelivery commercial rule — *Gate C C1.3*

`MSC-DEC-350`. **The charge exists, and it is created by one act.**

|| Charge| Accra example|
|---|---|---|
| **A**| The **applicable delivery fee for the new trip**, from the ordinary pricing rules| **GH₵35**|
| **B**| The **hub's redelivery fee**, `redelivery_fee_minor`| **GH₵20**|
|| **Recipient total due**| **GH₵55**|

**The payer is the recipient**, always, and ordinary Ops cannot change it. **Both figures are snapshotted when Ops schedules the trip** — a later change to the hub setting never reprices a redelivery already scheduled.

**Nothing before Ops scheduling creates a charge.** Not a failed `PRE_DISPATCH` call, not a failed `NEXT_STOP` call, not the doorstep timer starting, not retries inside the doorstep window, and not the physical failure itself. **A failed physical attempt creates eligibility**; a parcel can sit at the hub eligible and unscheduled owing nothing. **The charge exists because Melarc is about to send a rider out again.**

**It does not apply where Melarc caused the failure.** Where the originating reason attributes the failure to Melarc — a rider breakdown, a provider outage, an OTP failure that was not the recipient's doing — **`chargeable` is false and both fees are zero**. **Recipient is the payer *when a chargeable obligation exists***: two rules, and collapsing them bills a customer for Melarc's own outage.

**The original trip's fee is untouched** — not refunded, reversed or relabelled. Two events, two records.

**A redelivery runs the same three checkpoints**, beginning with its own `PRE_DISPATCH`. It is a delivery cycle, **not attempts four, five and six**. **No maximum redelivery count exists**; each further trip needs its own Ops approval.

**Redelivery is not Return.** `redelivery_fee_minor` and `flat_return_fee_amount` are **separate settings for separate acts**. Both launch at GH₵20 in Accra, and **that is a coincidence of value** — the surest way to merge two rules is to notice they currently agree.

## 6. Entities — *pointer*

[domain-model.md](../../contracts/domain-model.md) §6.10 `DeliveryStop`, §6.7 `Order`, §6.11 `RiderCashCustody`.

## 7. States — *pointer*

| Field| Home| Transitions this feature drives|
|---|---|---|
| `DeliveryStop.state`| [state-machines.md](../../contracts/state-machines.md) §12.1| `ARRIVED → AWAITING_RECIPIENT`, `AWAITING_RECIPIENT → ARRIVED`, `AWAITING_RECIPIENT → FAILED`, `ARRIVED → FAILED`, `PENDING → SKIPPED`|
| `Order.fulfilment_state`| [state-machines.md](../../contracts/state-machines.md) §9| `→ ATTEMPT_FAILED`, `→ AT_HUB_AFTER_FAILURE`, `→ READY_FOR_REATTEMPT` on a scheduled `Redelivery`|
| `Redelivery.status`| [state-machines.md](../../contracts/state-machines.md) §20.5| `→ SCHEDULED`, `SCHEDULED → CANCELLED`|

## 8. Permissions — *pointer*

[permissions.md](../../contracts/permissions.md) §7. **`delivery.stop.close`** — R only, assigned stop; **`settings.reason.read`** — R only, assigned stop or run; **`delivery.otp.override`** — S P, own hub; **`dispatch.run.create`** — Ops.

## 9. Settings — *pointer*

[settings.md](../../contracts/settings.md). **The failure reasons are controlled catalogue entries with five seeded defaults**, administered under `settings.reason.manage` — **not freely editable by ordinary Ops**, because a reason drives routing and attempt consumption.

## 10. Errors — *pointer*

[errors-and-enums.md](../../contracts/errors-and-enums.md) §5.5. All codes above exist.

## 11. Audit events — *pointer*

[audit.md](../../contracts/audit.md) §5.3. §25.3 requires *"attempt number, outcome, reason, rider, run, timestamps, contact attempts, and hub custody effects"* to remain auditable — eight facts, and the existing `delivery` events carry the first six.

## 12. API operations — *pointer*

[openapi.yaml](../../contracts/openapi.yaml). **The doorstep operations exist**, re-derived at Gate C C1.8:

| Act| Operation| Permission|
|---|---|---|
| Record the failure| `failDeliveryStop`| `delivery.stop.close` — **R only**, assigned stop|
| Read the active reason catalogue| `listReasonDefinitions`| **`settings.reason.read`** — rider-holdable|
| Start the doorstep wait| `recordDoorstepContact`| `delivery.stop.execute`|
| Request the OTP fallback| `requestVerificationFallback`| `delivery.stop.execute`|
| Grant it| `authoriseDeliveryWithoutOtp`| `delivery.otp.override` — **S P**|
| Schedule a redelivery| `scheduleRedelivery`| `dispatch.run.create`|
| Read prior trips| `listRedeliveries`| `delivery.read`|


## 13. Acceptance criteria

*Fourteen criteria were moved into this section on 14 September 2026*. `AC-SLICE-003-22` to `-35` had been written **between §5.0.2 and §6**, outside the section that owns them — so a reader consulting §13 for this feature found **five of its nineteen**, and an audit deriving criteria from §13 concluded fourteen did not exist. **Every criterion is moved verbatim**: no text, identifier, governing section, surface, actor or test level changes, and the feature has owned nineteen throughout.

### `AC-SLICE-003-08` — A failed attempt without a reason is refused

```text
Given an ARRIVED delivery stop,
When the rider closes it FAILED with no reason supplied,
Then the transition is refused with REASON_REQUIRED,
And the stop remains ARRIVED.
```

**Governs:** §25.3 · **Surface:** Melarc Rider · **Test level:** integration

### `AC-SLICE-003-09` — A further trip is a redelivery, and no attempt ceiling refuses it

```text
Given an order with three recorded unsuccessful physical delivery attempts,
When authorised Ops schedules a further trip,
Then the trip is accepted and recorded as a Redelivery with the next sequence number,
And no DELIVERY_ATTEMPT_LIMIT_REACHED or maximum-attempt rule refuses it,
And return-to-vendor remains a separate deliberate Ops decision, not an automatic outcome.
```

**Governs:** §25.3 *(superseded in part by `MSC-DEC-350`)* · **Surface:** Melarc Ops · **Test level:** integration


### `AC-SLICE-003-10` — A run cannot close with an undelivered parcel unreturned

```text
Given a completed run carrying one FAILED stop's parcel,
When the rider submits the hub handover without that parcel,
Then the handover is refused with CUSTODY_NOT_RETURNED,
And the run remains IN_PROGRESS.
```

**Governs:** §25.4 · **Surface:** Melarc Rider · **Test level:** integration

### `AC-SLICE-003-11` — A redelivery creates the approved charge, and a Melarc-caused one does not

```text
Given an order whose first physical delivery attempt failed for a chargeable recipient-side reason,
When authorised Ops schedules a redelivery,
Then a RedeliveryRecord is created with the applicable new delivery fee and the hub's redelivery fee snapshotted,
And chargeable is true and the payer is the recipient,
And the original trip's fee is unchanged, neither reversed nor relabelled,
And where the originating reason attributes the failure to Melarc, both fee fields are zero and chargeable is false.
```

**Governs:** §25.3 *(superseded in part by `MSC-DEC-350`)* · **Surface:** Melarc Ops · **Test level:** integration


### `AC-SLICE-003-12` — Stop state does not reveal custody of money

```text
Given one FAILED delivery stop with payment_taken true
  and one FAILED delivery stop with payment_taken false,
When each stop is read,
Then the two states are identical,
And only the payment record distinguishes what the rider is carrying.
```

**Governs:** [state-machines.md](../../contracts/state-machines.md) §12.1.1, `MSC-DEC-229` · **Surface:** backend · **Test level:** unit

### `AC-SLICE-003-22` — Ops completes pre-dispatch confirmation and the rider does not repeat it

```text
Given an order awaiting PRE_DISPATCH confirmation and an Ops user with dispatch.recipient_confirmation.work,
When Ops records a successful recipient contact,
Then a RecipientContactAttempt is written with checkpoint PRE_DISPATCH and actor type OPS,
And the parcel becomes CLEARED_FOR_DISPATCH,
And the assigned rider's app shows the confirmation as already completed,
And the rider is not prompted to call the same recipient again.
```

### `AC-SLICE-003-23` — A failed pre-dispatch checkpoint keeps the parcel at the hub

```text
Given an order whose PRE_DISPATCH contact failed with UNREACHABLE,
When a delivery run containing that order is finalised for physical departure,
Then the parcel is HOLD_AT_HUB and is not included in the physical load,
And DISPATCH_NOT_CLEARED is returned if it is submitted anyway,
And the Vendor has been notified with the recipient name and order reference,
And Order.delivery_attempts is unchanged, because no rider travelled.
```

### `AC-SLICE-003-24` — A next-stop contact failure skips the stop and consumes no attempt

```text
Given a rider on an IN_PROGRESS run whose next stop's recipient cannot be reached,
When the rider records the NEXT_STOP contact failure,
Then the stop becomes SKIPPED and the rider continues the route,
And the parcel remains in RIDER custody and is not recorded at the hub,
And Order.delivery_attempts is unchanged,
And no redelivery charge is created,
And the Vendor is notified with the recipient name, order reference and reason.
```

### `AC-SLICE-003-25` — A doorstep contact failure starts a server-timed wait

```text
Given a rider who has ARRIVED at a stop and cannot reach the recipient,
When the rider records the DOORSTEP contact failure,
Then the stop becomes AWAITING_RECIPIENT,
And the server sets wait_started_at and derives wait_expires_at from doorstep_wait_minutes,
And no field in the request supplied either value,
And Ops is alerted and sees the same countdown,
And a retried submission does not start a second timer or send a second Vendor notification.
```

### `AC-SLICE-003-26` — A physical delivery attempt cannot fail before the wait expires

```text
Given a stop in AWAITING_RECIPIENT whose wait_expires_at is in the future,
When the rider attempts to mark the physical delivery attempt failed for ordinary no-contact,
Then DOORSTEP_WAIT_NOT_ELAPSED is returned and the stop does not fail,
And a client-supplied claim that ten minutes elapsed does not change the outcome,
And a qualifying reason such as an in-person refusal may still terminate immediately.
```

### `AC-SLICE-003-27` — A recipient who appears during the countdown is delivered to

```text
Given a stop in AWAITING_RECIPIENT and a recipient who becomes available before expiry,
When the rider records a successful DOORSTEP contact,
Then the stop returns to ARRIVED and the delivery continues into payment and verification,
And no failure is recorded,
And Order.delivery_attempts is unchanged,
And no redelivery arises.
```

### `AC-SLICE-003-28` — Ops authorises the OTP fallback and a rider cannot self-bypass

```text
Given a recipient physically present at the door and an OTP that cannot be completed,
When the rider requests the verification fallback,
Then the request is recorded whether or not it is granted,
And a rider-submitted attempt to close the stop DELIVERED without OTP is rejected,
And only an actor holding delivery.otp.override may authorise the handover,
And recipient payment is still settled before the parcel is handed over.
```

### `AC-SLICE-003-29` — A rider records a reschedule or location change and Ops decides it

```text
Given a recipient who asks for a different date or a different delivery location,
When the rider records the request,
Then the request is queued for Ops and the authoritative commitment and destination are unchanged,
And an approved reschedule is written as a new DeliveryCommitment with attribution CUSTOMER,
And an approved location change preserves the original destination alongside the authorised one,
And no rider-held permission can apply either change.
```

### `AC-SLICE-003-30` — `PRE_DISPATCH` has no call ceiling

```text
Given an order whose recipient has not been reached after three pre-dispatch calls,
When an Ops user or the assigned rider attempts a fourth contact,
Then the attempt is accepted and recorded,
And no force-extension or Senior Ops approval was required,
And no Return process was started by the call count alone,
And the parcel remains HOLD_AT_HUB until a recipient is reached or Ops decides otherwise.
```

### `AC-SLICE-003-31` — A Vendor correction permits a retry before departure

```text
Given an order held at hub after an INCORRECT_NUMBER pre-dispatch outcome,
When the Vendor submits a corrected contact and Ops applies it,
Then a further PRE_DISPATCH contact may be recorded against the corrected number,
And a successful contact clears the parcel for dispatch,
And the parcel may still join the run subject to operational feasibility.
```

### `AC-SLICE-003-32` — A later approved trip is a redelivery and creates the charge then

```text
Given a DeliveryStop that failed as a qualifying physical delivery attempt,
When authorised Ops schedules a redelivery,
Then a Redelivery record is created with sequence 1,
And applicable_delivery_fee_minor and redelivery_fee_minor are snapshotted at that moment,
And payer is RECIPIENT and cannot be set by the request,
And total_due_minor is the sum of the two,
And a later change to the hub's redelivery_fee_minor does not alter this record,
And a retried scheduling request creates no second record, commitment, fee or notification.
```

### `AC-SLICE-003-33` — A Melarc-caused failure creates no recipient charge

```text
Given a physical delivery attempt that failed for a rider breakdown,
When authorised Ops schedules a redelivery,
Then chargeable is false,
And applicable_delivery_fee_minor and redelivery_fee_minor are both 0,
And the recipient is notified of the new trip without an amount due,
And the same holds for a platform, payment-provider or OTP failure not caused by the recipient.
```

### `AC-SLICE-003-34` — No charge arises from a contact failure

```text
Given an order whose PRE_DISPATCH or NEXT_STOP contact failed,
When the parcel is held at hub or the stop is skipped,
Then no Redelivery record exists,
And no delivery fee or redelivery fee is created,
And Order.delivery_attempts is unchanged,
And scheduling a redelivery against that stop returns STOP_NOT_QUALIFYING.
```

### `AC-SLICE-003-35` — There is no fourth-attempt rejection rule

```text
Given an order with two prior failed physical delivery attempts and two completed redeliveries,
When authorised Ops schedules a third redelivery,
Then the request is accepted,
And no maximum-attempt or maximum-redelivery rule rejects it,
And the trip runs its own PRE_DISPATCH, NEXT_STOP and DOORSTEP checkpoints,
And a reason outside the five seeded defaults is selectable if active in the catalogue.
```

### `AC-SLICE-003-44` — A declared return moves no custody and no order

```text
Given a run with two ATTEMPT_FAILED orders still aboard,
When the rider opens a parcel custody return naming both,
Then the return is DECLARED and confirmed_at is null,
And both orders are still ATTEMPT_FAILED,
And the rider's own view reads waiting for the hub, never returned.
```

**Governs:** §35.8.7, §36.9, `MSC-DEC-408`, state-machines.md 12.2 · **Surface:** Melarc Rider, backend · **Test level:** integration

### `AC-SLICE-003-45` — Custody transfers when the hub confirms, and the hub is not the rider

```text
Given a DECLARED return naming two ATTEMPT_FAILED orders,
When Hub Ops confirms receipt of both,
Then the return is RECEIVED with received_by_staff_id set to that officer and confirmed_at set,
And confirmed_at is the instant at which each received line's custody transferred,
And both orders are AT_HUB_AFTER_FAILURE,
And the same rider attempting to confirm their own return is refused with PERMISSION_DENIED,
And no rider bundle holds fleet.custody.receive at any scope.
```

**Governs:** §36.9, `MSC-DEC-408`, permissions.md §7 · **Surface:** Melarc Ops, backend · **Test level:** integration · **Expected code on rejection:** `PERMISSION_DENIED`

### `AC-SLICE-003-46` — A variance transfers the lines actually received and no others

```text
Given a DECLARED return naming three ATTEMPT_FAILED orders A, B and C,
When Hub Ops confirms receipt of A and B only, with a reason,
Then the return is VARIANCE_OPEN,
And A and B are RECEIVED and both orders are AT_HUB_AFTER_FAILURE,
And C is MISSING and its order is still ATTEMPT_FAILED,
And a confirmation whose received set differs from the declared set without a reason is refused
  with REASON_REQUIRED.
```

**Governs:** `MSC-DEC-408`, `MSC-DEC-321` · **Surface:** Melarc Ops, backend · **Test level:** integration · **Expected code on rejection:** `REASON_REQUIRED`

### `AC-SLICE-003-47` — A resolution records what was decided, not only why

```text
Given a VARIANCE_OPEN return with C MISSING,
When Senior Ops resolves C with disposition RECEIVED_LATE and a reason,
Then C is RESOLVED carrying that disposition, and C's order is AT_HUB_AFTER_FAILURE,
And where the disposition is CONFIRMED_NOT_RECEIVED instead, C is RESOLVED and its order state
  does not move,
And a resolution submitted with a reason and no disposition is refused with VALIDATION_FAILED,
And an actor holding fleet.custody.receive but not the senior key is refused with
  INSUFFICIENT_AUTHORITY.
```

**Governs:** `MSC-DEC-408`, state-machines.md 12.2 · **Surface:** Melarc Ops, backend · **Test level:** integration · **Expected code on rejection:** `INSUFFICIENT_AUTHORITY`

### `AC-SLICE-003-48` — A rider hands back what they carried, the hub may add to it, and an unconfirmed return stays visible

```text
Given an order with no stop on this rider's run,
When the rider names it on a parcel custody return for that run,
Then the response is 422 ORDER_NOT_ON_RUN,
And given a DECLARED return for that run,
When Hub Ops confirms receipt and names an order belonging to a different run,
Then that confirmation is refused with ORDER_NOT_ON_RUN and no line is created for it,
And where the unnamed order does carry a non-DELIVERED stop on this run, it is accepted and
  recorded as an UNDECLARED line,
And given a return left DECLARED overnight,
When Hub Ops lists returns filtered to DECLARED,
Then that return appears, because no rider overnight hold exists.
```

**Governs:** §34.9, §36.9, `MSC-DEC-408` · **Surface:** Melarc Rider, Melarc Ops, backend · **Test level:** integration · **Expected code on rejection:** `ORDER_NOT_ON_RUN`

### `AC-SLICE-003-49` — A doorstep contact failure is not yet a consumed attempt

```text
Given a rider arrived at the authorised location with the recipient not answering,
When the DOORSTEP contact is recorded UNSUCCESSFUL with RECIPIENT_NOT_AT_LOCATION,
Then the server-timed wait starts and Order.delivery_attempts is unchanged,
And recording the same reason at NEXT_STOP is refused with REASON_NOT_VALID_FOR_CHECKPOINT,
And where the recipient appears before wait_expires_at the delivery completes with no attempt
  consumed and no Vendor notice raised by the contact reason,
And where the wait expires unrecovered, failDeliveryStop consumes the attempt only if the
  selected Delivery Failure Reason says so.
```

**Governs:** `MSC-DEC-409`, `MSC-DEC-346`, `MSC-DEC-349` · **Surface:** Melarc Rider, backend · **Test level:** integration · **Expected code on rejection:** `REASON_NOT_VALID_FOR_CHECKPOINT`

### `AC-SLICE-003-50` — A skipped parcel comes home to somewhere

```text
Given a stop SKIPPED at NEXT_STOP with its order still OUT_FOR_DELIVERY,
When Hub Ops confirms receipt of that order on the parcel custody return,
Then the order is AT_HUB_AFTER_FAILURE and Order.delivery_attempts is unchanged,
And the stop is still SKIPPED and is not recorded as a physical attempt,
And scheduling a redelivery against it is accepted,
And given the same order covered by a live VendorSuspensionHold,
Then confirmation moves physical custody only and the fulfilment state is left to the hold,
And an order already RETURN_TO_VENDOR_IN_PROGRESS is still RETURN_TO_VENDOR_IN_PROGRESS.
```

**Governs:** `MSC-DEC-411`, `MSC-DEC-346`, state-machines.md §9, `state-machines.md` §12.2 · **Surface:** Melarc Ops, backend · **Test level:** integration

## 14. Open questions blocking this feature

| ID| What it blocks here| Type|
|---|---|---|
| ~~`OQ-003`~~| **Closed 26 August by `MSC-DEC-252`** — refusal consumes an attempt and routes to Ops| —|
| ~~`OQ-093`~~| **Closed 26 August by `MSC-DEC-252`**, and **refined 30 August by `MSC-DEC-343`**: the reasons are a **controlled extensible catalogue with five seeded defaults**, not a closed set. Metadata drives attribution, checkpoint validity, attempt consumption, Vendor notification and chargeability| —|
| ~~`OQ-027`~~| **No longer bears on this feature — `MSC-DEC-415`, 26 September 2026.** Recording a failed attempt is **online-only in Version 1**; the screen shows a no-connectivity state rather than queuing the act. `OQ-027` narrows to the design of the queued hub handover, which is not this feature's.| —|
| `OQ-004`| **CRIT-07 audit remediation.** §5.4's *"money collected before the failure"* row preserves it as custody, but this feature does not decide its fate if the parcel is later formally returned rather than redelivered — that is `SLICE-006`'s `ReturnRecord`| `DECISION_NEEDED`|

## 15. What this feature still owes its slice

- **`delivery.stop.close` is written**, and `failDeliveryStop` records the attempt against **an active catalogue reason**. ~~`delivery` sits in §7.1 as read-only~~ — **incorrect; it never did.** `delivery.handoff.perform` predates this work.
- ~~`OQ-093`'s reason categories are unset~~ — **closed 26 August**; `AC-SLICE-003-08` can now test that a *valid* reason was given. Superseded note: — and **§25.7 names the "failure-reason catalogue" as a preserved follow-up in terms**, which is a more direct citation than the §36.9 line this feature was first written against., so `AC-SLICE-003-08` can test that *a* reason is required and not that a *valid* one was given — the same half-testable state `pickup-failure` was in before §21.5 was read.
- ~~`OQ-003` blocks the two most common failure causes~~ — **closed 26 August**. **`SLICE-003` was `READY`** from 4 September 2026 until 21 September, when `Order` fulfilment §9 was amended past its signature; the closure recorded here is unaffected: `MSC-DEC-366` signed the eleven Gate C actions, and `OQ-109` — still open — is an **external implementation dependency**, not a readiness blocker.

## 16. Build status — *honest, per surface, re-derived at Gate C C1.8*

| Surface| Status|
|---|---|
| Melarc Rider| **Specified and buildable.** `failDeliveryStop` exists at `delivery.stop.close`, R only on an assigned stop; the reason list comes from `listReasonDefinitions` under **`settings.reason.read`**, a rider-holdable key; `consumes_delivery_attempt` is shown **before** submitting. **Screens are not built** — that is `OQ-030`. The machine behind the stop, `DeliveryStop` §12.1, is **re-signed by `MSC-DEC-366` on 4 September 2026** and **owes no further signature**.|
| Melarc Ops| **Specified and buildable.** The failed-attempt and hub-return queues, the redelivery decision (`scheduleRedelivery`) and the OTP fallback all have operations and keys. **No signature is outstanding**: `DeliveryStop` §12.1, `Order` fulfilment §9 and `Redelivery` §20.5 are all signed by `MSC-DEC-366`.|
| Melarc Vendor| **Specified and buildable** — outcome, redelivery and account effects on its own order, read-only|
| System| **Specified.** Reason metadata drives attribution, checkpoint validity, attempt consumption, Vendor notification and chargeability|

**What is genuinely outstanding, stated precisely:**

| Outstanding| Nature|
|---|---|
| ~~**Product Owner signatures** on the machines this feature drives — `DeliveryStop` §12.1, `Order` fulfilment §9, `Redelivery` §20.5~~ — **given 4 September 2026 by `MSC-DEC-366`; nothing is outstanding here**| Was signature, not specification|
| **Surface build** — rider screens and Ops queues| `OQ-030`, and unbuilt is not unspecified|
| ~~**`OQ-027`** — whether recording a failed attempt is offline-capable~~| **Decided 26 September 2026 by `MSC-DEC-415`: online-only in Version 1.**|

**Nothing here waits on `OQ-109`.** The Hubtel merchant contract blocks the **provider adapter**, and a delivery failure records a reason, moves custody and routes to Ops **without touching a payment provider**.

## 17. Related

[doorstep-delivery](doorstep-delivery.md) · [cash-collection](cash-collection.md) · [pickup-failure](../pickup/pickup-failure.md) — the same shape with its categories fixed · [SLICE-003](../../delivery/slices/SLICE-003.md)
