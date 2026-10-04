# Delivery-run build

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.5 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** assembling a draft delivery run — the ready pool, stop selection, sequencing and rider assignment
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §24.3, §24.4, §24.7, and cross-cutting §35.7, §16, §40
> **Slice:** `SLICE-002`

## 1. What this is, and why

Ops opens a draft run, adds eligible stops from the ready pool, orders them by hand, and assigns a rider. **Nothing here dispatches** — that is [atomic-dispatch](atomic-dispatch.md), and the separation is the point.

**Version 1 boundary.** Manual ordering, no route optimisation (§330: *"manual stop ordering… accepted launch simplification"*). Building a run is reversible; dispatching one is not.

## 2. Governing sections

| Section| What it governs here|
|---|---|
| §24.3| The ready pool, lane guards, and what re-checks on adding a stop|
| §24.4| Draft run, rider selection, courier selection, stop ordering, note copying, rider swap|
| §24.7| Outbound third-party service modes and carrier identity|
| §35.7| **Cross-cutting.** Rules 3 and 4: grouping into the right flow; controlled assignment and stop order|
| §16| **Cross-cutting.** Lifecycle placement|
| §40| **Cross-cutting.** Non-functional targets|


## 3. Surfaces and actors

| Surface| Actor| Can do| Gated by|
|---|---|---|---|
| Melarc Ops| Ops Staff| Create a draft run; add stops; order them; assign a rider| `dispatch.run.create`, `dispatch.run.sequence`, `dispatch.run.assign`|
| Melarc Ops| Senior Ops| The same| Same keys|
| Melarc Rider| Rider| **Sees nothing until dispatch.** A draft run is invisible to the rider it names| —|
| Melarc Vendor| Vendor account| **N/A.** A run spans vendors and is never vendor-visible| —|

## 4. Preconditions

- Orders are **confirmed** (doorstep lane) or lane-classified for outbound (§24.3).
- Each order is **payment-cleared or credit-approved** (§24.3, `MSC-DEC-176`).
- The rider is **active**, with a serviceable assigned motorcycle (§34.10).
- A registered courier exists where the outbound mode requires one (§24.4).

## 5. Behaviour

### 5.1 Normal path

1. **Ops opens a draft run** for a service date. No rider, no sequence yet.
2. **Ops adds eligible stops** from the ready pool. **Adding re-checks confirmation, availability and lane compatibility** (§24.3) — eligibility at draft time is not eligibility now.
3. **Ops orders the stops manually.** No optimisation exists.
4. **Refined-location notes are copied** from the confirmation call onto each stop (§24.4).
5. **Ops assigns an active rider** — a separate, separately permissioned act.
6. The run sits `DRAFT` until dispatch.

### 5.2 A run may mix carrier identities and commercial modes

§24.3 and §24.7, `MSC-DEC-154–155` are explicit, and the rule is **counter-intuitive enough to be built wrong by default**:

> A courier run may mix registered and informal handoff-mode stops, and may mix `STATION_DROP` and `MELARC_COVERED_THIRD_PARTY_DELIVERY` commercial-mode stops — **Ops is not required to build separate runs per mode.**

The instinct is to segregate: one run per courier, one per commercial mode. **The specification explicitly removes that constraint**, and an implementation that enforces separation invents work for Ops that Melarc decided not to impose — on every run, every day.

### 5.3 Three moments, three operations

Assignment, dispatch and run start are **distinct**, and collapsing any two loses a rule:

| Moment| Actor| What it governs|
|---|---|---|
| **Assign rider**| Ops| The run has a named rider. Still invisible to them|
| **Dispatch**| Ops| Atomic commit; the rider is notified|
| **Start run**| **Rider**| Work begins. Only the rider does this (§24.6)|

`MSC-DEC-222` established this shape on the pickup side. It applies here symmetrically, and **holders were confirmed on 21 August** as A S P at own hub — restricting assignment to Senior Ops would have made the two halves of the product differ, which is a training cost paid on every officer.

### 5.4 Exception paths

| Path| Behaviour| Error code|
|---|---|---|
| Stop added, order no longer confirmed| Refused on re-check (§24.3)| `VALIDATION_FAILED`|
| Stop added, payment gate no longer clear| Refused (§24.3, `MSC-DEC-176`)| `ORDER_NOT_COMMERCIALLY_CLEARED`|
| Lane incompatible with the run| Refused (§24.3)| `VALIDATION_FAILED`|
| Rider inactive at assignment| Refused (§30.6)| `VALIDATION_FAILED`|
| Rider's motorcycle unavailable| Refused (§34.10)| `VALIDATION_FAILED`|
| Outbound mode requires a courier, none selected| Refused (§24.4)| `VALIDATION_FAILED`|
| Sequencing a dispatched run| Refused. The sequence is fixed at dispatch| `STATE_CONFLICT`|
| Two officers editing one run| One wins; the other sees the conflict (`If-Match`)| `STATE_CONFLICT`|
| Rider swapped before dispatch| Permitted, **re-homing stop routing data** (§24.4)| —|
| Same order added to two runs| Refused. §35.7.5 forbids one order reaching two mechanisms| `STATE_CONFLICT`|

### 5.5 What this feature must never do

- **Never enforce one run per courier or per commercial mode.** §24.3, `MSC-DEC-154–155` explicitly permit mixing. See §5.2.
- **Never trust eligibility recorded at draft time.** §24.3: adding a stop **re-checks**. A confirmation can lapse, a payment gate can close, a rider can go inactive between drafting and adding.
- **Never treat the sequence as a constraint on the rider.** It is a plan. A rider working stops out of order is normal, and the system must record it rather than reject it.
- **Never optimise the route.** §330 records manual ordering as an accepted launch simplification. Automation *"should be introduced only when the data, rules and…"* conditions are met — none of which is met.
- **Never let a draft run be visible to the rider it names.** Dispatch notifies; a draft is Ops working material.
- **Never collapse assignment into dispatch.** Three moments, three rules — §5.3.

## 6. Entities — *pointer*

| Entity| Home|
|---|---|
| `DeliveryRun`, `DeliveryStop`| [domain-model.md](../../contracts/domain-model.md) §6.10|
| `RecipientConfirmation`| §6.10 — supplies the eligibility check and the note|
| `CourierProvider`| §6.9 — named, field detail deferred|

## 7. States — *pointer*

| Machine| Home| States this feature drives|
|---|---|---|
| `DeliveryRun.state`| [state-machines.md](../../contracts/state-machines.md) §12| Creates in `DRAFT`; assignment does not change state|
| `DeliveryStop.state`| §12.1| Creates in `PENDING`|

## 8. Permissions — *pointer*

| Key| Holders| Scope| Home|
|---|---|---|---|
| `dispatch.run.create`| A S P| own hub| [permissions.md](../../contracts/permissions.md) §7|
| `dispatch.run.sequence`| A S P| own hub| §7 — **confirmed `MSC-DEC-232`**|
| `dispatch.run.assign`| A S P| own hub| §7 — **confirmed `MSC-DEC-232`**|

## 9. Settings — *pointer*

None read directly. Pool eligibility depends on the payment gate, not on a setting.

## 10. Errors — *pointer*

`VALIDATION_FAILED`, `STATE_CONFLICT`, `RECIPIENT_PAYMENT_OUTSTANDING` — [errors-and-enums.md](../../contracts/errors-and-enums.md).

## 11. Audit events — *pointer*

| Event| Enhanced?| Home|
|---|---|---|
| `dispatch.run.created`|| [audit.md](../../contracts/audit.md) §5.3|
| `dispatch.run.rider_assigned`|| §5.3|

## 12. API operations — *pointer*

`createDeliveryRun`, `listDeliveryRuns`, `getDeliveryRun`, `setDeliveryStopOrder`, `assignDeliveryRider` — [openapi.yaml](../../contracts/openapi.yaml).

## 13. Acceptance criteria

### `AC-SLICE-002-07` — A run may mix carrier identities and commercial modes

```text
Given eligible outbound orders of both STATION_DROP and MELARC_COVERED_THIRD_PARTY_DELIVERY,
And stops using both a registered courier and an informal carrier,
When Ops adds all of them to one run,
Then every stop is accepted,
And no rule requires separate runs per mode or per carrier,
And the run dispatches as one.
```

**Governs:** §24.3, §24.7, `MSC-DEC-154–155` · **Surface:** Melarc Ops · **Test level:** integration

### `AC-SLICE-002-08` — Adding a stop re-checks eligibility

```text
Given an order that was confirmed and payment-cleared when the run was drafted,
When its confirmation lapses or its payment gate closes before the stop is added,
Then adding the stop is refused,
And the refusal names which check failed,
And eligibility recorded earlier does not carry.
```

**Governs:** §24.3 · **Surface:** Melarc Ops · **Test level:** API · **Code:** `VALIDATION_FAILED`

### `AC-SLICE-002-09` — Assignment is distinct from dispatch

```text
Given a draft run with stops,
When a rider is assigned,
Then the run remains DRAFT,
And the rider cannot see the run,
And the rider receives no notification,
And only dispatch makes it visible to them.
```

**Governs:** §24.4, §24.6, `MSC-DEC-222` · **Surface:** Melarc Ops, Melarc Rider · **Test level:** integration

### `AC-SLICE-002-10` — The sequence is a plan, not a constraint

```text
Given a dispatched run whose stops carry a manual sequence,
When the rider arrives at stop three before stop one,
Then the arrival is accepted and recorded,
And no error is raised for working out of order,
And the recorded sequence is unchanged.
```

**Governs:** §24.4 · **Surface:** Melarc Rider · **Test level:** API

### `AC-SLICE-002-11` — One order cannot join two runs

```text
Given an order already added as a stop on one draft run,
When Ops attempts to add the same order to a second run,
Then it is refused,
And the refusal cites the existing stop,
And no order reaches two dispatch mechanisms.
```

**Governs:** §35.7.5 · **Surface:** Melarc Ops · **Test level:** integration · **Code:** `STATE_CONFLICT`

### `AC-SLICE-002-12` — A rider swap re-homes routing data

```text
Given a draft run assigned to one rider,
When Ops swaps in a different active rider before dispatch,
Then the assignment changes,
And stop routing data follows the new rider,
And the run remains DRAFT.
```

**Governs:** §24.4 · **Surface:** Melarc Ops · **Test level:** integration

## 14. Open questions blocking this feature

| ID| What it blocks here| Type|
|---|---|---|
| ~~`OQ-075`~~| **Closed 21 August** by `MSC-DEC-232` — holders confirmed as proposed| —|
| `OQ-030`| Ready-pool and run-build screens| `ARTIFACT_REQUIRED`|

**No `VALUE_REQUIRED` question blocks this feature.** Run building reads no configured value — eligibility comes from state, not from settings.

## 15. What this feature still owes its slice

**Nothing outstanding.** Every dependency this feature named has closed. It contributes no blocker to its slice's Definition of Ready.

`DeliveryRun` and `DeliveryStop` were **signed on 21 August**, and the permission holders closed the same day. This section previously cited both as open.

**Readiness is not assessed here.** [definition-of-ready.md](../../standards/definition-of-ready.md) assesses it **for the complete vertical slice** and records the verdict in the slice document; a feature cannot answer §44.3 or §44.4 alone. This section feeds that assessment instead of duplicating it (`MSC-DEC-239`, closing `CONFLICT-029`).

## 16. Build status — *honest, per surface*

| Surface| Status| Gap|
|---|---|---|
| Melarc Ops| ⚪ not built| Screens `OQ-030`|
| Melarc Rider| ⚪ N/A until dispatch||
| Melarc Vendor| ⚪ N/A| A run spans vendors|

## 17. Related

- **Siblings:** [recipient-confirmation](recipient-confirmation.md) · [atomic-dispatch](atomic-dispatch.md)
- **Precedent:** [pickup-manifest.md](../pickup/pickup-manifest.md) — the same three-moment shape on the pickup side
- **Slice:** `SLICE-002` in [IMPLEMENTATION_PLAN.md](../../delivery/IMPLEMENTATION_PLAN.md)
