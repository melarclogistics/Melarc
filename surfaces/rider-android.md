# Melarc Rider

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.46 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** navigation, screen inventory and interface states for the native Android field app
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../PROJECT_MASTER_SPECIFICATION.md) §19, §10.1, §10.3, **§41.1, §41.4, §40.5**

## 1. What this surface is

A **native Android application** — explicitly not a web app or PWA (§10.1) — enabling riders to execute assigned pickup and delivery work **with minimal operational ambiguity**, under unreliable connectivity (§19.1).

**Boundary.** Field execution only. No approval, no pricing, no adjudication, no registry access, no unrelated records (§10.1). §19.4 puts it precisely: the rider **sees attempt context without receiving reschedule authority.**

## 2. Access and ownership

§19.2, and the second rule is a security requirement disguised as a UX one:

- Only **active authenticated** riders may use rider actions.
- A rider may access **only runs and stops assigned to that rider**.
- **Unauthorised lookup must avoid revealing whether another rider's record exists.** A "not found" and a "not yours" must be indistinguishable.
- Inactive status blocks protected actions and instructs the rider to contact Ops.

Authentication is registered phone plus private PIN on **one registered device** (§11.2), where the device half is proved by **signing a server challenge** with a non-exportable key, not by sending an identifier.

**The session credential is an opaque Bearer token returned exactly once**, at sign-in, in `RiderSessionIssued` (`MSC-DEC-261`, R1). It is written **only** to OS-backed secure credential storage — never to shared preferences, application logs, crash reports or analytics — and is sent as `Authorization: Bearer`. **Rider requests carry no CSRF token and need none**: a Bearer credential is not attached automatically by a browser, so there is nothing for a cross-site request to ride on.

## 3. Navigation model

§19.3's **Today view** is the primary surface and its structure is specified, not left open.

| Requirement| Detail|
|---|---|
| **Inbound and outbound in distinct blocks**| Not one merged list. §19.3 requires the separation|
| Assigned runs and ordered stops||
| **Next recommended non-terminal stop** identified| Advisory — §21.2 permits out-of-order working|
| Approved stop fields visible| Contact, address, landmark and refined note, zone, delivery-fee payer, amount and payment status, size, handling flags|
| **Run state, stop state, attempt count, hub-return requirement and sync state immediately visible**| All five, at a glance|

**Opening a run must not start it.** A deliberate **Start Run** action changes state (§19.3) — the same two-actor separation the manifest state machine enforces.

| Area| Screens| Features rendered|
|---|---|---|
| **Today**| Inbound block · outbound block · run list| [pickup-manifest](../features/pickup/pickup-manifest.md)|
| **Run**| Stop list · recommended next · start run| [pickup-manifest](../features/pickup/pickup-manifest.md)|
| **Pickup stop**| Sender detail · navigate · collected count · variance reason · handshake · fail| [pickup-collection](../features/pickup/pickup-collection.md), [pickup-failure](../features/pickup/pickup-failure.md)|
| **Hub handover**| One editable row per sender set · pre-filled counts · read-only total · sync state| [hub-intake](../features/hub/hub-intake.md)|
| **Delivery**| Parcel, recipient phone, payer split, amount due, **checkpoint and trip type** · Receive Money · cash · OTP and its fallback · failure · road expense · cash handover| [doorstep-delivery](../features/delivery/doorstep-delivery.md), [delivery-failure](../features/delivery/delivery-failure.md), [cash-collection](../features/delivery/cash-collection.md) — inventoried at §5, families A–M.|

## 4. Offline is narrower than it looks

**This is the correction `CONFLICT-027` made, and it governs this surface more than any other.**

§19.8: *"Currently approved source behaviour exists **only for hub-handover queuing**... **No additional action should be assumed offline-capable until confirmed.**"*

| Action| Offline-capable?|
|---|---|
| Hub handover submission| **Approved** (§19.5, §22.2)|
| Delivery failure, payment recording, OTP verification, hub return, return handover| **Online-only in Version 1**. The wider offline design is **formally deferred to a later version** under §50.4 — an approved deferral, not an omission. Each of these screens must show a clear no-connectivity state rather than queue the act.|
| Collection submission| **Online-only in Version 1** (`MSC-DEC-415` — the ruling is *hub handover only*).|

**Every rider command is still idempotent**, because a command over a flaky connection needs replay safety whether or not it can be composed offline. Idempotency and offline capability are different things, and conflating them was the error.

§19.8 lists what the final offline design must define: local persistence and encryption, client-generated idempotency identifiers, retry order and backoff, conflict and rejection presentation, evidence-upload behaviour, session expiration while queued, device loss and data cleanup.

**Sync state is not an afterthought.** §19.5 requires pending-sync, successful-sync **and actionable rejected-sync** states, and §19.9 forbids **silent dismissal of rejected work**. A rejected action that vanishes is the failure mode this surface most needs to avoid.

### 4.1 The queued hub handover — offline technical design (`MSC-DEC-419`, closing `OQ-027`)

This is the one queued command's technical design that §41.4 requires *"defined in mobile technical design and tested against custody and payment idempotency"* — the six §19.8 items, plus the reconnect-replay correctness §40.2 demands. It governs **`submitHubHandover` alone**; every other rider act is online-only in Version 1.

**1. What is queued.** The handover payload — one row per collected pickup request, and **`captured_at`**, the field time (§35.3.9) — is the durable record. `captured_at` is stamped **at enqueue**, from the device clock, and is never rewritten at sync: it is the time the rider handed over, not the time the server received it.

**2. Local persistence and encryption.** The queued command is persisted in **encrypted local storage**, durable across app restarts and device reboots — the payload names pickup requests and collected counts, and none of it sits in plaintext at rest. The key is wrapped by the **Android Keystore**, bound to the registered device. **The storage requirement is fixed and the library is not.** A **non-exportable Android Keystore AES-256-GCM key**, bound to this app, encrypts the payload and the session token; whether that is layered through an encrypted-preferences wrapper, an encrypted file or SQLCipher is the Frontend Engineer's choice at implementation, **provided** authenticated encryption, no plaintext copy anywhere, and a wipe on sign-out of the token, on replacement and on revocation ([SECURITY_DESIGN.md](../architecture/SECURITY_DESIGN.md) §15.2). The minimum Android version is 24, so the Keystore primitives this needs exist on every supported handset.

**3. A client-generated idempotency key, minted at enqueue.** The `Idempotency-Key` is generated **when the rider submits offline**, persisted **with** the payload, and replayed **unchanged** on every sync attempt across restarts, re-authentications and retries. It is never re-minted. This is what makes a lost acknowledgement safe: the same key on a command the server already processed returns the **original `201`**, not a second handover. `IDEMPOTENCY_KEY_CONFLICT` can arise only from the *same key with a different payload*, which an immutable queued command cannot produce — so it is a defect signal, never an ordinary sync outcome.

**4. No `If-Match` on the queued command.** The run's `ETag` captured when the rider went offline is almost certainly stale by sync time, and sending it would refuse a legitimate queued handover with a spurious `409`. **The queued submit omits `If-Match`** and relies on the signed `IN_PROGRESS → COMPLETED` guard ([state-machines.md](../contracts/state-machines.md) §4) — the real invariant, since a run already `COMPLETED` cannot complete twice (`MSC-DEC-418` approach). Online submits keep `If-Match`; only the queued path drops it, and only because its optimistic-concurrency token cannot stay fresh across an offline window.

**5. Retry order and backoff.** One command type, so ordering is trivial — but stated: **FIFO by enqueue time**, at most one in flight. Retries fire on transient failure (no connection, timeout, `5xx`) with **exponential backoff and a cap**; a definitive `4xx` stops the retry loop and becomes an actionable rejected-sync (item 6). A Melarc outage is never a rider's fault and never consumes anything.

**6. The three sync states (§19.5, §19.9).**
- **`201`, or a same-key replay of it** → **successful-sync**: the intakes opened, and the rider is shown the receipt.
- **`STATE_CONFLICT` where the run is already `COMPLETED`** → **reconcile, do not fail blindly**: the app reads the run (`getPickupManifest` / `listHubIntakes`); if the intakes it queued exist, an acknowledgement was lost and this is **successful-sync**; if they do not, it is an actionable rejected-sync. This is idempotency at the *outcome* level, which is what §40.2 asks for.
- **`NOT_CUSTODY_HOLDER`** (a stranded-run transfer handed the run to another rider while this one was offline, §12.1 family P), **`STOPS_UNRESOLVED`**, **`VALIDATION_FAILED`** → **actionable rejected-sync**: never silently dismissed (§19.9). The rider is told what happened and what to do — resolve the stops, or that the run is no longer theirs to close.

**7. Session expiry while queued.** A queued command **outlives its session**: it is bound to the rider and the registered device, not to the session token. If the session has expired by sync time the rider re-authenticates, and the command syncs under the new session with its `Idempotency-Key` unchanged. Re-authentication never drops or re-mints the queue.

**8. Device loss and cleanup.** On device de-registration or re-registration the local queue is **wiped** — a new device may not replay another's queued custody act. An unsynced handover on a lost device is **not silently lost to the operation**: because §36.9 allows **no overnight rider hold**, the run stays `IN_PROGRESS` and its intakes never open, so the hub sees an unclosed run the next working day and reconciles it — the same missing-declaration backstop `OQ-129` tracks. That no-overnight-hold rule is also why the queue's realistic lifetime is **within the working day**, inside `idempotency_record_ttl_hours` (24) — so the lost-ack replay of item 3 lands on a retained `IdempotencyRecord` in every ordinary case, and the item-8 backstop covers the rest.

**Acceptance criteria for this behaviour are `OQ-030`'s** — the §41.1 map from each offline sync outcome to the test that proves it, which this surface does not yet carry. The design is complete; its criteria are the next debt.

## 5. Screen inventory

**Scope: six slices** — `SLICE-001` pickup through hub itemization in this table and the custody handover below it, then `SLICE-000` authentication, `SLICE-002` delivery runs, `SLICE-003` the doorstep, `SLICE-005` the outbound handoff and `SLICE-006` the return handover, each in its own section below. `OQ-030` remains open on its four-surface scope.

Each row names the route, the permission that gates it, and the states that are **non-obvious for that page** — the nine interface states all apply everywhere and repeating them per row would be noise. What is recorded here is where a state carries a rule.

| Screen| Purpose| Gated by| Operation| States carrying a rule|
|---|---|---|---|---|
| Run list| Today's assigned manifest| assigned rider| `listPickupManifests`| **`empty`** before dispatch is correct, not a failure|
| Run detail| Ordered stops; start the run| assigned rider| `getPickupManifest` · `startRun`| Sequence is **a plan, not a constraint** — working stops out of order must not be blocked. **A run with nothing collected closes by itself** when its last stop turns terminal — there is no handover to offer|
| Stop detail| Vendor, packages, refined-location note| assigned rider| `getPickupManifest` (stops are embedded; there is no stop-read operation) · `arriveAtPickupStop`| **`offline`** — stop data must be readable with no signal|
| Handshake| Display code; trigger SMS fallback| assigned rider| `initiateHandshake` · `requestSmsHandshakeFallback`| The code is **displayed here and nowhere else**. Never logged, never in an audit event|
| Collection| Record collected count, variance reason| assigned rider| `recordCollection` · `listReasonDefinitions`| **Requires connectivity.** §19.8 does **not** approve offline collection; only replay safety on a flaky connection is guaranteed. Zero collected is a **failure**, not a collection|
| Failure| Report a failed stop with reason| assigned rider| `reportPickupFailure` · `listReasonDefinitions`| **`retry`** — must survive a dropped connection at the door|
| Hub handover| Submit one declared count per collected pickup request| custody holder| `submitHubHandover`| **`offline` — the one approved offline command** (§19.8). **One editable row per collected request**, pre-filled from its collected total and **correctable before submit**, with a read-only total. **A zero row is legal and must be deliberate**: it tells the hub that request's parcels are not in the handover, and Senior Ops reviews it. The device's capture time travels with the submission.|

**Seven screens, and one rule spans all of them: the rider never sees a price.** Size class, carrier cost and fee composition belong to itemization at the hub. A doorstep workflow run at speed under blind-count discipline is the least controlled place in the operation to put a revenue decision, and putting one there would also give the rider a reason to discuss price with a vendor — a conversation Melarc does not want at the door.

**Offline is narrower than it looks.** Only **hub-handover submission** is approved for offline capture — not collection. `CONFLICT-027` records the distinction that makes this bite: **idempotency is not offline capability.** An endpoint being safe to retry does not make it safe to queue.

### 5.1 Every operation a rider-held key gates, and where it surfaces

*Added 24 September 2026 by `MSC-DEC-404`, and **derived rather than listed**: the twenty-four
permission keys [permissions.md](../contracts/permissions.md) grants to **R** were extracted, every
operation in [openapi.yaml](../contracts/openapi.yaml) carrying one of them was collected, and each
was traced to the screen family that performs it. **Fifty-one operations. Forty surface here;
eleven are not rider acts**, and each of those eleven says whose act it is and on whose evidence.

**This is the half of §41.1 a surface can satisfy.** §41.1 requires every user action mapped to an
OpenAPI operation **and** an acceptance criterion; the mapping below is the first half, and the
second remains `OQ-030`'s.

| Operation| Key| Where it surfaces|
|---|---|---|
| `acceptRunCustodyHandover`| `fleet.custody.accept`| **P**|
| `arriveAtDeliveryStop`| `delivery.stop.execute`| **B**, **L**|
| `arriveAtPickupStop`| `pickup.run.execute`| Pickup — Stop detail|
| `closeDeliveryStopDelivered`| `delivery.stop.close`| **D**, **E**|
| `closeReturnHandover`| `returns.close`| **O**|
| `createRoadExpense`| `payment.road_expense.record`| **H**|
| `decideDeliveryLocationChange`| `dispatch.recipient_confirmation.work`| Not a rider act — **Ops.** *"Ops authority, never the rider’s"*. The rider records the request at **L**; the Rider holds the key and is refused by standing — `INSUFFICIENT_AUTHORITY`|
| `escalateRecipientConfirmation`| `dispatch.recipient_confirmation.work`| Not a rider act — **Ops.** Escalation is *"Ops judges the contact avenues exhausted"*, and the operation refuses a Rider although the Rider holds the key|
| `failDeliveryStop`| `delivery.stop.close`| **F**, **G**, **L**, **N**|
| `getCarrierHandoff`| `delivery.read`| **N**|
| `getDeliveryRun`| `dispatch.read`| Delivery run detail, and read by **A**–**L**, **O**, **Q**|
| `getParcelCustodyReturn`| `fleet.custody.read`| **Q**|
| `getPaymentCollection`| `payment.collection.read`| **M**|
| `getPickupManifest`| `pickup.read`| Pickup — Run detail, Stop detail|
| `getPickupRequest`| `pickup.read`| Not a rider act — **Ops and Vendor.** The request record behind a manifest stop; the rider reads the stop|
| `getRecipientConfirmation`| `dispatch.read`| **L**|
| `getRunCashSummary`| `payment.run_position.read`| **I**, **J**, **K**|
| `listParcelCustodyReturns`| `fleet.custody.read`| Not a rider act — **Ops.** The hub's parcel-returns queue; a rider reads **its own** return with `getParcelCustodyReturn`, not this list — the same pattern the redelivery list follows|
| `listRunCustodyHandovers`| `fleet.custody.read`| **P**|
| `listApprovedAgents`| `courier.read`| Not a rider act — **Ops.** The approved-agent register, **never served to a rider**: a rider names an agent by phone at the counter and the server resolves it|
| `listCarrierHandoffs`| `delivery.read`| Not a rider act — **Ops.** The covered-mode outcome worklist; a rider reads its own stop's record with `getCarrierHandoff`, never a hub's list|
| `listCourierProviders`| `courier.read`| **N**|
| `getStopPaymentDemand`| `payment.collection.read`| **C**, **M**|
| `initiateHandshake`| `pickup.collection.confirm`| Pickup — Handshake|
| `initiatePaymentCollection`| `payment.momo.collect`| **M**|
| `listDeliveryCommitments`| `delivery.read`| Not a rider act — **Ops and Vendor.** *"The record that answers whether Melarc kept its promise"* — a commitment history, not field work|
| `listDeliveryRuns`| `dispatch.read`| Delivery run list|
| `listOperationalPaymentDemands`| `payment.collection.read`| Not a rider act — **Ops.** *"The Ops Mini POS producer"* — the hub-scoped queue behind the officer’s counter, not a rider view|
| `listPickupManifests`| `pickup.read`| Pickup — Run list|
| `listPickupRequests`| `pickup.read`| Not a rider act — **Ops and Vendor.** Scoped to vendor ownership and hub; a rider works from the manifest, never the request|
| `listReasonDefinitions`| `settings.reason.read`| Pickup — Collection, Failure; **F**, **L**|
| `listRedeliveries`| `delivery.read`| Not a rider act — **Ops and Vendor.** `delivery.read` permits a rider to read it and **no screen needs it**: family **B** names the **trip type** (`INITIAL_DELIVERY` / `REDELIVERY`) and a trip **count** is exactly what this surface refuses to show, since `MSC-DEC-350` sets no maximum and v0.15 removed every *Attempt N of 3*|
| `listRoadExpenses`| `payment.run_position.read`| **H**, **I**|
| `openCashHandover`| `payment.cash.handover`| **J**|
| `openParcelCustodyReturn`| `fleet.custody.return`| **Q**|
| `recordCarrierHandoff`| `delivery.handoff.perform`| **N**|
| `recordCollection`| `pickup.collection.confirm`| Pickup — Collection|
| `recordConfirmationAttempt`| `dispatch.recipient_confirmation.work`| **L**|
| `recordDoorstepContact`| `delivery.stop.execute`| **L**|
| `recordNextStopContact`| `delivery.stop.execute`| **L**|
| `recordRecipientCashPayment`| `payment.cash.collect`| **C**|
| `reportPickupFailure`| `pickup.failure.report`| Pickup — Failure|
| `requestDeliveryLocationChange`| `delivery.stop.execute`| **L**|
| `requestDeliveryOtp`| `delivery.stop.execute`| **D**|
| `requestReturnOtp`| `returns.close`| **O**|
| `requestSmsHandshakeFallback`| `pickup.collection.confirm`| Pickup — Handshake|
| `requestVerificationFallback`| `delivery.stop.execute`| **D**|
| `startDeliveryRun`| `dispatch.run.execute`| Delivery run detail|
| `startRun`| `pickup.run.execute`| Pickup — Run detail|
| `submitHubHandover`| `hub.handover.submit`| Pickup — Hub handover; **P**|
| `verifyHandshake`| `pickup.collection.confirm`| Not a rider act — **Vendor.** *"Vendor account, own stop only"* — the vendor enters the code the rider displays at Pickup — Handshake|

**Nothing here is screened that a rider cannot reach, and that is the point of the third column.**
The eleven exclusions were the risk: a key held by **R** makes an operation *look* like rider work,
and several are refused to a rider outright — by standing (`decideDeliveryLocationChange`,
`escalateRecipientConfirmation`), by actor (`verifyHandshake`), or by scope and session (the Ops-only
lists a rider session never reaches). A screen built from the permission catalogue alone would have
shipped dead buttons.


### 5.2 Every rider operation, and the acceptance criterion that verifies it

*The second half of §41.1, which §5.1 left to `OQ-030`: each rider-surfacing operation traced to the acceptance criterion that proves it, matched by behaviour — a criterion names the act (*"the rider submits a capture"*), not always the `operationId`. **A read carries no §43.1 criterion of its own**: it surfaces data and changes nothing, so it is verified through the write it feeds, named here. `OQ-030` narrows to the two behavioural gaps this table flags and to the other three surfaces' maps.*

| Operation| Verifying acceptance criterion|
|---|---|
| `listPickupManifests` · `getPickupManifest`| **Reads** — the run list and stop detail; verified through `startRun` and `recordCollection`|
| `startRun`| `AC-SLICE-001-14`, `AC-SLICE-001-16`|
| `arriveAtPickupStop`| **Gap** — the arrival transition closes the cancellation window and has no dedicated criterion; `AC-SLICE-001-12` tests the window from assignment, not arrival|
| `initiateHandshake` · `requestSmsHandshakeFallback`| `AC-SLICE-001-23`, `AC-SLICE-001-24`, `AC-SLICE-001-26`, `AC-SLICE-001-73`|
| `recordCollection`| `AC-SLICE-001-20`, `AC-SLICE-001-21`, `AC-SLICE-001-22`, `AC-SLICE-001-29`|
| `reportPickupFailure`| `AC-SLICE-001-30`, `AC-SLICE-001-31`, `AC-SLICE-001-32`, `AC-SLICE-001-33`, `AC-SLICE-001-34`|
| `listReasonDefinitions`| **Read** — the reason pickers (F, L); verified through the reasons the writes accept (`AC-SLICE-001-31`, `AC-SLICE-003-08`)|
| `submitHubHandover`| `AC-SLICE-001-18`, `AC-SLICE-001-44`, `AC-SLICE-001-45`, `AC-SLICE-001-75`, `AC-SLICE-001-76` — its **offline** sync outcomes (§4.1 item 6) are a flagged gap below|
| `acceptRunCustodyHandover` · `listRunCustodyHandovers`| `AC-SLICE-001-67`, `AC-SLICE-001-68` (`listRunCustodyHandovers` the read that finds the handover)|
| `openParcelCustodyReturn` · `getParcelCustodyReturn`| `AC-SLICE-003-44`, `AC-SLICE-003-46`, `AC-SLICE-003-48` (`getParcelCustodyReturn` the read of the return and its variance)|
| `listDeliveryRuns` · `getDeliveryRun`| **Reads** — the run list and detail; verified through `startDeliveryRun` and the doorstep writes they feed|
| `startDeliveryRun`| `AC-SLICE-002-16`|
| `arriveAtDeliveryStop`| `AC-SLICE-003-25` opens the `DOORSTEP` checkpoint the wait runs from; the bare arrival transition is otherwise a flagged gap below|
| `requestDeliveryOtp`| `AC-SLICE-003-02`, `AC-SLICE-003-03`, `AC-SLICE-003-04`|
| `closeDeliveryStopDelivered`| `AC-SLICE-003-01`, `AC-SLICE-003-06`, `AC-SLICE-003-07`|
| `failDeliveryStop`| `AC-SLICE-003-08`, `AC-SLICE-003-26`; `AC-HANDOFF-12` (the outbound counter)|
| `recordDoorstepContact`| `AC-SLICE-003-25`, `AC-SLICE-003-49`|
| `recordNextStopContact`| `AC-SLICE-003-24`|
| `recordConfirmationAttempt`| `AC-SLICE-002-02`, `AC-SLICE-002-21`|
| `requestDeliveryLocationChange`| `AC-SLICE-003-29`; `AC-SLICE-002-05`|
| `getRecipientConfirmation`| **Read** (L) — verified through `AC-SLICE-002-06`, the refined-location note it surfaces|
| `requestVerificationFallback`| `AC-SLICE-003-28`|
| `getStopPaymentDemand` · `getPaymentCollection`| **Reads** — the payment views; verified through `recordRecipientCashPayment` and `initiatePaymentCollection`|
| `recordRecipientCashPayment`| `AC-SLICE-003-13`, `AC-SLICE-003-15`, `AC-SLICE-003-37`|
| `initiatePaymentCollection`| `AC-SLICE-003-36`|
| `getRunCashSummary` · `listRoadExpenses`| **Reads** — the cash and expense summaries; verified through `openCashHandover` and `createRoadExpense`|
| `openCashHandover`| `AC-SLICE-003-40`, `AC-SLICE-003-43`|
| `createRoadExpense`| `AC-SLICE-003-38`, `AC-SLICE-003-41`, `AC-SLICE-003-42`|
| `getCarrierHandoff` · `listCourierProviders`| **Reads** (N) — verified through `AC-HANDOFF-10` (readable from clearance) and `AC-HANDOFF-17` (the register that gates a registered handoff)|
| `recordCarrierHandoff`| `AC-HANDOFF-01`, `AC-HANDOFF-03`, `AC-HANDOFF-05`, `AC-HANDOFF-06`, `AC-HANDOFF-09`, `AC-HANDOFF-11`|
| `closeReturnHandover`| `AC-RETURN-06`, `AC-RETURN-07`, `AC-RETURN-08`, `AC-RETURN-09`|
| `requestReturnOtp`| `AC-RETURN-08`|

**Two behavioural gaps, and they are `OQ-030`'s follow-on:**

- **The offline sync outcomes.** §4.1 designs pending-sync, successful-sync, the outcome-level reconcile on a `STATE_CONFLICT`, and the actionable rejected-sync — and no §43.1 criterion yet exercises them. `AC-SLICE-001-18` covers *"lands once, capture time kept"*; the reconcile and rejected-sync paths are untested.
- **The bare arrival transitions.** `arriveAtPickupStop` (closes the cancellation window) and `arriveAtDeliveryStop` (opens the `DOORSTEP` checkpoint) are exercised by downstream criteria but never asserted on their own.

**Every other rider write has a criterion, and every rider read is verified through the write it feeds.** The remaining §41.1 debt — the Ops Portal, Vendor PWA and recipient-channel maps — stays `OQ-030`'s.

### Run custody-handover screens — `SLICE-001`

**One screen family, P, and it exists for the worst day of a run.** A rider nine stops into twelve,
with collected parcels aboard, breaks down or is injured. Ops opens a `RunCustodyHandover`
naming another active rider or the hub, and **completion authority follows the
parcels**: after acceptance the receiver completes the run and submits the hub handover, and the
original rider may no longer do either.

**The machine is SIGNED** — [state-machines.md](../contracts/state-machines.md) §4.1, 23 August
2026 — and [pickup-manifest.md](../features/pickup/pickup-manifest.md) carries its acceptance
criteria, `AC-SLICE-001-67` and `-68`, one of which names **Melarc Rider** as a surface. **The
rider's half had no screen until 24 September 2026**.

#### P. Taking custody of a stranded run

| Entry condition| Action| Actor · permission| Operation| Next| Error / fallback|
|---|---|---|---|---|---|
| **Named as the receiving rider on a `PENDING` handover**| **Find it** — the handovers this rider is a party to| Rider · `fleet.custody.read`| `listRunCustodyHandovers`| Accept| **Pull, not push.** Nothing alerts the rider at the moment Ops opens it; they find it by opening the app, the same model the delivery run list uses. The record carries the manifest id the next row needs|
| Deciding whether to take it| Read the handover itself — from whom, which run, to where| Rider · `fleet.custody.read`| `listRunCustodyHandovers`| Accept| **The run's stops are not shown, and that is the design rather than a gap.** `PickupManifest` and `PickupStop` stay scoped to the assigned rider, and the receiver does not need them: **Ops** skips the remaining stops|
| At the transfer, parcels counted| **Record what was physically taken**| Rider · `fleet.custody.accept`| `acceptRunCustodyHandover`| Run list, as holder| `NOT_ASSIGNED_RIDER` where this rider is not the named receiver. **The count is a custody record and never a count** — it must not be presented as agreeing with anything, and never seeds the hub blind count (§22.4)|
| Custody accepted| Hand the parcels to the hub| Rider · `hub.handover.submit`| `submitHubHandover`| Hub handover| **Stops worked before the transfer stay attributed to the original rider** (§43.4). **The remaining stops are Ops' to skip** — [state-machines.md](../contracts/state-machines.md) §5 gives `PENDING/ARRIVED → SKIPPED` to Ops — through `skipPickupStop` (`MSC-DEC-412`, closing `OQ-141`), so the run can reach `COMPLETED`.|
| **The original rider, after the transfer**| Shown that the run is no longer theirs to close| —| —| —| `NOT_CUSTODY_HOLDER` on `submitHubHandover`. **The screen must say custody moved**, not show a failure — the rider did nothing wrong|

**A handover that is never accepted changes nothing.** Custody stays with the original rider, the
run stays `IN_PROGRESS`, and Ops may open another (`AC-SLICE-001-68`). **No screen may show a
pending handover as though custody had already moved.**

**The discovery gap is closed** (`MSC-DEC-406`, closing `OQ-136`). A rider named as receiver finds
the handover in a list scoped to the parties, which carries the manifest id `acceptRunCustodyHandover`
requires — until 24 September 2026 that id travelled by telephone, because four approved sources said
the receiver may act and **no operation exposed any of them**.

**What was left was never the rider's, and it is now closed.** `OQ-141`: §5's `PENDING/ARRIVED → SKIPPED` row is **SIGNED**, names **Ops**, and **had no operation** — so after a transfer the remaining stops could not be resolved and `submitHubHandover` refused on `STOPS_UNRESOLVED`. **`MSC-DEC-412` built `skipPickupStop`** at the Ops floor on 25 September 2026, so **the run a custody handover exists to rescue can now be closed**. **The rider still cannot fix it themselves**: no rider bundle holds `pickup.stop.skip`, so the remaining stops are Ops' to skip, as the custody row above says.


### Authentication screens — `SLICE-000`

| Screen| Purpose| Gated by| Operation| States carrying a rule|
|---|---|---|---|---|
| Sign-in| Phone, PIN and a **signed challenge** from the registered handset. **Signing in again replaces any earlier session** (`REPLACED_BY_NEW_SESSION`); the older handset state simply becomes an invalid session and must **not** show a displacement message. **The challenge lives 5 minutes and one attempt consumes it, pass or fail** — a retry fetches a fresh one. **The app also sends `client_root_signal`** (`NOT_DETECTED`, `DETECTED` or `UNKNOWN`) and shows nothing different for any of them; **it asks for no attestation and calls no third party**| **None — pre-auth**| `requestRiderSignInChallenge` · `riderSignIn`| **`offline` is a hard stop** — see below. **`error` must not distinguish** a wrong PIN from an inactive rider from a failed device proof from an unknown phone. **An expired challenge says *start again*, a used one says *this one is finished*** — both are ordinary retries, never a device failure. **`CREDENTIAL_LOCKED` is shown only when the server returns it, which is only to a handset that signed the challenge**: *too many wrong PINs — try again in fifteen minutes, or ask your hub*. A handset that cannot sign can never reach it. `RATE_LIMITED` says *wait a minute*. The PIN field takes **six digits** and refuses anything else before it is sent. **`DEVICE_NOT_ENROLLED` is the one response that sends the rider to *Device blocked***: the server returns it only to a caller who has proved the phone and the PIN and whose device was revoked and not replaced, so showing the screen discloses nothing to anyone else|
| Device enrolment — **scan**| Rider scans the QR on the Ops officer's screen| **None — pre-auth**| — the QR is read on-device; the grant it carries is consumed by the screen below| **Camera permission is requested here and refused gracefully.** A code that is unknown, expired, already used or superseded is **one answer from the server** (`SETUP_GRANT_INVALID`), so the screen says *this code cannot be used — ask the officer for a new one* and **cannot say which**, and sends the rider back to the officer rather than retrying silently|
| First device enrolment| Rider sets their **own** PIN; the handset generates a **hardware-backed signing key** with the QR's attestation challenge and submits its public half and **Key Attestation chain**| **None — grant only, pre-auth**| `completeRiderDeviceEnrolment`| **The PIN is entered by the rider on their own device**, never on the officer's screen. The grant is single-use and the screen must not re-open after it is consumed. **Three refusals, three states**, in section 9.1 — a handset that cannot hold the key, evidence that failed, and a server that could not evaluate it|
| Device blocked| Shown when sign-in returns **`DEVICE_NOT_ENROLLED`** — **and on no other response**: the handset cannot know it is not the registered one, and every other device refusal is the uniform sign-in failure| **None**| — *none of its own: the trigger is `riderSignIn`'s response, and there is no self-service path*| Must explain that **Senior Ops re-registers a device** after verifying the rider in person, and offer no self-service path. **It must not be reachable by guessing**: nothing else the app can see leads here|
| Signed-in home| **The signed-in landing for a build holding `SLICE-000` alone**: the rider's name and hub, and the way to the run list that later slices fill. **Carries the sign-out control every signed-in screen carries**| Rider session| `getCurrentSession` · `signOut`| **Sign-out** calls `signOut`, wipes the stored token and **reads as done even if the session had already ended**. **It does not wipe a queued hub handover** — that command is bound to the rider and the registered device and outlives its session (§4.1 item 7) — **and the screen must warn that a queued handover cannot sync until the next sign-in**. A `401` anywhere else returns to sign-in without saying why|

**Five screens, and no recovery screen exists by design.**

**Enrolment begins by scanning a QR displayed on the Ops officer's screen**. That step is new in R1.1, and without it the screen below had no way to obtain the grant it consumes — the contract issued the credential to nobody. **The rider's own handset receives it directly; the officer never transcribes it.**

**First device enrolment is new in Gate A**. The surface previously had no screen for it, matching a contract that defined re-registration and no first registration — a rider could only become authentication-capable by an administrator writing rows.

**The keypair never appears on any screen.** It is generated in Android secure hardware, the private half is non-exportable, and only the public half leaves the device. There is no screen, and can be no screen, that displays or exports it.

*Original note:* §37.2 routes rider recovery through Ops identity verification; a self-service path would make the one-device binding voluntary.

**Sign-in cannot work offline, and that is an operational constraint rather than a limitation to engineer around.** §19.8 approves exactly one offline command — **hub-handover submission** — and authentication is not it. A rider must obtain a session **before** losing signal.

**The consequence belongs in the runbook, not the code.** A rider who signs out, or whose session expires mid-run in a dead zone, **cannot continue working** — including a queued hub handover, which needs a session to submit against.

**`MSC-DEC-234` answered this directly, and in both halves.** The rider tier gets a **1440-minute** absolute lifetime, comfortably beyond a working day, and **no idle timeout at all** — stated as a rule rather than left as an unset value, precisely so §33.3's fail-visibly requirement does not later halt sign-in over a figure that is supposed to be absent. An idle logout would strand a rider at a door, unable to complete the §19.6 OTP — a Melarc-caused failure that `MSC-DEC-309` says must never cost the customer a physical attempt.

### Delivery-run screens — `SLICE-002`

| Screen| Purpose| Gated by| Operation| States carrying a rule|
|---|---|---|---|---|
| Delivery run list| Today's dispatched runs| assigned rider| `listDeliveryRuns`| **`empty` before dispatch is correct.** A draft run assigned to this rider is **invisible** — it does not appear greyed or pending|
| Delivery run detail| Ordered stops; start the run| assigned rider| `getDeliveryRun` · `startDeliveryRun`| Sequence is **a plan, not a constraint**. Working stops out of order must not be blocked|

**Two screens, and both are `SLICE-002`'s boundary.** Arrival, OTP and payment at the door are `SLICE-003` — **inventoried below at §5's doorstep section**, added at Gate C R1.2.

**A draft run must be invisible, not merely disabled.** Ops assigns a rider before dispatching, and the instinct is to show the rider what is coming. **Assignment is not a commitment** — Ops may swap riders before dispatch (§24.4), and a rider who saw tomorrow's run and then lost it has been told something Melarc did not mean to say.

**HIGH-17 audit remediation (13 September 2026) — how a rider learns a run was dispatched.** By opening the app and finding it on the delivery run list, above — this is a **pull** model: nothing here actively alerts a rider the moment Ops dispatches a run to them, or reassigns one away, or records an urgent recall. No push mechanism is established anywhere in this corpus for this or any other native-app event, and none is invented here. Whether Melarc should build one — and for which events, since not every state change deserves an interrupt — is `OQ-117`, the same undecided question raised from [recipient-channel.md](recipient-channel.md) §6.2 and equally this surface's to answer, not resolved here.

### Outbound handoff screens — `SLICE-005`

**One screen family, N, and it is outbound rather than doorstep.** Added 23 September 2026 by `MSC-DEC-402` and made operable by `MSC-DEC-417`, in the same six-column form the doorstep families use. **It is the only rider act in the inventory that hands a parcel to someone who is not the recipient**, and — for a Station Drop — the only one whose completion earns a fee.

**Why it arrives after the doorstep families rather than with them.** The machine behind it — [state-machines.md](../contracts/state-machines.md) §10 — was **SIGNED on 26 August 2026** with one rider row and no operation, entity, register or screen behind it, so neither outbound mode had a rider execution path at all. The rider audit of 23 September 2026 found it, and `MSC-DEC-417` supplied the rest: the clearance that creates the record, the two registers the guard checks against, the counter-failure path, and the covered mode's Ops-side outcome.

**The record exists before the rider arrives.** Ops clears the paid order for dispatch (`clearOutboundForDispatch`, an Ops act, not shown here), and System opens the `ThirdPartyHandoff` at `PENDING_HANDOFF` then. So the first row below reads a record that is already there — the producer `OQ-139` was missing until `MSC-DEC-417`.

#### N. Carrier handoff

| Entry condition| Action| Actor · permission| Operation| Next| Error / fallback|
|---|---|---|---|---|---|
| Outbound stop on a started run — `lane = THIRD_PARTY_HANDOFF`, the order cleared for dispatch| Open the handoff, read the mode, the destination and what must be captured; **list the register's `ACTIVE` couriers and stations** to name one| Rider · `delivery.read` · `courier.read`| `getCarrierHandoff` · `listCourierProviders`| Capture| **`offline`** for reading. The capture itself requires a connection — custody passes to another party. The register read serves **`ACTIVE` entries only**; the approved-agent register is never served here — the rider names an agent by phone|
| At the counter| **Photograph the receipt or the handover**| Rider · `owner`| `createEvidence` → `completeEvidenceUpload`| Capture| **The photo must reach `STORED` before the handoff will accept it** (§17). A `PENDING_UPLOAD` record may not be referenced, so the screen must show upload progress rather than appear stuck|
| Photo stored| **Capture who took it and in which mode** — a registered courier or station **with its waybill**, or an **approved agent by phone** with no waybill| Rider · `delivery.handoff.perform`| `recordCarrierHandoff`| **A**, next stop| **Version 1 permits both carrier identity modes**: **the waybill field is shown and required only for a registered courier or station**; an agent handoff carries the phone number and the photo instead. **Evidence is mandatory in both.** `WAYBILL_REQUIRED` and `EVIDENCE_REQUIRED` each refuse alone. **`CARRIER_NOT_APPROVED`** refuses a courier not `ACTIVE` on the register or an agent not approved at this hub — enforceable in both modes from `MSC-DEC-417`|
| Counter refuses, or the handoff cannot happen| **Fail the stop with a reason** — station closed, carrier refuses, agent absent, or the recipient rejects the driver's price or route| Rider · `delivery.stop.close`| `failDeliveryStop`| **A**, next stop| A **`HANDOFF_FAILURE`** reason (§3.9): `STATION_CLOSED`, `CARRIER_REFUSED_PARCEL` (a note), `AGENT_NOT_PRESENT`, `RECIPIENT_REJECTED_WAYBILL_PRICE`, `VEHICLE_NOT_TERMINATING_AT_DESTINATION`. **No delivery attempt is consumed**, the handoff record stays `PENDING_HANDOFF`, and the parcel comes home with the run's custody return for Ops to re-dispatch or return|
| Station Drop, captured| Show **handed over, service complete**| —| —| **A**| **Terminal**. The third party's onward delivery is outside Melarc's lifecycle, and the recipient pays them directly — **no screen may offer to track it**|
| Covered delivery, captured| Show **handed over, Melarc still responsible**| —| —| **A**| **Not terminal.** Ops records the outcome afterwards (`recordHandoffOutcome`, not a rider act); the screen must not imply the order is finished, and **no rider screen records the outcome**|

**The rider never sees a price here either**, and this is the one screen where the temptation is real: a Station Drop earns a fee at this exact moment. The rider sees that custody transferred, never what it was worth.

**The family runs end to end from `MSC-DEC-417`**, which is what the rows now show rather than the four gaps they carried before: `OQ-139` had left the first row without a producer, `OQ-133` had left the register check unenforceable in both modes, `OQ-134` had left a counter failure with no path, and `OQ-135` had left the covered mode with no way onward.

### Doorstep screens — `SLICE-003`

**Thirteen screen families, A–M.**

|||
|---|---|
| **Melarc operation**| A named operation in [openapi.yaml](../contracts/openapi.yaml), written and gated by the permission in the same row|
| **Provider flow**| A named **third-party** interaction — Hubtel, MoMo — with **no Melarc endpoint**. Melarc remains authoritative for payment **state**, fallback, manual confirmation and handover authorisation, and each provider flow is followed by a Melarc operation that records the outcome|

**No Melarc endpoint is invented to make a row look complete.** A table that names an operation which does not exist costs an implementer a day and teaches them not to trust the table.

**The rider still never sees a price**. They see an **amount due**, which is a different thing: a figure to collect, not a fee to explain or negotiate.

#### A. Delivery stop list

| Entry condition| Action| Actor · permission| Operation| Next| Error / fallback|
|---|---|---|---|---|---|
| Run is `IN_PROGRESS` and assigned to this rider| Open the ordered stop list| Rider · assigned rider, `dispatch.read`| `getDeliveryRun`| **B** for a selected stop| **`offline`** — the list must be readable with no signal|
| Any stop| Read status, recipient, **amount due and payment state**, attempt count| Rider · assigned rider| `getDeliveryRun`| —| **`stale`** where a commitment was revised mid-run|
| Any stop| Navigate to the address| Rider · assigned rider| **Device flow** — the handset's maps application. No Melarc endpoint| —| Address is readable offline; navigation is not|

**Sequence is a plan, not a constraint.** Stops worked out of order must not be blocked — the same rule the pickup run list carries.

#### B. Stop arrival and detail

| Entry condition| Action| Actor · permission| Operation| Next| Error / fallback|
|---|---|---|---|---|---|
| Stop is `PENDING`, run started| **Mark arrived**| Rider · `delivery.stop.execute`| `arriveAtDeliveryStop`| **C** where money is due, else **D**| `STATE_CONFLICT` where Ops moved the stop; refresh, never silently retry|
| Arrived| Read recipient, **amount due**, payer state, **trip type and prior failed-trip history**, prior failure notes| Rider · assigned rider| `getDeliveryRun`| —| **`offline`** for reading; arrival itself requires connectivity. **No count against a maximum is shown** — none exists|

**Trip history is shown, never edited**, and **it is not a countdown**. A rider sees whether this is an `INITIAL_DELIVERY` or a `REDELIVERY` and what happened on earlier trips; **they are never shown a position against a maximum**, because `MSC-DEC-350` sets none.

#### C. Payment at the door

| Entry condition| Action| Actor · permission| Operation| Next| Error / fallback|
|---|---|---|---|---|---|
| Amount due is **already settled** — prepaid, credit-reserved or no vendor charge| Show **paid**, collect nothing| Rider · assigned rider| —| **D**| A screen that offers collection here invites a second charge|
| Amount due, digital preferred| Initiate Hubtel / MoMo collection| Rider · assigned rider| **Provider flow — Hubtel/MoMo.** No Melarc endpoint; the collection happens at the provider| **pending** until Melarc records an outcome| **Provider unavailable** — offer Merchant MoMo fallback, or cash where enabled|
| Provider unavailable, Merchant MoMo used| Record that the recipient paid the merchant number| Rider · assigned rider| **Provider flow — Merchant MoMo**, then **Melarc operation** `confirmManualPayment`, which is **Ops-side** (`payment.momo.confirm_manual`)| **pending — awaiting Ops**| **A screenshot is not proof**. **The rider cannot confirm their own collection**|
| Cash fallback enabled| Record the cash **actually taken** — short, exact or over| Rider · `payment.cash.collect`| **Melarc operation** `recordRecipientCashPayment`| **D** once the demand is `SETTLED`; **C** for the remainder otherwise| **A short tender is recorded, never refused**: GH₵50 against GH₵55 shows *GH₵50 received in cash, GH₵5 still due*, no fee line paid, and the remainder collectable by cash or Receive Money. **Where a collection is unresolved the Ops grant id is required** and is consumed by this receipt.|
| Payment pending| Wait, or re-check| Rider · assigned rider| **Melarc operation** `getDeliveryRun`| **D** on confirmation| **Handover requires the demand `SETTLED`**, not an attempt succeeding and not a receipt existing. **A GH₵50 receipt against GH₵55 is real money and does not open the door**|

**Payment is resolved before verification.** The order is deliberate: money first, then the OTP that releases the parcel.

**Three rows here are not Melarc operations**, and the distinction matters at build time: the provider owns the collection, and **Melarc owns the state**. A rider whose provider call succeeded but whose Melarc record did not is the case this surface has to survive, which is why the pending state is explicit rather than optimistic.

#### D. OTP and verification

| Entry condition| Action| Actor · permission| Operation| Next| Error / fallback|
|---|---|---|---|---|---|
| Arrived, payment resolved| **Send OTP** to the recipient| Rider · `delivery.stop.execute`| `requestDeliveryOtp`| Enter-code state| Requires connectivity|
| OTP sent| Enter the code the recipient reads out| Rider · `delivery.stop.close`| `closeDeliveryStopDelivered`| **E**| Wrong code is re-enterable; the code is **never displayed to the rider**|
| Not received| **Resend**| Rider · `delivery.stop.execute`| `requestDeliveryOtp`| Enter-code state| Rate-limited; the screen must say so rather than appearing broken|
| Repeatedly not received — poor network at the recipient's end| **Request Ops fallback**| Rider · `delivery.stop.execute`| `requestVerificationFallback`| **waiting for Ops**| The request is recorded **whether or not it is granted** — a refused fallback used to leave no trace|
| Waiting| Wait| —| —| **approved** or **denied**| The wait state must be explicit. A silent screen sends riders to the phone|
| **Fallback approved**| Complete handover without OTP| **Ops** authorises · `delivery.otp.override`| `authoriseDeliveryWithoutOtp`| **E**| The grant is **Ops-side**. The rider requests; the rider never grants|
| **Fallback denied**| Return to OTP, or fail the stop| Rider · `delivery.stop.execute`| —| **D** or **F**| A denial is an answer, not an error state|

**The rider requests and Ops decides.** `requestVerificationFallback` is the rider-side request only; the authority stays on `delivery.otp.override`, which no rider bundle holds.

#### E. Successful handover

| Entry condition| Action| Actor · permission| Operation| Next| Error / fallback|
|---|---|---|---|---|---|
| Verification complete **and** payment resolved| **Mark delivered**| Rider · `delivery.stop.close`| `closeDeliveryStopDelivered`| **A**, next stop| `STATE_CONFLICT` if already closed — show the closed state, never double-close|
| Evidence required| Capture and attach| Rider · `owner`| `createEvidence` → `completeEvidenceUpload`| **A**| **`retry`** — must survive a dropped connection at the door. A `PENDING_UPLOAD` record may not be referenced|

#### F. Failed delivery

| Entry condition| Action| Actor · permission| Operation| Next| Error / fallback|
|---|---|---|---|---|---|
| Arrived, delivery cannot complete| **Select a reason** from the **active** Delivery Failure Reason Catalog| Rider · `settings.reason.read`| `listReasonDefinitions`| Reason detail| **Not a fixed five-value list**. Inactive and wrong-domain codes are not offered|
| Reason selected| Add the note or evidence the reason requires| Rider · `delivery.stop.close` · `owner`| `createEvidence`| —| A reason requiring a note must not submit without one|
| Reason selected| **See whether this attempt is consumed**| Rider · `settings.reason.read`| `listReasonDefinitions`| —| `consumes_delivery_attempt` is shown **before** submitting. A Melarc outage must not silently cost the customer an attempt|
| Ready| Submit the failure| Rider · `delivery.stop.close`| `failDeliveryStop`| **A**; **G** where Ops later directs a hub return| The selected code is **snapshotted**, so deactivating a reason never makes an old failure unreadable. **No cap exists to reach** — Ops owns what follows|

#### G. Ultimate failure

| Entry condition| Action| Actor · permission| Operation| Next| Error / fallback|
|---|---|---|---|---|---|
| **Ops has directed a hub return**| **Read the instruction to return to hub**| Rider · assigned rider| `getDeliveryRun`| **A**| **No rider self-return initiation exists, by design**, and **no cap triggers this** — an authorised Ops disposition does|
| Awaiting Ops| Show **Ops decision pending**| —| —| —| Return begins when authorised Ops commits a `ReturnRecord`, **never because a counter reached three**|

**There is no Return button on this surface, and there must not be.** A rider who can initiate a return can decide a customer's outcome at the door.

#### H. Road Expense

| Entry condition| Action| Actor · permission| Operation| Next| Error / fallback|
|---|---|---|---|---|---|
| Any time during a run| **Record an expense** — category, amount, **funding source**, receipt photo| Rider · `payment.road_expense.record`| `createRoadExpense`| Expense list| **Funding sources are never mixed**: `COLLECTION_CASH`, `RIDER_PERSONAL`, `COMPANY_FLOAT`|
| Recorded| Read **approval status**| Rider · `payment.run_position.read`| `listRoadExpenses`| —| `CLAIMED` reduces nothing. **Approval alone reduces nothing either** — only application does|
| Approved| Read **whether it was applied**, and to which handover| Rider · `payment.run_position.read`| `listRoadExpenses`| —| `appliedToCashHandoverId` and `appliedAt`; null while unapplied|

**The rider records and never decides.** Approval is `payment.road_expense.approve`, an Ops key.

#### I. Rider cash and run summary

| Entry condition| Action| Actor · permission| Operation| Next| Error / fallback|
|---|---|---|---|---|---|
| Run in progress or complete| Read **expected customer collections**, **confirmed digital**, **gross cash**| Rider · `payment.run_position.read`| `getRunCashSummary`| —| Customer payment and cash custody are **two reconciliations, never collapsed**|
| Same| Read **applied collection-cash expenses** and **expected physical handover**| Rider · `payment.run_position.read`| `getRunCashSummary`| **J**| Expected handover derives from the **applied** total, never from every approved expense|
| Variance open| Read the open variance| Rider · `payment.run_position.read`| `getRunCashSummary`| —| Read-only. **A rider cannot resolve their own variance**|

#### J. Cash handover

| Entry condition| Action| Actor · permission| Operation| Next| Error / fallback|
|---|---|---|---|---|---|
| At the responsible hub, after the run or before workday close| **Declare a total** and name the custody records| Rider · `payment.cash.handover`| `openCashHandover`| Submitted| `HUB_SCOPE_VIOLATION` at the wrong hub. **The declaration is not validated against the sum** — the two figures exist to be compared|
| Submitted| Show **awaiting hub count**| Rider · assigned rider| —| —| **Nothing has moved yet.** A screen implying the hub has the money is wrong until it counts it|
| Hub has counted| Show the **hub's counted result** and the outcome — **clean** or **variance**| Rider · `payment.run_position.read`| `getRunCashSummary`| **K**| Variance is **counted vs system expected**, not counted vs declared|
| Variance open| **Read only**| Rider · `payment.run_position.read`| —| —| Resolution is `payment.variance.resolve`, **held by no rider bundle**|

**Custody transfers when the hub accepts, not when the rider declares**. The rider's screen must not claim otherwise: between opening a handover and the hub counting it, **the money is still the rider's responsibility**.

**This is the one approved offline command's sibling, and it is not itself offline.** §19.8 approves offline capture for **pickup** hub-handover submission. Cash handover requires connectivity.

#### K. Run closure

| Entry condition| Action| Actor · permission| Operation| Next| Error / fallback|
|---|---|---|---|---|---|
| Run worked| Show **route complete** — every stop delivered, failed or returned| Rider · `dispatch.read`| `getDeliveryRun`| —| Three dimensions, shown separately|
| Run worked| Show **custody complete / incomplete**| Rider · `payment.run_position.read`| `getRunCashSummary`| —| Incomplete while any `RiderCashCustody` is not `RECONCILED` or `RESOLVED`|
| Run worked| Show **financial complete / incomplete**| Rider · `payment.run_position.read`| `getRunCashSummary`| —| **The run cannot be financially closed while a variance is open** (§26.3)|
| All three pass| Show **fully closed**| —| —| —| **Closure is the conjunction, never a button.** A screen that lets a rider declare closure makes the guard decorative|
| Run worked| Show **parcels complete / incomplete**| Rider · `fleet.custody.read`| `getParcelCustodyReturn`| **Q**| **A fourth dimension, added at `OQ-129` R1.** Incomplete while any undelivered parcel is still aboard or a return sits `DECLARED` — §36.9 allows no rider overnight hold|

**Four dimensions and one verdict** — route, custody, financial and **parcels**, the last added at `OQ-129` R1 because a run could read *fully closed* with undelivered parcels still in the pannier. A run whose route is complete and whose cash is not is **not closed**, and the surface must say which dimension is holding it — a rider told only *not closed* will call Ops.

#### Q. Handing the parcels back — `SLICE-003`

*Added 24 September 2026 at `OQ-129` R1. `MSC-DEC-408` built the record and **no screen showed the
act**, which is the defect that pass was convened to stop making.*

**The counterpart of family J.** Cash and parcels come home in the same conversation: **J hands over
the money, Q hands over the parcels**, and both are declared by the rider and confirmed by the hub.

| Entry condition| Action| Actor · permission| Operation| Next| Error / fallback|
|---|---|---|---|---|---|
| Route worked, undelivered parcels aboard| Read what is still carried — failed, skipped and held| Rider · `dispatch.read`| `getDeliveryRun`| Declare| **`offline`** for reading. The declaration itself needs a connection — custody passes to another party|
| At the hub counter| **Declare every parcel being handed back**| Rider · `fleet.custody.return`| `openParcelCustodyReturn`| Waiting for the hub| `ORDER_NOT_ON_RUN` where a named order was not on this run. **One open return per run** — `STATE_CONFLICT`. **No custody has moved yet**, and the screen must not say it has|
| Declared| Read the return and its state| Rider · `fleet.custody.read`| `getParcelCustodyReturn`| —| **`DECLARED` means the hub has not confirmed.** The screen shows *waiting for the hub*, never *returned*|
| Hub confirmed| Show **parcels returned, custody transferred**| —| —| **K**| The receiving officer and the instant are the hub's record, not the rider's assertion|
| Hub opened a variance| Show **which parcels the hub did not receive**| Rider · `fleet.custody.read`| `getParcelCustodyReturn`| **K**| **The rider is told, and can do nothing about it here.** Senior Ops dispositions it; **no screen offers a rider a correction**|
| **Confirming the return**| **N/A — not this surface's act**| —| —| —| `fleet.custody.receive` is **held by no rider bundle**. A rider who could confirm their own return could close a run over parcels nobody counted|

**A declared return is not a returned parcel, and the wording matters more here than anywhere in
family K.** §36.9 allows no rider overnight hold, so a rider who reads *returned* and leaves has
been told something the platform does not know yet. **`DECLARED` reads as *waiting for the hub*.**

**The rider never sees a disposition vocabulary.** `RECEIVED_LATE`, `CONFIRMED_NOT_RECEIVED` and
`DECLARATION_CORRECTED` are Senior Ops' words on the Ops Portal; the rider sees which parcels the
hub has and which it does not.

#### L. Recipient-contact checkpoints — `SLICE-003`

**Terminology, and it is not cosmetic** *(Gate C C1.3)*. **No screen shows `Attempt 2 of 3`.** That label meant a contact checkpoint, a call retry and a physical trip interchangeably, and a rider deciding whether to wait or move on needs to know which. Screens show:

| Field| Values|
|---|---|
| **Contact stage**| `PRE_DISPATCH` · `NEXT_STOP` · `DOORSTEP`|
| **Trip type**| `INITIAL_DELIVERY` · `REDELIVERY`|
| **Prior failed physical deliveries**| A count, where operationally useful — **never presented as a budget**|

**No maximum is displayed**, because none exists. A call count may be shown as history; it gates nothing.


`MSC-DEC-346`. **Three chances to reach a person, and the app must label them as such.** No screen shows *attempt 1 / 2 / 3* without naming the checkpoint: the rider needs to know whether a call or a journey is being counted.

| Entry condition| Action| Actor · permission| Operation| Next| Error / fallback|
|---|---|---|---|---|---|
| **`PRE_DISPATCH`** — assigned parcels awaiting confirmation| Read the queue: awaiting · **confirmed by Ops** · confirmed by me · **held at hub**| Rider · `dispatch.read`| **Melarc operation** `getRecipientConfirmation`| —| **Where Ops confirmed, the rider does not call again**. The result is shown, not the task|
| `PRE_DISPATCH`, unconfirmed| **Select an active `PRE_DISPATCH` reason**, call the recipient and record the outcome| Rider · `dispatch.recipient_confirmation.work` · `settings.reason.read`| **Melarc operations** `listReasonDefinitions?checkpoint=PRE_DISPATCH` → `recordConfirmationAttempt`| Cleared, or **held at hub**| The same record Ops writes. **The picker filters server-side** so `REASON_NOT_VALID_FOR_CHECKPOINT` is avoidable rather than discoverable by being refused — **and the set it filters is seeded: four of the five `RECIPIENT_CONTACT` codes are valid at this checkpoint** (`MSC-DEC-409`, closing `OQ-142`).|
| Cleared / held| Read which parcels may be loaded| Rider · `dispatch.read`| **Melarc operation** `getDeliveryRun`| —| **Held parcels are not loaded**. Assigned to a run is not permitted to leave|
| **`NEXT_STOP`** — recipient is the next planned stop| Prompt: call ahead for directions and arrival notice, **selecting an active `NEXT_STOP` reason where the outcome needs one**| Rider · `delivery.stop.execute` · `settings.reason.read`| **Melarc operations** `listReasonDefinitions?checkpoint=NEXT_STOP` → `recordNextStopContact`| **B**, or skip| **Filterable and enforceable**; **four of the five seeded codes are valid at this checkpoint** (`MSC-DEC-409`, closing `OQ-142`).|
| `NEXT_STOP` failed| **Skip and continue the route**| Rider · `delivery.stop.execute`| **Melarc operation** `recordNextStopContact`| **A**, next stop| **The parcel stays with the rider.** No screen may show it as returned to hub while it is in the pannier. **No physical attempt consumed**|
| **`DOORSTEP`** — arrived| Call the recipient| Rider · `delivery.stop.execute`| **Melarc operation** `recordDoorstepContact`| **C** on success| —|
| `DOORSTEP` contact failed| Read the **countdown**| Rider · `delivery.stop.execute`| **Melarc operation** `recordDoorstepContact` starts it| Waiting| **The countdown renders from server time** — `wait_expires_at`, not a local timer. Ops sees the same clock|
| Waiting| Retry the call; Ops may assist| Rider · `delivery.stop.execute`| **Melarc operation** `recordDoorstepContact`| Waiting| **Retries are this checkpoint**, never attempts four, five and six|
| Recipient appears before expiry| Continue the delivery| Rider · `delivery.stop.execute`| **Melarc operation** `arriveAtDeliveryStop` state resumes| **C**| **No failure, no redelivery, no attempt consumed**|
| Wait expired, unrecovered| Mark the **physical delivery attempt** failed| Rider · `delivery.stop.close`| **Melarc operation** `failDeliveryStop`| **A**| `DOORSTEP_WAIT_NOT_ELAPSED` refuses it early. Vendor notified with recipient name and order|
| Recipient asks to reschedule or move the address| **Record the request**| Rider · `delivery.stop.execute`| **Melarc operation** `requestDeliveryLocationChange` · reschedule via Ops| Ops queue| **The rider records and never decides**. No screen offers a rider a date picker or a destination field|

**Nothing in this family lets a rider decide anything a rider should not decide.** They request the OTP fallback and Ops grants it; they record a reschedule and Ops makes it; they record a location change and Ops authorises it; they mark a physical failure and Ops owns what happens to the parcel.

#### M. Receive Money — the Mini POS, `SLICE-003`

`MSC-DEC-352`. **The same engine Ops uses, with a rider's scope.** Every row's Operation is a **Melarc operation**; the provider prompt itself is a **provider flow** on the customer's handset and Melarc has no endpoint in it.

| Entry condition| Action| Actor · permission| Operation| Next| Error / fallback|
|---|---|---|---|---|---|
| Arrived, money may be due| **Load the stop's payment position** — amount due, what it is for, what has been received, whether collection may start| Rider · `payment.collection.read`| **Melarc operation** `getStopPaymentDemand`| **C**| **This is where `payment_demand_id` comes from**. Nothing produced one before, so the next row could not be built. **Opening it five times creates one demand, not five**|
| Payment due at the door| Open **Receive Money** — payer, order, **amount due read-only**, MoMo number| Rider · `payment.momo.collect`| **Melarc operation** `initiatePaymentCollection`| Requesting| **The amount cannot be edited**. The rider confirms a number and nothing else. The request carries **the demand id from the row above** and the payer's number — nothing else|
| Number confirmed| **Requesting payment…**| Rider · `payment.momo.collect`| **Melarc operation** `initiatePaymentCollection`| Awaiting customer| **A second tap does nothing.** One collection, one prompt|
| Provider accepted| **Ask the customer to approve the MoMo prompt on their phone.**| —| **Provider flow** — the customer's own handset| Pending| **Never *enter your PIN here*.** Melarc has no PIN field and never will|
| Unresolved| **Payment is still being checked. Do not request payment again.**| Rider · `payment.collection.read`| **Melarc operation** `getPaymentCollection`| Pending| **`STATUS_UNKNOWN` shows no retry button** — a transmitted, unanswered request is when a second tap debits the customer twice|
| Provider confirmed| **Payment received — GH₵55.**| —| **Melarc operation** `getPaymentCollection`| Handover may proceed| **Only after backend-confirmed `SUCCEEDED`.** No rider screen ever sets paid|
| **Provider confirmed less than the amount due**| **GH₵50 received. GH₵5 still due. Delivery cannot be completed until the full amount is received.**| Rider · `payment.collection.read`| **Melarc operation** `getStopPaymentDemand`| **C**, remainder| **Never *payment failed*** — the money arrived. **No fee line is shown as paid**: under atomic settlement nothing is settled until the total is reached, so *GH₵35 delivery fee paid* would be false|
| Remainder outstanding| **Collect the remainder**| Rider · `payment.momo.collect`| **Melarc operation** `initiatePaymentCollection`| Requesting **GH₵5**| **The server requests the remaining due, not the total again** — a second GH₵55 prompt would take GH₵105 for a GH₵55 delivery. The rider chooses nothing|
| Failed or expired| Retry offered| Rider · `payment.momo.collect`| **Melarc operation** `initiatePaymentCollection`| Requesting| Retry is offered **only from a safely terminal state**|
| Provider unavailable| Offer an approved fallback| Rider · assigned rider| —| **C**, Merchant MoMo or cash| **Not while a collection is unresolved** — the fallback is blocked until the duplicate-payment risk is controlled|
| Collection unresolved, recipient present and willing| **Request Ops assistance**, then read the grant on this stop| Rider · `payment.collection.read`| **Melarc operation** `getStopPaymentDemand`| **C** with the authorisation id| **A rider never authorises this**. Ops issues the grant; the rider reads it and quotes its id on the fallback they take. **It is spent once** — a second use is refused|

**A rider asks for money and never records that it arrived.** No screen here writes a payment state; the backend applies provider truth, and *Payment received* is something the rider is **told**, not something they enter.

### Return-handover screens — `SLICE-006`

**One screen family, O, and it is the OTP the rider gives back.** A returned parcel goes to the
vendor or sender rather than the recipient, and [return-to-vendor.md](../features/returns/return-to-vendor.md)
names the **Rider** as an actor on their own assigned return. The transport is the ordinary
delivery machinery — a `ReturnRecord` placed on a `DeliveryRun`/`DeliveryStop`, never a new one
(§28.4) — so this family is a variant of family D and not a second app.

#### O. Return handover

| Entry condition| Action| Actor · permission| Operation| Next| Error / fallback|
|---|---|---|---|---|---|
| Stop on a started run carrying a `ReturnRecord`| Read the return, its destination contact and its fee state| Rider · `dispatch.read`| `getDeliveryRun`| Send code| **`offline`** for reading, as every stop detail is|
| At the vendor's or sender's counter| **Send the return code** to the recorded vendor/sender contact| Rider · `returns.close`| `requestReturnOtp`| Enter code| `RETURN_FEE_OUTSTANDING` where the fee is an immediate demand and unsettled (`AC-RETURN-06`); a registered vendor on the statement path is **not** gated (`AC-RETURN-07`). **The screen has no destination field** — a rider-supplied number is inexpressible (`AC-RETURN-08`)|
| Code sent| Enter the code the vendor reads out| Rider · `returns.close`| `closeReturnHandover`| Next stop| **The fee gate is re-checked at closure**, so a demand settled in between releases it and one that was not still refuses. `OTP_INVALID` covers wrong, expired or absent — **the same one refusal family D shows**, with the digit count, validity window and attempt limit that [settings.md](../contracts/settings.md) §7.4 sets.|
| Another rider's return| **Refused**| —| —| —| `NOT_ASSIGNED_RIDER` (`AC-RETURN-09`). **A return is assigned like any other stop**|
| Closed| Show **returned to vendor, complete**| —| —| —| **Terminal** (§16.1). The return-completed audit event is emitted and the order's fulfilment machine reaches `RETURNED_TO_VENDOR` — no screen may offer a further action|

**The rider never sees the return fee, the waiver or who bore it.** Those are Ops and vendor
facts (`MSC-DEC-209`, `MSC-DEC-210`; the waiver is §28.4, `MSC-DEC-163`); the rider sees only whether the handover is
released or held, which is the single thing the gate decides at the counter.

**One parameter set governs this code and the doorstep's** — `handover_otp_*`, set at
`MSC-DEC-418` and `MSC-DEC-421` ([settings.md](../contracts/settings.md) §7.4) — because
`requestReturnOtp` mirrors `requestDeliveryOtp` exactly. **Both screens can show a digit count
and a countdown.**
`OPEN`, which left two screens with one unbuildable field.


## 6. The nine interface states

| State| Requirement here|
|---|---|
| `loading`| Fast — a rider at a door cannot wait|
| `empty`| "No runs today" is a legitimate state|
| `validation error`| Inline, short forms, large touch targets (§19.9)|
| `error`| Plain instruction, never a diagnostic|
| `retry`| §41.1. **The most consequential retry surface** — a rider at a door with a failed submission needs one tap, not a re-entry|
| `offline`| **Substantive but narrow** — see §4. Visible network and sync state at all times (§19.9)|
| `stale / conflict`| **The most important state on this surface.** Rejected sync must be actionable and never silently dismissed|
| `success`| Confirms the physical fact recorded, not the HTTP result|
| `permission-restricted`| Inactive rider gets a clear instruction to contact Ops (§19.2)|

## 7. Safety and usability

§19.9 states these as requirements, not preferences:

- Large touch targets, short forms
- **Clear irreversible-action confirmation** — a failed stop is terminal, and the interface must say so before the tap
- Safe defaults and pre-filled context
- **No exposure of irrelevant internal data**
- Visible network and sync state
- **No silent dismissal of rejected work**
- Camera and upload guidance **only where evidence is actually required** — driven by the reason's metadata, not hardcoded
- **Masked recipient data where full values are not required**

## 8. What this surface must never do

- **Never start a run by opening it** (§19.3).
- **Never grant reschedule authority.** The rider sees attempt context and cannot act on it (§19.4).
- **Never let a rider add or substitute a stop** (§35.3.5).
- **Never complete a pickup with zero packages** — that routes to the failure flow (§19.4, `MSC-DEC-120`).
- **Never mark delivered without either a valid OTP or an explicit Ops-authorised verification fallback**, and never before the stop's `OperationalPaymentDemand` is `SETTLED` (§19.6, `MSC-DEC-362`) — a backend-confirmed GH₵50 against GH₵55 is real money and not settlement. **The Rider may request the fallback and can never grant it** — `delivery.otp.override` is held by no rider bundle.
- **Never retain parcels overnight.** A failed attempt returns to the responsible hub after the run (§19.6).
- **Never assume an action is offline-capable** beyond hub handover (§19.8).
- **Never reveal whether another rider's record exists** (§19.2).
- **Never silently drop rejected work** (§19.9).

## 9. Device and platform

Native Android. §41.4 requires optimisation for assigned run execution, **large field controls**, OTP entry, payment status, navigation and contact, evidence capture, custody handoff and poor connectivity — and enforcement of **one registered device with secure local storage**.

**Three parameters are set and one is held**. The **PIN is six digits, numeric** (a fixed constant, [rider-authentication.md](../features/identity/rider-authentication.md)); the **handover OTP is six digits, three wrong attempts, and a 10-minute validity window** ([settings.md](../contracts/settings.md) §7.4; `MSC-DEC-418`, `MSC-DEC-421`) — only the SMS vendor now remains external; and the app is **built, signed and distributed privately through a Melarc-managed internal channel and installed manually** — never through Google Play — with a **server-defined minimum supported version** that makes an update mandatory before a security deadline such as certificate-pin expiry; nothing is pushed to the handset ([SECURITY_DESIGN.md](../architecture/SECURITY_DESIGN.md) §15.2). **The minimum Android version is 24 (Android 7.0)** — the lowest level at which a key can be generated with an attestation challenge, so below it production enrolment is impossible; **a technical floor derived from the attestation requirement, not an operational one** ([SECURITY_DESIGN.md](../architecture/SECURITY_DESIGN.md) §15.2). **Whether an operational floor above 24 is wanted** is held pending real rider-device data and **stays `OQ-073`'s**; it would decide what the camera and the queue may assume above it. **Secure local storage is a non-exportable Android Keystore AES-256-GCM key**, and the library layered on it is the Frontend Engineer's choice (§4.1 item 2).

**§40.5 client baseline, to be defined and tested:** supported Android versions, device registration, local security, camera, location and storage requirements, background work, offline queue, and **app-update distribution**. The last is easily forgotten and matters for a field app that cannot be refreshed by reloading a page.

The Rider client baseline and remaining device/release inputs are described in this document’s open requirements and the deployment specification. Use the current Android floor and security controls stated here.

§41.4 closes by requiring exact offline actions and sync/conflict policy to be defined in mobile technical design and **tested against custody and payment idempotency**. **The exact offline actions are settled** — hub handover alone — and **the sync and conflict policy for that one act is written at §4.1** (`MSC-DEC-419`, closing `OQ-027`).

**§41.1 requires every user action mapped to an OpenAPI operation and an acceptance criterion.** **The operation half is done** — §5.1 maps every operation a rider-held key gates, each to a screen family or to the actor whose act it is, derived from the permission catalogue and the contract rather than listed by hand; §5.1 holds the count. **The acceptance-criterion half is not**, and remains part of what `OQ-030` owes.

### 9.1 Device trust — attested at enrolment, proven at sign-in; root detection recorded, never blocking

*Rewritten 1 October 2026. Added on 14 September by `MSC-DEC-387` as* Device integrity at sign-in*; the integrity evidence is now checked once, at enrolment and replacement, and not at sign-in.*

**The key is attested when the device is enrolled.** The handset generates a **hardware-backed signing key** in the Android Keystore — `TrustedEnvironment` or `StrongBox`, StrongBox not required — using the attestation challenge the enrolment QR carries, and submits its **Key Attestation chain** beside the public key. **The server decides; the app never judges its own evidence.** A handset that cannot produce such a key shows the unsupported-device state **without calling the server**, and one the server finds unsupported is refused with `DEVICE_SECURITY_UNSUPPORTED`. **The app contains no Google Play dependency and reads no installer identity**.

**Sign-in attests nothing.** The app signs the server's single-use challenge with the registered key and sends phone, PIN, the signature and `client_root_signal`, and **calls no third-party service** ([SECURITY_DESIGN.md](../architecture/SECURITY_DESIGN.md) §15.2).

**Root detection runs at sign-in, records and blocks nothing.** The app checks `su` binary presence, test-keys build fingerprint, known rooting package signatures and a writeable `/system`, sends the result as **`client_root_signal`** — `NOT_DETECTED`, `DETECTED`, or **`UNKNOWN` when it could not establish one** — and **proceeds either way**. The result is recorded on the session and in the audit trail for Ops follow-up. **A rider on a rooted or modified handset can sign in and work.** `NOT_DETECTED` is not evidence of trust, and the signal can neither permit nor deny authentication.

**Nothing here may refuse a rider mid-run.** After sign-in nothing calls an attestation service, so an outage cannot strand a rider, and **no live session is invalidated because attestation infrastructure is unreachable**. [state-machines.md](../contracts/state-machines.md) §9 names the **Rider** as the only actor for both exits from `OUT_FOR_DELIVERY`, so an app that refused at evidence upload or payment recording would strand a parcel no one can move.

**Interface states.** Root detected is **not** an error state and shows no blocking dialog. **At sign-in no integrity state exists.** At enrolment and replacement there are three refusals, and they must not be merged:

- **`DEVICE_SECURITY_UNSUPPORTED`** is a terminal state — *this handset cannot hold the key production needs; see Senior Ops* — and **offers no workaround**.
- **`DEVICE_INTEGRITY_FAILED`** is a refusal — *the device could not be verified; contact Ops* — and **never names the cause**, which would coach an attacker and mislead an honest rider whose evidence failed for another reason.
- **`TRUST_DATA_UNAVAILABLE`** — a `503` with a `Retry-After`, which is what stale or not-yet-loaded trust data looks like — says *try again shortly*, is neither of the two above, and **leaves the grant good, so the handset retries the same enrolment**. `SETUP_GRANT_INVALID` sends the rider back to the officer.

## 10. Open questions

| ID| Effect here| Type|
|---|---|---|
| ~~`OQ-027`~~| **Closed 28 September 2026 by `MSC-DEC-419`** — the offline-queue technical design for the one queued command (hub handover) is written at §4.1, covering all six live §19.8 items and the reconnect-replay correctness §40.2 demands. **The storage requirement is fixed — a Keystore AES-GCM key — and the library is the Frontend Engineer's choice**; it no longer waits on `OQ-073`.| `ARTIFACT_REQUIRED`|
| `OQ-030`| Page and route inventory. **Narrowed again 24 September 2026**: every operation a rider-held key gates is now mapped at §5.1, and the two families that had none — **O** the return handover and **P** the custody accept — are written. What this surface still owes the question is the **acceptance-criterion half of §41.1**, and the question's own scope is four surfaces, of which two carry no inventory at all| `ARTIFACT_REQUIRED`|
| `OQ-073`| **The §40.5 client baseline** — supported Android versions, local security, camera, storage, background work, offline queue and app-update distribution. **Narrowed at Gate PD-3R1:** the technical floor is **24** and the storage requirement is a Keystore AES-GCM key with the library left to engineering, so **neither the floor nor the storage API waits on this question any more**. What stays is whether an **operational** floor above 24 is wanted, from real rider-device data, **together with** the rest of each surface's baseline. Listed here from 24 September 2026; the register has owned it since 21 August. **The Rider security capability is now named**: hardware-backed Keystore Key Attestation at `TrustedEnvironment` security or better, StrongBox accepted and not required — what remains is an operational floor above 24| `ARTIFACT_REQUIRED`|
| `OQ-074`| **The operation-to-screen map §41.1 requires of each frontend.** Narrowed 24 September 2026: §5.1 here maps every operation a rider-held key gates, so a contract change can be traced to the rider screens it breaks. **Open on the three surfaces with no mapping**; the acceptance-criterion half of §41.1 is `OQ-030`'s. Listed here from 26 September 2026; §11 counted it and this table did not| `ARTIFACT_REQUIRED`|
| `OQ-117`| **Whether any time-sensitive event deserves an active push, email or SMS alert.** This surface is **pull-only**: a rider learns of a dispatched or reassigned run, and of a custody handover naming them, only by opening the app (§3). Which events, what mechanism, and what retry or fallback are unanswered, and no figure is invented for them. Listed here from 26 September 2026; §11 counted it and this table did not| `ARTIFACT_REQUIRED`|
| ~~`OQ-136`~~| **Closed 24 September 2026 by `MSC-DEC-406`** — `listRunCustodyHandovers` gives a named receiver the handover and its manifest id, and the run read is deliberately **not** widened because the receiver does not need it| —|
| ~~`OQ-141`~~| **Closed 25 September 2026 by `MSC-DEC-412`** — `skipPickupStop` exists, gated by the new `pickup.stop.skip` at the Ops floor, so **a transferred run can be completed**: Ops resolve the stops the receiver cannot, and `submitHubHandover` stops refusing on `STOPS_UNRESOLVED`. **No rider screen changes and no rider holds the key** — a rider who could skip a stop could choose which customers to serve| —|
| ~~`OQ-137`~~| **Closed 24 September 2026 by `MSC-DEC-405`** — `ASSIGNED` is removed from `PickupManifest.state` and the contract now carries the signed machine's five. **The run list and run detail render five states**, and rider assignment is a field update that leaves a manifest `DRAFT` until dispatch| —|
| ~~`OQ-138`~~| **Closed 24 September 2026 by `MSC-DEC-407`** — `validCheckpoints` is fielded and `listReasonDefinitions` gains `domain` and `checkpoint`, so the pickers filter server-side instead of fetching the whole catalogue| —|
| ~~`OQ-142`~~| **Closed 25 September 2026 by `MSC-DEC-409`** — the catalogue is seeded at five, so the pickers have something to filter. **Family **L** offers four at `PRE_DISPATCH` and `NEXT_STOP`** — `NO_ANSWER`, `NUMBER_INCORRECT`, `RECIPIENT_DECLINED`, `CONTACT_NOT_POSSIBLE_MELARC` — **and five at `DOORSTEP`**, where `RECIPIENT_NOT_AT_LOCATION` is also valid. **No picker shows `consumes_delivery_attempt` for a contact reason**: it is `false` on all five and nothing reads it here, so a screen displaying it would imply a cost that does not exist| —|
| `OQ-048`| The SMS/notification **vendor** contract. **All three OTP parameters are now set** — `handover_otp_length` (6), `handover_otp_max_wrong_attempts` (3) at `MSC-DEC-418` and `handover_otp_ttl_minutes` (10) at `MSC-DEC-421` — so families **D** and **O** build to a digit count and a countdown. What remains is external: which SMS provider, and its delivery SLA and rate limits (like `OQ-109`'s Hubtel contract).| `EXTERNAL_INPUT`|
| ~~`OQ-133`~~| **Closed 26 September 2026 by `MSC-DEC-417`** — the courier/station register and the hub's approved-agent register exist, so `CARRIER_NOT_APPROVED` fires in both modes| `ARTIFACT_REQUIRED`|
| ~~`OQ-139`~~| **Closed 26 September 2026 by `MSC-DEC-417`** — System opens the record when Ops clears the order for dispatch, so family N's first row has a producer| `ARTIFACT_REQUIRED`|
| ~~`OQ-134`~~| **Closed 26 September 2026 by `MSC-DEC-417`** — a counter failure fails the stop with a `HANDOFF_FAILURE` reason; the parcel comes home for a re-dispatch or a Return| `ARTIFACT_REQUIRED`|
| ~~`OQ-135`~~| **Closed 26 September 2026 by `MSC-DEC-417`** — `recordHandoffOutcome` under `delivery.handoff.outcome` carries the covered mode's four outcomes, and §9 and §10 were re-signed| `ARTIFACT_REQUIRED`|
| —| **All operational intervals bearing on this surface are set** — `doorstep_wait_minutes` 10 for the delivery doorstep, `rider_door_wait_minutes` 10 for the pickup door, session lifetime 1440, no idle timeout by rule| —|

## 11. What this surface still owes its slices

*A surface carries no readiness verdict (`MSC-DEC-423`, extending `MSC-DEC-239`): the slice's Definition of Ready, area D, judges whether this surface is specified well enough for that slice. This section lists what is still owed.

*Re-derived 24 September 2026 at Rider Four-Pass R1, and the count corrected at R1.1. The previous wording named `OQ-027` as **the** blocker, which was true before Rider Passes 1 and 3 and this remediation added seven more questions to this surface.*

The Today-view structure, access rules, safety requirements, the offline boundary and — since §5.1 — the map from every rider-held key to the screen that uses it are complete and citable. **Five live questions now bear on this surface, and none of them is a Product decision.** Counted from the rows below, which name `OQ-030`, `OQ-048`, `OQ-073`, `OQ-074` and `OQ-117` — **four `ARTIFACT_REQUIRED` and one `EXTERNAL_INPUT`**. **`OQ-113` closed on 1 October 2026 at `MSC-DEC-427`** and leaves the list.

|| What it still owes|
|---|---|
| ~~**`OQ-027`**~~| **Closed at `MSC-DEC-419`** — the offline-queue technical design is written (§4.1); the storage requirement is fixed and the library is engineering's.|
| **`OQ-073`**| The rest of the Android baseline: the technical floor is **24** and the storage requirement is fixed, so what is owed is whether an **operational** floor above 24 is wanted, from real rider-device data, and the camera, location and background-work baselines|
| ~~**`OQ-113`**~~| **Closed at `MSC-DEC-427`** — Key Attestation at enrolment and replacement, proof of possession at sign-in; section 9.1 now builds to a settled design. `OQ-073` carries the Rider security capability it needs|
| **`OQ-048`**| The SMS vendor contract alone: families **D** and **O** build to a digit count and a countdown, and what remains is which provider delivers the code|
| **`OQ-030`** · **`OQ-074`** · **`OQ-117`**| Narrowed here and open on their four-surface scope; and whether any event deserves a push at all|

**No single question closes this list.** With `OQ-027`'s offline design written, **`OQ-073`, the operational Android floor, is now the one that would change the most** — it decides what the camera and the queue may assume above the technical floor of 24. **Seven of the original thirteen were raised by this programme of work** — `OQ-133`–`OQ-135` at Rider Pass 1, `OQ-136`–`OQ-138` at Rider Pass 3, and `OQ-139` at Rider Four-Pass R1 — and every one of them would otherwise have been found by an implementer rather than by a reviewer. **Five have since closed**: `OQ-137` at `MSC-DEC-405`, and `OQ-133`, `OQ-134`, `OQ-135` and `OQ-139` together at `MSC-DEC-417`, which made family **N** an operable path.

## 12. Related

- **Up:** [overview.md](overview.md)
- **Down:** [pickup-manifest](../features/pickup/pickup-manifest.md) · [pickup-collection](../features/pickup/pickup-collection.md) · [pickup-failure](../features/pickup/pickup-failure.md) · [hub-intake](../features/hub/hub-intake.md)
- **Authority:** [contracts/domain-model.md](../contracts/domain-model.md) §7 for the offline table this surface implements
