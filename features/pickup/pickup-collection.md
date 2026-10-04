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
| §21.4| Collection confirmation: the overlay, code direction, TTL, attempts, dispute|
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
- The stop has reached `ARRIVED` — which also closes the vendor cancellation window.

---

## 5. Behaviour

### 5.1 Normal path

1. **The rider arrives.** The stop becomes `ARRIVED`.
2. **The rider counts and records.** `collected_count` is the **actual** count, never the declared one (§35.3.6). A vendor note is optional.
3. **If the counts differ, a variance reason is mandatory** (§21.3). `variance` records `MATCH` or `SHORT` on **every** collection — a clean count is a recorded outcome, not an absence.
4. **The handshake runs.** A code is generated and delivered by the direction fixed for that sender type. Verification within TTL confirms.
5. **The stop closes** as `COLLECTED` or `PARTIALLY_COLLECTED`.
6. **A provisional ad-hoc sender is promoted to reusable** on physical completion — **without waiting for the handshake response** (§21.3).
7. Custody passes to the hub at handover, where the **blind count runs independently**.

### 5.2 Exception paths

| Path| Behaviour| Error code|
|---|---|---|
| **Zero packages**| **Never a completed stop.** Zero collection routes to the failure flow with an approved category. The system must not create an empty completed stop, sender set or hub handover (§21.3, `MSC-DEC-120`)| `ZERO_COLLECTION_IS_FAILURE`|
| **Short count**| Permitted. Stop closes `PARTIALLY_COLLECTED` with a mandatory variance reason, and **office is flagged in-system at the time of the shortfall** — supplementing the rider's phone call, never replacing it| `REASON_REQUIRED`|
| Handshake code wrong| Returns remaining attempts (§21.4)| `CODE_INVALID`|
| Attempts exhausted| Code invalidated, routed to Ops (§21.4)| `ATTEMPTS_EXHAUSTED`|
| TTL expired| Routed to Ops; **late self-confirmation is blocked** (§21.4)| `CODE_EXPIRED`|
| **Portal unusable — no data, portal down**| **Fallback 1:** rider triggers SMS to the vendor's **registered number only**. Logged as `SMS_FALLBACK`. **Server-enforced per stop** (CRIT-08 audit remediation): capped at `sms_fallback_max_per_pickup` (3) sends, no closer together than `sms_fallback_cooldown_seconds` (60) apart| `NO_REGISTERED_NUMBER`|
| **SMS fallback exhausted or attempted too fast**| **Refused, not silently retried.** The rider needs Fallback 2, not another SMS — this is the ladder working as designed, not a dead end (CRIT-08 audit remediation)| `SMS_FALLBACK_LIMIT_REACHED`|
| **SMS also fails**| **Fallback 2:** rider contacts Ops, who verifies the vendor by another means and authorises as a recorded exception. Logged as `OPS_OVERRIDE`| `INSUFFICIENT_AUTHORITY`, `REASON_REQUIRED`|
| **Vendor simply busy**| **Not a fallback trigger.** The ladder addresses technical failure, not inattention. The rider waits `rider_door_wait_minutes` (10) and may then fail the stop| —|
| Vendor disputes| Raises reconciliation **without reversing physical completion** (§21.4)| —|
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
- **Never block manifest completion on handshake confirmation.** §21.4: "manifest completion does not wait for confirmation."

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
| `handshake_code_length`, `handshake_code_ttl_minutes`, `handshake_max_wrong_attempts`| **`PROVISIONAL`** — carry values (4, 15, 5) but await security review under `OQ-048`. Not authoritative| [settings.md](../../contracts/settings.md) §7.4|
| `sms_fallback_max_per_pickup`, `sms_fallback_cooldown_seconds`| **`CONFIRMED`** (3, 60). The SMS fallback's own cap and cooldown, independent of the generic authenticated-API rate-limit bucket (CRIT-08 audit remediation)| [settings.md](../../contracts/settings.md) §7.4|

## 10. Errors — *pointer*

`ZERO_COLLECTION_IS_FAILURE`, `HANDSHAKE_NOT_VERIFIED`, `CODE_INVALID`, `CODE_EXPIRED`, `ATTEMPTS_EXHAUSTED`, `NO_REGISTERED_NUMBER`, `SMS_FALLBACK_LIMIT_REACHED`, `COLLECTION_NOT_RECORDED`, `DELIVERY_CHANNEL_FAILED`, `REASON_REQUIRED`, `NOT_ASSIGNED_RIDER`, `IDEMPOTENCY_KEY_CONFLICT` — [errors-and-enums.md](../../contracts/errors-and-enums.md).

## 11. Audit events — *pointer*

`pickup.stop.collected`, `pickup.stop.partially_collected`, `pickup.handshake.generated`, `pickup.handshake.delivered`, `pickup.handshake.verified`, `pickup.handshake.disputed`, `pickup.handshake.manually_resolved`, `pickup.handshake.fallback_sms`, `pickup.handshake.fallback_override` *(enhanced)* — [audit.md](../../contracts/audit.md) §5.1.

**Every identifier is spelled in full.** The suffix form — `` `.dispatched` `` after `` `pickup.manifest.created` `` — is not a resolvable identifier: no check can verify it, and it still reads correctly after the code it points at is renamed.

**Handshake codes are never logged** — the event records that a code was generated, never its value (§38.2, audit §9).

## 12. API operations — *pointer*

`arriveAtPickupStop`, `recordCollection` — [openapi.yaml](../../contracts/openapi.yaml). **`arriveAtPickupStop` added 16 September 2026** (`MSC-DEC-392`, resolving `CONFLICT-038`): §5.1 step 1 has read *the rider arrives; the stop becomes `ARRIVED`* throughout, §4 makes `ARRIVED` a precondition of collection, and **no operation reached it** — `recordCollection` closed an `ARRIVED` stop that nothing could open. Handshake verification and the two fallback escalations are **not yet in the contract**; they are added when this feature reaches `READY`.

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
And when a reason is supplied the stop becomes PARTIALLY_COLLECTED,
And an office notification is raised at that moment,
And office_notified_at is recorded.
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

**Governs:** `MSC-DEC-198` · **Surface:** Melarc Rider, Melarc Ops · **Test level:** integration · **Code:** `NO_REGISTERED_NUMBER`

### `AC-SLICE-001-25` — Busy is not a fallback trigger

```text
Given a vendor who is present but too busy to enter the code,
When the rider attempts to escalate to the SMS fallback on that basis,
Then no technical-failure fallback is available,
And after rider_door_wait_minutes the rider may fail the stop through the ordinary failure flow.
```

**Governs:** `MSC-DEC-198`, `MSC-DEC-201` · **Surface:** Melarc Rider · **Test level:** e2e

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
Given a stop closed COLLECTED,
When the vendor disputes the collection,
Then a reconciliation item is raised,
And the stop remains COLLECTED,
And the manifest may still complete without waiting for confirmation.
```

**Governs:** §21.4 · **Surface:** Melarc Vendor · **Test level:** service

### `AC-SLICE-001-28` — Ad-hoc sender promotes on physical completion

```text
Given a PROVISIONAL ad-hoc sender,
When a physical pickup for that sender completes successfully,
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

**Governs:** `MSC-DEC-198` · **Surface:** Melarc Rider · **Test level:** API · **Code:** `SMS_FALLBACK_LIMIT_REACHED`

*CRIT-08 audit remediation. Before this criterion, only the generic 120/minute authenticated-API bucket bounded this operation — a cost- and harassment-bearing SMS send with no cap of its own.*

---

## 14. Open questions blocking this feature

| ID| What it blocks here| Type|
|---|---|---|
| `OQ-048`| Handshake TTL, code length and attempt limits are `PROVISIONAL` pending security review. Behaviour is specified; the parameters are not authoritative| `EXTERNAL_INPUT` — blocks **launch**|
| ~~`OQ-027`~~| **No longer bears on this feature — `MSC-DEC-415`, 26 September 2026.** Collection is online-only in Version 1, and `AC-SLICE-001-29` tests replay safety, which the command's idempotency already carries. `OQ-027` narrows to the design of the queued hub handover, which is not this feature's.| —|

No `DECISION_NEEDED` question blocks this feature.

## 15. What this feature still owes its slice

| Owed| Blocks which DoR area| Owner|
|---|---|---|
| ~~Offline action set — this feature leans on it heavily~~ — **discharged by `MSC-DEC-415`**: collection is online-only in Version 1, so nothing here waits on an offline design| —| ~~`OQ-027`~~|
| Handshake security parameters| E — launch| `OQ-048`|

**The handshake operations exist**: `initiateHandshake`, `verifyHandshake`, `requestSmsHandshakeFallback` and `authoriseHandshakeOverride` were added on 20 August. This section called all four missing.

**Readiness is not assessed here.** [definition-of-ready.md](../../standards/definition-of-ready.md) assesses it **for the complete vertical slice** and records the verdict in the slice document; a feature cannot answer §44.3 or §44.4 alone. This section feeds that assessment instead of duplicating it (`MSC-DEC-239`, closing `CONFLICT-029`).

## 16. Build status — *honest, per surface*

| Surface| Status| Gap|
|---|---|---|
| Melarc Rider| ⚪ not built| Everything|
| Melarc Vendor| ⚪ not built| Everything|
| Melarc Ops| ⚪ not built| Override path and shortfall flag|
| Recipient channel| ⚪ not built| Ad-hoc SMS code delivery|

## 17. Related

- **Upstream:** [pickup-manifest.md](pickup-manifest.md) — the run that brings the rider here
- **Downstream:** `features/hub/hub-intake.md` — where the independent blind count happens
- **Sibling:** [pickup-failure.md](pickup-failure.md) — where a zero count and an expired door wait both lead
- **Slice:** `SLICE-001`
