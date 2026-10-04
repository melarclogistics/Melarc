# Hub daily operating cycle

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.24 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** the canonical rhythm of one Melarc operating day — what is reviewed at start of day, what each period must produce, and what must be true before the day closes
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §21.1, §22, §24, §25, §26.3, §26.5, and `MSC-DEC-301`–`MSC-DEC-339`
> **Slice:** cross-slice

## 1. What this is, and why

**A day is not a sequence of features.** Every act below is already specified elsewhere and this document restates none of them. What it owns is the **order, the gates and the closing conditions** — the part a developer building any one feature cannot see from inside it.

**It exists because the failure modes are all cross-period.** A rider still holding cash at 18:30 is not a doorstep-delivery defect. A parcel that missed its committed date because nobody reviewed the confirmation queue at 09:00 is not a dispatch defect. Both are day-shaped, and nothing in the repository was day-shaped.

## 2. Governing sections

| Period| Governed by|
|---|---|
| Start of day| §34.10 fleet, §30 staff, §26.3 outstanding cash|
| Booking cutoff| §21.1, `MSC-DEC-147`–`149`, `MSC-DEC-255` grace window|
| Pickup and intake| §21.3, §21.4, §22, §23|
| Dispatch preparation| §24.2, §24.5, §35.8.2|
| End of day| §26.3, §26.5, §25.3, §28|

## 3. Surfaces and actors

**Ops Portal**, hub Ops Staff and Senior Ops throughout. **Rider Android** during pickup, dispatch and return. **Vendor PWA** and the official WhatsApp channel at booking only.

## 4. Preconditions

The hub is open, its settings are configured — `booking_cutoff_time`, the four service-window keys, `cash_reconciliation_cutoff_time` — and at least one rider and one serviceable motorcycle exist.

## 5. Behaviour

### 5.0 Before the run departs — the pre-dispatch confirmation queue

`MSC-DEC-346`, `MSC-DEC-347`. **Recipient confirmation is worked before departure, not after.**

| Step||
|---|---|
| 1| Ops works the **pre-dispatch confirmation queue** for every order planned onto today's runs|
| 2| Where the assigned rider is available, **either may make the call** — the same canonical record either way|
| 3| Each order resolves to **`CLEARED_FOR_DISPATCH`** or **`HOLD_AT_HUB`**|
| 4| Vendors are notified of exceptions needing their help, **with the recipient's name**|
| 5| Run finalisation includes **only cleared parcels**; held parcels and unresolved exceptions stay at the hub|

**Assigned to a run is not permitted to leave the hub**. A held parcel must be **visibly held** and never merely absent from a list — a parcel that quietly falls out of a load is one nobody chases.

**A queue worked to empty is a run that can depart.** Treating recipient confirmation as something that begins after the rider leaves is how a morning gets spent delivering to people who were never going to be there.


### 5.1 Start of day

**Everything here is a review, and every item can block the day.**

| Reviewed| Why it blocks|
|---|---|
| Rider availability| A run with no rider is a booking Melarc cannot serve|
| Motorcycle availability, compliance and maintenance blocks| §34.10's warning lead times exist so this is never a surprise|
| **Unresolved previous-day cash**| `MSC-DEC-324`. Cash open past yesterday's cutoff is an exception carried into today, and it does not age out|
| Parcels held at the hub| Custody that nobody has scheduled|
| Failed deliveries awaiting Ops review| `MSC-DEC-311` — the rider does not reschedule, so this queue *is* the reattempt mechanism|
| Returns awaiting formal initiation| `MSC-DEC-332` — a return has not started until Ops starts it|
| Recipient confirmations outstanding| §24.2. A parcel cannot dispatch without one|
| Corridor work| `MSC-DEC-304`. A corridor service day is not tomorrow by default|
| Platform and provider incidents| `MSC-DEC-328`. An outage decides whether cash fallback is even reachable today|

### 5.2 Booking cutoff period

Normal cutoff at `booking_cutoff_time`; a settled vendor may book until the `vendor_credit_grace_window_minutes` extension. **Late bookings route to review rather than being silently accepted or silently refused.** Pickup planning finalises against the resulting set.

**Both channels enforce the same cutoff**. A WhatsApp booking taken at 10:40 is late in exactly the way a PWA booking taken at 10:40 is late.

### 5.3 Pickup and intake period

Pickups executed within `pickup_service_window_start`–`pickup_service_window_end`, or under a recorded override. **Custody starts the delivery promise** — not hub arrival, not intake, not itemization.

Then hub intake, itemization, and pricing/payment readiness.

### 5.4 Dispatch preparation

Recipient confirmation, payer and payment gates, run assignment and dispatch. **Confirmation attempts are not delivery attempts**: a recipient may exhaust all three confirmation contacts here and still have zero physical attempts.

### 5.5 End of day

**A day closes when all of this is true, not when the last rider returns.**

| Closing condition| Source|
|---|---|
| Every rider accounted for| §26.3|
| Every undelivered parcel accounted for — returned, held or transferred| `MSC-DEC-325` custody dimension|
| Cash obligations reconciled, **or an exception explicitly open**| `MSC-DEC-321`, `MSC-DEC-324`|
| Hub cash reconciled against a physical count| `MSC-DEC-322`|
| Cash disposition recorded where cash left the hub| `MSC-DEC-323`|
| Missed service commitments surfaced| `MSC-DEC-307`. A miss that nobody looks at is a miss nobody learns from. **Detected automatically** by `sweep_missed_commitments` ([BACKGROUND_JOBS_AND_EVENTS.md](../../architecture/BACKGROUND_JOBS_AND_EVENTS.md) §3.5, MED-04 audit remediation), which emits `delivery.commitment.breached` — the review reads that event, not a live query with undefined detection logic|
| Failed deliveries queued for Ops review| `MSC-DEC-311`|
| Return reviews queued| `MSC-DEC-332`|
| Unresolved incidents visible| —|

### 5.6 What this feature must never do

- **Never close a day by declaring it closed.** `MSC-DEC-325` gives run closure three dimensions and the day inherits them: route execution complete is the least important of the three.
- **Never treat 18:00 as an accusation.** `MSC-DEC-324`: a legitimately active run may still be out, and a system that flags that rider as short produces an alert operators learn to ignore.
- **Never let the end-of-day list become a dashboard nobody owns.** Each row has an owner in [exception-ownership-matrix.md](exception-ownership-matrix.md).

## 6. Entities — *pointer*

[domain-model.md](../../contracts/domain-model.md) §6.11, §6.12 — `RiderCashCustody`, `CashHandover`, `HubCashReconciliation`, `CashDisposition`, `RoadExpense`, `DeliveryCommitment`.

## 7. States — *pointer*

[state-machines.md](../../contracts/state-machines.md) §16, §20. **§20's machines are signed** — `RoadExpense` §20.1, `HubCashReconciliation` §20.2 and `CashDisposition` §20.3 by `MSC-DEC-366` on 4 September 2026, together with `Redelivery` §20.5 and `PaymentAttempt` §20.6, which joined the section later.

## 8. Permissions — *pointer*

[permissions.md](../../contracts/permissions.md) §7 — `payment.cash.confirm`, `payment.cash.reconcile_hub`, `payment.variance.resolve`, `payment.cash.disposition`, `pickup.request.override_window`.

## 9. Settings — *pointer*

[settings.md](../../contracts/settings.md) §7.3 — `booking_cutoff_time`, the four service-window keys, `cash_reconciliation_cutoff_time`, `recipient_cash_enabled`.

## 10. Errors — *pointer*

[errors-and-enums.md](../../contracts/errors-and-enums.md) §5 — `CASH_HANDOVER_VARIANCE`, `SERVICE_WINDOW_OVERRIDE_REASON_REQUIRED`.

## 11. Audit events — *pointer*

[audit.md](../../contracts/audit.md) §5.7, §5.8 — `payment.cash.hub_reconciled`, `payment.cash.disposition_recorded`, `pickup.service_window.overridden`.

## 12. API operations — *pointer*

[openapi.yaml](../../contracts/openapi.yaml) — `getRunCashSummary`, `recordHubCashCount`, `resolveHubCashVariance`, `recordCashDisposition`, `overrideServiceWindow`.

## 13. Acceptance criteria

### `AC-OPS-01` — a day cannot close with unreconciled cash and no exception

**Given** a hub whose `HubCashReconciliation` is `VARIANCE_OPEN`
**When** end-of-day closure is attempted
**Then** closure is refused unless the variance is dispositioned under `payment.variance.resolve`, and the expected total is unchanged. *Integration.*

### `AC-OPS-02` — 18:00 does not manufacture a shortage

**Given** a rider on a legitimately active run at 18:30 holding collected cash
**When** the cutoff passes
**Then** the cash appears as an **open exception with visibility**, and the rider is **not** classified as short. *Integration.*

### `AC-OPS-03` — start of day surfaces yesterday's open cash

**Given** cash left unreconciled at yesterday's close
**When** the hub opens
**Then** it appears in the start-of-day review, and it does not age out. *Integration.*

### `AC-OPS-04` — a missed commitment is surfaced, not absorbed

**Given** an order whose committed date passed undelivered
**When** `sweep_missed_commitments` runs at end of day
**Then** `delivery.commitment.breached` is emitted exactly once for that commitment, and the miss is surfaced with its original commitment and attribution intact. *Integration.*

## 14. Open questions blocking this feature

None blocking. `OQ-028`'s legal retention sits outside the daily cycle; **`OQ-067`'s rate-limit values were supplied on 5 September** and it is closed.

## 15. What this feature still owes its slice

**A surface inventory.** No Ops Portal screen is specified for the start-of-day or end-of-day review, which is `OQ-030`'s scope. Until it exists the cycle is governance a developer can build to and not a screen anyone can open. **This is distinct from the dated report** — [daily-operations-and-cash-report.md](../reporting/daily-operations-and-cash-report.md) (Accounting, Finance & Reporting Pass 1) now renders this cycle's own closing conditions (§5.5) as a hub-day projection, but a rendered API response is not a screen: `OQ-030` still owns the live Ops Portal page this cycle's own review needs, unchanged by that report existing.

## 16. Build status — *honest, per surface*

| Surface| Status|
|---|---|
| Ops Portal| **Not buildable as a screen** — no page inventory|
| Rider Android| Its acts are specified; the day-level view is Ops-only|
| Vendor PWA| Booking only|

## 17. Related

- [exception-ownership-matrix.md](exception-ownership-matrix.md) — who owns each exception this cycle surfaces
- [daily-operations-and-cash-report.md](../reporting/daily-operations-and-cash-report.md) — the dated, hub-scoped read projection over this cycle's own closing conditions (Accounting, Finance & Reporting Pass 1)
- [SOLUTION_ARCHITECTURE.md](../../architecture/SOLUTION_ARCHITECTURE.md)
