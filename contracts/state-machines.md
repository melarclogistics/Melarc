# Canonical State Machines

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 1.81 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** canonical state enums, allowed transitions, guards, effects and failure codes
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../PROJECT_MASTER_SPECIFICATION.md) §36

## 1. Scope and standing caution

This document owns the state sets, transition guards, failures and effects used by the implementation. Implement transitions through the domain services and enforce ownership, permissions, concurrency and audit requirements in the referenced contracts.

### 1.1 Transition completeness

A listed state set without a transition table is incomplete for implementing transitions. The deferred machines in §14 remain explicit design dependencies for their affected slices. The written transition tables are the current specification; historical signature bookkeeping is not part of development. Changes to product behavior must be resolved in the retained specifications before implementation.

### 1.2 Application of transitions

Use the current row for the operation being implemented, including every guard, failure and side effect. Test invalid transitions as well as valid ones. Do not interpret a state label or historical status as proof of implemented behavior.

## 2. Conventions

Per §36.1, every transition names its source, destination, actor, preconditions, side effects, emitted event and failure code. The tables carry them as **Transition · Actor · Guard · Effects · Failure code**; the emitted event is `<entity>.<transition>` throughout and is not repeated per row.

Four rules from §36.1 bind every machine:

- A record must not change state because a screen changed. Every transition is a command with a guard.
- Terminal and reversible states are declared per machine.
- Failed, cancelled, superseded and replacement records stay queryable.
- Concurrent attempts are rejected deterministically or replayed idempotently — never last-write-wins.

Failure codes are named here and catalogued in [errors-and-enums.md](errors-and-enums.md).

---

## 3. `PickupRequest`

§36.2. States: `PENDING` · `CONFIRMED` · `DECLINED` · `CANCELLED`. Terminal: `DECLINED`, `CANCELLED`. No state is reversible.

| Transition| Actor| Guard| Effects| Failure code|
|---|---|---|---|---|
| `PENDING → CONFIRMED`| **Ops only in V1**| Package count ≥ 2, **or** an approved one-package exception. Service date Monday–Saturday (§21.1, `MSC-DEC-149`) and satisfying pickup-zone service-day rules (§35.2.5). **A corridor destination must fall on its batch day, or the off-day fee applies** — the off-day request is accepted and priced, not refused. Sender not suspended. `attempt_number ≤ 3` or a force-extension exists. **Past the hub cutoff is NOT a bar** — see below| Request becomes manifest-eligible (§35.2.8). Past cutoff, sets `cutoff_exception_state = PENDING_OPS_REVIEW`. **An indicative estimate is shown** — base fee × package count, assuming `SMALL` and in-area doorstep (`MSC-DEC-211`, superseding `MSC-DEC-175`'s no-estimate rule). Still **no credit reservation and no charge** — §5.2.1 is unchanged on that. The estimate is not a quote and the surface must say so.| `PICKUP_MINIMUM_NOT_MET`, `SERVICE_DATE_NOT_PERMITTED`, `ZONE_NOT_SERVICED_ON_DATE`, `SENDER_SUSPENDED`, `PICKUP_ATTEMPT_LIMIT_REACHED` · *deferred:* `EXCEPTION_NOT_AVAILABLE_TO_SELF_SERVICE`|
| *resolve cutoff exception*| Ops| `cutoff_exception_state = PENDING_OPS_REVIEW`| Same-day exception approved, or rescheduled to the next operating day (§21.1)| `REASON_REQUIRED`|
| `PENDING → DECLINED`| Ops| Reason required| Reason label snapshotted per domain model §3.7| `REASON_REQUIRED`|
| `PENDING → CANCELLED`| Ops, **or vendor for own request**| Reason required| No charge — no rider is committed to a pending request| `REASON_REQUIRED`|
| `CONFIRMED → CANCELLED` *(office, pre-assignment)*| Ops, Senior Ops, Platform Admin| No rider assigned. Reason required| No charge| `REASON_REQUIRED`|
| `CONFIRMED → CANCELLED` *(office, post-assignment)*| Ops, Senior Ops, Platform Admin| Rider assigned. Reason required. **Charge is discretionary** — Ops decides, with a mandatory charge reason either way| Charge applied and snapshotted, **or** waived, **or** unavailable. All three outcomes recorded. Stop moves to `SKIPPED`| `REASON_REQUIRED`|
| *waive cancellation charge*| **Senior Ops**| Applied to a post-assignment cancellation. Actor and reason recorded| Charge reversed; waiver auditable| `INSUFFICIENT_AUTHORITY`, `REASON_REQUIRED`|
| ~~`CONFIRMED → CANCELLED` *(vendor self-service)*~~| ~~Vendor, own request~~| **DEFERRED IN V1**. Guard preserved for re-enablement: no rider assigned — the request's stop has no manifest, or that manifest's `assigned_rider_id` is null| —| *dormant:* `SELF_CANCEL_NOT_PERMITTED_AFTER_ASSIGNMENT`|
| `CONFIRMED → CANCELLED` (replacement)| Ops| A replacement request is created in the same command; `attempt_number` increments| Source stays linked via `replaces_request_id`; attempt chain preserved (§36.2). **Source and replacement are never simultaneously active** (§35.4.4)| `REPLACEMENT_REQUIRED`, `SOURCE_STILL_ACTIVE`|
| *force-extension*| hub Senior Ops| `attempt_number = 3`. Direct authority — no second approver (§21.6, `MSC-DEC-116`)| Permits a further attempt. Reason, actor, timestamp, before/after and audit event all mandatory (§35.1.6)| `INSUFFICIENT_AUTHORITY`, `REASON_REQUIRED`|

**Invariants.**

- A confirmed request carries payer *intent* only. **No monetary amount is stored on the request entity** (§5.2.1). The indicative estimate `MSC-DEC-211` introduced is **computed for the response, never persisted here** — which is why that decision superseded `MSC-DEC-175` without disturbing this invariant.
- One request is **one origin and one scheduled pickup event** (§35.2.1).
- Pickup attempts cap at three — the setting is named `MELARC_MAX_PICKUP_ATTEMPTS` in §35.4.5. This is a **separate cap from the physical delivery attempt limit** in §35.8.6, which counts only a doorstep a rider actually reached; the two are unrelated counters on different records and must not be conflated.
- A failed pickup requires a categorized reason **and the supporting detail or evidence that reason demands** (§35.4.1) — which is read from the reason code's metadata, not hardcoded (domain model §3.9).
- A declined or cancelled request preserves its reason and history (§35.2.9).

`MSC-DEC-188` items 1–2 close two of the three questions §36.2 left to this document: no pre-submission `DRAFT` state exists in Version 1, and a one-package exception is a linked approval record rather than a state.

**A late booking is not an error**. §21.1: a request past the responsible hub's cutoff is "neither auto-scheduled nor blocked — it queues for Ops review, which may approve a same-day exception or reschedule it to the next operating day." The contract previously guarded on the cutoff and returned `BOOKING_CUTOFF_PASSED`, which would have rejected the booking and pushed work back to the vendor that §21.1 deliberately keeps inside Ops. That code is withdrawn from this transition.

**A suspended vendor's existing work goes on hold, it is not cancelled.** §21.1: a suspended vendor "cannot create requests and every non-terminal existing request is placed on controlled hold." The hold is `VendorSuspensionHold` (§13), which preserves the request rather than terminating it.

### 3.1 Vendor self-service is deferred, not deleted

`MSC-DEC-196`. In Version 1 a vendor may cancel its own **`PENDING`** request and nothing more — no self-confirm, no self-cancel of a confirmed request. `PENDING → CANCELLED` stays open because no rider is committed and blocking it would create Ops load for no control gained.

**The struck row above is retained deliberately.** Its guard, and the dormant `SELF_CANCEL_NOT_PERMITTED_AFTER_ASSIGNMENT` code, and the deferred `EXCEPTION_NOT_AVAILABLE_TO_SELF_SERVICE` guard on `PENDING → CONFIRMED`, all stay in this document marked deferred rather than stripped. Re-enabling self-service must not require reconstructing the reasoning — reconstruction is where rules get quietly lost.

**`MSC-DEC-195` is dormant, not superseded.** It fixed *where* the self-cancellation cutoff sits; `196` defers *whether the path is active at all*. When self-service returns, `195` governs it unchanged.

### 3.2 Cancellation — what is easy to get wrong

- **The cutoff is rider assignment, not custody.** `MSC-DEC-188` proposed the stop reaching `ARRIVED` and was overruled. Cancellation is a *commercial* event before it is a custody event: the cutoff marks where the charge begins, and must track Melarc's published policy — free before a rider is committed, chargeable after.
- **The request never becomes uncancellable.** Office cancellation remains available at every point. A model that makes `CANCELLED` unreachable after assignment is wrong.
- **The charge is discretionary, not automatic**. Ops decides, with a mandatory reason either way; Senior Ops may waive. This protects the genuine emergency without creating a free-cancel loophole — and because every application and waiver is recorded, **waiver frequency is the actual control**. A charge waived constantly is a policy problem the data will surface.
- **A missing charge setting must never block the cancellation.** `SETTING_MISSING` was removed from this transition. An unset amount produces *no charge applied, recorded as such*, and the cancellation proceeds. **Accra's figure is GH₵20, so this path now protects a newly opened hub rather than every cancellation.** An operational or custody decision is never held hostage to missing commercial configuration — see `standards/engineering-standards.md` §7.
- **The guard reads a different record.** Assignment is a fact on `PickupManifest`. The check is whether this request's stop belongs to a manifest with a non-null `assigned_rider_id`; a guard written against the request alone cannot answer it.

## 4. `PickupManifest`

§36.3. States: `DRAFT` · `DISPATCHED` · `IN_PROGRESS` · `COMPLETED` · `CANCELLED`. Terminal: `COMPLETED`, `CANCELLED`.

| Transition| Actor| Guard| Effects| Failure code| Signature|
|---|---|---|---|---|---|
| *assign rider*| Ops| Rider eligible, active, with a serviceable assigned motorcycle (§34.10)| Sets `assigned_rider_id` and `assigned_at`. **This is the moment vendor self-cancellation closes on every request carried by this manifest**| `RIDER_UNAVAILABLE`, `NO_SERVICEABLE_MOTORCYCLE`| —|
| `DRAFT → DISPATCHED`| Ops| ≥ 1 stop; rider assigned; rider's motorcycle available (§34.10)| Stops become visible to the rider| `MANIFEST_EMPTY`, `RIDER_UNAVAILABLE`, `NO_SERVICEABLE_MOTORCYCLE`| —|
| `DISPATCHED → IN_PROGRESS`| Rider| Assigned rider only| Run start recorded| `NOT_ASSIGNED_RIDER`| —|
| `IN_PROGRESS → COMPLETED`| **The custody holder** — the assigned rider, or whoever accepted a `RunCustodyHandover` (§4.1) — **by the hub handover**| **Every** stop in a terminal state and **at least one** `COLLECTED` or `PARTIALLY_COLLECTED`. The handover carries **one row per collected pickup request, each exactly once, and no other**| **The hub handover is recorded — `submitHubHandover` is this transition.** One `PickupIntake` opens per row at `AWAITING_COUNT` (§7), carrying that row's declared count.| `STOPS_UNRESOLVED`, `NOT_CUSTODY_HOLDER`, `VALIDATION_FAILED`| **AMENDED · RE-SIGNED — `MSC-DEC-416`**|
| `IN_PROGRESS → COMPLETED`| **System**| **Every** stop in a terminal state and **none** `COLLECTED` or `PARTIALLY_COLLECTED`; no `RunCustodyHandover` on the run is `PENDING`| **No handover and no intake** — nothing was collected (§22.2). Evaluated when a stop turns terminal and when a custody handover resolves| —| **AMENDED · RE-SIGNED — `MSC-DEC-416`**|
| `DRAFT/DISPATCHED → CANCELLED`| Ops| Not yet started| Stops move to `SKIPPED`| `RUN_ALREADY_STARTED`| —|

**A run completes one of two ways, and only one of them is a handover** (`MSC-DEC-416`, amended and re-signed on 26 September 2026). Where anything was collected, **the hub handover is the completion**: `submitHubHandover` performs `IN_PROGRESS → COMPLETED` and opens one `PickupIntake` per collected pickup request (§7). The row's effect had read *handover to hub becomes available*, as if the handover followed completion; there has never been another completion operation. Where nothing was collected, **System completes the run** the moment its last stop turns terminal, with no handover and no intake, because §22.2 bars a zero count from creating either. A `PENDING` `RunCustodyHandover` holds that row until it resolves, so a closed run never leaves a custody record open.

**Dispatch and start are separate transitions with different actors** — §36.3 requires it, and collapsing them would attribute an Ops action to a rider in the audit trail.

**Rider assignment is now a recorded moment, not an implicit property of the manifest existing.** `MSC-DEC-195` makes it the cancellation cutoff, so `assigned_at` must be a timestamp on the record rather than inferred. A `DRAFT` manifest may exist with no rider — which is why `assigned_rider_id` is nullable.

### 4.1 `RunCustodyHandover` — custody moves, and completion follows it

§36.14, written 23 August by `MSC-DEC-246`. States: `PENDING` · `COMPLETED` · `FAILED`. Terminal: `COMPLETED`, `FAILED`.

**Why this exists.** A rider nine stops into twelve, with collected parcels aboard, breaks down. Ops could skip the remaining stops — and completion was **Rider-only**, hub handover was **`R only`**, and cancellation was refused once the run had started. **The one actor permitted to close the run was the one who could not.** `CONFLICT-034`.

| Transition| Actor| Guard| Effects| Failure code|
|---|---|---|---|---|
| `→ PENDING`| Ops, Senior Ops, Platform Admin at own hub| Run is `IN_PROGRESS`. A receiving party is named: **another active rider**, or **the hub**| Custody remains with the original rider until acceptance. **No custody gap is created by opening a handover**| `VALIDATION_FAILED`, `RIDER_UNAVAILABLE`|
| `PENDING → COMPLETED`| **The named receiving party** — the receiving rider, or Ops where the hub is the destination| Receiver records the parcel count taken| **Custody transfers.** The receiver may now complete the run and submit the hub handover| `NOT_ASSIGNED_RIDER`, `VALIDATION_FAILED`|
| `PENDING → FAILED`| Ops| The named receiver did not take custody| **Custody stays with the original rider.** The run remains `IN_PROGRESS` and a further handover may be opened| `REASON_REQUIRED`|

**Completion authority follows custody, and that is the structural point.** A run cannot be closed by anyone who is not holding its parcels. The alternative — an Ops force-close independent of custody — would let the **record** close while the **parcels** were unaccounted for, on the day that distinction matters most.

**Completed-stop attribution is preserved.** §43.4 requires it in terms: stops worked by the original rider stay attributed to that rider after transfer. The receiver inherits the *remaining work*, never the *completed record*. An implementation that reassigns the run by rewriting `assigned_rider_id` destroys exactly this, which is why §36.14 says **a rider-ID edit is never a substitute for a `RunCustodyHandover` record.**

**The hub is the fallback route, not an afterthought.** §43.4: *“unsafe field handover routes work through the hub.”* Where a roadside transfer is unsafe — night, a hostile location, an injured rider — the destination is the hub, Ops accepts custody, and Ops completes the run.

**The handover count is a custody record and never an authoritative count.** The receiving party records what they took so that custody is continuous; the **hub blind count still runs independently** at intake (§22.4). Treating the handover figure as the received count would defeat the blind count by giving the hub a number to match — the precise failure `HubIntakePreCount` omits a field to prevent.

## 5. `PickupStop`

§36.4. States: `PENDING` · `ARRIVED` · `COLLECTED` · `PARTIALLY_COLLECTED` · `FAILED` · `SKIPPED`. Terminal: `COLLECTED`, `PARTIALLY_COLLECTED`, `FAILED`, `SKIPPED`.

| Transition| Actor| Guard| Effects| Failure code|
|---|---|---|---|---|
| `PENDING → ARRIVED`| Rider| Manifest `IN_PROGRESS`| Cancellation window closes| `MANIFEST_NOT_STARTED`|
| `ARRIVED → COLLECTED`| Rider| `CollectionRecord` exists with `collected_count > 0`; handshake `VERIFIED`| Intake created at hub handover| `ZERO_COLLECTION_IS_FAILURE`, `HANDSHAKE_NOT_VERIFIED`|
| `ARRIVED → PARTIALLY_COLLECTED`| Rider| `0 < collected_count < declared_count`; handshake `VERIFIED`; **variance reason required**| Variance recorded at the stop. **Office notification emitted** (`MSC-DEC-194` part 2). Variance carried to intake, which still counts blind| `ZERO_COLLECTION_IS_FAILURE`, `HANDSHAKE_NOT_VERIFIED`, `REASON_REQUIRED`|
| `ARRIVED → FAILED`| Rider| Approved failure reason| Attempt chain extended; Ops decision queue entry| `REASON_REQUIRED`|
| `PENDING/ARRIVED → SKIPPED`| Ops| Authorized skip with reason| —| `REASON_REQUIRED`|

**`ZERO_COLLECTION_IS_FAILURE` is the load-bearing guard here.** §36.4 states that "a zero collected count is a failed pickup and cannot be represented as a completed stop or handover." It is enforced server-side, because a rider app that merely disables a button does not satisfy it.

**Partial collection is permitted**, and its shape is deliberate on three counts:

- *Variance is recorded where it happens.* A rider facing a count difference completes the stop with the packages physically present rather than being forced to choose between full success and full failure. This is how the operation already runs — riders report count differences to office by phone at the stop — and the specified workflow preserves that actual custody outcome.
- *Office is flagged in-system at the time of the shortfall.* The notification **supplements and does not replace** the rider's phone call. A human step that can be missed is not a control; office must not be blind to a shortfall until hub intake.
- **The hub blind count still runs, independently.** This is the part most at risk of being optimised away by someone reasoning that the stop already counted. It has not. The stop variance and the intake variance are **two independent checks**, and a package lost *between* pickup and hub is caught only by the second. Reusing the stop's collected count as the hub's declared count, or skipping the blind count for a partial, destroys the custody guarantee §35.5 exists to provide.

## 6. `CollectionHandshake`

§36.5 warns that four lifecycle concepts "should not be collapsed." States: `PENDING` · `CODE_GENERATED` · `CODE_DELIVERED` · `VERIFIED` · `EXPIRED` · `EXHAUSTED` · `DISPUTED` · `MANUALLY_RESOLVED`. Terminal: `VERIFIED`, `MANUALLY_RESOLVED`, `DISPUTED`.

Direction is fixed by §21.4, `MSC-DEC-114–115` and may not be changed here: for a **registered vendor**, Melarc Rider displays the code and the vendor enters it in Melarc Vendor. For an **ad-hoc sender**, Melarc sends the code by SMS and the sender gives it to the rider to enter.

**`MSC-DEC-198` extends this with a fallback ladder. It does not overturn §21.4, `MSC-DEC-114–115`** — the portal path stays primary, because it is what proves registered-vendor presence.

| Rung| Path| Trigger| Authority|
|---|---|---|---|
| **Primary**| Rider displays, vendor enters in Melarc Vendor| Default| —|
| **Fallback 1**| SMS to the vendor's **registered number only**; vendor reads the code to the rider| Portal path unusable — no data, portal down| Rider may trigger at the door|
| **Fallback 2**| Ops-verified override| SMS also fails| **Ops by definition.** Ops verifies the vendor by another means and authorises the handshake as a recorded exception|

**Every fallback use is logged**, which is the point rather than a side effect: persistent fallback use becomes visible data. A vendor who never uses the portal is a signal to act on, not a silent convenience.

**"Busy" is not an accommodated trigger.** The ladder addresses genuine technical failure. A vendor too busy to read a code is subject to the ordinary door wait and possible stop failure, exactly as recipient-availability rules apply. The wait is **10 minutes**, held as the per-hub setting `rider_door_wait_minutes`.

| Transition| Actor| Guard| Failure code|
|---|---|---|---|
| `PENDING → CODE_GENERATED`| System| Collection recorded| `COLLECTION_NOT_RECORDED`|
| `CODE_GENERATED → CODE_DELIVERED`| System| Delivery channel confirms dispatch| `DELIVERY_CHANNEL_FAILED`|
| *escalate to SMS fallback*| Rider| Portal path unusable. Sends **only** to the registered number. Logged as `SMS_FALLBACK`| `NO_REGISTERED_NUMBER`|
| *escalate to Ops override*| **Ops**| SMS fallback also failed. Ops verifies the vendor by another means. Logged as `OPS_OVERRIDE`, recorded exception| `INSUFFICIENT_AUTHORITY`, `REASON_REQUIRED`|
| `CODE_DELIVERED → VERIFIED`| Vendor or rider, per direction and rung| Code matches, unexpired, attempts remain. **`channel` records which rung verified**| `CODE_INVALID`, `CODE_EXPIRED`, `ATTEMPTS_EXHAUSTED`|
| `CODE_DELIVERED → EXPIRED`| System| Validity window elapsed| —|
| `CODE_DELIVERED → EXHAUSTED`| System| Attempt limit reached| —|
| `EXPIRED/EXHAUSTED → MANUALLY_RESOLVED`| Senior Ops| Reason and evidence| `INSUFFICIENT_AUTHORITY`|
| any → `DISPUTED`| Ops| Reason| `REASON_REQUIRED`|

OTP validity window, attempt limits and security parameters are **not set here** — `OQ-048` owns them.

## 7. `PickupIntake`

§36.6, reconciled with §22.6. States: `AWAITING_COUNT` · `COUNTED` · `RECONCILIATION_REQUIRED` · `READY_FOR_ITEMIZATION` · `ITEMIZING` · `CLOSED` · `CANCELLED`. Terminal: `CLOSED` (reopenable only under privilege) and `CANCELLED`.

**`CANCELLED` was missing until the §22 reconciliation**. §22.6 names it in the target lifecycle; §36.6's more detailed sketch omitted it, and this document followed the sketch. Its exact cancellation rules remain downstream design (§22.6, §22.7).

| Transition| Actor| Guard| Effects| Failure code| Signature|
|---|---|---|---|---|---|
| `→ AWAITING_COUNT`| **The custody holder**, by the hub handover (§4)| One per row of the handover — a pickup request collected on the run. **Never for a request with nothing collected** (§22.2)| `rider_declared_count` is the row's declared count, **never seeded from `CollectionRecord.collected_count`** (`MSC-DEC-194` part 3). `pickup_manifest_id`, `handed_over_by`, `handed_over_at` and `declaration_captured_at` recorded| `VALIDATION_FAILED`| **AMENDED · RE-SIGNED — `MSC-DEC-416`**|
| `AWAITING_COUNT → COUNTED`| Ops| Physical count submitted **without the declared count having been served**| Variance revealed in the response, not before| `BLIND_COUNT_VIOLATED`| —|
| `COUNTED → READY_FOR_ITEMIZATION`| System| No variance, no condition finding, **and a declaration above zero**| —| —| **AMENDED · RE-SIGNED — `MSC-DEC-416`**|
| `COUNTED → RECONCILIATION_REQUIRED`| System| Variance or condition finding, **or a zero declaration** — a collected request the rider did not hand over| OS&D opened across its three independent dimensions. **A zero declaration is resolved by Senior Ops like any variance**| —| **AMENDED · RE-SIGNED — `MSC-DEC-416`**|
| `RECONCILIATION_REQUIRED → READY_FOR_ITEMIZATION`| Senior Ops| Authorized resolution with reason| Resolution audited| `INSUFFICIENT_AUTHORITY`| —|
| `READY_FOR_ITEMIZATION → ITEMIZING`| Ops| —| —| —| —|
| `ITEMIZING → CLOSED`| Ops| Parity: itemized order count reconciles to the **authoritative hub-received count**. Every order priced. **`PAYMENT_REQUIRED` orders count toward parity** (§35.6.11)| Orders enter their commercial machine at `PRICED`| `PARITY_NOT_MET`, `ORDER_UNPRICED`| —|
| `ITEMIZING → CLOSED` (exception)| Senior Ops| The approved exception process — the **only** permitted route to closing without parity (§35.5.5). §23.10: a substantive reason and appropriate authority| `parity_exception_id` recorded| `INSUFFICIENT_AUTHORITY`, `REASON_REQUIRED`| —|
| *acquire receive lock*| Ops| No active receiver, or the current lock is past its idle TTL — takeover is permitted (§22.8)| `active_receiver_id` and `lock_acquired_at` set. **Advisory only** — §22.8: a visual lock alone is not sufficient, backend transition and idempotency controls still apply| —| —|
| `CLOSED → ITEMIZING`| Platform Admin| Privileged reopen, audited (§36.6)| —| `INSUFFICIENT_AUTHORITY`| —|

**The machine had no creation row until `MSC-DEC-416`**, and the act that creates every intake was described nowhere in it. **One intake per collected pickup request**, opened by the hub handover (§4) with that row's declared count, and **never one for a request with nothing collected** (§22.2). **A zero declaration is legal and never quiet**: it means a collected request's parcels are not in the handover, the intake opens all the same so the loss has a custody record, and after the blind count it goes to `RECONCILIATION_REQUIRED` whatever the variance, so Senior Ops resolves it with a reason. **The guard reads whether the request was collected, never the collected count**, so `MSC-DEC-194` part 3's independence holds.

**`BLIND_COUNT_VIOLATED` guards two paths, not one.** §35.5.2 forbids the system to "reveal **or require the frontend to submit**" the rider-declared count before the physical count is committed. So the read path must not serve it — §43.2's criterion — *and* the write path must not accept it echoed back. A design satisfying only the first still fails.

**`PARITY_NOT_MET` is the rule most likely to be implemented backwards.** §35.6.11 states that "a valid `PAYMENT_REQUIRED` parcel still counts toward physical parity." Parity counts *physical parcels itemized*, not orders cleared for dispatch. An implementation that counts dispatch-ready orders will refuse to close intakes that are entirely correct, and the failure will look like a data problem rather than a logic one.

**Three OS&D dimensions stay independent.** §35.5.4 and §22.5: damage, tampering or dispute "may be recorded even when count variance is `MATCH`." This is why `count_variance` is an enum rather than a number — a zero difference is still a recorded comparison outcome, and a clean count does not close the condition or dispute dimensions.

**Condition is a fixed four-value enum** — `OK`, `DAMAGED`, `TAMPERED`, `OTHER` (§22.5). Like the pickup-failure categories at `CONFLICT-025`, these are product policy rather than configuration: `DAMAGED` and `TAMPERED` carry a mandatory evidence-and-senior-review consequence, which a renameable value could not reliably trigger.

**Closure emits `intake.completed` and generates the vendor-facing order summary** (§23.10). §22.9 bounds what that summary may contain: vendors receive the intake-completed and order summary only — **blind counts, the rider declaration, discrepancy evidence and internal adjudication remain Ops-only**.

## 8. `Order` — commercial machine

§36.11. Per domain model §5.9, orthogonal to fulfilment. States: `PRICED` · `PAYMENT_REQUIRED` · `CREDIT_RESERVED` · `NO_VENDOR_CHARGE` · `PREPAID` · `CLOSED` · `REVERSED`. Terminal: `CLOSED`.

**Unlike the fulfilment machine and `ThirdPartyHandoff`, this one can declare a terminal state plainly.** Those two omit a terminal line **deliberately**, because terminality there depends on commercial mode and a single line would be wrong. Commercial state has no such dependency, and the line was missing rather than withheld.

```text
PRICED
  ├─ vendor portion == 0 ................................> NO_VENDOR_CHARGE
  ├─ allowance enabled + not overdue + exposure available ─> CREDIT_RESERVED
  └─ allowance disabled | overdue | exposure insufficient ─> PAYMENT_REQUIRED
PAYMENT_REQUIRED ──full sender-paid amount succeeds──> PREPAID
CREDIT_RESERVED | PREPAID | NO_VENDOR_CHARGE ──terminal outcome──> CLOSED
CREDIT_RESERVED | PREPAID | NO_VENDOR_CHARGE ──ultimate failure──> REVERSED ──> CLOSED
```

**The zero branch is tested first, and it keys on the resolved amount rather than the intent.** `payer_allocation.sender_minor == 0` reaches it whether the request said `RECIPIENT_PAYS`, a split resolved to nothing, or a parcel-level override moved the whole fee to the recipient. Keying on `default_payer_intent` would miss the last two.

| Transition| Actor| Guard| Effects| Failure code| Signature|
|---|---|---|---|---|---|
| `→ PRICED`| System| Intake itemization computed the authoritative fee. Requires a selected `size_class` and, in `MELARC_COVERED_THIRD_PARTY_DELIVERY`, a captured `carrier_cost_minor`| Price locked; components snapshotted **with their hub** (domain model §3.7, `MSC-DEC-218`)| `SIZE_CLASS_REQUIRED`, `CARRIER_COST_REQUIRED`, `MARGIN_NOT_CONFIGURED`| —|
| `PRICED → CREDIT_RESERVED`| System| Allowance enabled, account not `OVERDUE`, sufficient global exposure| **Exposure reserved exactly once**, keyed by order (§5.2.3)| `ALLOWANCE_DISABLED`, `ACCOUNT_OVERDUE`, `CREDIT_LIMIT_EXCEEDED`| —|
| `PRICED → NO_VENDOR_CHARGE`| System| **Resolved vendor portion is zero** — `payer_allocation.sender_minor == 0`| Commercial gate satisfied with no reservation and no payment. **Evaluated before the credit conditions**, so an overdue account does not reach it| —| —|
| `PRICED → PAYMENT_REQUIRED`| System| Vendor portion **greater than zero** and any credit condition unmet| Order cannot reach `READY_FOR_DISPATCH`| —| —|
| `PAYMENT_REQUIRED → PREPAID`| System| **The sender-paid `OperationalPaymentDemand` is `SETTLED`** — cumulative confirmed principal reached the **full** sender-paid amount and every frozen line was allocated atomically.| Gate satisfied. **A short confirmed prepayment is money received**: the receipt stands, no line settles, the order stays `PAYMENT_REQUIRED`, and the next collection asks for the remainder| `PAYMENT_NOT_CONFIRMED`, `PAYMENT_AMOUNT_MISMATCH`| **AMENDED · RE-SIGNED — `MSC-DEC-366`**|
| *reprice*| Ops requests, hub Senior Ops approves| A post-freeze address correction **changes the service area or the commercial mode** (§35.6.8, as amended by `MSC-DEC-207`)| New price, full history, **and affected-party notification** — the notification is part of the rule. Recorded in `reprice_history`| `INSUFFICIENT_AUTHORITY`, `NO_PRICING_CHANGE`, `NOTIFICATION_FAILED`| —|
| *price correction*| Ops requests, approver confirms| Maker-checker per §35.6.7| Linked adjustment; the locked price is never rewritten| `INSUFFICIENT_AUTHORITY`, `SELF_APPROVAL_FORBIDDEN`| —|
| *payer correction* — **re-runs the gate**| Ops submits, **Senior Ops approves** (§5.2.3)| An approved change to `payer_allocation` after price freeze| **The commercial gate is re-evaluated from the new allocation**, testing the zero branch first exactly as at §8's entry. The order moves to whichever of `NO_VENDOR_CHARGE`, `CREDIT_RESERVED` or `PAYMENT_REQUIRED` the new vendor portion warrants; an existing reservation is adjusted, not duplicated| `INSUFFICIENT_AUTHORITY`, `SELF_APPROVAL_FORBIDDEN`, `CREDIT_LIMIT_EXCEEDED`| —|
| `CREDIT_RESERVED/PREPAID/NO_VENDOR_CHARGE → REVERSED`| System, **on formal Return initiation**| **A committed `ReturnRecord`** — **not** a counter reaching three.| Original delivery fee reversed; return fee becomes earned (§5.2.4, §35.8.8). **`NO_VENDOR_CHARGE` reaches here too, and the reason is easy to miss:** the reversed delivery fee is zero, but §5.2.4 makes the flat return fee **a new vendor charge** on an order the vendor never owed anything for| —| **AMENDED · RE-SIGNED — `MSC-DEC-366`**|
| `→ CLOSED`| System| Mode-specific terminal outcome reached **and** money collected, reconciled, waived or reversed (§13.2)| —| `FINANCIAL_CLOSURE_INCOMPLETE`| —|

**Two rows are amended, and both are now re-signed** — Product Owner, 4 September 2026, `MSC-DEC-366`.

**This table was in two pieces until Gate C R1.2** — six rows, a paragraph, then four rows with no header above them and one column fewer. **A markdown table that resumes after prose is not the same table**, and the four orphans rendered as loose text.

**The reprice trigger changed shape and narrowed.** §35.6.8 was written against the zone-pair matrix, where **any** zone crossing moved the price. Under a flat fee most crossings do not: a correction from Dansoman to Madina stays at GH₵35 and must **not** trigger a repricing workflow, because there is nothing to reprice. What still moves the price is crossing into a **different service area** — a corridor, or outside Accra — or changing commercial mode. Keeping the old wording would have fired an Ops-plus-Senior-Ops approval and a customer notification for a correction that changes no money.

Three invariants from §36.11, all of which have bitten real systems:

- **`CREDIT_RESERVED` and `PREPAID` are mutually exclusive** satisfaction paths for the same order, and both must be idempotent. Reservation is enforced by a uniqueness constraint keyed by order, not by retry semantics.
- **Ordinary `PART_PAID` does not exist.** The full currently-payable undisputed amount is paid or the gate stays shut. **What §36.11 does not say is that a short confirmed payment is refused** — under `MSC-DEC-362` it is preserved as a `PaymentReceipt` that settles no line and funds the same demand; the gate opens only when the cumulative principal reaches the total. Nothing is part-settled, and nothing that arrived is discarded.
- **Pickup-request confirmation creates none of these states.** The gate opens only after itemization. A system that reserves credit at booking contradicts `MSC-DEC-176`.
- **`NO_VENDOR_CHARGE` is not a payment and not a reservation.** It records that the gate had nothing to test. Counting it as revenue, as prepayment, or as consumed exposure is wrong in three different reports — which is why `MSC-DEC-244` gave it a state of its own rather than folding it into `PREPAID` or a zero-value `CREDIT_RESERVED`.
- **It still counts toward physical parity**, exactly as `PAYMENT_REQUIRED` does (§35.6.11). Parity is a count of parcels, and the commercial state never changes how many parcels are in the room.

**The commercial gate is not a one-way door, and treating it as one was the defect the stress test found.** §5.2.3 permits a **payer correction after price freeze** — Ops submits, Senior Ops approves — which changes `payer_allocation` **after** the gate has already run. Until 23 August the machine had no transition for it, only *reprice* and *price correction*, both of which change the **price** rather than the **allocation**. Two failures followed, in opposite directions:

- **A correction that gives the vendor a charge they did not have.** The order sits in `NO_VENDOR_CHARGE` with no exit but `CLOSED` and `REVERSED`, so the new debt is **never gated**: no reservation, no payment demand, and the parcel dispatches. **Money owed and never collected.**
- **A correction that takes a charge away.** The order sits in `CREDIT_RESERVED` holding exposure against a debt that no longer exists, or in `PAYMENT_REQUIRED` demanding a payment nobody owes — which is `CONFLICT-033`'s stranding bug returning by a different route.

**What is deliberately not settled here.** Where a correction *reduces* an amount already paid, the refund or adjustment mechanics are §5.2.3's *“payment effects”* and belong to `OQ-005`. This transition fixes the **state**; it does not invent a money movement.

## 9. `Order` — fulfilment machine


§36.9, extended with the §36.7 milestones the delivery progression omits. States: `AWAITING_RECIPIENT_CONFIRMATION` · `READY_FOR_DISPATCH` · `ASSIGNED` · `OUT_FOR_DELIVERY` · `DELIVERED` · `ATTEMPT_FAILED` · `AT_HUB_AFTER_FAILURE` · `READY_FOR_REATTEMPT` · `HANDED_TO_CARRIER` · `RETURN_TO_VENDOR_IN_PROGRESS` · `RETURNED_TO_VENDOR`.

| Transition| Actor| Guard| Effects| Failure code| Signature|
|---|---|---|---|---|---|
| `→ AWAITING_RECIPIENT_CONFIRMATION`| System| Intake `CLOSED`; `lane = DOORSTEP`| Enters the confirmation queue (§36.8)| —| —|
| `AWAITING_RECIPIENT_CONFIRMATION → READY_FOR_DISPATCH`| Ops| Confirmation `CONFIRMED` — the parcel is `CLEARED_FOR_DISPATCH` — **and** `commercial_state ∈ {CREDIT_RESERVED, PREPAID, NO_VENDOR_CHARGE}`.| —| `RECIPIENT_NOT_CONFIRMED`, `ORDER_NOT_COMMERCIALLY_CLEARED`| **AMENDED · RE-SIGNED — `MSC-DEC-366`**|
| `→ READY_FOR_DISPATCH`| Ops — **`clearOutboundForDispatch`** (`dispatch.outbound.clear`)| `lane = THIRD_PARTY_HANDOFF`; commercially cleared; **and the outbound charge backend-confirmed as paid** — see below| Third-party lane skips recipient confirmation. **System opens the order's `ThirdPartyHandoff` at `PENDING_HANDOFF` (§10) if none is open**| `ORDER_NOT_COMMERCIALLY_CLEARED`, `OUTBOUND_CHARGE_UNPAID`| **AMENDED · RE-SIGNED — `MSC-DEC-417`**|
| `READY_FOR_DISPATCH → ASSIGNED`| Ops| Placed on a `DeliveryRun`| —| —| —|
| `ASSIGNED → OUT_FOR_DELIVERY`| Rider| Run started| —| `NOT_ASSIGNED_RIDER`| —|
| `OUT_FOR_DELIVERY → DELIVERED`| Rider| **The `OperationalPaymentDemand` is `SETTLED` where payment is due**, *then* valid recipient OTP.| Terminal for `DOORSTEP`| `RECIPIENT_PAYMENT_OUTSTANDING`, `OTP_INVALID`| **AMENDED · RE-SIGNED — `MSC-DEC-366`**|
| `OUT_FOR_DELIVERY → ATTEMPT_FAILED`| Rider| An **active** reason from the Delivery Failure Reason Catalog, plus the evidence that reason requires| **`delivery_attempt_count += 1` only where the selected reason carries `consumes_delivery_attempt = true`**. Otherwise the failure is recorded and the counter is untouched| `REASON_REQUIRED`| **AMENDED · RE-SIGNED — `MSC-DEC-366`**|
| `ATTEMPT_FAILED → AT_HUB_AFTER_FAILURE`| **Hub Ops**, confirming the parcel custody return — **or Hub Senior Ops** on a `RECEIVED_LATE` disposition (§12.2)| **The order's line on a `ParcelCustodyReturn` reaches `RECEIVED`** — the hub confirmed physical receipt at `confirmed_at` (§12.2).| **Mandatory** — no rider overnight hold exists (§36.9). **The rider's declaration moves nothing**: it is the hub's confirmation that moves the order| `CUSTODY_NOT_RETURNED`| **AMENDED · RE-SIGNED — `MSC-DEC-410`**|
| `OUT_FOR_DELIVERY → AT_HUB_AFTER_FAILURE`| **Hub Ops**, confirming the parcel custody return — **or Hub Senior Ops** on a `RECEIVED_LATE` disposition (§12.2)| **The order's line on a `ParcelCustodyReturn` reaches `RECEIVED`**, or is dispositioned `RECEIVED_LATE`; its `DeliveryStop` is **terminal and not `DELIVERED`** — `SKIPPED`, or an outbound stop `FAILED` at the counter — and **no live `VendorSuspensionHold` covers it**, because a held parcel's fulfilment intent is the hold's to decide (§6.17, `OQ-143`)| **No attempt is consumed.** `delivery_attempts` is untouched and **the skip is not retrospectively a physical attempt** — §12.1's `→ SKIPPED` row already says no rider reached the door. The parcel becomes available for an authorised disposition, redelivery or Return, exactly as a failed one does| —| **AMENDED · RE-SIGNED — `MSC-DEC-417`**|
| `AT_HUB_AFTER_FAILURE → READY_FOR_REATTEMPT`| **Authorised Ops**| **A scheduled `Redelivery`** — Ops approves the new trip, and the commercial obligation is created there. **No attempt ceiling is consulted**: `MSC-DEC-350` retired the fixed maximum, and each further trip needs its own approval| The parcel joins a new run and runs **its own three checkpoints**, starting at `PRE_DISPATCH`| `INSUFFICIENT_AUTHORITY`, `STOP_NOT_QUALIFYING`| **AMENDED · RE-SIGNED — `MSC-DEC-366`**|
| `READY_FOR_REATTEMPT → ASSIGNED`| Ops| The scheduled `Redelivery` reaches `IN_PROGRESS` — the parcel joins a new run, **after its own `PRE_DISPATCH` checkpoint clears** (§20.5)| Mirrors `READY_FOR_DISPATCH → ASSIGNED`: the order is placed on a `DeliveryRun`. **The redelivery trip runs the same three checkpoints**, not attempts four, five and six| `DISPATCH_NOT_CLEARED`, `NOT_ASSIGNED_RIDER`| **NEW · SIGNED — `MSC-DEC-385`**|
| `READY_FOR_REATTEMPT → AT_HUB_AFTER_FAILURE`| **Authorised Ops**| The scheduled `Redelivery` reaches `CANCELLED` **before entering `IN_PROGRESS`** (§20.5)| The order returns to **eligible but unscheduled** — §20.5's own *“a parcel can sit at the hub eligible and unscheduled, owing nothing”*. **Both obligations are already `VOID`** by `MSC-DEC-353` and nothing further is charged here. Ops may schedule another `Redelivery` or commit a `ReturnRecord` from this state| `REASON_REQUIRED`| **NEW · SIGNED — `MSC-DEC-385`**|
| `AT_HUB_AFTER_FAILURE → READY_FOR_DISPATCH`| Ops — **`clearOutboundForDispatch`** (`dispatch.outbound.clear`)| `lane = THIRD_PARTY_HANDOFF`, the parcel back after a failed counter or a covered `RETURNED`, and **the outbound charge still confirmed paid** — no new charge is raised| **Re-dispatch.** A `PENDING_HANDOFF` record is reused with its stop link cleared; after a covered `RETURNED`, System opens a new one (§10). **No attempt is consumed**| `OUTBOUND_CHARGE_UNPAID`, `STATE_CONFLICT`| **AMENDED · RE-SIGNED — `MSC-DEC-417`**|
| `AT_HUB_AFTER_FAILURE → RETURN_TO_VENDOR_IN_PROGRESS`| **Authorised Ops**, not System| **A committed `ReturnRecord`** — a deliberate Return decision. **No attempt counter starts Return** and none ends ordinary delivery: a further trip is a scheduled `Redelivery`, and the physical-attempt count is history, never a gate| Commercial machine moves to `REVERSED`; return fee becomes applicable **at formal initiation**| `INSUFFICIENT_AUTHORITY`| **AMENDED · RE-SIGNED — `MSC-DEC-366`**|
| `AWAITING_RECIPIENT_CONFIRMATION`/`READY_FOR_DISPATCH`/`ASSIGNED`/`OUT_FOR_DELIVERY`/`ATTEMPT_FAILED`/`READY_FOR_REATTEMPT` → `RETURN_TO_VENDOR_IN_PROGRESS`| **Authorised Ops**, not System| **A `VendorSuspensionHold` in `HELD` for this order, dispositioned return-to-vendor** by a holder of `vendor.held_parcel.decide` **for the order's `responsible_hub_id`** (§29.6, `MSC-DEC-142`). **Authority scope, not physical custody** — the guard reads the accountable hub and **says nothing about where the parcel is**. **Not reachable without a suspension** — the ordinary route to Return stays the row above| Commercial machine moves to `REVERSED`; a `ReturnRecord` is committed with `originating_delivery_stop_id` **null** and the **same flat return fee** as any other return (§29.6, `MSC-DEC-171`). **This transition asserts no hub possession and rewrites no custody**: `custody_location` continues to record the truth — including *"with rider on run R"* — until a later custody-transfer event moves it. Where the order is `OUT_FOR_DELIVERY`, the stop follows §12.1's **signed** `→ SKIPPED` semantics| `INSUFFICIENT_AUTHORITY`, `STATE_CONFLICT`| **AMENDED · RE-SIGNED — `MSC-DEC-400`**|
| `RETURN_TO_VENDOR_IN_PROGRESS → RETURNED_TO_VENDOR`| Rider or Ops| Return-fee gate satisfied where applicable, **then** valid vendor or sender OTP| Terminal| `RETURN_FEE_OUTSTANDING`, `OTP_INVALID`| —|
| `OUT_FOR_DELIVERY → HANDED_TO_CARRIER`| Rider| `ThirdPartyHandoff` reached `HANDED_OVER` at the order's stop (§10, §12.1).| **Terminal for `STATION_DROP` only** — see §10| `HANDOFF_NOT_RECORDED`| **AMENDED · RE-SIGNED — `MSC-DEC-417`**|
| `HANDED_TO_CARRIER → DELIVERED`| Ops, by recording the covered outcome (§10)| `commercial_mode = MELARC_COVERED_THIRD_PARTY_DELIVERY`, and the `ThirdPartyHandoff` reaches `DELIVERED`| Terminal. **The covered charge is earned here** (§24.7.2, §36.10) — handoff alone never settled it| `TERMINAL_FOR_STATION_DROP`| **AMENDED · RE-SIGNED — `MSC-DEC-417`**|
| `HANDED_TO_CARRIER → AT_HUB_AFTER_FAILURE`| Ops, by recording the covered outcome (§10)| Covered mode, and the `ThirdPartyHandoff` reaches `RETURNED` — the parcel is back at the responsible hub| **Custody returns to Melarc.** No delivery attempt is consumed; Ops then re-dispatches or starts a Return| `TERMINAL_FOR_STATION_DROP`| **AMENDED · RE-SIGNED — `MSC-DEC-417`**|

**Five rows are amended and all five are now re-signed** — Product Owner, 4 September 2026, `MSC-DEC-366`.


**The previous signatures stand for every other row.** They do not cover the new suspension route until the Product Owner re-signs.

**The outbound path runs end to end from `MSC-DEC-417`.** Ops clears a paid third-party order for dispatch, and System opens its handoff record then; it joins a run and goes `OUT_FOR_DELIVERY` with the run; the rider hands it over at the stop and it goes `HANDED_TO_CARRIER`. **A failed counter** fails the stop, the parcel comes back with the run's custody return and the order reaches `AT_HUB_AFTER_FAILURE`, where Ops re-dispatches it at no new charge or starts a Return. **In the covered mode** Ops records the third party's outcome: `DELIVERED` completes the order, and a parcel that comes back re-enters at `AT_HUB_AFTER_FAILURE` the same way. **A Return reverses the unearned outbound charge** as it reverses any delivery fee — the Station Drop fee is earned only at handoff and the covered charge only at delivery.

**Outbound orders pass a second prepayment gate that the credit gate does not satisfy.** §35.7.7 forbids dispatching `STATION_DROP` "until the effective company-wide fee snapshot — GH₵25 at launch — is backend-confirmed as paid," with the recipient separately paying the third party at destination. §35.7.8 forbids dispatching `MELARC_COVERED_THIRD_PARTY_DELIVERY` until "the complete combined waybill-plus-Melarc charge is backend-confirmed as paid," with the recipient owing nothing. `OUTBOUND_CHARGE_UNPAID` is distinct from `ORDER_NOT_COMMERCIALLY_CLEARED`; an order can satisfy the vendor credit gate and still fail this one.

**Ordering inside the delivery transition is itself a business rule.** §36.9 requires payment confirmation *before* OTP, and OTP *before* handover. §34.5 defines proof of delivery as an OTP "recorded after any required recipient-paid delivery fee is backend-confirmed and before parcel handover." A rider app that captures OTP first and reconciles payment after satisfies neither.

**`CANCELLED` is withdrawn from this machine** (`MSC-DEC-389`, closing `OQ-122`). It was declared here, in [domain-model.md](domain-model.md) and in the `openapi.yaml` `fulfilment_state` enum, and **no transition in any machine produced it and no operation cancelled an `Order`** — §36.9’s own progression never listed it either. **No feature, surface or slice cited it.** An `Order` exists only from intake closure, so by the time one exists the parcel is physically in a hub and every real termination disposes of an object: that path is `→ RETURN_TO_VENDOR_IN_PROGRESS → RETURNED_TO_VENDOR` here, with `→ REVERSED → CLOSED` on the commercial machine. **Withdrawn rather than left unreachable**, on the precedent that retired `DEVICE_NOT_REGISTERED` — *a synonym, and the more dangerous kind: one nothing used* — because a state a reader can see but nothing can enter invites an implementer to supply the missing path. **Specification §22.7 still defers how *damaged, quarantined, cancelled, removed or temporarily unitemizable physical parcels* are represented**; that is a parcel-representation question at intake, not a fulfilment state, and if it ever needs one it returns through a decision rather than through an enum member nobody removed.

**`READY_FOR_REATTEMPT` has both its exits, and it did not until 14 September 2026**. The state was reachable and unleavable: the row above put an order into it when Ops scheduled a `Redelivery`, and **no row took it out** — so when §20.5's `SCHEDULED → IN_PROGRESS` put the parcel on a new run, the order's `fulfilment_state` had no legal move. **The second row is the one that mattered more.** A redelivery cancelled before departure left the order in `READY_FOR_REATTEMPT` while both onward paths — reattempt and Return — require `AT_HUB_AFTER_FAILURE` as their source, so **a physical parcel in a hub could reach a state with no tabled way out at all**. §36.9 delegated exactly this: *“scheduling sub-states … and exceptional administrative paths remain to be canonicalized.”* These two rows complete that delegation; they introduce no new Product rule, no charge and no actor the machine did not already use.


**A fully vendor-paid or sender-paid parcel still requires OTP.** §35.8.2 says so explicitly. OTP proves *receipt*, not payment, so no payer arrangement removes it — including one where the recipient owes nothing at the door.

**Everything visible at dispatch reads from the authoritative order record.** §35.7.10 lists price, recipient data, commercial mode, carrier, payment state and confirmation status. A dispatch screen assembling any of these from cached or run-level state can show a stale value at the moment it matters most.

Every one of these commands is replay-safe. §36.9 requires that "replayed payment, OTP, failure, hub-return, or return-handover commands must not duplicate outcomes" — five commands, all issued from an offline-tolerant device, all idempotent by key.


### 9.1 The suspension route into Return, and why it is one row rather than six

**§29.6 confirms return-to-vendor as a held-parcel disposition** (§29.6, `MSC-DEC-142`) and
§29.6, `MSC-DEC-171` fixes its fee. **Until 21 September 2026 this machine could not express it.**
`RETURNED_TO_VENDOR` is a terminal fulfilment outcome (§16.1), so a returned parcel must arrive
through this machine — and the only entry into `RETURN_TO_VENDOR_IN_PROGRESS` was from
`AT_HUB_AFTER_FAILURE`, which is where a parcel lands after a **failed delivery attempt**. A
suspended vendor's parcels are in **every** non-terminal state, and only one of them is that one.
**The confirmed disposition had no path for most held parcels**, which is not an edge case.

**The six source states are listed explicitly rather than written as “any non-terminal state”.**
An open-ended guard would silently acquire any state a later amendment adds, and the states this
row may leave from is exactly the kind of thing that must not grow by accident. The six are the
non-terminal set minus `AT_HUB_AFTER_FAILURE`, which keeps its own row: the ordinary Return and the
suspension Return are different acts under different authorities, and collapsing them would let a
`vendor.held_parcel.decide` holder perform an ordinary Return, or a `returns.initiate` holder
dispose of a held parcel.

**`HANDED_TO_CARRIER`, `DELIVERED` and `RETURNED_TO_VENDOR` are excluded** — the last two because they are terminal, and `HANDED_TO_CARRIER` because it is terminal for a Station Drop and, in the covered mode, the parcel is in a third party's custody with nothing in Melarc's hands to hold. A covered parcel that comes back re-enters at `AT_HUB_AFTER_FAILURE`, where the hold applies.
A parcel already delivered is history; §29.6 preserves history rather than holding it, and
`VendorSuspensionHold` is created for non-terminal work only.

**The guard reads authority scope, not physical custody, and the distinction is the reason this
row was held back from signature once.** It requires `vendor.held_parcel.decide` for the order's
**`responsible_hub_id`** — the hub that answers for the item. **It says nothing about where the
parcel is.** An earlier draft read *"at the hub where the item physically is"*, which conflated
the two and contradicted `VendorSuspensionHold`'s own model, where `custody_location` may legally
read *"with rider on run R"* (§6.17).

**The disposition may therefore be decided while the parcel is still with a rider, and that is
deliberate.** Requiring hub possession first would make §29.6's confirmed disposition
**unreachable** for most held parcels: the only route into a hub-custody state is
`ATTEMPT_FAILED → AT_HUB_AFTER_FAILURE`, which needs a physical delivery attempt that a suspended
vendor's parcel must never receive. **The decision and the movement are separate events.**

**This transition asserts no hub possession and rewrites no custody.** `custody_location`
continues to record the truth until a later custody-transfer event moves it — and how that
arrival is represented is **`OQ-129`**, an artifact gap this row does not fill and does not
depend on.

**`OUT_FOR_DELIVERY` is included, and it does not recall a rider.** §29.6 requires the system to
*identify where each held item physically is*, not to retrieve it. **Where the order is
`OUT_FOR_DELIVERY`, the stop follows §12.1's `→ SKIPPED` semantics, which are already signed**
and which this row adopts rather than restates:

- **recipient delivery is terminated for that stop** — `SKIPPED` is terminal;
- **no physical delivery attempt is consumed** — nobody reached the door;
- **the stop is not recorded as returned**, and nothing may record the parcel at the hub while it
  is in a pannier;
- **no recipient handover occurs**;
- **custody remains whatever `custody_location` truthfully records** until a later
  custody-transfer event.

**No hub-custody guard is added to this row**, by decision: the invariants above already deliver
what such a guard would protect, and a guard on hub possession would test a fact no contract
currently stores.

**What this row does not do.** It creates no new state, no new terminal outcome and no second
return workflow: closure is [return-to-vendor.md](../features/returns/return-to-vendor.md)'s
OTP-gated handover, unchanged, which is what §29.6 means by *“reusing the Section 28.4 OTP-based
closure”*. It introduces **no cause-based fee carve-out** — §29.6, `MSC-DEC-171` is explicit that a
suspension-triggered return costs the same as any other, and that a Melarc-caused suspension error
is a **candidate** for the existing §5.3 waiver category, case by case, not a blanket exemption.

**This amendment is not covered by `MSC-DEC-366`**, which re-signed 27 rows on 4 September against
a machine that did not contain this one. §9 is **AMENDED · RE-SIGNED** (`MSC-DEC-400`, 21 September 2026),
so the amendment costs no slice its readiness.
that cost — `SLICE-002` and `SLICE-003` both depend on this machine and both moved to `NOT_READY` until it was signed.

## 10. `ThirdPartyHandoff`


§36.10. States: `PENDING_HANDOFF` · `HANDED_OVER` · `IN_TRANSIT` · `DELIVERED` · `FAILED` · `RETURNED` · **`CANCELLED`**. **`CANCELLED` joined at `MSC-DEC-417`** — §24.7.1's *"cancelled handoff"*, for an order that left the outbound path before any handoff. **`FAILED` is not terminal in the covered mode**: the third party is bringing the parcel back, and `RETURNED` follows, superseding §36.10's reading of `FAILED` as a terminal state.

**The terminal state depends on commercial mode.** This is `MSC-DEC-181`, and it is the single most easily missed rule in the delivery domain:

| Mode| `HANDED_OVER` is| Then|
|---|---|---|
| `STATION_DROP`| **Terminal.** Melarc's service and fee-earning complete at verified handoff (§24.7, `MSC-DEC-129–132`).| The third party's onward delivery is outside Melarc's tracked lifecycle entirely.|
| `MELARC_COVERED_THIRD_PARTY_DELIVERY`| **Not terminal.** Melarc remains responsible through the recorded final external outcome.| Ops outcome updates drive `IN_TRANSIT`, then `DELIVERED` — or `FAILED` and then `RETURNED` when the parcel is back.|

| Transition| Actor| Guard| Effects| Failure code| Signature|
|---|---|---|---|---|---|
| `→ PENDING_HANDOFF`| System| The order reaches `READY_FOR_DISPATCH` on the third-party lane (§9) with no `PENDING_HANDOFF` record — its first clearance, or a re-dispatch after a covered `RETURNED`| `commercial_mode` snapshotted from the order. `delivery_stop_id` is set when the order joins a run and cleared on re-dispatch. **One `PENDING_HANDOFF` record per order at a time**| —| **AMENDED · RE-SIGNED — `MSC-DEC-417`**|
| `PENDING_HANDOFF → HANDED_OVER`| Rider| **At the order's outbound stop, `ARRIVED`** (§12.1). **An approved carrier identity captured, in either mode §24.7.3 names** — an **`ACTIVE` `CourierProvider`** from §24.7's register, **or an `ACTIVE` `ApprovedAgent`** at the rider's hub whose identity photo is stored (`MSC-DEC-417`, closing `OQ-133`). **The waybill is the registered mode's requirement**: §24.7.3 and §35.9(9) both scope it there, and `WAYBILL_REQUIRED` has always read *registered handoff without a waybill*. **Evidence is mandatory in both** — a receipt or handoff photo for a registered handoff (§34.5), and for an agent the evidence that design defines.| **Custody leaves Melarc.** The order moves to `HANDED_TO_CARRIER` (§9); for `STATION_DROP` the fee is **earned** at `handed_over_at` (§24.7.1); `delivery.handoff.recorded` is **Enhanced**; the stop becomes `HANDED_OVER` (§12.1)| `CARRIER_NOT_APPROVED`, `WAYBILL_REQUIRED` *(registered mode)*, `EVIDENCE_REQUIRED`| **AMENDED · RE-SIGNED — `MSC-DEC-417`**|
| `PENDING_HANDOFF → CANCELLED`| System| The order enters `RETURN_TO_VENDOR_IN_PROGRESS` (§9) before any handoff — by Ops' Return decision or a suspension disposition| **The outbound path is abandoned.** The Return reverses the unearned outbound charge as it reverses any delivery fee (§6.14, `MSC-DEC-394`) — owed back in full| —| **AMENDED · RE-SIGNED — `MSC-DEC-417`**|
| `HANDED_OVER → IN_TRANSIT`| Ops — `recordHandoffOutcome` (`delivery.handoff.outcome`)| Covered mode| The third party reports the parcel moving| `TERMINAL_FOR_STATION_DROP`| **AMENDED · RE-SIGNED — `MSC-DEC-417`**|
| `HANDED_OVER/IN_TRANSIT → DELIVERED`| Ops — `recordHandoffOutcome`| Covered mode, and the third party reports delivery| The order moves to `DELIVERED` (§9) and **the covered charge is earned**| `TERMINAL_FOR_STATION_DROP`| **AMENDED · RE-SIGNED — `MSC-DEC-417`**|
| `HANDED_OVER/IN_TRANSIT → FAILED`| Ops — `recordHandoffOutcome`| Covered mode, and the third party reports it cannot deliver. **Reason mandatory**| **Not terminal** — the third party is bringing the parcel back, and `RETURNED` follows. A parcel it loses stays open here until claims are designed (§28.5)| `TERMINAL_FOR_STATION_DROP`, `REASON_REQUIRED`| **AMENDED · RE-SIGNED — `MSC-DEC-417`**|
| `HANDED_OVER/IN_TRANSIT/FAILED → RETURNED`| Ops — `recordHandoffOutcome`| Covered mode, and the parcel is back at the responsible hub| **Custody returns to Melarc**; the order moves to `AT_HUB_AFTER_FAILURE` (§9)| `TERMINAL_FOR_STATION_DROP`| **AMENDED · RE-SIGNED — `MSC-DEC-417`**|

**One outcome row became four at `MSC-DEC-417`**: it had no operation and no permission key, and it treated `FAILED` as the end when the parcel still has to come back. **`STATION_DROP` still reaches none of them** — `HANDED_OVER` is terminal for it. **A counter failure is not a handoff state**: the stop fails (§12.1), the record stays `PENDING_HANDOFF`, and a re-dispatch reuses it.

§36.10 adds a guard worth stating separately: **the system must not mark a shipment financially settled merely because physical handoff occurred**, unless finance policy explicitly defines that event. For `STATION_DROP` it does. For the covered mode it does not.

Version 1 is a manual Melarc-managed courier register. No external booking, label, webhook or tracking states exist (`COURIER-007`).

## 11. `RecipientConfirmation`

§36.8. States: `AWAITING_ATTEMPT` · `ATTEMPTED_NO_ANSWER` · `CONFIRMED` · `DETAILS_CORRECTION_REQUIRED` · `REFUSED` · `ESCALATED` · `MAX_ATTEMPTS_REACHED`.

§36.8 states plainly that "the approved product policy references attempt limits but does not approve the complete state model." The states above are the six distinctions §36.8 requires.

**There is no fixed contact-attempt ceiling**.

`CONFIRMED` is the gate on `AWAITING_RECIPIENT_CONFIRMATION → READY_FOR_DISPATCH` for the doorstep lane (§34.5).

**The current transitions** *(Gate C C1.3 — `MSC-DEC-351`, `MSC-DEC-346`, `MSC-DEC-347`)*:

| Transition| Actor| Guard| Effects| Failure code| Signature|
|---|---|---|---|---|---|
| `→ AWAITING_ATTEMPT`| System| The order is planned onto a run and needs its `PRE_DISPATCH` checkpoint| —| —| —|
| `AWAITING_ATTEMPT → ATTEMPTED_NO_ANSWER`| **Assigned Rider or authorised Ops**| Contact attempted, unsuccessful. An `active` `PRE_DISPATCH` reason| A `RecipientContactAttempt` row. **The parcel is `HOLD_AT_HUB`**. Vendor notified with the recipient's name where assistance helps| `REASON_REQUIRED`, `REASON_NOT_VALID_FOR_CHECKPOINT`| **AMENDED · RE-SIGNED — `MSC-DEC-366`**|
| `ATTEMPTED_NO_ANSWER → AWAITING_ATTEMPT`| **Assigned Rider or authorised Ops**| **Any operationally useful retry** — a Vendor-supplied number, an alternative contact, or simply trying again before departure. **No count is consulted**| Another attempt row. **No force-extension, no approval, no ceiling**| —| **AMENDED · RE-SIGNED — `MSC-DEC-366`**|
| `AWAITING_ATTEMPT → CONFIRMED`| **Assigned Rider or authorised Ops**| Recipient reached; availability and delivery location acceptable| **`CLEARED_FOR_DISPATCH`.** The parcel may join the finalised physical load| —| **AMENDED · RE-SIGNED — `MSC-DEC-366`**|
| `AWAITING_ATTEMPT → DETAILS_CORRECTION_REQUIRED`| **Rider or Ops** records; **Ops decides**| A reschedule or location-change request| Held. Routed to Ops; the **rider never mutates** the commitment or the destination| `INSUFFICIENT_AUTHORITY`| **AMENDED · RE-SIGNED — `MSC-DEC-366`**|
| `AWAITING_ATTEMPT → REFUSED`| **Rider or Ops**| The recipient declines the delivery| Held. Ops decides the disposition| —| —|
| `→ ESCALATED`| **Ops**| **Ops judges the contact avenues exhausted** — **not a counter reaching three**| Senior decision queue| —| **AMENDED · RE-SIGNED — `MSC-DEC-366`**|
| `ESCALATED → AWAITING_ATTEMPT`| **Ops**| A new avenue exists — a corrected number, a Vendor response| Returns to the checkpoint. **No force-extension is required** (`MSC-DEC-351` refining `MSC-DEC-230`)| —| **AMENDED · RE-SIGNED — `MSC-DEC-366`**|
| `ESCALATED →` *return started*| **Senior Ops**| **A deliberate Return decision with a mandatory reason** — never automatic on exhausted calls| The §28.4 return-to-vendor workflow. `flat_return_fee_amount` applies, waivable| `REASON_REQUIRED`| **AMENDED · RE-SIGNED — `MSC-DEC-366`**|

**Seven amended rows, re-signed by the Product Owner on 4 September 2026**.

**`MAX_ATTEMPTS_REACHED` is retained in the state enum and no current transition enters it.** §36.8 fixes the state set and the specification is frozen, so the value stays; `MSC-DEC-351` retired the counter that once reached it, and *Ops judged the avenues exhausted* — the only thing the state was ever used to mean operationally — is carried by **`ESCALATED`**, which the table above enters on Ops judgement. An implementation must not treat `MAX_ATTEMPTS_REACHED` as reachable, and a screen must not offer it.

**What this checkpoint answers, and what it does not** *(§17)*:

| Control| Question|
|---|---|
| **`PRE_DISPATCH` confirmation**| **Should this parcel leave the hub on the planned run?**|
| **`DOORSTEP` OTP and its fallback**| **May this parcel be handed to the person standing here?**|

**These are different controls and one does not justify the other.** The old rationale defended confirmation on the ground that *a valid OTP is the sole proof of delivery* — which stopped being true when `MSC-DEC-326` authorised an Ops fallback, and would have made the whole checkpoint look redundant. **It is not.** Confirmation exists to **avoid wasted dispatch**, find unreachable contacts early, resolve unavailability and settle date or location changes **before a rider is carrying the parcel**. The fallback recovers a delivery where the recipient **is** present; confirmation prevents a trip to someone who will **not be there at all**.

### 11.1 Two exits from `ESCALATED`

`MSC-DEC-230`. §24.2 sent escalated orders into a senior decision queue and **named no way out**. Hub Senior Ops has exactly two, and **both are tabled in §11 above — that table is the only current transition truth for this machine.**

| Exit| What it means now|
|---|---|
| `ESCALATED → AWAITING_ATTEMPT`| **A new useful avenue exists** — a corrected number, a Vendor response, an alternative contact. Contact resumes. **No force-extension, no counter and no ceremony**: there is nothing to extend|
| `ESCALATED →` *return started*| **A deliberate authorised Return decision with a mandatory reason.** §28.4 return-to-vendor; **`flat_return_fee_amount` applies**, waivable by Ops with a reason and Senior Ops approving. **Never automatic on exhausted contact**|

Use one current transition table per machine. Retired attempt caps and force-extension behavior must not be implemented for recipient-contact checkpoints.

**A third exit was rejected, and the reason it was rejected has changed** *(Gate C C1.3)*. Dispatching without confirmation remains wrong, but **not because the OTP is the only possible proof** — `MSC-DEC-326` authorises an Ops fallback, and an argument resting on OTP being absolute would collapse the moment a reader noticed that. **The reason that survives is operational**: a parcel carried to an unreachable recipient is a wasted trip, and the checkpoint exists to find that out before a rider leaves.

### 11.2 `PRE_DISPATCH` is checkpoint one, and Ops or the Rider may complete it

`MSC-DEC-346`, `MSC-DEC-347`. **This machine is checkpoint one of three.** Its contact attempts are `RecipientContactAttempt` rows carrying `checkpoint = PRE_DISPATCH`.

**Either the assigned Rider or authorised Ops may perform it**, both under `dispatch.recipient_confirmation.work`, both writing **the same canonical record**. **A rider is never made to repeat a call Ops already made** — where Ops completed the checkpoint, the rider's app shows the result and the rider moves on. Two parallel confirmation systems, one for Ops and one for riders, would produce two answers to *has this recipient been reached*.

**`confirmed` alone clears a parcel for dispatch.** A parcel that is planned onto a draft run is **not thereby permitted to leave the hub**: clearance is a separate condition, and an unresolved or failed checkpoint holds the parcel in hub custody. **Only cleared parcels enter the finalised physical load.**

**A `PRE_DISPATCH` failure is not a delivery attempt.** No rider has travelled. `Order.delivery_attempts` is untouched, whatever the reason's metadata says.

## 12. `DeliveryRun`

§36.9. States mirror `PickupManifest`: `DRAFT` · `DISPATCHED` · `IN_PROGRESS` · `COMPLETED` · `CANCELLED`.

One rule distinguishes it, from §24.3, `MSC-DEC-154–155`: **a run may freely mix carrier identities and commercial modes.** Registered-courier and informal-carrier stops, `STATION_DROP` and `MELARC_COVERED_THIRD_PARTY_DELIVERY` stops, all on one run. The run imposes no compatibility constraint, and each order's carrier and mode facts are tracked on the order. A guard that rejects a mixed run would contradict an approved decision.

## 12.1 `DeliveryStop`

§36.9, `MSC-DEC-229`. **Mirrors `PickupStop` §5 deliberately** — one mental model across both halves of the product.

States: `PENDING` · `ARRIVED` · **`AWAITING_RECIPIENT`** · `DELIVERED` · `FAILED` · `SKIPPED` · **`HANDED_OVER`**. Terminal: `DELIVERED`, `FAILED`, `SKIPPED`, `HANDED_OVER`. **`HANDED_OVER` joined at `MSC-DEC-417`**: an outbound stop ends at the handoff, and `DELIVERED` — an OTP at a door — could never be its outcome.

| Transition| Actor| Guard| Effects| Failure code| Signature|
|---|---|---|---|---|---|
| `PENDING → ARRIVED`| Rider| Run `IN_PROGRESS`| —| `MANIFEST_NOT_STARTED`| —|
| `ARRIVED → DELIVERED`| Rider| **The `OperationalPaymentDemand` is `SETTLED` where payment is due**, *then* **valid recipient OTP** (§36.9, §19.6). Both, in that order. **`SETTLED`, not *an attempt succeeded* and not *a receipt exists***: a GH₵50 receipt against GH₵55 is real money and **does not open the door**| Order → `DELIVERED`; proof recorded| `RECIPIENT_PAYMENT_OUTSTANDING`, `OTP_INVALID`| **AMENDED · RE-SIGNED — `MSC-DEC-366`**|
| `ARRIVED → AWAITING_RECIPIENT`| Rider| **Contact at the door failed** — an `active` `DOORSTEP` reason. **Ops is alerted**| **The server sets `wait_started_at` and derives `wait_expires_at`** from `doorstep_wait_minutes`. Retries by rider, Ops or Vendor stay **inside this checkpoint**| `REASON_REQUIRED`, `REASON_NOT_VALID_FOR_CHECKPOINT`| **AMENDED · RE-SIGNED — `MSC-DEC-366`**|
| `AWAITING_RECIPIENT → ARRIVED`| Rider| **The recipient became available before expiry**| Wait closed. **No failure, no physical attempt consumed, no redelivery.** The delivery continues into payment and verification| —| **AMENDED · RE-SIGNED — `MSC-DEC-366`**|
| `AWAITING_RECIPIENT → FAILED`| Rider| **`now() >= wait_expires_at`, read from server time**, and Ops assistance has not recovered the delivery| **A physical delivery attempt is consumed** where the reason says so; Order → `ATTEMPT_FAILED`; Vendor notified with recipient name and order reference| `DOORSTEP_WAIT_NOT_ELAPSED`, `REASON_REQUIRED`| **AMENDED · RE-SIGNED — `MSC-DEC-366`**|
| `ARRIVED → FAILED`| Rider| **A qualifying reason that terminates immediately** — an in-person refusal — and **not ordinary no-contact**, which must wait. An `active` catalogue reason carrying its attribution and `consumes_delivery_attempt`.| Attempt chain extended; Order → `ATTEMPT_FAILED`. **Any payment already taken is recorded against the order and travels to hub reconciliation**| `REASON_REQUIRED`, `VALIDATION_FAILED`| **AMENDED · RE-SIGNED — `MSC-DEC-366`**|
| `ARRIVED → DELIVERED` **without OTP**| **Hub Senior Ops** authorises; the rider executes| §25.1's extraordinary path. **The demand must still be `SETTLED`** — the OTP fallback waives verification, never payment. **Mandatory reason**| Order → `DELIVERED`. Emits `delivery.otp.overridden`, **enhanced**| `INSUFFICIENT_AUTHORITY`, `REASON_REQUIRED`, `RECIPIENT_PAYMENT_OUTSTANDING`| **AMENDED · RE-SIGNED — `MSC-DEC-366`**|
| `PENDING → SKIPPED`| **Rider**, on a failed `NEXT_STOP` checkpoint| **The recipient could not be reached before arrival**. An `active` `NEXT_STOP` reason| **The rider continues the route. The parcel stays in RIDER custody** — it is not at the hub and must not be recorded as returned. **No physical delivery attempt is consumed**: nobody reached the door. Vendor notified; Ops queue updated| `REASON_REQUIRED`, `REASON_NOT_VALID_FOR_CHECKPOINT`| **AMENDED · RE-SIGNED — `MSC-DEC-366`**|
| `PENDING`/`ARRIVED` → `SKIPPED`| Ops| Authorised skip with reason| —| `REASON_REQUIRED`| —|
| `ARRIVED → HANDED_OVER`| Rider, by the handoff (§10)| **An outbound stop** (`lane = THIRD_PARTY_HANDOFF`) whose order's `ThirdPartyHandoff` reaches `HANDED_OVER` in the same act| Terminal. **No OTP and no payment demand** — the charge was prepaid (§24.7) — and no delivery attempt is recorded| —| **AMENDED · RE-SIGNED — `MSC-DEC-417`**|
| `ARRIVED → FAILED` *(outbound counter)*| Rider| **An outbound stop**, and an `active` `HANDOFF_FAILURE` reason (§3.9) with the note it requires. The handoff record stays `PENDING_HANDOFF`| Terminal. **No delivery attempt is consumed.** The parcel returns with the run's custody return (§12.2) and the order reaches `AT_HUB_AFTER_FAILURE` (§9)| `REASON_REQUIRED`, `REASON_NOT_ACTIVE`| **AMENDED · RE-SIGNED — `MSC-DEC-417`**|

**The doorstep is a checkpoint with a clock, and until C1.2 it had neither**. `ARRIVED → FAILED` fired on one unanswered call: arrive, ring once, fail, ride away. **`AWAITING_RECIPIENT` puts ten server-timed minutes in between**, and the guard reads `wait_expires_at` — **the party who wants to leave is the wrong clock**, which is a statement about incentives rather than about riders. Retries inside the window are **the same checkpoint**, not attempts four, five and six.

**A recipient who appears during the countdown is simply delivered to.** No failure, no redelivery, no attempt consumed — the outcome the whole workflow exists to produce.

**`NEXT_STOP` failure skips the stop and the parcel stays with the rider**. The rider continues the route; **the parcel is not at the hub** and nothing may record it as returned while it is in a pannier. It returns at end of run through the ordinary custody transfer.

**Neither `PRE_DISPATCH` nor `NEXT_STOP` is a physical delivery attempt.** No rider reached the door, so `Order.delivery_attempts` is untouched and **no redelivery charge could arise from either** — see `MSC-DEC-349`, which creates none in any case.

**The `ARRIVED → FAILED` row is amended and re-signed** *(amended Gate C R1; re-signed 4 September 2026, `MSC-DEC-366`)*. The reason is now drawn from the **catalogue** and carries its own attribution and `consumes_delivery_attempt`, so a Melarc-caused failure is recorded without costing the customer an attempt.

**The five reasons remain seeded and remain routing-distinct** — what changed is that adding an approved operational reason no longer requires a code deployment, and that the *consequence* of a reason is read from the reason. **`RECIPIENT_REFUSED` still consumes an attempt**, because its catalogue entry says so and not because the enum is closed.

**The five failure reasons are seeded defaults in a controlled catalogue**, and **routing is what admits a reason to it**. A category that changes nothing Ops does next is a note, not a reason — **but that is a test for admission, not a bar on it**, and an approved operational reason may be added without a deployment. `RECIPIENT_UNAVAILABLE`, `ACCESS_DENIED`, `RECIPIENT_REFUSED`, `PAYMENT_NOT_COMPLETED`, `OTP_NOT_VERIFIED`. §25.3 requires the reason to stay **adjudicable**, which means each value must change what Ops does next — a category that routes identically to another is a note wearing an enum's clothes.

**`RECIPIENT_REFUSED` consumes an attempt and is not terminal.** The case that recurs is **the wrong person answering the door**, and a terminal refusal converts that misunderstanding into an earned vendor-paid return fee (§25.5). Ops may still start the return immediately; what the rule removes is the *system* deciding it on the rider's word.

**The override row and `OTP_NOT_VERIFIED` are not alternatives.** One records a stop that **completed without OTP**; the other records a stop that **failed**. Collapsing them would hide every override inside the failure statistics, which is precisely where the control would stop working — `MSC-DEC-197`'s discretionary pattern depends on the frequency staying visible.

**`MANIFEST_NOT_STARTED` is reused rather than duplicated.** Its description already reads *“a stop action was attempted before the **run** started”* — only the name is pickup-flavoured. Adding `RUN_NOT_STARTED` beside it would repeat the `WRONG_HUB` mistake of 20 August: two codes for one condition, with handlers branching on whichever the author happened to know.

**Payment and OTP are guards, not states**. §36.9 states both as invariants on delivery closure, and modelling them as intermediate states would break symmetry with `PickupStop` for no gain the guard does not already give.

### 12.1.1 A `FAILED` stop may be carrying money

This is the rule most easily lost, because **the state machine cannot show it**.

A rider takes payment, then the OTP will not validate — a wrong number, no signal, a dead handset. §36.9 forbids a rider handing the parcel over without a valid OTP, so **absent an authorised Ops fallback** the stop fails **after** money has moved.

**Where the recipient is physically present, that failure is recoverable and should be recovered**. The rider requests assistance, Ops performs an approved alternative verification and **authorises the handover** — the `ARRIVED → DELIVERED` **without OTP** row above. **A rider may never self-bypass**, and payment is still settled first. The stop fails only where verification cannot be completed safely or the recipient is not there.

**The money is held, not refunded at the door**. Asking a rider to reverse a mobile-money transaction standing at a stranger's door is not a control. The payment is recorded against the order and returns with the rider into cash custody and hub reconciliation; the parcel returns too.

**So a `FAILED` delivery stop and a `FAILED` pickup stop look identical here and are not.** Anything reading stop state to decide what a rider is holding **must consult the payment record**, never the stop alone.

**This path is specified end to end.** It routes into `RiderCashCustody` §16.3; a transition table exists and the cash chain runs through to hub reconciliation and final disposition.

### 12.1.2 Ordering inside the successful transition is itself a rule

§36.9 lists *"recipient payment if due **+** valid recipient OTP"* in that order, and §36.9's delivery progression at §9 requires payment confirmation **before** OTP. An implementation that validates the OTP first and then asks for money has reordered an approved sequence — and creates the worse failure: a recipient who has proved identity, been shown the parcel, and then cannot pay.

## 12.2 `ParcelCustodyReturn`

§36.9, §35.8.7. Written 24 September 2026 by `MSC-DEC-408`, **SIGNED — Product Owner — 25 September 2026 — `MSC-DEC-410`**, and **two rows amended and re-signed the same day at `MSC-DEC-411`**, which gave the skipped parcel its route into hub custody and so widened what a received line moves. **`MSC-DEC-417` amended and re-signed it again on 26 September 2026** — the `→ DECLARED` guard now bars a `HANDED_OVER` order as well as a `DELIVERED` one, and `VARIANCE_OPEN → CLOSED`'s `RECEIVED_LATE` moves an `OUT_FOR_DELIVERY` order back after a covered return — **four amended rows in all** (§1.1). The original signature which also amended and re-signed §9's `ATTEMPT_FAILED → AT_HUB_AFTER_FAILURE` row in the same act, so that one machine no longer says **Rider** where the other says **Hub Ops**. **`OQ-129` is narrowed, not closed**: the signature was one of the two things it owed, and **the missing-declaration backstop is the other** — a run whose rider declares nothing still produces no record.
**The record of undelivered parcels coming back from a delivery run to the responsible hub.**

States: `DECLARED` · `RECEIVED` · `VARIANCE_OPEN` · `CLOSED`. Terminal: `CLOSED`.

**The state names are not the cash handover's, deliberately.** `DECLARED` and `RECEIVED` say what the record holds; reusing `OPEN`/`CONFIRMED` would put two different machines behind one pair of words and make state interpretation ambiguous.

**It mirrors `CashHandover` §16.4 deliberately**, because it is the same act on different goods: a
rider arrives at the hub at the end of a run, declares what they are handing over, and **the hub —
not the rider — confirms receipt**. Cash and parcels travel in the same pannier and come back in
the same conversation; two unrelated mental models for one arrival would be a defect.

| Transition| Actor| Guard| Effects| Failure code| Signature|
|---|---|---|---|---|---|
| `→ DECLARED`| **The rider holding the parcels**| At the **responsible hub**, after the run. The rider names the run and **every undelivered order still aboard**, each of which must carry a stop on that run that is **neither `DELIVERED` nor `HANDED_OVER`** — a handed-over parcel is a third party's| **No custody has moved.** Each order stays in the state it was already in| `NOT_ASSIGNED_RIDER`, `NOT_CUSTODY_HOLDER`, `ORDER_NOT_ON_RUN`| **AMENDED · RE-SIGNED — `MSC-DEC-417`**|
| `DECLARED → RECEIVED`| **Hub Ops**, not the rider| The hub confirms receipt of **every** order named, and holds none that was not named| **Custody transfers, at `confirmed_at`.** `confirmed_at` is set, and **every received line whose order §9 provides a transition for moves** — an `ATTEMPT_FAILED` order to `AT_HUB_AFTER_FAILURE`, and from `MSC-DEC-411` an `OUT_FOR_DELIVERY` order whose stop is terminal and undelivered with no live hold, to the same state. **An order §9 provides no transition for is recorded and does not move**| —| **AMENDED · RE-SIGNED — `MSC-DEC-411`**|
| `DECLARED → VARIANCE_OPEN`| **Hub Ops**| A named order is **not physically present**, or a present one was **not named**. **Reason mandatory**| **Custody transfers for the orders actually received** and for those alone; every other line stays open against the rider. **The order transitions §9 provides apply to the received lines** exactly as on the row above| `REASON_REQUIRED`, `ORDER_NOT_ON_RUN` — **an order the rider did not name must still be eligible for this run**, the same rule the declaration door applies, converged with `confirmParcelCustodyReturn` at `MSC-DEC-410`| **AMENDED · RE-SIGNED — `MSC-DEC-411`**|
| `VARIANCE_OPEN → CLOSED`| **Hub Senior Ops**| **Every open line carries a `disposition`** — `RECEIVED_LATE`, `CONFIRMED_NOT_RECEIVED` or `DECLARATION_CORRECTED` — with a reason| Terminal. The variance is **dispositioned, not erased**. **`RECEIVED_LATE` transfers that line's custody and moves an `ATTEMPT_FAILED` order to `AT_HUB_AFTER_FAILURE`, and an `OUT_FOR_DELIVERY` order whose stop is terminal and undelivered with no live hold to the same state** — the late path for a skipped or counter-failed parcel, missing until `MSC-DEC-417`; the other two move no order state| `INSUFFICIENT_AUTHORITY`, `REASON_REQUIRED`| **AMENDED · RE-SIGNED — `MSC-DEC-417`**|
| `RECEIVED → CLOSED`| System| —| Terminal| —| **SIGNED — `MSC-DEC-410`**|

**Custody is the actor test, not assignment.** The two coincide on a delivery run today, because no delivery-run custody transfer exists; the row is written on custody so that creating one later does not reopen it. **Both refusals are declared**, because after any transfer they describe different people — the correction `MSC-DEC-404` made to `submitHubHandover` and `OQ-129` R1 made here.

**A rider may not confirm their own return**, exactly as `AC-SLICE-003-16` forbids for cash. One
party declares and a different party receives, or the count is a single assertion wearing two
names.

**No rider overnight hold exists** (§35.8.7, §36.9). That is the rule this record makes auditable:
before it, a parcel that failed at the door had a signed transition into hub custody and **nothing
that recorded the arrival**, so *custody returned to the responsible hub* was a guard no artifact
could evidence.

**Whose act is the order's transition, and the signature settles it.** §9's
`ATTEMPT_FAILED → AT_HUB_AFTER_FAILURE` row names the **Rider** and guards on *custody returned to
the responsible hub*. This machine puts the transfer at **hub confirmation**, mirroring §16.4,
where `custody_transferred_at` is set at its own confirmation row by Hub Ops — because a rider who can
assert their own receipt can close a run over parcels nobody counted. **No approved text reconciled the two readings until the signature.** `MSC-DEC-410` settled it on the hub and **amended §9's row in the same act** so that both machines now name **Hub Ops** — the rider's declaration moves no order state. `MSC-DEC-411` then widened which orders move: a skipped parcel's order moves on the same confirmation, consuming no attempt.

**What this machine does not reach.** Only orders in `ATTEMPT_FAILED` have a signed route into
`AT_HUB_AFTER_FAILURE`. A parcel **skipped** at `NEXT_STOP` is still `OUT_FOR_DELIVERY`, and a
suspension-held parcel may be anywhere; §9 declares **no transition** carrying either into hub
custody, and adding one would amend a signed machine under §36.13. **They ride home on this record
and their order state does not move** — `OQ-143`.

## 13. `Session`

Governed by §11.2, §37.2, §37.5. Entity at [domain-model.md](domain-model.md) §6.8.

**Approved 21 August 2026 by `MSC-DEC-227`**, which extended `MSC-DEC-200`'s sign-off scope to cover this machine. The decision separates the three rules taken verbatim from §11.2, §37.2 and §37.5 from four derivations approved as derivations — chiefly that **riders hold one live *session*** where §11.2 fixes only one *device*.


**MFA gates login, not actions** (`MSC-DEC-228`, superseding `MSC-DEC-227`'s reading). A Senior Ops or Platform Admin user cannot obtain a session without a second factor; once issued, the session is privileged for its lifetime.

```
ACTIVE ──▶ TERMINATED
```

**Two states.** Elevation was withdrawn by `MSC-DEC-228`: §37.2's *"MFA before privileged access"* means **at sign-in** for Senior Ops and Platform Admin, so a privileged session cannot exist unelevated and there is no second state to hold.

| Transition| Actor| Guard| Effect| Error codes| Signature|
|---|---|---|---|---|---|
| `→ ACTIVE`| System| Credential verified; principal `ACTIVE`; **for Senior Ops and Platform Admin, a valid second factor**; for `RIDER` and `VENDOR`, the request comes from the registered device| Session issued with the bundle **snapshotted**, the authorized hub set resolved, and `expires_at` set from `session_lifetime_minutes`. **For `VENDOR` and `RIDER`, any existing live session is terminated first**| `INVALID_CREDENTIALS`, `MFA_REQUIRED`, `MFA_ENROLMENT_REQUIRED`, `MFA_PROOF_INVALID`, `DEVICE_PROOF_INVALID`, `DEVICE_NOT_ENROLLED`, `CHALLENGE_EXPIRED`, `CHALLENGE_UNUSABLE`, `CREDENTIAL_LOCKED`, `RATE_LIMITED`| **AMENDED · RE-SIGNED — `MSC-DEC-438`**|
| `ACTIVE → TERMINATED`| User, System or Admin| —| `terminated_at` and `termination_reason` recorded| —| —|
| `ACTIVE → TERMINATED` **on authority change**| System| Any security-relevant authority change| Terminated **immediately** with the matching reason. The next login takes a fresh snapshot| —| —|
| `ACTIVE → TERMINATED` **on idle**| System| `now − last_activity_at > session_idle_timeout_minutes`. **Browser sessions only**| `EXPIRED`. Rider sessions have no idle rule| —| —|

**`MFA_REQUIRED` is a sign-in challenge, not an action refusal.** It is returned mid-sign-in to a role that must present a second factor, and never in response to a business operation — a session that exists is already privileged to whatever its bundle allows.

**A privileged identity with no `ACTIVE` factor is answered the same way at the password step** (Product decision, 6 October 2026). The correct password of a Senior Ops or Platform Admin identity that holds no `ACTIVE` `MfaFactor` — its factor is `PENDING`, was revoked by a reset, or was never provisioned — is answered with the same `202` challenge as for an enrolled identity, so the password step says nothing about the factor. **`completeStaffMfaSignIn` then answers `403` `MFA_ENROLMENT_REQUIRED`**, issues no session and no cookie, and **that attempt does not count toward the lockout** ([staff-authentication.md](../features/identity/staff-authentication.md) §5.3, §5.5).

**Termination reasons, and each is a different event.**

| Reason| Trigger|
|---|---|
| `SIGNED_OUT`| The user signed out|
| `OFFBOARDED`| The principal was offboarded (§30.10). **Distinct from `SUSPENDED`** — one is terminal and one is not, and an auditor reading a session record should not have to join to another table to tell|
| `AUTHORITY_CHANGED`| The identity's assigned bundle changed — an approved bundle change, not an edit of a bundle's contents (§13.1). The snapshot no longer matches the grant|
| `HUB_SCOPE_CHANGED`| The authorized hub set changed. Separate from `AUTHORITY_CHANGED` because §37.3 makes hub scope an independent axis from the bundle|
| `DEVICE_REVOKED`| Melarc **explicitly revoked** the registered device binding — loss, theft or a security workflow.|
| `DEVICE_REPLACED`| **Rider only.** The registered device was **superseded through the approved replacement workflow** — the old device became `REPLACED` when the new handset's enrolment completed. A device already `REVOKED` is not replaced, and its session already ended with `DEVICE_REVOKED`|
| `MFA_RESET`| A Platform Admin reset the principal's MFA factor|
| `SUPERSEDED_BY_NEW_LOGIN`| A newer login displaced this one. **Vendor only** — the shared credential, where displacement is expected and the client is told with `SESSION_SUPERSEDED`|
| `REPLACED_BY_NEW_SESSION`| **Rider only.** The same rider authenticated again on their registered handset. The old token then fails as an ordinary invalid session — **a rider never receives `SESSION_SUPERSEDED`**|
| `EXPIRED`| `expires_at` passed|
| `CREDENTIAL_CHANGED`| Password, PIN or vendor secret changed|
| `SUSPENDED`| The principal was suspended (§30.9, §29.6)|
| `ADMIN_REVOKED`| Platform Admin or Senior Ops revoked it|

### 13.1 Three rules that are easy to get wrong

**One live session per rider, and one per vendor credential — and the two are not the same rule**. A rider re-authenticating on their registered handset ends the prior session with **`REPLACED_BY_NEW_SESSION`**, and the displaced client gets a plain `401 SESSION_INVALID`. There is no colleague to explain to: it is the same person, on the same device. Handing a rider `SESSION_SUPERSEDED` would import a shared-account concept into a one-person, one-device credential.

**One live session per vendor credential, and displacement must be *told*, not merely done.** §11.2 and §37.2: a new successful login ends the earlier session. The displaced device must receive `SESSION_SUPERSEDED` on its next call rather than a generic `401`. A vendor's colleague signing in elsewhere is **normal operation** at Melarc — the shared credential makes it routine — and a message reading *"your session expired"* invites a support call about a system working exactly as designed.

**A privileged session is privileged for its whole life.** With elevation withdrawn, nothing re-challenges a Senior Ops user after sign-in.

**Which is exactly why an authority change must end the session**. `bundle_snapshot` is deliberately a snapshot — resolving live would judge yesterday's action by today's authority — and the same property means a reduced bundle would otherwise leave the old permissions live for up to eight hours. **An administrator would remove access in the database while the user kept it.** Termination is what reconciles a historically honest snapshot with immediate revocation. **That is an authority change to the identity** — a different bundle assigned (`AUTHORITY_CHANGED`), a hub scope change, a suspension. **Editing the contents of a bundle is not one** (Product decision, 6 October 2026): the edit applies to sessions created after it, live sessions keep the snapshot they were issued with, and a narrowing that must act at once is done with `revokeSession` ([permission-enforcement.md](../features/identity/permission-enforcement.md) §5.5).

**The session credential is opaque, and the transport is now defined**. Browser surfaces receive it in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie; Melarc Rider receives the same class of secret as a Bearer credential in Android secure storage. Only `token_hash` is stored. **This was previously deferred to a Solution Architecture section that never defined it** — everything about the record was specified except what the client presents on the next request.

**`MSC-DEC-234` closed `OQ-071` with two controls rather than one figure.** Both are per-tier: privileged sessions expire absolutely at **480 minutes** and after **15 minutes idle**. The second key exists because `session_lifetime_minutes` was the wrong instrument — the exposure is an **unattended** browser, and an absolute lifetime cannot tell a user who walked away from one who is working. Tuning it alone forced a choice between interrupting active officers and leaving abandoned sessions live.

**A credential change terminates every session, including the one making the change.** §37.5 requires recovery to *"revoke or control prior sessions"*, and for a shared vendor credential that **is the entire point of recovery**: the vendor changing the secret is trying to remove access from someone else. Leaving other sessions live means the recovery achieved nothing.

### 13.2 What has no transition here

**Lockout is not a session state.** It attaches to the *credential*, not to a session — a locked-out principal has no session to hold the state. The count and the lock live on the embedded credential ([domain-model.md](domain-model.md) §6.8, *Failed attempts and lockout*) and are decided **before the credential is verified**, so a locked credential never reaches the `→ ACTIVE` guard; the lock is recorded through `auth.lockout.applied`.

**Device registration is not a session state either.** A device is bound to a principal and outlives any session; `RegisteredDevice.status` carries it.

**The staff identity's own lifecycle is a machine, and it is at §13.3.** A session is issued *against* a `StaffIdentity`; the record's own states — created, approved, suspended, offboarded — are not session states and were missing entirely until 24 August.

### 13.3 `StaffIdentity` — the record a session is issued against

Governed by §30.3, **§30.8**, §30.9, §30.10, §11.6. Entity at [domain-model.md](domain-model.md) §6.8. Written 24 August by `MSC-DEC-247`.

States: `PENDING_APPROVAL` · `ACTIVE` · `REJECTED` · `SUSPENDED` · `OFFBOARDED`. Terminal: `REJECTED`, `OFFBOARDED`.

**Placed here rather than as a machine section of its own** because §13 is where identity lives and renumbering §14 and §15 a second time would strand the citations in three revision histories that already point at them.

**Why this exists, and it is the plainest gap the programme has found.** §13's `→ ACTIVE` guard requires the principal to be `ACTIVE`. [staff-authentication.md](../features/identity/staff-authentication.md) §4 requires "a staff record… with an assigned permission bundle." **Nothing could produce either.** `status` was `ACTIVE · SUSPENDED · OFFBOARDED`, and §30.8 requires an independent approval *before* a profile becomes active — so the record that §30.8 creates had **no state to occupy** and the rule was inexpressible rather than merely unimplemented. `CONFLICT-035`, `CONFLICT-036`.

| Transition| Actor| Guard| Effects| Failure code|
|---|---|---|---|---|
| `→ PENDING_APPROVAL`| **Ops Staff, Senior Ops or Platform Admin** at own hub (§30.8)| Work email unique in its canonical form ([domain-model.md](domain-model.md) §6.8) and not yet verified. A bundle is named. **No credential and no MFA are supplied by the maker**| Profile created. **It grants nothing** — no session may be issued against it| `VALIDATION_FAILED`, `WORK_EMAIL_IN_USE`|
| `PENDING_APPROVAL → ACTIVE`| **Senior Ops or Platform Admin** (§30.8)| **Approver ≠ creator** (§11.6, `MSC-DEC-135`). **Platform Admin required where the named bundle is privileged**| Bundle takes effect. A **`SetupGrant`** is issued to the verified work email. **Sign-in is not yet possible** — the identity is operationally `ACTIVE` and not authentication-ready| `SELF_APPROVAL_FORBIDDEN`, `INSUFFICIENT_AUTHORITY`|
| `PENDING_APPROVAL → REJECTED`| **Senior Ops or Platform Admin** — **a Platform Admin where the named bundle is privileged**| Approver ≠ creator. **Reason mandatory**: a `reason_code` of the staff-profile-rejection domain ([domain-model.md](domain-model.md) §3.9)| Terminal. The record stays queryable (§36.1) and **its work email is released** for a new profile| `SELF_APPROVAL_FORBIDDEN`, `INSUFFICIENT_AUTHORITY`, `REASON_REQUIRED`, `REASON_NOT_ACTIVE`|
| `ACTIVE → SUSPENDED`| **Hub Senior Ops** for Ops Staff · **Platform Admin required** where the target holds a privileged bundle (§30.9)| Reason cites one of §30.9's **four grounds categories**| **Every session terminates** with `SUSPENDED` (§13). In-progress queue items become unavailable to them| `REASON_REQUIRED`, `INSUFFICIENT_AUTHORITY`|
| `SUSPENDED → ACTIVE`| **Hub Senior Ops** · **Platform Admin** where the target holds a privileged bundle| Reason mandatory| Sessions are **not** restored — the principal signs in afresh| `REASON_REQUIRED`, `INSUFFICIENT_AUTHORITY`|
| `ACTIVE → OFFBOARDED` · `SUSPENDED → OFFBOARDED`| **Hub Senior Ops** · **Platform Admin** where the target holds a privileged bundle| Reason mandatory| §30.10: access and credentials revoked **immediately**, every session terminated, all history preserved and never deleted, any motorcycle through §30.7's formal transfer| `REASON_REQUIRED`, `INSUFFICIENT_AUTHORITY`|

**Rejection takes the approval's tier, and the work email goes back to the pool** (Product decision, 6 October 2026). A profile whose named bundle is privileged is rejected, as it is approved, only by a Platform Admin other than the maker: a Senior Ops caller is `INSUFFICIENT_AUTHORITY` and an Ops Staff caller `PERMISSION_DENIED`. **A `REJECTED` profile releases its work email**: uniqueness holds among identities that are not `REJECTED`, so the address may be used on a new profile.

**Both actor gaps were filled on 26 August by `MSC-DEC-253`**, and the tier comes from §30.9 rather than from §30.8. Suspension is the adjacent act: it already fixes who may remove a person's ability to work, and offboarding removes it permanently. Splitting the two across different authorities would let a Senior Ops suspend a rider indefinitely but not offboard them — a distinction with no operational meaning that invites suspension used as informal termination.

**Offboarding is deliberately not maker-checker**, against the instinct that a terminal transition deserves two parties. **The day it matters most is a security dismissal** — credential misuse, theft, a rider who must lose access now — and a second approver is a delay measured in hours at exactly the moment §30.9's grounds categories say speed is the point. **Onboarding can wait for a checker; revocation cannot.** The control on the way out is that it is reasoned and audited.

**Reactivation restores no session.** A suspended principal's sessions were terminated with `SUSPENDED` (§13); returning them to `ACTIVE` lets them sign in again and does not resurrect what was cut.

**Operational status and authentication readiness are different concerns**. `status` tracks the employee; readiness is **derived** from credential and factor state. An `ACTIVE` identity that has not completed setup grants **zero authenticated access**, and no fake intermediate business status was introduced to model that — the two axes are simply not the same axis.

**The MFA circularity is gone.** This machine previously required `mfa_enrolled` before a privileged bundle could be named, and a new employee could not enrol a factor without authenticating or authenticate without the factor. **The only exit was an administrator setting a boolean**, which is the manual workaround Gate A exists to remove. MFA now gates the privileged **session** (§13), not the assignment.

**The bundle is assigned at creation and approved with the profile.** `role_bundle_id` is non-null on `StaffIdentity`, so a profile cannot exist without one; the §30.8 checker therefore approves the person *and* their authority in a single act. **Changing it afterwards is a separate act with its own maker-checker** — `MSC-DEC-248`, `PROPOSED` — because §30.8 reaches creation only.

**`PENDING_APPROVAL` grants nothing, and the guard belongs in two places.** The state is not merely "inactive": §13's `→ ACTIVE` session guard already requires an `ACTIVE` principal, so a pending record cannot obtain a session even if a credential were somehow set. Both guards are stated because an implementation that checks only one is the plausible mistake, and it would make an unapproved profile usable.

**This machine is signed** (`MSC-DEC-257`, 26 August 2026; §1.1 lists it among the signed machines). §36 has no staff-lifecycle subsection at all — unlike `VendorOrganization`, which §36.12 describes — so every state name here was derived rather than transcribed, and the signature covers the table as a derivation. Deciding a state set is not signing a transition table.

**`SELF_APPROVAL_FORBIDDEN` is reused, not renamed.** §11.6's same-actor exclusion already had a code — `approveOnePackageException` returns it — and coining a second name for one rule would put two vocabularies on the uniform maker-checker pattern that `MSC-DEC-135` exists to keep singular. Reuse the existing code for the same condition.

**Rider onboarding is the same §30.8 rule and has no machine here** — `OQ-089`. `RiderIdentity.status` carries five values including the §30.6 availability model, and it has a device precondition staff do not. It is `SLICE-009`'s rider half.

## 14. Machines with tables deferred

State sets are fixed from §36; full transition tables follow in Phase 4 with their features. Deferring the tables does not defer the states — these enums are citable now.

**None of these machines is Product-Owner-approved** (§1.1). No slice may reach `READY` against one.

**`RiderCashCustody` was written first when Phase 4 opened**, per `MSC-DEC-199` — see §16. Of the deferred set it is the machine whose absence leaves *money* untracked rather than a workflow unspecified.

**`PaymentAttempt` left this deferred set on 2 September 2026** — tabled at §20.6 with `STATUS_UNKNOWN` added.

**`RiderCashCustody` left this deferred set on 24 August** — written and tabled at §16 with `CashHandover`. `MSC-DEC-199` named it the priority deferred machine because its absence leaves **money** untracked, and `MSC-DEC-229` made that concrete: a `FAILED` delivery stop may be carrying cash with nowhere to record it.

**`VendorStatement`** (§36.11) — `DRAFT` · `ISSUED` · `PAID` · `OVERDUE` · `DISPUTED_LINE_REVIEW` · `ADJUSTED` · `DISPUTE_REJECTED`. Issued Monday 08:00 `Africa/Accra`, due Thursday 08:00, `OVERDUE` immediately at cutoff with no grace period. A disputed line separates for review **without rewriting the issued statement**; an approved correction posts a linked adjustment.

**`VendorOrganization`** (§36.12) — `CREATED_BY_OPS` · `PENDING_SENIOR_OPS_REVIEW` · `ACTIVE` · `REJECTED` · `SUSPENDED` · `TERMINATED`. Transitions out of `SUSPENDED` and into `TERMINATED` were decided at `MSC-DEC-397` (`OQ-033` closed 21 September 2026) and are driven by `suspendVendor`, `reactivateVendor` and `terminateVendor` — **operations that exist for a machine still untabled here**, which is `OQ-132`, owed by `SLICE-008` and closing on a §36.13 signature.

**`AdHocSender`** (§35.2.7, §35.12.10) — `PROVISIONAL` · `REUSABLE`. Added by the §35 reconciliation. A new ad-hoc sender stays provisional and is **not searchable for reuse** until a physical pickup completes successfully. Promotion to a registered vendor is a separate act following the approved onboarding process.

**`VendorAccountAllowance`** (§36.12) — `DISABLED_PREPAYMENT_ONLY` · `ENABLED`. Platform Admin only, both directions, reason mandatory.

**`VendorSuspensionHold`** (§36.12) — `HELD` · `RESUMED` · `AUTHORIZED_EXCEPTION_DISPOSITION`. Resumption or exceptional disposition of held parcels is privileged, reasoned and audited (§35.12.9).

**`SecurityRiskHold` left this deferred set on 26 September 2026** — tabled and signed at §21, closing `OQ-128`.

**Fleet** (§36.14) — `BreakdownIncident`: `REPORTED_PENDING` · `CONFIRMED` · `REJECTED`. `Motorcycle` availability: `AVAILABLE` · `UNAVAILABLE` · `IN_MAINTENANCE` · `PENDING_RETURN_TO_SERVICE`. `ComplianceReview`: `PENDING_SENIOR_OPS_DECISION` · `DECIDED`.

**`RunCustodyHandover` left this deferred set on 23 August** — it is written and signed at §4.1. It was promoted out of turn because `CONFLICT-034` showed a started run had **no exit any available actor could take** while parcels sat in Melarc's custody.

Three §36.12 and §36.14 invariants that are easy to violate and expensive to unpick:

- Operational `ACTIVE` does **not** imply allowance `ENABLED`. They are separate lifecycles with different approvers.
- `OVERDUE` is a **financial** state and does not equal `SUSPENDED`. An overdue vendor keeps booking; §5.3 moves them to prepayment, it does not stop them.
- A rider's breakdown report does **not** make a motorcycle unavailable. Only Senior Ops confirmation does. Compliance expiry likewise creates a pending decision record and "must not silently mutate availability."
- A rider-ID edit is never a substitute for a `RunCustodyHandover` record.

## 15. Questions this document raised

| ID| Question| Type|
|---|---|---|
| `OQ-054`| **CLOSED 16 Aug 2026** by `MSC-DEC-194`. Partial collection is permitted: variance recorded at the stop with a mandatory reason, office flagged in-system, and the hub blind count runs as an independent second check. Applied in §5.| —|
| ~~`OQ-059`~~| **CLOSED 17 August 2026 by `MSC-DEC-201`** — the door wait is **10 minutes**, per-hub configurable as `rider_door_wait_minutes`.| `DECISION_NEEDED`|

## 16. `RiderCashCustody` and `CashHandover`

Governed by §26.2, **§26.3**, §26.5, §36.11. Entities at [domain-model.md](domain-model.md) §6.11. Written 24 August by `MSC-DEC-250`, promoted out of the §14 deferred set under `MSC-DEC-199`.

**Numbered §16 rather than inserted mid-document.** The deferred set at §14 and the questions at §15 have been renumbered once already (v1.7), and three revision histories cite them at their current numbers. **A second renumbering would strand those rows**, so a machine section follows the questions rather than preceding them.

### 16.1 Why this is the priority deferred machine

`MSC-DEC-199` named it first among the deferred set because **its absence leaves money untracked rather than a workflow unspecified**, and `MSC-DEC-229` made that concrete: §12.1.1 records that a `FAILED` delivery stop may be carrying cash, and the only place that cash could go was a machine with no table.

**`payment` has held `payment.read` and nothing else since the catalogue was written.** [permissions.md](permissions.md) §7.1 lists it as read-only and accounts for it by `SLICE-004`. That accounting was honest and it was also **the third time this shape appeared**: `fleet` held `fleet.read` alone and a stranded run had no operator; `permission` held `permission.read` alone and nobody could grant authority. **Here it means no actor can record that a recipient paid cash** — the ordinary outcome of the default payer intent.

### 16.2 Two records, because §26.3 compares three figures

§26.3 requires the system to compare *"expected cash **by parcel/payment**, **rider-declared handover**, and **hub-confirmed receipt**."* Those live at two different grains and cannot share a record:

| Record| Grain| Carries|
|---|---|---|
| `RiderCashCustody`| **One per order with cash due**| The expected amount and what the rider collected|
| `CashHandover`| **One per handover event**| The rider's declared total and the hub's confirmed total|

**`CashHandover` is coined, and registered in [GLOSSARY.md](../registers/GLOSSARY.md).** §26.3 requires the comparison and names no record to hold it — the same gap that produced `HubAssignment` and `Evidence`. Without it, "rider-declared handover" has nowhere to be written down and the comparison §26.3 mandates cannot be performed.

### 16.3 `RiderCashCustody`

States from §36.11 verbatim: `EXPECTED` · `COLLECTED_BY_RIDER` · `HANDED_TO_HUB` · `RECONCILED` · `EXCEPTION_OPEN` · `RESOLVED`. Terminal: `RECONCILED`, `RESOLVED`.

| Transition| Actor| Guard| Effects| Failure code| Signature|
|---|---|---|---|---|---|
| `→ EXPECTED`| System| Order is dispatch-ready with a **recipient cash amount due**. Created at dispatch, not at the door| The workday now has an open cash obligation| —| —|
| `EXPECTED → COLLECTED_BY_RIDER`| **Rider**, assigned stop| **A physical cash tender is taken** against a payable `OperationalPaymentDemand` — `OPEN` or `PARTIALLY_SETTLED` with remaining due — and either no provider attempt is unresolved or a valid Ops fallback grant is quoted. **The tender may be short of, equal to or over the remaining due**.| **A `PaymentReceipt` (`method = CASH`) is written at the tendered amount and linked to this custody record**; `collected_minor` becomes that amount. A later cash tender on the same order writes a further linked receipt and **increments `collected_minor` without changing state**. **The delivery gate is not satisfied here** — it opens only when the demand reaches `SETTLED` on cumulative principal across every method. The workday stays financially open| `NOT_ASSIGNED_RIDER`, `FALLBACK_REQUIRES_AUTHORIZATION`, `PAYMENT_ALREADY_SETTLED`, `PAYMENT_COLLECTION_NOT_ALLOWED`| **AMENDED · RE-SIGNED — `MSC-DEC-366`**|
| `COLLECTED_BY_RIDER → HANDED_TO_HUB`| **Hub Ops**, on accepting the count| **The hub has recorded and accepted its physical count** on a `CashHandover` naming this record — **not merely that a handover is `OPEN`**. A rider declaring a total is not a hub receiving money| **Physical custody of the hub-counted amount has transferred to the hub**, and `custody_transferred_at` is stamped on the parent `CashHandover`. **The financial outcome follows separately** — clean reconciliation or an open rider variance, per the parent handover. A variance does not return the money to the rider| `HUB_SCOPE_VIOLATION`, `STATE_CONFLICT`| **AMENDED · RE-SIGNED — `MSC-DEC-366`**|
| `HANDED_TO_HUB → RECONCILED`| System| The parent `CashHandover` reached `CONFIRMED` — which now requires **the hub count to equal the system-derived expected total**, not merely the rider's declaration| Terminal. This order's cash is closed. **Gross cash collected is unchanged by any road expense**| —| **AMENDED · RE-SIGNED — `MSC-DEC-366`**|
| `HANDED_TO_HUB → EXCEPTION_OPEN`| System| The parent `CashHandover` reached `VARIANCE_OPEN`| **Physical custody has already passed to the hub** — the hub holds what it counted. What stays open is the **financial** obligation: **the run cannot be financially closed** (§26.3)| —| —|
| `EXCEPTION_OPEN → RESOLVED`| **Hub Senior Ops**| Variance dispositioned with a **mandatory reason**| Terminal. The disposition is recorded, never a silent adjustment| `REASON_REQUIRED`, `INSUFFICIENT_AUTHORITY`| —|

**Three rows are amended and all three are now re-signed** — Product Owner, 4 September 2026, `MSC-DEC-366`.

**Custody accumulates by receipt**. A recipient who hands over **GH₵50** against **GH₵55** has paid GH₵50: a `CASH` receipt of GH₵50 exists, this record holds **GH₵50** in `COLLECTED_BY_RIDER`, **no demand line settles**, GH₵5 remains due, and handover stays blocked. A second tender of **GH₵5** — cash, or the remainder by Hubtel or Merchant MoMo — is a second receipt; where it is cash, the same custody record rises to **GH₵55** and both receipt facts survive. **Nothing is invented and nothing is lost**: `collected_minor` is always the sum of the confirmed `CASH` receipts linked to the record, and a digital remainder creates no custody at all.

**Its effect contradicted its own trigger until this pass.** The row fired on the hub accepting a physical count and then said *"custody passes to the hub on the handover's confirmation, not here"* — the precise rule `MSC-DEC-344` reversed. **For a variance handover it was worse than stale**: confirmation never comes, so the cash the hub had counted and put in its safe stayed attributed to the rider indefinitely.

**Custody moves when the hub accepts, not when the rider declares** *(Gate C R1.2, `MSC-DEC-344`)*. The signed guard read *an open `CashHandover` names this custody record* — so between a rider opening a handover and a hub counting it, **the record said the hub held money nobody had counted**. The two events are minutes or hours apart, and the second is the one that transfers anything.

**`EXPECTED` is created at dispatch and not at the door**, which is the difference between a system that knows what it is owed and one that only knows what it received. §26.3 compares *expected* against collected; an expectation created at collection time is not a comparison, it is a transcription. **This is the same reasoning as the hub blind count** — a figure generated by the party being checked cannot check them.

**Collection alone satisfies nothing, and closes nothing.** §36.11 is precise: *"Recipient cash satisfies the gate only after the rider records collection, but the run/workday remains financially open until hub reconciliation or an exception."* Under `MSC-DEC-362` the first half is read through the demand: cash recorded here is a receipt that funds the `OperationalPaymentDemand`, and **the gate is the demand reaching `SETTLED`** — which a full tender reaches at once and a short tender reaches only when the remainder arrives. The second half is unchanged: two obligations with different lifetimes over one amount, and treating collection as the end of it is the plausible mistake.

**`COLLECTED_BY_RIDER` is reachable from a `FAILED` stop.** §12.1.1: money moves, then the OTP fails, and `MSC-DEC-229` holds the payment rather than refunding at the door. **The custody record does not care why the stop ended** — it tracks the money, and the money is with the rider either way. An implementation that creates cash custody only on `DELIVERED` loses exactly the cash that is hardest to account for.

### 16.4 `CashHandover`

States: `OPEN` · `CONFIRMED` · `VARIANCE_OPEN` · `CLOSED`. Terminal: `CLOSED`.

| Transition| Actor| Guard| Effects| Failure code| Signature|
|---|---|---|---|---|---|
| `→ OPEN`| **Rider**| At the **responsible hub** (§26.3), after the run or before workday close. Rider states a **declared total** and names the custody records| **No cash has moved, and the expectation is derived here**. The server selects the **eligible** `COLLECTION_CASH` expenses — `APPROVED`, this rider, this run or operational period, **not already applied** — **binds** each by setting `applied_to_cash_handover_id` and `applied_at`, snapshots `applied_expense_minor`, and derives **`system_expected_minor` = `gross_cash_minor` − `applied_expense_minor`**. **The opened handover already knows what it expects**| `HUB_SCOPE_VIOLATION`, `ROAD_EXPENSE_ALREADY_APPLIED`| **AMENDED · RE-SIGNED — `MSC-DEC-366`**|
| `OPEN → CONFIRMED`| **Hub Ops**, not the rider| Hub records its **confirmed total**, and **`system_expected_minor` = `declared_total_minor` = `confirmed_total_minor`** — all three| **`custody_transferred_at` is set and the hub's daily position rises by `confirmed_total_minor`**. Every named `RiderCashCustody` → `RECONCILED`. **No expense is applied here** — application happened at opening, and this row only compares against the figure it produced| `NOT_ASSIGNED_RIDER`, `CASH_HANDOVER_VARIANCE`| **AMENDED · RE-SIGNED — `MSC-DEC-366`**|
| `OPEN → VARIANCE_OPEN`| **Hub Ops**| **The confirmed total differs from `system_expected_minor`** — whatever the rider declared. **Reason mandatory**| **`custody_transferred_at` is set and the hub's daily position rises by `confirmed_total_minor`** — the hub holds what it counted. Every named record → `EXCEPTION_OPEN`. **The run cannot be financially closed**| `REASON_REQUIRED`| **AMENDED · RE-SIGNED — `MSC-DEC-366`**|
| `VARIANCE_OPEN → CLOSED`| **Hub Senior Ops**| Every child record is `RESOLVED`| Terminal| `INSUFFICIENT_AUTHORITY`| —|
| `CONFIRMED → CLOSED`| System| —| Terminal| —| —|

**`OPEN → CONFIRMED` is amended and now re-signed, and this is the row the R1 audit found** *(amended Gate C R1; re-signed 4 September 2026, `MSC-DEC-366`)*.

The signed guard was *"Hub records its confirmed total, and it equals the declared total"* — **two figures, both supplied by parties who can both be wrong.** Expected **GH₵125**, rider declares **GH₵100**, hub counts **GH₵100**: the two agree, the machine reaches `CONFIRMED` cleanly, and **a GH₵25 shortage leaves no trace at all.**

**The third figure is the one neither party supplies.** `system_expected_minor` is derived — gross cash collected minus applied approved collection-cash road expenses — and a clean confirmation now requires **all three** to agree. A rider under-declaring against a correct system figure produces a variance **and** a disclosure, and both are worth keeping.

**Variance is measured against the system figure**, not against the declaration. Measuring it against what the rider said would let the rider set the target they are then measured against.

**Application moved to `→ OPEN` at C1, and the ordering is the whole point.** The signed row applied expenses on `OPEN → CONFIRMED`, one transition **after** the hub counts. `system_expected_minor` is what the count is compared against, so computing it at confirmation means **the expectation is derived from the same event that tests it**. Approval makes an expense eligible; **opening** binds it; the hub then counts against a number that already exists.

**The clean row did not set `custody_transferred_at` until Gate C R1.2**, while this paragraph and the domain model both said it did. **A rule stated in prose beside a table that contradicts it is not a rule** — an implementer reads the row. The variance row carried the stamp because R1.1 was written to defend the variance case, and the ordinary case was left to the sentence about it.

**Physical custody is not conditional on financial agreement**. The hub records a count and **accepts that cash** in both outcomes: `CONFIRMED` and `VARIANCE_OPEN` each set `custody_transferred_at`, and each raises the hub's daily position by **`confirmed_total_minor`**. **A variance says what the rider owes. It does not say where the money is.** Leaving custody with a rider who has physically handed over GH₵100 puts the money in a safe, on a record that says someone else has it — and it is the money most worth tracking, because a variance is open against it.

**The hub confirms, never the rider.** §26.3 names *"hub-confirmed receipt"* as a distinct figure from *"rider-declared handover"*. One actor supplying both makes the comparison meaningless — the identical structure as the §22.4 blind count, and the reason `submitHubHandover` and `submitBlindCount` are separate operations.

**The hub's count is deliberately *not* blind** (`MSC-DEC-254`, closing `OQ-092`). `declared_total_minor` is visible to the confirming officer — no schema omission, unlike `HubIntakePreCount`.

**Separation of actors survives; independence of the second figure does not.** `payment.cash.confirm` is held by no rider bundle, the variance path is unchanged, and `payment.cash.received` carries **both** totals so a clean handover stays distinguishable from a corrected one. What is given up is that a confirming officer who wants to agree can agree.

**The case that carried it.** A rider handing over cash stands at the counter, and an honest miscount resolves in seconds when both parties see the figure. Blind, every arithmetic slip becomes a `VARIANCE_OPEN` that holds the run and needs Senior Ops — **friction on a flow that runs every day for every rider, to catch a rare fault.**

**And unlike parcels, cash stays countable.** §22.4's blind count has no second chance: the parcels are mixed into the hub the moment they are received. Cash can be recounted by anyone at any point before it is banked, which is why the same argument does not compel the same answer.

**A shortage and an overage are one state, deliberately.** §26.5 requires Version 1 to distinguish cash *"short, or over"*, and both are recorded on the record as a signed variance. **They are not separate states** because both produce the identical obligation: the run cannot close, and a Senior Ops disposition is required. Two states would double the transition table and change nothing about what anyone does.

**Variance thresholds are not modelled** — §26.3 assigns *"variance thresholds and escalation"* to downstream design. **Any** difference opens the exception here. A threshold that tolerates small shortages is a policy nobody has set, and defaulting it to zero is the conservative reading rather than an invention.


**No new error code was added for this machine, and one near miss is worth recording.** The first draft of the two handover rows used `WRONG_HUB` — **a code withdrawn on 21 August for duplicating `HUB_SCOPE_VIOLATION`**, which is the very mistake [errors-and-enums.md](errors-and-enums.md) §5.7 exists to prevent recurring.  Every refusal here reuses an existing code.

**Over-collection is not refused at the door, and that follows from §26.5 rather than from a new rule.** §26.5 requires Version 1 to distinguish cash *"short, **or over**"* — so an excess is a **variance to be reconciled**, not a transaction to be blocked. A rider holding more than expected still hands it over; the difference surfaces at `CashHandover`. **Under-collection is no longer refused either** *(Gate C C1.9)*: a short tender is preserved as a `CASH` receipt and as custody of exactly what was taken, settles no demand line, and leaves the remainder due — the same atomic engine every method runs. What survives of the asymmetry is at the **demand**: an excess against the total becomes a `FinancialAdjustmentRequired`, a shortfall keeps handover blocked.

### 16.5 What this machine does not do

**It does not close the run.** §26.3 says the run *"cannot be financially closed until the amount is reconciled or an explicit shortage/overage exception is opened"* — a guard on run closure, which `DeliveryRun` §12 will carry when `SLICE-004` writes it. **Recorded here because the obligation is stated in §26.3 and belongs to a machine that does not yet enforce it.**

**It does not handle mobile money.** §26.4 makes the backend authoritative for mobile-money success and `PaymentAttempt` (§14) owns that lifecycle. Cash custody exists precisely because cash has no provider to confirm it.

**It is signed, it was amended, and the amendment is signed too.** `MSC-DEC-257` signed this machine on **26 August 2026**; Gate C amended three rows, and `MSC-DEC-366` **re-signed them on 4 September 2026** — §1.1 carries the position and this section defers to it.

**What remains unsettled is not the signature but the downstream design.** `EXCEPTION_OPEN`'s actor, the `VARIANCE_OPEN` reason categories, and the cutoff for "before workday close" are all §26.3 downstream-design items. **The signature bars no slice**: the amended rows were re-signed at `MSC-DEC-366`, and §1.1 carries the position.

## 17. `Evidence`

Governed by §34.7, §39.4. Entity at [domain-model.md](domain-model.md) §3.6. Written 24 August by `MSC-DEC-251`.

States: `PENDING_UPLOAD` · `STORED` · `EXPIRED`. Terminal: `STORED`, `EXPIRED`.

**This is a storage lifecycle, not a business one**, and it is the only machine here that carries no product policy. §36 describes no evidence states because there are none to approve — §34.7 defines the *record* and §39.4 assigns *upload initiation, validation and lifecycle* to the contract. It is modelled here rather than left implicit because **the difference between a declared record and a stored one is load-bearing**, and a field with no transitions invites an implementation that treats the two alike.

| Transition| Actor| Guard| Effects| Failure code| Signature|
|---|---|---|---|---|---|
| `→ PENDING_UPLOAD`| The actor performing the owning act| Holds that act's write permission (`x-permission: owner`). Metadata complete; `captured_at` not in the future| Record created. **It may not be referenced by anything**| `VALIDATION_FAILED`, `NOT_FOUND`| **AMENDED · RE-SIGNED — `MSC-DEC-438`**|
| `PENDING_UPLOAD → STORED`| Same actor| The stored object's **content type, byte size and checksum match what was declared**| Referenceable from `evidence_ids`. `uploaded_at` set| `VALIDATION_FAILED`, `EVIDENCE_UPLOAD_EXPIRED`| —|
| `PENDING_UPLOAD → EXPIRED`| System| The upload instruction's `expires_at` passed with no completion| Terminal. **The record is retained, not deleted** — §35.1.5, and an abandoned capture is itself a fact| —| —|

**Validation happens on the transition, not on the client's word.** §39.4 requires the contract to define validation, and a client reporting success proves nothing. The three declared facts are re-checked against the object that actually arrived.

**`EXPIRED` is retained rather than deleted, which will look like clutter.** A rider who captured a damage photo and never got signal has a record of having tried, and §35.1.5 preserves historical records generally. Deletion is retention policy — `OQ-028` — and not this machine's business.


## 18. `MfaFactor`

Governed by §37.2, §11.2. Entity at [domain-model.md](domain-model.md) §6.8. Written 26 August by `MSC-DEC-262`.


States: `PENDING` · `ACTIVE` · `REVOKED`. Terminal: `REVOKED`.

**Why this machine exists.** §37.2 requires MFA before privileged access and the contract carried a **boolean** as the evidence. A boolean can be set by a seed, a migration or an administrator; it is a claim that a factor exists rather than a factor. This machine makes the claim checkable.

| Transition| Actor| Guard| Effects| Failure code|
|---|---|---|---|---|
| `→ PENDING` *(ordinary privileged onboarding)*| The staff member| A valid **`STAFF_CREDENTIAL_SETUP`** grant is consumed at `completeStaffCredentialSetup`; identity is `ACTIVE` and the password is established| A `PENDING` factor is created, a TOTP secret provisioned, and an **`MFA_ENROLMENT`** continuation grant issued. **Grants nothing yet**| `SETUP_GRANT_INVALID`|
| `→ PENDING` *(bootstrap)*| The bootstrap administrator| A valid **`BOOTSTRAP_SETUP`** grant is consumed at password establishment| Same effects, from the provisioning-channel secret. **If the continuation grant later expires unused, `MSC-DEC-272`'s provisioning-only mechanism issues a fresh `MFA_REENROLMENT` — the consumed bootstrap secret is never restored or reused**| `SETUP_GRANT_INVALID`|
| `→ PENDING` *(re-enrolment after reset)*| The staff member| A valid **`MFA_REENROLMENT`** grant is consumed at `beginMfaReenrolment`| Any unusable `PENDING` factor is superseded; a new `PENDING` factor and secret are created and an **`MFA_ENROLMENT`** continuation grant issued| `SETUP_GRANT_INVALID`|
| `PENDING → ACTIVE`| The staff member| **A generated code is successfully proven** against a valid **`MFA_ENROLMENT`** grant — the *only* purpose that can activate. Any previously `ACTIVE` factor is revoked| The identity becomes authentication-ready **if every other requirement is met**. The continuation grant is consumed| `MFA_PROOF_INVALID`, `SETUP_GRANT_INVALID`|
| `PENDING → REVOKED`| System or Platform Admin| Enrolment abandoned or superseded| Terminal. **No active or usable factor exists; the revoked factor record is retained as history**| —|
| `ACTIVE → REVOKED`| **Platform Admin** holding `staff.mfa.reset`, or the system on re-enrolment| **Mandatory reason** where administrative: a `reason_code` of the MFA-reset domain ([domain-model.md](domain-model.md) §3.9). **The actor is not the target, and the target is a privileged identity holding an `ACTIVE` factor**| **Every session for the owner terminates** with `MFA_RESET`. A re-enrolment `SetupGrant` is issued. **Enhanced audit**| `REASON_REQUIRED`, `REASON_NOT_ACTIVE`, `INSUFFICIENT_AUTHORITY`, `SELF_APPROVAL_FORBIDDEN`, `STATE_CONFLICT`|

**Three creating purposes, one activating purpose.** The table listed `MFA_ENROLMENT` among the grants that *create* a `PENDING` factor and omitted `STAFF_CREDENTIAL_SETUP` entirely — so ordinary privileged onboarding, the commonest path in the product, had **no row**, and the continuation grant appeared to authorise both halves of its own issuance. Corrected by R1.1 to match the API lifecycle exactly:

| Grant consumed| At| Result|
|---|---|---|
| `STAFF_CREDENTIAL_SETUP`| `completeStaffCredentialSetup`| `PENDING` factor + `MFA_ENROLMENT` continuation grant|
| `BOOTSTRAP_SETUP`| `completeStaffCredentialSetup`| Same|
| `MFA_REENROLMENT`| `beginMfaReenrolment`| Same|
| **`MFA_ENROLMENT`**| `completeMfaEnrolment`| **`PENDING → ACTIVE`**, and only this one|

**There is no `BOOTSTRAP_SETUP → ACTIVE` transition, and the contract accepted one until R1.2.** `completeMfaEnrolment` advertised *"an `MFA_ENROLMENT` or `BOOTSTRAP_SETUP` grant"*. That would have made the **one grant with no expiry** capable of activating a factor at any later date — a deployment-channel secret becomes a standing key to privileged access, and the property that makes bootstrap safe is precisely that its secret dies at password establishment.

**`mfa_enrolled` is never caller-settable.** It is derived from the factor; a boolean a client can set is the defect this machine replaced.

**No grant both creates and activates a factor.** Creation is authorised by whoever may start the enrolment; activation requires a **proven code**, which only the holder of the authenticator can supply. Collapsing the two would let an administrative reset produce an `ACTIVE` factor nobody had demonstrated possession of.

**`PENDING` is not MFA.** A factor counts only once a code has been proven, so an abandoned enrolment never becomes evidence. This is the difference between the record and the boolean it replaces.

**Reset is not recovery, and the separation is the whole control**. Password recovery leaves the factor untouched. If it did not, an attacker holding a compromised work email would have turned *"password and MFA"* into *"control of the email account"* — and the email is the password-recovery channel. **There are no backup codes, bypass codes or support overrides**, because each would be a weaker secret that silently defeats the stronger one.

**A Platform Admin cannot turn MFA off.** Reset revokes and re-issues; it does not produce an identity that can hold a privileged session without a factor.

**What `resetStaffMfa` refuses** (Product decision, 6 October 2026). A Platform Admin **cannot reset their own factor** (`SELF_APPROVAL_FORBIDDEN`). A target whose factor is only `PENDING` has no `ACTIVE` factor to revoke, and a non-privileged identity has no MFA at all: both are `STATE_CONFLICT`. **The other bootstrap administrator is a valid actor**, as is any other Platform Admin. The consequence for a stranded bootstrap administrator is an open question ([credential-recovery.md](../features/identity/credential-recovery.md) §5.6).

## 19. `SetupGrant`

Governed by §37.2, §37.5. Entity at [domain-model.md](domain-model.md) §6.8. Written 26 August by `MSC-DEC-259`, `MSC-DEC-260` and `MSC-DEC-265`.


States: `PENDING` · `CONSUMED` · `EXPIRED` · `SUPERSEDED`. Terminal: `CONSUMED`, `EXPIRED`, `SUPERSEDED`.

**Why this machine exists.** Every first credential in the product — staff password, rider PIN, vendor shared secret, the bootstrap admin's password — had **no path by which its owner could establish it**. The alternative in practice is an administrator choosing someone else's permanent credential, which makes it not a credential.

| Transition| Actor| Guard| Effects| Failure code|
|---|---|---|---|---|
| `→ PENDING`| System, or the authorising actor for an administrative reset| A principal exists and needs the named purpose| Random token issued, **stored hashed**, and **delivered by the transport its purpose fixes** — see the delivery table below. Any `PENDING` grant of the same purpose is superseded| —|
| `PENDING → CONSUMED`| The principal| Token matches, not expired, purpose matches the act attempted| The act proceeds once. Terminal| `SETUP_GRANT_INVALID`|
| `PENDING → EXPIRED`| System| `expires_at` passed. **Never fires for `BOOTSTRAP_SETUP`**, which has none| Terminal| —|
| `PENDING → SUPERSEDED`| System| A newer grant of the same purpose was issued| Terminal| —|

**A grant is not a session, and this is the rule most worth stating.** It authorises **one act of one purpose on one principal** and confers no business authority whatever. A grant that could be presented as a session credential would be an unaudited authentication path around every control above it.

### 19.1 Delivery is purpose-specific

**The machine previously stated one universal rule — every grant "delivered to the principal's registered channel."** That is false for several purposes, and **the table above is the authority on which** — a count restated in prose drifts the moment a purpose is added or withdrawn, as this sentence did. **`BOOTSTRAP_SETUP` does not go to a registered channel — not because the principal is missing, but because first-administrator setup must not depend on ordinary user-controlled or verified application delivery.** The two seeded `StaffIdentity` records exist; what they do not yet have is a verified work email, and trusting an unverified one would let whoever provisioned the environment nominate where the highest-authority credential in the system is sent. The `MFA_ENROLMENT` continuation grant is returned *inside* the transaction that issued it and is not a fresh invitation to anything. And a rider's enrolment grant is displayed as a QR code on an officer's screen, because the ceremony is in person and the rider has no registered channel that could carry a credential this sensitive.

| Purpose| Delivered by| Why|
|---|---|---|
| `STAFF_CREDENTIAL_SETUP`| The staff member's **verified work email** (§37.2)| Unverified means no channel, and therefore no onboarding|
| `VENDOR_CREDENTIAL_SETUP`| The credential's **`delivery_channel`** — `PHONE` or `EMAIL`, to the registered phone or email| **Chosen at approval** by the approver and stored on the `VendorCredential` ([domain-model.md](domain-model.md) §6.8), never supplied in the request. It is also the channel a vendor's recovery link goes by|
| `MFA_REENROLMENT`| **Two authorised origins, two transports.** Ordinary administrative reset → the affected staff principal's **verified work email**. **Bootstrap resume under `MSC-DEC-272`** → the **controlled provisioning channel**| It is a privileged recovery authorising **beginning** re-enrolment only. **Transport differs; purpose does not** — the act authorised is identical, and a second purpose invented for a second delivery route would fragment the enum without adding a rule|
| `BOOTSTRAP_SETUP`| The **controlled provisioning channel**| **The bootstrap `StaffIdentity` already exists after seed.** The provisioning channel is used because **first-administrator setup must not depend on ordinary user-controlled or verified application delivery** — there is no verified work email yet, and trusting one would let whoever provisioned the environment nominate where the highest-authority credential in the system is sent|
| `MFA_ENROLMENT`| **Returned directly in the response** that created the `PENDING` factor| A continuation credential inside a live transaction, not a new setup invitation. Emailing it would create a second, mailbox-reachable path to activating a factor|
| `RIDER_DEVICE_ENROLMENT`| **QR / deep link on the Ops Portal screen**, scanned by the rider in person| The rider's own handset must receive it, and the officer must not transcribe it|
| `RIDER_DEVICE_REREGISTRATION`| Same QR handoff| One enrolment protocol, not two|
| **`VENDOR_DEVICE_ENROLMENT`**| The account's **registered recovery channel**| **Registering an additional browser is not rotating a credential**, so it uses the channel already proved for the account rather than a fresh ceremony. **The two halves have deliberately different authentication, and conflating them would misread the control.** The grant is **requested** from a browser that is already registered and signed in (`requestAdditionalDeviceGrant`) — an unauthenticated request would let anyone who knows an identifier post an enrolment OTP at its owner. It is **consumed** from the new browser, which is **pre-authentication by necessity** (`completeAdditionalDeviceEnrolment`): that browser holds no device credential and cannot present one, so the principal-bound grant is its whole authority. **The step-up boundary sits on the request, not the consumption**|

**‘Verified work email’ means the address the maker entered and the independent approver accepted** (§30.8, `MSC-DEC-435`). Version 1 has no separate email-verification step, state or message, so *unverified* names no condition an identity can be in: the first row's rationale, *unverified means no channel, and therefore no onboarding*, is read as **an identity that has not been approved has no channel**, and a send that fails is a delivery outcome and never an identity state (`SECURITY_DESIGN.md` §13.9a). The two bootstrap identities are the ones that never passed that approval, which is why `BOOTSTRAP_SETUP` does not use their addresses.

**Purpose answers *what may this credential authorise*; transport answers *how does the authorised principal receive it*.** They are separate questions, and `MFA_REENROLMENT` is the case that proves it: one purpose, two approved origins, two controlled transports, **one authorised act**.

**`SetupGrant` does not handle recovery of an existing credential** (R1.3). Replacing a password or shared secret somebody already holds is a `RecoveryRequest`, self-service or Platform-Admin-initiated. `VENDOR_CREDENTIAL_RECOVERY` was withdrawn from this enum for exactly that reason — **a purpose that repaired rather than established did not belong here**, and it left the vendor path naming three different lifecycles for one act.

**The following invariants apply to all eight setup-grant purposes**, including `VENDOR_DEVICE_ENROLMENT`:

- cryptographically strong;
- **purpose-bound** — a grant of one purpose can never authorise another act;
- **principal-bound**;
- **single-use**;
- **hash persisted**, never the raw token;
- expires on its purpose's approved lifetime, `BOOTSTRAP_SETUP` alone excepted — and **`CONSUMED`, `SUPERSEDED` and `EXPIRED` are terminal**: a later authorisation creates a **new** grant and never resurrects an old one;
- **is never reactivated once consumed** — `BOOTSTRAP_SETUP` in particular is consumed at password establishment, is never used for TOTP activation, and if MFA setup subsequently stalls the resume mechanism issues a **new grant of a different purpose** rather than resurrecting it;
- may be **superseded** by a newer grant of the same purpose, or **consumed**.

**Delivery transport is purpose-specific; the lifecycle is not.** That separation is what lets one machine govern every purpose in the table above without a universal delivery claim that would be wrong for some of them.

**Where a registered channel *is* the transport, the destination is resolved from the principal's record and never from the request** — the rule `RecoveryRequest` already carries, and the reason a setup link cannot be redirected by whoever triggers it.

**The 30-minute lifetime is `recovery_link_ttl_minutes` reused, not a new figure**. A second security-link interval would be a value nobody approved, which must not be invented during implementation.

**`BOOTSTRAP_SETUP` has no expiry, alone among the purposes**. A clock here can strand provisioning into an environment nobody can sign into, and the seed only runs on an empty staff table — so the window it opens is bounded by the deployment, not by time. **It is principal-bound to one of the two seeded bootstrap `StaffIdentity` records, single-use, consumed at permanent-password establishment, never reactivated, and never usable for MFA activation.**

**`BOOTSTRAP_SETUP` is consumed at password establishment, not at the end of the workflow**. The prior sequencing consumed it after TOTP proof while the contract required a grant at **both** steps — so a **single-use** grant would have had to be presented twice. A separate short-lived `MFA_ENROLMENT` continuation grant carries the second step.

**That continuation grant may expire where the bootstrap secret may not**, and the asymmetry is deliberate rather than an oversight: if it lapses, the identity still holds an established password and a `PENDING` factor, and a fresh grant re-enters the flow. **The unrecoverable state the no-expiry rule exists to prevent is not reachable from there.**

**`MFA_REENROLMENT` never activates a factor.** It authorises *beginning* re-enrolment — provisioning material out, `MFA_ENROLMENT` continuation grant issued — and only that second grant with a **proven** code activates anything. One grant doing both would let a reset authorisation stand in for possession of the new authenticator.

---

## 20. Operational machines

`MSC-DEC-314`, `MSC-DEC-319`, `MSC-DEC-321`, `MSC-DEC-322`, `MSC-DEC-323`. Three new persistent entities carry a lifecycle, and two more joined them. **All five are signed by `MSC-DEC-366`, 4 September 2026.**

**§36.13 requires a Product Owner signature per machine, and Gate C's original approval did not include one** — the Product Owner approved the operational rules, and a state-machine signature is a separate act with a separate scope, and inventing one here would be exactly the fabrication the programme has refused throughout. **These machines were drafted so the work was reviewable, and while they were unsigned they were correctly reported as a Gate C closure dependency.** **That dependency was satisfied on 4 September 2026 by `MSC-DEC-366`, and they are not a current Gate C signature blocker.**

### 20.1 `RoadExpense` — **SIGNED — `MSC-DEC-366`**

Three states. The transition that matters is the one a Rider may not perform.

| From| To| Actor| Guard| Effect|
|---|---|---|---|---|
| —| `CLAIMED`| Rider *(`payment.road_expense.record`)* · Ops| Category, amount, funding source present; evidence where the category requires it| The expense exists. **It does not yet reduce anything**|
| `CLAIMED`| `APPROVED`| Senior Ops *(`payment.road_expense.approve`)*| Approver ≠ the Rider who claimed it| **Eligible for its authorised treatment. Nothing is deducted yet**|
| `CLAIMED`| `REJECTED`| Senior Ops *(`payment.road_expense.approve`)*| **Mandatory reason**| The cash remains owed|

**`APPROVED` is not a deduction.** The expected cash handover falls only when the expense is **applied** to one specific handover — `applied_to_cash_handover_id` set, once, at handover preparation. **Approval and application are different events and only the second moves money**, which is also what makes the one-time rule enforceable: a deduction taken at approval has **no handover to be unique against**.

**Application is an immutable reference, not a fourth state.** `APPLIED` would answer *has this been used* and not *by which handover*, and a reconciliation being audited needs the second.

**`CLAIMED` is terminal for the cash calculation until someone decides.** `MSC-DEC-319` treats unresolved as not-approved, so a claim that is never actioned leaves the rider accountable — otherwise the control is bypassed by not deciding.

**There is no path from `REJECTED` back to `CLAIMED`.** A rejected expense that is genuinely valid is re-raised as a new claim with its own evidence, so the rejection stays visible rather than being edited away.

### 20.2 `HubCashReconciliation` — **SIGNED — `MSC-DEC-366`**

| From| To| Actor| Guard| Effect|
|---|---|---|---|---|
| —| `OPEN`| System, at first accepted handover of the business date| One row per `hub_id` + `business_date`| **`expected_minor` accrues `confirmed_total_minor` from every handover the hub has physically accepted** — `CONFIRMED` and `VARIANCE_OPEN` alike. The hub holds what it counted|
| `OPEN`| `COUNTED`| Hub staff *(`payment.cash.reconcile_hub`)*| A physical count is recorded| `counted_minor` set; `variance_minor` computed|
| `COUNTED`| `RECONCILED`| Hub staff *(`payment.cash.reconcile_hub`)*| **`variance_minor = 0`**| The day's hub position closes|
| `COUNTED`| `VARIANCE_OPEN`| System| **`variance_minor ≠ 0`**| Mandatory reason; the variance workflow opens|
| `VARIANCE_OPEN`| `RECONCILED`| Senior Ops *(`payment.variance.resolve`)*| Disposition recorded with a reason| **`expected_minor` is unchanged.** The variance is resolved, not erased|

**A rider's variance is not a hub's shortage**. Expected **125**, counted and accepted **100**: the hub's position rises by **100** — never 0, never 125 — and the rider's **−25** stays open against the rider. Accruing only clean handovers would leave the hub short against its own safe, which is the one discrepancy nobody could explain.

**`RECONCILED` is reachable from `VARIANCE_OPEN` and the variance stays on the record.** A resolution that rewrote the expectation would produce the same terminal state with no evidence anything happened — which is the one action `MSC-DEC-321` forbids.

**Passing `cash_reconciliation_cutoff_time` is not a transition.** An `OPEN` reconciliation past 18:00 is an exception requiring visibility, and a legitimately active run may still be out; the state does not change because a clock did.

### 20.3 `CashDisposition` — **SIGNED — `MSC-DEC-366`**

| From| To| Actor| Guard| Effect|
|---|---|---|---|---|
| —| `RECORDED`| Hub staff or Finance *(`payment.cash.disposition`)*| Amount, method, destination present; **reference mandatory for `BANK_DEPOSIT` and `MERCHANT_MOMO_TRANSFER`**; evidence where the method requires it| Physical cash leaves hub custody for an approved destination. **`payment.cash.disposition_recorded`**, enhanced (MED-14 audit remediation)|

**One state, deliberately.** A disposition is an **event**, not a lifecycle: the money went to the bank or it did not. Modelling `PENDING` would create a state in which cash has left the hub and reached nothing, which is precisely the gap `MSC-DEC-323` closes rather than one it should represent.

**A correction is a new row**, never an edit — the same discipline `MSC-DEC-321` applies to variance.

### 20.5 `Redelivery` — **SIGNED — `MSC-DEC-366`**

`MSC-DEC-350`. States: `SCHEDULED` · `IN_PROGRESS` · `COMPLETED` · `CANCELLED`. Terminal: `COMPLETED`, `CANCELLED`.

| Transition| Actor| Guard| Effects| Failure code| Signature|
|---|---|---|---|---|---|
| `→ SCHEDULED`| **Authorised Ops**| A **qualifying failed physical `DeliveryStop`** exists and the parcel is under controlled hub custody. **Never a `PRE_DISPATCH` or `NEXT_STOP` failure**| **The obligation is created here and nowhere earlier**: destination and service resolved, `applicable_delivery_fee_minor` and `redelivery_fee_minor` **snapshotted**, `payer = RECIPIENT`, `chargeable` derived from the originating reason, a new `DeliveryCommitment` written, recipient and Vendor notified| `INSUFFICIENT_AUTHORITY`, `STOP_NOT_QUALIFYING`, `PARCEL_NOT_IN_HUB_CUSTODY`| —|
| `SCHEDULED → IN_PROGRESS`| System| The parcel joins a new run — **after its own `PRE_DISPATCH` checkpoint clears**| The trip runs the **same three checkpoints**. Not attempts four, five and six| `DISPATCH_NOT_CLEARED`| —|
| `IN_PROGRESS → COMPLETED`| System| The new `DeliveryStop` reached `DELIVERED`| Amount due settled through the ordinary recipient-payment workflow| —| —|
| `IN_PROGRESS → CANCELLED`| **Authorised Ops**| A deliberate decision with a reason — Return, or another disposition| **The snapshots are retained**, not deleted. **For a recipient-caused outcome the charges remain due**; for a **Melarc-caused** cancellation or failure the recipient **is not liable** and the obligations void. Refund treatment is Accounting's| `REASON_REQUIRED`| —|
| `SCHEDULED → CANCELLED`| **Authorised Ops**| **The trip has not entered `IN_PROGRESS`**| **Both obligations become `VOID`** — the new delivery fee and the redelivery fee. **The recipient owes nothing for them.** The scheduled charge records are **retained, never deleted**; `VOID` is a state history keeps. **Where the fees were already paid**, the receipt stands and a **financial-adjustment-required** fact is raised for Accounting — **received money is never left unaccounted for**| `REASON_REQUIRED`| —|

**Cancelling before the trip starts costs the recipient nothing**. Both obligations become `VOID` and the records stay — **a charge that vanishes cannot be audited**, and a billing dispute begins with what the customer was told they owed. **Once `IN_PROGRESS`, a recipient-caused outcome keeps the charges due**; a Melarc-caused one never does.

**Money already received is not reversed here.** The receipt stands, the obligation is void, and the difference becomes a **financial-adjustment-required** fact. **Gate C records it and stops**: cash refund, mobile-money refund or account credit is Accounting & Reporting's decision. What is forbidden is a void obligation with a real payment against it and **no recorded consequence**.

**`chargeable` is derived, never chosen.** Where the originating reason attributes the failure to Melarc — a rider breakdown, a provider outage, an OTP failure that was not the recipient's doing — **both fees are zero**. **Recipient is the payer *when a chargeable obligation exists***, and billing a customer for Melarc's own outage is the exact error that separation prevents.

**Eligibility is not obligation.** A failed physical attempt makes a parcel **eligible**; a parcel can sit at the hub eligible and unscheduled, owing nothing. **Ops scheduling is what creates the charge**, because that is the point at which Melarc commits a rider to another trip.

**No maximum redelivery count exists.** Each further trip needs its own Ops approval, and no Product decision sets a ceiling.

**It is not a Return.** Return-to-vendor is a separate Ops decision under `MSC-DEC-332` with its own fee. **`redelivery_fee_minor` and `flat_return_fee_amount` are separate settings that happen to share an Accra launch value.**


### 20.6 `PaymentAttempt` — **SIGNED — `MSC-DEC-366`**

`MSC-DEC-354`. §36.11's mobile-money attempt, **tabled for the first time**. States: `CREATED` · `PENDING` · **`STATUS_UNKNOWN`** · `SUCCEEDED` · `FAILED` · `EXPIRED` · `CANCELLED` · `REVERSED`.

**One attempt collects one `OperationalPaymentDemand`** — its **frozen lines** and **its remaining due**, in one provider request. **`SUCCEEDED` records that the provider moved money; it does not mean the demand is `SETTLED`**.

**Terminal closure states:** `FAILED` · `EXPIRED` · `CANCELLED` · `REVERSED`.

**`SUCCEEDED` is immutable provider payment truth and is not terminal in the graph** — the one transition out of it is the controlled `SUCCEEDED → REVERSED`, which records a provider reversal as a linked fact rather than unmaking the payment. **`SUCCEEDED → PENDING` and `SUCCEEDED → FAILED` do not exist**: money that the provider confirmed does not become unconfirmed because a later message says otherwise.

**It leaves the deferred set** (§14) and is no longer a state list. **`STATUS_UNKNOWN` is added to §36.11's seven**; the state set here is current.

| Transition| Actor| Guard| Effects| Failure code| Signature|
|---|---|---|---|---|---|
| `→ CREATED`| **Assigned Rider or authorised Ops** *(`payment.momo.collect`)*| **An `OperationalPaymentDemand` the actor is authorised for**, payable with `remaining_due_minor > 0` — **`OPEN` or `PARTIALLY_SETTLED`**, never `SETTLED` or `VOID`; **no other unresolved attempt exists against that demand**.| **The server freezes the demand — its line composition, its **remaining due** as this attempt's `principal_amount_minor`, the payer number — and a unique immutable `client_reference`.** `frozen_at` is set on the demand. **The demand's own total is preserved and never overwritten.** A demand of GH₵55 with GH₵50 already confirmed creates an attempt for **GH₵5**; asking for the total again would take GH₵105 for a GH₵55 delivery. Nothing has been sent| `PAYMENT_ALREADY_PENDING`, `PAYMENT_COLLECTION_NOT_ALLOWED`, `PAYMENT_ALREADY_SETTLED`| —|
| `CREATED → PENDING`| System *(adapter)*| **The provider accepted the request** and a prompt is outstanding| **This is an acknowledgement, not a payment**. `provider_initiated_at` set; `expires_at` where the provider gives one| `PAYMENT_PROVIDER_UNAVAILABLE`| —|
| `CREATED → FAILED`| System *(adapter)*| **Melarc knows nothing happened**: the request was **not transmitted**, or the provider **rejected it synchronously before creating a payment request**. **No customer debit could have occurred**| **Terminal and safe.** The demand is payable again; an ordinary retry or fallback becomes eligible immediately| `PAYMENT_PROVIDER_UNAVAILABLE`| —|
| `CREATED → STATUS_UNKNOWN`| System| **The request was transmitted and no answer arrived** — timeout, dropped connection, or a transient error where creation **may** have occurred. **Distinct from the row above**: there, nothing happened; here, we cannot tell| **No retry and no ordinary fallback**. Reconciliation owns it from here| —| —|
| `PENDING → STATUS_UNKNOWN`| System| The callback never came and the status query is unavailable or inconclusive| Same| —| —|
| `PENDING → SUCCEEDED`| System *(trusted service)*| **Authoritative provider confirmation, verified server-to-server**: the reference resolves to **this** attempt, the confirmed principal is trustworthy, the currency and context are valid, and callback or status-query authentication passed. **It does NOT require the confirmed principal to equal the demand's total**| **The canonical success effect below.** One `PaymentReceipt` at **the amount that actually arrived**; counted as **confirmed digital**, never rider cash. **Whether the demand settles is a separate question, answered by the cumulative principal**| —| —|
| `STATUS_UNKNOWN → SUCCEEDED`| System *(trusted service)*| The same verification, arriving late. **Also without an amount match**| **Late money is never discarded.** The same success effect. If the demand was settled by a fallback meanwhile, **both receipts stand**, the demand stays settled **once**, and a `FinancialAdjustmentRequired` records the excess. **Any `ACTIVE` fallback grant on this attempt becomes `SUPERSEDED`**| —| —|
| `STATUS_UNKNOWN → FAILED` / `EXPIRED`| System *(trusted service)*| **The provider authoritatively reports** final failure or expiry| The demand is payable again and a fresh attempt becomes eligible| —| —|
| `PENDING → FAILED`| System| Provider reports final failure| Payable again; retry eligible| —| —|
| `PENDING → EXPIRED`| System| **The provider expires the request**| Payable again; retry eligible| —| —|
| `CREATED`/`PENDING` → `CANCELLED`| **Authorised Ops**| **Only where the provider authoritatively supports cancellation** and no payment completed. **Never from `STATUS_UNKNOWN`**| No receipt; the demand is payable again and retry is eligible. **`CANCELLED` means the payer cannot subsequently be debited under normal provider behaviour** — not that Melarc stopped polling| `PAYMENT_STATUS_UNKNOWN`| —|
| `SUCCEEDED → REVERSED`| System, on a **controlled linked event**| §36.11's reversal path| The receipt survives, marked `REVERSED_BY_PROVIDER`; the reversal is a separate linked fact| —| —|

**The canonical `SUCCEEDED` effect**. Reaching `SUCCEEDED` is not *mark the obligation paid*. It is, in order:

1. **Provider success is verified** server-to-server — a callback alone is a hint, not proof.
2. **Exactly one `PaymentReceipt` is created or reused**, keyed by `source_key`. The same success delivered three times produces **one** receipt.
3. **The demand's cumulative confirmed principal is recomputed** across **every** receipt against it — not just this one.
4. **If and only if the cumulative principal has reached the frozen total, settlement fires atomically**: every frozen line is allocated its exact `principal_due_minor` in one act, drawing on the contributing receipts in `confirmed_at` order. **Below the total, nothing is allocated at all.**
5. **Line and demand settlement are derived** from those allocations. Nobody sets `SETTLED` by hand.
6. **Any `ACTIVE` fallback grant on this attempt or demand is re-evaluated** and superseded where its condition has gone.
7. **Audit and domain events are emitted** against the receipt and the demand.

**A mismatch does not falsely settle the demand, and it does not unmake the payment either.** Where the confirmed principal is **short** of the total, the receipt stands at what arrived, **no line is settled**, the demand records `PARTIALLY_SETTLED` — *partially funded*, with identical line states to `OPEN` — handover stays blocked, and **nothing is allocated**. **No allocation priority exists**: not delivery-fee-first, not redelivery-fee-first, not pro rata. **Further receipts accumulate**, and the next collection asks for the **remaining** due, never the total again. Where the cumulative principal **exceeds** the total, the lines settle for exactly their amounts and the excess becomes a `FinancialAdjustmentRequired`; **it is never allocated onto unrelated lines or orders.**

**`PAYMENT_AMOUNT_MISMATCH` describes the settlement, never the provider.** It is the operational exception a short payment raises and the reason handover is blocked — **it does not deny that money arrived and does not prevent the receipt from being created**. Using it to refuse the receipt would delete a real payment because it was the wrong size.

**`STATUS_UNKNOWN` is the state this machine exists for.** The other seven describe outcomes; this one describes **Melarc's ignorance**, and ignorance is the condition under which a second GH₵55 gets taken from a customer who already paid.

**A timeout is not a failure.** Money moves at the provider, on the customer's handset, seconds before Melarc's connection drops. **Recording that as `FAILED` invites the retry that debits them twice** — so the retry is refused, the operator is told *checking payment status, do not request payment again*, and a callback, a status query or the reconciliation job resolves it.

**An acknowledgement is not a payment.** `CREATED → PENDING` means the provider took the request. **It does not mean money arrived**, and no `2xx`, provider reference or delivered push may reach `SUCCEEDED` on its own.

**One unresolved attempt per demand.** A new attempt needs the previous one **safely terminal** — `FAILED`, `EXPIRED` or `CANCELLED` — **or `SUCCEEDED` with the demand still short**: a GH₵50 success against GH₵55 is resolved provider truth, and the GH₵5 attempt that follows it is the ordinary next collection, not a retry. **`STATUS_UNKNOWN` is not safe**, which is the point of separating it from `FAILED`.

**The fallback through an unresolved attempt is a consumable grant, not a note.** Merchant MoMo and cash are refused outright while an attempt is `CREATED`, `PENDING` or `STATUS_UNKNOWN`; the one way through is an Ops `PaymentFallbackAuthorization`, **method-bound, demand-bound and spent exactly once** by the receipt that uses it.

**Terminal truth does not regress.** A stale `PENDING` arriving after `SUCCEEDED` is discarded; the only transition out of `SUCCEEDED` is the controlled reversal.

**Cancellation is a provider capability, not a Melarc convenience.** Where the live product cannot cancel authoritatively, **this transition is not offered** — calling something cancelled because Melarc stopped watching it is how a customer gets debited by a request nobody is expecting any more. **Whether Hubtel supports it is unverified**.

**The definite-failure path matters as much as the unknown one.** A provider that rejects a request before transmitting it tells Melarc something exact: **nobody was debited**. Recording that as unknown would block a retry that is entirely safe, and would leave a customer standing at a door while an operator waits for a reconciliation job to resolve a request that never existed.

**No human declares a payment result.**

| Who| May set|
|---|---|
| **Trusted service / provider reconciliation only**| `PENDING` · `STATUS_UNKNOWN` · `SUCCEEDED` · `FAILED` · `EXPIRED` · `REVERSED`|
| **Authorised Ops**| **`CANCELLED` only**, and only where the provider supports it safely. Nothing else|
| **Rider**| **Nothing.** A Rider initiates and reads; a Rider sets no state|

**Ops cannot declare provider success, provider failure, or an amount**. The machine gives no actor that option, which is stronger than a permission that merely nobody holds.


### 20.7 Four records, and why none of them is a machine

`MSC-DEC-358`, `MSC-DEC-360`. §36.13 asks the Product Owner to sign **product-semantic lifecycles**. A status column is not a lifecycle, and drafting a table for one adds a signature that certifies nothing.

| Record| Determination|
|---|---|
| **`PaymentReceipt`**| **No machine.** It is an **immutable fact** from creation: money confirmed received through one method. Its only further state is `REVERSED_BY_PROVIDER`, and that is not an actor's decision or a guarded transition — it is a **linked provider event** already tabled above as `SUCCEEDED → REVERSED`. Tabling it separately would model the same provider act twice, in two documents, with two signatures|
| **`PaymentAllocation`**| **No machine.** It has **no states at all**. It is the immutable result relationship settlement writes — receipt, line, amount, timestamp. There is nothing an actor decides, nothing to guard, and no second state to move to|
| **`PaymentFallbackAuthorization`**| **No machine — re-assessed at C1.7, not carried.** States: `ACTIVE` · `CONSUMED` · **`SUPERSEDED`**. **No transition after creation is any actor's decision.** Consumption is the arithmetic consequence of a fallback receipt being written; supersession is the arithmetic consequence of the attempt resolving or the demand settling. **Both are observed, neither is chosen**, and a table of transitions nobody takes certifies nothing a Product Owner could sign. **There is deliberately no `REVOKED`**: an Ops officer withdrawing a grant they issued *would* be an actor decision and *would* need a machine, and no approved rule asks for one. **C1.7 removed the `EXPIRED` state rather than defining it** — it had no duration, so nothing could enter or test it, and inventing a window would have been a Product-policy time limit nobody requested. The **creation** is the Product-semantic act and is already governed: authorised Ops only, mandatory reason, explicit duplicate-risk acknowledgement, its own permission and its own operation|
| **`AccountingExport`**| **No machine**. States: `REQUESTED` · `GENERATED` · `FAILED`. **No transition after creation is any actor's decision** — generation is the arithmetic consequence of the job succeeding and failure of it not. The Product-semantic act is the **request**: who may export, over what scope, and only over a closed period. That is governed by `payment.ledger.export`, by `requestAccountingExport`'s preconditions and by the final-period rule, none of which a transition table would add to. **A retry is a new record, never a transition** — so there is deliberately no `REGENERATING` state and no path back to `REQUESTED`|

**If any of the four later acquires an actor-decided transition — a revoked grant, a receipt an operator may void — it acquires a machine and a signature with it.** The determination is recorded here so that a later reader can see it was made rather than skipped, **and it was re-made at C1.7 after the grant's own lifecycle changed** rather than assumed to still hold.

**The grant's validity is evaluated at the moment of use, not read from its stored status**. Six conditions must hold together: `ACTIVE`; the referenced attempt still unresolved in an allowed state; the demand neither `SETTLED` nor `VOID`; the method matching the fallback being taken; not already consumed; and naming the demand being settled. **A grant issued against *we cannot tell* must not still authorise a full payment once the provider has told us.**

**C1.6 therefore added no signature action.** It restated the current rows of **one machine that was then unsigned**, §20.6, and signed nothing; `PaymentAttempt` §20.6 has been **signed by `MSC-DEC-366`** since 4 September 2026.

### 20.4 What these machines do not do

**They create no accounting entry.** `RECONCILED` and `RECORDED` are operational custody facts. Journal treatment, ledger accounts, payables and bank reconciliation belong to the future Accounting, Finance & Reporting domain, which consumes these as source events.

**`DeliveryCommitment` has no machine and needs none.** It is append-only: each row is immutable from creation, and supersession is a timestamp rather than a transition. **A breach is detected without one** — `sweep_missed_commitments` reads the current row against delivery outcome and emits `delivery.commitment.breached` (MED-04 audit remediation; [BACKGROUND_JOBS_AND_EVENTS.md](../architecture/BACKGROUND_JOBS_AND_EVENTS.md) §3.5, [audit.md](audit.md) §5.3), so an entity with no transitions still has an automated system that observes it.

## 21. `SecurityRiskHold`

§35.12.8. **SIGNED — Product Owner — 26 September 2026 — `MSC-DEC-414`**, which tabled it out of §14's deferred set and closed `OQ-128`. States: `OPEN` · `CLEARED`. Terminal: `CLEARED`.

**§35.12.8 names this as the fourth of four vendor conditions that *"must not be collapsed into one flag"*** — suspension, `OVERDUE` status, allowance disablement, and security/risk hold. Until this table existed it had a state set, a scope class and a glossary entry, and **no way to be opened or cleared by anyone**.

| Transition| Actor| Guard| Effects| Failure code| Signature|
|---|---|---|---|---|---|
| `→ OPEN`| **Platform Admin** *(`vendor.security_hold.manage`)*| A **mandatory reason**. The vendor organisation exists| **New business stops**: while any hold on the vendor is `OPEN`, `VendorOperationalEligibility.may_create_pickup` and `may_confirm_vendor_paid_order` read **false**. **Work already in flight continues** to delivery and **the vendor login is not blocked**. `restriction_category` **never names the hold**| `PERMISSION_DENIED`, `REASON_REQUIRED`| **SIGNED — `MSC-DEC-414`**|
| `OPEN → CLEARED`| **Platform Admin** *(`vendor.security_hold.manage`)*| A **mandatory reason**| The effect lifts **once no other hold on the vendor is `OPEN`**. **The record is kept**, never deleted| `PERMISSION_DENIED`, `REASON_REQUIRED`, `STATE_CONFLICT`| **SIGNED — `MSC-DEC-414`**|

**Distinct in effect as well as in record.** Suspension blocks the vendor's login and holds every non-terminal work item (§35.12.7). **This stops only new business** — no login block, no held parcels — so a vendor under review is not treated as a suspended one, and §35.12.8's four conditions stay four in what the vendor experiences as well as in the model.

**Holds may coexist, and each keeps its own reason.** Two separate security concerns are two records, not one reason rewritten; the effect applies while **any** is `OPEN`, so clearing one does not lift a restriction another still justifies.

**The vendor never sees it.** [data-scope-registry.md](data-scope-registry.md) §4.3 denies the vendor its own row, and the eligibility projection answers *may this vendor book today* without disclosing that a hold exists, who opened it or why — which is what lets Hub Ops act on the outcome while only all-Hub `vendor.read` holders see the record.
