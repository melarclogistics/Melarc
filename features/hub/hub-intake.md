# Hub Intake

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.11 (cleaned edition)
> **Date:** 4 October 2026
> **Domain:** `hub`
> **Owns:** the behaviour and acceptance criteria for the custody boundary — rider handover, the blind physical count, and OS&D
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §22, §35.5, §36.6
> **Slice:** `SLICE-001`

## 1. What this is, and why

Hub receiving is **the custody boundary** between rider road operations and Melarc's controlled inventory. §22.1 is emphatic that it "must be a distinct act, **not an automatic consequence of rider pickup completion**."

The mechanism is a **blind count**: the receiver enters what is physically present without seeing what the rider declared. The system then reveals the comparison. This is the single most protected rule in the product, and it is enforced by schema rather than by discipline.

**Version 1 boundary.** Intake establishes what arrived and in what condition. It does not price, does not itemize, and does not decide dispatch. It ends when the physical count is reconciled and the intake is eligible for itemization.

## 2. Governing sections

| Section| What it governs here|
|---|---|
| §22.1| Receiving as a distinct custody act|
| §22.2| Rider handover — availability, count rows, pre-fill with correction, idempotency, offline|
| §22.3| The awaiting-receive queue, and what it must not expose|
| §22.4| The seven-step blind receive|
| §22.5| OS&D — three independent dimensions, fixed condition enum, senior review|
| §22.6| Intake lifecycle|
| §22.7| Count-parity control — the hub count is the close authority|
| §22.8| Concurrency and the advisory soft lock|
| §22.9| What vendors may see|
| §35.5| Hub-receiving rules|


## 3. Surfaces and actors

| Surface| Actor| Can do| Gated by|
|---|---|---|---|
| Melarc Rider| Rider| Submit the handover after all stops are terminal; correct the pre-filled count before submission| `hub.handover.submit` — owned completed run|
| Melarc Ops| Ops Staff| Open an intake, acquire the receive lock, submit the blind count, record OS&D, resolve a clean variance| `hub.intake.count`|
| Melarc Ops| Senior Ops| Adjudicate `DAMAGED`, `TAMPERED` and disputed cases| `hub.osd.adjudicate`|
| Melarc Ops| Platform Admin| Reopen a closed intake — privileged and audited| `hub.intake.reopen`|
| Melarc Vendor| Vendor account| **Receives the intake-completed and order summary only.** Blind counts, the rider declaration, discrepancy evidence and internal adjudication are Ops-only (§22.9)| —|

## 4. Preconditions

- The manifest is `COMPLETED` — handover is available only after **all** run stops are terminal (§22.2).
- At least one stop collected a non-zero count. **A zero collected count must never produce a completed handover or an empty intake** (§22.2, `MSC-DEC-120`).

---

## 5. Behaviour

### 5.1 Normal path

1. **The custody holder submits the handover** — one row per pickup request collected on the run (§22.2, `MSC-DEC-416`), each **pre-filled from that request's collected total and correctable before submission**, with a read-only total. It carries the device's capture time, is idempotent, and is Version 1's one offline command. **Each row opens one intake**; a request with nothing collected has no row and no intake. **A zero row is legal** — that request's parcels are not in the handover — and its intake opens all the same.
2. **Each intake appears in the awaiting-receive queue** (`listHubIntakes`) with its run and the rider who handed it over, its sender-set and intake references, submission timing, whether another user is actively receiving, and required evidence indicators (§22.3) — **and never its declared count**, a zero one included.
3. **A receiver acquires the advisory soft lock** (`acquireIntakeLock`, §22.8), which shows who is receiving and permits takeover after an idle TTL.
4. **The receiver enters the physical count without seeing the declaration** (§22.4 steps 1–2).
5. **The backend reveals the server-owned rider declaration and calculates variance** (§22.4 steps 3–4).
6. **Any required discrepancy or condition workflow completes** (§22.4 step 5, §22.5) — **including a zero declaration**, which always goes to Senior Ops.
7. **The intake records `received_at`, `received_by` and the hub received count** and becomes eligible for itemization (§22.4 steps 6–7).

### 5.2 Exception paths

| Path| Behaviour| Error code|
|---|---|---|
| **Declaration served before commit**| The read model must not carry it. §22.3: the queue "must not expose the rider-declared count before the receiver submits the blind physical count"| `BLIND_COUNT_VIOLATED`|
| **Client submits the declaration as input**| Refused. §22.4: "the client must never submit the hidden declared count as authoritative input"| `BLIND_COUNT_VIOLATED`|
| Count variance `SHORT` or `OVER`| Intake moves to `RECONCILIATION_REQUIRED`; the discrepancy workflow runs| —|
| Condition `DAMAGED` or `TAMPERED`| **Supporting evidence and controlled review are required**, and senior review is mandatory (§22.5). `adjudicateDiscrepancy`'s `condition` enum carries all four §22.5 values and `evidence_ids` gates on a `STORED` reference (HIGH-11 audit remediation)| `INSUFFICIENT_AUTHORITY`, `REASON_REQUIRED`, `EVIDENCE_NOT_STORED`|
| **Condition finding on a matching count**| Fully supported. §22.5: damage, tampering or dispute "may be recorded even when the physical count matches"| —|
| Two receivers on one intake| The soft lock shows the active receiver; takeover after idle TTL. **The lock is advisory** — §22.8 requires backend transition and idempotency controls regardless| `STATE_CONFLICT`|
| Handover before all stops terminal| Refused (§22.2)| `STOPS_UNRESOLVED`|
| Zero collected count reaching here| Impossible by rule — routed to pickup failure upstream| `ZERO_COLLECTION_IS_FAILURE`|
| **Zero declared for a collected request**| Legal. The intake opens; after the blind count it goes to `RECONCILIATION_REQUIRED` whatever the variance, and **Senior Ops** resolves it with a reason| `INSUFFICIENT_AUTHORITY` for anyone else|
| Handover rows not exactly the run's collected requests| Refused — a row omitted, repeated, or naming a request not collected on the run| `VALIDATION_FAILED`|
| Same idempotency key, different rows| Refused| `IDEMPOTENCY_KEY_CONFLICT`|
| Run with nothing collected| No handover and no intake: System completes the run (`MSC-DEC-416`, [pickup-manifest.md](../pickup/pickup-manifest.md))| —|
| Rider offline at handover| Queues and retries under the approved offline interaction (§22.2) — Version 1's one offline command. Each intake keeps the device's capture time apart from the server's receipt (§35.3.9)| —|
| Reopen a closed intake| Platform Admin only, privileged and audited (§36.6)| `INSUFFICIENT_AUTHORITY`|

### 5.3 What this feature must never do

- **Never let receiving be automatic.** §22.1: it is a distinct act, not a consequence of pickup completion. An intake created and counted by the same event destroys the control.
- **Never serve or accept the rider declaration before commit.** Both directions. §22.3 guards the read, §22.4 guards the write, and the OpenAPI schema enforces both — `HubIntakePreCount` has no such property and the count request is `additionalProperties: false`.
- **Never seed the hub count from the stop's collected count.** Two independent checks (`MSC-DEC-194` part 3). A package lost between the door and the hub is visible only here.
- **Never use the rider declaration as the close target.** §22.7: the hub's physical count is the intake-close authority; the declaration is **immutable discrepancy history**.
- **Never collapse the three OS&D dimensions.** Count, condition and dispute are independent — a `MATCH` count does not close the condition question.
- **Never rely on the soft lock alone.** §22.8 says so in terms: a visual lock is not sufficient.
- **Never show a vendor the internals.** §22.9 limits them to the intake-completed and order summary.

---

## 6. Entities — *pointer*

| Entity| Home|
|---|---|
| `PickupIntake`| [domain-model.md](../../contracts/domain-model.md) §6.6|
| `Evidence`| [domain-model.md](../../contracts/domain-model.md) §3.6|
| `CollectionRecord`| [domain-model.md](../../contracts/domain-model.md) §6.5 — read for history, never as the close target|

Non-obvious: `rider_declared_count` is **never readable before commit and never seeded** from collection; `condition` is a fixed four-value enum; `active_receiver_id` and `lock_acquired_at` carry the advisory lock.

## 7. States — *pointer*

| Machine| Home| Transitions this feature drives|
|---|---|---|
| `PickupIntake.state`| [state-machines.md](../../contracts/state-machines.md) §7| `AWAITING_COUNT → COUNTED`; `→ RECONCILIATION_REQUIRED`; `→ READY_FOR_ITEMIZATION`; lock acquisition|

## 8. Permissions — *pointer*

| Key| Holders| Scope| Home|
|---|---|---|---|
| `hub.handover.submit`| **Rider only**| owned completed run| [permissions.md](../../contracts/permissions.md) §7|
| `hub.intake.count`| Ops, Senior Ops, Platform Admin| own hub||
| `hub.osd.adjudicate`| **Senior Ops, Platform Admin** — not Ops Staff| own hub||
| `hub.intake.reopen`| **Platform Admin only**| all hubs||

## 9. Settings — *pointer*

| Key| Why this feature reads it| Home|
|---|---|---|
| `intake_parcel_cap`| **`CONFIRMED`** — 100, by decision (`MSC-DEC-256`, 26 August 2026, `OQ-078` closed).| [settings.md](../../contracts/settings.md) §7.3|

## 10. Errors — *pointer*

`BLIND_COUNT_VIOLATED`, `STOPS_UNRESOLVED`, `ZERO_COLLECTION_IS_FAILURE`, `INSUFFICIENT_AUTHORITY`, `REASON_REQUIRED`, `STATE_CONFLICT` — [errors-and-enums.md](../../contracts/errors-and-enums.md).

## 11. Audit events — *pointer*

`hub.handover.submitted`, `hub.intake.counted` — **the first moment both counts may legally appear together** — `hub.osd.opened`, `hub.osd.resolved` *(enhanced)*, `hub.intake.reopened` *(enhanced)* — [audit.md](../../contracts/audit.md) §5.2.

## 12. API operations — *pointer*

`getHubIntake`, **`listHubIntakes`**, **`acquireIntakeLock`**, `submitBlindCount`, `closeHubIntake`, `adjudicateDiscrepancy` and `submitHubHandover` — [openapi.yaml](../../contracts/openapi.yaml). **`listHubIntakes` and `acquireIntakeLock` were added at `MSC-DEC-416`**: the queue and the lock this feature describes had no operation. **The last three were missing from this pointer until 23 August**, though this feature owns intake close, OS&D adjudication and handover receipt. The blind-count guarantee is carried by the schema: `HubIntakePreCount` omits the declaration entirely, and the count request declares `additionalProperties: false`.

---

## 13. Acceptance criteria

### `AC-SLICE-001-37` — The declaration is not served before commit

```text
Given an intake in AWAITING_COUNT,
When any authorized Ops user reads it,
Then the response contains no rider_declared_count property at all,
And the awaiting-receive queue likewise does not expose it,
And it becomes readable only in the response to the committed physical count.
```

**Governs:** §22.3, §22.4, §43.2 · **Surface:** Melarc Ops · **Test level:** API · **Code:** `BLIND_COUNT_VIOLATED`

### `AC-SLICE-001-38` — The client cannot submit the declaration

```text
Given an intake in AWAITING_COUNT,
When a client submits a count payload that also carries rider_declared_count,
Then the request is rejected,
And no count is committed.
```

**Governs:** §22.4, `CONFLICT-005` · **Surface:** Melarc Ops · **Test level:** API · **Code:** `VALIDATION_FAILED`

### `AC-SLICE-001-39` — Receiving is a distinct act

```text
Given a manifest whose stops are all terminal and whose collection records exist,
When the run completes,
Then no intake is automatically counted or received,
And an intake exists in AWAITING_COUNT requiring a separate authorized receive action.
```

**Governs:** §22.1 · **Surface:** Melarc Ops · **Test level:** service

### `AC-SLICE-001-40` — The hub count is the close authority, not the declaration

```text
Given an intake where the rider declared 10 and the hub physically received 9,
When the intake proceeds to itemization and closure,
Then closure requires 9 itemized orders,
And the declared count of 10 is retained as immutable discrepancy history,
And it is never used as the close target.
```

**Governs:** §22.7, `MSC-DEC-119` · **Surface:** Melarc Ops · **Test level:** service · **Code:** `PARITY_NOT_MET`

### `AC-SLICE-001-41` — Condition is recordable on a matching count

```text
Given an intake whose physical count matches the declaration exactly,
When the receiver records a condition of DAMAGED with supporting evidence,
Then count_variance is MATCH,
And the condition and any dispute are recorded independently,
And the case routes to senior review.
```

**Governs:** §22.5, §35.5.4 · **Surface:** Melarc Ops · **Test level:** API

### `AC-SLICE-001-42` — Damaged and tampered require evidence and senior review

```text
Given a receiver recording a condition of TAMPERED,
When no supporting evidence is attached,
Then the submission is rejected,
And when evidence is attached the case requires Senior Ops adjudication,
And an Ops Staff user cannot adjudicate it.
```

**Governs:** §22.5 · **Surface:** Melarc Ops · **Test level:** API · **Code:** `REASON_REQUIRED`, `INSUFFICIENT_AUTHORITY`

### `AC-SLICE-001-43` — The soft lock is advisory, not a substitute

```text
Given receiver A holds the advisory lock on an intake,
When receiver B opens the same intake,
Then B sees that A is actively receiving,
And B may take over after the idle TTL,
And if both submit a count regardless, exactly one succeeds and the other receives STATE_CONFLICT.
```

**Governs:** §22.8, §35.5.6 · **Surface:** Melarc Ops · **Test level:** API · **Code:** `STATE_CONFLICT`

**Executable since `MSC-DEC-416`**: `acquireIntakeLock` takes the lock and shows who holds it. Until then no operation acquired it, and this criterion had nothing to run against.

### `AC-SLICE-001-44` — The rider may correct the pre-filled count

```text
Given a rider submitting a handover with one row per collected pickup request,
When each row's count is pre-filled from that request's collection record,
Then the rider may correct any row before submission,
And each corrected value is what that row's intake carries as rider_declared_count,
And each correction is recorded.
```

**Governs:** §22.2, `MSC-DEC-416` · **Surface:** Melarc Rider · **Test level:** API

### `AC-SLICE-001-45` — Handover requires every stop terminal

```text
Given a manifest with one stop still PENDING,
When the rider attempts to submit the hub handover,
Then the submission is refused,
And handover becomes available only once every stop is terminal.
```

**Governs:** §22.2 · **Surface:** Melarc Rider · **Test level:** API · **Code:** `STOPS_UNRESOLVED`

### `AC-SLICE-001-46` — Vendors see the summary, never the internals

```text
Given a completed intake with a count variance and an adjudicated damage finding,
When the vendor views its records,
Then the vendor sees the intake-completed and order summary,
And the vendor sees no blind count, no rider declaration, no discrepancy evidence and no internal adjudication.
```

**Governs:** §22.9, §37.3 · **Surface:** Melarc Vendor · **Test level:** security

### `AC-SLICE-001-75` — The handover carries one row per collected request, and each row opens one intake

```text
Given a run whose stops are COLLECTED for requests P and Q, PARTIALLY_COLLECTED for R, and FAILED for S,
When the custody holder submits the hub handover with one row each for P, Q and R,
Then three intakes open at AWAITING_COUNT, one per row, each carrying its row's declared count, the run, the custody holder, the receipt time and the capture time,
And no intake opens for S,
And a handover that omits R, repeats P or names S is refused with VALIDATION_FAILED and opens nothing,
And the same idempotency key replayed with different rows is refused with IDEMPOTENCY_KEY_CONFLICT.
```

**Governs:** §22.2, `MSC-DEC-416`, state-machines.md §4, §7 · **Surface:** Melarc Rider, backend · **Test level:** API · **Expected code on rejection:** `VALIDATION_FAILED`, `IDEMPOTENCY_KEY_CONFLICT`

### `AC-SLICE-001-76` — A zero declaration opens the intake and forces Senior Ops review

```text
Given a run on which request P was COLLECTED with 4 parcels,
When the custody holder's handover declares 0 for P,
Then P's intake opens at AWAITING_COUNT with rider_declared_count 0, and no pre-count view reveals it,
And when the receiver commits a blind count of 0, the intake moves to RECONCILIATION_REQUIRED although the variance is MATCH,
And only Senior Ops, with a reason, can move it to READY_FOR_ITEMIZATION,
And an Ops user attempting that resolution is refused with INSUFFICIENT_AUTHORITY.
```

**Governs:** §22.2, §22.5, `MSC-DEC-416`, state-machines.md §7 · **Surface:** Melarc Rider, Melarc Ops · **Test level:** integration · **Expected code on rejection:** `INSUFFICIENT_AUTHORITY`

### `AC-SLICE-001-77` — The awaiting-receive queue lists pre-count intakes and never a declaration

```text
Given three intakes awaiting count at the acting hub, one of them carrying a zero declaration,
When an Ops user lists intakes filtered to AWAITING_COUNT,
Then all three are returned, each with its run, the rider who handed it over, its submission time and any active receiver,
And no item carries rider_declared_count, the zero declaration included,
And an intake at another hub is not returned,
And a user without hub.read is refused with PERMISSION_DENIED.
```

**Governs:** §22.3, §35.5.2, `MSC-DEC-416` · **Surface:** Melarc Ops · **Test level:** security · **Expected code on rejection:** `PERMISSION_DENIED`

---

## 14. Open questions blocking this feature

| ID| What it blocks here| Type|
|---|---|---|
| `OQ-051`| **The soft-lock idle TTL now has a key** — `intake_lock_idle_ttl_minutes`, added to `contracts/settings.md` §7.3 on 23 August after being found here rather than in that inventory. Still unvalued. **An unset TTL degrades takeover, not correctness**, because §22.8 makes the lock advisory| `VALUE_REQUIRED` — blocks **launch**|

**`OQ-078` closed** 26 August 2026 by `MSC-DEC-256` — the four source-default keys were reviewed
and confirmed, so `intake_parcel_cap` is `CONFIRMED` by decision and §9 now says so; the status
disagreement this document raised resolved in `settings.md`'s favour. No `DECISION_NEEDED`
question blocks this feature.

## 15. What this feature still owes its slice

| Owed| Blocks which DoR area| Owner|
|---|---|---|
| ~~**The handover's count shape — `CONFLICT-042`.**~~ **Resolved 26 September 2026 by `MSC-DEC-416`** — one row per collected pickup request, each opening its own intake. *Original text:* §5.1 and §22.2 require one count row per sender set, and each `PickupIntake` keeps its own `rider_declared_count`; `submitHubHandover` carries one `declared_count` for the run, so a declaration per intake cannot be recorded| E| Engineering — `SLICE-001`, the next pass|
| `intake_lock_idle_ttl_minutes` has no value| F — launch; `AC-SLICE-001-43` needs it| `OQ-051`|
| Evidence upload has no maximum size or MIME-type whitelist to validate against — condition and OS&D photos captured here are unbounded (MED-12 audit remediation). **Rate limiting is not owed**: evidence upload already falls under `rate_limit_authenticated_api` (120/minute, `MSC-DEC-371`), no dedicated sub-ceiling shown necessary| F — launch| `OQ-121`|

The blind-count guarantee is enforced **structurally** — `HubIntakePreCount` omits the declaration entirely — and `AC-SLICE-001-37` and `-38` are testable against the contract today. §12 gained the three operations it owns on 23 August.

**Readiness is not assessed here.** [definition-of-ready.md](../../standards/definition-of-ready.md) assesses it **for the complete vertical slice** and records the verdict in the slice document; a feature cannot answer §44.3 or §44.4 alone. This section feeds that assessment instead of duplicating it (`MSC-DEC-239`, closing `CONFLICT-029`).

**Evidence became creatable on 24 August**. `createEvidence` and `completeEvidenceUpload` are written, and **`AC-SLICE-001-41` and `-42` are executable**. `Evidence` was fully modelled at [domain-model.md](../../contracts/domain-model.md) §3.6 and **no operation produced one**, so every criterion here requiring attached evidence was unexecutable — a fact recorded against `OQ-048` and **never against this feature**. The guard worth knowing: a `PENDING_UPLOAD` record **may not be referenced**, so "evidence attached" now means bytes actually arrived.

## 16. Build status — *honest, per surface*

| Surface| Status| Gap|
|---|---|---|
| Melarc Ops| ⚪ not built| Everything|
| Melarc Rider| ⚪ not built| Handover submission|
| Melarc Vendor| ⚪ not built| Summary only|
| Recipient channel| N/A| —|

## 17. Related

- **Upstream:** [pickup-collection.md](../pickup/pickup-collection.md) — supplies custody, **never** the count
- **Downstream:** [itemization.md](itemization.md) — what an eligible intake becomes
- **Slice:** `SLICE-001`
