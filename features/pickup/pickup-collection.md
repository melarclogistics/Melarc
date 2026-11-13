# Pickup Collection

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.9 (cleaned edition)
> **Date:** 4 October 2026
> **Domain:** `pickup`
> **Owns:** the behaviour and acceptance criteria for what happens at the door — recording the collected count, capturing variance, and the two-party collection handshake
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §21.3, §21.4, §35.3, §36.4, §36.5
> **Slice:** `SLICE-001`

## 1. What this is, and why

This is the moment custody transfers. A rider at a sender's door records **how many packages were actually collected** — never assuming the declared count (§35.3.6) — and a **two-party handshake** proves the sender participated.

**Version 1 boundary.** Collection records the physical result. It does not price, does not confirm a recipient, and does not close the count question: **the hub counts again, blind, on arrival.** That second count is not redundancy; it is the only thing that catches a package lost between the door and the hub.

## 2. Governing sections

| Section| What it governs here|
|---|---|
| §21.3| Pickup completion: collected count, vendor note, mandatory variance reason, the zero-count bar|
| §21.4| Collection confirmation: code direction, TTL, attempts, dispute; the stop closes when the handshake is verified or overridden (§21.4 as amended on 29 October 2026)|
| §35.3.6–9| Actual counts, two-party handshake, zero and partial consistency, offline obligations|
| §36.4| Stop states and the zero-count rule|
| §36.5| The four handshake lifecycle concepts that must not be collapsed|


## 3. Surfaces and actors

| Surface| Actor| Can do| Gated by|
|---|---|---|---|
| Melarc Rider| Rider| Arrive; **photograph every parcel**; record collected count (the number of photos) and variance reason; capture evidence; display the handshake code; enter an ad-hoc sender's code; trigger the SMS fallback| `pickup.run.execute`, `pickup.collection.confirm` — assigned stop only|
| Melarc Vendor| Vendor account| **Enter the rider-displayed code** in the portal; **see the photos of its own stop** there and in its pickup history (SLICE-015; an individual sender sees none). Dispute a collection| `pickup.collection.confirm` — own pickup only|
| Melarc Ops| Ops Staff| Authorise a handshake override when both prior rungs fail; **let a stop's count through without parcel photos when the camera fails or the photos cannot be sent**; work the shortfall flag; see the stop's photos as they arrive (S1.30)| `pickup.handshake.override`; the photos are read under `pickup.read`|
| Recipient channel| Ad-hoc sender| Receives the code by SMS and reads it to the rider. **Holds no permission** — the rider enters it| —|

**The handshake direction is fixed and may not be reversed** (§21.4, `MSC-DEC-114–115`): registered vendors *enter* a rider-displayed code; ad-hoc senders *receive* an SMS code the rider enters.

## 4. Preconditions

- The manifest is `IN_PROGRESS` and the stop belongs to the acting rider.
- The stop has reached `ARRIVED`. (The vendor's cancellation window closed earlier, at the assignment: state-machines.md §5, `AC-SLICE-001-12`; arrival writes nothing to the request.)

---

## 5. Behaviour

### 5.1 Normal path

1. **The rider arrives.** The stop becomes `ARRIVED`.
2. **The rider photographs every parcel, counts and records.** `collected_count` is the **actual** count, never the declared one (§35.3.6), and it is **the number of parcel photos** ([§5.5](#55-the-photo-of-every-parcel)). A vendor note is optional.
3. **If the counts differ, a variance reason is mandatory** (§21.3). `variance` records `MATCH` or `SHORT` on **every** collection — a clean count is a recorded outcome, not an absence.
4. **The handshake runs.** Once the count is recorded the system generates a code and delivers it by the direction fixed for that sender type. Verification within TTL confirms; an expired or exhausted code routes to Ops, who may authorise an override.
5. **The stop closes** as `COLLECTED` or `PARTIALLY_COLLECTED` when the handshake is verified or overridden. Until then it stays `ARRIVED`.
6. **A provisional ad-hoc sender is promoted to reusable** when the count is recorded — **without waiting for the handshake response** (§21.3).
7. Custody passes to the hub at handover, where the **blind count runs independently**.

**As built (S1.26, `recordCollection`).** Steps 2 and 3 and 6 are built: the rider's count makes the `CollectionRecord` (the actual count, `variance` `MATCH` or `SHORT` on every collection, the reason of a short one from the `PICKUP_SHORT_COUNT` catalogue with the note it asks for), a shortfall raises the office flag in the same transaction (`office_notified_at`; **the Ops feed is told in the same transaction**, a feed entry `COLLECTION_SHORT_OPS_FEED` through the outbox whose wording is a draft until the owner approves it, OB-S1-51, and Ops works the flag from `listCollectionShortfalls`: Run A, 12 November 2026), and a provisional individual sender becomes reusable. **The stop stays `ARRIVED`** and the handshake (steps 4 and 5) is the next task's. **The count has an audit event of its own, `pickup.collection.recorded`** (OB-S1-54, decided on 4 November 2026): it says that a count was recorded and that the stop is still `ARRIVED`, the same for a clean count and a short one, and `pickup.stop.collected` and `pickup.stop.partially_collected` are written only when the handshake closes the stop, so a count whose handshake never finishes is never read as a completed collection. **The facts of the record that are the catalogue's and the clock's are the database's** (OB-S1-60, decided on 4 November 2026): the reason of a short count is an active reason of the catalogue as the catalogue holds it (its code, its label and its attribution, with the rider's note where the reason asks for one), and the recording and the office flag are the database's own instants, taken once the stop is locked, apart from the device's moment (`captured_at`). A short count whose reason asks for a photo is `REASON_REQUIRED` unless `evidence_ids` names a stored photo of the stop (OB-S1-52, closed by Run A2); **a count above the declared one is refused** (OB-S1-50). **A stop with a record is never skipped, failed or cancelled away** (approved on 4 November 2026, [§5.4](#54-a-stop-that-has-been-counted)): it waits for the handshake.

**As built (Run A2, 12 November 2026, D-A10: the photo of every parcel; migration `0088`).** Step 2 is built as [§5.5](#55-the-photo-of-every-parcel) says. `recordCollection` takes `parcel_photo_ids`: **exactly `collected_count` stored `PARCEL_PHOTO` records of this rider and this stop, each attached once, or none for a stop Ops let through without them**, judged after every other refusal of the operation (a count refused for another reason is told so; a different number, none included, is `VALIDATION_FAILED` with the rule `parcel_photo_count`, a photo named twice `duplicate`, and a photo that cannot be counted, in any of the ways of the table in §5.2, is the one answer `EVIDENCE_NOT_STORED`). **The database holds the number for every writer, at the end of the transaction, on the record and on the link** (`collection_parcel_photo`, a deferred rule), and holds that a photo is a stored parcel photo of this very stop, captured by the rider who made the count, attached once. The photo has its own declaration: `createEvidence` with the purpose `PARCEL_PHOTO` is a rider's act under the key of the count, and a failure's proof under the key of the failure. **Ops's exception** is `authoriseParcelPhotoException` (`POST /pickup-stops/{id}/parcel-photo-exception`, `pickup.handshake.override`, an officer of the stop's hub, an `Idempotency-Key`, a required note): once for a stop, before the count, written by one operation of the database with the stop's lock first, never changed or removed, with the enhanced event `pickup.collection.photo_exception_authorised`; **the Product Owner is asked to confirm that the existing door-exception key is the right one** (the plan's section 11). There is no cap on the photos: a pickup of two hundred parcels is two hundred ids in a body of about 8 KB, against the 100 KiB the application admits by default. The stop's photos with their progress, and the screen for the exception, are S1.30's; the camera and the upload queue are SLICE-016's; the vendor's view is SLICE-015's.

**As built (S1.27, the collection handshake; migration `0070`).** Steps 4 and 5 are built, as five operations of the database that no other statement can imitate. The rider that recorded the count asks for the code (`initiateHandshake`); the database keeps a **keyed digest** of the live code and never the code, which is derived from the stop and the generation under a key of the `credential_delivery` purpose, shown once to the rider (a vendor's pickup: `display_code`) or texted by the notification lane (an individual sender's pickup, to the sender's number alone, with no link), and which appears in no log, metric, event or stored answer. The vendor enters the code its rider shows (`verifyHandshake`, channel `PORTAL`); the rider enters the code a sender received. **Each wrong code is counted by the database whatever the application does** and the last one ends the code (`ATTEMPTS_EXHAUSTED`); a code past `handshake_code_ttl_minutes` on the database's clock is `CODE_EXPIRED`, is kept expired and routes to Ops, and the right code after either is refused (late self-confirmation, `AC-SLICE-001-26`). The SMS fallback (`requestSmsHandshakeFallback`) makes a **new** code the rider has not seen and texts it to the vendor's registered number only; the cap and the cooldown are the database's, for every process (`SMS_FALLBACK_LIMIT_REACHED`, `AC-SLICE-001-73`), the code the rider displayed no longer verifies, the wrong attempts already counted stay counted, and the rider then enters what the vendor read out (channel `SMS_FALLBACK`). **The registered number is the phone of the vendor's credential** (F-23, resolved in the review closeout of 5 November 2026, migration `0073`; the Product Owner's confirmation is open, plan `OB-S1-62`): `VendorCredential.recovery_phone` where the credential's `delivery_channel` is `PHONE`, which is the number the vendor's own setup and recovery messages go to. It is entered at registration, chosen as the delivery channel by the approver, and proven by possession (the vendor set its secret from the grant that was texted to it: a credential whose secret was never set has no registered number); the organisation's business contact number is not an authentication channel (domain-model.md) and the fallback never goes to it. The lane reads no table for it: the database gives it to the one lane that sends the text, for the request its envelope names and only while a fallback code is live, and the message log keeps no hint of it. No operation changes the number in `SLICE-001`; a change is a later slice's act and must be an authorised, verified one (a grant to the new number, as at approval). **The length of a code is kept with it** (`code_length`, migration `0073`): the setting `handshake_code_length` is read when a code is made, and a setting changed after a code was made, sent or queued applies to the next code and cannot change the length of one that is out, so the text carries the length the vendor or the rider will be asked to type; the handshakes that existed when the column was added took the setting then in force. Ops overrides (`authoriseHandshakeOverride`, `pickup.handshake.override`: from a stop that is counted and arrived at, whatever the handshake stood at, with a note) and Senior Ops resolve (`resolveHandshake`, `pickup.handshake.resolve`: an expired or exhausted handshake, or a live one whose life has passed, with a note); each writes an enhanced event with the note. **The stop closes in the same change as the handshake ends**, as the count says (`COLLECTED` for `MATCH`, `PARTIALLY_COLLECTED` for `SHORT`), and the close writes `pickup.stop.collected` or `pickup.stop.partially_collected`; an abandoned handshake writes neither. Every rung writes its channel; the record's `handshake_channel`, `handshake_confirmed_at` and `handshake_override_by` are set once, by the close. Evidence on a manual resolution is `EVIDENCE_NOT_STORED` until the evidence store (S1.28) exists.

**As built (S1.29, the collection dispute; migration `0071`).** The vendor whose pickup it is disputes a collection that has closed (`disputeCollection`, `pickup.collection.confirm` on the Vendor surface): the database raises the **reconciliation item** (`collection_dispute`: the stop, the organisation, the vendor principal, the vendor's note, `OPEN`), sets the stop's handshake `DISPUTED` and writes `pickup.handshake.disputed` (the actor and the note), in one change, under the stop's lock. **It never reverses physical completion**: the stop stays `COLLECTED` or `PARTIALLY_COLLECTED` (the operation does not touch it) and the manifest does not wait for the item; a run whose other stops are settled completes as it would have. A stop that has not closed through its handshake, a skipped stop and a failed one have no collection to dispute (`STATE_CONFLICT`, `details.rule` `stop_not_closed`; a failed stop has no dispute form by design, `AC-SLICE-001-35`); a second dispute of the same collection is `dispute_open`; another vendor's stop and an id that matches nothing are `NOT_FOUND`, the same. The item is readable by Ops in the stop's hub and by the vendor that raised it (the policies of the table say so; Ops reads the items with `listCollectionDisputes` (Run A, 12 November 2026; its screen is S1.30's), and **no operation lets the vendor read its own item yet**: that view is a later screen's and needs an operation added to the contract first, plan `OB-S1-70`); its resolution is the detailed Ops reconciliation workflow that the specification leaves to downstream design, and **no operation resolves it in `SLICE-001`**.

### 5.2 Exception paths

| Path| Behaviour| Error code|
|---|---|---|
| **Zero packages**| **Never a completed stop.** Zero collection routes to the failure flow with an approved category. The system must not create an empty completed stop, sender set or hub handover (§21.3, `MSC-DEC-120`)| `ZERO_COLLECTION_IS_FAILURE`|
| **Short count**| Permitted. The stop closes `PARTIALLY_COLLECTED`, once the handshake is verified or overridden, with a mandatory variance reason recorded at the count, and **office is flagged in-system when the shortfall is recorded** — supplementing the rider's phone call, never replacing it| `REASON_REQUIRED`|
| **The photos do not make the count**| A count whose number of parcel photos differs from `collected_count` is refused (a count with none at all included), for every writer. A repeated photo is refused too ([§5.5](#55-the-photo-of-every-parcel))| `VALIDATION_FAILED`|
| **A photo that cannot be counted**| A photo that is still `PENDING_UPLOAD`, has `EXPIRED`, is another rider's, is of another stop or another purpose, or is already attached to a count is **one answer**, so that the reply tells a rider nothing about a record that is not its own| `EVIDENCE_NOT_STORED`|
| **The camera fails, or the photos cannot be sent**| The rider tells Ops, and **Ops lets that stop's count through without parcel photos**, as a recorded exception, before the count (`authoriseParcelPhotoException`). Once let through, that stop's count takes no parcel photos; a stop that was not let through cannot be counted without them| `STATE_CONFLICT`, `REASON_REQUIRED`|
| **A photo's upload window ran out** (no signal)| The photo is uploaded under a **fresh upload instruction** (a new record if the old one has expired), keeping its capture time; the rider does not retake it. The Rider app's upload queue does this (SLICE-016)| `EVIDENCE_UPLOAD_EXPIRED`|
| Handshake code wrong| Returns remaining attempts (§21.4)| `CODE_INVALID`|
| Attempts exhausted| Code invalidated, routed to Ops (§21.4)| `ATTEMPTS_EXHAUSTED`|
| TTL expired| Routed to Ops; **late self-confirmation is blocked** (§21.4)| `CODE_EXPIRED`|
| **Portal unusable — no data, portal down**| **Fallback 1:** rider triggers SMS to the vendor's **registered number only**. Logged as `SMS_FALLBACK`. **Server-enforced per stop** (CRIT-08 audit remediation): capped at `sms_fallback_max_per_pickup` (3) sends, no closer together than `sms_fallback_cooldown_seconds` (60) apart| `NO_REGISTERED_NUMBER`|
| **SMS fallback exhausted or attempted too fast**| **Refused, not silently retried.** The rider needs Fallback 2, not another SMS — this is the ladder working as designed, not a dead end (CRIT-08 audit remediation)| `SMS_FALLBACK_LIMIT_REACHED`|
| **SMS also fails**| **Fallback 2:** rider contacts Ops, who verifies the vendor by another means and authorises as a recorded exception. Logged as `OPS_OVERRIDE`| `INSUFFICIENT_AUTHORITY`, `REASON_REQUIRED`|
| **Vendor simply busy**| **Not a fallback trigger.** The ladder addresses technical failure, not inattention. The rider waits `rider_door_wait_minutes` (10) and may then fail the stop. The server holds it: an earlier report of a vendor-unavailable failure is `PICKUP_DOOR_WAIT_NOT_ELAPSED` (migration `0073`)| —|
| Vendor disputes| Raises reconciliation **without reversing physical completion** (§21.4): a dispute raised after the stop closed does not reopen it, and the parcels were collected| —|
| Poor connectivity| The command is replay-safe under retry. **Collection requires a connection in Version 1** — hub-handover queuing is Version 1's whole offline scope.| `IDEMPOTENCY_KEY_CONFLICT`|
| Duplicate submission| Idempotent replay returns the original result| `IDEMPOTENCY_KEY_CONFLICT`|

### 5.3 What this feature must never do

- **Never let `collected_count` seed the hub's declared count.** They are **two independent checks** (`MSC-DEC-194` part 3). A package lost between the door and the hub is visible only in the second. Collapsing them looks like a sensible optimisation and destroys the custody guarantee §35.5 exists to provide.
- **Never take a count the photos do not make, and never count a photo twice.** The number of parcel photos is the collected count; a photo is attached to one count, once, and the database holds both for every writer ([§5.5](#55-the-photo-of-every-parcel)).
- **Never show the parcel photos, or their number, to the hub's blind count before the hub's count commits.** They follow the rule of the rider's declared count ([hub-intake.md §5.3](../hub/hub-intake.md#53-what-this-feature-must-never-do)).
- **Never complete a stop with zero packages.** No empty completed stop, no empty sender set, no empty handover.
- **Never assume the declared count.** §35.3.6 requires the actual count to be recorded.
- **Never reverse the handshake direction.** Vendors enter; ad-hoc senders are read to.
- **Never send the fallback SMS anywhere but the registered number.**
- **Never treat "busy" as a technical failure.** The ladder exists for no-data and portal-down.
- **Never let a dispute undo physical completion.** It raises reconciliation; the parcels were collected.
- **Never hold manifest completion for a dispute.** §21.4 as amended: a dispute raised after a stop closed does not hold up the run.

### 5.4 A stop that has been counted

*Approved by the Product Owner on 4 November 2026. The first rule is built (S1.26) and the second is built with the handshake (S1.27).*

- **A counted stop is kept.** Once a `CollectionRecord` stands for a stop (a count above zero), the ordinary acts that discard a stop cannot discard its counted work: Ops's skip, the failure of the stop and the cancellation of its request are refused (`STATE_CONFLICT`, `details.rule` `collection_recorded`), and the database refuses them for every writer. The parcels have been counted and need a traceable resolution; the stop leaves `ARRIVED` through the handshake and its exits (verification, the Ops override, the manual resolution), never by being discarded.
- **Who finishes the rider-side handshake of a counted stop (S1.27).** After a custody transfer ([state-machines.md §4.1](../../contracts/state-machines.md#41-runcustodyhandover--custody-moves-and-completion-follows-it)), the rider who recorded the count may finish that stop's rider-side handshake, **only while that rider's assignment and authorization are still valid**. Custody alone grants the receiving rider no handshake authority and no run-execution authority. If the recording rider is no longer eligible, the specified recovery or the Ops override applies, with its existing prerequisites and its audit. The vendor's confirmation and the individual sender's code stay as they are. **Built (S1.27):** asking for the code, the SMS fallback and the rider's entry of a code are refused to every rider but the one that recorded the count, and only while it is the run's assigned rider (`NOT_ASSIGNED_RIDER`); a rider that holds the run by custody alone has none of them, and an officer's override or resolution is the recovery. **This grants no authority to collect at additional stops**: what a rider who has handed custody away may still do at the stops yet to be worked is OB-S1-43 and OB-S1-55, which stay open.
- **A run that completes as empty over a custody count** (OB-S1-59) stays an operational-release blocker: the custody count and the pickup counts are independent records, both are kept, and no figure of one seeds the other. The reconciliation that would hold such a completion is not specified here.

### 5.5 The photo of every parcel

*Decided by the Product Owner on 12 November 2026 (D-A10, [the plan's §11](../../delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md#11-decisions-recorded)), replacing the count the rider typed. The server half is built (Run A2); the camera, the upload queue, the screens and the reads are the later tasks named in the last paragraph. This section owns the rule; the documents of those tasks link here and do not restate it.*

**The rule.** At the door the rider photographs **every parcel**, label side up, one photo each. **The photos make the count**: `collected_count` is the number of photos, and the server refuses a count that differs from it. A parcel photo is a record of evidence about the stop (`owner_type` `PICKUP_STOP`, the purpose `PARCEL_PHOTO` of [domain-model.md §3.6](../../contracts/domain-model.md#36-evidence)), declared and completed like any evidence (`createEvidence`, then `completeEvidenceUpload`, which checks the object, scans it for malicious content and only then stores it), and captured by the rider who counts, at a stop it has arrived at on a run in progress.

**The order at the door.**

1. The rider photographs a parcel. The phone shrinks the photo (about 0.3 MB; SLICE-016) and begins to upload it **while the rider takes the next one**.
2. A photo counts only when it is `STORED`. A photo that is only declared, or still uploading, counts for nothing.
3. Once every photo is `STORED`, the count is sent **once**: `recordCollection` with `collected_count` and the identifiers of the photos (`parcel_photo_ids`). No count is sent on photos that are only declared.
4. The server records the count and attaches the photos to the record in the same transaction. A short count's reason that asks for a photo takes that photo separately (below).

**What is refused, and where it is held.** Each is held by the database for every writer, not only by the operation (a deferred rule of the record at the end of its transaction, and the guard of the link):

- a count whose number of photos differs from `collected_count` (none at all included): `VALIDATION_FAILED`, `details.violations` pointer `/parcel_photo_ids`, rule `parcel_photo_count`;
- the same photo twice in one count: `VALIDATION_FAILED`, rule `duplicate`;
- a photo that is pending, expired, another rider's, another stop's, of another purpose, or already attached to a count (or to a failure): the single `EVIDENCE_NOT_STORED`.

**The photo of the parcel left behind is not one of the counted photos.** A short-count reason that asks for a photo (`PARCEL_DAMAGED_OR_UNSAFE`) takes the photo of the parcel that was left behind in `evidence_ids`: a `STORED` record of the stop, captured by the rider, of the purpose `COLLECTION_PROOF` (the purpose of a failure's photo), not yet attached to anything. It is attached to the stop beside the count and is **not** counted; the reason is `REASON_REQUIRED` (`details.rule` `photo`) without it, for every writer: the operation answers it, and the database holds it at the end of the transaction (the constraint `collection_record_reason_photo`, migration `0089`, in the rule that holds the number of the parcel photos). This closes the part of OB-S1-52 that held the reason unusable, which the guard of the record had in fact kept unusable until migration `0089`.

**There is no limit on the number of photos of a stop** beyond the count (D-A8, which closes finding L4 of the review of Run A). Each file is bounded by the size and the types of the settings, and the authenticated rate limit bounds how fast records are made. The request must admit a large collection: the identifiers of 200 parcels are about 8 KB of the 100 KiB that `HTTP_BODY_LIMIT_BYTES` admits by default, and a test proves 200.

**If the camera fails, or the photos cannot be sent,** the rider tells Ops and **Ops lets that stop's count through without photos**, as a recorded exception: `authoriseParcelPhotoException` (`pickup.handshake.override`, the key of Ops's door exceptions: it is a policy waiver of the same kind as the handshake override, [permissions.md](../../contracts/permissions.md)), with a note, for a stop the rider has arrived at on a run in progress **before the count**. The exception is one row for the stop, made once and never changed (the officer, the moment on the database's clock, the note) with an enhanced audit event (`pickup.collection.photo_exception_authorised`). **Once let through, that stop's count takes no parcel photos** (a count that names some is `VALIDATION_FAILED`, rule `parcel_photo_count`), and **a stop that was not let through cannot be counted without them**. A stop that already has a count cannot be let through (`STATE_CONFLICT`, `details.rule` `collection_recorded`).

**A photo whose upload window ran out** (a phone without signal when the instruction lived) is uploaded under a **fresh upload instruction**, a new record if the old one has expired, **keeping its capture time**: `captured_at` is the phone's and travels with the new declaration, within the tolerance the platform grants a phone whose clock runs ahead (`evidence_capture_clock_tolerance_minutes`, [settings.md](../../contracts/settings.md)). The Rider app's upload queue does this, so no rider retakes a photo for it (SLICE-016).

**Who sees the photos, and when.**

- **Ops** sees them on the stop as they arrive, with the progress of the uploads (S1.30), and reads each with `createEvidenceRetrievalAuthorization` under `pickup.read`.
- **A registered vendor** sees the photos of its own stop on the screen where it enters the code, and later in its pickup history (SLICE-015: a read of its own stop's photos, which does not exist yet). **An individual sender does not.**
- **The hub's blind count never sees them**, nor their number, before the hub's count commits ([hub-intake.md §5.3](../hub/hub-intake.md#53-what-this-feature-must-never-do)): they follow the rule of the rider's declared count, in no read, response, list or page of the receiving side before the commit (Stage 6).
- **At itemization** the officer chooses the photo of each order from the collection's photos, **one photo per order**, the unmatched ones shown ([itemization.md](../hub/itemization.md)); the order keeps a reference to the evidence and the evidence's owner is never re-pointed. **The photo follows the order**: the order list, the order page, and the delivery rider's stop (Stage 7 and the later order screens).

**Open, not decided.** (1) The retention category of a parcel photo: it must outlast the order's delivery, return and dispute, and the period stays the owner's (`OQ-028`); until it is decided a parcel photo is kept under the one category that exists, `PICKUP_STOP_EVIDENCE`. (2) How the small copy that lists show is made, by the phone or by the evidence lane: the task that builds the list decides. **Out of scope:** reading a label automatically is a later option.

**Who builds what.** The server half (`recordCollection` with the photos, the exception and the database's rules) is Run A2. The stop's photos with the progress of their uploads, and the screen for Ops's exception, are S1.30. The photos' place in the receiving side's reads is Stage 6 (S1.31 to S1.35); the choice of an order's photo is Stage 7 (S1.36). The vendor's view is SLICE-015; the counting camera, the shrinking, the upload queue and a warning on blur or glare are SLICE-016; the order list and the order page are the later order screens. Each has its row in [the plan's §7](../../delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md#7-deferred-obligations--what-is-owed-and-not-yet-run) (`OB-S1-80` to `OB-S1-86`).

---

## 6. Entities — *pointer*

| Entity| Home|
|---|---|
| `PickupStop`| [domain-model.md](../../contracts/domain-model.md) §6.4|
| `CollectionRecord`| [domain-model.md](../../contracts/domain-model.md) §6.5|
| `Evidence`| [domain-model.md](../../contracts/domain-model.md) §3.6|
| `AdHocSender`| [domain-model.md](../../contracts/domain-model.md) §6.8|

Non-obvious: `variance` is present on **every** collection, not only shortfalls; `handshake_channel` likewise records `PORTAL` even on the happy path, because a fallback ratio needs both terms; `office_notified_at` marks the shortfall flag.

## 7. States — *pointer*

| Machine| Home| Transitions this feature drives|
|---|---|---|
| `PickupStop.state`| [state-machines.md](../../contracts/state-machines.md) §5| `ARRIVED → COLLECTED`, `→ PARTIALLY_COLLECTED`|
| `CollectionHandshake.state`| [state-machines.md](../../contracts/state-machines.md) §6| generation, delivery, verification, the two fallback escalations|

## 8. Permissions — *pointer*

| Key| Holders| Scope| Home|
|---|---|---|---|
| `pickup.run.execute`| Rider| assigned run| [permissions.md](../../contracts/permissions.md) §7|
| `pickup.collection.confirm`| Vendor, Rider| Vendor: own pickup · Rider: ad-hoc code entry||
| `pickup.handshake.override`| **Ops**| own hub. Ops's override authority at the door (`MSC-DEC-204`; the contract calls the handshake override a policy waiver rather than a verification step, and this row said the opposite until Run A2): the handshake override, working the shortfall flag and, since D-A10, **a stop's count without parcel photos** (`authoriseParcelPhotoException`)||
| `pickup.read`| Ops (A S P)| own hub (P: all hubs). The read of the subject: **the stop's parcel photos** are read by staff under it (`createEvidenceRetrievalAuthorization`); a vendor's read of its own stop's photos is SLICE-015's| [permissions.md](../../contracts/permissions.md)|

## 9. Settings — *pointer*

| Key| Why this feature reads it| Home|
|---|---|---|
| `rider_door_wait_minutes`| 10. How long before a busy vendor becomes a failed stop| [settings.md](../../contracts/settings.md) §7.3|
| `handshake_code_length`, `handshake_code_ttl_minutes`, `handshake_max_wrong_attempts`| **`CONFIRMED`** (4, 15, 5) — reviewed and confirmed by `MSC-DEC-256` (settings.md owns the status). **Seeded as platform settings and read by S1.27** (migration `0070`; the seed writes the same rows): the database reads the life and the limit inside its operations, the API reads the length once, when it makes a code, and the database keeps it with the code (`code_length`, migration `0073`: the notification lane reads the stored length and not the setting)| [settings.md](../../contracts/settings.md) §7.4|
| `sms_fallback_max_per_pickup`, `sms_fallback_cooldown_seconds`| **`CONFIRMED`** (3, 60). The SMS fallback's own cap and cooldown, independent of the generic authenticated-API rate-limit bucket (CRIT-08 audit remediation). **Held by the database per stop (S1.27)**, in the handshake's own counters| [settings.md](../../contracts/settings.md) §7.4|
| `evidence_upload_max_bytes`, `evidence_upload_allowed_mime_types`, `evidence_upload_authorization_ttl_minutes`, `evidence_capture_clock_tolerance_minutes`| What a parcel photo may be, how long its upload instruction lives and how far ahead of the server's clock a phone's capture time may be. **Held by the database for every writer** (Run A2): the owner changes a value without code and it holds everywhere at once. There is **no limit on the number of photos** of a stop (D-A8)| [settings.md](../../contracts/settings.md) §7|

## 10. Errors — *pointer*

`ZERO_COLLECTION_IS_FAILURE`, `HANDSHAKE_NOT_VERIFIED`, `CODE_INVALID`, `CODE_EXPIRED`, `ATTEMPTS_EXHAUSTED`, `NO_REGISTERED_NUMBER`, `SMS_FALLBACK_LIMIT_REACHED`, `COLLECTION_NOT_RECORDED`, `DELIVERY_CHANNEL_FAILED`, `REASON_REQUIRED`, `NOT_ASSIGNED_RIDER`, `IDEMPOTENCY_KEY_CONFLICT`, and for the parcel photos `EVIDENCE_NOT_STORED`, `EVIDENCE_UPLOAD_EXPIRED` and `VALIDATION_FAILED` (rules `parcel_photo_count` and `duplicate`) — [errors-and-enums.md](../../contracts/errors-and-enums.md). No new code: the photos add rules, not codes.

## 11. Audit events — *pointer*

`pickup.collection.recorded` *(the count; the stop stays `ARRIVED`)*, `pickup.collection.photo_exception_authorised` *(enhanced: Ops lets a stop's count through without parcel photos; Run A2)*, `pickup.stop.collected`, `pickup.stop.partially_collected` *(the close of the stop, by the handshake)*, `pickup.handshake.generated`, `pickup.handshake.delivered`, `pickup.handshake.verified`, `pickup.handshake.disputed`, `pickup.handshake.manually_resolved`, `pickup.handshake.fallback_sms`, `pickup.handshake.fallback_override` *(enhanced)* — [audit.md](../../contracts/audit.md) §5.1.

**Every identifier is spelled in full.** The suffix form — `` `.dispatched` `` after `` `pickup.manifest.created` `` — is not a resolvable identifier: no check can verify it, and it still reads correctly after the code it points at is renamed.

**Handshake codes are never logged** — the event records that a code was generated, never its value (§38.2, audit §9).

## 12. API operations — *pointer*

`arriveAtPickupStop`, `recordCollection` — [openapi.yaml](../../contracts/openapi.yaml). **`arriveAtPickupStop` added 16 September 2026** (`MSC-DEC-392`, resolving `CONFLICT-038`): §5.1 step 1 has read *the rider arrives; the stop becomes `ARRIVED`* throughout, §4 makes `ARRIVED` a precondition of collection, and **no operation reached it** — `recordCollection` closed an `ARRIVED` stop that nothing could open. The handshake operations (`initiateHandshake`, `verifyHandshake`, `requestSmsHandshakeFallback`, `authoriseHandshakeOverride`) are in the contract, added on 20 August, and `resolveHandshake` was added with the Slice 001 reconciliation; **all five are built (S1.27)**. `disputeCollection` is built too (S1.29). **Run A2 (12 November 2026, D-A10) gave `recordCollection` the field `parcel_photo_ids` and added `authoriseParcelPhotoException`** (`POST /pickup-stops/{id}/parcel-photo-exception`, `pickup.handshake.override`; [§5.5](#55-the-photo-of-every-parcel)). **Three Ops reads of what the collection makes were added by Run A (12 November 2026, D-A3, `OB-S1-70`)** so that the office finds and works it: `listCollectionDisputes` (`pickup.read`; the items a vendor raised, `open` = still `OPEN`: no operation resolves one yet), `listHandshakesForOps` (`pickup.handshake.override`; the handshakes that **need Ops now**: state `EXPIRED` or `EXHAUSTED`, a live code past its life on the database's clock, or the fallback sends at the platform cap, each item saying why in `routed_because`; `open=false` is the ones Ops settled by override or by hand) and `listCollectionShortfalls` (`pickup.handshake.override`, the key this document gives for working the shortfall flag; the short counts flagged to the office, `open` = the run still in progress, because nothing yet marks a shortfall as worked). Each is a `GET` for Ops staff only, by the hubs of the grant (an audited crossing, as the other hub reads), cursor-paged oldest first, with `open` and `hub_id`; **no code, digest, phone, address or Ops note is in an item**. Their names and the meaning of `open` are provisional until the screens (S1.30) use them.

---

## 13. Acceptance criteria

### `AC-SLICE-001-20` — Zero collection is a failure, never a completed stop

```text
Given a rider at an ARRIVED stop,
When the rider submits a collected count of zero,
Then the backend rejects with ZERO_COLLECTION_IS_FAILURE,
And no completed stop, sender set or hub handover is created,
And the rider is routed to the failure flow.
```

**Governs:** §21.3, §36.4, `MSC-DEC-120` · **Surface:** Melarc Rider · **Test level:** API · **Code:** `ZERO_COLLECTION_IS_FAILURE`

### `AC-SLICE-001-21` — A short count needs a reason and flags office

```text
Given a stop with a declared count of 5,
When the rider records 3 collected without a variance reason,
Then the backend rejects with REASON_REQUIRED,
And when a reason is supplied the count is recorded and the stop stays ARRIVED until the handshake closes it,
And an office notification is raised at that moment,
And office_notified_at is recorded,
And once the handshake is verified or overridden the stop becomes PARTIALLY_COLLECTED.
```

**Governs:** §21.3, `MSC-DEC-194` · **Surface:** Melarc Rider · **Test level:** API · **Code:** `REASON_REQUIRED`

### `AC-SLICE-001-22` — The hub count is independent of the stop count

```text
Given a stop closed PARTIALLY_COLLECTED with a collected count of 3,
When the consignment reaches the hub and an intake is created,
Then rider_declared_count is captured at handover,
And it is not seeded, defaulted or derived from collected_count,
And the hub blind count runs exactly as it would for a full collection.
```

**Governs:** `MSC-DEC-194` part 3, §35.5 · **Surface:** Melarc Ops · **Test level:** service

### `AC-SLICE-001-23` — Handshake direction cannot be reversed

```text
Given a registered vendor pickup,
When the handshake runs,
Then the rider device displays the code and the vendor enters it in Melarc Vendor,
And for an ad-hoc sender the code is sent by SMS to the recorded sender and entered by the rider,
And neither direction can be swapped by configuration.
```

**Governs:** §21.4, `MSC-DEC-114–115` · **Surface:** Melarc Rider, Melarc Vendor · **Test level:** integration

### `AC-SLICE-001-24` — Fallback ladder escalates in order and logs every rung

```text
Given the portal path is unusable at the door,
When the rider triggers the SMS fallback,
Then the code is sent only to the vendor registered number,
And the handshake channel records SMS_FALLBACK,
And when SMS also fails and Ops authorises an override, the channel records OPS_OVERRIDE with actor and reason,
And a successful portal handshake records PORTAL rather than leaving the channel unset.
```

**Governs:** §21.4, `MSC-DEC-198` · **Surface:** Melarc Rider, Melarc Ops · **Test level:** integration · **Code:** `NO_REGISTERED_NUMBER`

### `AC-SLICE-001-25` — Busy is not a fallback trigger

```text
Given a vendor who is present but too busy to enter the code,
When the rider attempts to escalate to the SMS fallback with the trigger VENDOR_BUSY (the fallback request names its trigger, and only NO_DATA and PORTAL_DOWN are technical failures),
Then the backend refuses with VALIDATION_FAILED and no SMS is sent, and the Rider app offers no such trigger,
And after rider_door_wait_minutes the rider may fail the stop through the ordinary failure flow.
```

**Governs:** §21.4, `MSC-DEC-198`, `MSC-DEC-201` · **Surface:** Melarc Rider · **Test level:** API, e2e · **Code:** `VALIDATION_FAILED`

### `AC-SLICE-001-26` — TTL expiry blocks late self-confirmation

```text
Given a handshake code whose TTL has expired,
When the vendor submits the correct code,
Then the backend rejects with CODE_EXPIRED,
And the handshake routes to Ops,
And the physical collection state is unchanged.
```

**Governs:** §21.4 · **Surface:** Melarc Vendor · **Test level:** API · **Code:** `CODE_EXPIRED`

### `AC-SLICE-001-27` — A dispute does not reverse physical completion

```text
Given a stop closed COLLECTED (its handshake verified or overridden),
When the vendor disputes the collection,
Then a reconciliation item is raised,
And the stop remains COLLECTED,
And the manifest may still complete without waiting for the dispute to be resolved.
```

**Governs:** §21.4 · **Surface:** Melarc Vendor · **Test level:** service

### `AC-SLICE-001-28` — Ad-hoc sender promotes on physical completion

```text
Given a PROVISIONAL ad-hoc sender,
When a collection with a count above zero is recorded for that sender,
Then the sender becomes REUSABLE and searchable,
And promotion does not wait for the handshake response.
```

**Governs:** §21.3, §35.2.7 · **Surface:** Melarc Ops · **Test level:** service

### `AC-SLICE-001-29` — Collection is idempotent under replay

```text
Given a rider device that submits a collection and loses connectivity before the response,
When the device replays the same payload with the same idempotency key,
Then the original result is returned and no second collection record is created,
And a different payload under the same key returns IDEMPOTENCY_KEY_CONFLICT.
```

**Governs:** §35.3.9, §36.1 · **Surface:** Melarc Rider · **Test level:** API · **Code:** `IDEMPOTENCY_KEY_CONFLICT`

**Note.** This criterion tests **replay safety on a flaky connection**, not offline composition. **Collection is online-only in Version 1**, so there is no offline composition to test.

### `AC-SLICE-001-73` — SMS fallback is capped and cooled down, server-side

```text
Given a PickupStop whose handshake has already used its SMS fallback sms_fallback_max_per_pickup times,
When the rider triggers requestSmsHandshakeFallback again,
Then the request is refused with SMS_FALLBACK_LIMIT_REACHED,
And no SMS is sent,
And the rider's next available path is Fallback 2, authoriseHandshakeOverride.

Given a PickupStop whose handshake sent its last fallback SMS less than sms_fallback_cooldown_seconds ago,
When the rider triggers requestSmsHandshakeFallback again,
Then the request is refused with SMS_FALLBACK_LIMIT_REACHED,
And no SMS is sent.
```

**Governs:** §21.4, `MSC-DEC-198` · **Surface:** Melarc Rider · **Test level:** API · **Code:** `SMS_FALLBACK_LIMIT_REACHED`

*CRIT-08 audit remediation. Before this criterion, only the generic 120/minute authenticated-API bucket bounded this operation — a cost- and harassment-bearing SMS send with no cap of its own.*

### `AC-SLICE-001-86` — The photos make the count

```text
Given a stop the rider has arrived at, with a declared count of 3,
And three parcel photos of this stop that are STORED and were captured by this rider,
When the rider records a collected count of 3 and names the three photos,
Then the count is recorded and the three photos are attached to it, once,
And a collected count of 3 with two photos, with four, or with none is refused with VALIDATION_FAILED (rule parcel_photo_count) and nothing is recorded,
And a collected count of 2 with three photos is refused the same way,
And the same photo named twice is refused (rule duplicate),
And a record inserted directly, by any login, with a number of photos other than its count is refused by the database at the end of its transaction.
```

**Governs:** D-A10 (12 November 2026), [§5.5](#55-the-photo-of-every-parcel) · **Surface:** Melarc Rider · **Test level:** API, database · **Code:** `VALIDATION_FAILED` · **Status:** built in the API (Run A2, migration `0088`; `parcel-photos.db.test.ts`); the camera is SLICE-016's.

### `AC-SLICE-001-87` — Only a stored photo of this rider and this stop counts, and once

```text
Given a count that names a photo,
When the photo is still PENDING_UPLOAD, has EXPIRED, was captured by another rider, is of another stop, is of another purpose, or is already attached to a count,
Then the count is refused with EVIDENCE_NOT_STORED, the same answer for each, and nothing is recorded,
And a photo that was attached to a count cannot be attached to another, by any writer,
And a parcel photo cannot be attached to a failure, nor a failure's photo counted as a parcel.
```

**Governs:** D-A10, [domain-model.md §3.6](../../contracts/domain-model.md#36-evidence) · **Surface:** Melarc Rider · **Test level:** API, database · **Code:** `EVIDENCE_NOT_STORED` · **Status:** built in the API (Run A2, migration `0088`; `parcel-photos.db.test.ts`, `pickup-stop-evidence-policies.db.test.ts`).

### `AC-SLICE-001-88` — Ops lets a stop's count through without photos, and it is on record

```text
Given a stop the rider has arrived at, on a run in progress, with no count yet,
When an officer who holds pickup.handshake.override in the stop's hub authorises the exception with a note,
Then one exception is recorded for the stop (the officer, the moment on the database's clock, the note) with an enhanced audit event,
And the rider's count of that stop takes no parcel photos, and a count that names some is refused,
And a stop that was not let through cannot be counted without photos,
And a stop that already has a count cannot be let through (STATE_CONFLICT, collection_recorded),
And the exception cannot be made twice for a stop, changed or removed, by any writer,
And a note is required (REASON_REQUIRED), an officer of another hub is refused (HUB_SCOPE_VIOLATION) and a caller without the key is refused (PERMISSION_DENIED).
```

**Governs:** D-A10, [§5.5](#55-the-photo-of-every-parcel), `MSC-DEC-204` · **Surface:** Melarc Ops · **Test level:** API, database · **Code:** `REASON_REQUIRED`, `STATE_CONFLICT`, `HUB_SCOPE_VIOLATION`, `PERMISSION_DENIED` · **Status:** built in the API (Run A2, migration `0088`; `parcel-photos.db.test.ts`); the screen is S1.30's.

### `AC-SLICE-001-91` — A registered vendor sees its stop's photos, and an individual sender does not

```text
Given a collection with parcel photos for a registered vendor's pickup,
When the vendor opens the screen where it enters the code, and later its pickup history,
Then the photos of that stop are shown, and no other vendor's,
And for an individual sender's pickup no photo is shown to the sender, in any message or page.
```

**Governs:** D-A10, [§5.5](#55-the-photo-of-every-parcel) · **Surface:** Melarc Vendor · **Test level:** API (the read), client · **Status:** owed by SLICE-015 (`OB-S1-83`); no read of a vendor's own stop's photos exists yet.

---

## 14. Open questions blocking this feature

| ID| What it blocks here| Type|
|---|---|---|
| `OQ-048`| The SMS provider and the code message templates. The handshake parameters themselves were confirmed by `MSC-DEC-256`| `EXTERNAL_INPUT` — blocks **launch**|
| ~~`OQ-027`~~| **No longer bears on this feature — `MSC-DEC-415`, 26 September 2026.** Collection is online-only in Version 1, and `AC-SLICE-001-29` tests replay safety, which the command's idempotency already carries. `OQ-027` narrows to the design of the queued hub handover, which is not this feature's.| —|

No `DECISION_NEEDED` question blocks this feature.

## 15. What this feature still owes its slice

| Owed| Blocks which DoR area| Owner|
|---|---|---|
| ~~Offline action set — this feature leans on it heavily~~ — **discharged by `MSC-DEC-415`**: collection is online-only in Version 1, so nothing here waits on an offline design| —| ~~`OQ-027`~~|
| SMS provider and templates for the handshake code| E — launch| `OQ-048`|
| The retention category (and period) of a parcel photo, which must outlast the order's delivery, return and dispute; how the small copy for lists is made| F — launch (the period); the list task (the copy)| `OQ-028`; `OB-S1-86`|
| The later tasks the photo of every parcel binds: the stop's photos and the exception screen (S1.30), the receiving side's blind-count rule (Stage 6), the order's photo (Stage 7), the vendor's view (SLICE-015), the camera and the upload queue (SLICE-016), the order list and page| per task| `OB-S1-80` to `OB-S1-85`|

**The handshake operations exist**: `initiateHandshake`, `verifyHandshake`, `requestSmsHandshakeFallback` and `authoriseHandshakeOverride` were added on 20 August. §12 said otherwise until the Slice 001 reconciliation.

**Readiness is not assessed here.** [definition-of-ready.md](../../standards/definition-of-ready.md) assesses it **for the complete vertical slice** and records the verdict in the slice document; a feature cannot answer §44.3 or §44.4 alone. This section feeds that assessment instead of duplicating it (`MSC-DEC-239`, closing `CONFLICT-029`).

## 16. Build status — *honest, per surface*

| Surface| Status| Gap|
|---|---|---|
| API (`apps/api`)| 🟢 built (S1.27)| The five handshake operations, the texts of the sender's code and of the SMS fallback (words unapproved: OB-S1-06), the database rules; the dispute (S1.29) is built beside them; the sub-ceiling for operations that cause a text is built (review closeout of 5 November 2026, `OB-S1-65`): `initiateHandshake` and `requestSmsHandshakeFallback` declare it, with `confirmPickupRequest`, `dispatchManifest` and `skipPickupStop`|
| Melarc Rider| ⚪ not built| Everything: the counting camera, the shrinking, the upload queue (SLICE-016, `OB-S1-84`)|
| Melarc Vendor| ⚪ not built| Everything, and the vendor's view of its stop's photos (SLICE-015, `OB-S1-83`)|
| Melarc Ops| ⚪ not built| The stop's photos with their upload progress and the screen for Ops's exception (S1.30, `OB-S1-80`); the screens of the override path, the shortfall flag, the handshakes routed to Ops and the disputes (S1.30); **their reads exist** (`listHandshakesForOps`, `listCollectionShortfalls`, `listCollectionDisputes`, Run A)|
| Recipient channel| ⚪ not built| Ad-hoc SMS code delivery|

## 17. Related

- **Upstream:** [pickup-manifest.md](pickup-manifest.md) — the run that brings the rider here
- **Downstream:** `features/hub/hub-intake.md` — where the independent blind count happens
- **Sibling:** [pickup-failure.md](pickup-failure.md) — where a zero count and an expired door wait both lead
- **Slice:** `SLICE-001`
