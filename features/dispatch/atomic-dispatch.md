# Atomic dispatch

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.5 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** the all-or-nothing dispatch commit, its revalidation set, and the boundary between dispatch and delivery
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §24.5, §24.6, §24.8, §24.9, and cross-cutting §35.7, §16, §40
> **Slice:** `SLICE-002`

## 1. What this is, and why

Dispatch commits a whole run at once. §24.5 is unambiguous: **"Dispatch must be all-or-nothing."**

Everything is revalidated at the commit — the rider, **the rider's assigned motorcycle**, the courier, and **every** order's payment gate and readiness. If one check fails, **every change rolls back** and the run stays `DRAFT`.

**Version 1 boundary.** Dispatch is where `SLICE-002` ends. §24.8: *"for doorstep work, dispatch does not equal delivery"* — the parcel reaches a terminal outcome only after OTP and payment under §25, which is `SLICE-003`.

## 2. Governing sections

| Section| What it governs here|
|---|---|
| §24.5| The atomic commit and its six-item revalidation set|
| §24.6| Run state direction; **dispatch is Ops, start is Rider**|
| §24.8| The doorstep boundary — dispatch is not delivery|
| §24.9| The outbound financial boundary|
| §35.7| **Cross-cutting.** Rule 5: one order cannot reach two mechanisms. Rules 7–8: the second prepayment gate. Rule 10: everything visible at dispatch comes from the authoritative record|
| §16| **Cross-cutting.** Lifecycle placement|
| §40| **Cross-cutting.** The 5-second critical-write target applies here|


## 3. Surfaces and actors

| Surface| Actor| Can do| Gated by|
|---|---|---|---|
| Melarc Ops| Ops Staff| Dispatch a run| `dispatch.run.dispatch`|
| Melarc Ops| Senior Ops| The same| Same key|
| Melarc Rider| Rider| **Receives one run-level notification**, then **starts the run** — a deliberate act| assigned rider|
| Melarc Vendor| Vendor account| **N/A**| —|

## 4. Preconditions

- Run is `DRAFT` with **at least one stop** and an **assigned rider**.
- Each order is confirmed (doorstep) and payment- or credit-cleared (§24.3, `MSC-DEC-176`).
- Outbound orders have satisfied their **second** prepayment gate (§35.7.7–8).

## 5. Behaviour

### 5.1 Normal path

1. **Ops dispatches.** The server revalidates, in one transaction (§24.5):
   - rider still active
   - rider's assigned motorcycle still serviceable (§34.10)
   - courier still active, where the outbound mode requires one
   - **every** order's credit or payment gate
   - **every** order's readiness and availability
   - lane compatibility
2. **All state changes commit together** — run, orders and stops.
3. **One run-level rider notification** follows success (§24.5). **One — not one per stop.**
4. **The rider starts the run.** A deliberate rider action, never an Ops one (§24.6).

### 5.2 Partial dispatch is the plausible implementation, and it is wrong

The natural build, facing one order that fails revalidation, is to **drop that stop and dispatch the rest**. It feels helpful: nineteen good parcels should not wait for one bad one.

**§24.5 forbids it** — *"roll back all changes if one validation fails"* — and §35.7.5 explains why: *"the same order cannot be dispatched to two destinations or mechanisms through concurrent actions."*

**Partial dispatch is how that happens.** An order silently dropped from a run is still eligible, still in the pool, and will be picked up by the next run built — while a concurrent process may already be acting on the first dispatch. All-or-nothing is not fastidiousness; it is the control that keeps one parcel on one path.

### 5.3 A rollback must leave a trace

A failed dispatch changes nothing. The run stays `DRAFT`, every order is untouched, and **without an event there is no way to tell that dispatch was attempted at all.**

`dispatch.run.rollback` exists for that: an atomic operation that fails silently is indistinguishable from one never attempted. Ops needs to know the difference — the first means *fix the failing order*, the second means *press the button*.

### 5.4 Outbound carries a second gate the credit gate does not satisfy

§35.7.7 and §35.7.8, and this is a distinct check from `MSC-DEC-176`'s credit reservation:

| Mode| Gate|
|---|---|
| `STATION_DROP`| The effective **hub-scoped** fee snapshot must be **backend-confirmed paid** before station dispatch|
| `MELARC_COVERED_THIRD_PARTY_DELIVERY`| The **combined waybill-plus-Melarc** charge must be backend-confirmed paid; the recipient owes nothing at destination|

**A vendor with available credit does not clear this gate.** They are different questions — one asks whether the vendor may owe, the other whether an outbound charge has actually been received.

### 5.5 Exception paths

**`RECIPIENT_PAYMENT_OUTSTANDING` was used here until 23 August, and it is not a milder mistake than a typo.** That code means *the recipient owes money at the door* (§35.8.2). At **dispatch** on a recipient-pays order the recipient **always** owes — that is the normal, healthy case — so a handler branching on it here reads a condition true of every correct delivery. `ORDER_NOT_COMMERCIALLY_CLEARED` is the dispatch-readiness code, it is what `state-machines.md` §9 has always used, and until now **no feature used it at all**.

| Path| Behaviour| Error code|
|---|---|---|
| Run has no stops| Refused| `MANIFEST_EMPTY`|
| No rider assigned| Refused| `VALIDATION_FAILED`|
| Rider went inactive since assignment| **Whole run rolls back**| `VALIDATION_FAILED`|
| Rider's motorcycle broke down since the run was built| **Whole run rolls back.** A confirmed breakdown makes the motorcycle unavailable for new runs — same rule §34.10 applies at pickup-manifest dispatch (`NO_SERVICEABLE_MOTORCYCLE`), now revalidated here too| `NO_SERVICEABLE_MOTORCYCLE`|
| Courier inactive, mode requires one| Whole run rolls back| `VALIDATION_FAILED`|
| One order's credit gate closed| **Whole run rolls back.** Not "drop that stop"| `ORDER_NOT_COMMERCIALLY_CLEARED`|
| Outbound charge unpaid| Whole run rolls back (§35.7.7–8)| `OUTBOUND_CHARGE_UNPAID`|
| Concurrent dispatch of one run| One wins; the other sees the conflict| `STATE_CONFLICT`|
| Ops attempts to start the run| **Refused. Only the rider starts** (§24.6)| `INSUFFICIENT_AUTHORITY`|
| Rider starts a run not theirs| Refused| `NOT_ASSIGNED_RIDER`|
| Dispatch succeeds, notification fails| **The dispatch stands.** A notification failure does not roll back a committed dispatch. `notify_rider_run_dispatched` ([BACKGROUND_JOBS_AND_EVENTS.md](../../architecture/BACKGROUND_JOBS_AND_EVENTS.md) §3.2, §4) **automatically retries first**, classified by the failure it hit: a transient failure (timeout, 5xx, provider-retryable) gets the bounded Class 1 schedule — roughly 30s, 2min, 10min, 30min, 2h, then dead-letter; a deterministic rejection dead-letters immediately, Class 2, with no blind retry. **Only once the job dead-letters does the run surface in the `retry` interface state (§41.1)** for an operator to act on — this is what "surfaced for operator retry" means, not that automated retry never happened (MED-13 audit remediation)| `DELIVERY_CHANNEL_FAILED`|

### 5.6 What this feature must never do

- **Never dispatch partially.** §24.5, §35.7.5. See §5.2. This is the single most likely defect in the feature.
- **Never let a notification failure roll back a committed dispatch.** The commit is the operation; the notification is a consequence. Reversing custody state because an SMS failed would be worse than the failed SMS.
- **Never send one notification per stop.** §24.5 says one run-level notification.
- **Never let Ops start a run.** §24.6: dispatch is Ops, start is Rider. Collapsing them removes the rider's deliberate act and the moment the run genuinely begins.
- **Never treat the credit gate as satisfying the outbound gate.** §5.4 — different questions.
- **Never read anything but the authoritative order record at dispatch.** §35.7.10: price, recipient data, commercial mode, carrier, payment state and confirmation status all come from the order, never from a cached pool projection.
- **Never treat dispatch as delivery.** §24.8. A dispatched doorstep parcel has reached no terminal outcome.

## 6. Entities — *pointer*

| Entity| Home|
|---|---|
| `DeliveryRun`, `DeliveryStop`| [domain-model.md](../../contracts/domain-model.md) §6.10|
| `Order`| §6.7 — `commercial_state`, `fulfilment_state`, `commercial_mode`|

## 7. States — *pointer*

| Machine| Home| States this feature drives|
|---|---|---|
| `DeliveryRun.state`| [state-machines.md](../../contracts/state-machines.md) §12| `DRAFT → DISPATCHED → IN_PROGRESS`|
| `Order.fulfilment_state`| §9| `READY_FOR_DISPATCH → ASSIGNED → OUT_FOR_DELIVERY`|
| `DeliveryStop.state`| §12.1| Stops remain `PENDING` until the rider arrives|

## 8. Permissions — *pointer*

| Key| Holders| Scope| Home|
|---|---|---|---|
| `dispatch.run.dispatch`| A S P| own hub| [permissions.md](../../contracts/permissions.md) §7|
| `pickup.run.execute`| Rider| assigned| §7 — the rider's start|

## 9. Settings — *pointer*

None. Dispatch reads state, not configuration.

## 10. Errors — *pointer*

`MANIFEST_EMPTY`, `VALIDATION_FAILED`, `NO_SERVICEABLE_MOTORCYCLE`, `ORDER_NOT_COMMERCIALLY_CLEARED`, `OUTBOUND_CHARGE_UNPAID`, `STATE_CONFLICT`, `INSUFFICIENT_AUTHORITY`, `NOT_ASSIGNED_RIDER` — [errors-and-enums.md](../../contracts/errors-and-enums.md).

**`ORDER_NOT_COMMERCIALLY_CLEARED`, not `RECIPIENT_PAYMENT_OUTSTANDING`** — this pointer still named the retired code after v0.3 corrected every other mention of it. `RECIPIENT_PAYMENT_OUTSTANDING` means the recipient owes at the door, true of every healthy recipient-pays order at dispatch; using it here would flag the normal case as an error. **`NO_SERVICEABLE_MOTORCYCLE` added** — CRIT-06 audit remediation, §5.1.

## 11. Audit events — *pointer*

| Event| Enhanced?| Home|
|---|---|---|
| `dispatch.run.dispatched`| **Yes**| [audit.md](../../contracts/audit.md) §5.3|
| `dispatch.run.rollback`| **Yes**| §5.3|

## 12. API operations — *pointer*

`dispatchDeliveryRun`, `startDeliveryRun` — [openapi.yaml](../../contracts/openapi.yaml).

## 13. Acceptance criteria

### `AC-SLICE-002-13` — One failing order rolls back the whole run

```text
Given a draft run of twenty stops with an assigned active rider,
When one order's credit gate has closed since the run was built,
And Ops dispatches,
Then the dispatch is refused,
And the run remains DRAFT,
And all twenty orders are untouched,
And no stop was dispatched and none was silently dropped.
```

**Governs:** §24.5, §35.7.5 · **Surface:** Melarc Ops · **Test level:** integration · **Code:** `ORDER_NOT_COMMERCIALLY_CLEARED`

### `AC-SLICE-002-14` — A rollback is recorded

```text
Given a dispatch attempt that fails revalidation,
When the transaction rolls back,
Then dispatch.run.rollback is emitted naming the failing check and order,
And the event distinguishes an attempted dispatch from one never made,
And Ops can see why the run is still DRAFT.
```

**Governs:** §24.5, §38 · **Surface:** Melarc Ops · **Test level:** integration

### `AC-SLICE-002-15` — One run-level notification, not one per stop

```text
Given a run of twenty stops dispatched successfully,
When the rider is notified,
Then exactly one notification is sent,
And it is run-level,
And no per-stop notification is generated.
```

**Governs:** §24.5 · **Surface:** Melarc Rider · **Test level:** integration

### `AC-SLICE-002-16` — Dispatch is Ops; start is Rider

```text
Given a dispatched run,
When an Ops user attempts to start it,
Then it is refused,
And when the assigned rider starts it the run becomes IN_PROGRESS,
And a rider who is not assigned to that run is refused.
```

**Governs:** §24.6 · **Surface:** Melarc Ops, Melarc Rider · **Test level:** API · **Code:** `INSUFFICIENT_AUTHORITY`, `NOT_ASSIGNED_RIDER`

### `AC-SLICE-002-17` — The outbound gate is separate from the credit gate

```text
Given a STATION_DROP order for a vendor with ample available credit,
When the station-drop fee snapshot is not backend-confirmed as paid,
And the run is dispatched,
Then the dispatch is refused,
And available credit did not satisfy the outbound gate,
And a MELARC_COVERED_THIRD_PARTY_DELIVERY order behaves the same against its combined charge.
```

**Governs:** §35.7.7, §35.7.8, §24.9 · **Surface:** Melarc Ops · **Test level:** integration · **Code:** `OUTBOUND_CHARGE_UNPAID`

### `AC-SLICE-002-18` — A notification failure does not reverse a commit

```text
Given a run that passes every revalidation check,
When the commit succeeds but the rider notification fails to send,
Then the run remains DISPATCHED,
And the orders remain dispatched,
And the failure surfaces as DELIVERY_CHANNEL_FAILED for operator retry,
And custody state is not rolled back.
```

**Governs:** §24.5, §39.9 · **Surface:** Melarc Ops · **Test level:** integration · **Code:** `DELIVERY_CHANNEL_FAILED`

### `AC-SLICE-002-19` — Dispatch is not delivery

```text
Given a doorstep order on a dispatched run,
When dispatch completes,
Then the order is OUT_FOR_DELIVERY and not DELIVERED,
And no terminal outcome is recorded,
And no proof of delivery exists.
```

**Governs:** §24.8 · **Surface:** Melarc Ops · **Test level:** API

### `AC-SLICE-002-20` — A motorcycle breakdown since build blocks dispatch, not just assignment

```text
Given a DRAFT run built for a rider whose assigned motorcycle was serviceable at build time,
When the motorcycle's status changes to a confirmed breakdown before Ops dispatches,
And Ops dispatches,
Then the dispatch is refused,
And the run remains DRAFT,
And every order on the run is untouched,
And no stop was dispatched and none was silently dropped.
```

**Governs:** §24.5, §34.10 · **Surface:** Melarc Ops · **Test level:** integration · **Code:** `NO_SERVICEABLE_MOTORCYCLE`

*CRIT-06 audit remediation. Mirrors `AC-SLICE-001-15` in [pickup-manifest.md](../pickup/pickup-manifest.md), which already covers the equivalent gap for pickup dispatch.*

## 14. Open questions blocking this feature

| ID| What it blocks here| Type|
|---|---|---|
| `OQ-030`| Dispatch screens, and how a rollback is presented to Ops| `ARTIFACT_REQUIRED`|
| `OQ-048`| The notification provider for the run-level rider message| `EXTERNAL_INPUT`|

**No `DECISION_NEEDED` question blocks this feature.** §24.5's atomicity, §24.6's actor split and §35.7's gates are all confirmed; nothing here waits on a ruling.

## 15. What this feature still owes its slice

| Owed| Blocks which DoR area| Owner|
|---|---|---|
| Visual design| D — *satisfied at slice level* by the page inventory under `MSC-DEC-223`| `OQ-030`|

**Nothing structural.** Its rules were settled in the baseline and needed no interpretation — the most decision-complete feature in the slice.

**Readiness is not assessed here.** [definition-of-ready.md](../../standards/definition-of-ready.md) assesses it **for the complete vertical slice** and records the verdict in the slice document; a feature cannot answer §44.3 or §44.4 alone. This section feeds that assessment instead of duplicating it (`MSC-DEC-239`, closing `CONFLICT-029`).

## 16. Build status — *honest, per surface*

| Surface| Status| Gap|
|---|---|---|
| Melarc Ops| ⚪ not built| Screens `OQ-030`|
| Melarc Rider| ⚪ not built| Notification provider `OQ-048`|
| Melarc Vendor| ⚪ N/A||

## 17. Related

- **Siblings:** [recipient-confirmation](recipient-confirmation.md) · [delivery-run-build](delivery-run-build.md)
- **Next slice:** delivery execution — §25, OTP and payment at the door
- **Slice:** `SLICE-002` in [IMPLEMENTATION_PLAN.md](../../delivery/IMPLEMENTATION_PLAN.md)
