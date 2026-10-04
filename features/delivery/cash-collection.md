# Recipient cash collection and custody

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.17 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** the money a rider takes at the door — collecting it, carrying it, handing it to the hub, and the three-figure comparison that closes it
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §26.2, §26.3, §26.5, §36.11, and cross-cutting §35.8, §16, §40
> **Slice:** `SLICE-003` collection · `SLICE-004` reconciliation

## 1. What this is, and why

The recipient pays by default (§5.2). This feature is what happens to that money between the door and the hub's books.

**Two obligations of different lifetimes sit on one amount**, and §36.11 states both in one sentence: *"Recipient cash satisfies the gate only after the rider records collection, but the run/workday remains financially open until hub reconciliation or an exception."* Collection unblocks the **delivery**. It closes nothing **financial**. Treating the first as the second is the plausible mistake, and it is how cash goes missing without anything looking wrong.

### The cash chain, complete — Gate C and Gate C R1

**This section replaces the position this feature held until 29 August**, which was that money could be taken and not closed. It could not, and it can now.

| Stage| Record| Authority|
|---|---|---|
| Recipient hands over cash at the door| A `CASH` `PaymentReceipt` at the amount taken **and** `RiderCashCustody` → `COLLECTED_BY_RIDER`, linked| `payment.cash.collect` — **R only**|
| Rider declares at the hub| `CashHandover` → `OPEN`| `payment.cash.handover` — **R only**|
| Hub accepts| `CashHandover` → `CONFIRMED`| `payment.cash.confirm` — **never a rider**|
| Hub reconciles its day| `HubCashReconciliation`| `payment.cash.reconcile_hub`|
| Cash reaches its destination| `CashDisposition`| `payment.cash.disposition`|

**The comparison is three-way** (`MSC-DEC-320`, amended at R1). **System expected = rider declared = hub counted.** The system figure is derived — gross cash minus applied approved `COLLECTION_CASH` road expenses — and **is not writable by either party**.

**Rider and hub agreeing with each other is not reconciliation.** Expected **GH₵125**, declared **GH₵100**, counted **GH₵100** is a **GH₵25 shortage**, and until R1 it confirmed cleanly.

**Gross cash is never rewritten by an expense**. GH₵145 collected with a GH₵20 approved fuel expense is **GH₵145 collected and GH₵20 spent** — not GH₵125 collected. The customer-payment reconciliation depends on it: 280 digital + 145 cash = 425 expected, and netting the fuel out would break it.

**An approved collection-cash expense reduces exactly one handover**, enforced by a **write-once per-expense application reference** rather than by convention. **Each `RoadExpense` may apply to at most one `CashHandover`; one `CashHandover` may include multiple `RoadExpense`s**.

**A rider never resolves their own variance** (`payment.variance.resolve`, Senior Ops), and **`SLICE-004` no longer owns the operational half.** `OQ-005` retains the future Accounting, Finance & Reporting domain — ledger, journals, periods, payables, export — and Gate C's cash events are the source events that domain consumes.

**This feature spans two slices, and the split is now about *where the work happens* rather than about what is missing.** Collection is `SLICE-003` — it happens at the door. Hub-side reconciliation is `SLICE-004` — it happens at the hub. **Both halves are specified.**

**`SLICE-003` defines the doorstep cash-collection side. A hub may enable recipient cash only when the dependent Rider→Hub handover and hub reconciliation capability is operational for that hub.** Specification completeness is not runtime capability: **the chain is fully specified and none of it is built**, so recipient cash stays disabled until the dependent components are implemented and enabled.

## 2. Governing sections

| Section| What it governs here|
|---|---|
| §26.2| The approved collection channels, and that a rider's personal mobile-money account is never one|
| §26.3| Reconciliation: the three figures, the hub, and the run that cannot close|
| §26.5| The financial distinctions Version 1 must digitally make — including "short, **or over**"|
| §36.11| The `RiderCashCustody` lifecycle, and its *no ordinary `PART_PAID`* rule — **read through `MSC-DEC-362`**: the gate stays shut until the demand is fully funded, and a short payment is **preserved rather than refused**|
| §26.4| Mobile money by contrast — the **backend** is authoritative, not the rider|
| **§26.1**| The payer model, and that the allocation stays **traceable through estimate, pricing, delivery, payment, reversal, statement and reconciliation**|
| **§25.6**| Surface responsibilities — the Rider executes **payment capture**; Ops holds payment and reconciliation **visibility**|
| **§26.6**| Names the remaining finance design, including **variance resolution** and **exact cash roles and forms** — the two this feature leaves open|


## 3. Surfaces and actors

| Surface| Actor| Can do| Gated by|
|---|---|---|---|
| Melarc Rider| Rider| Record a cash collection at an assigned stop| `payment.cash.collect`|
| Melarc Rider| Rider| Open a cash handover at the responsible hub with a declared total| `payment.cash.handover`|
| Melarc Ops| Ops Staff| **Confirm receipt** with the hub's own figure| `payment.cash.confirm`|
| Melarc Ops| Senior Ops| Disposition a shortage or overage with a reason| `payment.variance.resolve`|
| Melarc Vendor| —| **N/A.** A vendor never sees another party's cash position|

**§26.1 makes the allocation traceable end to end**, and this feature is one link in that chain: *"the allocation remains traceable through estimate, final pricing, delivery, payment, reversal, statement, and reconciliation."* A cash record that cannot be joined back to the order's `payer_allocation` breaks the chain at its most fragile point, which is why `expected_minor` is snapshotted from that allocation rather than re-derived.

**The rider cannot confirm receipt, and this is the feature's central control.** §26.3 names *"rider-declared handover"* and *"hub-confirmed receipt"* as two figures. One actor supplying both is not a comparison — the identical reasoning as the §22.4 blind count, and the reason `payment.cash.confirm` appears in no rider bundle.

## 4. Preconditions

- The stop's `OperationalPaymentDemand` is payable — `OPEN` or `PARTIALLY_SETTLED` with remaining due — and the hub's `recipient_cash_enabled` capability is on.
- A `RiderCashCustody` record exists in `EXPECTED`, **created at dispatch** — not at the door.
- The rider is the assigned rider for the stop.

## 5. Behaviour

### 5.1 Normal path

1. **At dispatch, the system creates a `RiderCashCustody` in `EXPECTED`**, snapshotting the amount owed.
2. **At the door, the rider records the cash actually taken.** A `CASH` `PaymentReceipt` is written at that amount and linked to the custody record; `EXPECTED → COLLECTED_BY_RIDER`. **The demand settles only when its cumulative confirmed principal reaches the total** — a full tender settles it at once, a short tender leaves the remainder due for any allowed method, and a second cash tender adds a second receipt to the same custody. **The delivery gate is the demand being `SETTLED`**; the workday is closed by none of this.
3. **The rider carries the cash for the rest of the run.**
4. **At the responsible hub, the rider opens a `CashHandover`** with a declared total covering the custody records being handed over.
5. **A hub actor records the hub's confirmed total.** Equal → `CONFIRMED`, and every named custody record reaches `RECONCILED`.
6. **Different → `VARIANCE_OPEN`** with a mandatory reason, every named record goes to `EXCEPTION_OPEN`, and **the run cannot be financially closed** (§26.3).
7. **Senior Ops dispositions the variance**, each record reaches `RESOLVED`, and the handover closes.

### 5.2 Expected is snapshotted at dispatch, and that is what makes it a check

An expectation created at the moment of collection is a **transcription of what the rider says they took**, not a comparison. §26.3 requires comparing *expected* against collected, which requires the expectation to pre-date the collection.

**It is snapshotted, not resolved live** (§35.1.5). A price corrected after the fact would otherwise change what the rider was expected to collect *retroactively*, and every post-hoc repricing would appear as a rider shortage.

### 5.3 Exception paths

| Condition| Behaviour| Code|
|---|---|---|
| Less than the amount due tendered| **Preserved, not refused**: a `CASH` receipt and custody of exactly what was taken, **no demand line settled**, the remainder still due and handover blocked. GH₵50 against GH₵55 leaves GH₵5 to collect by cash, Hubtel or Merchant MoMo.| `PAYMENT_AMOUNT_MISMATCH` — the settlement outcome, never a refusal of the money|
| More than the amount due tendered| **Accepted**, and reconciled as a variance. §26.5 requires "over" to be distinguishable| —|
| Collection attempted by an unassigned rider| Refused| `NOT_ASSIGNED_RIDER`|
| Handover opened at the wrong hub| Refused. §26.3 fixes the **responsible** hub| `HUB_SCOPE_VIOLATION`|
| Hub total differs from declared| `VARIANCE_OPEN`, reason mandatory, run held| `REASON_REQUIRED`|
| Ops attempts to close a variance| Refused — Senior Ops only| `INSUFFICIENT_AUTHORITY`|
| The stop then fails| **Custody is unaffected.** The money travels home (§12.1.1) through the ordinary hub reconciliation chain in §14a. **Its financial resolution if the parcel is never redelivered — refund, vendor credit, or Melarc retention — is not decided here**: `OQ-004`, deferred to `SLICE-006`, is where a parcel's exceptional final disposition and any money already collected against it are resolved together (CRIT-07 audit remediation)| —|

**Neither short nor over is refused, and the two are recorded differently.** A short tender is money received that settles nothing yet; an over-tender is accepted because §26.5 requires "short, **or over**" to be distinguishable and a rider cannot make change at a stranger's door — the excess against the demand total becomes a `FinancialAdjustmentRequired`, and the custody variance surfaces at the hub. Refusing either would leave the fee uncollected — the worse outcome.

### 5.4 What this feature must never do

- **Never treat collection as financial closure** (§36.11).
- **Never refuse or discard a short cash tender**. Money the rider physically took is a receipt and custody at that amount; what it does not do is open the door.
- **Never let custody state open the door.** The delivery gate is the demand reaching `SETTLED` on cumulative principal across every method.
- **Never let a rider confirm hub receipt** (§26.3).
- **Never accept a rider's personal mobile-money account as a channel.** §26.2 forbids it outright.
- **Never let the rider's declared total be auto-filled from the sum of expectations.** The two figures exist to be compared, so both must be independently recordable. **This survives `MSC-DEC-254`**: the officer may *see* the declared total, and the system must never *supply* it.
- **Never apply a variance tolerance.** §26.3 assigns thresholds to downstream design; none is set, so any difference opens the exception.
- **Never read the run to find who holds the money.** A `RunCustodyHandover` moves parcels between riders and **not cash** — see [domain-model.md](../../contracts/domain-model.md) §6.11.

## 6. Entities — *pointer*

[domain-model.md](../../contracts/domain-model.md) §6.11 `RiderCashCustody` and `CashHandover`; §6.10 `DeliveryStop.payment_taken`.

## 7. States — *pointer*

| Field| Home| Transitions this feature drives|
|---|---|---|
| `RiderCashCustody.state`| [state-machines.md](../../contracts/state-machines.md) §16.3| All six|
| `CashHandover.state`| [state-machines.md](../../contracts/state-machines.md) §16.4| All four|
| `OperationalPaymentDemand.status`| [domain-model.md](../../contracts/domain-model.md) §6.12| `OPEN → PARTIALLY_SETTLED → SETTLED`, derived from receipts across every method|

## 8. Permissions — *pointer*

[permissions.md](../../contracts/permissions.md) §7. `payment.cash.collect`, `payment.cash.handover`, `payment.cash.confirm`, `payment.variance.resolve` — **all four added 24 August by `MSC-DEC-250`.** Before that the `payment` domain had `payment.read` and nothing else.

## 9. Settings — *pointer*

[settings.md](../../contracts/settings.md). **The workday-close cutoff has no key** — §26.3 assigns *"exact cutoff, shift model, verifier/approver roles, evidence, variance thresholds, and escalation"* to downstream design. See §14.

## 10. Errors — *pointer*

[errors-and-enums.md](../../contracts/errors-and-enums.md) §4, §5.4. **This feature adds no code.** Every refusal above reuses one — including the near miss `MSC-DEC-250` records, where `WRONG_HUB` was drafted before the register showed it withdrawn.

## 11. Audit events — *pointer*

[audit.md](../../contracts/audit.md) §5.7. Six codes, added with the machines: `payment.cash.collected`, `payment.cash.handover_opened`, `payment.cash.custody_accepted`, `payment.cash.received`, `payment.cash.variance_opened`, `payment.cash.variance_resolved`. §26.3 requires *"cash collection, custody, handover, receipt, variance, correction, and closure"* to be **separate auditable events** — seven acts named individually in an `APPROVED` section, against a domain that had none. **Correction** is `payment.cash.variance_resolved`; **closure** needs no record of its own because `payment.cash.received` already carries it (§5.7's own commentary) — which is the arithmetic behind six codes for seven acts.

**`CashDisposition`'s own event is deliberately out of this feature's scope** (MED-14 audit remediation). `payment.cash.disposition_recorded` **exists and is enhanced** — physical cash reaching an approved bank, Merchant MoMo or Finance destination is a later act than anything §26.3 assigns here, and it is cited correctly from [hub-daily-operating-cycle.md](../operations/hub-daily-operating-cycle.md) §11 and [exception-ownership-matrix.md](../operations/exception-ownership-matrix.md), which own it. **Read in isolation this section could look like coverage stops at variance**; it does not — the chain continues one feature over.

## 12. API operations — *pointer*

[openapi.yaml](../../contracts/openapi.yaml). `recordRecipientCashPayment` (R), `getStopPaymentDemand` (the demand and its remaining due, R and Ops), `openCashHandover` (R), `confirmCashHandover` (A S P), `resolveCashVariance` (S P); the road-expense pair and the hub reconciliation operations behind §14a.

## 13. Acceptance criteria

### `AC-SLICE-003-13` — Collection satisfies delivery and closes nothing financial

```text
Given an order whose OperationalPaymentDemand has GH¢30 due at the door,
When the rider records a GH¢30 cash collection,
Then a CASH PaymentReceipt of GH¢30 exists and the RiderCashCustody record is COLLECTED_BY_RIDER at GH¢30,
And the demand is SETTLED on the cumulative GH¢30 and the delivery payment gate is satisfied,
And the run's financial status remains open,
And no reconciliation record is created.
```

**Governs:** §36.11, §26.3 · **Surface:** Melarc Rider · **Test level:** integration

### `AC-SLICE-003-14` — Expected is snapshotted at dispatch, not at collection

```text
Given an order dispatched with a recipient portion of GH¢30,
When the order is repriced to GH¢35 after dispatch,
And the rider then collects GH¢30,
Then RiderCashCustody.expected_minor is still 3000,
And the collection reconciles without variance.
```

**Governs:** §35.1.5, §26.3 · **Surface:** backend · **Test level:** integration

### `AC-SLICE-003-15` — A short tender is preserved and the remainder stays due

```text
Given a stop whose OperationalPaymentDemand is GH¢55,
When the rider records a cash collection of GH¢50,
Then the collection is accepted and a CASH PaymentReceipt of GH¢50 exists,
And the RiderCashCustody record is COLLECTED_BY_RIDER at GH¢50 with that receipt linked,
And no demand line is settled, the demand is PARTIALLY_SETTLED and remaining_due_minor is 500,
And the delivery gate remains unsatisfied and the OTP request is refused with RECIPIENT_PAYMENT_OUTSTANDING,
And the stop's payment view still offers collection, for GH¢5.
```

**Governs:** `MSC-DEC-362`, `MSC-DEC-365`, §36.11 · **Surface:** Melarc Rider · **Test level:** integration


### `AC-SLICE-003-16` — A rider cannot confirm the hub's receipt

```text
Given an OPEN CashHandover declared by a rider,
When that rider attempts to record the confirmed total,
Then the attempt is refused with PERMISSION_DENIED,
And the handover remains OPEN.
```

**Governs:** §26.3 · **Surface:** Melarc Rider · **Test level:** integration

### `AC-SLICE-003-17` — Any difference opens a variance and holds the run

```text
Given an OPEN CashHandover declared at GH¢300,
When a hub actor confirms GH¢299 with a reason,
Then the handover is VARIANCE_OPEN,
And every named custody record is EXCEPTION_OPEN,
And the run cannot be financially closed,
And an Ops Staff actor cannot resolve the variance.
```

**Governs:** §26.3 · **Surface:** Melarc Ops · **Test level:** integration

### `AC-SLICE-003-18` — Cash survives a run custody handover

```text
Given a rider holding GH¢200 in cash custody on an IN_PROGRESS run,
When a RunCustodyHandover transfers the run's parcels to another rider,
Then RiderCashCustody.rider_id is unchanged,
And the original rider still owes the hub GH¢200,
And the receiving rider owes nothing.
```

**Governs:** `MSC-DEC-246`, `MSC-DEC-250` · **Surface:** backend · **Test level:** integration

### `AC-SLICE-003-36` — Cash then a digital remainder settles the demand once, and the two amounts stay apart

```text
Given a stop whose OperationalPaymentDemand is GH¢55 (delivery fee GH¢35 + redelivery fee GH¢20),
When the rider records GH¢50 in cash,
Then a CASH PaymentReceipt of GH¢50 exists and RiderCashCustody is COLLECTED_BY_RIDER at GH¢50,
And no demand line is settled, the demand is PARTIALLY_SETTLED and remaining_due_minor is 500,
And the OTP request is refused with RECIPIENT_PAYMENT_OUTSTANDING,
When the recipient then approves a Hubtel prompt that the server raised for GH¢5 and the provider confirms it,
Then a HUBTEL PaymentReceipt of GH¢5 exists and no custody record changes,
And both lines settle atomically — GH¢35 and GH¢20 — and the demand is SETTLED on the cumulative GH¢55,
And the run cash summary shows GH¢50 gross cash and GH¢5 confirmed digital, never GH¢55 of either,
And the same outcome holds when the GH¢5 arrives first by Hubtel and the GH¢50 in cash after it.
```

**Governs:** `MSC-DEC-362`, `MSC-DEC-363`, `MSC-DEC-365`, `MSC-DEC-313` · **Surface:** Melarc Rider, backend · **Test level:** integration

### `AC-SLICE-003-37` — Two cash tenders on one order are two receipts and one custody record

```text
Given a stop whose OperationalPaymentDemand is GH¢55 and a rider who has recorded GH¢50 in cash,
When the recipient finds GH¢5 more and the rider records a second cash collection of GH¢5,
Then a second CASH PaymentReceipt of GH¢5 exists, linked to the same RiderCashCustody,
And that custody record remains COLLECTED_BY_RIDER with collected_minor 5500 and two cash_receipt_ids,
And the demand is SETTLED on the cumulative GH¢55 with both lines allocated,
And no money is invented and none is lost: the handover expects GH¢55 of physical cash from this order.
```

**Governs:** `MSC-DEC-362`, `MSC-DEC-365`, §26.3 · **Surface:** Melarc Rider, backend · **Test level:** integration

### `AC-SLICE-003-38` — A claimed expense reduces nothing

```text
Given a rider who has recorded a GH₵20 COLLECTION_CASH fuel expense on their run,
When the expense is CLAIMED and no Senior Ops has decided it,
And the rider opens a cash handover,
Then the handover's expected cash is unchanged by that expense,
And appliedToCashHandoverId on the expense is null.
```

**Governs:** §26.5, `MSC-DEC-314`, `MSC-DEC-319`, state-machines.md §20.1 · **Surface:** Melarc Rider, backend · **Test level:** integration

### `AC-SLICE-003-39` — Approval makes an expense eligible and deducts nothing

```text
Given a CLAIMED GH₵20 COLLECTION_CASH expense,
When Senior Ops approves it,
Then its status is APPROVED and appliedToCashHandoverId is still null,
And no open or later handover's expected cash has moved,
And the rider's cash accountability is unchanged until the expense is applied.
```

**Governs:** §26.5, `MSC-DEC-341`, `MSC-DEC-344`, `MSC-DEC-345`, state-machines.md §20.1 · **Surface:** Melarc Rider, Melarc Ops, backend · **Test level:** integration

### `AC-SLICE-003-40` — Application is what lowers expected cash, once and to one handover

```text
Given an APPROVED GH₵20 COLLECTION_CASH expense and an APPROVED GH₵10 one on the same run,
When a cash handover is opened and both are bound to it,
Then that handover's expected cash is GH₵30 lower,
And each expense carries appliedToCashHandoverId naming that one handover and an appliedAt,
And neither may be bound to a second handover,
And a later handover on the same run is reduced by neither.
```

**Governs:** §26.5, `MSC-DEC-341`, `MSC-DEC-345` · **Surface:** backend · **Test level:** integration

### `AC-SLICE-003-41` — A rider cannot approve their own expense

```text
Given a GH₵20 expense CLAIMED by Rider A,
When Rider A attempts to decide it,
Then the response is 403 PERMISSION_DENIED — payment.road_expense.approve is not a rider key,
And when a Senior Ops who is the same person as the claimant attempts it,
Then the response is 403 SELF_APPROVAL_FORBIDDEN.
```

**Governs:** §26.5, `MSC-DEC-319`, state-machines.md §20.1 · **Surface:** Melarc Ops, backend · **Test level:** integration · **Expected code on rejection:** `SELF_APPROVAL_FORBIDDEN`

### `AC-SLICE-003-42` — An undecided claim leaves the rider accountable

```text
Given a GH₵20 COLLECTION_CASH expense that stays CLAIMED through the end of the run,
When the rider hands cash to the hub,
Then the expected cash includes the GH₵20,
And a shortfall of GH₵20 opens a variance rather than being written off,
And the control is not bypassed by nobody deciding.
```

**Governs:** §26.5, `MSC-DEC-319`, `MSC-DEC-321` · **Surface:** Melarc Rider, backend · **Test level:** integration

### `AC-SLICE-003-43` — Only `COLLECTION_CASH` is selected at the handover's opening

```text
Given three APPROVED expenses on one run — COLLECTION_CASH GH₵20, RIDER_PERSONAL GH₵15 and COMPANY_FLOAT GH₵10,
When the CashHandover opens and the server selects eligible expenses,
Then only the COLLECTION_CASH GH₵20 is selected, bound and deducted — it alone receives
  applied_to_cash_handover_id and applied_at, and applied_expense_minor is 2000,
And the RIDER_PERSONAL GH₵15 is not applied to this handover and keeps a null
  applied_to_cash_handover_id, remaining a reimbursement obligation to the rider,
And the COMPANY_FLOAT GH₵10 is likewise not applied and reconciles against the float,
And system_expected_minor falls by GH₵20 and by nothing else.
```

**Governs:** §26.5, `MSC-DEC-315`, `MSC-DEC-341`, `MSC-DEC-345`, domain-model.md §6.11 · **Surface:** backend · **Test level:** integration

**Corrected at Rider Four-Pass R1.** The first draft read *"when all three are applied at the
handover's opening"*, which **is not the approved mechanism and would have failed a correct
implementation**. [domain-model.md](../../contracts/domain-model.md) §6.11 states the selection rule
in five steps: the server selects expenses that are `APPROVED` **and** `funding_source =
COLLECTION_CASH` **and** this rider and run **and** unapplied, and binds **only those**.
`RIDER_PERSONAL` and `COMPANY_FLOAT` are never selected, never bound, and never carry
`applied_to_cash_handover_id` — they are not applied to the handover at all, rather than applied
with no effect.

## 14. Open questions blocking this feature

| ID| What it blocks here| Type|
|---|---|---|
| ~~`OQ-092`~~| **Closed 26 August by `MSC-DEC-254` — the count is NOT blind.** `declared_total_minor` stays visible. Two actors survive; blindness does not| —|
| `OQ-005`| **Narrowed at Gate C R1.** The future **Accounting, Finance & Reporting** domain — ledger, journals, periods, payables, export, deeper allocation and reversal design. **It no longer owns this feature's reconciliation**, which `MSC-DEC-320`–`MSC-DEC-323` supply| `ARTIFACT_REQUIRED`|
| `OQ-109`| The live Hubtel merchant contract, for the digital alternative at the same door — **blocks the provider adapter, not this feature's specification**.| `EXTERNAL_INPUT`|
| ~~`OQ-094`~~| **Closed 30 August by `MSC-DEC-324`** — `cash_reconciliation_cutoff_time` = **18:00 `Africa/Accra`**, per hub.| —|
| —| **Variance thresholds and verifier roles** remain §26.3 downstream design and have no key. **§26.6 names the same residue** — *"exact cash roles/forms, variance resolution"*. **Any** difference opens the exception until a threshold is set| —|
| `OQ-004`| **CRIT-07 audit remediation.** §5.3's *"the stop then fails"* row preserves custody through ordinary hub reconciliation, but this feature does not decide the money's fate if the parcel is never redelivered — that is `SLICE-006`'s `ReturnRecord`, alongside a parcel's other exceptional dispositions| `DECISION_NEEDED`|

## 14a. The reconciliation chain, end to end — *current truth, Gate C R1.2*

**Specification truth, not build truth.** Every step below is specified and none of it is built.

| Step| Record| What moves| Where|
|---|---|---|---|
| Recipient pays at the door| `RiderCashCustody` → `COLLECTED_BY_RIDER`| Cash enters the rider's possession| §16.3|
| Rider opens a handover at the responsible hub| `CashHandover` → `OPEN`| **No cash moves — and the expectation is derived.** Eligible approved `COLLECTION_CASH` expenses are **bound here**, the applied total is snapshotted, and `system_expected_minor` follows. A declaration is an assertion| §16.4|
| Hub counts and accepts| `RiderCashCustody` → `HANDED_TO_HUB`| **Physical custody transfers**, `custody_transferred_at` stamped| §16.3, §16.4|
| Three-way comparison| `CashHandover` → `CONFIRMED` or `VARIANCE_OPEN`| System expected = declared = counted, or a variance opens| §16.4|
| Hub's daily position| `HubCashReconciliation`| **Accrues what the hub counted** — clean and variance handovers alike| §20.2|
| Variance resolution| `RiderCashCustody` → `RESOLVED`| The rider's shortfall, settled separately| §16.3|
| Final disposition| `CashDisposition`| Banked, or moved to an approved destination| §20.3|

**The rider's variance is not the hub's shortage.** Expected **GH₵125**, counted and accepted **GH₵100**: the hub's position rises by **100**, and **−25** stays open against the rider. Physical truth does not wait for financial agreement.

**The cutoff exists.** `cash_reconciliation_cutoff_time` = **18:00 `Africa/Accra`**, per hub (`MSC-DEC-324`, closing `OQ-094`).

Use the current transition tables and feature criteria. No additional document-signing step is required for this feature; production dependencies remain in the relevant deployment and slice sections.

#### Road expenses and the handover — cardinality and timing, C1

`MSC-DEC-341`, `MSC-DEC-345`. **Two rules, and both are easy to state backwards.**

|||
|---|---|
| **Each `RoadExpense` applies to at most one `CashHandover`**| Write-once per row, immutable once set. This is what stops the same GH₵20 being deducted twice|
| **Each `CashHandover` may carry zero, one or many applied `RoadExpense`s**| `CashHandover 1 ← 0..N RoadExpense`. Fuel **GH₵20** and a puncture repair **GH₵10** on one run both apply, and deduct **GH₵30**|

**The reference is not unique across the column.** A constraint written as *unique by handover* would reject the second expense on an ordinary day.

**Approval alone does not reduce expected cash. Application does.** `APPROVED` makes an expense **eligible**; binding it to one specific handover — at **that handover's opening** — is what reduces that handover's expected cash. An approved expense never applied reduces nothing, and one already applied elsewhere can never reduce a second handover.

#### Digital collection is not rider cash — Gate C C1.4

`MSC-DEC-352`. **Money collected through the provider reaches Melarc's own account. It never touches a rider.**

**Cash writes two records, and they are not the same record**. A **`PaymentReceipt`** with `method = CASH` records **what payment Melarc accepted**; a **`RiderCashCustody`** records **who is physically holding the notes**. One is a fact about money received, the other a fact about accountability for it — and §26.3 compares three figures precisely because those two things move apart. **A confirmed `HUBTEL` or `MERCHANT_MOMO` receipt creates no custody row at all**: rider physical cash is **zero**, and the money is already Melarc's at the provider.

**A doorstep collection taken while a provider attempt is unresolved requires the Ops duplicate-risk grant** — `fallback_authorization_id`, checked for method, demand and attempt, and **consumed by the receipt that uses it**. A rider supplies its id and **can never issue one**.

|| Creates|
|---|---|
| **Provider-confirmed collection**| **Confirmed digital.** No `RiderCashCustody`, no collection-cash pool, no handover cash|
| **Cash at the door**| **`RiderCashCustody`.** Physical money in a pannier, reconciled at the hub|

**The run reconciliation keeps them apart**, exactly as `MSC-DEC-313` requires: confirmed digital and gross physical cash are two figures, and collapsing them reports a shortfall against a rider who is holding nothing.

**A failed digital collection does not become cash.** If the provider path fails and the customer pays cash instead, that is a **separate receipt against the same obligation** — the collection attempt stays what it was, and the cash creates custody in the ordinary way. **Nothing mutates one into the other.**

**A fallback while a collection is unresolved is a duplicate-payment risk.** Merchant MoMo or cash must not begin while an attempt sits in `STATUS_UNKNOWN` unless the duplicate risk is explicitly controlled: resolve it, expire it, cancel it safely, or record the risk deliberately. **If the fallback settles and the provider later confirms, both receipts are kept, the obligation is paid once, and the excess becomes an overpayment exception** for Accounting. **Neither receipt is silently discarded** — that is money someone actually paid.

## 15. What this feature still owes its slice

- **All four cash operations are written** — `recordRecipientCashPayment`, `openCashHandover`, `confirmCashHandover`, `resolveCashVariance`. The four permissions no longer sit without calls behind them, which is the state §7.1 warns produces an invisible hole.
- ~~**`SLICE-003` can take money and cannot reconcile it.**~~ **Withdrawn at Gate C R1.** The chain closes: rider handover, hub acceptance, hub reconciliation, variance disposition and final disposition are all specified. **What remains true is the sequencing** — `recipient_cash_enabled` ships **Off** for a hub until that workflow is operational, which is the same protection stated as a capability rather than as a gap.
- **`RiderCashCustody` and `CashHandover` are signed, amended, and re-signed** (§36.13). `MSC-DEC-257` signed both on **26 August**; Gate C amended three rows in each; **`MSC-DEC-366` re-signed all six on 4 September 2026**, so **no signature is outstanding on either machine**.
- ~~`OQ-092` should be answered before the read schema ships~~ — **answered 26 August**, before it shipped. The count is not blind; the schema is unchanged.

## 16. Build status — *honest, per surface*

| Surface| Status|
|---|---|
| Melarc Rider| **Specified and buildable.** The contract is complete — four cash operations, the road-expense pair, the payment demand, and the doorstep surface inventory at [rider-android.md](../../surfaces/rider-android.md) §5, every row naming a permission a rider holds. **Nothing is built**; the machines behind it — `RiderCashCustody` §16.3, `CashHandover` §16.4 and the §20 cash machines — are **re-signed by `MSC-DEC-366` on 4 September 2026** and **owe no further signature**.|
| Melarc Ops| **Specified and buildable.** Hub count, reconciliation and disposition have operations, keys and routes; their machines — `HubCashReconciliation` §20.2 and `CashDisposition` §20.3 — are **signed by `MSC-DEC-366`**, and the surfaces are **unbuilt**.|
| Melarc Vendor| **N/A** — never exposed|

## 17. Related

[doorstep-delivery](doorstep-delivery.md) · [delivery-failure](delivery-failure.md) · [state-machines.md §16](../../contracts/state-machines.md) · [SLICE-003](../../delivery/slices/SLICE-003.md)
