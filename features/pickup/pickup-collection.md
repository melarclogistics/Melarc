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
| Melarc Rider| Rider| Arrive; record collected count and variance reason; capture evidence; display the handshake code; enter an ad-hoc sender's code; trigger the SMS fallback| `pickup.run.execute`, `pickup.collection.confirm` — assigned stop only|
| Melarc Vendor| Vendor account| **Enter the rider-displayed code** in the portal. Dispute a collection| `pickup.collection.confirm` — own pickup only|
| Melarc Ops| Ops Staff| Authorise a handshake override when both prior rungs fail; work the shortfall flag| `pickup.handshake.override`|
| Recipient channel| Ad-hoc sender| Receives the code by SMS and reads it to the rider. **Holds no permission** — the rider enters it| —|

**The handshake direction is fixed and may not be reversed** (§21.4, `MSC-DEC-114–115`): registered vendors *enter* a rider-displayed code; ad-hoc senders *receive* an SMS code the rider enters.

## 4. Preconditions

- The manifest is `IN_PROGRESS` and the stop belongs to the acting rider.
- The stop has reached `ARRIVED`. (The vendor's cancellation window closed earlier, at the assignment: state-machines.md §5, `AC-SLICE-001-12`; arrival writes nothing to the request.)

---

## 5. Behaviour

### 5.1 Normal path

1. **The rider arrives.** The stop becomes `ARRIVED`.
2. **The rider counts and records.** `collected_count` is the **actual** count, never the declared one (§35.3.6). A vendor note is optional.
3. **If the counts differ, a variance reason is mandatory** (§21.3). `variance` records `MATCH` or `SHORT` on **every** collection — a clean count is a recorded outcome, not an absence.
4. **The handshake runs.** Once the count is recorded the system generates a code and delivers it by the direction fixed for that sender type. Verification within TTL confirms; an expired or exhausted code routes to Ops, who may authorise an override.
5. **The stop closes** as `COLLECTED` or `PARTIALLY_COLLECTED` when the handshake is verified or overridden. Until then it stays `ARRIVED`.
6. **A provisional ad-hoc sender is promoted to reusable** when the count is recorded — **without waiting for the handshake response** (§21.3).
7. Custody passes to the hub at handover, where the **blind count runs independently**.

**As built (S1.26, `recordCollection`).** Steps 2 and 3 and 6 are built: the rider's count makes the `CollectionRecord` (the actual count, `variance` `MATCH` or `SHORT` on every collection, the reason of a short one from the `PICKUP_SHORT_COUNT` catalogue with the note it asks for), a shortfall raises the office flag in the same transaction (`office_notified_at`; **the Ops feed is told in the same transaction**, a feed entry `COLLECTION_SHORT_OPS_FEED` through the outbox whose wording is a draft until the owner approves it, OB-S1-51, and Ops works the flag from `listCollectionShortfalls`: Run A, 12 November 2026), and a provisional individual sender becomes reusable. **The stop stays `ARRIVED`** and the handshake (steps 4 and 5) is the next task's. **The count has an audit event of its own, `pickup.collection.recorded`** (OB-S1-54, decided on 4 November 2026): it says that a count was recorded and that the stop is still `ARRIVED`, the same for a clean count and a short one, and `pickup.stop.collected` and `pickup.stop.partially_collected` are written only when the handshake closes the stop, so a count whose handshake never finishes is never read as a completed collection. **The facts of the record that are the catalogue's and the clock's are the database's** (OB-S1-60, decided on 4 November 2026): the reason of a short count is an active reason of the catalogue as the catalogue holds it (its code, its label and its attribution, with the rider's note where the reason asks for one), and the recording and the office flag are the database's own instants, taken once the stop is locked, apart from the device's moment (`captured_at`). A short count whose reason asks for a photo is `REASON_REQUIRED` until evidence can be stored (OB-S1-52); **a count above the declared one is refused** (OB-S1-50). **A stop with a record is never skipped, failed or cancelled away** (approved on 4 November 2026, [§5.4](#54-a-stop-that-has-been-counted)): it waits for the handshake.

**As built (S1.27, the collection handshake; migration `0070`).** Steps 4 and 5 are built, as five operations of the database that no other statement can imitate. The rider that recorded the count asks for the code (`initiateHandshake`); the database keeps a **keyed digest** of the live code and never the code, which is derived from the stop and the generation under a key of the `credential_delivery` purpose, shown once to the rider (a vendor's pickup: `display_code`) or texted by the notification lane (an individual sender's pickup, to the sender's number alone, with no link), and which appears in no log, metric, event or stored answer. The vendor enters the code its rider shows (`verifyHandshake`, channel `PORTAL`); the rider enters the code a sender received. **Each wrong code is counted by the database whatever the application does** and the last one ends the code (`ATTEMPTS_EXHAUSTED`); a code past `handshake_code_ttl_minutes` on the database's clock is `CODE_EXPIRED`, is kept expired and routes to Ops, and the right code after either is refused (late self-confirmation, `AC-SLICE-001-26`). The SMS fallback (`requestSmsHandshakeFallback`) makes a **new** code the rider has not seen and texts it to the vendor's registered number only; the cap and the cooldown are the database's, for every process (`SMS_FALLBACK_LIMIT_REACHED`, `AC-SLICE-001-73`), the code the rider displayed no longer verifies, the wrong attempts already counted stay counted, and the rider then enters what the vendor read out (channel `SMS_FALLBACK`). **The registered number is the phone of the vendor's credential** (F-23, resolved in the review closeout of 5 November 2026, migration `0073`; the Product Owner's confirmation is open, plan `OB-S1-62`): `VendorCredential.recovery_phone` where the credential's `delivery_channel` is `PHONE`, which is the number the vendor's own setup and recovery messages go to. It is entered at registration, chosen as the delivery channel by the approver, and proven by possession (the vendor set its secret from the grant that was texted to it: a credential whose secret was never set has no registered number); the organisation's business contact number is not an authentication channel (domain-model.md) and the fallback never goes to it. The lane reads no table for it: the database gives it to the one lane that sends the text, for the request its envelope names and only while a fallback code is live, and the message log keeps no hint of it. No operation changes the number in `SLICE-001`; a change is a later slice's act and must be an authorised, verified one (a grant to the new number, as at approval). **The length of a code is kept with it** (`code_length`, migration `0073`): the setting `handshake_code_length` is read when a code is made, and a setting changed after a code was made, sent or queued applies to the next code and cannot change the length of one that is out, so the text carries the length the vendor or the rider will be asked to type; the handshakes that existed when the column was added took the setting then in force. Ops overrides (`authoriseHandshakeOverride`, `pickup.handshake.override`: from a stop that is counted and arrived at, whatever the handshake stood at, with a note) and Senior Ops resolve (`resolveHandshake`, `pickup.handshake.resolve`: an expired or exhausted handshake, or a live one whose life has passed, with a note); each writes an enhanced event with the note. **The stop closes in the same change as the handshake ends**, as the count says (`COLLECTED` for `MATCH`, `PARTIALLY_COLLECTED` for `SHORT`), and the close writes `pickup.stop.collected` or `pickup.stop.partially_collected`; an abandoned handshake writes neither. Every rung writes its channel; the record's `handshake_channel`, `handshake_confirmed_at` and `handshake_override_by` are set once, by the close. Evidence on a manual resolution is `EVIDENCE_NOT_STORED` until the evidence store (S1.28) exists.

**As built (S1.29, the collection dispute; migration `0071`).** The vendor whose pickup it is disputes a collection that has closed (`disputeCollection`, `pickup.collection.confirm` on the Vendor surface): the database raises the **reconciliation item** (`collection_dispute`: the stop, the organisation, the vendor principal, the vendor's note, `OPEN`), sets the stop's handshake `DISPUTED` and writes `pickup.handshake.disputed` (the actor and the note), in one change, under the stop's lock. **It never reverses physical completion**: the stop stays `COLLECTED` or `PARTIALLY_COLLECTED` (the operation does not touch it) and the manifest does not wait for the item; a run whose other stops are settled completes as it would have. A stop that has not closed through its handshake, a skipped stop and a failed one have no collection to dispute (`STATE_CONFLICT`, `details.rule` `stop_not_closed`; a failed stop has no dispute form by design, `AC-SLICE-001-35`); a second dispute of the same collection is `dispute_open`; another vendor's stop and an id that matches nothing are `NOT_FOUND`, the same. The item is readable by Ops in the stop's hub and by the vendor that raised it (the policies of the table say so; Ops reads the items with `listCollectionDisputes` (Run A, 12 November 2026; its screen is S1.30's), and **no operation lets the vendor read its own item yet**: that view is a later screen's and needs an operation added to the contract first, plan `OB-S1-70`); its resolution is the detailed Ops reconciliation workflow that the specification leaves to downstream design, and **no operation resolves it in `SLICE-001`**.

### 5.2 Exception paths

| Path| Behaviour| Error code|
|---|---|---|
| **Zero packages**| **Never a completed stop.** Zero collection routes to the failure flow with an approved category. The system must not create an empty completed stop, sender set or hub handover (§21.3, `MSC-DEC-120`)| `ZERO_COLLECTION_IS_FAILURE`|
| **Short count**| Permitted. The stop closes `PARTIALLY_COLLECTED`, once the handshake is verified or overridden, with a mandatory variance reason recorded at the count, and **office is flagged in-system when the shortfall is recorded** — supplementing the rider's phone call, never replacing it| `REASON_REQUIRED`|
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
| `pickup.handshake.override`| **Ops**| own hub. Verification, not waiver — hence Ops rather than Senior Ops||

## 9. Settings — *pointer*

| Key| Why this feature reads it| Home|
|---|---|---|
| `rider_door_wait_minutes`| 10. How long before a busy vendor becomes a failed stop| [settings.md](../../contracts/settings.md) §7.3|
| `handshake_code_length`, `handshake_code_ttl_minutes`, `handshake_max_wrong_attempts`| **`CONFIRMED`** (4, 15, 5) — reviewed and confirmed by `MSC-DEC-256` (settings.md owns the status). **Seeded as platform settings and read by S1.27** (migration `0070`; the seed writes the same rows): the database reads the life and the limit inside its operations, the API reads the length once, when it makes a code, and the database keeps it with the code (`code_length`, migration `0073`: the notification lane reads the stored length and not the setting)| [settings.md](../../contracts/settings.md) §7.4|
| `sms_fallback_max_per_pickup`, `sms_fallback_cooldown_seconds`| **`CONFIRMED`** (3, 60). The SMS fallback's own cap and cooldown, independent of the generic authenticated-API rate-limit bucket (CRIT-08 audit remediation). **Held by the database per stop (S1.27)**, in the handshake's own counters| [settings.md](../../contracts/settings.md) §7.4|

## 10. Errors — *pointer*

`ZERO_COLLECTION_IS_FAILURE`, `HANDSHAKE_NOT_VERIFIED`, `CODE_INVALID`, `CODE_EXPIRED`, `ATTEMPTS_EXHAUSTED`, `NO_REGISTERED_NUMBER`, `SMS_FALLBACK_LIMIT_REACHED`, `COLLECTION_NOT_RECORDED`, `DELIVERY_CHANNEL_FAILED`, `REASON_REQUIRED`, `NOT_ASSIGNED_RIDER`, `IDEMPOTENCY_KEY_CONFLICT` — [errors-and-enums.md](../../contracts/errors-and-enums.md).

## 11. Audit events — *pointer*

`pickup.collection.recorded` *(the count; the stop stays `ARRIVED`)*, `pickup.stop.collected`, `pickup.stop.partially_collected` *(the close of the stop, by the handshake)*, `pickup.handshake.generated`, `pickup.handshake.delivered`, `pickup.handshake.verified`, `pickup.handshake.disputed`, `pickup.handshake.manually_resolved`, `pickup.handshake.fallback_sms`, `pickup.handshake.fallback_override` *(enhanced)* — [audit.md](../../contracts/audit.md) §5.1.

**Every identifier is spelled in full.** The suffix form — `` `.dispatched` `` after `` `pickup.manifest.created` `` — is not a resolvable identifier: no check can verify it, and it still reads correctly after the code it points at is renamed.

**Handshake codes are never logged** — the event records that a code was generated, never its value (§38.2, audit §9).

## 12. API operations — *pointer*

`arriveAtPickupStop`, `recordCollection` — [openapi.yaml](../../contracts/openapi.yaml). **`arriveAtPickupStop` added 16 September 2026** (`MSC-DEC-392`, resolving `CONFLICT-038`): §5.1 step 1 has read *the rider arrives; the stop becomes `ARRIVED`* throughout, §4 makes `ARRIVED` a precondition of collection, and **no operation reached it** — `recordCollection` closed an `ARRIVED` stop that nothing could open. The handshake operations (`initiateHandshake`, `verifyHandshake`, `requestSmsHandshakeFallback`, `authoriseHandshakeOverride`) are in the contract, added on 20 August, and `resolveHandshake` was added with the Slice 001 reconciliation; **all five are built (S1.27)**. `disputeCollection` is built too (S1.29). **Three Ops reads of what the collection makes were added by Run A (12 November 2026, D-A3, `OB-S1-70`)** so that the office finds and works it: `listCollectionDisputes` (`pickup.read`; the items a vendor raised, `open` = still `OPEN`: no operation resolves one yet), `listHandshakesForOps` (`pickup.handshake.override`; the handshakes that **need Ops now**: state `EXPIRED` or `EXHAUSTED`, a live code past its life on the database's clock, or the fallback sends at the platform cap, each item saying why in `routed_because`; `open=false` is the ones Ops settled by override or by hand) and `listCollectionShortfalls` (`pickup.handshake.override`, the key this document gives for working the shortfall flag; the short counts flagged to the office, `open` = the run still in progress, because nothing yet marks a shortfall as worked). Each is a `GET` for Ops staff only, by the hubs of the grant (an audited crossing, as the other hub reads), cursor-paged oldest first, with `open` and `hub_id`; **no code, digest, phone, address or Ops note is in an item**. Their names and the meaning of `open` are provisional until the screens (S1.30) use them.

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

**The handshake operations exist**: `initiateHandshake`, `verifyHandshake`, `requestSmsHandshakeFallback` and `authoriseHandshakeOverride` were added on 20 August. §12 said otherwise until the Slice 001 reconciliation.

**Readiness is not assessed here.** [definition-of-ready.md](../../standards/definition-of-ready.md) assesses it **for the complete vertical slice** and records the verdict in the slice document; a feature cannot answer §44.3 or §44.4 alone. This section feeds that assessment instead of duplicating it (`MSC-DEC-239`, closing `CONFLICT-029`).

## 16. Build status — *honest, per surface*

| Surface| Status| Gap|
|---|---|---|
| API (`apps/api`)| 🟢 built (S1.27)| The five handshake operations, the texts of the sender's code and of the SMS fallback (words unapproved: OB-S1-06), the database rules; the dispute (S1.29) is built beside them; the sub-ceiling for operations that cause a text is built (review closeout of 5 November 2026, `OB-S1-65`): `initiateHandshake` and `requestSmsHandshakeFallback` declare it, with `confirmPickupRequest`, `dispatchManifest` and `skipPickupStop`|
| Melarc Rider| ⚪ not built| Everything|
| Melarc Vendor| ⚪ not built| Everything|
| Melarc Ops| ⚪ not built| The screens of the override path, the shortfall flag, the handshakes routed to Ops and the disputes (S1.30); **their reads exist** (`listHandshakesForOps`, `listCollectionShortfalls`, `listCollectionDisputes`, Run A)|
| Recipient channel| ⚪ not built| Ad-hoc SMS code delivery|

## 17. Related

- **Upstream:** [pickup-manifest.md](pickup-manifest.md) — the run that brings the rider here
- **Downstream:** `features/hub/hub-intake.md` — where the independent blind count happens
- **Sibling:** [pickup-failure.md](pickup-failure.md) — where a zero count and an expired door wait both lead
- **Slice:** `SLICE-001`
