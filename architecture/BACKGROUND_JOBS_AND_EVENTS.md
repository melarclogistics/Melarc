# Background jobs and events

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.17 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** how asynchronous work is scheduled, retried, made idempotent, and tied back to the business event that caused it
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../PROJECT_MASTER_SPECIFICATION.md) §39.5, §42.5, §42.6, §42.8
> **Authority:** Technical design implements the retained product requirements; it does not redefine product behavior.

## 1. Scope and what this may not do

This document answers the seven questions §39.5 requires the architecture to settle before implementation, and applies §42.5's four properties to every job.

**It carries no product authority.** Where anything here appears to decide product behaviour, it is wrong by construction — register the contradiction. Two places came close while writing it and are marked as questions rather than decisions.

**Out of scope:** deployment topology ([DEPLOYMENT_AND_ENVIRONMENTS.md](DEPLOYMENT_AND_ENVIRONMENTS.md)), alerting and runbooks ([OBSERVABILITY_AND_RECOVERY.md](OBSERVABILITY_AND_RECOVERY.md)), and provider contracts.

## 2. The four properties, which are requirements and not goals

§42.5 states them as musts: every asynchronous task is **idempotent**, **observable**, **retry-safe**, and **linked to the originating business event**. And: *"Failed jobs must be visible and recoverable **without duplicating business effects**."*

| Property| What it means concretely here|
|---|---|
| **Idempotent**| Running the task twice produces one business effect. Enforced by a key, not by hoping the broker delivers once|
| **Observable**| Queue depth, age of the oldest message, failure count and dead-letter depth are all visible without reading logs|
| **Retry-safe**| A retry after partial completion is safe. Tasks are structured so there is no partial state to resume from|
| **Linked**| Every task carries the id of the record that caused it. A job with no business anchor cannot be triaged|

**The fourth is the one that gets dropped**, because it costs a field and buys nothing until an incident. Without it, a failed notification job is a stack trace; with it, it is *"order `X`'s dispatch SMS failed"* — a thing Ops can act on.

## 3. §39.5's seven questions

### 3.1 Broker and result backend

§39.5 records Celery as the *"current technical hypothesis"* — a hypothesis, not a decision, and this document does not promote it to one. **Whatever is chosen must support:** delayed and scheduled execution, per-task retry with backoff, a dead-letter destination, and at-least-once delivery. **HIGH-09 audit remediation (13 September 2026):** the product selection itself is `OQ-115` — an engineering choice, not a Product one, the same shape `OQ-113` already carries for the anti-tampering provider — registered so the deferral §5 states is traceable through the register nothing here duplicates.

**At-least-once is assumed and is the reason §2's idempotency requirement is not optional.** Exactly-once delivery is not available from any broker in the presence of network partitions, so the guarantee is built at the task, never at the transport.

**A result backend is required only where a caller waits.** §40.3: *"long-running exports or asynchronous work must show progress and completion state rather than block an interactive request."* Exports need a result to poll. A notification dispatch does not, and storing results for fire-and-forget tasks is retention nobody has budgeted.

### 3.2 Task idempotency and retry/backoff

**Every task carries an idempotency key derived from the business fact, never from the message.** A key generated at enqueue time changes on every retry and guarantees nothing. `notify_dispatch(order_id)` keys on the order and the notification type; a redelivery of the same message finds the key already consumed and returns.

This is the same rule the contract already applies at the API boundary — `IDEMPOTENCY_KEY_CONFLICT` when a key is reused with a different payload, replay of the identical payload returning the original result ([errors-and-enums.md](../contracts/errors-and-enums.md) §4).

**Retry policy is per failure class, not per task**, and Gate D fixes the classes at four:

| Failure| Policy|
|---|---|
| **Class 1 — transient or explicitly retryable**: timeout, connection reset or refused, temporary 5xx, **HTTP 429**, and any provider response **explicitly documented as retryable**| Exponential backoff with jitter on the bounded schedule below, then dead-letter. **A safe `Retry-After` is respected when present**|
| **Class 2 — deterministic, non-retryable rejection**: invalid number, malformed request, unsupported destination, and any deterministic 4xx **excluding 429 and excluding any provider response explicitly documented as retryable**| **No blind retry.** Dead-letter immediately; retrying a rejection produces load and no delivery|
| **Class 3 — unknown result** after a potentially side-effecting request| **Never blindly repeat the business effect.** §3.2a|
| **Class 4 — broker or queue infrastructure unavailable**| The business transaction keeps its Outbox intent; the relay retries transport. §3.2b|
| Business guard refused the transition| **No retry, and not an error.** A job that finds its precondition no longer true has been overtaken by events|
| Unhandled exception| One retry, then dead-letter. A second identical crash is a defect, not a transient|

**The Class 1 schedule, and it terminates:**

```
attempt 1   immediately
attempt 2   ~30 seconds
attempt 3   ~2 minutes
attempt 4   ~10 minutes
attempt 5   ~30 minutes
attempt 6   ~2 hours
then        DEAD-LETTER - manual recovery
```

unless an operation-specific deadline requires earlier termination. **A provider `Retry-After` may safely extend the next attempt**; it never removes the bound.

**The terminus is the part that gets left out, and leaving it out is invisible.** A retry schedule with no final bound is an infinite retry wearing a table's clothing: the queue drains, the dashboard stays green, and nothing reports that one message has been in flight for a week. **The dead-letter is mandatory**, and it is also what keeps §3.3's triage queue finite.

**Jitter is not a refinement.** The scheduled backstop sweeps and the statement issue both fire on a clock, so their failures are simultaneous and their retries would be too.

**Class 1 and Class 2 must never be merged, and the earlier text merged them in one direction** — describing a provider outage as though it were a permanent rejection. **The class is decided by the failure's shape, not by the fact that a provider was involved.**

**The two classes are mutually exclusive, and an unqualified `4xx` in Class 2 destroys that** *(D-R1)*. **429 is a 4xx**, so a Class 2 that reads *"4xx"* with no carve-out silently claims the status code Class 1 explicitly retries — and the same response then has two contradictory policies, which an implementer resolves by picking one. **Class 2 therefore excludes 429 by name**, and excludes any provider response the provider documents as retryable, because a provider that says *try again* has told you the failure is not deterministic.

### 3.2a Class 3 — the result is unknown, and the request may already have worked

**Chiefly payment, and the rule is absolute: never blindly repeat the business effect.**

A timeout on a request that may have moved money is not a transient failure, **because the safe response to a transient failure — try again — is the unsafe response here.** The attempt enters the existing **`STATUS_UNKNOWN` reconciliation** path and resolves through the **provider transaction reference**, the **idempotency reference**, a **trusted callback**, or a **provider query where supported** — `payment_collection_reconciliation`, which **may never fabricate success**.

**Gate C's payment truth is unchanged.** §26.4 makes the provider authoritative for payment success, and a retry that re-charges a recipient because Melarc did not hear the answer is exactly the failure this class exists to make impossible. **Where provider truth stays unknown the attempt stays unknown** — a job that guesses is worse than one that waits, because its guess looks like evidence.

**`payment_collection_reconciliation`'s schedule, and why it does not terminate** *(CRIT-03 audit remediation)*:

```
attempt 1   ~1 minute after entering STATUS_UNKNOWN
attempt 2   ~5 minutes
attempt 3   ~15 minutes
attempt 4   ~1 hour
then        every 6 hours, indefinitely - no dead-letter, no final bound
```

**Class 1's terminus does not apply here, and the omission is deliberate.** Dead-lettering a `STATUS_UNKNOWN` attempt after six tries would stop anyone from ever asking the provider again — the queue would drain, the dashboard would stay green, and a payment that genuinely succeeded at the provider would sit unreconciled forever with nobody watching for it. **The failure mode this class exists to prevent is silence, so the job may never fall silent.**

**This does not mean an order waits on it.** The attempt may stay `STATUS_UNKNOWN` for as long as the provider withholds an authoritative answer, but the *order* is never held hostage to that convergence: [domain-model.md](../contracts/domain-model.md)'s `PaymentFallbackAuthorization` entity — the Ops-authorised duplicate-risk exception — lets a fresh attempt proceed through a different method (Merchant MoMo or cash) while the original keeps reconciling in the background, gated on a mandatory reason and an explicit risk acknowledgement so the exception cannot become the ordinary path. If the reconciling attempt later resolves `SUCCEEDED`, the money is never discarded — [state-machines.md](../contracts/state-machines.md) §20.6's `STATUS_UNKNOWN → SUCCEEDED` row raises a `FinancialAdjustmentRequired` for the excess rather than losing track of it. **Reconciliation never stops asking, and Ops is never stuck waiting for it to answer — together, that is the answer to a `STATUS_UNKNOWN` attempt that never resolves.**

### 3.2b Class 4 — the broker is down, and the business transaction is not

**The originating business transaction persists its trusted Outbox intent and commits.** The relay then:

- **never marks an event published before broker acknowledgement** — the single ordering rule that makes the outbox worth having;
- retries transport safely, under the same bounded backoff;
- **retains ordering and correlation information**;
- **resumes idempotently** after recovery.

**No business transaction is rolled back because notification infrastructure is down** — unless the business rule itself requires synchronous completion. §31.1 already draws that line and §4 keeps it: a vendor milestone is soft-fail, `send_recipient_otp` is blocking. **Rolling back a committed custody change because an SMS could not be queued would be the queue deciding a business outcome.**

### 3.3 Dead-letter and failure handling

**A dead-lettered job is an operational fact, not a log line.** §42.5 requires failed jobs to be *"visible and recoverable"*, which means a queue a person can look at, with the business anchor from §2 on every entry.

**Replay is explicit and audited.** A dead-lettered job is re-run by a person, and because §2 makes tasks idempotent, replaying one that partially succeeded is safe. **Replay of a job with financial effects emits an audit event** — §38.5 category 2 covers manual overrides, and re-running a payment-adjacent task is one.

**The screen this requires is scoped to `SLICE-013`** — [IMPLEMENTATION_PLAN.md](../delivery/IMPLEMENTATION_PLAN.md) §4b (CRIT-16 audit remediation). This architecture document specifies the requirement and, per §42.7, may not itself allocate delivery-plan scope; before this pass, no document did either, and *"a queue a person can look at"* had no slice building it.

### 3.4 Vendor ownership and responsible-hub context

**Every task carries `vendor_id` and `responsible_hub_id` where the record has them**, because §37.6 requires *"every query, export, notification, file, and API operation"* to enforce vendor ownership and hub scope — **notifications and files are named explicitly**, and both are asynchronous.

**A background task runs with no session**, so it cannot resolve scope from an actor. It carries the scope it was created with and re-checks it at execution: the vendor may have been suspended between enqueue and run, which for a notification is precisely the case that matters (§29.6).

**This is where a leak would happen**, and §37.6's negative-access tests apply here as much as at the API. A notification job that resolves its recipient from a stale payload can send one vendor's parcel details to another.

**The re-check has an order, and the order is the control**:

```
1  receive broker message - the ONLY authority bootstrap it carries is outbox_id
2  BEGIN under the worker technical identity
3  read the TRUSTED Outbox row by outbox_id, via the narrow bootstrap capability
4  verify: exists - task type allowed for this worker - envelope executable - no incompatible prior run
5  establish TRANSACTION-LOCAL SYSTEM context FROM THE STORED ENVELOPE
6  RELOAD the protected business aggregate UNDER RLS
7  compare the reloaded aggregate's authoritative scope against the IMMUTABLE envelope
8  mismatch -> no business side effect - abort - dead-letter/quarantine - security signal
9  matched  -> perform only the minimum task-authorised DML
10 COMMIT
11 transaction-local context disappears before the connection is reused
```

**Step 3 is what R0 was missing, and its position is the whole control**. v0.2 had the worker establish context *from the payload* and then compare the reloaded object against that same payload — **so the payload selected the authority under which it was validated, and a forged or stale envelope validated perfectly.** Both sides of the comparison came from one untrusted source.

**Reading a stored, server-written row first is what makes step 7 a check at all.** The comparison is now between something the broker supplied and something **only the business transaction could have written**.

**A queue message is not authority.** The envelope's scope metadata exists to be *verified*, never to *grant*. **A mismatch dead-letters and emits a security event** — it is not retried, because a retry of a scope mismatch is the same wrong job again.

**Payloads carry the minimum.** No customer addresses, OTPs, payment secrets, credentials or signed Evidence URLs unless the task genuinely cannot run without them — §38.2's *never unnecessary personal data* applies to a queue as much as to a log, and a dead-letter queue is a durable store that outlives the job.

### 3.5 Scheduling and backstop jobs

| Job| Cadence| Governing section| Figure|
|---|---|---|---|
| Failure backstop sweep| Periodic| §21, `MSC-DEC-237`| **24 hours** — set|
| Vendor statement issue| Weekly, Monday 08:00 `Africa/Accra`| §36.11| Set|
| Statement overdue transition| Weekly, Thursday 08:00 `Africa/Accra`| §36.11| Set. **No grace period**|
| Session expiry and idle timeout| Continuous| `MSC-DEC-234`| 480 / 15 minutes — set|
| Compliance expiry alert| Daily| §30.7, `MSC-DEC-237`| 30 / 14 / 7 days — set|
| Notification dispatch| Event-driven| §31| Provider is `OQ-048`|
| **Payment collection reconciliation**| 1 / 5 / 15 min, 1 hour, then every 6 hours — **indefinitely, no dead-letter** (§3.2a, CRIT-03)| `MSC-DEC-354`| **Buildable, provider query subject to `OQ-109`** — resolves `STATUS_UNKNOWN` and long-pending attempts. **Never fabricates success**|
| **Cash reconciliation reminder**| **18:00 `Africa/Accra`**, per hub| §26.3, `MSC-DEC-324`| **Buildable** — `cash_reconciliation_cutoff_time`, a per-hub setting|
| **Evidence `PENDING_UPLOAD` sweep**| Hourly| [state-machines.md](../contracts/state-machines.md) §17, `MSC-DEC-251`| **Buildable** — transitions `PENDING_UPLOAD → EXPIRED` wherever `expires_at` has passed. The guard is `evidence_upload_authorization_ttl_minutes` = **15** ([settings.md](../contracts/settings.md), `MSC-DEC-297`), so an abandoned capture is caught within roughly an hour of its window closing. **Retained, not deleted** (§35.1.5) — the sweep only marks, it never removes|
| **Missed-commitment sweep**| Daily, at each hub's own end-of-day point ([hub-daily-operating-cycle.md](../features/operations/hub-daily-operating-cycle.md) §5.5)| [domain-model.md](../contracts/domain-model.md) §6.12, `MSC-DEC-307`| **Buildable** — reads (never writes) the current `DeliveryCommitment` row per order; where `committed_date`/`committed_window_end` has passed with no `delivery.stop.delivered` yet recorded, emits `delivery.commitment.breached` ([audit.md](../contracts/audit.md) §5.3) unless that event already exists for the same commitment id. **No new state, no mutation of an append-only entity** — the audit log carries the "already flagged" fact the entity itself may never hold|

**All business-time schedules evaluate in `Africa/Accra`, never UTC** ([domain-model.md](../contracts/domain-model.md) §3.3). Monday 08:00 means Monday 08:00 in Accra.

**The last row was a gap this document found and could not fill, and Gate C filled it** *(R1.2)*. `cash_reconciliation_cutoff_time` = **18:00 `Africa/Accra`**, per hub (`MSC-DEC-324`, closing `OQ-094`), held per hub as a setting rather than a constant so a hub whose riders finish later can be configured without a code change. **The job is buildable.**

**The last row is a gap this document found and may not fill.** §26.3 requires cash reconciliation *"after the rider's run or before the rider's workday closes"* and assigns *"exact cutoff [and] shift model"* to downstream design. **A scheduled job needs a time and there is no time.** `OQ-094` raised — an architecture document choosing one would be setting an operational policy under §42.7, which it may not do.

**The Evidence sweep marks; it never strands anything downstream**. `state-machines.md` §17 already tabled `PENDING_UPLOAD → EXPIRED`, guarded by `expires_at`, System-actor — what this document was missing was the job that actually fires it, since an unscheduled System transition is a transition nobody performs. **No parent record can be locked waiting on an abandoned capture**: every operation that accepts an `evidence_ids` array requires each referenced record to already be `STORED` at the moment of the call — `EVIDENCE_NOT_STORED` otherwise ([domain-model.md](../contracts/domain-model.md) §3.6, [errors-and-enums.md](../contracts/errors-and-enums.md) §5.7). A handoff, an intake finding or a delivery failure that names required evidence simply has not succeeded yet if the capture never completed; the sweep changes the abandoned `Evidence` record's own bookkeeping; it does not unblock, fail or otherwise touch whatever operation the rider or Ops officer has not yet completed.

### 3.6 Monitoring and operational replay

Covered in [OBSERVABILITY_AND_RECOVERY.md](OBSERVABILITY_AND_RECOVERY.md) §3. The signals this document depends on: queue depth, oldest-message age, dead-letter depth, and per-task failure rate.

**Oldest-message age is the one that matters and the one usually missing.** Queue depth of zero with a stuck consumer looks identical to a healthy idle queue. Age does not.

### 3.7 Transaction-to-event consistency

**Jobs are enqueued through an outbox, not from inside the request transaction.** §39.5 names the pattern; this is why it is required rather than preferred:

A transition commits and *then* enqueues. If the process dies between the two, the state changed and the notification never fires — a dispatched run whose rider was never told. Enqueue *before* commit and the transaction may roll back after the message is gone, producing a notification for a dispatch that did not happen. **`MSC-DEC-231`'s atomic dispatch makes the second failure concrete**: `dispatchDeliveryRun` rolls the whole run back if one order's gate fails, and pre-commit enqueue would notify a rider about a run that returned to `DRAFT`.

**The outbox writes the intent inside the same transaction as the state change**, and a relay publishes it afterwards. The relay is at-least-once, which §3.2's idempotency already covers.

**`Outbox` is a persistent technical table, declared here for mechanical discovery**:

```
PERSISTENT-TECHNICAL-TABLE: Outbox
```

**The declaration lives at the architecture definition point, not in the Registry** — contract-consistency validation reconciles three independent sets, so a technical table added here and forgotten in the Registry fails the check instead of passing unnoticed.

**The row it writes is a security envelope, not merely an intent**. It carries `outbox_id`, aggregate type and id, event/task type, authoritative `responsible_hub_id`, `vendor_organization_id` and rider/assignment id, the originating principal, `operation_id`, correlation id, idempotency linkage, timestamp and the minimum payload. **Every scope field is derived from the authoritative row inside that transaction**, and none is ever accepted from HTTP input, client payload, broker headers or worker payload.

**Immutable once committed:** aggregate identity · event/task identity · Hub, Vendor and Rider scope · originating authority · correlation and idempotency linkage. **The relay updates only its narrow delivery bookkeeping columns and may never rewrite the envelope** — which is why it holds no business DML at all.

**The broker message carries `outbox_id` and nothing authoritative.** Convenience metadata may ride along; it never establishes scope, never overrides the stored row, and is **rejected or ignored when inconsistent** with it.

**Payloads carry the minimum**, and a dead-letter queue is a durable store that outlives the job — so no customer addresses, OTPs, payment secrets, credentials or signed Evidence URLs unless the task genuinely cannot run without them.

**The relay holds a fixed technical capability and never a `RoleBundle`**: it may read outbox rows and mark them relayed, and it may perform **no business DML at all**. §11.1 makes bundles editable configuration, so a bundle attached to the relay would put the authority of the one component that touches every business transaction one settings screen away from being the whole product. **`OQ-047`'s service-account question stays open** — this settles only that its answer is not a human bundle.

### 3.8 Queue priority, backpressure, and the bound on scaling

`MSC-DEC-372`. **Three technical workload classes**, and the ordering between them is a safety property rather than a preference:

| Class| Contains| Why it outranks the one below|
|---|---|---|
| **Recovery / financial safety**| Payment reconciliation · security and integrity recovery work| Money or custody is already in an uncertain state, and delay compounds it|
| **Operational**| Time-sensitive operational notifications · dispatch and rider work · scheduled business jobs| Parcels are moving now|
| **Bulk**| Exports · non-urgent analytics and background generation| Nobody is standing at a door waiting for one|

**A bulk backlog must not starve recovery work.** One caller requesting two hundred exports must not delay the job resolving a `STATUS_UNKNOWN` payment, and a single shared queue makes that outcome a matter of luck rather than design. This is the queue-side counterpart of the sub-ceiling `MSC-DEC-371` put on export creation.

**Scale-out is driven principally by oldest-message age, not by depth.** §3.6 already says why — depth of zero with a stuck consumer looks identical to a healthy idle queue — and this is that signal wired to the action that consumes it.

**Two bounds on scaling, and both exist because scaling is the intuitive wrong answer:**

- **A provider-down queue must not respond by creating unlimited worker concurrency against the failed provider.** Adding workers to a dead downstream converts one outage into two, and arrives at the provider looking like an attack at the moment they are trying to recover.
- **Worker concurrency remains bounded, so horizontal scaling cannot exhaust the database connection budget.** A queue that scales without a ceiling takes the API down with it — and the API is the half that was still working.

**Bounded concurrency does not widen worker authority.** Every worker still runs under the least-privileged identity `MSC-DEC-289` fixed, and §3.4's re-check order is unchanged: **a scaled worker is more of the same authority, never more authority.**

## 4. Jobs the product needs today

Derived from the written slices. **Each names the business event that causes it**, per §2.

| Job| Caused by| Effect if it never runs|
|---|---|---|
| `notify_rider_run_dispatched`| `dispatch.run.dispatched`| A rider is not told. §35.7.5: **dispatch stands**, and the failure is surfaced for retry — custody is not reversed. **Classified per §3.2 like any other task** (MED-13 audit remediation): a transient failure gets Class 1's bounded schedule before dead-lettering; a deterministic rejection dead-letters immediately (Class 2). The `retry` **interface state** [atomic-dispatch.md](../features/dispatch/atomic-dispatch.md) §5.5 cites is what an operator sees **after** dead-letter, not instead of automated retry|
| `notify_vendor_milestone`| Approved §31 milestones| A vendor is uninformed. Soft-fail and kill-switchable (§31.1)|
| `send_recipient_otp`| OTP requested at the door| **The ordinary OTP verification path cannot complete.** **Blocking and recovery-required, not soft-fail** — and not universal impossibility: where the recipient is present, the approved **Ops-assisted verification fallback** may still authorise the handover at the same doorstep. A delivery that cannot satisfy the fallback's conditions stays blocked until the path recovers.|
| `sweep_failure_backstop`| Clock, 24h| A failed pickup sits unescalated|
| `issue_vendor_statements`| Clock, Monday 08:00| No vendor is billed that week|
| `transition_overdue_statements`| Clock, Thursday 08:00| Overdue vendors keep credit they should not have|
| `expire_sessions`| Clock| **A privileged session outlives its bound**|
| `alert_compliance_expiry`| Clock, daily| A motorcycle's insurance lapses silently|
| `sweep_missed_commitments`| Clock, daily per hub's end-of-day point| A missed delivery promise is provable in the data and invisible in practice — nobody looks until someone happens to query it|

**`send_recipient_otp` is the only blocking one — blocking the ordinary OTP path rather than the delivery itself — and it should not be a background job at all** if the provider's latency allows a synchronous call. §40.3 permits asynchronous work to *"show progress and completion state"* rather than block — but a rider standing at a door waiting for an OTP is an interactive interaction by any reading. **The decision depends on `OQ-048`'s provider latency**, so it is recorded here as a question rather than settled.

**Setup grants, recovery links and re-enrolment links are not background jobs** (Gate PD-3R1). The raw token exists only in memory, and an outbox row or a task payload would persist it, so `SecurityMessageDelivery` is called **inside the issuing transaction, before it commits**, and a refused send rolls the issue back ([SECURITY_DESIGN.md](SECURITY_DESIGN.md) §13.9a). **There is no `send_setup_grant` task and none may be added** without first answering how its payload avoids holding a credential.

**The attestation trust-data loader is not a background job either** (Gate PD-3R2). It is the rider device verifier's own in-process loader in each API instance ([SECURITY_DESIGN.md](SECURITY_DESIGN.md) §15.2.2): it enqueues nothing, reads and writes no table, takes no lock and needs neither the scheduler nor a worker nor the broker, so **`OQ-115` does not bear on it** and no capability row exists for it.

**Notification soft-fail is a product rule, not an infrastructure choice.** §31.1 makes SMS *"soft-fail and kill-switchable for selected events"* — so a failed vendor milestone does not roll anything back, while **a failed OTP blocks the ordinary verification path and demands recovery** — escalation, or the approved Ops-assisted fallback where the recipient is present. **The two are different in kind, not merely in severity**, which is the distinction this paragraph exists to hold.

## 5. What this document does not settle

| Item| Owner|
|---|---|
| Broker and result-backend product| Backend Engineer, at implementation. §39.5 offers a hypothesis, not a decision. **Registered as `OQ-115`**|
| ~~Retry counts and backoff intervals~~| **CLOSED** — `MSC-DEC-372` sets the bounded Class 1 schedule at §3.2. Still recalibrated as launch configuration under `MSC-DEC-217`, like the rate-limit figures `MSC-DEC-371` supplied|
| The cash-reconciliation cutoff| **CLOSED** — **18:00 `Africa/Accra`**, per hub (`MSC-DEC-324`, closing `OQ-094`). A job needed a time; Gate C set one|
| Whether OTP dispatch is synchronous| `OQ-048` provider latency|
| The email and SMS providers for credential messages| `OQ-048` — widened at Gate PD-3R1 to the transactional email provider; the port and the capture adapter are written, the choice is not|
| Retention of task results and dead letters| `OQ-028` — legal input|

## 6. Related

[SOLUTION_ARCHITECTURE.md](SOLUTION_ARCHITECTURE.md) · [OBSERVABILITY_AND_RECOVERY.md](OBSERVABILITY_AND_RECOVERY.md) · [MIGRATION_AND_SEEDING.md](MIGRATION_AND_SEEDING.md) · [audit.md](../contracts/audit.md) for the events these jobs consume
