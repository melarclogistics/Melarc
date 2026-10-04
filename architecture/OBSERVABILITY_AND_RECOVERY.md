# Observability and recovery runbooks

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.33 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** what is measured, what alerts, and the ordered steps taken when something breaks
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../PROJECT_MASTER_SPECIFICATION.md) §40.3, §40.4, §40.6, §42.8, §42.5
> **Authority:** Technical design implements the retained product requirements; it does not redefine product behavior.

## 1. Scope and the constraint that binds hardest

§40.6 assigns *"observability/alerts… restore-test cadence, exact performance percentiles"* to this document and adds the constraint that governs every line of it:

> *"They must **preserve the confirmed targets rather than weaken them silently**."*

**That sentence exists because this is the document where weakening happens.** An availability target measured over a convenient window, a percentile quoted at p50 instead of p95, a restore test scheduled annually — each looks like operational realism and each is a product decision taken by an architecture document, which §42.7 forbids.

**`OQ-068` was exactly that, and it was caught and then decided.** [DEPLOYMENT_AND_ENVIRONMENTS.md](DEPLOYMENT_AND_ENVIRONMENTS.md) §2 argued availability should be measured over operating hours rather than the calendar, which **relaxes §42.8's approved 99.5% monthly**. It was registered rather than applied — and **`MSC-DEC-256` approved the relaxation on 26 August**, with `MSC-DEC-257` setting the window at **Monday–Saturday 07:00–18:00 `Africa/Accra`**. **The Product Owner took it, not an architecture document**, which is the whole point of registering it.

**Planned maintenance inside the operating window counts as downtime**. The window leaves 132 hours a week free for maintenance, so a maintenance exclusion would buy nothing and cost the one property that makes the figure honest.

## 2. What is measured

### 2.1 The four signals that decide whether Melarc is working

Not server metrics. These are the ones where a fault means parcels stop moving.

| Signal| Why it is first-class|
|---|---|
| **Interactive response time**, p95| §40.3's targets apply to *"normal connected interactions"*. A rider at a door is one|
| **Queue oldest-message age**| Depth of zero with a stuck consumer looks exactly like a healthy idle queue. **Age is the signal; depth is the decoration**|
| **Provider success rate** — SMS, transactional email, mobile money| Melarc's OTP, credential-message and payment paths run through them, and §26.4 makes the provider authoritative for payment success|
| **Dead-letter depth**| §42.5: failed jobs must be *"visible and recoverable"*. A dead-letter queue nobody watches is neither|

### 2.2 Business signals, because a green infrastructure dashboard can sit above a broken operation

| Signal| The failure it catches| Source|
|---|---|---|
| Orders in `PAYMENT_REQUIRED` with no payment attempt, ageing| The commercial gate closed on a vendor and nobody noticed| §36.11|
| **Runs financially open past their workday**| **Cash collected and never reconciled** (§26.3)| [state-machines.md](../contracts/state-machines.md) §16|
| Failed pickups approaching the 24-hour backstop| The backstop sweep is not running| `MSC-DEC-237`|
| Confirmation escalation queue depth| §24.2's queue is filling faster than Ops empties it| `MSC-DEC-230`|
| Handshake **SMS-fallback ratio**| `MSC-DEC-198`'s only control is that persistent fallback use stays visible| §5.1, `audit.md`|
| Enhanced-audit event rate by type| A discretionary override becoming routine — the `MSC-DEC-197` pattern's sole mitigation| §38.5|

**The last two are controls, not curiosities.** These discretionary paths are safe only when their frequency is observable. **If nothing plots the ratio, the safeguard does not exist operationally.** This document therefore requires those controls to be measurable rather than merely described.

### 2.3 What is never measured into a log

- **OTP and handshake code values** (§20.4). The audit records that validation occurred, never the material.
- **Session tokens** ([domain-model.md](../contracts/domain-model.md) §6.8).
- **Credentials, PINs, vendor secrets** — hashed, never retrievable.
- **Recipient personal data beyond the minimum** the transaction requires (§19.9, §38.2).

**A trace or an error report is a log.** The most common leak is not a `logger.info` — it is an exception payload containing the whole request body on the path that handles the OTP.

**Gate B makes that observation an obligation**. **Operational logs and traces are not the `AuditEvent` ledger**, and redaction is central rather than per-call-site — a rule enforced at each call site is enforced at review level, which [engineering-standards.md](../standards/engineering-standards.md) §2 ranks lowest.

**Redacted everywhere, in every sink:** `Authorization` · `Cookie` · `Set-Cookie` · `X-CSRF-Token` · passwords · PINs · TOTP values and seeds · `SetupGrant` tokens · `RecoveryRequest` tokens · Vendor device credentials · Session credentials · **signed Evidence URLs** · provider secrets · and sensitive authentication, payment and evidence request bodies.

**The sinks are the part that gets missed:** application logs, **worker** logs, **reverse-proxy** logs, **traces and APM**, and **exception reporting**. A reverse proxy logging a query string and an APM span carrying request attributes are both outside whatever the application's own logger was taught.

**A signed Evidence URL is a bearer capability, so logging one grants the object to whoever reads the log**. It is the one item on the list that is not merely a disclosure — it is an access grant with a timer on it.

**Test redaction on failure paths, not only successful ones.** This section already names the exception payload as the likeliest leak, and a redaction test that exercises only `200` responses never reaches the handler that leaks.

## 3. Alerting

**An alert is a thing someone does something about.** Everything else is a dashboard.

| Alert| Condition| Response|
|---|---|---|
| **Provider down**| SMS, email or payment success rate collapses. Every refusal by the credential-message port counts toward the SMS and email rates, **including the `requestCredentialRecovery` refusals that are never shown to the caller** ([SECURITY_DESIGN.md](SECURITY_DESIGN.md) §13.9a)| §4.1 runbook. **Deliveries in progress do not simply stop** — `MSC-DEC-326`'s Ops-assisted verification fallback completes the handover where the recipient is present|
| **Queue stalled**| Oldest-message age exceeds its threshold below| §4.2 runbook|
| **Dead letters accumulating**| Depth rises over a window| Triage by business anchor ([BACKGROUND_JOBS_AND_EVENTS.md](BACKGROUND_JOBS_AND_EVENTS.md) §2)|
| **Cash unreconciled past workday**| Business signal §2.2| Hub contact. **Money is outstanding**|
| **Scheduled job did not run**| Statement issue, backstop sweep, session expiry| §4.3 runbook|
| **Attestation trust data aging** *(Gate PD-3R1)*| The Android attestation revocation list that an API instance holds is **older than 12 hours** (SEV-3), or **older than 24 hours**, or the accepted roots cannot be loaded (SEV-2: new rider enrolment and replacement are failing closed). **Measured per instance**, from the held list's fetch time — or from process start when none is held — and **evaluated on the oldest instance** ([SECURITY_DESIGN.md](SECURITY_DESIGN.md) §15.2.2)| **Owner: the Backend Engineer.** §4.3a runbook — **not §4.3**, because the loader is not a scheduled job. **At SEV-2, tell Senior Ops**: a rider's enrolment or replacement is blocked and the handset is told to try again shortly, while sign-in and every live session are unaffected|
| **Backup did not complete**| §40.4 requires verification, not just execution| §4.4 runbook|
| **Audit archive or checkpoint failed**| The immutable mirror is asynchronous and **must be monitored**| Investigate before the gap widens. **An unmonitored asynchronous mirror is an absent control**, because nothing else reports that it stopped|
| **Enhanced-audit write failed closed**| An enhanced-audit action was refused because its audit record could not be durably written| The action did **not** happen. Treat as an operational block, not a logging fault|
| **Rate limit binding on operational work**| `RATE_LIMITED` returned to an authenticated staff Session on operational endpoints — hub intake counting above all| **Investigate before loosening anything.** `MSC-DEC-386` ruled no intake exemption necessary **on `MSC-DEC-369`’s launch volumes**, which are planning assumptions rather than ceilings. **This alert is the mechanism by which that ruling is revisited**: if it fires, the arithmetic behind it has stopped holding and the exemption question reopens on evidence rather than on speculation|

**The provider row is the one that was wrong, and it was wrong in the direction that stops parcels.** It read *"OTP failure blocks deliveries in progress"* — true until 29 August, when `MSC-DEC-326` authorised the Ops-assisted verification fallback. **An SMS outage is recoverable where the recipient is present**, and an alert that tells an operator otherwise drives exactly the improvisation §4.1 exists to prevent.

### 3.1 Severity and acknowledgement

`MSC-DEC-370`. **An alert with no severity is a preference about who gets woken up.**

| Severity| What it means| Acknowledgement|
|---|---|---|
| **SEV-1 — Critical**| Core service unavailable · data-integrity risk · cross-scope security failure · unsafe payment or custody state · **RPO breached · RTO breached · recovery position compromised**| **≤10 minutes**, with continuous incident ownership until stabilised|
| **SEV-2 — High**| Major sustained degradation · a queue blocking business operations · critical provider outage · failed daily backup · sustained p95 breach · a financial or security dead letter| **≤30 minutes**|
| **SEV-3 — Warning**| A developing degradation or capacity condition that has **not yet** broken the Product SLO| **≤4 operating hours**|

### 3.2 The provisional launch thresholds

**These exist now, and telemetry recalibrates them.** They are technical launch defaults under `MSC-DEC-217` and **may not be recalibrated in a direction that relaxes a Product target.**

| Domain| SEV-3| SEV-2| SEV-1|
|---|---|---|---|
| **Performance**| p95 above **80% of its target** for 30 minutes| normal p95 **>3s for 10 continuous minutes**, or critical-write p95 **>5s for 10 continuous minutes** — each **only once the window holds enough observations** (§3.2a)| —|
| **Queue**| oldest message **>2 minutes** for 15 minutes| blocking or operational oldest **>10 minutes**, or soft/bulk oldest **>30 minutes**| queue failure creates an unsafe money or custody state, or prevents all active core work|
| **Provider**| failure rate **>5%** for 15 minutes across **at least 20 attempts**| success rate **<80%** for 10 minutes across **at least 20 attempts**, or **five consecutive failures** regardless of volume| provider failure **together with** the absence or failure of the approved Melarc fallback leaves a business-critical flow unsafe|
| **Backup and recovery**| —| the daily backup fails, or the **latest verified recoverable point** is older than **20 hours**| the verified recoverable point reaches or exceeds **24 hours**|
| **Scheduled jobs**| —| a critical scheduled job **>15 minutes late** with no documented reason| —|
| **Attestation trust data**| the oldest instance's list is **older than 12 hours**| the oldest instance's list is **older than 24 hours**, or the accepted roots cannot be loaded — enrolment and replacement fail closed (`503` `TRUST_DATA_UNAVAILABLE`)| —|
| **Dead letters**| —| **any** financial or security-sensitive dead letter, until triaged| —|

### 3.2a What counts as enough traffic to evaluate a percentage — D-R1

**A percentile computed from four requests is not a percentile**, and an alert that fires on one is an alert people turn off. Gate D's thresholds said *"with sufficient traffic"* and *"on a meaningful sample"* — correct in intent and not executable, because two engineers can implement them differently and both be right.

| Evaluation| Minimum in the window|
|---|---|
| **Normal-action p95**| **100 completed observations**|
| **Critical-write p95**| **30 completed observations**|
| **Provider percentage thresholds**| **20 provider attempts**|

**Below the minimum, do not claim percentage-based compliance or failure.** An unstable percentile is not evidence in either direction — it may not be reported as a breach, and it may not be reported as compliance either. **What continues to run below the minimum:** absolute-error signals, the **five-consecutive-failure** provider tripwire, and the external synthetic probes §5 of the availability contract already requires. **The consecutive-failure rule is deliberately volume-free**, which is what makes it the right control for a quiet window: five failures in a row is evidence at any traffic level.

**For release and load testing**, generate enough traffic to compute a stable p95 for **every operation and class being asserted** — a target asserted over too few observations has not been tested, whatever the report says.

**These are evaluation minimums, not Product commitments.** They govern when Melarc is willing to draw a conclusion from its own telemetry; they change no approved target, and §42.8's figures are unaffected.

**The provider SEV-1 is deliberately conditional, and it is the row that would have been written wrongly.** An SMS outage alone is a SEV-2 provider outage, not a SEV-1: `MSC-DEC-326`'s fallback is authoritative and the ordinary contact and failure workflow continues where the recipient is absent. **SEV-1 requires Melarc's own approved fallback to be missing or broken too** — which is also the rule that decides whether an outage counts against Melarc's availability at all.

**Two rows above stay threshold-free by construction** and always did: a checkpoint either wrote or it did not, and an enhanced-audit action either committed its record or was refused. **A binary condition needs no figure.**

**The circularity is closed, and it was the reason these were missing.** `OQ-095` said thresholds would be *"set from the first month after launch"* — under which the first month of live operation, the period a new system is likeliest to fail, runs **with no alerting at all**. It also made the question uncloseable by construction: the data that would set the thresholds could only be gathered by running without them.

## 4. Recovery runbooks

§42.7 asks for *"observability **and recovery** runbooks"*. Each is ordered, and each ends with a state that is verifiable rather than assumed.

### 4.1 A provider is down

1. **Confirm the scope** — one channel or both. Payment and SMS may share a provider.
2. **If SMS is down:** deliveries in progress **do not simply stop** *(Gate C C1.2, `MSC-DEC-326`)*. **Recipient present:** the Rider requests the **Ops-assisted verification fallback**, Ops performs an approved alternative verification and authorises the handover — the delivery completes. **Recipient absent or unreachable:** no fallback, and the ordinary contact and failure workflow continues. **There is no global OTP bypass mode**, and no configuration switch turns verification off for a hub or a day: every fallback is one Ops decision on one order, audited with actor, method and outcome.
3. **If payment is down:** cash remains an approved channel (§26.2). Recipients who intended mobile money may pay cash; the custody path absorbs it.
4. **Notification jobs dead-letter rather than spin** ([BACKGROUND_JOBS_AND_EVENTS.md](BACKGROUND_JOBS_AND_EVENTS.md) §3.2 — provider rejection is not retried).
5. **On recovery, replay from the dead-letter queue.** Idempotency keys make double-sending impossible.
6. **Verify** that oldest-message age returns to baseline. A drained queue with a stuck consumer drains no further.

**If the failing channel carries credential messages** — setup grants, recovery links, re-enrolment links (`SECURITY_DESIGN.md` §13.9a) — **steps 4 and 5 do not apply**, because those messages are not jobs and nothing is queued or dead-lettered (`BACKGROUND_JOBS_AND_EVENTS.md` §4). Every refused issue **rolled back whole**: no grant exists and an earlier pending one is untouched, so **there is nothing to replay**. The officer who was told `CREDENTIAL_DELIVERY_FAILED` issues again once the channel is back, and a `requestCredentialRecovery` that was refused was never disclosed to its caller, so the person simply asks again. The *Provider down* alert counts those refusals, **including the ones nobody was told about**, which is why it can fire on recovery requests alone. Sign-in, live sessions and every operation are unaffected.

**Step 2 is the one that will be argued with during an incident.** The pressure to hand over parcels without an OTP will be real and immediate. **It is not this document's call** — §25.1 is approved product behaviour, and an architecture runbook authorising a bypass is precisely what §42.7 forbids.

### 4.2 A queue is stalled

1. Distinguish **stalled** (age rising, depth flat) from **backed up** (both rising). Different faults.
2. Stalled → consumers. Backed up → capacity or a slow downstream.
3. **Check whether the blocked job class is soft-fail or blocking** (§31.1). A stalled vendor-milestone queue is a service degradation; **a stalled OTP queue blocks the ordinary OTP path and materially degrades delivery operations** — Ops workload rises, **eligible recipient-present deliveries may still complete through the approved Ops-assisted fallback** (`MSC-DEC-326`, §4.1), and those that cannot satisfy its conditions stay blocked until the queue recovers. **It is a serious operational incident and it is not every delivery stopped**, which is the same distinction §3 draws for the provider alert.
4. Drain or scale, then verify by **age**, never by depth.

### 4.3 A scheduled job did not run

1. Identify the business effect from [BACKGROUND_JOBS_AND_EVENTS.md](BACKGROUND_JOBS_AND_EVENTS.md) §4 — it names what fails for each.
2. **Statement issue missed** → vendors unbilled that week. Re-run; idempotency keys prevent double-issue.
3. **Backstop sweep missed** → failed pickups sat unescalated past 24 hours. Re-run and **review what aged past the window**; the sweep catches them but their SLA is gone.
4. **Session expiry missed** → **privileged sessions outlived their bound**. Re-run, then treat as a security event: §38.4 requires privileged access to be auditable, and this is a window where it was over-granted.

### 4.3a Attestation trust data is ageing *(Gate PD-3R2)*

`SECURITY_DESIGN.md` §15.2.2. **The loader is each API instance's own, not a scheduled job**, so §4.3's *identify the business effect and re-run* has nothing to re-run, and the alert's own condition is the whole trigger.

1. **Read the age gauge and the failure counter per instance** (`attestation_trust_data_age_seconds`, `attestation_trust_data_load_failures_total`). **One instance old and the rest fresh** is that instance's egress or process; **every instance old** is the source or the network.
2. **Check egress** from the API runtime to Google's published endpoint, **and that what it returns parses and is not empty** — a fetched list that fails its schema is discarded and counted as a failure, so a reachable source can still leave the age growing.
3. **If the accepted roots cannot be loaded**, the cause is configuration, and it is SEV-2 whatever the age: production refuses to start with the set empty, so look first at what changed in the deployment.
4. **Do not restart an instance while the source is unreachable.** A restart loses the held copy, and the instance then refuses enrolment until its first load succeeds — the price of keeping nothing on disk, stated at `SECURITY_DESIGN.md` §15.2.2.
5. **At SEV-2, tell Senior Ops.** The handset is told to try again shortly, **the grant is still good** and nothing needs reissuing; **sign-in, live sessions and every operation are unaffected**, so no rider who is already working is stopped.
6. **Verify by the gauge**: it falls to near zero on every instance after a load and stays under the 6-hour cadence. A completed enrolment in Staging confirms the path end to end.

**No step relaxes the maximum age or bypasses the check.** It decides which handsets may be enrolled; an architecture runbook that authorises a bypass is what §42.7 forbids, and the figure moves only by the configuration change `SECURITY_DESIGN.md` §15.2.2 describes.

### 4.4 Restoring from backup

§40.4 sets four hard numbers: **daily backups**, **≤24 hours data loss**, **≤4 hours to restore**, and **tested restoration on a defined cadence**.

1. Establish the loss window and **what business acts fall inside it** — this is the question everything else waits on.
2. Restore the database.
3. **Restore or reconcile file and evidence storage separately.** §40.4 requires it covered *"or have an explicit recreation procedure"*, and evidence is a controlled object (§34.7), not an incidental attachment.
4. **Secrets and integration configuration** are covered by the same clause and are usually the thing nobody restored.
5. **Reconcile provider state.** §26.4 makes the provider authoritative for payment success, so payments confirmed inside the loss window exist **at the provider** and not in the restored database. **Restoring the database is not restoring the truth about money.**
6. Verify against the audit trail: §42.6 requires state-transition history to be preserved, so the restored history is what proves the restore.

**Step 5 is the one that turns a clean restore into a financial incident.** A recipient paid, the provider recorded it, the restore rolled the order back to unpaid, and the rider is told to collect again.

**The restore-test cadence was `OQ-095` until 27 August.** §40.4 requires *"a defined cadence"* and defines none; §40.6 assigned it here, and a cadence is an operational commitment rather than an architecture choice — **so it took a decision, and `MSC-DEC-284` is that decision.**

#### The drill, per `MSC-DEC-284`

**One full restore test before production launch, then quarterly**, into an **isolated** environment. **A routine drill never overwrites production.**

| #| Step| Why it is on the list|
|---|---|---|
| 1| Choose a controlled recovery point| The drill proves a *procedure*, not a lucky snapshot|
| 2| Restore PostgreSQL into the isolated environment||
| 3| Restore and verify **Evidence objects**| Step 3 above — a restored reference with no object leaves an order whose proof has vanished|
| 4| Restore the required **KMS / key access**| Ciphertext without its key is not a backup|
| 5| Verify representative **encrypted TOTP data can still be used**| The narrowest test of step 4, and the one that fails loudest in production: no privileged administrator can sign in|
| 6| Verify key business **row counts and checksums**||
| 7| Verify the **`AuditEvent` integrity checkpoint**| A restore that silently loses audit history is a restore that destroyed the record of what was lost|
| 8| Verify the application **starts**| [DEPLOYMENT_AND_ENVIRONMENTS.md](DEPLOYMENT_AND_ENVIRONMENTS.md) §12.3 now makes a missing security value *prevent* startup — so this step also proves the restored configuration is complete|
| 9| Verify the restored environment **cannot send live SMS or move real money**| §4 of that document already forbids production credentials outside production. **A restored database is full of real recipients' phone numbers**, and a drill that reaches a live SMS key sends real messages about parcels delivered months ago|
| 10| Record **elapsed recovery time**| For later RTO analysis. §40.4's 4-hour figure is a claim until a drill has timed it|

**Quarterly repeats use the same controlled runbook**, so that the drill measures the procedure rather than the person running it.

#### What the drill must record, and what makes it a PASS

`MSC-DEC-373`. **A drill that completes without producing two numbers has proved a restore is possible and nothing about whether it is fast enough.**

Each drill records: **drill start · chosen recovery point · latest verified recoverable point · calculated RPO · restore completion time · calculated RTO · PostgreSQL integrity · Evidence verification · KMS and TOTP verification · application startup · audit-integrity verification · provider-reconciliation handling · confirmation that no live SMS or payment credential is reachable from the restored environment · PASS/FAIL · operator and evidence.**

**PASS requires RPO ≤24h and RTO ≤4h.**

#### 4.4a RPO is proved against a verified recoverable point

**Not against a backup job that ran.** A completed job proves a file was written; it does not prove the file restores, that its WAL is continuous, or that the Evidence objects the database references still exist.

> qualifying incident recovery or cutover time **−** latest verified recoverable point **≤ 24 hours**

A successful recovery set includes, as applicable: **PostgreSQL base backup or snapshot · WAL/PITR material · Evidence or object recovery data, or a verified reconstruction mechanism · object-versioning state · required KMS and key access · a configuration recovery manifest · integrity and checksum evidence.** **Continuous WAL/PITR remains preferred over relying on a daily snapshot alone** — [DEPLOYMENT_AND_ENVIRONMENTS.md](DEPLOYMENT_AND_ENVIRONMENTS.md) §6 already showed that a daily snapshot meets 24 hours on paper while losing a full day of intake in practice.

#### 4.4b The RTO clock, both ends

**It starts at the earlier of:**

1. **monitoring confirming** a qualifying condition that requires recovery; or
2. **an authorised responder determining** that normal production cannot safely continue, and invoking recovery.

**Starting only at a human declaration would let a delayed incident call buy back RTO**, measuring the paperwork rather than the outage.

**It stops only when every one of these holds:**

- the core production application is **available**;
- **PostgreSQL integrity** is verified;
- required **configuration and KMS access** work;
- **Evidence and object access** is restored, or safely isolated with a known scope;
- **audit integrity** is verified;
- critical workflows **can safely resume**;
- **provider and payment events inside the loss window** are identified and placed into safe reconciliation or hold paths.

**Stopping at process startup is not recovery**, and this is step 5 above stated as a clock rule: an application that boots against a database whose payment truth has not been reconciled is a running system in an unsafe state. **Downstream reconciliation may continue after RTO only where the affected records cannot create double payment, double custody or unsafe continuation.**

**`OQ-095` closes here.** The cadence element was answered on 27 August; **the percentile and the eight volumes close on `MSC-DEC-369`, and the alert thresholds on `MSC-DEC-370`.**

## 5. Performance, capacity and the proof that they hold

### 5.1 The measurement contract

`MSC-DEC-369`. §42.8 fixes two figures and never said which percentile carries them. **A target with no percentile is not a target**: the same 3-second promise is met by a comfortable system at p50 and missed by a failing one at p99, and both readings could be reported as compliance.

|| Target|
|---|---|
| Normal connected action| **p95 ≤ 3 seconds**|
| Critical write| **p95 ≤ 5 seconds**|

**No p90 substitution, no p50 presented as compliance, and no p99 requirement added.** The last matters as much as the first — raising an approved commitment unasked is also changing it.

**What each clock measures:**

| Measure| From| To|
|---|---|---|
| **Normal connected action**| user action dispatched| authoritative resulting state presented to the user|
| **Critical write**| request reaches Melarc's public application edge| authoritative transaction commits and its result is returned|
| **Trusted provider callback**| callback reaches the public edge| authoritative state is committed and acknowledged|
| **Diagnostic server latency**| edge ingress| final response byte|

**The normal-action clock runs under a fixed, reproducible connected profile** — the *approved connected network profile* `MSC-DEC-369` names, defined here as a test fixture because a measurement taken over an unspecified network is not repeatable:

| Parameter| Fixture value|
|---|---|
| Round-trip latency| **150 ms**|
| Downstream bandwidth| **5 Mbps**|
| Upstream bandwidth| **2 Mbps**|
| Packet loss| **1%**|
| Jitter| **up to 20 ms**|

**This is a load-test fixture and nothing else.** It is **not a supported-network guarantee**, **not a minimum customer bandwidth requirement** and **not a Product SLA** — Melarc makes no promise about the network a vendor or rider happens to be on, and §40 still requires the interfaces to work on constrained connections. **It exists so that two runs of the same test are comparable.**

**Server-side latency is recorded separately on every run**, per the diagnostic row above, so a degradation caused by the fixture's own 150 ms and 1% loss stays distinguishable from a degradation in Melarc's backend. **Without that separation the fixture would hide the thing it was introduced to measure.**

**Excluded from the user-action measure, and each exclusion is measured somewhere else rather than unwatched:**

| Excluded| Why it is not Melarc latency| Where it is watched|
|---|---|---|
| Human thinking and input time| It is the person, not the product| —|
| **MoMo payer interaction time**| The recipient approving a prompt on their own handset is outside Melarc entirely (§26.4)| Payment attempt ageing|
| The **doorstep wait**| A deliberate business timer, server-derived, 10 minutes by design| `doorstep_wait_minutes` compliance|
| Asynchronous export completion| §40.3 requires progress and completion state rather than blocking| Queue oldest-message age|
| Rider offline time| The device has no connection, so there is no request to time| Offline reconciliation on reconnect|

**A slow Ghana mobile connection is not a slow Melarc backend.** Diagnostic server latency exists to tell them apart and is **recorded beside the target, never in place of it** — reporting the inner number against a target defined on the outer one is the weakening §1 says this document is where it happens.

**Reported by operation · by surface · by `NORMAL` versus `CRITICAL_WRITE` · by environment · by current release.** Production alert windows and release-test windows are **separate from the monthly availability report** and may not be substituted for it.

### 5.2 The launch capacity assumptions — all eight

§40.3 requires representative volumes for *"vendors, riders, hubs, parcels, dashboard queries, exports, files and concurrent staff"*. **All eight exist**.

| Volume| Launch assumption| Source|
|---|---|---|
| Registered vendors| **~150**| Product|
| Riders| **~10**| Product|
| Active hubs| **1**| Product|
| Parcels per day| **fewer than 50**| Product|
| Dashboard and report queries per day| **5,000**| Gate D engineering assumption|
| Exports per day| **100**| Gate D engineering assumption|
| File and Evidence operations per day| **500**| Gate D engineering assumption|
| Concurrent staff| **25**| Gate D engineering assumption|

**These are launch load-planning assumptions and nothing else** — **not contractual limits, not customer promises, not permanent capacity ceilings, not licensing limits.** The architecture must grow past them **without changing the data-isolation model**: a second hub may not require a different RLS design.


**One structural rule holds regardless of the figures** (§40.3): long-running exports and asynchronous work **show progress and completion state rather than block an interactive request.** That is a design constraint, not a tuning target, and it bound before these numbers existed.

### 5.3 The critical-write catalogue — exhaustive, by `operationId`

`MSC-DEC-369`. **Examples are not a catalogue.** This document previously named *"blind-count commit, price freeze, OTP validation, payment confirmation"*, which is a list nobody can test an operation against.

An operation is **`CRITICAL_WRITE`** when it changes or confirms **custody · money or payment · cash custody or reconciliation · authentication or security authority · privileged approval · itemization or authoritative price freeze · dispatch allocation · recipient verification and final handover · failed-delivery attribution where attempt or custody state changes · Return or redelivery obligation · an immutable audit-sensitive override.**

**`ASYNC`** is an operation whose **authoritative work completes after the response** and whose progress or completion is **tracked by a contracted mechanism**; its promise is progress and completion state, and it is watched by **queue age** rather than by the interactive target. **`NORMAL`** is everything else.

**A `202` is not evidence of that, and treating it as evidence is the defect D-R1 corrected.** `202` describes what the response body does not carry; it says nothing about whether the request already committed the fact that matters. **Classification follows the clock, not the status code.** Five operations were classed `ASYNC` on their status code alone, and contract inspection shows each commits its authoritative effect **inside** the request: `requestCredentialRecovery` creates the `RecoveryRequest`, `requestDeliveryOtp` commits the OTP verification-path state behind the payment gate, `requestSmsHandshakeFallback` commits fallback verification state that gates custody confirmation, and `requestVerificationFallback` creates the audited fallback request. `submitVendorContactAssistance` records Vendor input synchronously and authorises nothing, so it is `NORMAL`.

**`ASYNC` has no members, and the reason changed on 23 September 2026. It is now UNREACHABLE rather than merely unpopulated, and the obstacle is in contract-consistency validation's rule.** The first export operation has been added — `requestAccountingExport` (`MSC-DEC-401`, [openapi.yaml](../contracts/openapi.yaml) 5.43) — and it did **not** get the class, which is the outcome the superseded sentence below was written to prevent. It is classified `CRITICAL_WRITE`.

**contract-consistency validation's D-R2 rule admits `ASYNC` by two routes, and this contract can satisfy neither.** The first is a declared `callbacks` block; **no operation in the contract declares one**, and contracting a provider webhook for an export is not this design. The second needs **both** a 2xx response property named `<job|task|export|report|operation|batch>_id` **and a path parameter whose name contains that property's stem**. Every resource path parameter in this contract is `{id}` — [openapi.yaml](../contracts/openapi.yaml)'s shared `Id` parameter, carried by **101 of the 140 operations**, while **35 take no path parameter at all** and the remaining **four** use `{riderId}` (3) or `{code}` (1). **The contract's entire path-parameter vocabulary is those three names** — `id`, `code`, `riderId` — which is the fact the conclusion rests on, rather than how many operations carry each. **None of the six stems is a substring of `id`, `code` or `riderid`**, so the second half of the rule cannot be satisfied by any operation in this contract, whatever its response carries. **The class is therefore closed to the whole contract, not just to this operation.**

**`requestAccountingExport` IS asynchronous, and the classification records what the check can recognise rather than what the operation is.** It commits an `AccountingExport` in `REQUESTED` and nothing else; the package, its manifest and its digest are produced **after the response, with no caller present**, and `status` advances `REQUESTED → GENERATED`/`FAILED` without anybody waiting. `getAccountingExport` **is** the completion-polling path — it reports `status`, `generated_at`, `row_counts`, `manifest_digest` and `failure_reason_code` on the handle the request returned — and it is precisely the mechanism the superseded sentence says the contract had none of. **Both halves of this section's own `ASYNC` definition are met.** §40.3 requires long-running work to show progress and completion state rather than block, and a package covering a month of a busy hub is not interactive work.

**The gap is in the rule, not in the design, and it was not closed by bending the contract.** Satisfying `HANDLE` would mean renaming this path parameter to `{accounting_export_id}` and adding a duplicate handle property to the response — making this **the only named resource path parameter among 140 operations** — to fit a regex. That is changing the contract to fit the tool, and this document's own §5.3 warns in the next paragraph that classification follows the clock rather than the status code, for the same reason. **`CRITICAL_WRITE` is defensible on this catalogue's own precedent** — `createEvidence` carries it for issuing a short-lived single-object capability, and this operation writes the record that authorises payment facts to leave the platform under an Enhanced audit event (§38.5 category 8). **It is reversible in one line if the rule is widened**, which is the remedy this note recommends and which belongs to the check's own review, not to this pass.


**Every operation in [openapi.yaml](../contracts/openapi.yaml) carries exactly one class, and the implementation must verify it** — every catalogued id exists in the contract, every contract id is catalogued, and none is classified twice. **A new critical operation cannot be added without a performance classification.**

**172 operations: 109 `CRITICAL_WRITE` · 0 `ASYNC` · 63 `NORMAL`.**

| `operationId`| Class| Why|
|---|---|---|
| `acceptRunCustodyHandover`| `CRITICAL_WRITE`| custody transfer completes|
| `adjudicateDiscrepancy`| `CRITICAL_WRITE`| OS&D adjudication over custody and liability|
| `approveAgent`| `CRITICAL_WRITE`| privileged approval of an informal agent, who may then take custody of a parcel|
| `approveBundleChange`| `CRITICAL_WRITE`| privileged approval of granted authority|
| `approveOnePackageException`| `CRITICAL_WRITE`| privileged approval carrying a fee|
| `approveStaffIdentity`| `CRITICAL_WRITE`| privileged approval activating an identity|
| `arriveAtDeliveryStop`| `NORMAL`| —|
| `arriveAtPickupStop`| `NORMAL`| Classified with its delivery counterpart. **The counter-argument is real and is recorded rather than dismissed**: this transition closes the cancellation window, so what a vendor is charged for a later cancellation turns on it. It stays `NORMAL` because **this catalogue classifies the clock and the proof obligation, not the importance** — a rider flipping a stop to `ARRIVED` moves no custody, no money and no allocation, and its latency profile is the delivery arrival’s. The commercial consequence is carried by `pickup.stop.arrived` in the audit catalogue, which is where auditability belongs|
| `assessParcelHandling`| `NORMAL`| —|
| `assignDeliveryRider`| `CRITICAL_WRITE`| dispatch allocation|
| `assignRider`| `CRITICAL_WRITE`| dispatch allocation|
| `authoriseDeliveryWithoutOtp`| `CRITICAL_WRITE`| authorised override of the delivery verification gate|
| `authoriseHandshakeOverride`| `CRITICAL_WRITE`| authorised override of a verification gate|
| `authorizePaymentFallbackWhileUnresolved`| `CRITICAL_WRITE`| authorised money path while a demand is unresolved|
| `beginMfaReenrolment`| `CRITICAL_WRITE`| security authority — begins re-enrolment|
| `cancelPickupRequest`| `CRITICAL_WRITE`| may raise a cancellation charge|
| `cancelRedelivery`| `CRITICAL_WRITE`| voids a redelivery obligation|
| `clearOutboundForDispatch`| `CRITICAL_WRITE`| opens the handoff record that fixes the commercial mode; a re-dispatch is the outbound counterpart of `scheduleRedelivery`|
| `closeDeliveryStopDelivered`| `CRITICAL_WRITE`| final handover; custody ends|
| `closeHubIntake`| `CRITICAL_WRITE`| itemization closes and becomes authoritative|
| `closeReturnHandover`| `CRITICAL_WRITE`| final handover to the outbound transport; custody ends, mirroring `closeDeliveryStopDelivered`|
| `completeAdditionalDeviceEnrolment`| `CRITICAL_WRITE`| registers an additional browser credential — the `RegisteredDevice` is authoritative and created in the request|
| `completeCredentialRecovery`| `CRITICAL_WRITE`| security authority — establishes a credential|
| `completeEvidenceUpload`| `NORMAL`| —|
| `completeMfaEnrolment`| `CRITICAL_WRITE`| activates a second factor|
| `completeRiderDeviceEnrolment`| `CRITICAL_WRITE`| completes a device binding|
| `completeStaffCredentialSetup`| `CRITICAL_WRITE`| establishes a permanent credential|
| `completeStaffMfaSignIn`| `CRITICAL_WRITE`| authentication authority|
| `completeVendorCredentialSetup`| `CRITICAL_WRITE`| establishes a Vendor credential|
| `confirmCashHandover`| `CRITICAL_WRITE`| physical cash custody|
| `confirmManualPayment`| `CRITICAL_WRITE`| money — independent confirmation of a receipt|
| `confirmPickupRequest`| `NORMAL`| —|
| `createAccountingExportRetrievalAuthorization`| `CRITICAL_WRITE`| issues a short-lived single-object retrieval capability over a payment-ledger package — classified with `createEvidenceRetrievalAuthorization`, which it mirrors operation for operation|
| `createDeliveryRun`| `NORMAL`| —|
| `createEvidence`| `CRITICAL_WRITE`| issues a short-lived single-object upload capability|
| `createEvidenceRetrievalAuthorization`| `CRITICAL_WRITE`| issues a short-lived single-object retrieval capability|
| `createPickupManifest`| `NORMAL`| —|
| `createPickupRequest`| `NORMAL`| —|
| `createRoadExpense`| `CRITICAL_WRITE`| money — records an expense obligation|
| `createStaffIdentity`| `CRITICAL_WRITE`| creates an identity under maker-checker|
| `createVendorPickupLocation`| `NORMAL`| —|
| `createVendorOrganization`| `CRITICAL_WRITE`| creates a vendor record and its shared portal account under maker-checker|
| `deactivateCourierProvider`| `CRITICAL_WRITE`| withdraws an approval every registered handoff depends on|
| `decideHeldParcelDisposition`| `CRITICAL_WRITE`| custody decision over another party's goods, hub-scoped and reasoned|
| `deactivateVendorPickupLocation`| `NORMAL`| —|
| `decideVendorOrganization`| `CRITICAL_WRITE`| privileged approval that confers operational standing, and issues the one credential setup grant|
| `decideAdjustmentResolution`| `CRITICAL_WRITE`| privileged approval that moves money out, and it resolves the adjustment — the class `decideRoadExpense` already holds, for the same reason|
| `decideDeliveryLocationChange`| `CRITICAL_WRITE`| authorised change to the delivery obligation|
| `decideRoadExpense`| `CRITICAL_WRITE`| privileged approval of money|
| `dispatchDeliveryRun`| `CRITICAL_WRITE`| atomic dispatch — one failed gate rolls the run back|
| `disableVendorAllowance`| `CRITICAL_WRITE`| withdraws a financial standing — the commercial gate reads it on the next priced order|
| `dispatchManifest`| `CRITICAL_WRITE`| dispatch allocation, atomic|
| `escalatePickupRequest`| `NORMAL`| —|
| `enableVendorAllowance`| `CRITICAL_WRITE`| extends a financial standing against the global limit — Platform Admin only|
| `escalateHeldParcel`| `CRITICAL_WRITE`| privileged exceptional disposition of goods in custody — Platform Admin only|
| `escalateRecipientConfirmation`| `NORMAL`| —|
| `extendPickupAttempts`| `CRITICAL_WRITE`| authorised override of an approved ceiling|
| `failDeliveryStop`| `CRITICAL_WRITE`| failed-delivery attribution; custody stays with the Rider|
| `getAccountingExport`| `NORMAL`| — A metadata read. It moves no custody, money or allocation, and it reaches no package: the bytes are behind `createAccountingExportRetrievalAuthorization`|
| `getCurrentSession`| `NORMAL`| —|
| `getRider`| `NORMAL`| — The rider roster's detail read, and the `ETag` source `reregisterRiderDevice` takes. Identity and readiness only; it moves no custody, money or allocation|
| `getStaffIdentity`| `NORMAL`| — The `ETag` source for the staff-targeted mutations. A read; it moves nothing|
| `getVendorAccount`| `NORMAL`| — The `ETag` source for the vendor-targeted mutations. Readiness only, never a credential|
| `getDailyOperationsCashReport`| `NORMAL`| A `DERIVED-PROJECTION` read (`domain-model.md` §6.13) — moves no custody, money or allocation|
| `getCarrierHandoff`| `NORMAL`| —|
| `listApprovedAgents`| `NORMAL`| —|
| `listCarrierHandoffs`| `NORMAL`| —|
| `listCourierProviders`| `NORMAL`| —|
| `listRunCustodyHandovers`| `NORMAL`| —|
| `openParcelCustodyReturn`| `CRITICAL_WRITE`| —|
| `confirmParcelCustodyReturn`| `CRITICAL_WRITE`| —|
| `reactivateCourierProvider`| `CRITICAL_WRITE`| restores an approval to receive custody|
| `recordHandoffOutcome`| `CRITICAL_WRITE`| covered-mode outcome — `DELIVERED` earns the charge and `RETURNED` brings custody back|
| `registerCourierProvider`| `CRITICAL_WRITE`| privileged approval — an entry may receive custody from registration|
| `resolveParcelCustodyVariance`| `CRITICAL_WRITE`| —|
| `getParcelCustodyReturn`| `NORMAL`| —|
| `listParcelCustodyReturns`| `NORMAL`| —|
| `getDeliveryRun`| `NORMAL`| —|
| `getHubIntake`| `NORMAL`| —|
| `listHubIntakes`| `NORMAL`| —|
| `acquireIntakeLock`| `NORMAL`| advisory — the count's own transition and idempotency guards decide the outcome (§22.8)|
| `getPaymentCollection`| `NORMAL`| —|
| `getPickupManifest`| `NORMAL`| —|
| `getPickupRequest`| `NORMAL`| —|
| `getRecipientConfirmation`| `NORMAL`| —|
| `getRunCashSummary`| `NORMAL`| —|
| `getStopPaymentDemand`| `NORMAL`| —|
| `getVendorOperationalEligibility`| `NORMAL`| —|
| `initiateHandshake`| `CRITICAL_WRITE`| sender verification gates collection|
| `initiatePaymentCollection`| `CRITICAL_WRITE`| money — commits a PaymentAttempt|
| `initiateReturn`| `CRITICAL_WRITE`| Return obligation — commits a `ReturnRecord`, snapshots the fee and derives the settlement path|
| `initiateRunCustodyHandover`| `CRITICAL_WRITE`| custody transfer opens|
| `itemizeOrder`| `CRITICAL_WRITE`| authoritative price freeze|
| `listAccountingExports`| `NORMAL`| —|
| `listAssignableStaffRoleBundles`| `NORMAL`| — The bundles `createStaffIdentity` may name. A read of configuration; it moves no custody, money or allocation, and returns no permission and no holder|
| `listDeliveryCommitments`| `NORMAL`| —|
| `listDeliveryRuns`| `NORMAL`| —|
| `listHubCashReconciliations`| `NORMAL`| —|
| `listOperationalPaymentDemands`| `NORMAL`| —|
| `listPickupManifests`| `NORMAL`| —|
| `listPickupRequests`| `NORMAL`| —|
| `listVendorDevices`| `NORMAL`| —|
| `listRiders`| `NORMAL`| — A hub-scoped roster read|
| `listSessions`| `NORMAL`| — The read `revokeSession` needs; no credential, hash or bundle contents|
| `listStaffIdentities`| `NORMAL`| — The approver's queue|
| `listVendorAccounts`| `NORMAL`| — A hub-scoped account read|
| `listReasonDefinitions`| `NORMAL`| —|
| `listRedeliveries`| `NORMAL`| —|
| `listRoadExpenses`| `NORMAL`| —|
| `openCashHandover`| `CRITICAL_WRITE`| physical cash custody|
| `overrideServiceWindow`| `CRITICAL_WRITE`| authorised override of the customer service window|
| `proposeAdjustmentResolution`| `CRITICAL_WRITE`| commits how money owed back will be resolved — an authorised financial act, even though nothing moves until it is approved|
| `proposeBundleChange`| `CRITICAL_WRITE`| proposes a change to granted authority|
| `reassignPickupRequestHub`| `CRITICAL_WRITE`| moves the authoritative responsible Hub|
| `receiveHubtelPaymentCallback`| `CRITICAL_WRITE`| provider-authoritative payment truth is committed and acknowledged|
| `recordCashDisposition`| `CRITICAL_WRITE`| physical cash leaves custody|
| `recordCarrierHandoff`| `CRITICAL_WRITE`| custody leaves Melarc entirely, and a Station Drop fee is earned at that instant|
| `recordCollection`| `CRITICAL_WRITE`| custody — parcels pass from sender to Rider|
| `recordConfirmationAttempt`| `NORMAL`| —|
| `recordDoorstepContact`| `NORMAL`| —|
| `recordHubCashCount`| `CRITICAL_WRITE`| cash reconciliation|
| `recordNextStopContact`| `NORMAL`| —|
| `recordRecipientCashPayment`| `CRITICAL_WRITE`| money and physical cash custody|
| `reactivateVendor`| `CRITICAL_WRITE`| restores commercial standing and resumes every held item in one act|
| `recoverStaffCredential`| `CRITICAL_WRITE`| privileged credential recovery|
| `recoverVendorCredential`| `CRITICAL_WRITE`| privileged credential recovery|
| `registerRiderDevice`| `CRITICAL_WRITE`| binds a device identity|
| `reissueStaffCredentialSetup`| `CRITICAL_WRITE`| privileged act issuing a fresh setup grant|
| `reissueVendorCredentialSetup`| `CRITICAL_WRITE`| privileged act issuing a fresh setup grant|
| `reportPickupFailure`| `CRITICAL_WRITE`| failed-attempt attribution; custody does not pass|
| `openSecurityRiskHold`| `CRITICAL_WRITE`| Restricts a vendor's new business; Enhanced-audited|
| `clearSecurityRiskHold`| `CRITICAL_WRITE`| Lifts that restriction once no other hold is open|
| `listSecurityRiskHolds`| `NORMAL`| —|
| `skipPickupStop`| `CRITICAL_WRITE`| **Terminal for the stop, and it unblocks run completion** — §4's guard needs every stop terminal. Notifies the Vendor|
| `requestAccountingExport`| `CRITICAL_WRITE`| writes the `AccountingExport` record that authorises payment facts to leave the platform, under an Enhanced audit event (§38.5 category 8) — classified with `createEvidence`, which carries the class for issuing a short-lived single-object capability. **This operation is substantively `ASYNC` and the class could not be applied**: its authoritative work completes after the response, `status` advances `REQUESTED → GENERATED`/`FAILED` with no caller present, and `getAccountingExport` is the completion-polling path — but contract-consistency validation's `HANDLE` rule is unsatisfiable by any operation in this contract (see the `ASYNC` note above). **Reversible in one line if that rule is widened**|
| `requestAdditionalDeviceGrant`| `CRITICAL_WRITE`| security authority — the authoritative `SetupGrant` is created in the request, the same reasoning `requestCredentialRecovery` uses and the same reason a `202` does not make it `ASYNC`|
| `requestCredentialRecovery`| `CRITICAL_WRITE`| security authority — where the principal exists the authoritative `RecoveryRequest` is created in the request|
| `requestDeliveryLocationChange`| `NORMAL`| —|
| `requestDeliveryOtp`| `CRITICAL_WRITE`| the payment gate and the OTP verification-path state are authoritative handover work|
| `requestOnePackageException`| `NORMAL`| —|
| `requestReturnOtp`| `CRITICAL_WRITE`| the return-fee gate and the OTP verification-path state are authoritative handover work, mirroring `requestDeliveryOtp`|
| `requestRiderSignInChallenge`| `CRITICAL_WRITE`| issues a challenge whose nonce a failure consumes|
| `requestSmsHandshakeFallback`| `CRITICAL_WRITE`| fallback verification state gates pickup custody confirmation|
| `requestVerificationFallback`| `CRITICAL_WRITE`| creates the authoritative audited fallback request feeding the controlled verification exception|
| `reregisterRiderDevice`| `CRITICAL_WRITE`| rebinds a device identity|
| `resetStaffMfa`| `CRITICAL_WRITE`| privileged security act|
| `resolveCashVariance`| `CRITICAL_WRITE`| cash reconciliation|
| `resolveHubCashVariance`| `CRITICAL_WRITE`| cash reconciliation|
| `reviseDeliveryCommitment`| `CRITICAL_WRITE`| revises an authoritative customer commitment, with attribution|
| `revokeVendorDevice`| `CRITICAL_WRITE`| security authority — removes a registered browser credential and terminates the session bound to it|
| `revokeRiderDevice`| `CRITICAL_WRITE`| security authority — revokes a device binding|
| `revokeSession`| `CRITICAL_WRITE`| security authority — revokes a Session|
| `riderSignIn`| `CRITICAL_WRITE`| authentication authority|
| `scheduleRedelivery`| `CRITICAL_WRITE`| creates a redelivery obligation with snapshotted charges|
| `setDeliveryStopOrder`| `NORMAL`| —|
| `setDefaultVendorPickupLocation`| `NORMAL`| —|
| `setManifestStopOrder`| `NORMAL`| —|
| `signOut`| `CRITICAL_WRITE`| ends a Session|
| `staffSignIn`| `CRITICAL_WRITE`| authentication authority|
| `startDeliveryRun`| `CRITICAL_WRITE`| custody — the Rider takes the delivery run|
| `startRun`| `CRITICAL_WRITE`| custody — the Rider takes the run|
| `suspendVendor`| `CRITICAL_WRITE`| blocks a login, terminates sessions and places every non-terminal item in custody hold|
| `submitBlindCount`| `CRITICAL_WRITE`| the blind count is authoritative and unrepeatable|
| `updateVendorPickupLocation`| `NORMAL`| —|
| `submitHubHandover`| `CRITICAL_WRITE`| custody returns to the Hub|
| `submitVendorContactAssistance`| `NORMAL`| records Vendor input synchronously; Ops decides authority later, and this call is not itself an asynchronous job|
| `upsertReasonDefinition`| `CRITICAL_WRITE`| governs the Reason Catalogue every failure path cites|
| `vendorSignIn`| `CRITICAL_WRITE`| authentication authority|
| `verifyHandshake`| `CRITICAL_WRITE`| verification decides whether custody may pass|
| `terminateVendor`| `CRITICAL_WRITE`| ends the relationship; obligations survive and no balance is closed|
| `waiveCancellationCharge`| `CRITICAL_WRITE`| money, by privileged waiver|
| `withdrawAgentApproval`| `CRITICAL_WRITE`| withdraws an agent's approval to take custody|

**Seven operations return `202` and every one of them is `CRITICAL_WRITE` or `NORMAL`, because the clock decides the class and the status code does not.** `receiveHubtelPaymentCallback` commits provider-authoritative payment truth and acknowledges it — §5.1 gives a callback its own critical-write clock. `staffSignIn` returns `202` when a second factor is required, which is an authoritative step in an authentication it has not finished. The remaining five are the rows D-R1 reclassified above. **A `202` describes what the response body promises, not whether the request committed something that matters** — and contract-consistency validation now refuses an `ASYNC` classification that rests on a status code.

### 5.4 The capacity proof model

| Run| Shape| Passes when|
|---|---|---|
| **Baseline 1×**| The complete approved launch workload of §5.2| p95 targets hold · no unexpected 5xx · no duplicate business effect · no lost asynchronous work · **no cross-Hub, Vendor or Rider leakage** · no monotonic queue-age growth · database and worker capacity bounded|
| **Peak 3×**| 3× request and burst rate for **30 minutes**, up to **75 concurrent staff-equivalent**, with proportionate compression of files, dashboards and queued work| p95 still met · **no incorrect business failure** · queue and backpressure remain recoverable|
| **Soak 2×**| **4 hours**| p95 holds · memory and connection use do not grow without bound · queue age returns to baseline · **retries do not multiply business effects** · no progressive degradation|
| **Stress to degradation**| Increase until one or more limits are observed| Establishes the actual ceiling, names the **first constrained resource**, and validates graceful degradation. **The discovered ceiling is diagnostic and is not a Product promise**|

**A scenario is not a PASS because HTTP requests returned.** Every run verifies **business invariants** afterwards, and §37.6's negative-access tests run **under concurrency** — **a performance optimisation that bypasses RLS is rejected automatically**, not traded off against latency.

### 5.5 The load and resilience scenario matrix

**Fifteen scenarios, and the last eleven are the ones that decide whether Melarc degrades safely.**

| #| Scenario| What it must prove|
|---|---|---|
| 1| Ordinary launch workload| §5.4 baseline criteria|
| 2| **3× peak for 30 minutes**| §5.4 peak criteria|
| 3| **2× soak for 4 hours**| §5.4 soak criteria|
| 4| Dashboard, filter and report load| Read load does not starve write paths|
| 5| Asynchronous export burst| Bulk work does not starve recovery or operational queues|
| 6| Evidence and file burst, at the §5.2 volume and the §5.5a byte profile| Object-service throughput and the short-lived capability path hold|
| 7| **All launch Riders reconnecting after offline work**| No duplicate business effect on replay; idempotency keys hold|
| 8| Scheduled-job collision at business schedule boundaries| Jitter works; simultaneous clock jobs do not retry in lockstep|
| 9| Queue backlog| Oldest-message age drives scale-out and returns to baseline|
| 10| **Broker unavailable**| Outbox intent persists; nothing is marked published before acknowledgement (§3.2b)|
| 11| **SMS provider degraded or down**| The Ops-assisted fallback completes handovers; **no global OTP bypass appears**|
| 12| **Payment provider slow, down, or returning an unknown result**| **No blind retry**; `STATUS_UNKNOWN` reconciliation engages (§3.2a)|
| 13| Database latency or degradation| Bounded worker concurrency protects the connection budget|
| 14| Worker crash and restart| Partial work resumes idempotently; no duplicated effect|
| 15| Stress to limit| §5.4 stress criteria|

### 5.5a The Evidence and file workload fixture — D-R1

**500 file operations a day is a count, not a workload.** Five hundred 1 MiB captures and five hundred 15 MiB captures are different tests of the object service, the signed-capability path and the network, and the §5.2 volume alone does not say which one was run.

| Share of operations| File size|
|---|---|
| **70%**| **1 MiB**|
| **25%**| **5 MiB**|
| **5%**| **15 MiB**|

Every file is a **valid** test artifact with approved MIME type, signature and checksum behaviour, so the run exercises the accept path rather than the rejection path. **Scenario 6 uses this distribution at baseline, peak and soak scale.**

**This is a performance test fixture and must not be read as the platform's upload-size limit.** No Product rule here sets a maximum Evidence file size, and this distribution does not create one — it describes what the load test sends, not what the product accepts.

**Scenarios 11 and 12 are Gate C regressions as much as load tests.** An outage is exactly when someone proposes a shortcut, and these two exist to prove the approved paths hold under pressure rather than to measure throughput.

## 6. What this document does not settle

| Item| Why| Owner|
|---|---|
| Retention of logs, traces and metrics| Personal data is in scope| `OQ-028` — legal|
| Monitoring product| Implementation choice| Backend Engineer|
| **Whether the launch load tests and the pre-launch restore drill have passed**| **They have not been run.** Gate D specifies their inputs, procedure and pass/fail criteria so implementation cannot invent them — **running them is a release blocker**, not a documentation one| [IMPLEMENTATION_PLAN.md](../delivery/IMPLEMENTATION_PLAN.md)|

**Four rows left this table at Gate D, and each left by being decided rather than by being dropped:**

| Item| Closed by|
|---|---|
| ~~Availability denominator~~| **`MSC-DEC-256`**, 26 August — operating hours, with the window at `MSC-DEC-257`. This table carried it as open for eleven days afterwards|
| ~~Alert thresholds~~| **`MSC-DEC-370`** — §3.2|
| ~~Restore-test cadence~~| **`MSC-DEC-284`**, 27 August — §4.4|
| ~~Representative volumes~~| **`MSC-DEC-369`** — §5.2|

## 7. Related

[BACKGROUND_JOBS_AND_EVENTS.md](BACKGROUND_JOBS_AND_EVENTS.md) · [DEPLOYMENT_AND_ENVIRONMENTS.md](DEPLOYMENT_AND_ENVIRONMENTS.md) · [SECURITY_DESIGN.md](SECURITY_DESIGN.md) · [audit.md](../contracts/audit.md)

---

## 5. Security Incident Response Plan

*Added 13 September 2026 — CRIT-12 audit remediation.*

**This plan is the authoritative incident response procedure.** It is not guidance and it is not a template — it is what happens. Deviation requires Incident Commander sign-off and is logged as an incident action.

### 5.1 Incident classification

| Severity| Definition| Example|
|---|---|---|
| **P0 — Active breach**| Confirmed unauthorised access to production data or live systems| Compromised admin credential with active use; confirmed data exfiltration; attacker-controlled admin session|
| **P1 — Suspected breach**| Strong indicators of compromise, not yet confirmed| Anomalous high-volume API access pattern; unexpected privilege escalation; admin action from unusual location|
| **P2 — Security defect**| Vulnerability identified, not yet exploited| OWASP finding from test; misconfiguration detected in audit; exposed secret in log|

**P0 and P1 activate this plan immediately.** P2 is handled through normal sprint prioritisation unless the window for exploitation is imminent, in which case it is elevated to P1.

### 5.2 Command roles

| Role| Responsibility| On-call|
|---|---|---|
| **Incident Commander**| Platform Admin or CTO. Single decision authority for the duration. Declared at P0/P1 onset — every action from that moment requires their knowledge.| Yes|
| **Security Lead**| Leads technical investigation and containment. Produces timeline of events for Legal.| Yes|
| **Legal/Compliance**| Regulatory notification decisions and external communication sign-off. Invoked immediately on P0.| On-call via email|
| **Communications Lead**| Vendor and customer-facing communication. Drafts; Legal signs off.| On-call via email|

**No action that changes production state happens without the Incident Commander's knowledge.** This includes account revocations, secret rotations, service isolations and database operations.

### 5.3 Detection and triage (0–1 hour)

1. **Source identification:** audit log anomaly alert (SECURITY_DESIGN.md §15.1), external security report, staff observation, or monitoring alert.
2. **Create an incident ticket** — private, time-stamped, accessible only to the response team.
3. **Classify severity** using §5.1. If uncertain between P0 and P1, classify P0 and step down if evidence supports it.
4. **Page the Incident Commander.** If unreachable within 15 minutes, escalate to CTO.
5. **Do not remediate before the Incident Commander is briefed** — premature containment can destroy forensic evidence.

### 5.4 Containment (1–4 hours)

**P0 — Active breach:**
- Immediately revoke all active sessions for affected principals (Platform Admin capability `session.revoke_all`).
- Rotate compromised secrets using the rotation procedure in SECURITY_DESIGN.md §15.5.
- If a service or database is confirmed as the entry point: isolate it at the network layer. Incident Commander authorises this.
- Preserve all audit log checkpoints before any write operation that could affect the chain.

**P1 — Suspected breach:**
- Increase audit log monitoring frequency; set up real-time streaming to the response team's channel.
- Freeze suspect accounts: set `RiderIdentity.status`, `StaffIdentity.status`, or `VendorAccount.status` to `SUSPENDED` with reason `SECURITY_INVESTIGATION`. This ends the principal's live sessions in the same transaction, because a revocation is a `Session` state change ([SECURITY_DESIGN.md](SECURITY_DESIGN.md) §15.3).
- Do not alert the suspect account holder until the Incident Commander decides.

### 5.5 Evidence preservation

- **Snapshot the audit log** and its integrity checkpoint immediately on P0/P1 declaration, before any remediation that could affect it.
- **Preserve application logs, reverse-proxy logs, and database connection and audit logs** in an immutable, time-locked S3 bucket for the duration of the incident plus 90 days.
- **Do not delete, modify, or overwrite any data** until Legal/Compliance gives written sign-off.
- **Document every action taken** in the incident ticket with actor, timestamp, and reason. This is the forensic record.

### 5.6 Regulatory notification

**72-hour window.** From the moment of awareness of a personal data breach, Melarc has 72 hours to notify the relevant supervisory authority.

| Jurisdiction| Authority| Notification deadline|
|---|---|---|
| Ghana| Data Protection Commission (DPC)| 72 hours from awareness|
| European users *(if applicable)*| Lead Supervisory Authority under GDPR| 72 hours from awareness|

**Notification must include:**
- Nature of the breach (what happened)
- Categories and approximate number of data subjects affected
- Categories and approximate number of personal data records affected
- Contact point for the authority (Legal/Compliance)
- Likely consequences of the breach
- Measures taken or proposed to address the breach

**Legal/Compliance is solely responsible** for drafting and submitting the notification. The Incident Commander provides the technical facts; Legal/Compliance translates them into the required format.

**Subject notification.** Where the breach is likely to result in high risk to individuals, data subjects must also be notified — content, timing and channel require Legal/Compliance decision.

### 5.7 Vendor and customer communication

- **Communications Lead drafts** the notification after the Incident Commander confirms the facts.
- **Legal/Compliance signs off** before any external communication is sent.
- **No communication template is stored here** — a template in a public document is an advance notice to an attacker.
- **Vendors are notified if their data was involved** — through their registered email, not through the Vendor PWA session that may be compromised.

### 5.8 Post-incident review

**Mandatory within 5 business days of incident containment.** The review is not optional and is not deferred to a "lessons-learned" backlog.

**Required outputs:**
1. **Root cause** — the specific technical or process failure that allowed the incident.
2. **Timeline** — detection, escalation, containment, notification, and resolution — with actor and timestamp for each.
3. **Remediation actions** — specific, assigned, time-bounded.
4. **Process improvements** — what changes to monitoring, access controls, or procedures would have prevented or reduced the incident.

**The review document is retained as an audit record** for at least 3 years, or the relevant legal retention period if longer.
