# Pickup Failure

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.6 (cleaned edition)
> **Date:** 4 October 2026
> **Domain:** `pickup`
> **Owns:** the behaviour and acceptance criteria for failing a pickup stop, and the Ops decision that follows
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §21.5, §21.6, §35.4, §36.4
> **Slice:** `SLICE-001`

## 1. What this is, and why

Not every stop succeeds. This feature records **why**, preserves the evidence, and routes the request to an Ops decision — reschedule, cancel, or escalate.

**Version 1 boundary.** Physical failure is **terminal for the stop**. It is never undone; a retry is a *new* request cloned from the old one, and the chain is the evidence. There is **no vendor self-service dispute form** (§21.5, `MSC-DEC-122`) — a vendor contacts support, and contact alone reverses nothing.

## 2. Governing sections

| Section| What it governs here|
|---|---|
| §21.5| The four fixed categories, required note, optional contact attempts and evidence, terminality|
| §21.6| Ops resolution: reschedule as cancel-plus-clone, the cap, force-extension, the backstop|
| §35.4| Failure and rescheduling rules — attempt chain, replacement links, force-extension authority|
| §36.4| Stop states|


## 3. Surfaces and actors

| Surface| Actor| Can do| Gated by|
|---|---|---|---|
| Melarc Rider| Rider| Fail an **owned dispatched** stop with a category, reason note, optional contact attempts and evidence| `pickup.failure.report` — owned dispatched stop only|
| Melarc Ops| Ops Staff| Work the decision queue: reschedule, cancel, escalate| `pickup.failure.resolve`|
| Melarc Ops| Senior Ops| All Ops actions, plus force-extension past the cap| `pickup.attempt.extend`|
| Melarc Vendor| Vendor account| **Receives the notification only.** No self-service dispute form exists in V1 (§21.5, `MSC-DEC-122`)| —|
| Recipient channel| —| **N/A**| —|

## 4. Preconditions

- The stop is `ARRIVED` on an `IN_PROGRESS` manifest, and belongs to the acting rider.
- Or: a collection attempt produced **zero packages**, which routes here by rule (§21.3).

---

## 5. Behaviour

### 5.1 Normal path

1. **The rider fails the stop**, submitting:
   - **one fixed category** — `VENDOR_UNAVAILABLE`, `ACCESS_DENIED`, `PARCEL_NOT_READY`, or `REFUSED_COLLECTION` (§21.5)
   - a **required reason note**
   - optional contact attempt — method, outcome, wait, note
   - optional evidence photo
2. **The stop becomes `FAILED`. This is terminal** (§21.5).
3. **The linked request enters an Ops decision context.**
4. **Ops decides** (§21.6): reschedule by cancelling the source and creating a new `PENDING` clone; cancel without clone; or escalate.
5. **A clone increments `attempt_number`** and carries approved metadata. The chain is traversable through `replaces_request_id`.

### 5.2 Exception paths

| Path| Behaviour| Error code|
|---|---|---|
| Category omitted or invented| Refused. The four categories are a **fixed enum**, not configuration| `VALIDATION_FAILED`|
| Reason note omitted| Refused. §21.5 makes it required| `REASON_REQUIRED`|
| Reason metadata demands a photo or contact attempt| Refused if absent. The requirement is **read from the reason**, never hardcoded (§35.9.2)| `REASON_REQUIRED`|
| A rider fails an unowned or undispatched stop| Refused| `NOT_ASSIGNED_RIDER`, `MANIFEST_NOT_STARTED`|
| **Refused collection**| **Escalation-only.** Never rescheduled by ordinary Ops action (§21.6)| —|
| Attempt cap reached| Escalation-only unless hub Senior Ops force-extends with a mandatory reason and immutable audit (§21.6, `MSC-DEC-116`)| `PICKUP_ATTEMPT_LIMIT_REACHED`|
| Reschedule attempted without a clone| Refused (§35.4.3)| `REPLACEMENT_REQUIRED`|
| Source still active when a clone exists| Refused. The two are never simultaneously active (§35.4.4)| `SOURCE_STILL_ACTIVE`|
| **Failure left undecided**| A scheduled backstop escalates it after `stale_failure_backstop_hours` (§21.6)| —|
| Vendor wants to dispute| Receives the approved notification and contacts support for assisted review. **Contact alone does not reverse the physical failure state** (§21.5, `MSC-DEC-122`)| —|
| Offline| **Requires a connection in Version 1**: hub-handover queuing is Version 1's whole offline scope. The command is idempotent, so a retry over a flaky connection cannot record the failure twice.| —|

### 5.3 What this feature must never do

- **Never make the categories configurable.** Four fixed values. §21.6 attaches a hard rule to one of them — refused collection is escalation-only — and a renameable category would leave that rule pointing at nothing.
- **Never reverse a physical failure.** It is terminal. Correction happens through a new request, and the chain records what happened.
- **Never overwrite the failed attempt on reschedule.** §35.4.3: rescheduling creates a traceable chain, not an edit.
- **Never let a vendor's complaint change the state.** There is no self-service dispute form, and contact reverses nothing.
- **Never allow an ordinary reschedule of a refused collection**, or of an exhausted chain, without Senior Ops force-extension.
- **Never leave a failure undecided indefinitely.** The backstop exists because a queue nobody works is a queue that hides parcels.
- **Never record a zero collection as anything but a failure** — §21.3 routes it here.

### 5.4 As built (S1.28, 4 November 2026; the part that stands alone)

`reportPickupFailure` is built (migration `0072`, `src/pickup/pickup-failure.*`); the rest of the task is not (below).

**Built.** The assigned rider fails a stop it has arrived at, on a run in progress: one of the four fixed categories, a reason of the `PICKUP_FAILURE` catalogue, the note, and up to ten contact attempts (each a method — a call, a text or in person —, an instant, what came of it and, where the rider wants, a note; migration `0073`). The time the rider waited is not a field of its own: it is derived, from the arrival the database stamped, and a reported wait would be the rider's claim. The stop becomes `FAILED`, which is terminal and frozen for every writer; it keeps its place, its arrival and its claim, and **the request is not written** (it stays `CONFIRMED`; the office reschedules, cancels or escalates it). **The database holds what is the catalogue's and the clock's** (OB-S1-60, as for the count): the reason is an active reason of the catalogue with the label and attribution it holds now, and the note, the contact attempt and the photo its metadata asks for are required (`REASON_REQUIRED`; `details.rule` `contact_attempt` or `photo`); the moment of the failure is the database's own and the snapshot names it. One event in the rider's name, `pickup.stop.failed` (ordinary tier), bound member for member to the stored stop and carrying no note; a run whose last stop failed with nothing collected is **completed by the system** in the same transaction (`pickup.manifest.completed`, cause `LAST_STOP_FAILED`). A stop with a count is never failed. **A refused collection is escalation-only**: `cancelPickupRequest` with a replacement is `PICKUP_ATTEMPT_LIMIT_REACHED` for it whatever the cap, until hub Senior Ops force-extends the request for its next attempt (`extendPickupAttempts`, which now treats a refused collection as one that cannot go on); a plain cancellation and an escalation are open to Ops at once. A count of zero is refused by `recordCollection` and is reported here with a category (`AC-SLICE-001-36`).

**The door wait (review closeout of 5 November 2026, migration `0073`; built on the reviewer's recommendation, the Product Owner's confirmation is open, `OB-S1-69`).** A failure of the category `VENDOR_UNAVAILABLE` is accepted once the hub's `rider_door_wait_minutes` has passed since the arrival of the stop, which the database stamped (a writer under the arrival key does not choose it) and on the database's clock; before that it is `422 PICKUP_DOOR_WAIT_NOT_ELAPSED`, with the wait, the moment the report is allowed and the seconds to it. The stop's guard holds the same rule for every writer; the other three categories carry no wait; a hub with no usable value gets the operational failure, never an invented wait. **The pairing of a reason with a category is not checked anywhere**, so the wait (like the restriction of a refused collection) follows the category the rider reports: a rider who reports `PARCEL_NOT_READY` with a vendor-unavailable reason is not held. Binding the two needs a category on the failure reasons of the catalogue, which is the owner's to decide.

**Not built, and why** (the plan's S1.28 paragraph and OB-S1-66 say the same). (1) **The evidence photo**: the evidence store (S1.11) is built with this task's first user and is not built, so `evidence_ids` is `EVIDENCE_NOT_STORED` and the two reasons that ask for a photo (`ENTRY_REFUSED_BY_SECURITY`, `LOCATION_CLOSED`) cannot be used until it is. (2) **The backstop** (`AC-SLICE-001-34`): its cadence and the process of its lane are the owner's (OB-S1-07; the plan's stop condition), and it needs a capability of its own; until it runs an undecided failure is not escalated by the system. (3) **The narrowing of `escalatePickupRequest`** to a request whose stop failed. (4) **The messages of a failure** (to the sender, the vendor and the Ops feed). (The door wait, which this list held before the review closeout, is built: above.)

**For the owner.** (1) A contact attempt carries a method (`PHONE_CALL`, `SMS`, `IN_PERSON`), an instant, an outcome and an optional note; the wait is derived and not reported (OB-S1-67). (2) A force-extension is one explicitly authorised next attempt: for a refused collection it releases the restriction for exactly that attempt and records that it did, for a request at the cap it lifts the cap by one, and it records which of the two it did; the ceiling before and after are recorded only where one was lifted, and the request's own attempt number is never presented as the ceiling that was in force (OB-S1-68). The release is the request's own: the replacement that carries the extension is not itself released. A request extended before its stop failed as a refused collection cannot be extended a second time (one extension a request, OB-S1-15), so it can only be escalated or cancelled: the owner decides whether the second act is allowed. (3) The door wait is enforced for a vendor-unavailable failure (OB-S1-69).

---

## 6. Entities — *pointer*

| Entity| Home|
|---|---|
| `PickupStop`| [domain-model.md](../../contracts/domain-model.md) §6.4|
| `PickupRequest`| [domain-model.md](../../contracts/domain-model.md) §6.2 — `attempt_number`, `replaces_request_id`, `attempt_extension_id`|
| `ReasonCode`| [domain-model.md](../../contracts/domain-model.md) §3.9 — and the fixed-category exception recorded there|
| `Evidence`| [domain-model.md](../../contracts/domain-model.md) §3.6|

**`PickupFailureCategory` is a fixed enum** of four values, closed to configuration. The note, contact attempts and evidence attached to it remain configurable reason metadata.

## 7. States — *pointer*

| Machine| Home| Transitions this feature drives|
|---|---|---|
| `PickupStop.state`| [state-machines.md](../../contracts/state-machines.md) §5| `ARRIVED → FAILED`|
| `PickupRequest.state`| [state-machines.md](../../contracts/state-machines.md) §3| `CONFIRMED → CANCELLED` (replacement); force-extension|

## 8. Permissions — *pointer*

| Key| Holders| Scope| Home|
|---|---|---|---|
| `pickup.failure.report`| **Rider only**| owned dispatched stop| [permissions.md](../../contracts/permissions.md) §7|
| `pickup.failure.resolve`| Ops, Senior Ops, Platform Admin| own hub||
| `pickup.attempt.extend`| Senior Ops, Platform Admin| own hub, reason mandatory||

## 9. Settings — *pointer*

| Key| Why this feature reads it| Home|
|---|---|---|
| `MELARC_MAX_PICKUP_ATTEMPTS`| 3. The cap the chain respects| [settings.md](../../contracts/settings.md) §7.3|
| `stale_failure_backstop_hours`| **24** — one full service day before the backstop escalates an undecided failure||
| `rider_door_wait_minutes`| 10. How long before vendor unavailability becomes a failure||

## 10. Errors — *pointer*

`REASON_REQUIRED`, `VALIDATION_FAILED`, `NOT_ASSIGNED_RIDER`, `MANIFEST_NOT_STARTED`, `PICKUP_ATTEMPT_LIMIT_REACHED`, `REPLACEMENT_REQUIRED`, `SOURCE_STILL_ACTIVE`, `INSUFFICIENT_AUTHORITY` — [errors-and-enums.md](../../contracts/errors-and-enums.md).

## 11. Audit events — *pointer*

`pickup.stop.failed`, `pickup.request.cancelled`, `pickup.attempt.extended` *(enhanced)* — [audit.md](../../contracts/audit.md) §5.1.

The force-extension carries the §35.1.6 minimum: reason, actor, timestamp, **before and after values**, and an audit event.

## 12. API operations — *pointer*

`reportPickupFailure`, `escalatePickupRequest`, `extendPickupAttempts` — [openapi.yaml](../../contracts/openapi.yaml). The Ops decision-queue operations were added on 23 August (§15); a reschedule is `cancelPickupRequest` with a replacement.

---

## 13. Acceptance criteria

### `AC-SLICE-001-30` — Category is fixed and mandatory

```text
Given a rider at an ARRIVED stop on an owned run,
When the rider submits a failure with no category, or with a category outside the fixed four,
Then the backend rejects it,
And when one of VENDOR_UNAVAILABLE, ACCESS_DENIED, PARCEL_NOT_READY or REFUSED_COLLECTION is supplied with a reason note, the stop becomes FAILED.
```

**Governs:** §21.5, `CONFLICT-025` · **Surface:** Melarc Rider · **Test level:** API · **Code:** `VALIDATION_FAILED`, `REASON_REQUIRED`

### `AC-SLICE-001-31` — Reason metadata drives what else is mandatory

```text
Given a failure category whose reason configuration requires a photo,
When the rider submits without evidence,
Then the backend rejects with REASON_REQUIRED,
And the requirement is read from the reason record rather than hardcoded for that category.
```

**Governs:** §35.9.2, §21.5 · **Surface:** Melarc Rider · **Test level:** API · **Code:** `REASON_REQUIRED`

### `AC-SLICE-001-32` — Physical failure is terminal

```text
Given a stop in FAILED,
When any actor attempts to move it back to ARRIVED or to a collected state,
Then the transition is refused,
And the only route forward is a new request cloned from the source.
```

**Governs:** §21.5 · **Surface:** Melarc Ops · **Test level:** service · **Code:** `STATE_CONFLICT`

### `AC-SLICE-001-33` — Refused collection is escalation-only

```text
Given a stop failed with category REFUSED_COLLECTION,
When an Ops user attempts an ordinary reschedule,
Then the reschedule is refused,
And the refusal is PICKUP_ATTEMPT_LIMIT_REACHED,
And the request may only be escalated, or rescheduled after hub Senior Ops force-extension with a reason.
```

**Governs:** §21.6, `MSC-DEC-116` · **Surface:** Melarc Ops · **Test level:** service · **Code:** `PICKUP_ATTEMPT_LIMIT_REACHED`

### `AC-SLICE-001-34` — The backstop escalates an undecided failure

```text
Given a failed stop whose request has sat in the Ops decision context beyond stale_failure_backstop_hours,
When the scheduled backstop runs,
Then the request is escalated,
And the escalation is recorded with its trigger,
And no parcel or request is left silently undecided.
```

**Governs:** §21.6 · **Surface:** Melarc Ops · **Test level:** integration

### `AC-SLICE-001-35` — A vendor cannot reverse a failure by complaining

```text
Given a stop failed for a registered vendor,
When the vendor contacts support to dispute it,
Then no self-service dispute form exists on Melarc Vendor,
And the physical failure state is unchanged by the contact,
And any correction happens through an assisted Ops review, recorded as an audited note on the escalated request (escalatePickupRequest) with the reviewer, the time and what was decided,
And the review never reverses the physical failure state.
```

**Governs:** §21.5, `MSC-DEC-122` · **Surface:** Melarc Vendor, Melarc Ops · **Test level:** e2e, API

### `AC-SLICE-001-36` — Zero collection arrives here, not at a completed stop

```text
Given a rider who collected zero packages,
When the outcome is recorded,
Then recordCollection refuses a count of zero with ZERO_COLLECTION_IS_FAILURE and the stop cannot close as COLLECTED,
And the rider is routed to this failure flow (reportPickupFailure) with an approved category,
And no sender set or hub handover is created.
```

**Governs:** §21.3, `MSC-DEC-120` · **Surface:** Melarc Rider · **Test level:** API · **Code:** `ZERO_COLLECTION_IS_FAILURE`

---

## 14. Open questions blocking this feature

| ID| What it blocks here| Type|
|---|---|---|
| —| **`stale_failure_backstop_hours` set at 24**, so `AC-SLICE-001-34` is now exercisable. `OQ-051` no longer bears on this feature| —|

No `DECISION_NEEDED` question blocks this feature.

## 15. What this feature still owes its slice

**Nothing outstanding.** Every dependency this feature named has closed. It contributes no blocker to its slice's Definition of Ready.

**`escalatePickupRequest` and `extendPickupAttempts` were added on 23 August**. This section correctly reported them missing since it was written — and because every feature read `NOT_READY` regardless, a true and specific report was indistinguishable from boilerplate. `AC-SLICE-001-33` and `-34` are now executable against the contract.

**Readiness is not assessed here.** [definition-of-ready.md](../../standards/definition-of-ready.md) assesses it **for the complete vertical slice** and records the verdict in the slice document; a feature cannot answer §44.3 or §44.4 alone. This section feeds that assessment instead of duplicating it (`MSC-DEC-239`, closing `CONFLICT-029`).

**Evidence became creatable on 24 August**. `createEvidence` and `completeEvidenceUpload` are written, and **the optional failure evidence photo has a creation path**. `Evidence` was fully modelled at [domain-model.md](../../contracts/domain-model.md) §3.6 and **no operation produced one**, so every criterion here requiring attached evidence was unexecutable — a fact recorded against `OQ-048` and **never against this feature**. The guard worth knowing: a `PENDING_UPLOAD` record **may not be referenced**, so "evidence attached" now means bytes actually arrived.

## 16. Build status — *honest, per surface*

| Surface| Status| Gap|
|---|---|---|
| Melarc Rider| 🟡 API built, no screen| `reportPickupFailure` (§5.4); the screen is S1.46. Not built: the evidence photo, and the screen that tells the rider how long to wait (the server refuses an early vendor-unavailable report)|
| Melarc Ops| ⚪ not built| Decision queue (S1.30), the backstop and the narrowing of the escalation (OB-S1-66). The reschedule of a refused collection and its force-extension are built|
| Melarc Vendor| ⚪ not built| Notification only — no dispute form by design|
| Recipient channel| N/A| —|

## 17. Related

- **Upstream:** [pickup-collection.md](pickup-collection.md) — zero collection and an expired door wait both arrive here
- **Sibling:** [pickup-request.md](pickup-request.md) — owns the attempt chain fields and the clone
- **Sibling:** [pickup-manifest.md](pickup-manifest.md) — a failed stop still counts toward run completion
- **Slice:** `SLICE-001`
