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
| **Transactional email provider**| Every staff setup grant, recovery link and MFA re-enrolment link, and every vendor setup grant **whose `delivery_channel` is `EMAIL`**, reaches its principal through it, sent by the credential-delivery worker from a durable job ([SECURITY_DESIGN.md](SECURITY_DESIGN.md) §13.9a); **a vendor whose `delivery_channel` is `PHONE` is reached through the SMS provider instead**. A test that sent through the real provider would deliver a **live credential link to a real person**. In Local, in CI and, **by default, in Staging** the **capture adapter** writes each message to a developer-visible sink and reaches nobody; Staging uses a real provider only inside the controlled window of §4.1|
| **Hubtel MoMo**| Payment confirmation gates dispatch. Testing against production moves real money|

**No environment but production may hold production credentials.** A staging system holding a live SMS key will eventually send a live message to a real recipient during a test.

### 4.1 Real-provider release validation in Staging — explicitly controlled

Product decision, 8 October 2026 (R2 review). Staging runs the **capture adapter by default**, and the functional acceptance walk of `SLICE-000` §5 uses it. Before external exposure the chosen email and SMS providers must also be shown to work end to end, once, with a real provider. That is a **separate, explicitly controlled release validation** — gate G3 of the implementation plan — and never a standing Staging configuration. It sits beside the rule above, which it does not relax: the credential is never the production one.

- **Authorised for a window.** Written Product Owner approval names the provider, the channel or channels, the start and the end, the recipient allow-list and the number of messages, and is recorded with the release evidence.
- **A non-production credential only.** The provider's test or restricted Staging credential, held under production-like custody ([SECURITY_DESIGN.md](SECURITY_DESIGN.md) §14.9). The production credential never enters Staging.
- **Allow-listed recipients only.** Addresses and numbers that Melarc staff control, enforced by the delivery adapter before any provider call: a message to any other destination is a terminal failure of its own non-secret outcome class (`DESTINATION_NOT_ALLOWED`) and nothing is sent.
- **Selection is explicit and reversible.** The delivery worker refuses to start in Staging with the real adapter selected unless the approval reference and the allow-list are configured. The window ends by returning to the capture adapter, and a link created inside it expires by its own lifetime and is not reused.
- **Evidence.** The provider's acceptance (a message reference, never content), the recipient's receipt where the provider reports one, the link opening the Staging page and redeeming once, and the delivery alerts firing in rehearsal. No token appears in the record.
- **Not local acceptance.** It neither replaces nor is replaced by the capture-adapter walk. Specifying it sends no message and changes no deployed configuration.

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

**A release that reduces a bundle or the compiled Vendor or Rider policy is a policy-reducing release** (Product decision, 8 October 2026; [SECURITY_DESIGN.md](SECURITY_DESIGN.md) §13.10 and §13.10a). Ending today's sessions is not enough, because release N−1 is still serving and could issue the old authority afterwards. The release therefore raises the **floor** in the database — a bundle's `reduction_floor`, or the type's `minimum_revision` for the compiled policy — under the exclusive policy lock, no later than the step that first lets an instance of release N serve traffic. For a bundle, N−1 reads the reduced content at its next issue, because it reads the bundle under the shared lock and never from a cache. For the compiled policy, from then on an N−1 instance **refuses issuance and every authenticated request of that type** with the existing operational failure (`503`, retryable, nothing executed or written) and reports itself not ready; it terminates no session, because the session is valid and the instance serving it is the obsolete one. An instance older than a session's revision likewise refuses that request ([SECURITY_DESIGN.md](SECURITY_DESIGN.md) §13.10, item 2); Slice-000 has no compatibility exception. A rollback to N−1 cannot issue or serve either. An addition raises a revision and no floor. A sign-in or an authenticated call that lands on an N−1 instance during the overlap fails closed and is retried, which is the accepted price. The release notes mark such a release, and it is rolled out so that N−1 instances drain promptly.

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
| **Attestation verifier**| **no**| The private JVM verifier service of [SECURITY_DESIGN.md](SECURITY_DESIGN.md) §15.2.3: reached only by the API runtime, on loopback or a dedicated private network and authenticated if it crosses hosts; egress only to Google's published attestation endpoints; **no database credential**|
| **Worker runtime**| **no**| `melarc_worker_runtime`. No inbound listener at all. The credential-delivery worker needs egress to the configured SMS and email providers and nothing else|
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

**Gate A's cookies stay host-only** — no `Domain` attribute — so `ops.` and `vendor.` are separate origins with separate cookie jars. The Ops and Vendor origins are **configuration**, validated at start, and are the only source of the allowlisted `Origin` values and of the destinations in credential links (Product decision, 8 October 2026): they are never taken from `Host`, a forwarded header or a request's own redirect.

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

**A per-address ceiling at the edge** (deployment note, Product decision of 6 October 2026). The credential setup and recovery bucket is keyed by the grant or token a request presents ([settings.md](../contracts/settings.md) §7.7), and a caller chooses that key freely: every made-up value is a fresh bucket. The edge therefore enforces a ceiling per source address, which **bounds the cost of attacker-chosen keys**. It is infrastructure and not a seventh bucket, and it identifies no credential. **Its value, and the operations it covers, are a deployment input that has not been supplied**: the implementation task measures hashing, database contention, API latency and shared-network (NAT) behaviour and supplies it with the NAT consequence recorded, and external authentication exposure waits for it.

**Trusted proxies and the client address** (Product decision, 8 October 2026). The API believes no forwarded header by default: `trust proxy` is off. A deployment that fronts the API names its topology explicitly — which hops are trusted, by address — and its last trusted hop overwrites the forwarded headers; the API is not reachable through any ingress that bypasses the edge. Trust is never switched on unconditionally to obtain an apparent client address. Spoofed forwarding and several users behind one shared address are tested, because a per-address ceiling can throttle a shop's whole network.

### 12.3 Production security configuration fails startup

Production permits **no "development mode" bypass** of RLS, authentication, KMS-backed secrets, private storage, TLS or audit controls. **The application fails to start when required production security configuration is missing.**

§33.3 already applies *fail visibly* to a missing hub setting, and §33.4 makes a hub with no fee take no bookings rather than borrow another's. **A missing KMS key deserves at least the treatment of a missing delivery fee.** A product that boots degraded is a product that runs degraded, and nobody reads the warning.

**Key custody and the limiter are two more.** Production refuses to start with any purpose-separated key absent (§14.9 of [SECURITY_DESIGN.md](SECURITY_DESIGN.md)), with a test key adapter selected, or with the in-memory rate-limit adapter selected in place of the authoritative PostgreSQL limiter (§14.12 there); a test proves each refusal. Staging used for release proof exercises production-like custody, not keys held in environment variables alone.

**Rider device attestation is one of those controls** (`MSC-DEC-427`, [SECURITY_DESIGN.md](SECURITY_DESIGN.md) §15.2.1). **Production refuses to start** if the attestation verifier is the non-production substitute; if the accepted Android attestation roots, the Rider package name or the approved signing-certificate digest set is missing or empty; or if the revocation-data maximum age (`ATTESTATION_TRUST_DATA_MAX_AGE_HOURS`, 24 at launch) is unset or not greater than 6, the refresh cadence in hours; or if the production verifier is selected without its service endpoint configured (and its caller authentication where the service crosses hosts). **The substitute verifier is available in Local and Staging only** and produces allowed and rejected outcomes deterministically, so neither needs production trust settings. The trust roots and the revocation list are a **maintenance dependency of rider enrolment and replacement only**: if the list is older than the configured maximum age, new enrolment and replacement fail closed (`503` `TRUST_DATA_UNAVAILABLE`, retryable) and operations are alerted, while **sign-in and every live session continue** — the sign-in path calls no attestation service. **The list is loaded by the verifier service itself, in memory, in each verifier instance** — every 6 hours, retried every 15 minutes while a load fails — and is no scheduled job, so it needs no scheduler, worker or broker; **what it does need is egress from the verifier service to Google's published attestation endpoint**, and the API runtime needs none ([SECURITY_DESIGN.md](SECURITY_DESIGN.md) §15.2.2). The first production signing certificate's digest is a **release input**, created with the signing key.

**Credential and recovery message delivery is another** (Gate PD-3R1, `PDA-54`, revised 8 October 2026). **Production refuses to start** — the API and the delivery worker alike — with the capture adapter selected, or without a configured production adapter and its timeout, for the SMS channel and for the email channel ([SECURITY_DESIGN.md](SECURITY_DESIGN.md) §13.9a). The providers are **external deployment inputs** that no document has selected; this section names the failure so that the day one is chosen the application already refuses to run without it. **A test proves each refusal**, exactly as for the attestation substitute. **The mirror-image refusal holds in Staging:** the delivery worker refuses to start with a real provider adapter selected unless the approval reference and the recipient allow-list of §4.1 are configured, and a test proves that too. **The credential-delivery worker is its own process**: `melarc_worker_runtime` plus `melarc_worker_cap_credential_delivery`, no inbound listener, egress only to the configured providers. It stops claiming on `SIGTERM` and finishes or relinquishes its leases inside the shutdown budget, it never holds a database connection while a provider call runs, and its backlog, terminal failures and expired leases alert ([OBSERVABILITY_AND_RECOVERY.md](OBSERVABILITY_AND_RECOVERY.md) §3).

**Staging exercises real RLS policies, real database-role separation and representative cloud security controls.** Local may simplify the infrastructure but its tests must still exercise the **logical** boundaries — scope classes, policies and role separation — rather than stubbing them, or the first place they run is production.

### 12.5 The API runtime's probes, configuration and shutdown, and the browser-history fallback

This is what the B0.2 API skeleton (`apps/api`), its B0.4 database foundation and the B0.3 Ops Portal shell (`apps/ops-web`) actually do, so that a deployment can be built against it. None of it is a product setting: the product's own settings are in [settings.md](../contracts/settings.md).

**Technical probes.** `GET /livez` and `GET /readyz` sit outside `/api/v1`, take no principal and send `Cache-Control: no-store`. `/livez` answers `200 {"status":"ok"}` while the process runs, **including while it drains**, so the platform does not kill an instance that is finishing its work. `/readyz` answers `200 {"status":"ready"}` or `503 {"status":"not_ready","reason":…}` with one coarse reason (`starting`, `shutting_down`, `dependency_unavailable` or, once sessions are issued, `policy_superseded`) and never a dependency name or an error. **`policy_superseded`** says this instance was compiled with a fixed-policy revision below the database `minimum_revision` ([SECURITY_DESIGN.md](SECURITY_DESIGN.md) §13.10); it refuses to issue Vendor and Rider sessions **and refuses every authenticated request of those two types** (the existing operational failure; it ends no session) and the platform stops routing new traffic to it. It turns `503` the moment shutdown begins and while a registered dependency check fails. **They are not part of the business API:** the generated OpenAPI description excludes them (its `paths` stays empty until business operations exist), `contracts/openapi.yaml` does not contain them, and the generated route inventory lists them as technical routes.

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
| `DATABASE_ACQUIRE_TIMEOUT_MS`| no| `5000`| integer 100–60000: the longest a caller waits for a connection. The wait in the connection queue and the making of the connection draw on this one deadline, measured on the monotonic clock from the moment the caller asks (less when the request has less left), so the whole wait is at most this. It is also the pool's own time to make a connection, which only bounds an attempt that a caller gave up on and that keeps its place until it ends|
| `DATABASE_LOCK_TIMEOUT_MS`| no| `2000`| integer 100–60000, and **less than** `DATABASE_STATEMENT_TIMEOUT_MS`|
| `DATABASE_STATEMENT_TIMEOUT_MS`| no| `5000`| integer 100–120000, and **less than** `DATABASE_TRANSACTION_TIMEOUT_MS`|
| `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS`| no| `5000`| integer 100–120000|
| `DATABASE_TRANSACTION_TIMEOUT_MS`| no| `10000`| integer 100–300000|
| `DATABASE_POOL_MAX_WAITERS`| no| `50`| integer 1–10000: the most callers allowed to wait for a connection at once|
| `REQUEST_EXECUTION_BUDGET_MS`| no| `15000`| integer 1000–300000: the longest one request may run once it has been received and admitted, database work and everything else included (the execution budget; "Deadlines" below)|
| `OPS_ORIGIN`| yes| none| an exact browser origin: `http` or `https`, a host and an optional port, **no** path, query, fragment or trailing slash; `https` unless `APP_ENV` is `local`|
| `VENDOR_ORIGIN`| yes| none| an exact browser origin as above, **different from** `OPS_ORIGIN`|
| `HTTP_TRUST_PROXY`| no| `off`| `off`, or up to 16 comma-separated trusted hops, each an IP address or an address with a prefix length of at least 1; never a count, `true`, a wildcard or a host name|
| `HTTP_BODY_LIMIT_BYTES`| no| `102400`| integer 1024–1048576|
| `HTTP_HEADER_TIMEOUT_MS`| no| `10000`| integer 1000–60000|
| `HTTP_BODY_TIMEOUT_MS`| no| `10000`| integer 1000–120000|
| `HTTP_ADMISSION_TIMEOUT_MS`| no| `2000`| integer 100–30000|
| `HTTP_ADMISSION_CONCURRENCY`| no| `64`| integer 1–10000|
| `RATE_LIMITER`| no| `postgres`| `postgres` or `memory`; `memory` only when `APP_ENV` is `local`|
| `KEY_CUSTODY`| yes| none| `local`, the only custody built: key material from this environment, **a substitute that is not KMS-backed custody**; refused when `APP_ENV` is `production`|
| `KEY_TOTP_SEED_MATERIAL`| yes| none| key material for the purpose `totp_seed`: one to eight comma-separated `<version>:<key>`; a key is 32 random bytes as 43 unpadded base64url characters, and no key repeats in any purpose or version|
| `KEY_TOTP_SEED_ACTIVE_VERSION`| yes| none| integer 1–999999 naming a version listed in `KEY_TOTP_SEED_MATERIAL`|
| `KEY_CREDENTIAL_DELIVERY_MATERIAL`| yes| none| as above, for the purpose `credential_delivery`|
| `KEY_CREDENTIAL_DELIVERY_ACTIVE_VERSION`| yes| none| as above|
| `KEY_IDEMPOTENT_REPLAY_MATERIAL`| yes| none| as above, for the purpose `idempotent_replay`|
| `KEY_IDEMPOTENT_REPLAY_ACTIVE_VERSION`| yes| none| as above|
| `KEY_LIMITER_DIGEST_MATERIAL`| yes| none| as above, for the purpose `limiter_digest`|
| `KEY_LIMITER_DIGEST_ACTIVE_VERSION`| yes| none| as above|
| `KEY_PASSWORD_PEPPER_MATERIAL`| yes| none| as above, for the purpose `password_pepper`|
| `KEY_PASSWORD_PEPPER_ACTIVE_VERSION`| yes| none| as above|
| `ARGON2_MEMORY_KIB`| no| `65536`| integer 8–1048576, at least 8 and a multiple of 4 per lane (`ARGON2_PARALLELISM`): the memory of one credential hash, in KiB, in the profile new hashes are written at; staging and production refuse less than 19456|
| `ARGON2_PASSES`| no| `2`| integer 1–16: the passes of that profile; staging and production refuse fewer than 2|
| `ARGON2_PARALLELISM`| no| `1`| integer 1–16: the lanes of that profile; one lane keeps a hash on one thread of the shared pool|
| `ARGON2_ACCEPTED_PROFILES`| no| none| absent, or one to eight comma-separated `<memory KiB>:<passes>:<lanes>` older profiles that stored hashes may still be verified at, each valid as above, none repeated and none the profile above; a hash at any other profile is refused without being derived|
| `DELIVERY_EMAIL_ADAPTER`| no| `capture`| `capture` or `provider`; `capture` is refused when `APP_ENV` is `production`|
| `DELIVERY_EMAIL_ENDPOINT`| no| none| an `https` URL (`http` only to a loopback host when `APP_ENV` is `local`) with no user information, query or fragment; **required with `provider`, absent with `capture`**|
| `DELIVERY_EMAIL_TIMEOUT_MS`| no| none| integer 100–60000; required with `provider`, absent with `capture`|
| `DELIVERY_SMS_ADAPTER`| no| `capture`| `capture` or `provider`; `capture` is refused when `APP_ENV` is `production`|
| `DELIVERY_SMS_ENDPOINT`| no| none| as `DELIVERY_EMAIL_ENDPOINT`|
| `DELIVERY_SMS_TIMEOUT_MS`| no| none| integer 100–60000; required with `provider`, absent with `capture`|
| `ATTESTATION_VERIFIER`| no| `substitute`| `substitute` or `service`; `substitute` is refused when `APP_ENV` is `production`|
| `ATTESTATION_VERIFIER_URL`| no| none| an endpoint as `DELIVERY_EMAIL_ENDPOINT`; required with `service`, absent with `substitute`|
| `ATTESTATION_VERIFIER_TIMEOUT_MS`| no| none| integer 100–60000; required with `service`, absent with `substitute`|
| `ATTESTATION_VERIFIER_CALLER_SECRET`| no| none| a 32-byte key as 43 base64url characters; required with `service` when the URL is not on a loopback host (SECURITY_DESIGN.md §15.2.3), absent with `substitute`|

**What the settings added by the identity slice (S0.2) do, and do not do yet.** They are **validated at start and not yet read by the code that will enforce them**: the transport limits and deadlines by S0.20 (transport admission), the keys by S0.3 (cryptography and credential normalisation), the delivery timeouts by S0.18 (delivery worker process), and the verifier settings by S0.55 (the private JVM verifier service), S0.56 (trust data and policy) and their first caller, S0.57 (`completeRiderDeviceEnrolment`). A setting here is therefore a configuration the API accepts or refuses, not yet a limit it applies: **validation is not enforcement**, and no row, comment or test of S0.2 claims otherwise. The one limit in force on the transport today is the fixed 100 KiB the JSON body parser already applies, which does not read `HTTP_BODY_LIMIT_BYTES`. **S0.6 (resource deadlines) has since applied the database deadlines and the pool bound** and built the execution-budget mechanism (the map below, and "What S0.6 applied and where it was exercised"); `REQUEST_EXECUTION_BUDGET_MS` is read by nothing yet, because no request has a budget until S0.20 (transport admission) creates one. The attestation policy (trust roots, package name, signing digests, maximum trust-data age) is a separate set added with the verifier.

**Deadlines: what each one bounds, and who enforces it.** Two different things are called a deadline. A **receipt limit** bounds how long the server waits for a *client* to send (the head, the body); an **execution budget** bounds how long the *application* takes once it has the request (a database wait, an outbound call). A receipt limit does not bound a handler, and nothing below claims it does.

| Retained requirement| Setting| It bounds| It does not bound| Owning task| Applied today|
|---|---|---|---|---|---|
| Header receipt deadline ([SECURITY_DESIGN.md](SECURITY_DESIGN.md) §14.6; [permission-enforcement.md](../features/identity/permission-enforcement.md) §5.1)| `HTTP_HEADER_TIMEOUT_MS`| how long the server waits for a client to send the request head| a handler's execution| S0.20 (transport admission)| no|
| Body receipt deadline (same)| `HTTP_BODY_TIMEOUT_MS`| how long the server waits for the body to arrive after the head| a handler's execution| S0.20 (transport admission)| no|
| Admission deadline and concurrency (same)| `HTTP_ADMISSION_TIMEOUT_MS`, `HTTP_ADMISSION_CONCURRENCY`| how long a request waits for an admission slot, and how many are admitted at once| what an admitted request then does| S0.20 (transport admission)| no|
| Body size (same)| `HTTP_BODY_LIMIT_BYTES`| the bytes received, chunked requests included| time| S0.20 (transport admission)| no: a fixed 100 KiB parser limit applies instead|
| Pool acquisition and waiters (§14.6)| `DATABASE_ACQUIRE_TIMEOUT_MS`, `DATABASE_POOL_MAX_WAITERS`| the wait for a pooled connection, and how many callers may wait; a caller that gives up is removed from the line| the work done with the connection| S0.6 (resource deadlines)| yes: applied by S0.6, a bounded line in front of the pool|
| Lock wait, statement, idle in transaction and whole transaction (§14.6)| `DATABASE_LOCK_TIMEOUT_MS`, `DATABASE_STATEMENT_TIMEOUT_MS`, `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS`, `DATABASE_TRANSACTION_TIMEOUT_MS`| waiting and running inside the database| work outside the database, and the application's own computation| S0.6 (resource deadlines)| yes: applied by S0.6, sent to the server on every connection and per transaction|
| A call to a delivery provider, made outside any transaction (§13.9a)| `DELIVERY_EMAIL_TIMEOUT_MS`, `DELIVERY_SMS_TIMEOUT_MS`| that one call| anything but that call| S0.18 (delivery worker process)| no|
| A call to the verifier service, made outside any transaction (§15.2.1)| `ATTESTATION_VERIFIER_TIMEOUT_MS`| that one call| anything but that call| S0.55 (the private JVM verifier service); first caller S0.57 (`completeRiderDeviceEnrolment`)| no|
| The whole of a shutdown (B0.2, §12.5 below)| `SHUTDOWN_TIMEOUT_MS`, `SHUTDOWN_DRAIN_DELAY_MS`| draining and closing at stop| a request while the process runs| in force since B0.2| yes|
| A request's whole execution (§14.6 "request deadlines"; the plan's S0.6: "a request that exceeds a deadline answers the platform's generic operational failure")| `REQUEST_EXECUTION_BUDGET_MS`| the request's whole execution once it has been received and admitted: database work, and everything else the request does| the time before the request was received (the receipt limits), and work no one can cancel (an outbound call can be refused when it has not started and recorded when it ends late, not stopped)| S0.6 (resource deadlines) builds the shared execution-budget mechanism and chooses the setting, and the database layer consumes it; S0.20 (transport admission) integrates it into the request pipeline| no: the mechanism and the database layer exist, and no request has a budget until S0.20|

**A receipt limit ends a slow sender; it does not stop a handler.** `HTTP_HEADER_TIMEOUT_MS` and `HTTP_BODY_TIMEOUT_MS` end a connection whose client is too slow to send. Once a request has been received they bound nothing that it goes on to do. What bounds a handler is its execution budget (`REQUEST_EXECUTION_BUDGET_MS`), decided on 9 October 2026: S0.6 built the shared mechanism, S0.20 integrates it into the request pipeline, and **until S0.20 no request has a budget**: today a handler is bounded only by the database's own time bounds, which S0.6 applies to every transaction, and by the shutdown budget at stop. The provider and verifier timeouts will bound each outbound call, and the bounded hash admission of S0.16 (bounded hash admission) will bound how many hashes run at once and not how long a request takes. **The database timeouts alone do not bound a whole request**: time outside the database is outside them. Enforcing the budget means more than racing a response against a timer. On expiry it must cancel what can be cancelled, roll back the open transaction, discard a connection of uncertain state, and keep a late side effect from taking effect or record it (obligation OB-37 of the delivery plan); S0.6 does that for database work and refuses or records an effect started under a budget, and a commit whose outcome is unknown is reported as unknown, never as a rollback.

**Provisional defaults, validated by configuration only.** Every default in the table that bounds a resource and has not yet been applied (`HTTP_BODY_LIMIT_BYTES`, the `HTTP_*_TIMEOUT_MS` and `HTTP_ADMISSION_CONCURRENCY`, and the provider and verifier timeouts) is a **provisional default**: a number chosen so that a development or test run is bounded. The loader checks it against its stated bounds; `load-config.test.ts` proves exactly that and nothing about behaviour. No HTTP value has been measured, applied to a running server, or exercised under load, so none is yet qualified in the sense of the plan's engineering-parameter rule (section 3), and none is labelled development-qualified. **That obligation is unchanged and stays with the first consumer:** S0.20 (transport admission) for the HTTP limits and deadlines, and S0.18 (delivery worker process) for the provider timeouts each choose a measured development or test value, record the environment (machine, Node and PostgreSQL versions) and the test that exercises it, and label it development-qualified, not production-qualified. S0.6 (resource deadlines) has done so for the database deadlines, the pool waiters and the request budget (below). S0.65 (benchmark and capacity) then calibrates all of them on a recorded machine and proposes release values for the owner's approval; no earlier task waits for it. `HTTP_BODY_LIMIT_BYTES` keeps the 100 KiB the body parser already applies.

**What S0.6 applied and where it was exercised (development-qualified, not production-qualified).** The database layer applies the database deadlines and the pool bound, and the execution-budget mechanism consumes `REQUEST_EXECUTION_BUDGET_MS`. Each figure below is the default an environment gets, exercised by the named tests in the environment recorded under the table, and **not production-qualified**: S0.65 (benchmark and capacity) calibrates it and proposes the release value for the owner's approval. The relations hold as validated (`lock < statement < transaction`); the request budget is independent of them, because it also bounds work outside the database, and the effective bound on a transaction inside a request is the smaller of what the request has left and `DATABASE_TRANSACTION_TIMEOUT_MS`.

| Value| Figure| Applied as| Exercised by|
|---|---|---|---|
| `DATABASE_ACQUIRE_TIMEOUT_MS`| `5000`| how long a caller waits for a connection, the queue and the connecting together; also the pool's time to make a connection, for an attempt a caller gave up on| `connection-queue.test.ts`, `database-deadlines.test.ts`, `execution-budget.db.test.ts`|
| `DATABASE_POOL_MAX_WAITERS`| `50`| callers allowed to wait; one more is refused at once (`PoolSaturatedError`) and takes no connection| the same|
| `DATABASE_LOCK_TIMEOUT_MS`| `2000`| `lock_timeout` on every connection, from its start| `execution-budget.db.test.ts` (read back from the server as the runtime login; a lock wait ended by it)|
| `DATABASE_STATEMENT_TIMEOUT_MS`| `5000`| `statement_timeout` on every connection, from its start| the same|
| `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS`| `5000`| `idle_in_transaction_session_timeout` on every connection, from its start| the same|
| `DATABASE_TRANSACTION_TIMEOUT_MS`| `10000`| the transaction's budget (capped by the request's); the server's `transaction_timeout` is set for each transaction to the budget remaining plus the disposal bound| `database-deadlines.test.ts`, `execution-budget.db.test.ts`|
| `REQUEST_EXECUTION_BUDGET_MS`| `15000`| the budget a request will run under (S0.20 creates it); read by no request yet| `execution-budget.test.ts`, `load-config.test.ts`|
| the disposal bound (`DISPOSAL_BOUND_MS`, a constant in `execution-parameters.ts`)| `2000` ms| the longest clean-up after an expiry (the cancel and the rollback share it; nothing is sent after it passes), the server's margin past a budget, and the one bound on the whole cancel (the wait for a turn, the connection, the statement and its close)| `database-deadlines.test.ts`, `execution-budget.db.test.ts`|
| cancel connections at once (a constant in `statement-canceller.ts`)| `4`| the most connections open to cancel statements, so a stall that expires every request at once is not a storm of connections| `statement-canceller.test.ts`|
| the readiness check's deadline (`DEFAULT_CHECK_TIMEOUT_MS`, a constant in `readiness.registry.ts`)| `2000` ms| the longest a readiness check may take; the database check draws its wait for a connection and its query on it, and destroys its connection and gives its permit back when it passes, so a probe the database does not answer cannot hold the pool| `database-deadlines.test.ts`, `readiness.registry.test.ts`|

**Environment (10 October 2026).** Windows 11 Pro 10.0.26200 on an Intel Core i7-8750H (6 cores, 12 threads) with 15.9 GB of memory, a developer workstation shared with other work; Node 24.21.0; `pg` 8.23.1; PostgreSQL 18.6 (Debian 18.6-1.pgdg12+2) in a local container, reached on the loopback interface. **Measured over 20 runs each, as the runtime login, on an otherwise idle database (indicative, not a benchmark):** a transaction (begin, context, one statement, commit) took 5 ms at the median and 7 ms at most; a cancel (a new connection and `pg_cancel_backend`) 19 ms at the median and 46 ms at most; the caller was told 31 ms at the median (53 ms at most) after a budget ran out with a statement running, and 8 ms (14 ms at most) after it ran out with the work outside the database. The server ended a transaction at its `transaction_timeout` 290 ms after 300 ms was set (SQLSTATE `25P04`, the session terminated), which is why the server's bound is set past the budget: it fires only when this process could not clean up in time. The cancel needs no privilege beyond the runtime login's own (a role may cancel its own role's statements); it cannot reach another role's session (`execution-budget.db.test.ts`). `transaction_timeout` needs PostgreSQL 17 or later; the pinned version is 18.6.

**What S0.6 does not do.** It sets no HTTP receipt or admission limit and creates no request budget (S0.20); it gives no worker process its budget (S0.18); it proposes no release value (S0.65); and it does not qualify the figures at the deployed topology (release gate G2), where the network between the API and the database is the case the disposal bound's margin is for. The pool bounds the connections the API holds, not the sessions the server holds: a connection destroyed while its statement could not be cancelled leaves a session that lives until its statement or transaction timeout, so the server's `max_connections` is sized for the pool plus those.

**What S0.7 applied and where it was exercised (development-qualified, not production-qualified).** The policy-coordination toolkit (`platform/database/policy-lock/`) takes the transaction-scoped advisory locks of [SECURITY_DESIGN.md](SECURITY_DESIGN.md) §13.10a. It adds two engineering figures and no setting, and uses two that exist; each is exercised by the named tests in the environment recorded below, and none is production-qualified: S0.65 (benchmark and capacity) calibrates them.

| Value| Figure| Applied as| Exercised by|
|---|---|---|---|
| the restart bound (`POLICY_MAX_ATTEMPTS`, a constant in `policy-lock/coordinate.ts`)| `3` attempts| the most attempts of one operation, the first and two restarts; then `PolicyCoordinationError`, the generic operational failure| `coordinate.test.ts`, `policy-lock.db.test.ts`|
| the total operation deadline| `REQUEST_EXECUTION_BUDGET_MS` (default `15000`), or what the request has left if that is less| one execution budget, `policy-coordination`, under which every attempt and restart runs; a restart never grants a fresh deadline| the same|
| the lock wait| `DATABASE_LOCK_TIMEOUT_MS` (default `2000`)| `lock_timeout` on the connection bounds each acquisition; expiry is a `DatabaseDeadlineError` of kind `lock`, which is not retried| `policy-lock.db.test.ts`|

Measured on the same machine and server as the S0.6 figures (above), as the runtime login, over 20 runs each, on an otherwise idle database (indicative, not a benchmark): an operation of one discovery transaction and one locked transaction (the lock, the revalidation, an insert, the commit) took 12.5 ms at the median and 13.6 ms at most; with one restart 21.2 ms and 27.3 ms; with two restarts, all three attempts, 30.5 ms and 47.3 ms. The three attempts therefore use a small part of the total deadline, and the bound is the number of attempts, not time. The lock classes (`AUTH_POLICY_BUNDLE` 1296843313, `AUTH_POLICY_FIXED` 1296844337) and the bundle digest are engineering constants pinned by tests, not contract values: two instances that disagree on them would not exclude each other.

**The credential-hashing profile.** `ARGON2_MEMORY_KIB`, `ARGON2_PASSES` and `ARGON2_PARALLELISM` are the Argon2id profile new credential hashes are written at, and `ARGON2_ACCEPTED_PROFILES` lists the older profiles stored hashes may still be verified at. Their defaults are the **development-qualified** profile, 64 MiB, 2 passes and 1 lane: measured by S0.3a on one development machine, with the record in `apps/api/src/platform/auth/crypto/argon2-parameters.ts`, and **not production-qualified**. S0.65 (benchmark and capacity) proposes the release profile for the owner's approval. The loader checks that the profile is a cost the algorithm honours exactly; the Hasher is given it by whoever binds the Hasher, which the first consumer does. Staging and production refuse a write profile below 19456 KiB or 2 passes (the OWASP minimum named at the correction review of S0.3, taken as the initial policy, for the Product Owner to confirm); the floor judges what is written and not the older profiles. A stored hash is derived only at the write profile or a listed older one, so hash admission (S0.16 (bounded hash admission)) must budget for the largest profile it can be asked to verify, which is the largest listed, not only the current one. A stored hash is rewritten only forward, to a larger cost at the same lanes or a newer pepper version, and never to an older one; being able to verify a hash and being permitted to replace it are separate decisions. Verifying at the cost a hash was made with also means that, while a cost migration is under way, a real verification and the dummy one differ in cost: each is one bounded derivation, equal timing stays a diagnostic and not the proof (SECURITY_DESIGN.md §13.4b), and that window is to be assessed before a cost migration is enabled.

**What each environment refuses at start.** The checks run on the built configuration, so they hold for a configuration made by hand as for one made from the environment. They judge what is *selected*; a setting is applied only by the task that owns it (above).

| Selected| `local`| `staging`| `production`|
|---|---|---|---|
| `KEY_CUSTODY=local` (the key substitute)| allowed| allowed, for controlled fixture acceptance| **refused**: no production custody is built yet, so a production start is refused until one is|
| `DELIVERY_*_ADAPTER=capture`| allowed| allowed, for controlled fixture acceptance| **refused**|
| `ATTESTATION_VERIFIER=substitute`| allowed| allowed, for controlled fixture acceptance| **refused**|
| `RATE_LIMITER=memory`| allowed| **refused**| **refused**|
| an `ARGON2_*` write profile below 19456 KiB or below 2 passes| allowed, for an explicit test composition| **refused**| **refused**|
| the describe composition (inert adapters, hand-built configuration only)| allowed| **refused**| **refused**|
| any key, origin or required setting absent| refused| refused| refused|

**What staging's permissions are for.** Staging may run the local key custody, the capture delivery adapter and the substitute attestation verifier so that the slice's walk (the delivery plan's gate SW) can be done there against fixtures under control. That is **controlled fixture acceptance and nothing more**. It is not real-provider evidence (a real provider is exercised only in the controlled window of §4.1), not real-secret evidence (the local custody is a substitute, not KMS-backed custody), and not release evidence (gate G3 of the delivery plan). It extends no waiver and defers nothing.

**Production stays refused until managed key custody exists.** `KEY_CUSTODY=local` is the only custody built, and production refuses it, so no production start is possible yet. Building the managed custody, with a rotation proof for every key purpose and a recovery proof, is a **prerequisite of release gate G3** (obligation OB-36 of the delivery plan) and not a task of the identity slice. S0.2 does not implement it and does not weaken the refusal.

**The runtime composition refuses an inert adapter too.** Outside a local run only the runtime composition is allowed, and it binds nothing until a real adapter is added. Whatever is bound is also judged: the runtime composition refuses a binding that is one of the inert describe adapters, however it is supplied (a class, a ready instance, a factory, an alias), at registration for the written forms and when the application initialises for all of them. It leaves any other adapter, a test double included, alone. This is a wiring check against a mis-built composition root; it is not a defence against code that is already running inside the application.

`DATABASE_MIGRATION_URL` and `DATABASE_SEED_URL` are **forbidden** in the API's environment: the presence of either, with any value, stops the API at start, so that migration credentials and the provisioning login's credentials are never within reach of a request handler. Only the migration command reads the first and only the seed command (`db:seed`, below) the second.

**Shutdown has one budget.** On `SIGTERM` or `SIGINT` readiness turns `503` at once and the listener keeps serving for `SHUTDOWN_DRAIN_DELAY_MS`. Then Nest closes the application (the listener stops accepting, in-flight requests finish, the shutdown hooks run) and the registered resources close, last registered first (the database pool, from B0.4). **The drain delay and every step after it run inside `SHUTDOWN_TIMEOUT_MS`.** A clean shutdown exits `0` once the event loop drains. When the budget ends, nothing stalled is waited for: the listener and the remaining connections are closed, resources not yet confirmed are started but not awaited, the log names what is unconfirmed, and the process **exits with code `1` at once, even while a handle is still open**. A forced exit never claims that everything closed. **The supervisor's stop grace period must be longer than `SHUTDOWN_TIMEOUT_MS`**, so that the process ends itself, with its own record, before the supervisor kills it. `SHUTDOWN_DRAIN_DELAY_MS` should cover the time the load balancer needs to stop sending traffic after `/readyz` turns `503`.

**Database, roles and migrations.** The API reaches PostgreSQL through one lazily connecting pool, registered for shutdown, and sets a request's security context only inside a transaction (`set_config(…, true)`), so nothing survives on a pooled connection. `/readyz` is `503` with `dependency_unavailable` while the database does not answer **and while the connected role is not a safe runtime identity**: a superuser, a `BYPASSRLS` role, one that can create databases or roles, or one that owns the database or any object, directly or as a member of the owning role. Three roles exist, each with its own credential, provisioned outside the migrations: `melarc_owner` (`NOLOGIN`; owns every object), `melarc_migration_elevated` (runs migrations; a member of `melarc_owner`) and `melarc_api_runtime` (owns nothing, bypasses nothing, is a member of nothing).

**Schema changes are applied by one command and never by the API at start:** `pnpm --filter @melarc/api db:migrate` applies `apps/api/migrations/`, the one canonical history, as the migration identity (`DATABASE_MIGRATION_URL`), forward only, in one transaction and under an advisory lock, so two runs at once serialise and a repeat applies nothing. `drizzle-kit push` is not used. A migration that creates a table must, in the same file, assign it to `melarc_owner` and enable **and** force row-level security; the migration lint in `pnpm test` fails the build otherwise.

**Reference data is seeded by one command and never by the API:** `pnpm --filter @melarc/api run db:seed` fills a migrated, empty database as the provisioning identity (`DATABASE_SEED_URL`, with `APP_ENV` naming the environment; without them the local development database with the local provisioning login, and never a server that is not on the machine). It refuses a database that already holds any of what it adds, and `--fixtures` adds the test-only fixtures and refuses in production, before it connects ([MIGRATION_AND_SEEDING.md](MIGRATION_AND_SEEDING.md) §4 and §5.1).

**Locally**, `infrastructure/postgres/compose.yaml` runs the server (loopback only; the image, `postgres:18.6-bookworm`, is a provisional engineering choice, since no retained specification names a version). `db:bootstrap`, `db:migrate` and `db:reset` prepare it; `db:reset` refuses any server not on the machine, any `APP_ENV` of `staging` or `production`, any database but a `melarc_dev` or `melarc_test` one, and any database that does not carry the marker this tooling puts on what it creates. `pnpm test:db` runs the tests that need the server, each in a database of its own, and CI runs them against a service container. A run removes only the databases it made. A database a killed run leaves behind is never removed on a guess, because one with no connection may belong to a run between two steps: `db:orphans` lists the `melarc_test_*` databases that carry the marker (changing nothing), and `db:orphans --drop <name>…` removes the ones a person names, refusing any with a session connected unless `--disconnect` is added.

**Metrics** (decided 8 October 2026, not yet implemented). Counters and gauges are bounded and low-cardinality: no email, phone number, token, resource id or arbitrary URL ever appears in a label. A `/metrics` route, if one is exposed, is a technical route declared as such, reachable only on a private operations boundary with ingress restrictions and deployment authentication where needed — never through the public edge — and is added to the route inventory deliberately. Alert triggering and recovery are tested for the delivery backlog, terminal delivery failure, expired leases and trust-data staleness ([OBSERVABILITY_AND_RECOVERY.md](OBSERVABILITY_AND_RECOVERY.md) §3).

**Browser-history fallback.** The Ops Portal routes with the browser history, so its host must answer a request for **a document route** with the surface's `index.html`: a deep link or a reload on an unknown path must not be a `404` from the host. The fallback applies to document requests only. **It never applies to `/api/...`, to `/livez` and `/readyz`, or to a missing asset:** those keep their own `404`, so that a stale or mistyped asset fails visibly instead of arriving as HTML. This states the behaviour a host must have; what serves the bundle is still the proposal in §12.1.

**Decided 8 October 2026, not yet implemented.** *Trusted proxies*: `trust proxy` is off unless a deployment names its topology (§12.2). *Transport limits and deadlines*: identity mutations accept UTF-8 JSON and reject compressed request bodies, the body limit counts received bytes (chunked requests included), and header, body and admission deadlines and admission concurrency are configured, validated at start and measured on a recorded machine — they are engineering configuration, not product settings (§12.5 below and [permission-enforcement.md](../features/identity/permission-enforcement.md) §5.1 own the rules; [SECURITY_DESIGN.md](SECURITY_DESIGN.md) §13.4c covers hash admission). Future upload limits are their own rule. *Still not enforced*: today only the framework's default body limit applies and the API trusts no proxy. The settings that will carry these rules (`HTTP_TRUST_PROXY`, `HTTP_BODY_LIMIT_BYTES`, the header, body and admission deadlines and the admission concurrency) are now in the table above and validated at start (S0.2), which is configuration validation and not enforcement; the task that reads and applies them is S0.20 (transport admission). The variables the identity slice adds are listed in the table above as their tasks land.

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
