# Carrier handoff

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.6 (cleaned edition)
> **Date:** 4 October 2026
> **Domain:** delivery
> **Owns:** the behaviour and acceptance criteria for the rider's verified handoff of an outbound
> parcel to an approved courier, station or agent — what must be captured, what the capture earns,
> where Melarc's responsibility ends or continues, and what happens when a handoff fails or never
> happens
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §24.7, §34.5, §36.10
> **Slice:** `SLICE-005`

> **Link paths in this document use `../../`** — correct from `features/delivery/<name>.md`.

## 1. What this is, and why

An outbound parcel leaves Melarc's custody at a third party's counter. This feature is the moment
it does: the rider captures **who took it and in which identity mode**, a photograph, and — **for a
registered courier or station** — the waybill they issued, and the platform records that custody
transferred.

**Two identity modes are supported.** A registered courier/station requires its waybill and the mandatory handoff photograph. An approved informal driver/agent requires the photograph and approved identity but no waybill. The `identity_mode` controls the required fields and authorization.


**The two modes diverge here, and `MSC-DEC-181` calls that divergence the single most easily
missed rule in the delivery domain.** For a Station Drop the handoff is the end of Melarc's
service and the moment its fee is earned. For a Melarc-covered delivery it is the middle, and
Melarc stays responsible to a final outcome.

**The act has a before and an after, and both are now specified**. Before it, Ops
clears the paid order for dispatch and System opens the handoff record. After it, a Station Drop
is complete, a covered delivery stays Melarc's until Ops records the outcome, and a counter that
refuses sends the parcel home for a re-dispatch or a Return.

**Version 1 boundary.** No external courier API, no booking, no label, no webhook and no tracking
states (§24.7, `COURIER-007`). This is a manual Melarc-managed record of a physical act.

## 2. Governing sections

| Section| What it governs here|
|---|---|
| §24.4| Run build. Ops *"selects active registered courier where required by outbound mode"* — and since `MSC-DEC-417` a run's courier is checked against the register, at creation and again at dispatch (§24.5)|
| §24.7| Outbound third-party service modes. **Names the approved courier/station registry**, which `MSC-DEC-417` fields as one platform-wide register, with a hub register of approved agents beside it — **for both commercial modes**, because §10's guard names no mode.|
| §24.7.1| Station Drop — Melarc's fee is earned *"only when the mandatory waybill and receipt/handoff photo are recorded against a valid handoff"*, and a failed handoff *"cannot be closed as successful"* — and needs *"a controlled retry, refund, reversal, or correction path"*, which §5.4 and §5.6 now are|
| §24.7.2| Melarc-Covered Third-Party Delivery — Melarc remains responsible *"until final delivery, failure, or return is recorded"*, and Ops now records it (§5.5)|
| §34.5| The concept: an evidence-backed custody transfer with waybill and mandatory photo|
| §36.10| The lifecycle, and the mode-specific terminal rule|
| §35.7.5| Atomic dispatch — one order reaches one destination. **One `PENDING_HANDOFF` record per order at a time**: a failed counter keeps it for the re-dispatch, and a covered `RETURNED` closes it, so a re-dispatch after one opens a second.|
| §40| Non-functional. No new target. The write is classified at the critical tier in [OBSERVABILITY_AND_RECOVERY.md](../../architecture/OBSERVABILITY_AND_RECOVERY.md) §5.3 because custody leaves the platform; the class name lives there rather than here, since no contract or register defines it|

**Decisions that shape this feature:** `MSC-DEC-417` (the path end to end — clearance, the registers, the counter failure, the covered outcomes and the refund), `MSC-DEC-413` (both carrier identity modes), `MSC-DEC-394` (the refund a Return raises), `MSC-DEC-402` (the operation and the entity's fields),
`MSC-DEC-257` (the machine's signature, 26 August 2026), `MSC-DEC-181` (the mode-specific
terminal), `MSC-DEC-392` (the routing class — an operation for an already-signed transition),
`MSC-DEC-398` (the `Evidence` signature this feature's photograph depends on).

## 3. Surfaces and actors

| Surface| Actor| Can do| Gated by|
|---|---|---|---|
| Melarc Rider| Rider| Capture the handoff — who took it, in which identity mode, the photograph, and for a registered courier or station the waybill — for a parcel on their own outbound run| `delivery.handoff.perform`, owned outbound run|
| Melarc Rider| Rider| Fail an outbound stop at the counter, with a `HANDOFF_FAILURE` reason| `delivery.stop.close`, assigned stop|
| Melarc Rider| Rider| Read the handoff record for an assigned stop, and the register's `ACTIVE` entries| `delivery.read`, assigned · `courier.read`, active entries|
| Melarc Ops| Ops Staff, Senior Ops, Platform Admin| Clear a paid outbound order for dispatch, or re-dispatch one| `dispatch.outbound.clear`, own hub|
| Melarc Ops| Ops Staff, Senior Ops, Platform Admin| Read the hub's handoff records, and record a covered-mode outcome| `delivery.read` · `delivery.handoff.outcome`, own hub|
| Melarc Ops| Senior Ops, Platform Admin| Register, deactivate and reactivate couriers and stations| `courier.registry.manage`, all hubs|
| Melarc Ops| Senior Ops, Platform Admin| Approve an informal agent, or withdraw approval| `courier.agent.approve`, own hub|
| Melarc Vendor| Vendor account| Read their own order's handoff| `delivery.read`, own record|
| Recipient channel| —| **N/A.** A recipient has no account and no portal (§49)|  —|

## 4. Preconditions

The order is outbound — `lane = THIRD_PARTY_HANDOFF` with a non-null `commercial_mode` — and **Ops
has cleared it for dispatch**, at which System opened its `PENDING_HANDOFF` record. It sits on a
started run assigned to this rider, and **the rider has arrived at its stop**. Its prepayment gate
is already satisfied, because clearance refuses without it: §24.7.1 requires
the Station Drop fee *"fully paid and backend-confirmed before a rider is dispatched"*, and §24.7.2
the same of the combined amount, so **this feature never collects money and never checks a demand**
— clearance and dispatch already did.

---

## 5. Behaviour

*This section and §13 are the only sections with original content. Everything else points
elsewhere.*

### 5.1 Normal path

1. **Ops clears the paid order for dispatch** with `clearOutboundForDispatch`. It refuses with
   `OUTBOUND_CHARGE_UNPAID` until the outbound charge is backend-confirmed paid; on success the
   order is `READY_FOR_DISPATCH` and **System opens its `ThirdPartyHandoff` at `PENDING_HANDOFF`**,
   snapshotting `commercial_mode` (`MSC-DEC-417`, closing `OQ-139`). The record links to the stop
   when the order joins a run, so `getCarrierHandoff` shows the rider what the stop will require
   before they reach the counter.
2. The rider arrives at the station or the carrier's counter with the parcel, and the stop reads
   `ARRIVED`.
3. **What they capture depends on which carrier identity mode this is**, and Version 1 permits both (`MSC-DEC-413`, closing `OQ-140`). **Always**: **who took it** — the station, carrier or agent as identified there — and **a receipt or handoff photograph**. **For a registered courier or station, additionally the waybill reference** they issued; §24.7.3 and §35.9(9) both scope the waybill to that mode, and `WAYBILL_REQUIRED` has always been catalogued as *registered handoff without a waybill*. The rider names the courier or station from **the register's `ACTIVE` entries**, which the app offers with the run's own courier first where Ops selected one. **An approved informal agent carries no waybill**: the rider names the agent **by phone number**, the server resolves it to an `ACTIVE` agent at the rider's hub whose identity photo is stored, and **the handoff photo stands in for the waybill** (`MSC-DEC-417`, closing `OQ-133`). **The capture declares which mode it is** — `identity_mode` is `REGISTERED` or `APPROVED_AGENT` and is required, because with two modes live a server that inferred the mode from which fields arrived would treat a capture carrying **neither** identity as ambiguous rather than invalid. **Neither mode permits an unapproved third party to receive custody.**
4. The photograph is uploaded first and must reach `STORED`. A record still `PENDING_UPLOAD` may
   not be referenced ([state-machines.md](../../contracts/state-machines.md) §17), so a photo that
   has not finished uploading cannot complete the handoff.
5. `recordCarrierHandoff` writes the capture. The handoff moves `PENDING_HANDOFF → HANDED_OVER`,
   the stop moves to `HANDED_OVER`, and the order moves to `HANDED_TO_CARRIER`.
6. `delivery.handoff.recorded` is emitted, **Enhanced** — custody has left Melarc.
7. **For `STATION_DROP` that is the end.** §24.7.1 completes Melarc's service at verified handoff;
   `HANDED_OVER` is terminal on §10 and `HANDED_TO_CARRIER` is terminal on §9 for this mode. The
   fee captured before dispatch is **earned** at `handed_over_at`. The third party's onward
   delivery is outside Melarc's tracked lifecycle entirely, and the recipient pays them directly.
8. **For `MELARC_COVERED_THIRD_PARTY_DELIVERY` it is not.** §24.7.2 keeps Melarc responsible until
   a final outcome is recorded, and **Ops records it** (§5.5). The covered charge is earned at
   `DELIVERED`, never at handoff (§36.10).
   the order rested at `HANDED_TO_CARRIER`.

**`commercial_mode` is snapshotted at creation and never read live.** It decides whether
`HANDED_OVER` is terminal, which is to say it decides what a closed record means. Reading it from
the order would let an edit months later reopen a completed service.

### 5.2 Exception paths

| Path| Behaviour| Code|
|---|---|---|
| No waybill captured, **registered mode**| Refused. §24.7.1 earns the fee only against one| `WAYBILL_REQUIRED`|
| No photograph, or one not yet `STORED`, **either mode**| Refused. The photo is mandatory (§34.5) and a `PENDING_UPLOAD` record may not be referenced| `EVIDENCE_REQUIRED`|
| **No approved identity** — a registered capture naming an entry that is absent or `INACTIVE`, or an agent capture whose phone resolves to no `ACTIVE` agent at the rider's hub with a stored identity photo| Refused, **in both commercial modes**: [state-machines.md](../../contracts/state-machines.md) §10's row names no mode.| `CARRIER_NOT_APPROVED`|
| Stop not yet `ARRIVED`| Refused. The handoff happens at the stop (§12.1)| `STATE_CONFLICT`|
| Stop not on this rider's run| Refused| `NOT_ASSIGNED_RIDER`|
| Handoff already recorded| Refused; a replay with the same key returns the original| `STATE_CONFLICT`|
| The order has no open handoff record — not outbound, not yet cleared, or its record closed| Not found. The operation transitions a record and never creates one| **404**|
| A declared identity mode whose own identity is missing| Refused, never read as the other mode| `VALIDATION_FAILED`|
| Duplicate / replay| `Idempotency-Key`. One handoff, one audit event, one earning| `IDEMPOTENCY_KEY_CONFLICT`|
| **Handoff refused at the counter**| **The stop fails, not the handoff** — §5.4. The record stays `PENDING_HANDOFF` for a re-dispatch.| `failDeliveryStop` with a `HANDOFF_FAILURE` reason|
| Offline| **N/A.** §19.8 approves one offline command and this is not it. Custody transferring to another party requires a connection|  —|

### 5.3 What this feature must never do

- **Never record a handoff without everything its mode requires.** A registered handoff needs the
  approved entry, the waybill **and** the photo — §24.7.1 earns the fee against a waybill and a
  photo on a valid handoff. An agent handoff needs the approved agent and the photo. A system that
  accepts less earns a fee Melarc did not earn.
- **Never reference a photograph that is not `STORED`.** A client reporting a successful upload
  proves nothing; §17 validates content type, byte size and checksum on the transition.
- **Never accept `commercial_mode` from the client.** A caller able to send it could declare a
  covered delivery a Station Drop and terminate Melarc's responsibility early.
- **Never close a failed handoff as successful** (§24.7.1). A counter that refuses fails the stop
  and leaves the record `PENDING_HANDOFF`; the remedy is a re-dispatch or a Return (§5.4, §5.6).
- **Never charge again for a re-dispatch.** The outbound charge is paid and not yet earned, so a
  re-dispatch after a failed counter or a covered return is at Melarc's cost.
- **Never earn the covered charge at handoff.** It is earned at `DELIVERED` (§36.10).
- **Never serve the approved-agent register to a rider, or an agent's ID photo to a vendor.** The
  rider names the agent by phone and the server resolves it; the register and its identity
  documents stay with Ops.
- **Never let the rider record an outcome.** Every post-handoff state in the covered mode is Ops'
  (§10), and a rider marking a parcel delivered by a third party would be certifying something
  they did not see.
- **Never collect money here.** Both modes are prepaid before dispatch (§24.7.1, §24.7.2). A
  payment step at the counter would be a second charge.

### 5.4 A counter that refuses

The station is closed, the carrier refuses the parcel, the agent is not there, or the recipient's
side will not take this driver. **The stop fails; the handoff does not** (`MSC-DEC-417`, closing
`OQ-134`).

1. The rider fails the stop with `failDeliveryStop` and one of the five **`HANDOFF_FAILURE`**
   reasons ([domain-model.md](../../contracts/domain-model.md) §3.9): `STATION_CLOSED`,
   `CARRIER_REFUSED_PARCEL` (a note is required), `AGENT_NOT_PRESENT`,
   `RECIPIENT_REJECTED_WAYBILL_PRICE` and `VEHICLE_NOT_TERMINATING_AT_DESTINATION` — the last two
   the Product Owner's own, from how informal drivers fail in practice. A `DELIVERY_FAILURE`
   reason on an outbound stop is refused with `REASON_NOT_ACTIVE`, and the reverse on a doorstep.
2. **No delivery attempt is consumed** — a counter is not a doorstep — and **the vendor is not
   notified at the counter**; it hears through the Return flow if Ops decides one.
3. The stop reads `FAILED`. **The handoff record stays `PENDING_HANDOFF`**, the order stays
   `OUT_FOR_DELIVERY`, and **no fee is earned**.
4. The parcel comes home with the run's parcel custody return. When the hub confirms receipt, the
   order reaches `AT_HUB_AFTER_FAILURE` ([state-machines.md](../../contracts/state-machines.md) §9).
5. **Ops re-dispatches or returns.** A re-dispatch is `clearOutboundForDispatch` again, with **no
   new charge**, reusing the same record with its stop link cleared. A Return is §5.6.

**Each reason changes what Ops does next** — the test `MSC-DEC-252` set for admitting one: re-dispatch
when the counter is open, inspect the parcel before anything else, re-arrange the agent, or find a
driver whose price or route suits the recipient.

**An agent Senior Ops will not approve has no reason of its own.** The Product Owner declined one:
*"an unapproved carrier would be recorded only through the contract's
`CARRIER_NOT_APPROVED` refusal, not as a separate stop reason."* If no approved identity takes the
parcel, the stop still fails with a `HANDOFF_FAILURE` reason and the parcel comes home.

### 5.5 The covered mode after handoff

§24.7.2 keeps Melarc responsible *"until final delivery, failure, or return is recorded"*, and **Ops
records it** with `recordHandoffOutcome` under `delivery.handoff.outcome` — Ops Staff, Senior Ops and
Platform Admin at own hub (`MSC-DEC-417`, closing `OQ-135`). **The worklist is
`listCarrierHandoffs`**, filtered to the covered mode and the three states still in a third party's
hands, so an outcome is never recorded only for the orders someone happened to remember.

- **`IN_TRANSIT`** — the third party reports the parcel moving.
- **`DELIVERED`** — the order is `DELIVERED`, and **the covered charge is earned here**, never at
  handoff (§36.10).
- **`FAILED`** — the third party cannot deliver and is bringing the parcel back. **A reason is
  mandatory**, from the `DELIVERY_FAILURE` catalogue, and **no delivery attempt is counted**: no
  Melarc rider stood at a door. **Not terminal.**
- **`RETURNED`** — the parcel is back at the responsible hub. **Custody returns to Melarc** and the
  order reaches `AT_HUB_AFTER_FAILURE`, where Ops re-dispatches at Melarc's cost — a new record
  opens — or starts a Return that owes the whole combined charge back.

**A Station Drop reaches none of these** — its handoff is terminal, and
`TERMINAL_FOR_STATION_DROP` refuses the attempt. **A parcel the third party loses** stays at `FAILED`
until claims are designed (§28.5, `OQ-004`); nothing here invents a claim.

### 5.6 An order that never reaches a counter

§24.7.1 requires a controlled path for a **cancelled** handoff as well as a failed one. **An order
whose record is still `PENDING_HANDOFF` and which goes to Return** — Ops' decision after a failed
counter, or a suspension disposition — **cancels the record**: System moves it to `CANCELLED`.


**The unearned charge is owed back in full.** The Return reverses it as it reverses any delivery
fee, raising one `FinancialAdjustmentRequired` with reason `PAID_OBLIGATION_VOIDED` for what was
paid ([domain-model.md](../../contracts/domain-model.md) §6.14, `MSC-DEC-394`). **A Station Drop fee
is earned only at a verified handoff and a covered charge only at delivery**, so neither is kept
when neither happened. How the money is paid back is `OQ-005`'s.

### 5.7 The two registers

**The courier/station register** is one platform-wide list (§24.7), kept by Senior Ops and Platform
Admin under `courier.registry.manage` at all hubs. An entry is approved while
`ACTIVE`; deactivation and reactivation each take a reason, and neither deletes anything. **A rider
reads its `ACTIVE` entries**, to name the one handed to, and nothing else of it.

**The approved-agent register belongs to a hub.** Hub Senior Ops approves an informal driver or
agent under `courier.agent.approve` — in advance, or on the spot while the rider waits, since agents
*"cannot all be pre-registered"* — recording the name, the phone number and **a
photo of an ID document, which must be stored before the agent can take custody**. Withdrawal takes
a reason and deletes nothing. **A rider never reads this register** and names the agent by phone;
**the ID photo is Ops-only**, whichever record owns it.

**A delivery run's courier is checked against the same register**: a `courier_provider_id` on a run
must name an `ACTIVE` entry when the run is created and again at dispatch (§24.4, §24.5). It is the
plan; the capture records the courier actually handed to (§36.10), and nothing requires the two to
match.

---

## 6. Entities — *pointer*

| Entity| Home|
|---|---|
| `ThirdPartyHandoff`| [domain-model.md](../../contracts/domain-model.md) §6.10 — fielded at `MSC-DEC-402`, completed at `MSC-DEC-417`|
| `CourierProvider`| domain-model.md §6.10 — **the courier/station register**, fielded at `MSC-DEC-417`|
| `ApprovedAgent`| domain-model.md §6.10 — **a hub's approved-agent register**, fielded at `MSC-DEC-417`|
| `Order` (`commercial_mode`, `carrier_identity`, `fulfilment_state`)| domain-model.md §6.7|
| `Evidence`| domain-model.md §3.6 — the mandatory photograph, and an agent's ID photo|
| The `HANDOFF_FAILURE` reasons| domain-model.md §3.9 — five seeded codes|

## 7. States — *pointer*

| Machine| Home| States this feature drives|
|---|---|---|
| `ThirdPartyHandoff`| [state-machines.md](../../contracts/state-machines.md) §10| All of it — creation at clearance (System), the handoff (Rider), cancellation (System) and the four covered outcomes (Ops). **Re-signed 26 September 2026**|
| `DeliveryStop`| state-machines.md §12.1| `ARRIVED → HANDED_OVER`, and `ARRIVED → FAILED` at the counter|
| `Order.fulfilment_state`| state-machines.md §9| `→ READY_FOR_DISPATCH` at clearance, `OUT_FOR_DELIVERY → HANDED_TO_CARRIER`, `HANDED_TO_CARRIER → DELIVERED` or `→ AT_HUB_AFTER_FAILURE` in the covered mode, `OUT_FOR_DELIVERY → AT_HUB_AFTER_FAILURE` after a failed counter, and `AT_HUB_AFTER_FAILURE → READY_FOR_DISPATCH` to re-dispatch. **`HANDED_TO_CARRIER` is terminal for `STATION_DROP` only**|
| `Evidence`| state-machines.md §17| **None** — the photograph is captured through the existing two-phase upload|

**Four machines were amended and re-signed for this feature in one act** — [state-machines.md](../../contracts/state-machines.md) §9, §10, §12.1 and `state-machines.md` §12.2, so every row it drives is signed as it now reads.
signed or re-signed by this feature, both transitions it then drove having been signed before it
existed.

## 8. Permissions — *pointer*

| Key| Holders| Scope| Home|
|---|---|---|---|
| `delivery.handoff.perform`| **Rider only**| owned outbound run| [permissions.md](../../contracts/permissions.md) §7 — existing|
| `delivery.stop.close`| **Rider only**| assigned stop| permissions.md §7 — existing; also the counter failure|
| `dispatch.outbound.clear`| Ops Staff, Senior Ops, Platform Admin| own hub| permissions.md §7 — **new**, `MSC-DEC-417`|
| `delivery.handoff.outcome`| Ops Staff, Senior Ops, Platform Admin| own hub| permissions.md §7 — **new**, `MSC-DEC-417`|
| `courier.registry.manage`| Senior Ops, Platform Admin| **all hubs**| permissions.md §7 — existing; scope widened at `MSC-DEC-417`|
| `courier.agent.approve`| Senior Ops, Platform Admin| own hub| permissions.md §7 — **new**, `MSC-DEC-417`|
| `courier.read`| Ops Staff, Senior Ops, Platform Admin, **Rider**| own hub · active entries| permissions.md §7 — existing; the Rider joins for `ACTIVE` entries at `MSC-DEC-417`|
| `delivery.read`| Ops Staff, Senior Ops, Platform Admin, Rider, Vendor| own hub · assigned · own record| permissions.md §7 — existing|

**Three keys are added at `MSC-DEC-417`**, each for an act that had an actor and no authority:
clearance, the covered outcome and agent approval.
`delivery.handoff.perform` had been in the catalogue since it was written, which was the evidence
that the act was designed and never built.

## 9. Settings — *pointer*

None. The Station Drop fee is `station_drop_fee` ([settings.md](../../contracts/settings.md) §7.2)
and is read at pricing, not here — this feature records that an already-collected fee became
**earned**.

## 10. Errors — *pointer*

| Code| When| Home|
|---|---|---|
| `WAYBILL_REQUIRED`| No waybill captured, registered mode| [errors-and-enums.md](../../contracts/errors-and-enums.md) §5|
| `EVIDENCE_REQUIRED`| No photograph, or not yet `STORED` — either mode| errors-and-enums.md §5|
| `CARRIER_NOT_APPROVED`| No approved identity in the declared mode. **Enforceable from `MSC-DEC-417`**| errors-and-enums.md §5|
| `OUTBOUND_CHARGE_UNPAID`| Clearance before the outbound charge is confirmed paid| errors-and-enums.md §5|
| `TERMINAL_FOR_STATION_DROP`| An outcome recorded against a Station Drop| errors-and-enums.md §5|
| `REASON_REQUIRED` · `REASON_NOT_ACTIVE`| A covered `FAILED` with no reason; a counter failure with a reason from the wrong domain| errors-and-enums.md §4|
| `EVIDENCE_NOT_STORED`| An agent approval naming an ID photo that is not yet stored| errors-and-enums.md §5|
| `HANDOFF_NOT_RECORDED`| The order's transition attempted before the handoff exists| errors-and-enums.md §5|
| `NOT_ASSIGNED_RIDER` · `STATE_CONFLICT` · `VALIDATION_FAILED` · `IDEMPOTENCY_KEY_CONFLICT`| Cross-cutting| errors-and-enums.md §4|

**No error code is added**, at `MSC-DEC-417` either: every refusal the path needs already existed.


## 11. Audit events — *pointer*

| Event| Enhanced?| Home|
|---|---|---|
| `delivery.handoff.recorded`| **Yes**| [audit.md](../../contracts/audit.md) §5.3 — `MSC-DEC-402`|
| `dispatch.outbound.cleared`| No| audit.md §5.3 — `MSC-DEC-417`|
| `delivery.handoff.outcome_recorded`| **Yes**| audit.md §5.3 — `MSC-DEC-417`|
| `delivery.handoff.cancelled`| No| audit.md §5.3 — `MSC-DEC-417`|
| `delivery.stop.failed`| Where money moved| audit.md §5.3 — also the counter failure|
| `courier.provider.registered` · `.deactivated` · `.reactivated`| **Yes**| audit.md §5.3a — `MSC-DEC-417`|
| `courier.agent.approved` · `.withdrawn`| **Yes**| audit.md §5.3a — `MSC-DEC-417`|

**Enhanced on a precedent, not a category.** `fleet.custody.initiated` is Enhanced because custody
movement is a chain-of-custody fact; this is the movement where custody leaves Melarc entirely, and
for a Station Drop the same instant earns the fee.

## 12. API operations — *pointer*

| Operation| Home|
|---|---|
| `recordCarrierHandoff` · `getCarrierHandoff`| [openapi.yaml](../../contracts/openapi.yaml) — `MSC-DEC-402`|
| `clearOutboundForDispatch`| openapi.yaml — `MSC-DEC-417`|
| `recordHandoffOutcome` · `listCarrierHandoffs`| openapi.yaml — `MSC-DEC-417`|
| `failDeliveryStop`| openapi.yaml — existing; takes the counter failure|
| `listCourierProviders` · `registerCourierProvider` · `deactivateCourierProvider` · `reactivateCourierProvider`| openapi.yaml — `MSC-DEC-417`|
| `listApprovedAgents` · `approveAgent` · `withdrawAgentApproval`| openapi.yaml — `MSC-DEC-417`|
| `createEvidence` → `completeEvidenceUpload`| openapi.yaml — existing; every photograph here|

---

## 13. Acceptance criteria

*§43.1 form. Every criterion cites its governing §, decision, or entity invariant.*

### `AC-HANDOFF-01` — all three captures, or none

```text
Given an outbound parcel on this rider's started run,
When the rider submits a capture with identity_mode REGISTERED, a stored photograph and no waybill,
Then the response is 422 WAYBILL_REQUIRED,
And no ThirdPartyHandoff reaches HANDED_OVER,
And no fee is earned,
And the same submission carrying all three is accepted.
```
**Governs:** §24.7.1, §24.7.3, `MSC-DEC-402`, `MSC-DEC-413` · **Surface:** API · **Test level:** integration · **Expected code on rejection:** `WAYBILL_REQUIRED`

**Why:** §24.7.1 earns Melarc's fee *"only when the mandatory waybill and receipt/handoff photo are
recorded against a valid handoff"*. Two of three is not a registered handoff. **Scoped to the registered
mode at `MSC-DEC-413`**, which permits an approved informal agent in Version 1 and puts the waybill where
§24.7.3 and §35.9(9) put it — on the registered mode alone. `AC-HANDOFF-09` covers the other mode.

### `AC-HANDOFF-02` — a photograph still uploading cannot complete a handoff

```text
Given a handoff whose evidence record is PENDING_UPLOAD,
When the rider submits the handoff,
Then the response is 422 EVIDENCE_REQUIRED,
And once the upload completes and the record reads STORED the same submission is accepted.
```
**Governs:** §34.5, state-machines.md §17, `MSC-DEC-398` · **Surface:** API · **Test level:** integration · **Expected code on rejection:** `EVIDENCE_REQUIRED`

### `AC-HANDOFF-03` — a Station Drop completes at the counter

```text
Given an outbound order whose commercial_mode is STATION_DROP,
When the rider records a valid handoff,
Then the ThirdPartyHandoff reads HANDED_OVER and no further transition is available on it,
And the order's fulfilment_state reads HANDED_TO_CARRIER and is terminal,
And handed_over_at is the instant Melarc's Station Drop fee becomes earned,
And no payment is collected by this operation.
```
**Governs:** §24.7.1, `MSC-DEC-181`, `MSC-DEC-402` · **Surface:** API · **Test level:** integration

### `AC-HANDOFF-04` — the mode is the server's, never the client's

```text
Given an outbound order whose commercial_mode is MELARC_COVERED_THIRD_PARTY_DELIVERY,
When a client submits a handoff carrying a commercial_mode of STATION_DROP,
Then the request is rejected as malformed — CarrierHandoffCapture declares
  additionalProperties false and has no commercial_mode property,
And a handoff recorded on that order snapshots MELARC_COVERED_THIRD_PARTY_DELIVERY from the order.
```
**Governs:** `MSC-DEC-181`, `MSC-DEC-402`, domain-model.md §6.10 · **Surface:** contract · **Test level:** contract

**Why:** the mode decides whether `HANDED_OVER` is terminal. A client that could send it could end
Melarc's responsibility for a parcel Melarc still owes.

### `AC-HANDOFF-05` — only the rider carrying it

```text
Given an outbound parcel on another rider's run,
When this rider submits a handoff for it,
Then the response is 403 NOT_ASSIGNED_RIDER,
And an Ops actor holding no delivery.handoff.perform grant is refused with PERMISSION_DENIED,
And no Ops bundle holds that key at any scope.
```
**Governs:** permissions.md §7, `MSC-DEC-402` · **Surface:** API · **Test level:** integration · **Expected code on rejection:** `NOT_ASSIGNED_RIDER`

### `AC-HANDOFF-06` — a recorded handoff earns once, and a replay earns nothing

```text
Given a handoff already recorded against an order,
When the same request is replayed with the same Idempotency-Key,
Then the original record is returned unchanged,
And no second audit event is emitted and no second earning occurs,
And a submission against a record already in HANDED_OVER is refused with STATE_CONFLICT.
```
**Governs:** domain-model.md §7, state-machines.md §10, `MSC-DEC-402` · **Surface:** API · **Test level:** integration · **Expected code on rejection:** `STATE_CONFLICT`

**This is idempotency and the machine's own state guard, not a cardinality rule.** The refusal is
`STATE_CONFLICT` because the record is **already `HANDED_OVER`** — §10 offers no second
`PENDING_HANDOFF → HANDED_OVER`. **How many records an order may carry is now `MSC-DEC-417`'s** —
one `PENDING_HANDOFF` at a time, kept through a failed counter and closed by a covered `RETURNED`,
so a re-dispatch after one opens a second (`AC-HANDOFF-13`, `AC-HANDOFF-16`).
handoff attempts an order may carry was `OQ-134`'s, and this criterion did not pre-decide it.


`STATE_CONFLICT`"*, which read as a per-order cardinality rule the corpus does not approve.
Withdrawn at Rider Four-Pass R1.

### `AC-HANDOFF-07` — an approved carrier identity gates both commercial modes

```text
Given an outbound order in either commercial_mode,
And a handoff naming a carrier approved in NEITHER identity mode — not on §24.7's register, and not an approved agent,
When the rider submits the capture,
Then the response is 422 CARRIER_NOT_APPROVED,
And this holds for STATION_DROP exactly as it holds for MELARC_COVERED_THIRD_PARTY_DELIVERY,
And a handoff naming a registered active courier or station is accepted,
And a handoff naming an approved informal driver/agent is accepted.
```
**Governs:** §24.7, §24.7.3, state-machines.md §10, `MSC-DEC-417` · **Surface:** API · **Test level:** integration · **Expected code on rejection:** `CARRIER_NOT_APPROVED`

**Executable from `MSC-DEC-417`**, which gave both modes their authority: the platform-wide register
for a courier or station, and the hub's approved-agent register for an agent.
executable, there being no register to match against — the position
[accounting-export.md](../payments/accounting-export.md) holds for its generation-gated criteria.

**Why this criterion exists, and why it replaced its own first draft.** The first version of this
feature asserted the opposite — that a Station Drop *needs no* register and is therefore executable
without one. **That was a Product-authority contradiction, not an interpretation.**
[state-machines.md](../../contracts/state-machines.md) §10's guard is *"approved courier or station
captured"* with **no mode distinction**, the row is **SIGNED**, and §24.7 opens by stating that
Version 1 uses a Melarc-managed approved courier/station registry. Changing that to *capture any
station* would have been a new Product rule, which no pass may make. Corrected at
**Rider Four-Pass R1**, before commit.

### `AC-HANDOFF-09` — an approved agent hands off without a waybill

```text
Given an outbound parcel on this rider's started run,
When the rider submits a capture with identity_mode APPROVED_AGENT, the agent's phone number —
  resolving to an ACTIVE agent at the rider's hub with a stored identity photo — a stored
  photograph and no waybill,
Then the handoff reaches HANDED_OVER and WAYBILL_REQUIRED is not raised,
And courier_provider_id is null, which is not a validation failure,
And the order moves to HANDED_TO_CARRIER,
And for STATION_DROP the fee is earned at handed_over_at exactly as for a registered handoff,
And a capture with no evidence is refused with EVIDENCE_REQUIRED in this mode too,
And a capture carrying no identity_mode at all is refused with VALIDATION_FAILED,
And a capture declaring APPROVED_AGENT with no agent_phone is refused with VALIDATION_FAILED
  rather than accepted as a registered handoff,
And an agent who is not validly approved is refused with CARRIER_NOT_APPROVED.
```

**Governs:** §24.7.3, §35.9(9), `MSC-DEC-413`, `MSC-DEC-417`, state-machines.md §10 · **Surface:** API · **Test level:** integration · **Expected code on rejection:** `EVIDENCE_REQUIRED`

**Why:** §24.7.3 requires of this mode *"the approved driver/agent identity and evidence defined by
technical design"* — **identity and evidence, and no waybill.** Version 1 permits the mode,
so a capture that carries what the mode requires must succeed. **Executable from
`MSC-DEC-417`**: an agent is approved while `ACTIVE` in the rider's hub's register with its identity
photo stored, and the capture names it by phone.
approved having no artifact.

### `AC-HANDOFF-08` — a covered handoff is the middle of the delivery, not the end

```text
Given an outbound order whose commercial_mode is MELARC_COVERED_THIRD_PARTY_DELIVERY,
When the rider records a valid handoff,
Then the ThirdPartyHandoff reads HANDED_OVER and is NOT terminal,
And the order reads HANDED_TO_CARRIER and is not terminal,
And no charge is earned by the handoff,
And the record appears in listCarrierHandoffs filtered to the covered mode and HANDED_OVER,
And the rider holds no operation that moves it further.
```
**Governs:** §24.7.2, §36.10, `MSC-DEC-181`, `MSC-DEC-417` · **Surface:** API · **Test level:** integration

**Why:** Melarc stays responsible until the outcome is recorded, and the outcome is Ops' to record —
a rider marking a parcel delivered by a third party would certify what they did not see. The
worklist is what keeps the responsibility visible.
where the contract stops** — no operation could move the record past `HANDED_OVER`,
rewritten at `MSC-DEC-417` when the outcomes were signed.

### `AC-HANDOFF-10` — the record exists from clearance, and clearance waits for payment

```text
Given an itemized outbound order whose outbound charge is not yet backend-confirmed paid,
When Ops calls clearOutboundForDispatch,
Then it is refused with OUTBOUND_CHARGE_UNPAID and no ThirdPartyHandoff exists for the order,
And once the charge is confirmed paid the same call moves the order to READY_FOR_DISPATCH,
And System opens exactly one ThirdPartyHandoff at PENDING_HANDOFF with commercial_mode snapshotted
  from the order,
And getCarrierHandoff returns that record before any run is built.
```
**Governs:** §24.7.1, §24.7.2, state-machines.md §9 and §10, `MSC-DEC-417` · **Surface:** API · **Test level:** integration · **Expected code on rejection:** `OUTBOUND_CHARGE_UNPAID`

**Why:** the record had a consumer and no producer. Opening it at clearance means every
order a rider can be sent with already has it, and the mode snapshot follows payment.

### `AC-HANDOFF-11` — the handoff happens at an arrived stop

```text
Given a PENDING_HANDOFF record whose outbound stop on this rider's started run is not yet ARRIVED,
When the rider submits an otherwise valid capture,
Then it is refused with STATE_CONFLICT and the record stays PENDING_HANDOFF,
And once the rider arrives the same capture is accepted,
And the stop then reads HANDED_OVER, the record HANDED_OVER and the order HANDED_TO_CARRIER.
```
**Governs:** state-machines.md §10 and §12.1, `MSC-DEC-417` · **Surface:** API · **Test level:** integration · **Expected code on rejection:** `STATE_CONFLICT`

### `AC-HANDOFF-12` — a counter that refuses fails the stop, not the handoff

```text
Given this rider at an ARRIVED outbound stop whose counter will not take the parcel,
When the rider fails the stop with the HANDOFF_FAILURE reason STATION_CLOSED,
Then the stop reads FAILED and the order's delivery_attempt_count is unchanged,
And the ThirdPartyHandoff stays PENDING_HANDOFF and the order OUT_FOR_DELIVERY,
And no fee is earned and no vendor notification is sent,
And a DELIVERY_FAILURE reason on the same stop is refused with REASON_NOT_ACTIVE,
And CARRIER_REFUSED_PARCEL without the note it requires is refused,
And once the hub confirms the parcel's custody return the order reads AT_HUB_AFTER_FAILURE.
```
**Governs:** §24.7.1, state-machines.md §9 and §12.1, domain-model.md §3.9, `MSC-DEC-417` · **Surface:** API · **Test level:** integration · **Expected code on rejection:** `REASON_NOT_ACTIVE`

### `AC-HANDOFF-13` — a re-dispatch reuses the record and charges nothing

```text
Given an outbound order at AT_HUB_AFTER_FAILURE after a failed counter, its charge still paid,
When Ops clears it for dispatch again,
Then it reads READY_FOR_DISPATCH, and no new charge, demand or adjustment is raised,
And the same ThirdPartyHandoff is reused at PENDING_HANDOFF with its stop link cleared,
And when the order joins a new run the record links to the new stop.
```
**Governs:** §24.7.1, state-machines.md §9 and §10, `MSC-DEC-417` · **Surface:** API · **Test level:** integration

**Why:** the charge is paid and not yet earned. Charging again would bill the vendor twice for one
Station Drop or one covered delivery.

### `AC-HANDOFF-14` — an order that never reaches a counter owes its charge back

```text
Given an outbound order at AT_HUB_AFTER_FAILURE whose ThirdPartyHandoff is PENDING_HANDOFF,
And whose outbound charge was paid through CONFIRMED receipts,
When Ops commits a Return instead of a re-dispatch,
Then System moves the ThirdPartyHandoff to CANCELLED,
And exactly one FinancialAdjustmentRequired with reason PAID_OBLIGATION_VOIDED records the sum of
  those receipts as owed back,
And no Station Drop fee or covered charge is earned,
And a retried Return commit raises no second adjustment.
```
**Governs:** §24.7.1, state-machines.md §10, domain-model.md §6.14, `MSC-DEC-394`, `MSC-DEC-417` · **Surface:** API · **Test level:** integration

### `AC-HANDOFF-15` — the covered charge is earned at delivery, never at handoff

```text
Given a covered-mode ThirdPartyHandoff at HANDED_OVER,
When Ops records DELIVERED with recordHandoffOutcome,
Then the record reads DELIVERED and the order DELIVERED, both terminal,
And the covered charge is earned at that moment and not before,
And the same call against a STATION_DROP record is refused with TERMINAL_FOR_STATION_DROP,
And a rider calling it is refused with PERMISSION_DENIED.
```
**Governs:** §24.7.2, §36.10, `MSC-DEC-181`, `MSC-DEC-417` · **Surface:** API · **Test level:** integration · **Expected code on rejection:** `TERMINAL_FOR_STATION_DROP`

### `AC-HANDOFF-16` — a covered failure comes home before anything else happens

```text
Given a covered-mode ThirdPartyHandoff at IN_TRANSIT,
When Ops records FAILED with no reason,
Then it is refused with REASON_REQUIRED,
And with a DELIVERY_FAILURE reason the record reads FAILED, is not terminal, and the order stays
  HANDED_TO_CARRIER with delivery_attempt_count unchanged,
And when Ops records RETURNED the record reads RETURNED and the order AT_HUB_AFTER_FAILURE,
And a re-dispatch then opens a second ThirdPartyHandoff at PENDING_HANDOFF with no new charge,
And a Return instead owes the whole combined charge back as in AC-HANDOFF-14.
```
**Governs:** §24.7.2, state-machines.md §9 and §10, `MSC-DEC-417` · **Surface:** API · **Test level:** integration · **Expected code on rejection:** `REASON_REQUIRED`

### `AC-HANDOFF-17` — the register decides a registered handoff

```text
Given a courier or station entry that Senior Ops deactivated with a reason,
When the rider submits a REGISTERED capture naming it,
Then the response is 422 CARRIER_NOT_APPROVED,
And a rider session listing the register receives ACTIVE entries only, and status=INACTIVE from it
  is refused with PERMISSION_DENIED,
And once the entry is reactivated with a reason the same capture is accepted,
And an Ops Staff member registering, deactivating or reactivating an entry is refused with
  PERMISSION_DENIED,
And a delivery run naming the deactivated entry as its courier is refused with VALIDATION_FAILED at
  creation, and rolled back at dispatch.
```
**Governs:** §24.4, §24.5, §24.7, `MSC-DEC-417` · **Surface:** API · **Test level:** integration · **Expected code on rejection:** `CARRIER_NOT_APPROVED`

### `AC-HANDOFF-18` — an agent takes custody only once Senior Ops approves them, with an ID photo

```text
Given an informal agent not approved at the rider's hub,
When the rider submits an APPROVED_AGENT capture with the agent's phone number,
Then the response is 422 CARRIER_NOT_APPROVED,
And an agent approved with no identity photo is still refused the same way,
And an approval naming an identity photo not yet STORED is refused with EVIDENCE_NOT_STORED,
And once hub Senior Ops approves the agent with a stored identity photo the capture is accepted,
And after the approval is withdrawn with a reason a capture resolving to the agent is refused again,
And no rider session can list the approved-agent register,
And the order's vendor cannot retrieve the agent's identity photo.
```
**Governs:** §24.7.3, `MSC-DEC-413`, `MSC-DEC-417` · **Surface:** API · **Test level:** integration · **Expected code on rejection:** `CARRIER_NOT_APPROVED`

**Why:** agents *"cannot all be pre-registered"*, so approval must be possible on the spot — and
none may take custody unapproved. The ID photo is what makes the approval an
identity rather than a name and a number.

---

## 14. Open questions blocking this feature

**None blocks the path.** `OQ-133`, `OQ-134`, `OQ-135` and `OQ-139` closed together at `MSC-DEC-417`,
26 September 2026, and the four machines were re-signed in the same act. Three live questions bound
it without blocking it:

| ID| What it bounds here| Type|
|---|---|---|
| `OQ-004`| **A parcel a third party loses** stays at `FAILED` until claims are designed (§28.5); nothing here invents one| `DECISION_NEEDED`|
| `OQ-005`| **How money owed back is paid** — a Return raises the adjustment (§5.6), and its execution is `OQ-005`'s| `ARTIFACT_REQUIRED`|
| `OQ-030`| The complete page inventory across surfaces. **This feature's screens are written** — the rider's family **N** and the Ops outbound routes — so it no longer blocks here| `ARTIFACT_REQUIRED`|


in both modes, and `OQ-134` and `OQ-135` blocked the covered mode further — **a contract surface
specified, with production execution unavailable**, both operations returning 404 for every order.

## 15. What this feature still owes its slice

**Nothing it can supply itself.** `SLICE-005` has **no slice document** yet
(`delivery/IMPLEMENTATION_PLAN.md` §3), so no Definition of Ready has been run on this feature; that
is the slice's next step, not this feature's.
the failed-handoff disposition, the covered outcome and an Ops view — `OQ-133`, `OQ-139`, `OQ-134`,
`OQ-135` and `OQ-030` — each closed or written at `MSC-DEC-417`.

## 16. Build status — *honest, per surface*

| Surface| Status| Gap|
|---|---|---|
| Melarc Rider| ⚪ not built| Specified end to end — screen family **N** at [rider-android.md](../../surfaces/rider-android.md) §5, the counter failure included. **Nothing is implemented**|
| Melarc Ops| ⚪ not built| Clearance, the covered-outcome worklist and the two registers are inventoried at [ops-portal.md](../../surfaces/ops-portal.md) §7. **Nothing is implemented**|
| Melarc Vendor| ⚪ not built| Reads their own order's handoff under an existing key|
| Recipient channel| N/A| No portal (§49)|

## 17. Related

- [delivery-run-build.md](../dispatch/delivery-run-build.md) — where an outbound run is built and
  its carrier identity and commercial mode are set; this feature executes what that one plans
- [doorstep-delivery.md](doorstep-delivery.md) — the other way an outbound parcel can leave a
  rider's custody, and the one with an OTP
- [itemization.md](../hub/itemization.md) — where `carrier_cost_minor` is transcribed from the
  carrier's waybill at pricing, distinct from the waybill captured here at handoff
- `delivery/IMPLEMENTATION_PLAN.md` §3 — `SLICE-005`, **Outbound third-party handoff**, which depends
  on `SLICE-002` and has no slice document of its own; this is its first feature
