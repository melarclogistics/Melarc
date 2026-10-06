# Deployment and Environments

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.15 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** environments, release path, secrets handling, backup and recovery, and the observability that proves the §42.8 targets are met
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../PROJECT_MASTER_SPECIFICATION.md) §42.8, §39.9, §37.8, §33.3, §35.9.4

## 1. What this document is

The fourth of the six artifacts `MSC-DEC-205` created a home for, and the one §37.8 was still waiting on. It carries **no product authority** (§42.7): if it appears to change a rule, it is wrong and the contradiction gets registered.

**Every performance and recovery number here is approved, not chosen.** §42.8 fixes them and this document implements them. Where a figure is *not* in §42.8, it is marked as engineering judgement and flagged in §9.

## 2. The targets, and what each one forces

§42.8, verbatim: *"99.5% monthly availability, 3-second normal-action, 5-second critical-write, daily-backup, 24-hour RPO and 4-hour RTO."*

| Target| Value| What it actually forces|
|---|---|---|
| Availability| **99.5% monthly**| ~3h 39m of permitted downtime per month. Comfortably single-region; **no multi-region complexity is justified**|
| Normal action| **3 seconds**| Ordinary reads and writes. Achievable on modest hardware with correct indexing|
| Critical write| **5 seconds**| Blind-count commit, price freeze, OTP validation, payment confirmation|
| Backup| **daily**| Plus continuous WAL archiving — see §6, where daily alone is insufficient|
| **RPO**| **24 hours**| Maximum tolerable data loss|
| **RTO**| **4 hours**| Maximum tolerable time to restore|

**Read the availability target honestly.** 99.5% is a modest target and that is appropriate: Melarc runs Monday–Saturday, roughly 07:00–18:00 local. **The system is not load-bearing overnight**, so a two-hour window at 02:00 costs the business nothing and consumes a third of the monthly allowance on paper. Availability is therefore measured against **operating hours**, not the calendar — otherwise routine maintenance looks like failure and genuine daytime outages look survivable.

**That was this document's proposal and it is now an approved rule.** `MSC-DEC-256` approved the relaxation on **26 August**, `MSC-DEC-257` fixed the window at **Monday–Saturday 07:00–18:00 `Africa/Accra`**, and `OQ-068` closed with them. **The Product Owner took the decision, not this document** — which is what §9 raising it as a question was for. The denominator is about **286 hours a month**, so 99.5% permits roughly **86 minutes** of downtime rather than 219.

**Planned maintenance inside the operating window counts as downtime**, and maintenance outside it does not consume the denominator. **The window already leaves 132 hours a week free**, so an exclusion would buy nothing and would cost the property that makes the figure honest.

**The RPO and RTO are the demanding pair, not availability.** A 24-hour RPO with daily backups alone means a failure at 17:00 loses a full day of intake — every count, every price freeze, every collection. §6 addresses that gap directly.

## 3. Environments

| Environment| Purpose| Data|
|---|---|---|
| **Local**| Development| Seeded fixtures. **Never production data**|
| **Staging**| Integration, UAT, the §45.1 demonstration| Seeded, plus sandbox integrations|
| **Production**| Live| Real|

**Three, not four.** A separate QA tier would need staffing this team does not have, and an environment nobody exercises is worse than absent — it drifts and then gets trusted.

**Staging must be able to run the §45.1 demonstration end to end.** §45.1 requires the Product Owner to demonstrate normal and exception paths, and `SLICE-001` §6 scripts twelve steps plus nineteen exception rows. That is the real sizing requirement for staging, not a general "production-like" aspiration.

**Region: Africa or Europe, decided on measured latency to Accra.** No retained specification sets a network-quality target for the web surfaces; §7.8 and §41.4 ask only the Rider application to tolerate unreliable connectivity. Ghanaian traffic commonly routes via Europe, so a European region may genuinely beat a nominally closer one. **This must be measured before it is chosen** — no figure is asserted here.

## 4. Sandbox integrations are mandatory, not convenient

§39.9 requires **sandbox/testing support** for every external integration. Three matter at launch:

| Integration| Why a sandbox is non-negotiable|
|---|---|
| **SMS provider**| The OTP is the **ordinary mandated proof of delivery** (§19.6), and an outage is **recoverable rather than terminal**: where the recipient is present, an **authorised Ops-assisted verification fallback** completes the handover.|
| **Transactional email provider**| Every staff setup grant, recovery link and MFA re-enrolment link, and every vendor setup grant **whose `delivery_channel` is `EMAIL`**, reaches its principal through it ([SECURITY_DESIGN.md](SECURITY_DESIGN.md) §13.9a); **a vendor whose `delivery_channel` is `PHONE` is reached through the SMS provider instead**. A test that sent through the real provider would deliver a **live credential link to a real person**. In Local and Staging the **capture adapter** writes each message to a developer-visible sink and reaches nobody|
| **Hubtel MoMo**| Payment confirmation gates dispatch. Testing against production moves real money|

**No environment but production may hold production credentials.** A staging system holding a live SMS key will eventually send a live message to a real recipient during a test.

## 5. Secrets

§33.3 and §35.9.4: security-sensitive values **are not business settings** and are never administered through the settings mechanism. `SECURITY_DESIGN.md` §9 states the rule; this section supplies the mechanics §39.9 asks for.

| Property| Rule|
|---|---|
| **Storage**| A managed secret store. **Never in the database, never in the repository, never in `contracts/settings.md`**|
| **Access**| Service identity only. **No human reads a production secret in normal operation**|
| **Rotation**| Provider credentials **quarterly** and **immediately on suspected compromise or staff offboarding**. Signing keys support overlapping validity so rotation needs no downtime|
| **Audit**| Access and rotation are recorded. **The value is never recorded** — the same rule that governs OTPs (§20.4)|
| **Offboarding**| §30 staff offboarding triggers rotation of every secret that person could reach. This is an **operational runbook step**, not an automatic consequence, and it must appear in the offboarding checklist or it will be forgotten|

**Quarterly is engineering judgement, not an approved figure.** §39.9 requires rotation to be *specified*; it names no interval. Flagged in §9. **This remains true for *secret rotation*** — `MSC-DEC-284` approved the **restore-drill** cadence and said nothing about rotating provider credentials, and the two intervals must not be conflated because one figure happens to match the other.

**A settings screen that can display an API key is a defect.** Restating `SECURITY_DESIGN.md` §9 here because this is the document whose reader builds the screen.

**Gate B adds the key half, which is not the secret half**. A managed **KMS** holds the keys that protect material the product must be able to *use* rather than merely *check*: the **TOTP seed** is encrypted under an envelope key and decryptable only with KMS access, because the server has to recompute the expected code. The **Argon2id pepper lives outside PostgreSQL and is versioned**, with `pepper_version` recorded on every credential hash — an unversioned pepper can be rotated exactly once, and doing so locks out every user in the product simultaneously. **High-entropy tokens are hashed and never encrypted.** Full detail at [SECURITY_DESIGN.md](SECURITY_DESIGN.md) §14.9.

**Production workloads authenticate to the secret store and KMS with workload or federated identity** where the platform supports it. An embedded long-lived cloud credential is a secret protecting the secret store, which returns the problem to where it started.

## 6. Backup and recovery — where the approved targets need more than they say

**Daily backups alone cannot meet a 24-hour RPO in any useful sense.** A daily snapshot means a failure just before the next one loses nearly a full day: every blind count, every frozen price, every collection recorded since the last snapshot. Technically within a 24-hour RPO; operationally a catastrophe, because **an intake cannot be reconstructed** — the parcels have moved on.

| Layer| Mechanism| Real recovery point|
|---|---|---|
| Daily snapshot| Full backup, retained per §38.7| Up to 24 hours|
| **Continuous WAL archiving**| Point-in-time recovery| **Minutes**|
| Evidence files| Object storage with versioning| Per object|

**WAL archiving is how the 24-hour RPO is met without meaning it.** It costs little and turns a compliance figure into an actually survivable position. This is engineering judgement built on an approved target, and it is the single most valuable line in this document.

**Restore testing is required by §42.8 and is the part that gets skipped.** A backup nobody has restored is a hypothesis. **The cadence is approved, not proposed**: one full isolated restore **before production launch, then quarterly**, timed against the 4-hour RTO — and if a drill exceeds four hours the RTO is not met, whatever the backup configuration claims.

**`MSC-DEC-284` approves that cadence and adds the test before it**: one full restore **before production launch**, then quarterly. It also separates the backup plane from the application plane — **§13.2** — because encryption at rest says nothing about an application credential that can delete the archive this section calls the real recovery position.

**Evidence files need their own consideration.** Photographs are the proof behind OS&D adjudication and delivery. A database restored to a point where an evidence reference exists but the file does not leaves an order whose proof has vanished — so object storage retention must **equal or exceed** database retention, never trail it.

**HIGH-08 audit remediation (13 September 2026) — what "restore" targets, and how traffic reaches it.** Everything above describes recovering *data*; nothing said what happens when the production *infrastructure* itself is what's lost, or how a client's request ever reaches whatever comes back. §2 already settled the geography — **single-region, and "no multi-region complexity is justified"** — so this is not the gap a standby region would close, and inventing one here would contradict an approved target rather than implement it. Two recovery shapes follow from that, and they are not the same drill: **(a) infrastructure survives, only data is lost or corrupted** — PITR restores into the runtime that is already serving `ops.<melarc-domain>` and `vendor.<melarc-domain>` (§12.1), and no traffic-facing step exists because nothing at the edge ever stopped pointing at it; **(b) the production environment itself is unavailable** — compute, not just data, is gone — and restore additionally requires the environment to be re-provisioned before §13.3's drill sequence can even begin, after which the edge (§12's managed load balancer / reverse proxy) is repointed at the recovered environment before it is declared serving traffic again. **Case (b)'s re-provisioning and repoint mechanism is unnamed** — no infrastructure-as-code tool, DNS TTL or load-balancer target-group procedure is stated anywhere in this document, the same gap §9 already carries for WAL archiving and secret rotation, and it is added there rather than guessed at here. §13.3's drill already measures **elapsed recovery time** and gates on **that the application starts**; case (b) is the scenario in which those two steps are doing more work than case (a), and the 4-hour RTO must hold for both.

## 7. Release path

**The Rider Android app is built, signed and distributed privately through a Melarc-managed internal channel and installed manually** (`MSC-DEC-418`, clarified by `MSC-DEC-426`) — not Google Play, not Managed Google Play and not any public store; that is the Version 1 mechanism, and Play may be a future migration option only. The same expand/deploy/contract discipline below governs its releases, and a **server-defined minimum supported version** can be enforced before a security-critical deadline (the certificate-pin forced-update gate, [SECURITY_DESIGN.md](SECURITY_DESIGN.md) §15.2) — **nothing is pushed to the device**; the channel makes a release available, the rider installs it, and the version gate is what makes it mandatory. **The technical minimum is Android 7.0 (API level 24)** — what the attestation architecture requires, accepted by the Product Owner for Version 1 and **not a commitment to support every such handset**; whether an operational floor above it is wanted, set from the real Rider fleet, remains `OQ-073`.

```
feature branch
   │  CI: lint · unit · integration · OPENAPI DRIFT CHECK · negative tests
   ▼
main ──▶ staging (automatic) ──▶ production (manual approval)
```

**The OpenAPI drift check is a merge blocker, not a warning.** `MSC-DEC-226` makes the hand-authored contract authoritative and code conformant. A drift check that only warns lets the contract be overridden by code exactly as §42.1 forbids — and the rules that would erode are the structural ones: the blind count's absent property, `additionalProperties: false` on itemization.

**Migrations run forward only.** §42.6's snapshot and append-only audit rules mean a down-migration can destroy history that is required to be preserved. A bad migration is corrected by a **new forward migration**, never a rollback.

### 7.1 Expand → Compatible Deploy → Backfill → Verify → Switch → Contract

`MSC-DEC-374`. **Every production database change runs these six phases in order.**

| Phase| Rule|
|---|---|
| **Expand**| Add compatible structures first — a new nullable field, a new table, a new index, additive contract support. **Never begin with deleting something the running release needs**|
| **Compatible deploy**| Release **N** operates against the expanded schema while release **N−1** remains supported through the rollback window. **A rolling deployment therefore cannot depend immediately on a destructive schema change**|
| **Backfill**| **Idempotent · restartable · bounded and batched · observable · safe under live traffic · historically truthful.** No default may fabricate a historical business fact, and no huge synchronous transaction may block startup|
| **Verify**| Completeness · constraints · state invariants · **RLS and scope** · historical snapshots · application compatibility · performance and lock effects|
| **Switch**| Authoritative reads and writes move to the new representation **only after verification**. Compatibility may remain through the rollback window|
| **Contract**| Destructive removal only once **all N−1 instances are gone**, the rollback window is closed, the backfill is complete, verification passed, and **no supported release needs the old representation**|

**Rolling deployment is the reason the middle four phases exist.** During a rolling release both N and N−1 are serving traffic against one database, so a schema the old release cannot read takes the product down in the middle of its own deployment — and the instinct at that moment is to roll the application back, which is exactly what the next section says may not be assumed to work.

**The rollback rule, corrected.** The statement this section carried — *"application code rolls back freely, data does not"* — is **too broad and is withdrawn as a rule.** It is true only before the contract phase, and read literally it authorises rolling an application back onto a schema that no longer supports it.

> **Application rollback is allowed only while the database remains compatible with that application version.**

**Before the contract phase**, code rollback is expected to work. **After a destructive contract migration**, recovery is by **roll-forward or forward fix** — unless a separately proven restore procedure is deliberately invoked (§6). **Database down-migrations are not the default recovery strategy**, and the original reasoning is unchanged: §42.6's snapshot and append-only audit rules mean a down-migration can destroy history required to be preserved.

### 7.2 Migration lock and performance safety

Production migration review considers **table rewrites · lock acquisition · index creation · backfill volume · database connection pressure · operating-hour impact.** Online or concurrent index mechanisms are used **where the selected PostgreSQL operation supports them** — the qualifier matters, because not every index build has a concurrent form and assuming one is how a migration takes a write lock on a live table.

**An unavoidably disruptive change is scheduled deliberately**, and **maintenance inside the approved operating window still counts against availability**. A migration planned for 11:00 on a Tuesday spends the monthly allowance whether or not anyone calls it an outage.

**Gate B's migration identity and RLS protections are unchanged.** `melarc_migration_elevated` keeps its deployment-window bound, and every protected table is still created with `ENABLE` **and** `FORCE ROW LEVEL SECURITY` in the same migration.

## 8. Observability — instrument the targets, not the machine

Monitoring exists to prove §42.8 is met and to surface the failures the product's own rules care about.

| Signal| Why this one|
|---|---|
| p95 latency, normal vs critical-write paths| The two targets are **different numbers**; one aggregate hides both|
| Availability **during operating hours**| See §2 — calendar availability misprices the risk in both directions|
| Failed background jobs| §39.9 requires **failure visibility and manual recovery**. A silently dead job is the worst case: nothing alerts and SMS quietly stops|
| Integration failure rate, per provider| SMS and MoMo fail independently and need separate views|
| Idempotency-key collisions| A spike means a client is retrying wrongly — a bug signature, not noise|
| `409` conflict rate| Expected and healthy; a *spike* means two users are fighting over the same record|
| Rate-limit rejections, per credential| `MSC-DEC-224`. A shared vendor credential hitting its ceiling is the signal that decision exists to produce|
| Restore-drill duration| The only evidence the 4-hour RTO is real|

**Alert on the promise, not the resource.** CPU at 90% may be fine; a critical write exceeding 5 seconds is an approved target being missed. Alerting on the second is what §42.8 asks for.

## 9. Engineering judgement flagged as such

The following mechanisms remain proposals where explicitly marked as such; do not silently treat an unresolved proposal as a product decision:

| Item| Approved intent it serves| Status|
|---|---|---|
| Quarterly secret rotation| §39.9 requires rotation be specified; no interval given| **Judgement**|
| Continuous WAL archiving| §42.8's 24-hour RPO; the mechanism is not named| **Judgement**|
| ~~Quarterly restore drills~~| §42.8 requires restore testing and names no cadence| **APPROVED — `MSC-DEC-284`, 27 August 2026**: one full isolated restore **before production launch, then quarterly**. No longer engineering judgement|
| Three environments| No count is specified anywhere| **Judgement**|
| Frontend static-asset hosting| §12.1's approved same-origin topology names `ops.<melarc-domain>` and `vendor.<melarc-domain>`; nothing said what serves the bundle at them| **Judgement — §12.1**|
| Infrastructure-loss re-provisioning and traffic repoint| §42.8's 4-hour RTO; §6 covers data restore and named no mechanism for restoring lost compute or repointing the edge at it| **Judgement — §6**|
| ~~Availability measured over operating hours~~| §42.8 says 99.5% monthly and does **not** say this| **APPROVED — `MSC-DEC-256`, 26 August 2026**, window at `MSC-DEC-257`. No longer engineering judgement|

**The last row was the one to look at, and it is the one that shows the mechanism working.** Measuring availability over operating hours rather than the calendar is defensible and probably right, but it was **not what §42.8 says** — so adopting it here would have been an architecture document quietly redefining a product commitment, precisely what §42.7 forbids. **It was raised as `OQ-068` instead, and the Product Owner decided it.**

**Two rows have now left this table by being decided, and the distinction between them and the rest is the point of §9.** Availability moved on `MSC-DEC-256`; the **restore-drill cadence** moved on `MSC-DEC-284` and this table carried it as judgement for nine days afterwards *(corrected at D-R1)*.

**The restore-drill cadence and the secret-rotation cadence are separate questions and must not be conflated because both are quarterly and both live in operations.** `MSC-DEC-284` approved **restore drills**: pre-launch, then quarterly. **It said nothing about rotating provider credentials**, so quarterly secret rotation stays engineering judgement in the row above — and §5 already warns against reading one interval as authority for the other merely because the numbers coincide.

**The five remaining rows are engineering judgement**, and none of them relaxes anything.

## 10. §37.8 gate — closed

| Deliverable| Status|
|---|---|
| Factor, token, session, device mechanics| Settled — `SOLUTION_ARCHITECTURE.md`|
| Authorization checks| Settled — `MSC-DEC-221` supplied read keys|
| Audit events| Settled — `audit.md`, 45 codes|
| **Secrets**| **Settled — §5 above**|
| Rate limits| **Complete.** Model `MSC-DEC-224`; six buckets and their keys `MSC-DEC-285`; **launch figures `MSC-DEC-371`**, closing `OQ-067`.|
| **Recovery**| **Settled — §6 above**|
| Negative tests| Settled as an obligation — `engineering-standards.md` §3.1|

**Seven of seven.** §37.8 gated login, vendor records, rider access, OTP, payment, suspension and privileged approval on these. **That gate is now passed**, and `SLICE-000` has no missing artifact.

Two artifacts remain owed under `MSC-DEC-205` — background-job and event design, and migration and data-seeding strategy — but **neither is named by §37.8**, so neither blocks `SLICE-000`.

## 12. Trust zones and the production network

`MSC-DEC-280`. **Which components accept public ingress, stated so that anything not listed is private by default.**

| Zone| Public ingress| Contents|
|---|---|---|
| **Public edge**| **yes**| Managed load balancer / reverse proxy. TLS terminates here|
| **Browser surfaces**| **yes**, via the edge| `ops.<melarc-domain>` and `vendor.<melarc-domain>`, each proxying `/api/...` on its own origin|
| **API runtime**| **no** — edge only| `melarc_api_runtime`|
| **Worker / scheduler / relay**| **no**| `melarc_worker_runtime`, `melarc_scheduler_runtime`, `melarc_outbox_relay_runtime` — **three identities, not one**|
| **Worker runtime**| **no**| `melarc_worker_runtime`. No inbound listener at all|
| **PostgreSQL**| **no**| Private subnet. No public endpoint|
| **Broker / cache**| **no**| Private subnet|
| **Object storage — Evidence**| **endpoint only, §12.4**| **Authorization-private.** No anonymous read or write · no public bucket or object ACL · no listing · no browsing · no permanent URL. The **object-service endpoint** is Internet-reachable **only** to redeem a valid short-lived single-object signed capability|
| **KMS / secret store**| **no**| Reached by workload identity, not by an embedded key|
| **Immutable audit archive**| **no**| Write-once. Separate credential from the application|
| **CI / deployment plane**| provider-managed| Short-lived federated identity. Separate build / staging / production / migration capabilities|
| **Backup plane**| **no**| Snapshots, WAL/PITR archive, object versions. **Unreachable with application credentials**|

**Approved public entry points are the edge, the two browser hosts, the Rider/native API hostname, approved provider webhooks, and — narrowly — the Evidence object-service endpoint under §12.4.** Nothing else.

**The object-service endpoint is listed because omitting it made an approved mechanism impossible.** A presigned single-object capability is redeemed **by the client**, from a browser or a handset, directly against the object service; an endpoint no client can reach cannot be redeemed. **It is an entry point in the network sense and grants nothing in the authorization sense** — which is the distinction §12.4 exists to hold.

### 12.1 Same-origin is a precondition, not a preference

Each browser surface calls the API on **its own origin** through a reverse-proxied path:

| Surface| Host| Browser API path|
|---|---|---|
| Ops Portal| `https://ops.<melarc-domain>/`| `https://ops.<melarc-domain>/api/...`|
| Vendor PWA| `https://vendor.<melarc-domain>/`| `https://vendor.<melarc-domain>/api/...`|

**Gate A's cookies stay host-only** — no `Domain` attribute — so `ops.` and `vendor.` are separate origins with separate cookie jars.

**A cross-origin API host would break the approved design rather than merely complicate it.** `MSC-DEC-261` fixed `SameSite=Lax` session cookies and a readable `melarc_csrf` echoed in `X-CSRF-Token`. Cross-origin, the browser would not attach the cookie without **credentialed CORS**, `SameSite=Lax` would suppress it on exactly the cross-site requests the attribute describes, and the deployment would be pushed toward a **parent-domain** cookie — which hands the Ops Portal's session to the Vendor PWA's origin and back, leaving §37.3's *"three authentication models that never mix"* to application code alone.

**HIGH-07 audit remediation (13 September 2026) — what serves the bundle at `ops.<melarc-domain>` and `vendor.<melarc-domain>`.** The table above names the two hosts and the `/api/...` proxy path; it never said what answers a request for the surface's own HTML, JS and CSS. Both surfaces are static builds — no server-side rendering — so the proposal is the plain mechanism: each origin's edge (§12's managed load balancer / reverse proxy, the component that already terminates TLS for these two hosts) serves the built bundle from a **static-asset object-storage container pulled at the edge, not itself Internet-reachable**. That is deliberate: it adds no third public entry point beyond the two browser hosts already listed in §12's *"approved public entry points"* sentence, the same way an Evidence object never becomes reachable except through the endpoint §12.4 names for it. `/api/...` on the same origin continues to reverse-proxy to `melarc_api_runtime` exactly as this section already states. Cache invalidation on deploy is a release-path concern (§7), not a trust-zone one, and is left unspecified here for the same reason the WAL-archiving mechanism in §6 names the layer and not its provider. **This is a proposed mechanism, not an approved rule — see §9.**

### 12.4 The Evidence object endpoint — reachable, and private

`MSC-DEC-291`. **Private means authorization-private. It does not mean unreachable**, and R1 recorded that distinction while this document still forbade the reachable half.

| Property| Posture|
|---|---|
| Anonymous object read| **Denied**|
| Anonymous object write| **Denied**|
| Public bucket / container ACL| **Denied**|
| Public object ACL| **Denied**|
| Anonymous listing| **Denied**|
| Public directory browsing| **Denied**|
| Permanent public URL| **Denied — none exists**|
| **Object-service network endpoint**| **Internet-reachable**, and only useful with a valid signed capability|
| Signed capability scope| **One object.** Altering the key or path invalidates the signature|
| Signed capability lifetime| Upload **15 minutes**, retrieval **5 minutes**|
| Listing via a signed capability| **Impossible** — it authorises one object, never enumeration|
| Uploaded object before validation| **Quarantine/private** until completion validation passes|

**The bucket is not public and no object is anonymously reachable.** Reachability is a property of the endpoint; access is a property of the capability. **Only possession of a cryptographically valid, short-lived, single-object signature authorises the specific operation** — and the platform issues that signature only after authentication, the existing Product permission check, principal-specific RLS and `access_rule` evaluation ([SECURITY_DESIGN.md](SECURITY_DESIGN.md) §14.18a).

**Why the R1 wording could not stand.** *No public ingress* plus *nothing else may be a public entry point* describes a deployment in which **no client can redeem a presigned URL** — which is not a hardening of `MSC-DEC-291`, it is a contradiction of it. The two halves had to be named separately: the **container** is closed, the **endpoint** is reachable, and the capability is what bridges them for one object for a few minutes.

### 12.2 Transport and browser baseline

**TLS 1.3 preferred · TLS 1.2 for compatibility only · TLS 1.0 and 1.1 disabled · HTTPS everywhere · HSTS once the domain and certificates are validated.**

**Headers on browser surfaces:** a strict allowed-`Origin` list · **no wildcard credentialed CORS** · CSP · `frame-ancestors 'none'` unless a specific need is approved · `X-Content-Type-Options: nosniff` · a restrictive Referrer Policy · **`Cache-Control: no-store` on every API response**, which the API sends itself as a platform rule ([SECURITY_DESIGN.md](SECURITY_DESIGN.md) §14.8) · **exact `Origin` validation on browser-sensitive flows, including pre-session endpoints** — which is where a login-CSRF or session-fixation attempt necessarily arrives, and the one place a session-cookie defence has nothing to check.

**A per-address ceiling at the edge** (deployment note, Product decision of 6 October 2026). The credential setup and recovery bucket is keyed by the grant or token a request presents ([settings.md](../contracts/settings.md) §7.7), and a caller chooses that key freely: every made-up value is a fresh bucket. The edge therefore enforces a ceiling per source address, which **bounds the cost of attacker-chosen keys**. It is infrastructure and not a seventh bucket, and it identifies no credential. **Its value, and the operations it covers, are a deployment input that has not been supplied.**

### 12.3 Production security configuration fails startup

Production permits **no "development mode" bypass** of RLS, authentication, KMS-backed secrets, private storage, TLS or audit controls. **The application fails to start when required production security configuration is missing.**

§33.3 already applies *fail visibly* to a missing hub setting, and §33.4 makes a hub with no fee take no bookings rather than borrow another's. **A missing KMS key deserves at least the treatment of a missing delivery fee.** A product that boots degraded is a product that runs degraded, and nobody reads the warning.

**Rider device attestation is one of those controls** (`MSC-DEC-427`, [SECURITY_DESIGN.md](SECURITY_DESIGN.md) §15.2.1). **Production refuses to start** if the attestation verifier is the non-production substitute; if the accepted Android attestation roots, the Rider package name or the approved signing-certificate digest set is missing or empty; or if the revocation-data maximum age (`ATTESTATION_TRUST_DATA_MAX_AGE_HOURS`, 24 at launch) is unset or not greater than 6, the refresh cadence in hours. **The substitute verifier is available in Local and Staging only** and produces allowed and rejected outcomes deterministically, so neither needs production trust settings. The trust roots and the revocation list are a **maintenance dependency of rider enrolment and replacement only**: if the list is older than the configured maximum age, new enrolment and replacement fail closed (`503` `TRUST_DATA_UNAVAILABLE`, retryable) and operations are alerted, while **sign-in and every live session continue** — the sign-in path calls no attestation service. **The list is loaded by the verifier itself, in memory, in each API instance** — every 6 hours, retried every 15 minutes while a load fails — and is no scheduled job, so it needs no scheduler, worker or broker; **what it does need is egress from the API runtime to Google's published attestation endpoint** ([SECURITY_DESIGN.md](SECURITY_DESIGN.md) §15.2.2). The first production signing certificate's digest is a **release input**, created with the signing key.

**Credential and recovery message delivery is another** (Gate PD-3R1, `PDA-54`). **Production refuses to start** with the capture adapter selected, or without a configured production adapter and its timeout, for the SMS channel and for the email channel ([SECURITY_DESIGN.md](SECURITY_DESIGN.md) §13.9a). The providers are **external deployment inputs** that no document has selected; this section names the failure so that the day one is chosen the application already refuses to run without it. **A test proves each refusal**, exactly as for the attestation substitute.

**Staging exercises real RLS policies, real database-role separation and representative cloud security controls.** Local may simplify the infrastructure but its tests must still exercise the **logical** boundaries — scope classes, policies and role separation — rather than stubbing them, or the first place they run is production.

### 12.5 The API runtime's probes, configuration and shutdown, and the browser-history fallback

This is what the B0.2 API skeleton (`apps/api`), its B0.4 database foundation and the B0.3 Ops Portal shell (`apps/ops-web`) actually do, so that a deployment can be built against it. None of it is a product setting: the product's own settings are in [settings.md](../contracts/settings.md).

**Technical probes.** `GET /livez` and `GET /readyz` sit outside `/api/v1`, take no principal and send `Cache-Control: no-store`. `/livez` answers `200 {"status":"ok"}` while the process runs, **including while it drains**, so the platform does not kill an instance that is finishing its work. `/readyz` answers `200 {"status":"ready"}` or `503 {"status":"not_ready","reason":…}` with one coarse reason (`starting`, `shutting_down` or `dependency_unavailable`) and never a dependency name or an error. It turns `503` the moment shutdown begins and while a registered dependency check fails. **They are not part of the business API:** the generated OpenAPI description excludes them (its `paths` stays empty until business operations exist), `contracts/openapi.yaml` does not contain them, and the generated route inventory lists them as technical routes.

**Isolation is a network property, not a path property.** The edge forwards only `/api/...`, so it does not route the probes. That is a routing rule, not isolation: anyone who can reach the runtime's listener can request them. The API runtime therefore stays unreachable from browsers and the Internet (§12: edge only), and the platform's health checker is the only intended caller of the probes.

**Configuration.** The API reads its environment at start. A missing or invalid value stops it with exit code `1` and one log line that names the key and never the value.

| Variable| Required| Default| Bounds|
|---|---|---|---|
| `NODE_ENV`| yes| none| `development`, `test` or `production`; `production` is required when `APP_ENV` is `staging` or `production`|
| `APP_ENV`| yes| none| `local`, `staging` or `production`|
| `HTTP_HOST`| no| `127.0.0.1`| letters, digits, `.`, `_`, `:` and `-`|
| `HTTP_PORT`| yes| none| integer 1–65535|
| `LOG_LEVEL`| no| `info`| `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`|
| `SHUTDOWN_TIMEOUT_MS`| no| `15000`| integer 1000–300000|
| `SHUTDOWN_DRAIN_DELAY_MS`| no| `0`| integer 0–60000, and less than `SHUTDOWN_TIMEOUT_MS`|
| `DATABASE_URL`| yes| none| a `postgres://` or `postgresql://` URL naming a host, one database and the user `melarc_api_runtime`; any other user is refused. **No query string or fragment is accepted**, so no connection option (TLS included) can be set through the URL until a deployment specifies them; a URL with one is refused, never stripped|
| `DATABASE_POOL_MAX`| no| `10`| integer 1–100|

`DATABASE_MIGRATION_URL` is **forbidden** in the API's environment: its presence, with any value, stops the API at start, so that migration credentials are never within reach of a request handler. Only the migration command reads it.

**Shutdown has one budget.** On `SIGTERM` or `SIGINT` readiness turns `503` at once and the listener keeps serving for `SHUTDOWN_DRAIN_DELAY_MS`. Then Nest closes the application (the listener stops accepting, in-flight requests finish, the shutdown hooks run) and the registered resources close, last registered first (the database pool, from B0.4). **The drain delay and every step after it run inside `SHUTDOWN_TIMEOUT_MS`.** A clean shutdown exits `0` once the event loop drains. When the budget ends, nothing stalled is waited for: the listener and the remaining connections are closed, resources not yet confirmed are started but not awaited, the log names what is unconfirmed, and the process **exits with code `1` at once, even while a handle is still open**. A forced exit never claims that everything closed. **The supervisor's stop grace period must be longer than `SHUTDOWN_TIMEOUT_MS`**, so that the process ends itself, with its own record, before the supervisor kills it. `SHUTDOWN_DRAIN_DELAY_MS` should cover the time the load balancer needs to stop sending traffic after `/readyz` turns `503`.

**Database, roles and migrations.** The API reaches PostgreSQL through one lazily connecting pool, registered for shutdown, and sets a request's security context only inside a transaction (`set_config(…, true)`), so nothing survives on a pooled connection. `/readyz` is `503` with `dependency_unavailable` while the database does not answer **and while the connected role is not a safe runtime identity**: a superuser, a `BYPASSRLS` role, one that can create databases or roles, or one that owns the database or any object, directly or as a member of the owning role. Three roles exist, each with its own credential, provisioned outside the migrations: `melarc_owner` (`NOLOGIN`; owns every object), `melarc_migration_elevated` (runs migrations; a member of `melarc_owner`) and `melarc_api_runtime` (owns nothing, bypasses nothing, is a member of nothing).

**Schema changes are applied by one command and never by the API at start:** `pnpm --filter @melarc/api db:migrate` applies `apps/api/migrations/`, the one canonical history, as the migration identity (`DATABASE_MIGRATION_URL`), forward only, in one transaction and under an advisory lock, so two runs at once serialise and a repeat applies nothing. `drizzle-kit push` is not used. A migration that creates a table must, in the same file, assign it to `melarc_owner` and enable **and** force row-level security; the migration lint in `pnpm test` fails the build otherwise.

**Locally**, `infrastructure/postgres/compose.yaml` runs the server (loopback only; the image, `postgres:18.6-bookworm`, is a provisional engineering choice, since no retained specification names a version). `db:bootstrap`, `db:migrate` and `db:reset` prepare it; `db:reset` refuses any server not on the machine, any `APP_ENV` of `staging` or `production`, any database but a `melarc_dev` or `melarc_test` one, and any database that does not carry the marker this tooling puts on what it creates. `pnpm test:db` runs the tests that need the server, each in a database of its own, and CI runs them against a service container. A run removes only the databases it made. A database a killed run leaves behind is never removed on a guess, because one with no connection may belong to a run between two steps: `db:orphans` lists the `melarc_test_*` databases that carry the marker (changing nothing), and `db:orphans --drop <name>…` removes the ones a person names, refusing any with a session connected unless `--disconnect` is added.

**Browser-history fallback.** The Ops Portal routes with the browser history, so its host must answer a request for **a document route** with the surface's `index.html`: a deep link or a reload on an unknown path must not be a `404` from the host. The fallback applies to document requests only. **It never applies to `/api/...`, to `/livez` and `/readyz`, or to a missing asset:** those keep their own `404`, so that a stale or mistyped asset fails visibly instead of arriving as HTML. This states the behaviour a host must have; what serves the bundle is still the proposal in §12.1.

**Not decided yet, and not implemented.** The trusted proxy topology: which proxies the API may believe for client address, scheme and request id. Today it trusts none and ignores a client-supplied request id. Explicit business request-size and upload limits: today only the framework's default body limit applies, and no business route accepts a body.

## 13. Production access, deployment identity and the backup plane

`MSC-DEC-284`.

### 13.1 No standing shared production database credential

Routine support uses **application observability, authorised support and admin product surfaces, and controlled tools** — never a shared psql login.

**Emergency infrastructure access** is individually attributable, MFA protected, time bounded, reason bound and infrastructure audited.

**§5 already says no human reads a production secret in normal operation.** A shared database credential is the same rule facing the other way and is the one usually left standing, because it is the fastest way to answer a support question at 20:00 — which is exactly when nobody records who used it.

### 13.2 The backup plane is separate

Snapshots, WAL/PITR archives and object versions are **encrypted, separately access-controlled, unreachable with standard application credentials, protected against accidental deletion, and restorable only through a controlled infrastructure procedure.**

**Encryption at rest defends the medium and does nothing about an application credential that can enumerate and delete snapshots.** §6 makes WAL archiving the mechanism that turns a 24-hour RPO into minutes, which means **the archive is the recovery position** — and a compromise reaching the application and the archive on one credential removes that position at the moment it creates the need for it.

### 13.3 Restore drills: pre-launch, then quarterly

**One full restore test before production launch, then quarterly.** In an **isolated** environment. **A routine drill never overwrites production.**

A drill verifies, in order: PostgreSQL data · Evidence objects · required KMS/key access · secrets and configuration · provider reconciliation state where relevant · that representative **encrypted TOTP data can still be used** · key business row counts and checksums · the `AuditEvent` integrity checkpoint · that the application starts · **that the restored environment cannot send live customer SMS or move real money** · and the **elapsed recovery time**, recorded for later RTO analysis.

**§6 already required quarterly drills timed against the 4-hour RTO, and §9 flagged the interval as engineering judgement.** §40.4 requires *"a defined cadence"* and defines none — one of the four unset groups `OQ-095` tracks. `MSC-DEC-284` supplies it. **The pre-launch test is the load-bearing half**: a cadence beginning after launch means the first restore attempt of a production system happens during an incident, which is §6's own point — *"a backup nobody has restored is a hypothesis."*

**The live-provider isolation step is not a formality.** §4 already says no environment but production may hold production credentials, and a restored database is full of real recipients' phone numbers. A drill that reaches a live SMS key sends real messages about parcels that were delivered months ago.

### 13.4 Deployment identity

Short-lived **federated / OIDC** deployment identity where the platform supports it. Pipeline capabilities separated for **build · staging deployment · production deployment · migration**.

**A migration identity does not thereby gain broad business-data read authority.** `melarc_migration_elevated` performs approved schema, ownership and policy operations and never processes a request; a pipeline role that could also read every business table would make the deployment plane the widest data-access path in the product.

**R1 stopped describing it as unprivileged**. R0 had the same identity transferring table ownership *and* holding no elevated capability — which cannot both be true, and **the phrasing prevented anyone bounding it deliberately.** It is now bounded by **lifetime**: obtained through the deployment workload identity, infrastructure-audited, usable **only for the deployment window**, withdrawn or expired when the migration finishes, and **never reusable as a runtime**. `melarc_owner` remains `NOLOGIN`, so even this identity hands ownership to a role nothing can log in as.

## 14. Encryption at rest — Gate B R1

`MSC-DEC-292`. **Provider or storage-level encryption at rest is required** for every class below. Anything not listed is not thereby exempt; it is not yet in use.

| Class| Covered|
|---|---|
| Live PostgreSQL primary and its storage| **yes**|
| Read replicas, where used| **yes**|
| **PostgreSQL WAL**| **yes**|
| **PITR material**| **yes**|
| Database snapshots| **yes**|
| Database backups| **yes**|
| Evidence object storage| **yes**|
| **Evidence quarantine objects**| **yes** — before validation, not only after|
| Evidence object versions, where applicable| **yes**|
| Object-storage snapshots and backups| **yes**|
| Every backup-plane copy| **yes**|

**This needed saying rather than assuming.** §5, §6 and §13 described a managed KMS, an application-encrypted TOTP seed and an isolated backup plane, and **never stated that the storage beneath the database and the object store is encrypted at all.** That reads as obvious and is not: managed services differ in what they encrypt by default, **WAL and PITR archives are the material most often left outside the guarantee** — and §6 makes the WAL archive the actual recovery position — and the quarantine bucket holding not-yet-validated Evidence had no stated posture whatever.

**It does not replace application-level KMS encryption, and the two are not alternatives.** TOTP seeds stay application-encrypted under an envelope key because the server must **recompute** the expected code ([SECURITY_DESIGN.md](SECURITY_DESIGN.md) §14.9). **Storage encryption defends a stolen disk or a mishandled snapshot; application KMS encryption defends a readable database** — and a seed sitting in plaintext inside an encrypted volume is plaintext to everything holding a connection.

**Customer-managed per-row keys for ordinary business rows are explicitly not a V1 requirement**, and nothing here claims otherwise. Key and access separation for backup material follows §13.2: **the backup plane's keys are not reachable with application credentials.**

## 11. Related

- **Architecture:** [SOLUTION_ARCHITECTURE.md](SOLUTION_ARCHITECTURE.md) · [SECURITY_DESIGN.md](SECURITY_DESIGN.md)
- **Standards:** [engineering-standards.md](../standards/engineering-standards.md) — CI checks this pipeline runs
- **Slice:** `SLICE-000` in [IMPLEMENTATION_PLAN.md](../delivery/IMPLEMENTATION_PLAN.md)
