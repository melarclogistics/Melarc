# Audit

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 1.49 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** the audit-event structure, the event-code grammar and catalogue, coverage obligations, and the enhanced-audit set
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../PROJECT_MASTER_SPECIFICATION.md) §38, §35.1.6, §37.1

## 1. Scope and why this is a contract

`MSC-DEC-193` fixed the boundary: **`standards/` owns how well something is built; `contracts/` owns what shape it must be.** "Every privileged override emits an audit event with this structure" is a shape.

Three drafted contracts already bind to §38 as a structural authority: [domain-model.md](domain-model.md) §3.8 requires a before/after audit event on every privileged override, [permissions.md](permissions.md) §7 grants `audit.log.read` and `audit.log.export`, and §37.1 requires "tamper-evident audit history for privileged, financial, identity, recovery, and device/session actions." Without this document those citations point at nothing.

**Covered:** event structure, code grammar, the event catalogue for the proving slice, coverage obligations, enhanced audit, timeline visibility, and retention governance.

**Not covered, and named so nobody assumes otherwise.** §38.7 lists these as still requiring approval or design, and this document does not supply them:

- Exact retention period per data category — `OQ-028`, needs legal input
- Whether any records are immutable or WORM-protected
- Export and legal-hold procedural mechanics
- Redaction and privacy handling
- Tamper-detection and integrity-verification mechanics
- Archival performance and restore expectations

The *policy* underneath several of those **is** confirmed and appears in §8 below. What is missing is mechanics, not authority.

## 2. Principles

From §38.1, and each has a structural consequence:

| Principle| Consequence|
|---|---|
| An audit record describes **who did what, to which business object, when, from which authorized context, and with what result**| The five are mandatory fields, not a description of intent|
| History is **append-oriented** and cannot be silently rewritten by normal users| No update or delete operation exists on an audit event. A correction is a new event referencing the earlier one|
| Business-event history and security audit may be **stored differently**, but both must be queryable for authorized investigation| A split store is permitted; a split that makes one unqueryable is not|
| Human-readable timelines are generated from **stable event codes and snapshots**, not from mutable current labels| A timeline rendered from today's reason labels misrepresents what the actor saw. Labels are snapshotted (domain model §3.7)|
| **Failed and denied** privileged attempts may also require security logging| A rejected action is an event. Auditing only successes hides exactly the attempts worth seeing|

The fourth is the one most often lost. A timeline that joins to the live `ReasonCode` table will silently rewrite history the first time a reason is renamed.

### 2.1 Append-only is a control. It was never tamper evidence

`MSC-DEC-283`. The second principle above is enforced structurally: no `UPDATE` or `DELETE` grant exists on `AuditEvent` for any runtime role ([SOLUTION_ARCHITECTURE.md](../architecture/SOLUTION_ARCHITECTURE.md) §8, [data-scope-registry.md](data-scope-registry.md) §4.5). **That is a strong control against the application and says nothing about a credential holder** — and this ledger exists precisely to describe the actions of people the system trusts. **A control administered by the party it constrains is not evidence.**

An independent layer therefore sits above it:

```
AuditEvent / audit outbox  ->  periodic signed checkpoint  ->  independently protected immutable / WORM storage
```

A checkpoint carries **canonical event identifiers and hashes**, an **ordered batch manifest**, **the previous checkpoint's reference and hash**, and a **KMS-backed signature or MAC**. **It is cut every 15 minutes** — `audit_integrity_checkpoint_interval_minutes`.

| Tampering| Detected by|
|---|---|
| An event was **modified**| Its hash no longer matches the manifest|
| An event was **deleted**| The manifest names an identifier the store no longer holds|
| An event was **inserted** into history| The batch it claims to belong to hashes to a different manifest|
| A **checkpoint** was removed or replaced| The next checkpoint's previous-hash reference does not resolve|
| A checkpoint was **forged**| The KMS signature does not verify|

**The previous-checkpoint link is the row that earns the design.** Per-event hashing detects a changed event. Only a chain detects an event that is simply *absent* — deletion leaves nothing behind to compare against, which is what makes it the tampering worth doing.

**The mechanism is tamper-*evident*, not tamper-proof.** It detects modification, deletion and insertion after the fact and proves the detection with a KMS signature. **It does not prevent a sufficiently privileged infrastructure actor from destroying both stores**, and this document does not claim otherwise.

**The rejected alternative is named deliberately.** A synchronous hash chain written across every business transaction would serialise the whole product on a single lock, to defend against a threat this deployment has no evidence of. §42.8's availability target is company-wide, and a global write lock is the most reliable way to miss it. **The mirror is asynchronous and must be monitored** — an unmonitored asynchronous mirror is an absent control, so its failure alerts ([OBSERVABILITY_AND_RECOVERY.md](../architecture/OBSERVABILITY_AND_RECOVERY.md) §3).

**Operational logs and traces are not this ledger** (§9). A split store is permitted by the third principle above; a split that lets telemetry be *mistaken* for the ledger is not.

## 3. Event structure

§38.2's eleven fields, as a schema. "As applicable" in §38.2 governs which fields a given event populates — not whether the field exists.

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no| Stable event ID|
| `event_code`| text| no| Stable code per §4. Never a free string|
| `occurred_at`| timestamptz| no| When the business act happened|
| `recorded_at`| timestamptz| no| When it was persisted. **Distinct** — rider events sync hours later (§35.3.9)|
| `actor_type`| enum| no| `STAFF`, `RIDER`, `VENDOR_ACCOUNT`, `SYSTEM`|
| `actor_id`| uuid| yes| Null for `SYSTEM`|
| `actor_bundle`| text| yes| The bundle held at the time, snapshotted — bundles are editable|
| `surface_context`| enum| no| `OPS_PORTAL`, `VENDOR_PWA`, `RIDER_ANDROID`, `SYSTEM`|
| `device_context`| jsonb| yes| Registered rider device where applicable|
| `vendor_organization_id`| uuid| yes| Ownership context (§38.2)|
| `responsible_hub_id`| uuid| yes| Hub context — §39.7 requires audit events to carry it|
| `object_type` / `object_id`| enum + uuid| no| The affected business object|
| `correlation_id`| text| no| Request or idempotency identifier. Links a replay to its original|
| `previous_state` / `resulting_state`| text| yes| Both, where the event is a transition|
| `reason_code`| text| yes| With its label snapshotted, per §2|
| `note`| text| yes||
| `approval_id`| uuid| yes| Maker-checker reference|
| `before_after`| jsonb| yes| Values or a safe diff. **Mandatory for every privileged override** (§35.1.6)|
| `related_ids`| jsonb| yes| Run, stop, pickup, intake, order, payment, settlement, file|
| `outcome`| enum| no| `SUCCEEDED`, `REJECTED`, `FAILED`, `REPLAYED`, `RECONCILED`|
| `enhanced`| bool| no| True for every §6 category. Drives retention and export treatment|

**`outcome` carries `REPLAYED` deliberately.** An idempotent retry is not a second business act, and recording it as `SUCCEEDED` would inflate every count derived from the log. It is also the only way to tell a genuine duplicate from a replay after the fact.

**`actor_bundle` is snapshotted, not joined.** Bundles are editable configuration (§11.1). Resolving an actor's authority at read time would show today's bundle against yesterday's action.

## 4. Event-code grammar

```
<domain>.<object>.<past-tense-verb>
```

`domain` is the **same closed seventeen-item list** as [permissions.md](permissions.md) §4. One vocabulary, shared with the permission catalogue.

The verb is **past tense**, which distinguishes an event from a permission at a glance: `pickup.request.confirm` is a capability someone holds; `pickup.request.confirmed` is a thing that happened. Adding a domain requires a Product Owner decision, exactly as for permissions.

A rejected attempt uses the same code with `outcome = REJECTED` rather than a separate `*.rejected` code — otherwise every event has a shadow twin and the catalogue doubles for no gain.

## 5. Event catalogue — proving slice

§38.3 names the required event domains. Enumerated here for pickup through itemization; later slices extend this table as they reach `READY`.

### 5.1 `pickup`

| Code| Emitted when|
|---|---|
| `pickup.request.created`| Request created in `PENDING`|
| `pickup.request.confirmed`| Confirmed and manifest-eligible|
| `pickup.request.declined`| Declined with reason|
| `pickup.request.cancelled`| Cancelled free of charge — vendor self-service or office, pre-assignment. Carries `cancelled_by_actor_type` and the replacement link where rescheduled|
| `pickup.request.cancelled_chargeable`| Office cancellation after rider assignment. Carries the charge **outcome** — `APPLIED`, `WAIVED`, `NOT_APPLIED`, `UNAVAILABLE` or `EXEMPT` — and the mandatory charge reason. Emitted for all five outcomes, because the charge is discretionary and its absence is a decision. **`EXEMPT` records a `MELARC`-attributed reason, where no charge was permitted** — and it is the event that makes *how often Melarc cancels on its own failure* measurable, which folding it into `NOT_APPLIED` would have hidden inside ordinary Ops discretion|
| `pickup.cancellation_charge.waived`| Senior Ops waived an applied charge. **Enhanced** — carries actor and reason. Waiver frequency is the control `MSC-DEC-197` relies on, and it is only measurable if each waiver is its own event|
| `pickup.handshake.fallback_sms`| Handshake escalated to SMS on the registered number|
| `pickup.handshake.fallback_override`| Ops-verified handshake override. **Enhanced** — a recorded exception|
| `pickup.manifest.rider_assigned`| Rider assigned. **The moment vendor self-cancellation closes** on every request the manifest carries|
| `pickup.exception.requested`| One-package exception raised (maker)|
| `pickup.exception.approved`| Approved by a holder of `pickup.exception.approve` — **Senior Ops, Platform Admin, or Ops Staff explicitly granted it**. Records **which actor and which key**, not a role. **Enhanced**|
| `fleet.custody.initiated`| A `RunCustodyHandover` was opened on an `IN_PROGRESS` run. **Enhanced** — custody movement is a chain-of-custody event (§38.3)|
| `fleet.custody.accepted`| The receiving party took custody, with the parcel count they recorded. **Enhanced**|
| `fleet.custody.failed`| The named receiver did not take custody; it stays with the original rider|
| `pickup.sender.saved`| An ad-hoc sender record was created at booking. §21.7 requires it and no code carried it until 23 August|
| `pickup.sender.promoted`| An `AdHocSender` moved `PROVISIONAL → REUSABLE` after a physical pickup completed successfully (§35.2.7, §35.12.10). **A state change with money and identity behind it** — the record becomes searchable for reuse only here — and §38 requires state changes to be auditable|
| `pickup.attempt.extended`| Force-extension past `MELARC_MAX_PICKUP_ATTEMPTS`. **Enhanced**|
| `pickup.request.escalated`| `escalatePickupRequest` moved a failed request out of the Ops decision context — `REFUSED_COLLECTION`, an exhausted attempt chain, or the scheduled backstop after `stale_failure_backstop_hours`. Carries `trigger` — the actor, or `BACKSTOP`. **Enhanced** — a manual state override under §38.5 category 2, the same category `pickup.attempt.extended` above sits in (CRIT-09 audit remediation)|
| `pickup.manifest.created`| Manifest built with stop membership and order|
| `pickup.manifest.stops_ordered`| `setManifestStopOrder` set the manual stop sequence. Not enhanced — ordering is a routine planning act §21.2 places entirely in Ops discretion, not a maker-checker approval, override or the other seven §38.5 categories (CRIT-09 audit remediation)|
| `pickup.manifest.dispatched`| Made available to the rider — not execution|
| `pickup.manifest.started`| Rider began the run|
| `pickup.manifest.completed`| All stops terminal — **by the custody holder's hub handover, or by System when nothing was collected**|
| `pickup.stop.arrived`| Cancellation window closes here|
| `pickup.stop.collected`| Carries declared and collected counts, and the variance outcome|
| `pickup.stop.partially_collected`| Short collection. Carries the variance reason and the office-flag reference|
| `pickup.stop.failed`| Carries reason, contact attempts, evidence|
| `pickup.stop.skipped`| Authorized skip|
| `pickup.handshake.generated`| Verification code created|
| `pickup.handshake.delivered`| Code dispatched to its channel|
| `pickup.handshake.verified`| Two-party proof complete|
| `pickup.handshake.disputed`||
| `pickup.handshake.manually_resolved`| Senior Ops override after expiry or exhaustion. **Enhanced**|
| `pickup.request.hub_reassigned`| **Enhanced**. Pre-custody move of a request's responsible hub. Carries **previous hub, new hub, the actor, the correlation id and every planning artifact revoked or rebuilt**. **A security-scope change, not an edit** — after it, a different hub's staff can reach the record and the previous hub's cannot, which is exactly what §38.5 category 2 exists to make visible|
| `pickup.service_window.overridden`| Service scheduled or approved outside the customer service window, with the original window, the revision, the reason and the customer notification state| **Enhanced**|
| `pickup.parcel.handling_assessed`| A parcel was assessed `REQUIRES_REVIEW` or `NOT_ACCEPTABLE`, with the mandatory reason||
| `pickup.request.single_package_fee_posted`| The GH₵20 single-package fee became due on acceptance and was posted to the Vendor's account or gated behind prepayment, per eligibility| **Enhanced**|
| `pickup.request.single_package_approved`| A one-package exception was approved — by a holder of the permission rather than by role. **The approved fee becomes due on acceptance**| **Enhanced**|

### 5.2 `hub`

| Code| Emitted when|
|---|---|
| `hub.handover.submitted`| Rider-to-hub transfer recorded — **one event per handover, naming the intakes it opened**, one per collected pickup request|
| `hub.intake.counted`| Blind count committed. **Carries both counts — this is the first moment both may legally appear together**|
| `hub.osd.opened`| Variance, condition or dispute finding raised|
| `hub.osd.resolved`| Senior Ops adjudication. **Enhanced**|
| `hub.intake.itemized`| An order created from the intake|
| `hub.intake.closed`| Parity met|
| `hub.intake.closed_exception`| Closed without parity via the approved exception. **Enhanced**|
| `hub.intake.reopened`| Platform Admin privileged reopen. **Enhanced**|

### 5.3 `dispatch` and `delivery`

§38 requires dispatch and delivery to be auditable. **Neither family existed before `SLICE-002`** — the catalogue was built around pickup and hub work.

| Code| When|
|---|---|
| `dispatch.confirmation.attempted`| A **`PRE_DISPATCH`** recipient-contact attempt **by the assigned Rider or by Ops**, carrying `checkpoint`, `performed_by_actor_type`, the number dialled, outcome and reason. **Every attempt** — §24.2 requires attempts be persisted, *“not kept only in transient UI state”* — and **one event per attempt**: `PRE_DISPATCH` attempts do not also emit `delivery.recipient_contact.recorded`|
| `dispatch.confirmation.confirmed`| The recipient confirmed. The order becomes run-eligible|
| `dispatch.confirmation.escalated`| **Ops judged the contact avenues exhausted**; the order entered the senior decision queue.|
| `dispatch.run.created`| A draft run was opened|
| `dispatch.run.rider_assigned`| A rider was set on the run|
| `dispatch.run.dispatched`| The run was dispatched. **Enhanced** — this is the atomic commit of §24.5|
| `dispatch.run.rollback`| A dispatch attempt failed validation and **every change was rolled back**. **Enhanced**|
| `dispatch.outbound.cleared`| **Ops cleared a paid outbound order for dispatch** — a first clearance, or a re-dispatch after a failed counter or a covered `RETURNED`. Records the order, the clearing officer, whether it was a re-dispatch, and the handoff record opened or reused. **Not `delivery.dispatch.cleared`**, which is the doorstep lane's `PRE_DISPATCH` checkpoint|
| `delivery.stop.arrived`| A rider arrived at a stop — **the `DOORSTEP` checkpoint opens here**|
| `delivery.recipient_contact.recorded`| **A `NEXT_STOP` or `DOORSTEP` recipient-contact attempt was performed** — carries `checkpoint`, actor type, outcome and reason. **The same event for Ops and for a Rider**, because the act is the same act. **`PRE_DISPATCH` attempts are `dispatch.confirmation.attempted`**, carrying the same field set, so one contact act emits exactly one event and a timeline reads across all three checkpoints|
| `delivery.physical_attempt.failed`| **A physical delivery attempt failed** — a stop the rider reached. **Never a `PRE_DISPATCH` or `NEXT_STOP` contact failure.** Creates redelivery **eligibility**, not an obligation|
| `delivery.redelivery.scheduled`| **Authorised Ops scheduled a redelivery** — **the act that creates the charge**. Carries both fee snapshots, the total, `payer = RECIPIENT` and **`chargeable`**, so an audit can answer why one recipient was billed and another was not|
| `delivery.redelivery.completed`| The redelivery trip reached `DELIVERED`|
| `delivery.redelivery.cancelled`| Ops cancelled a scheduled redelivery with a reason. **The snapshots are retained, not deleted**|
| `notification.redelivery.sent`| The recipient was notified of a scheduled redelivery and its amount due; the Vendor was notified that a redelivery is scheduled and **that the recipient is the payer**|
| `payment.demand.created`| **An operational payment demand was frozen** with its lines and total — the exact amount one payer is being asked for|
| `payment.fallback.authorized_while_unresolved`| **Authorised Ops accepted a duplicate-payment risk**: the unresolved attempt, the demand, the chosen method, the mandatory reason and the explicit acknowledgement. **The one event that names who decided a customer might pay twice**|
| `payment.adjustment_required.created`| **Money is owed back** — source demand, source receipt, reason, amount, hub. **Raised once per source condition.** No refund occurs in Gate C|
| `payment.adjustment.resolution_proposed`| **How money owed back is proposed to be resolved** — adjustment, class, method, destination, amount, proposer. **Proposing is not resolving**: nothing moves and the adjustment stays `OPEN`||
| `payment.adjustment.resolution_decided`| **A proposed resolution was approved or rejected** by Finance — decider, outcome, and the reason on a rejection. **Enhanced for the same reason `payment.road_expense.decided` is: approval moves money out.** A rejection is recorded and kept, because how often a resolution is refused is the control| **Enhanced**|
| `payment.ledger.exported`| **A canonical accounting export was generated** — requester, scope, period range, schema version, per-record-type row counts and manifest digest. **The event that says payment facts left the platform.** Enhanced because §38.5 makes enhanced audit mandatory for *"data exports and destructive retention actions"*| **Enhanced**|
| `payment.ledger.export_retrieval_authorized`| **A short-lived retrieval capability was issued** over a generated package — export, requester, expiry. **Named for what Melarc can observe**: the object is fetched from storage under a presigned authorization, so the platform records the capability it issued and never the download that follows. **Calling it `accessed` would certify a fact nobody holds.** The signed URL itself is never logged (§9)| **Enhanced**|
| `payment.receipt.recorded`| **Money Melarc has confirmed receiving**, through one method, against one demand — method, confirmed principal, source key, and the actor or trusted service that confirmed it. **The event that says money arrived**, distinct from the request that asked for it|
| `payment.receipt.allocated`| The confirmed principal was **applied to the demand's frozen lines** — receipt, line, amount. **A redelivery emits two**, one per line, from one receipt|
| `payment.receipt.unallocated_shortfall`| **A confirmed receipt left the demand's cumulative principal short of its total and nothing was allocated** (`MSC-DEC-362` — atomic settlement, which closed `OQ-111`). The demand records `PARTIALLY_SETTLED`, the receipt stands, **no line is settled and no priority exists**; carries the remaining due the next collection will ask for. Emitted for every method — a GH₵50 cash tender against GH₵55 raises it exactly as a GH₵50 Hubtel confirmation does|
| `payment.fallback_authorization.consumed`| **The Ops duplicate-risk grant was spent**, once and finally, by the receipt that used it — grant, method, demand, receipt. **A second attempt to use it is refused**|
| `payment.collection.created`| A collection attempt was created with its frozen obligation, amount and `client_reference`. **Nothing has been sent**|
| `payment.collection.provider_requested`| The request was transmitted to the provider|
| `payment.collection.pending`| The provider accepted it and a prompt is outstanding. **Acceptance is not payment**|
| `payment.collection.status_unknown`| **Transmitted and unanswered** — the outcome is unknown and **no retry is permitted**|
| `payment.collection.succeeded`| **Provider confirmation verified server-to-server.** Carries the confirmed principal|
| `payment.collection.failed`| The provider authoritatively reported failure|
| `payment.collection.expired`| The provider expired the request|
| `payment.collection.reconciled`| A reconciliation pass resolved an unknown or long-pending attempt|
| `payment.collection.duplicate_callback`| The same provider event arrived again. **One success effect, however many times it is delivered**|
| `payment.collection.amount_mismatch`| A confirmation did not match the expected principal or currency|
| `payment.collection.fallback_started`| An approved fallback began. **Carries whether an unresolved collection existed**, because that is the duplicate-payment risk|
| `payment.collection.late_success`| **Provider success arrived after Melarc had stopped waiting.** Money that actually arrived is never discarded|
| `payment.collection.overpayment_exception`| More was confirmed than was owed, or a fallback had already settled it. **Recorded for Accounting, never silently absorbed**|
| `delivery.doorstep_wait.started`| **The controlled doorstep wait began.** Carries the server-set `wait_started_at` and `wait_expires_at`|
| `delivery.dispatch.cleared`| A parcel passed its `PRE_DISPATCH` checkpoint and became eligible for a physical load|
| `delivery.dispatch.held`| A parcel was **held at hub** on an unresolved or failed `PRE_DISPATCH` checkpoint|
| `vendor.contact_exception.notified`| **A Vendor was notified of a recipient-contact exception.** Carries the checkpoint, the reason and the notification outcome — **a failed send is recorded, never silently dropped**|
| `delivery.stop.delivered`| Payment settled where due, OTP validated, parcel handed over|
| `delivery.stop.failed`| A delivery attempt failed, carrying **the active Delivery Failure Reason Catalog code selected at the door** and a snapshot of whether it consumed an attempt. The original five are seeded defaults. **Enhanced when a payment was already taken** — see below An **outbound** stop that fails at the counter emits it too, carrying a `HANDOFF_FAILURE` code, and consumes no attempt.|
| `delivery.stop.skipped`| Ops skipped a stop with a reason|
| `delivery.custody.return_declared`| **A rider declared the undelivered parcels coming back to the responsible hub** at the end of a run. Records the run, the rider, the hub and every order named. **Nothing has been received and no custody has moved** — the receipt is `delivery.custody.received`, and the name says so after `OQ-129` R1.1||
| `delivery.custody.received`| **Hub Ops confirmed receipt, and this is where custody transferred** for the lines actually received. Records the receiving officer, **`confirmed_at`**, and each line's outcome| **Enhanced**|
| `delivery.custody.variance_opened`| A named parcel was not present, or a present one was not named, with the mandatory reason and the affected lines| **Enhanced**|
| `delivery.custody.variance_resolved`| Hub Senior Ops dispositioned a missing or undeclared parcel| **Enhanced**|
| `delivery.handoff.recorded`| **The rider handed the parcel to an approved courier or station** — the identity mode and the captured courier, station or approved agent, the waybill reference in the registered mode, the evidence id, the commercial mode and the handing rider. **Enhanced**, on `fleet.custody.initiated`'s reasoning rather than a §38.5 category: custody movement is a chain-of-custody fact, and this is the movement where **custody leaves Melarc entirely**. For a `STATION_DROP` it is also the instant the fee is earned (§24.7.1), so the event that says the parcel left is the same event that says Melarc got paid for taking it there| **Enhanced**|
| `delivery.handoff.outcome_recorded`| **Ops recorded a covered-mode third party's reported outcome** — `IN_TRANSIT`, `DELIVERED`, `FAILED` or `RETURNED` (`MSC-DEC-417`, closing `OQ-135`), with the reason where one is required. **Enhanced**, on `delivery.handoff.recorded`'s reasoning: `DELIVERED` earns the covered charge, and `RETURNED` brings custody back to Melarc| **Enhanced**|
| `delivery.handoff.cancelled`| **System closed a `PENDING_HANDOFF` record** because the order entered Return before any handoff. **The money is not recorded here**: the Return's own adjustment records the unearned outbound charge owed back||
| `delivery.otp.overridden`| **Hub Senior Ops authorised a handover without OTP verification** (§25.1's extraordinary path). Records the actor and reason — **never the OTP**| **Enhanced**|
| `delivery.verification.fallback_requested`| A rider reported an OTP or verification problem at a doorstep and **requested assistance**. The request, not the grant — a rider may raise it and may never approve it||
| `delivery.commitment.created`| The **initial** commitment was written at itemization, carrying the `sla_start_at` read from the pickup-custody lineage. **Distinct from a revision**: this is the promise being made, not changed||
| `order.return.initiated`| **Authorised Ops committed a `ReturnRecord`**. Return processing and the return fee begin **here**, never because an attempt counter reached three| **Enhanced**|
| `order.return.completed`| **`SLICE-006` Pass 1.** Return-fee gate satisfied where applicable, OTP validated against the recorded vendor/sender contact, physical custody closed (§28.4). The completion half of `order.return.initiated`, the same pairing `delivery.stop.arrived`/`delivery.stop.delivered` already uses||
| `delivery.commitment.revised`| A committed delivery date or window changed. Carries **old value, new value, requester, approver and attribution reason**| **Enhanced**|
| `delivery.commitment.breached`| **MED-04 audit remediation.** The current (non-superseded) `DeliveryCommitment`'s `committed_date` — and `committed_window_end` where set — passed with no `delivery.stop.delivered` yet recorded against the order. Raised by `sweep_missed_commitments` ([BACKGROUND_JOBS_AND_EVENTS.md](../architecture/BACKGROUND_JOBS_AND_EVENTS.md) §3.5), **SYSTEM**-actor, once per commitment — the sweep checks for a prior `delivery.commitment.breached` against the same `DeliveryCommitment.id` before emitting, since the row it reads can never itself carry a "already flagged" mark (§6.12's append-only invariant). Carries the commitment id, `order_id`, `committed_date` and `sla_start_at`. **Not enhanced** — a system-detected fact for reporting and the end-of-day review, none of §38.5's eight categories|

**`dispatch.run.rollback` records a non-event, and that is the point.** §24.5 makes dispatch all-or-nothing: if one order's payment gate fails revalidation, *every* change rolls back. Without an event, a rollback leaves no trace at all — the run simply stays `DRAFT` and nobody can tell whether Ops never pressed the button or the system refused. **An atomic operation that fails silently is indistinguishable from one never attempted.**

**`delivery.commitment.breached` is the event that closes MED-04's gap.** `DeliveryCommitment` is append-only by design precisely so a missed promise cannot be quietly overwritten — but nothing before this row ever detected the miss in the first place. `sweep_missed_commitments` is the missing half: it reads, never writes, the current commitment row against whether a successful delivery exists, and this event is its output. **The audit log is the flag**, not a new mutable column on an entity whose entire purpose is that no column may be silently corrected.

**`delivery.stop.failed` is enhanced when money moved.** `MSC-DEC-229`: a rider may take payment and then fail to close the delivery because the OTP will not validate. The stop fails **carrying cash**, and the event is the only record that ties the money to the failed attempt before hub reconciliation sees it.

**`delivery.otp.overridden` belongs on the same dashboard as the handshake fallback ratio.** `MSC-DEC-197` and `MSC-DEC-198` both establish that a discretionary path's only real control is that its **frequency** stays visible, and this is the discretion that lets a parcel leave Melarc's custody without the proof §25.1 calls *"the Product Owner-approved authorization"*. An override used routinely is a fraud control that has stopped existing.

**Gate C reuses `delivery.otp.overridden` rather than adding a second approval code.** `MSC-DEC-326`'s supervised fallback **is** §25.1's extraordinary path with the review steps written down: Ops examines the order, recipient, rider, location, payment state and verification attempts, then authorises. The existing code already records the actor and the reason and already never records the OTP, and a parallel `fallback_approved` code would split one dashboard into two — defeating `MSC-DEC-198`'s control that a discretionary path's **frequency** stays visible.

**What Gate C adds is the half that was missing: the request.** A rider raising a verification problem and an authority granting a bypass are different acts by different parties, and only the second was recorded. Without the first, a fallback that is **refused** leaves no trace at all.

### 5.3a `courier` — the courier register and approved agents

Added 26 September 2026 at `MSC-DEC-417`. **§38.5 category 7 names *“provider changes”***, and a register that decides who may take custody of a parcel is the plainest reading of it — the approved-agent register is the same list for informal carriers. Every event here is **Enhanced**, carries the actor, and carries the mandatory reason where the act requires one.

| Code| When||
|---|---|---|
| `courier.provider.registered`| A courier or station entered the platform-wide register — **`ACTIVE`, and so approved, from that moment**| **Enhanced**|
| `courier.provider.deactivated`| An entry's approval was withdrawn, with the mandatory reason. **Nothing is deleted**; past handoffs keep the entry they used| **Enhanced**|
| `courier.provider.reactivated`| A deactivated entry was restored, with the mandatory reason| **Enhanced**|
| `courier.agent.approved`| **Hub Senior Ops approved an informal driver or agent** at their hub — the agent record, the approving officer, and whether an identity photo was supplied. **Never the photo itself**| **Enhanced**|
| `courier.agent.withdrawn`| An agent's approval was withdrawn, with the mandatory reason. **Nothing is deleted**; past handoffs keep their agent| **Enhanced**|

### 5.4 `auth`

§38 requires authentication and privileged access to be auditable. **No `auth` family existed before `SLICE-000`** — the catalogue was built around the parcel domain.

| Code| When|
|---|---|
| `auth.session.issued`| A session was established. Records principal, device and hub set — **never the token**. **A rider session also records `client_root_signal`** — the app's own root-detection result: a risk signal for Ops follow-up, **never an authentication control**, so `DETECTED` is recorded and refuses nothing|
| `auth.session.failed`| Sign-in, or a second factor, refused — **written for every refusal**. Records the attempted identifier — **the principal's own `id` for one that exists; for an unknown principal a hash and the identifier's kind, never the string as typed**, because an identifier field is where a mistyped password lands — the factor the request had reached (`PASSWORD`, `MFA_CODE`, `SECRET`, `PIN` or `NONE`) and the **cause** — internally, from the closed set `UNKNOWN_PRINCIPAL`, `INELIGIBLE_PRINCIPAL`, `WRONG_PASSWORD`, `WRONG_MFA_CODE`, `WRONG_SECRET`, `WRONG_PIN`, `UNREGISTERED_BROWSER`, `DEVICE_PROOF_INVALID`, `NO_ACTIVE_DEVICE`, `LOCKED_OUT`, `CHALLENGE_EXPIRED`, `CHALLENGE_UNUSABLE` — while the response stays undifferentiated (§37.7). **A wrong second-factor code also writes `auth.mfa.failed`, and a failed device signature also writes `auth.device.proof_failed`, in addition** — the uniform record and the specific one each say their own thing once. **Never the credential, a code or a signature**|
| `auth.session.superseded`| **Vendor only.** A shared vendor credential's session ended because a colleague's newer login displaced it|
| `auth.session.terminated`| Sign-out, expiry, credential change, suspension or admin revocation, with the reason|
| `auth.mfa.completed`| A second factor was accepted during sign-in for a Senior Ops or Platform Admin. **Enhanced**|
| `auth.mfa.failed`| A second factor was rejected at sign-in. **Enhanced.** Written **in addition to** `auth.session.failed`, which records the same refusal for the uniform failure trail|
| `auth.lockout.applied`| A credential's failed-attempt threshold was reached and `locked_until` was set. Records the principal, the factor that tipped it (`PASSWORD`, `MFA_CODE`, `PIN` or `SECRET`) and `locked_until` — **never the attempts' values**. **One event per lock**: the refused attempts inside it are `auth.session.failed` with cause `LOCKED_OUT`|
| `auth.device.registered`| A device was bound to a rider or vendor, with the authorising actor. **Enhanced.** **Never the enrolment credential**: the rider grant is displayed as a QR and is excluded from logs, analytics and audit payloads, exactly as `auth.setup_grant.issued` excludes its token. The event records that a binding happened and who authorised it, never the material that authorised it. **For a rider device it also records the verified attestation summary** — the key's security level, the verified-boot and lock state, the package and the signing certificate's digest fingerprint — **never the certificate chain, the attestation challenge or the grant**; and, on a replacement, the id of the device it replaces|
| `auth.device.revoked`| A device was **explicitly revoked** — loss, theft or a security workflow. **Enhanced.** A replacement is `auth.device.replaced`, not this.|
| `auth.device.replaced`| **A rider's `ACTIVE` device became `REPLACED` because its replacement completed**. **Enhanced.** Names the old and the new device and the authorising Senior Ops, and records that any live session on the old device ended `DEVICE_REPLACED`. Emitted in the same transaction as `auth.device.registered` for the new device, so the two cannot disagree. **Not emitted for a device already `REVOKED`**|
| `auth.device.attestation_failed`| **A rider device enrolment or replacement was refused** because the attestation evidence failed policy (`DEVICE_INTEGRITY_FAILED`) or the handset cannot hold a hardware-backed key (`DEVICE_SECURITY_UNSUPPORTED`). Records the rider, the authorising officer, which of the two outcomes and the **cause class** — **never the certificate chain or the challenge**. **Not enhanced**, like `auth.device.proof_failed`: one refusal is noise and a rate of them is the signal. **Not emitted when the trust data was too stale to evaluate** — that is an operational alert, not a finding about the device|
| `auth.credential.changed`| A password, PIN or vendor secret changed — **never the value**|
| `auth.setup_grant.issued`| A one-time setup grant was issued, with its purpose, principal and the **kind** of channel it was handed to (email, SMS, QR, the response, or the controlled provisioning channel) — **never the token and never the address**|
| `auth.setup_grant.consumed`| A grant was used once and closed|
| `auth.setup_grant.superseded`| A newer grant of the same purpose replaced a pending one|
| `auth.mfa.enrolled`| A TOTP factor was proven and became `ACTIVE`. **Enhanced**|
| `auth.mfa.revoked`| A factor was revoked, by reset or by replacement. **Enhanced**|
| `auth.mfa.reset`| A Platform Admin reset another identity's MFA, with the mandatory reason. **Enhanced**|
| `auth.bootstrap.completed`| **One of the two bootstrap Platform Admins** established a password, **consuming that identity's setup secret at that step**, and proved TOTP against the continuation grant. **Written once per bootstrap identity**, so the pair writes it twice. **Enhanced**|
| `auth.bootstrap.succeeded`| **A bootstrap identity** was offboarded after two proven non-bootstrap successors. **Written once per bootstrap identity retired.** **Enhanced**|
| `auth.device.proof_failed`| A rider device signature failed to verify against the registered public key|
| `auth.session.authority_revoked`| A session was terminated because the principal's authority changed, carrying the reason. **Enhanced**|
| `auth.mfa.reenrolment_begun`| A revoked factor was re-provisioned: a new `PENDING` `MfaFactor` exists and a continuation grant was issued. **Enhanced.** **Distinct from `auth.mfa.enrolled`, which records a *proven* factor** — an investigator must be able to tell an authenticator that was handed out from one that was demonstrated|
| `auth.csrf.rejected`| A cookie-authenticated unsafe request failed synchronizer-token or `Origin` validation. Records route, principal and which check failed — **never the token or its hash**|
| `auth.hub_boundary.crossed`| **A Platform Admin read a record outside the admin's own hub** (§37.3, Product decision of 6 October 2026). **One event per read**, recording the actor, the hub of the record and a reference to the record (`object_type`, `object_id`) — **never the record's contents**. **Enhanced** (§6 category 4); a read changes nothing, so `before_after` stays empty. **A read inside the admin's own hub is not audited**|

**`auth.session.failed` is the one to get right.** The *response* to a failed sign-in must not distinguish an unknown account from a wrong password from a suspended one (§37.7), but the *audit record* must, or nobody can tell a typo from an attack. **The asymmetry is the point**: undifferentiated outward, precise inward.

**One refusal has no cause in that closed set yet.** `MFA_ENROLMENT_REQUIRED` at `completeStaffMfaSignIn` (Product decision, 6 October 2026) is a refusal at the `MFA_CODE` factor with no wrong code behind it, and it counts toward no lockout. Which cause it records is not decided, and none is invented here.

**`auth.session.superseded` is vendor-only**. Its purpose is to let a shared vendor credential distinguish colleague displacement from ordinary expiry — a fact this catalogue, as the canonical home for event shape, must state itself rather than leave to a feature spec's citation. A rider replacing their own session on their own registered device has no colleague to distinguish from; rider session replacement instead emits `auth.session.terminated` with reason `REPLACED_BY_NEW_SESSION`. [rider-authentication.md](../features/identity/rider-authentication.md) §11 records the rider side of this and cited a table that, until this revision, still read *vendor or rider*.

**Gate A added ten, and six of them are enhanced**. §38.5 category 6 covers *"account role, status, or credential administration"*, and MFA enrolment, revocation, reset, both bootstrap events and authority-driven session termination are each exactly that. **`auth.device.proof_failed` is not enhanced and is deliberately present**: a single failure is noise, and a **rate** of failures against one rider is the signal that a registered handset is being attacked.

**Never recorded, in any of these events**: a password, a PIN, a TOTP code, a TOTP seed, a session secret, a device secret or a setup token. §20.4's OTP rule extends to every credential Gate A introduced — the audit records **that** a factor was proven, never **what** proved it.

**Four are enhanced** because they change who can do what: second-factor acceptance, second-factor failure, and both device events. A device binding is the moment a rider's identity becomes usable on a specific handset; an accepted second factor is the moment a privileged session begins.

### 5.5 `pricing` and `order`

| Code| Emitted when|
|---|---|
| `pricing.price.calculated`| Authoritative fee computed at itemization|
| `pricing.price.locked`| Frozen at order confirmation|
| `pricing.correction.requested`| Maker side|
| `pricing.correction.approved`| Checker side. **Enhanced**|
| `pricing.correction.applied`| Linked adjustment posted. §35.6.7 forbids a locked price changing silently, so the event records an adjustment, never a rewrite|
| `pricing.reprice.approved`| Post-freeze repricing on a **service-area or commercial-mode change** (§35.6.8 as amended by `MSC-DEC-207`). **Enhanced**|
| `pricing.size_class.selected`| The receiving officer's size-class judgement at itemization. **Enhanced**|
| `pricing.carrier_cost.captured`| Third-party carrier's actual charge transcribed from their waybill. **Enhanced**|
| `order.delivery_date.overridden`| Ops moved a system-derived delivery date, with reason|
| `order.credit.reserved`| Exposure reserved exactly once, keyed by order|
| `order.payment.required`| Order entered `PAYMENT_REQUIRED`|
| `order.commercial.cleared_no_charge`| The commercial gate was satisfied with **no vendor charge** — the resolved vendor portion was zero. Recorded because the other two exits from `PRICED` are recorded, and an unlogged third would make the gate's outcome unreconstructable|

### 5.6 `staff` and `permission`

Added 24 August by `MSC-DEC-247` and `MSC-DEC-248`. **§38.5 category 6 — "account role, status, or credential administration" — made every one of these mandatory enhanced audit before any of them existed.** The obligation was approved; the events were not written.

| Code| When||
|---|---|---|
| `staff.identity.created`| A staff profile was created in `PENDING_APPROVAL`. Records the **maker** (§30.8). **The bootstrap seed writes it as an enhanced record**, because the seeded identities have no independent checker; `createStaffIdentity` writes it at ordinary level||
| `staff.identity.approved`| The independent approval that makes a staff record usable. Records **both actors**, which is what makes the same-actor exclusion auditable rather than merely enforced| **Enhanced**|
| `staff.identity.rejected`| A pending profile was refused, with reason| **Enhanced**|
| `staff.identity.suspended`| §30.9 suspension, with the grounds category| **Enhanced**|
| `staff.identity.offboarded`| Access and credentials revoked (§30.10). **The authority is `OQ-050`; the event is not**| **Enhanced**|
| `permission.bundle.assign_requested`| A bundle change proposed on an existing record. Maker side *(`MSC-DEC-248`, `PROPOSED`)*||
| `permission.bundle.assigned`| The change took effect. `before_after` carries **both bundles by name**| **Enhanced**|

**Five of these are enhanced and two are not, and the split is deliberate.** **Both exceptions are maker halves.** Creating a profile grants nothing — a `PENDING_APPROVAL` record cannot hold a session ([state-machines.md](state-machines.md) §13.3) — and proposing a bundle change grants nothing either, which is what `PROPOSED` means at `permission.bundle.assign_requested`. **Approval is the moment authority begins**, so that is where `before_after` is required. Recording each maker act at ordinary level and each approval as enhanced makes the *grant* the thing an auditor searches for, rather than burying it among profile edits.

**`staff.identity.approved` carries both actors on purpose.** §30.8's exclusion — "the creator cannot approve their own profile creation" — is enforced at the call, and an enforcement that leaves no record is unfalsifiable afterwards. With `created_by` and `approved_by` both on the event, a reviewer can answer *"did this ever happen?"* by query rather than by trusting that the guard was present in the build that ran.

**Rider onboarding emits nothing here** — `OQ-089`. §30.8 governs rider profiles in the same sentence and `RiderIdentity` has no machine yet, so inventing `staff.rider_identity.*` codes now would name events for transitions that do not exist.

### 5.6b `vendor` — onboarding and account allowance

Added 20 September 2026 at `SLICE-008` Pass 1. **§38.5 category 6 — *"account role, status, or credential administration"* — and category 1, maker-checker approvals, made all but one of these mandatory enhanced audit before any of them existed.** The obligation was approved; the events were not written, because the operations were not either.

| Code| When||
|---|---|---|
| `vendor.organization.created`| A vendor record and its shared portal account were created in `PENDING_SENIOR_OPS_REVIEW`. Records the **maker** (§29.2.1)||
| `vendor.organization.approved`| The independent approval that makes a vendor operational. Records **both actors**, which is what makes §35.12.2's exclusion auditable rather than merely enforced, and the `VENDOR_CREDENTIAL_SETUP` grant it issued — **never the grant token**| **Enhanced**|
| `vendor.organization.rejected`| Operational activation was refused, with the mandatory reason (§29.2.2)| **Enhanced**|
| `vendor.allowance.enabled`| Platform Admin enabled the account allowance, with the mandatory reason. **Records no amount** — the limit is one platform-wide figure and this event moves a flag| **Enhanced**|
| `vendor.allowance.disabled`| Platform Admin disabled it, with the mandatory reason. **`before_after` carries the state either side**, because this is the act that puts a vendor back on prepayment| **Enhanced**|

**Four of five are enhanced and one is not, on the split §5.6 already established.** Creating a vendor record grants nothing — it cannot hold a session, because `VendorCredential.secret` is null until approval issues the setup grant ([domain-model.md](domain-model.md) §6.16). **Approval is the moment standing begins**, so that is where `before_after` is required.

**Two different grants of standing get two different events, deliberately.** Operational activation and the account allowance are separate decisions by separate authorities (§35.12.3), and one event carrying both would make it impossible to answer *"who extended this vendor credit"* without also reading who activated them. **`vendor.organization.approved` never implies `vendor.allowance.enabled`** — the same invariant §36.12 states about the states themselves.

**Reactivation, termination and offboarding emit nothing here** — `OQ-033`. §36.12 sketches `SUSPENDED → ACTIVE` and *"exact reactivation, termination transitions remain follow-up"*, so inventing `vendor.organization.reactivated` now would name an event for a transition that does not exist. The same reasoning §5.6 records for rider onboarding under `OQ-089`, and §5.6a for block reversal.

### 5.6d `vendor` — saved pickup locations

Added 21 September 2026 at `SLICE-008` Pass 3.

| Code| When||
|---|---|---|
| `vendor.pickup_location.created`| A location was saved. Records the actor, which may be **the vendor account or an Ops user** — §29.1 makes this an Ops capability and §29.4 gives the vendor it||
| `vendor.pickup_location.updated`| A label or address changed. **`before_after` carries the address either side**, because a silently corrected address is where a rider gets sent next time||
| `vendor.pickup_location.default_changed`| The default moved. **Names both locations**, the one demoted and the one promoted, because the act clears and sets in one transaction and an event naming only the winner cannot answer *what was it before*||
| `vendor.pickup_location.deactivated`| A location was retired and **retained** (§8). No deletion event exists, because no delete operation does||

**None of these is enhanced, and the omission is reasoned rather than an oversight.** §38.5's
categories are authority, money, custody, evidence, settings, account administration, exports
and manual overrides. **A saved address is none of them**: it confers no authority, moves no
money and holds no custody. Marking it enhanced would dilute the class that exists so an
auditor can find the acts that matter.

**The default move still gets its own code**, because it is the one act here that changes
where a rider is later sent without changing any address.

### 5.6c `vendor` — suspension, reactivation and termination

Added 21 September 2026 at `SLICE-008` Pass 2 and `MSC-DEC-397`. **§35.12.9 requires reactivation and exceptional disposition to be *“privileged, reasoned, and audited”*, and §38.5 category 6 covers the rest.** The obligation was approved before any of these events existed, because no operation performed the acts.

| Code| When||
|---|---|---|
| `vendor.suspension.created`| A vendor was suspended. Carries **one of §29.6's four grounds categories**, the mandatory reason, the actor, and **the count of work items held**| **Enhanced**|
| `vendor.suspension.lifted`| A suspension was lifted and every remaining `HELD` hold moved to `RESUMED`. Carries **both actors** — the suspender and the reactivator — which is what makes the symmetric-or-higher rule auditable rather than merely enforced, and **the count of holds resumed**| **Enhanced**|
| `vendor.held_parcel.decided`| One held item was dispositioned, with the mandatory reason and the hub where it physically is (§29.6, `MSC-DEC-142`)| **Enhanced**|
| `vendor.held_parcel.escalated`| One held item was escalated to a manual claims or security hold by Platform Admin. **Escalates a parcel; creates no vendor-level `SecurityRiskHold`**| **Enhanced**|
| `vendor.organization.terminated`| The relationship ended. Carries the reason and **an assertion that no hold remained `HELD`**. **Records that obligations survive** — it is not a write-off and nothing here closes a balance| **Enhanced**|

**All five are enhanced, and that is the difference from §5.6b.** There is no maker half here: every one of these acts changes standing or custody at the moment it happens, so there is no *“grants nothing”* event to record at ordinary level.

**`vendor.suspension.lifted` carries both actors on purpose**, the same reasoning `staff.identity.approved` records. `MSC-DEC-397`'s rule is that a Platform Admin suspension may be lifted **only** by Platform Admin; an enforcement that leaves no queryable record of who suspended and who lifted is unfalsifiable afterwards.

**Reactivation emits one event for the vendor, not one per parcel.** The holds resume in a single act, so a per-parcel event would record a decision nobody made.

**Nothing here records a return-to-vendor disposition**, because none is reachable — see `openapi.yaml`'s `HeldParcelDisposition`. When §9 is re-signed, that disposition will need its own code.

### 5.6a `vendor` — sender blocking

Added at Gate B R1 by `MSC-DEC-296`. **`MSC-DEC-258` created the authority and no event recorded its use** — the same shape as `OQ-084`, caught here because R1 had to represent the block's reach.

| Event| Recorded when|
|---|---|
| `vendor.pickup_skip.notified`| **A Vendor was notified that an authorised skip left their pickup uncollected**. Carries the vendor, the pickup request, the `PICKUP_STOP_SKIP` reason and the requested vendor action where anything would unblock it — `MSC-DEC-348`'s field set, applied on the pickup side for the first time. **A failed send is recorded, never silently dropped**, and the notice is raised for **every** skip including `VENDOR_REQUESTED_SKIP`, where it records that the request was honoured||
| `vendor.security_hold.opened`| **Platform Admin opened a vendor-level security/risk hold**. Carries the vendor, the actor and the mandatory reason. **Enhanced** — it restricts a customer's ability to do business and its grounds are sensitive by definition| **Enhanced**|
| `vendor.security_hold.cleared`| **Platform Admin cleared a security/risk hold**, with the mandatory reason. Records whether the vendor's restriction lifted — it lifts only once no other hold is open| **Enhanced**|
| `vendor.sender_block.created`| An ad-hoc sender is blocked. Carries the **`scope`** — `HUB_LOCAL` or `PLATFORM_WIDE` — the §29.6 grounds, the mandatory reason, and the hub where the reach is local. **Enhanced when `PLATFORM_WIDE`**: one actor stopping a customer transacting in every hub is account administration under §38.5 category 6, and the control on a discretionary authority is that its use stays visible|

**Reversal is not here**, because reversal is not decided — `OQ-033` still owns it and R1 did not touch it.

### 5.7 `payment` — cash custody

Added 24 August by `MSC-DEC-250`. **§26.3 requires these by name:** *"cash collection, custody, handover, receipt, variance, correction, and closure are **separate auditable events**."* Seven acts, named individually, in an `APPROVED` section — and the `payment` domain had **no event of any kind**.

| Code| Emitted when||
|---|---|---|
| `payment.cash.collected`| A rider recorded a cash tender at the door. Records the order, **the amount actually taken — short, exact or over** — the `CASH` `PaymentReceipt` it created, the `RiderCashCustody` it increased and that record's running `collected_minor`, and the stop outcome — **including where the stop then `FAILED`** (§12.1.1). A short tender is recorded here at what was taken, never refused; whether the demand settled is `payment.receipt.allocated` or `payment.receipt.unallocated_shortfall`, not this event||
| `payment.cash.handover_opened`| A rider declared a total at the responsible hub||
| `payment.cash.custody_accepted`| **The hub physically accepted the counted cash into its custody** — emitted on `CONFIRMED` **and on `VARIANCE_OPEN`**. Carries `confirmed_total_minor`, which is what the hub holds whatever the rider owes. **The event that distinguishes where the money is from who owes what**| **Enhanced**|
| `payment.cash.received`| The hub confirmed receipt. Records **all three** totals — **system expected**, rider declared and hub counted — which is what makes the §26.3 comparison reconstructable. **The third was added at R1**: with two, a rider and a hub agreeing with each other looked like reconciliation||
| `payment.cash.variance_opened`| Confirmed differed from declared, with the reason and the signed difference| **Enhanced**|
| `payment.cash.variance_resolved`| Senior Ops dispositioned a shortage or overage| **Enhanced**|
| `payment.cash.reconciled`| An order's cash closed with no variance||
| `payment.cash.hub_reconciled`| End-of-day Hub cash reconciliation completed. Records expected Hub cash, physical count and the signed difference| **Enhanced**|
| `payment.cash.hub_variance_opened`| The Hub count differed from the expected Hub position. **Distinct from a rider variance** — netting the two would assign a loss to whichever record was reconciled second| **Enhanced**|
| `payment.cash.disposition_recorded`| Physical cash reached an approved destination — amount, method, destination, reference, actor, evidence| **Enhanced**|
| `payment.momo.manually_confirmed`| Merchant MoMo receipt confirmed out of band by an authorised actor. **Records who confirmed it**, because the integrated path records no human at all| **Enhanced**|
| `payment.fallback.used`| A delivery was completed through an approved payment fallback rather than the integrated provider. Carries the method, so persistent fallback use becomes visible||
| `payment.road_expense.created`| A rider recorded an operational expense — category, amount, funding source, evidence||
| `payment.road_expense.decided`| A road expense was approved or rejected. **Enhanced because approval moves money out of a rider's cash accountability**| **Enhanced**|
| `payment.road_expense.applied`| An approved `COLLECTION_CASH` road expense was **applied to a cash handover**, once. Records the expense, the handover and the amount deducted. **The event that makes a second application visible if one is ever attempted**| **Enhanced**|

**Six codes for §26.3's seven acts, and the arithmetic is deliberate.** *Custody* is not an event — it is the interval between collection and handover, and emitting an event for a state that merely persists would log the absence of change. *Correction* is `payment.cash.variance_resolved`: §26.3 lists correction and closure separately, and a variance disposition **is** the correction, with `CONFIRMED → CLOSED` needing no record of its own because `payment.cash.received` already carries it.

**Both totals go on `payment.cash.received`, not one.** An event carrying only the confirmed figure makes a clean handover and a corrected one indistinguishable afterwards. §26.3's whole control is the comparison, so the audit record has to hold both sides of it.

**The two variance codes are enhanced under §38.5 category 3** — "price or financial corrections". A cash variance is money that did not arrive, and its disposition is a financial correction by any reading.

**188 codes, re-derived after `MSC-DEC-427` and `MSC-DEC-428`** — two `auth` events, `auth.device.replaced` (**Enhanced**) and `auth.device.attestation_failed`, so that a replacement stops being recorded as a revocation and a refused enrolment leaves a trace.

**The catalogue listed 99 rows and held 98 codes.** `delivery.stop.failed` was entered twice — once on 21 August with the family, and again on 26 August by `MSC-DEC-252` adding the failure-reason payload, four rows below the entry it was amending. **A duplicate row in an event catalogue is not cosmetic**: this document is the specification an implementation registers its emitters from, and two rows for one code is an instruction to emit it twice or to pick one. Merged, keeping both facts. The second row also carried a trailing empty cell in a two-column table, which is how it survived a reading.

**R1 added the last two.** `auth.mfa.reenrolment_begun` exists because re-provisioning and proving are different facts and only one of them was recorded; `auth.csrf.rejected` because a rejected cross-site write was, until R1, a security refusal that left no trace at all.

**This line read "sixty-six" until 24 August and the true figure was seventy-two** — the third time an audit-code count in this programme has been wrong, after 34-against-36 and 40-against-39. Three of the six missing were `fleet.custody.*`, added by `MSC-DEC-246` **the day before**; `pickup` was two low and `order` one low from earlier edits. **The number was restated rather than derived, and the extraction is now in the line above it.**

**The three `fleet` codes sit inside §5.1 `pickup`, which is where the miscount hid.** §4's grammar draws `domain` from the same closed seventeen-item list as [permissions.md](permissions.md) §4, and every other subsection here is named for the domain it holds. `fleet.custody.initiated` is a `fleet` event living under a `pickup` heading because the run it attaches to is a pickup manifest — defensible, and it is exactly why a reader counting by section heading missed them. Left in place rather than moved: a fourth recount is a worse risk than an odd heading, and the total above is now derived.

**Three of these exist because a human judgement moves money.** `pricing.size_class.selected` is the sharpest: `MSC-DEC-209` established **no weight or dimension thresholds**, so the class is a discretionary call by the receiving officer that changes the fee by up to GH₵30. Without this event a vendor disputing a classification has nothing to dispute against, and two officers grading the same parcel differently is invisible. The event is the entire mitigation for a decision taken deliberately.

`pricing.carrier_cost.captured` is enhanced for the same reason — it is the one monetary figure a client submits, and it is auditable against the carrier's waybill precisely because it is an observation rather than a price.

**`pickup.handshake.verified` carries `channel` on every emission**, not only on fallbacks. `MSC-DEC-198`'s control is that persistent fallback use becomes visible, and a ratio needs both terms — logging only the exceptions makes the denominator unknowable. §38.3 also requires events for delivery, payment, settlement, returns, account, export and fleet; those arrive with their slices.


### 5.8 `settings` — reason catalogues *(Gate C)*

`MSC-DEC-330`. §35.9.1–2 already made reason metadata configuration; this records who changed it.

| Code| Emitted when||
|---|---|---|
| `settings.reason.catalog_changed`| A reason definition was created, edited, activated or deactivated. Records the code, the field changed, the old and new values and the actor| **Enhanced**|

**Enhanced because a reason drives validation.** Flipping `consumes_delivery_attempt` on `OTP_NOT_VERIFIED` silently changes what every future delivery failure costs a customer, and a catalogue change with no actor is the one edit that can rewrite policy without touching a document.

## 6. Enhanced audit

§38.5 makes enhanced audit **mandatory** for eight categories. Each sets `enhanced = true` and requires `before_after` populated:

1. Maker-checker approvals
2. Force extensions and manual state overrides
3. Price or financial corrections
4. Cross-vendor access or impersonation
5. Evidence replacement or removal
6. Account role, status, or credential administration
7. Settings, thresholds, reason lists, service zones and days, and provider changes
8. Data exports and destructive retention actions

Category 8 includes the Auditor's own exports: §38.7 confirms that "every export [is] enhanced-audited per Section 38.5." **The audit function is itself audited**, which is deliberate and must not be optimised away as self-referential noise.

**An enhanced-audit action fails closed**. Where a category above requires synchronous primary audit, an action whose `AuditEvent` cannot be **durably written does not happen** — the transaction does not commit. **The alternative is the failure this table exists to prevent**: a privileged override that succeeded with no record is indistinguishable, afterwards, from one that never occurred, and §35.1.6 makes `before_after` mandatory on exactly those acts. This is an operational block, not a logging fault, and it alerts as one.

Category 4 is the one with no obvious trigger in the slice above, and **a Platform Admin's read of a record outside the admin's own hub is it** (§37.3): a *read* that emits an event, which is unusual enough to state explicitly. **One `auth.hub_boundary.crossed` per such read**, recorded with the actor, the hub and a reference to the record and **no record contents**; reads inside the admin's own hub are not audited (Product decision, 6 October 2026). That decision covers a Platform Admin and the hub axis: whether an authorised HQ role's cross-hub read, or a cross-vendor read, emits one is not decided.

## 7. Authentication and access coverage

§38.4 requires audit of: login success and failure as appropriate, MFA enrolment, challenge and recovery, rider device registration and replacement, vendor session replacement, logout and revocation, account recovery, suspension access denial, and privileged cross-vendor or cross-hub access.

**Vendor activity is attributable to the shared vendor account, not a named employee** (§38.4, §37.5). The audit record names the account. Any surface presenting it as a person is asserting something the data cannot support — [permissions.md](permissions.md) §10 carries the same constraint from the UI side.

## 8. Timelines and retention

### 8.1 Operational timelines

§38.6: authorized users inspect an ordered business timeline for a pickup request, attempt chain, intake, order, delivery, and later payment and settlement.

**Vendor-visible timelines expose only approved customer-facing milestones.** They must not leak internal notes, personnel data, or other vendors' information. A vendor timeline is therefore a filtered projection, not the audit log with a permission check bolted on — the filter is on event code and field, not merely on ownership.

### 8.2 Retention — confirmed policy

§38.7 and §38.7, `MSC-DEC-150–153`:

- Photos, audit events, call logs, notifications, sender records and parcel history each carry an **independently configurable** retention period. Not one uniform value.
- A record under active dispute, unresolved discrepancy, or ongoing investigation is **exempt from automatic deletion** until the matter closes.
- **Only Platform Admin** may change a retention-period setting (`settings.retention.manage`).
- The Auditor bundle may search, view and export audit data; every export is enhanced-audited.

Exact periods are `OQ-028` and require legal input under §8.2. The keys live in [settings.md](settings.md) §7.1.

## 9. Never logged

§38.2 is explicit: secrets, full credentials, raw OTPs, and unnecessary personal data must **never** be copied into audit logs.

This bites in three places the slice actually touches:

- **Handshake codes.** `pickup.handshake.generated` records that a code was generated, never its value. A verification event records the outcome, not the submitted digits.
- **Evidence.** Audit references `Evidence` by ID. It never embeds an image or its storage credentials.
- **`before_after` diffs.** A safe diff, not a field dump. A diff over a record containing a phone number or declared value carries the change, not the surrounding personal data.

§37.7 lists the sensitive categories; masking and redaction design **was** open under §38.7 and is settled by `MSC-DEC-283`.

### 9.1 Telemetry separation

**Operational logs and traces are not the `AuditEvent` ledger**, and the prohibition above binds in both. Redaction is **central**, not per-call-site: a rule applied at each call site is enforced at review level, which [engineering-standards.md](../standards/engineering-standards.md) §2 ranks lowest and §2's own worked examples call a defect in the enforcement.

**Never written to any log, trace, span or error report:**

`Authorization` · `Cookie` · `Set-Cookie` · `X-CSRF-Token` · passwords · PINs · **TOTP values and seeds** · `SetupGrant` tokens · `RecoveryRequest` tokens · Vendor device credentials · Session credentials · **signed Evidence URLs** · provider secrets · and sensitive authentication, payment and evidence **request bodies**.

**Applied across every sink:** application logs · **worker** logs · **reverse-proxy** logs · **traces and APM** · **exception reporting**.

**The sinks are where this is normally broken.** A reverse proxy logging a query string and an APM span carrying request attributes are both outside whatever the application's own logger was taught, and neither appears in a code review of the handler.

**A signed Evidence URL is the one entry that is not merely a disclosure.** It is a bearer capability, so a logged URL **grants the object** to anyone who reads the log, for as long as it lives.

**Redaction is tested on failure paths, not only successful ones** ([OBSERVABILITY_AND_RECOVERY.md](../architecture/OBSERVABILITY_AND_RECOVERY.md) §2.3). An exception frame carries the arguments an access log never sees, and a redaction test that exercises only `200` responses never reaches the handler that leaks.

## 10. Questions this document raised

None. The six items §38.7 leaves open are recorded in §1 and already tracked — `OQ-028` covers retention periods, and the immutability, tamper-detection, export-procedure, redaction and archival mechanics are downstream security and privacy design under §37.7's open scope.

**Three of those five were answered on 27 August by `MSC-DEC-283`** — **immutability** and **tamper detection** at §2.1, **redaction** at §9.1. **Export procedure and archival mechanics remain open**, and `OQ-028`'s retention periods are untouched: they need legal input under §8.2 and Gate B supplied none. **The checkpoint interval is settled at 15 minutes** (`MSC-DEC-297`, closing `OQ-103`). Gate B R0 declined to choose it and was right to: the interval is simultaneously the **detection window** for tampering and the **amount of history a lost checkpoint costs**, which is a risk judgement rather than an engineering default — and *every hour* is the answer that gets chosen precisely because it sounds like neither.


