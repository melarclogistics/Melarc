# Solution Architecture

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.25 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** the platform, its boundaries, and how each approved rule is carried in code
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../PROJECT_MASTER_SPECIFICATION.md) §42 — **notably §42.2, the backend's five core responsibilities** — §40, §37, §39

## 1. What this document is, and what it may not do

It records **how** the approved rules are carried in code. It never decides **what** the rules are.

Architecture defines technical mechanisms for the retained product requirements. It does not silently change a product rule. Resolve a conflict with an owning contract before implementing the affected behavior.

**The practical test:** every rule below traces to something already approved. Where this document introduces a mechanism with no approved rule behind it, that is a defect — and one is flagged as such in §12.

## 2. The platform

`MSC-DEC-225`. One language across every surface.

| Layer| Choice| Why this domain wanted it|
|---|---|---|
| Backend| **NestJS**| Module boundaries and DI make the 17 permission domains and their guards testable in isolation|
| Data access| **Drizzle**| The hardest reads here are SQL-shaped; Drizzle keeps them legible instead of hiding them|
| Database| **PostgreSQL**| Transactional state transitions, `JSONB` for snapshots, row-level security for hub scoping|
| Rider| **React Native**| Shares the team's language. **Does not share the platform work** — see §9|
| Ops Portal, Vendor PWA| **React**| Types generated from the contract are consumed unchanged|

**What this costs, recorded so it is not rediscovered.** NestJS brings **no admin scaffolding**, and `SLICE-013` and `SLICE-014` are administration slices built from nothing. `MSC-DEC-218` put `SLICE-014` on the critical path — a hub cannot take a booking until all nine of its fee keys exist. If that slice runs slow, the cause is this choice, and revisiting it is legitimate rather than an admission of error.

## 3. The contract is hand-authored — and this inverts the framework default

`MSC-DEC-226`, and it is the single most important thing to get right at setup.

```
contracts/openapi.yaml   ← hand-authored, APPROVED, the source of truth
        │
        ├── generate ──▶  client types (Ops Portal, Vendor PWA, Rider)
        │
        └── CI compare ──▶  spec generated from NestJS decorators
                            MISMATCH = BUILD FAILS
```

NestJS conventionally builds its specification **from** decorators, making code the source. §42.1 forbids precisely that: *"current code does not silently override the contract,"* and *"schema generation/validation must detect drift."* **Generation is a check here, not an authoring tool.**

**Why this matters more on this product than on most.** Several approved rules exist *because* they are structural — unenforceable by review, enforceable only by schema:

| Rule| Carried as| What code-first would allow|
|---|---|---|
| The blind count is blind| `HubIntakePreCount` has **no** `rider_declared_count` property| Adding the field "for the UI" — and the count stops being blind, silently|
| Clients never set prices| `OrderItemize` is `additionalProperties: false`| An extra property accepted without review|
| Only carrier cost may be sent| One `Money` field, mode-gated| A second monetary field appearing by convenience|

Under a code-first pipeline, **any of those relaxes through an ordinary code change and the specification regenerates to match.** Nothing fails. That is the failure mode this inversion exists to prevent, and it is why the drift check belongs in CI beside the mechanical checks at [engineering-standards.md](../standards/engineering-standards.md) §4.

## 3.1 §42.2's five core responsibilities, and where each one lives

| §42.2 requires the backend to| Carried at|
|---|---|
| Authenticate identities and enforce session and device policy| §13 below; [state-machines.md](../contracts/state-machines.md) §13 `Session`|
| Authorize **every** action using surface, role, ownership, record state and approval conditions| §6 below — two gates, four axes|
| Enforce vendor ownership and **audited** cross-vendor access| §6 and §11; [permissions.md](../contracts/permissions.md) §9|
| Validate commands and execute state transitions **atomically**| §7 below; `MSC-DEC-231`'s atomic dispatch is the worked case|
| Maintain canonical entities, invariants and **historical snapshots**| §8 below; [domain-model.md](../contracts/domain-model.md) §3.7|

**All five were already carried — none was missing.** That is the useful result rather than a disappointing one: the check's job is to prove coverage rather than assume it, and an uncited section is unproven either way. **§30.8 was in precisely this state for ten days** and turned out not to be covered at all.

## 4. Where each rule is enforced

`engineering-standards.md` §2 ranks enforcement: **structural** beats **mechanical** beats **review**, and *"a rule enforced at review level that could have been structural is a defect in the enforcement."* This maps it.

| Rule| Level| Mechanism|
|---|---|---|
| Blind count withheld| **Structural**| Absent from the response schema. No handler can leak it|
| No client-set price| **Structural**| `additionalProperties: false` + generated types|
| Money is integer minor units| **Structural**| `bigint` columns, `_minor` suffix enforced by a lint rule on schema names|
| Currency is GHS only| **Structural**| Single-value enum|
| Two orthogonal `Order` states| **Structural**| Two columns, two enums; no combined state exists to mis-set|
| Hub scoping| **Structural**| PostgreSQL row-level security, **transaction-local** context on a **`NOBYPASSRLS` non-owner** role — see §6. **Both halves, or neither**|
| Optimistic concurrency| **Mechanical**| `If-Match` required on mutating routes; a guard rejects its absence|
| Idempotency| **Mechanical**| **Principal + operation + key**, payload hash inside that identity, unique-constrained|
| State transitions| **Mechanical**| One transition service per machine; direct status writes barred by lint|
| Snapshot-on-write| **Mechanical**| Repository-level; a test asserts every priced write carries hub, key, version, value|
| Audit completeness| **Mechanical**| Event emitted in the same transaction; a test asserts coverage against `audit.md`|
| Credential strength| **Structural**| `minLength` 12 and `maxLength` 128 on the three schemas that create a credential, repeated in the credential service before it hashes (`MSC-DEC-431`, [SECURITY_DESIGN.md](SECURITY_DESIGN.md) §13.4a)|
| Sign-in lockout| **Mechanical**| Counters on the embedded credential record, updated by one atomic statement, excluded from the record's version; a failed sign-in cannot move an `ETag` ([SECURITY_DESIGN.md](SECURITY_DESIGN.md) §13.4b)|
| Mid-session revocation| **Structural**| A `Session` state change made **in the same transaction as the act that caused it**; there is no second store and no interval in which a decision exists and its effect does not ([SECURITY_DESIGN.md](SECURITY_DESIGN.md) §15.3)|
| Reason-code requirements| **Mechanical**| Schema-level conditional requirement|
| Size class is judgement| **Review**| *Nothing structural can help* — `MSC-DEC-209` establishes no thresholds, so no rule can validate the choice. The audit record is the whole control|

**The last row is the honest one.** Exactly one revenue-affecting decision in this product cannot be enforced by anything but a recorded actor and a human looking later. That is a deliberate product choice, not a gap to engineer away.

**The Hub-scoping row said *session-scoped* until 27 August, and on a pooled connection that phrase named the defect rather than the control.** A session-wide setting survives the request; the connection returns to the pool still carrying one actor's Hub set. `MSC-DEC-275` makes the context transaction-local and `MSC-DEC-276` removes the owner exemption that `ENABLE ROW LEVEL SECURITY` leaves behind — **and neither control is sufficient alone.** Transaction-local context under a `BYPASSRLS` role enforces nothing; role separation without transaction-local context still leaks across the pool. This is the clearest instance in the document of a rule recorded at the **structural** level whose structure had not been specified.

## 5. Module boundaries

NestJS modules follow the **17 closed permission domains** of `permissions.md` §4, not technical layers. A domain that needs a new module needs a Product Owner decision first, because it means an eighteenth domain.

```
src/
  platform/     auth · authorization · audit · idempotency · concurrency · settings
  pickup/       requests · manifests · stops · collection · failure
  hub/          handover · intake · blind count · OS&D · itemization
  pricing/      calculation · corrections · repricing
  … one module per domain
```

**`platform/` is cross-cutting and every domain depends on it.** Nothing in `platform/` may depend on a domain module — that dependency direction is the thing that keeps authorization and audit impossible to bypass per-feature.

## 6. Authorization: two gates, four axes

`permissions.md` §2: two **independent** checks, and passing one never implies the other.

1. **Surface gate** — Melarc Ops, Vendor and Rider are different tools, not one system behind three logins.
2. **Permission and ownership gate** — held permission, plus the four scope axes.

**Implemented as a guard chain**, deny-by-default (§37.1). A route with no permission declared is **refused**, never permitted by framework default — enforced by a test that enumerates every route and fails on any lacking a declaration.

| Axis| Carried as|
|---|---|
| Hub scope| PostgreSQL **row-level security**, hub set per request from the session and installed **transaction-locally**|
| Ownership| Policy predicate per resource — own / assigned / any|
| **State precondition**| Evaluated **with** the state machine, never before it|
| Time window| Temporary-assignment grants with explicit validity|

**The state-precondition axis is the one most easily dropped**, and `permissions.md` §5 says so. A check answerable from the actor alone is wrong: `pickup.request.cancel` held with *own record* scope still fails once a rider is assigned. **Authorization and the state machine are one decision, not two**, which is why every transition in `state-machines.md` carries an actor column.

**What a refusal reveals is decided per axis, not once**. A missing permission is `PERMISSION_DENIED` and a missing tier `INSUFFICIENT_AUTHORITY`. **Authenticated staff are told** when a record exists outside their hubs (`HUB_SCOPE_VIOLATION`) and when it does not (`NOT_FOUND`). **A Vendor and a Rider are never told** that another party's record exists: their row-level policies return nothing, the handler finds nothing, and the answer is the nonexistent one. Row-level security cannot tell the two staff answers apart, so a staff read that found nothing in scope is followed by one narrow probe that no other principal takes — [SECURITY_DESIGN.md](SECURITY_DESIGN.md) §4 and §14.4b.

**Row-level security rather than application-level filtering** because a forgotten `WHERE hub_id = ?` is a cross-hub data leak, and there will be hundreds of queries. RLS makes the omission impossible rather than unlikely — structural over mechanical, per §4.

**Hub scope is a set or an explicit all-Hub authority, never one `hub_id`**. §11.6 permits several authorised Hubs and §37.3 permits all-Hub access, so the context carries `hub_scope_mode` — `SET` or `ALL` — beside `authorized_hub_ids`. **`ALL` is never inferred** from an empty list, a missing context, a client request, or a bundle name. **An empty Hub set means no Hub-scoped rows**, which is the one condition an application-assembled predicate reliably inverts: an empty list reads as *no filter needed*, and the actor with the least authority in the product sees everything.

**Access is evaluated by principal type, not composed across principals**. A `STAFF` branch reads the hub set; a `VENDOR` branch reads `vendor_organization_id` **and no hub at all**; a `RIDER` branch reads the assignment; `SYSTEM` reads an explicit task capability or the trusted `Outbox` envelope; anything else denies.

**R0 composed them instead, and on `Order` that denied legitimate access.** A vendor's order sits in whichever hub is fulfilling it, and **a Vendor principal holds no `authorized_hub_ids`** — so a Hub predicate evaluated first leaves *the vendor sees nothing* or *an empty hub set is permissive*, and the second is the inversion `MSC-DEC-275` exists to prevent, reached by a different route. **The vendor's boundary was never the hub.**

**The policy patterns live at [SECURITY_DESIGN.md](SECURITY_DESIGN.md) §14.4**, and the trap that survives R1 is `USING` without `WITH CHECK` — it protects reads and says nothing about writes. Every table's per-principal predicates are [data-scope-registry.md](../contracts/data-scope-registry.md).

**Reads are permissioned too.** `MSC-DEC-221` supplied sixteen read keys, one per domain. Before it, no list screen in the product could express who may open it.

## 7. Idempotency, concurrency, and the difference between them

`CONFLICT-027` records the distinction, and it is load-bearing: **idempotency is not offline capability.** An endpoint being safe to retry does not make it safe to queue.

| Concern| Mechanism|
|---|---|
| Idempotency| **`principal_type` + `principal_id` + `operation_id` + `idempotency_key`**, unique-constrained, with `payload_hash` evaluated **inside** that identity. Replay returns the original response|

**`route` is not `operation_id`, and the difference is not cosmetic.** A route is a transport detail that can change without the operation changing; `operation_id` is the contract's stable name for the act. **And a formula with no principal in it is the one that let a vendor replay another vendor's stored result** — `Idempotency-Key: retry-1` is what two independent clients both send.

**`IdempotencyRecord` is a persistent technical table, declared here for mechanical discovery**:

```
PERSISTENT-TECHNICAL-TABLE: IdempotencyRecord
```

**The declaration lives at the architecture definition point, not in the Registry** — contract-consistency validation reconciles three independent sets, so a technical table added here and forgotten in the Registry fails the check instead of passing unnoticed.


| Concurrency| `ETag` / `If-Match`, version-based. `MSC-DEC` per `domain-model.md` §7: version-based subsumes state-based|
| Conflict| `409` with `STATE_CONFLICT`. **Never a silent overwrite** — two receivers on one intake, one wins and the other is told|

## 8. Data and historical integrity

§42.6 and `domain-model.md` §3.7.

- **Snapshots, not joins.** A record depending on mutable configuration stores value, setting key, **hub** and version. The hub became part of it at `MSC-DEC-218` — fees are hub-scoped, so version counters collide across hubs and key-plus-version stopped identifying anything.
- **Actor bundles snapshot at write time.** Resolving an actor's authority at read time would show today's bundle against yesterday's action.
- **Reason codes carry their label**, so renaming a reason does not rewrite history.
- **Append-only audit.** No update path, no delete path, enforced by table permissions rather than convention. **This constrains the application and not a credential holder**, so `MSC-DEC-283` adds an independent KMS-signed integrity checkpoint over an immutable mirror — see [SECURITY_DESIGN.md](SECURITY_DESIGN.md) §14.11. Append-only is a strong control and was never tamper evidence.
- **Effective-dated settings.** New charges take the new value; existing charges do not reprice.

## 9. The rider app, and the honest cost of React Native

`MSC-DEC-225` chose React Native for language uniformity. **It shares the team's language, not the platform work.** Every §40.5 requirement needs a native module:

| Requirement| Native work|
|---|---|
| Device registration, one device per rider| Keystore-backed key, attested on registration|
| Local security for the queued command| Encrypted storage, not AsyncStorage|
| Evidence capture| Camera with EXIF and location|
| Background sync| Native scheduler|

**Attestation is verified behind one interface**. The native module generates the hardware-backed signing key — `TrustedEnvironment` or `StrongBox` — with the attestation challenge the enrolment QR carries and returns the Android Key Attestation chain beside the public key. In `platform/auth` a `RiderDeviceAttestationVerifier` receives that chain and returns one of four outcomes — accepted, unsupported, integrity failed with a cause, or trust data unavailable — so **Android-attestation parsing lives in one adapter** and the rest of authentication never handles a certificate. A production adapter and a **test substitute** implement it; the substitute is Local and Staging only and the application refuses to start in production with it selected ([DEPLOYMENT_AND_ENVIRONMENTS.md](DEPLOYMENT_AND_ENVIRONMENTS.md) §12.3). **It is called at enrolment and replacement and nowhere else**: sign-in verifies a signature over a single-use challenge against the registered key and calls no attestation service, so no live session depends on one. The policy is [SECURITY_DESIGN.md](SECURITY_DESIGN.md) §15.2.1. **The one thing it depends on is trust data** — the accepted roots and Google's revocation list — loaded by the verifier itself in each API instance, with a 24-hour maximum age and a fail-closed rule (`503` `TRUST_DATA_UNAVAILABLE`) for enrolment and replacement only ([SECURITY_DESIGN.md](SECURITY_DESIGN.md) §15.2.2); it is no scheduled job and needs no broker. **The minimum Android version is 24** — a technical floor the Product Owner accepted for Version 1, and not a commitment to support every such handset — the lowest level at which a key can carry an attestation challenge, and secure local storage is an **Android Keystore AES-256-GCM key** with the storage library left to the Frontend Engineer ([SECURITY_DESIGN.md](SECURITY_DESIGN.md) §15.2).

**Offline is deliberately narrow.** §19.8 approves **one** offline command — **hub-handover submission**. Everything else, collection submission included, requires connectivity (`domain-model.md` §7, `CONFLICT-027`). This keeps the sync layer to a single queued command type with one conflict rule, which is what makes the choice affordable. **Widening the offline set is a product decision, not an engineering convenience**, and it would multiply this layer.

**MED-09 audit remediation: this is a named, accepted risk, not an unexamined gap.** §46.1 lists **"Rider offline complexity"** among the twelve principal product and delivery risks `MSC-DEC-161` approved — *"native Android execution must tolerate unreliable connectivity while protecting custody, OTP, payment, and evidence,"* impact *"duplicate/stale actions, local-data exposure, and evidence loss,"* owned by the **Frontend Engineer**, required response *"bound the offline action set."* A rider who loses connectivity while physically holding a parcel — collection recorded nowhere until signal returns — is the concrete instance of that risk, not a separate one. **The required response is already the tracked mitigation**: §19.8's narrow approval *is* "bound the offline action set," and the remaining design work (encryption, retry, conflict handling, device loss) that response also names was written when `OQ-027` closed on 28 September 2026, at `surfaces/rider-android.md` §4.1.

## 10. Rate limiting

`MSC-DEC-224`: **per credential, never per address.**

| Surface| Posture|
|---|---|
| Shared vendor credential| Tightest — one login, many people, highest-volume abuse path|
| Rider device| Tight — bounded, predictable traffic|
| Staff session| Moderate — must clear a busy hub during intake|
| Service accounts| Per integration, aligning with §39.9|

**Enforced at the API edge, keyed on the credential**, before the handler. An address-keyed limit would throttle a hub whose staff share one connection while doing nothing about a credential used from many. **The one backstop is the deployment's per-address ceiling at the edge, for operations whose key an attacker chooses** ([DEPLOYMENT_AND_ENVIRONMENTS.md](DEPLOYMENT_AND_ENVIRONMENTS.md) §12.2): infrastructure, not a bucket. **The launch figures are set** — `MSC-DEC-371`, closing `OQ-067` — and remain launch configuration under `MSC-DEC-217`, recalibrated from telemetry rather than replaced by it.

**And launch configuration needed somewhere to live.** `MSC-DEC-217` makes every launch figure portal-administered, which requires keys in `contracts/settings.md`. **None existed for rate limits** when the gap was found on 23 August and raised as `OQ-077`. How many buckets the limits need — one default, or separate ceilings for the shared vendor credential and the rider device — is a **design choice rather than a value**, which is why the keys were not simply added at the time. **`MSC-DEC-285` made that choice on 27 August: six keys at [settings.md](../contracts/settings.md) §7.7, closing `OQ-077`** — and `MSC-DEC-371` valued all six on 5 September.

**`MSC-DEC-285` makes that choice: six buckets**, at [settings.md](../contracts/settings.md) §7.7.

| Bucket| Keyed on|
|---|---|
| Staff sign-in| Normalized Staff identity|
| Privileged MFA| MFA challenge / principal|
| Vendor sign-in| Vendor account **and** registered device|
| Rider challenge / sign-in| Submitted phone number|
| Recovery| Recovery principal|
| Authenticated API| Active Session|

**Six rather than one, because a shared bucket lets one credential's abuse throttle another's legitimate traffic** — the mirror of the address-keyed failure `MSC-DEC-224` rejected. **Privileged MFA is separated from Staff sign-in deliberately**: `mfa_max_attempts` is 3 against `signin_max_attempts` of 5 precisely because a wrong code from someone who already proved a password is *more* suspicious, and one shared bucket would make that reasoning unexpressible.

**`OQ-077` closed on 27 August and `OQ-067` on 5 September**, in that order and nine days apart. **The bucket architecture existing and the launch figures being supplied are two statements**, and production readiness must not read the first as the second — which is exactly why they closed separately.

**The launch values**: staff sign-in **10/min** · privileged MFA **10/min** · vendor sign-in **10/min** · rider challenge **20/min** · recovery **10/min** · authenticated API **120/min**. **Not one bucket key or credential keying changed**, and **no IP or source-address bucket was added** — a launch figure is not the place to overturn `MSC-DEC-224`. Two operation-specific sub-ceilings sit **inside** the authenticated-API bucket and are **not** a seventh and eighth bucket.

**The posture table and the flat ceiling agree, and `MSC-DEC-386` settled that they always did.** The rows above describe **credential classes, not operations**: the **Staff session** row’s *"Moderate"* **is** `rate_limit_authenticated_api` at **120/minute** — six times the rider bucket and twelve times the vendor bucket — and *"must clear a busy hub during intake"* is the **rationale for that looseness**, not a promise of a further per-operation exemption on top of it. **The arithmetic confirms it**: `submitBlindCount` submits one count in one call whatever the parcel quantity, and `MSC-DEC-369`’s launch volumes are one hub and fewer than 50 parcels a day, so reaching 120/minute would take two requests per second sustained for a minute from a person counting boxes. **`hub_intake_rate_limit` is removed from [settings.md](../contracts/settings.md) §7.7 rather than valued**, and **`RATE_LIMITED` gains an alert** ([OBSERVABILITY_AND_RECOVERY.md](OBSERVABILITY_AND_RECOVERY.md) §3) so the ceiling is revisited on telemetry rather than on a calendar.

## 11. Multi-hub from day one

§660: one active hub at launch, *"must model multiple hubs without redesign."*

Every operational and financial record carries `responsible_hub_id` — **and [data-scope-registry.md](../contracts/data-scope-registry.md) is where each one says which field, or which parent, that Hub is read from**. Hub scoping is RLS, not a filter added later. **`VendorStatement` is the deliberate exception and the one most likely to be wrongly hardened**: §5.2.5 issues one weekly statement per vendor across all hubs, so a Hub column there does not leak — it under-bills. **Fees are hub-scoped and never inherit** (`MSC-DEC-218`, §33.4): a hub missing a value **fails visibly** rather than borrowing another's. There is no global fallback table to add, and adding one later would be a regression.

### 11.1 Launch scaling posture

`MSC-DEC-369`. **No multi-region platform is required for the approved launch target**, and the approved target is ~150 vendors, ~10 riders, one hub and fewer than 50 parcels a day ([OBSERVABILITY_AND_RECOVERY.md](OBSERVABILITY_AND_RECOVERY.md) §5.2).

| Element| Launch posture|
|---|---|
| Region| **Single production region**, selected on **measured** latency to Accra — [DEPLOYMENT_AND_ENVIRONMENTS.md](DEPLOYMENT_AND_ENVIRONMENTS.md) §3 measures rather than assumes|
| API| **Stateless**, horizontally scalable|
| Workers| Horizontally scalable, with **bounded concurrency** ([BACKGROUND_JOBS_AND_EVENTS.md](BACKGROUND_JOBS_AND_EVENTS.md) §3.8)|
| PostgreSQL| **Private.** No public endpoint|
| Broker and cache| **Private**|
| Evidence| Direct **short-lived single-object** capabilities under Gate B|
| Backup plane| **Separate**, unreachable with application credentials|

**Scale on measured pressure, not on speculative enterprise architecture.** 99.5% over operating hours is comfortably single-region, and §2 already declined the multi-region complexity that a calendar reading of the target might have seemed to justify.

**One constraint makes this posture safe to grow out of, and it is the reason the section belongs here rather than in the deployment document:** **a future second hub must not require changing the RLS or data-isolation model.** §11 above already builds for multi-hub from day one — the scaling posture is allowed to be modest precisely because the isolation model is not. **A capacity assumption may be revised by a settings change or a bigger instance; a data-isolation model may not**, and the launch volumes at §5.2 of the observability document are explicitly not permanent ceilings.

## 12. What this document does not settle

| Item| Owner|
|---|---|
| ~~Deployment, environments, hosting region~~| **Written** — [DEPLOYMENT_AND_ENVIRONMENTS.md](DEPLOYMENT_AND_ENVIRONMENTS.md), `APPROVED`. Network trust zones and the TLS baseline settled 27 August, `MSC-DEC-280`, at its §12|
| ~~Background-job and event design~~| **Written** — [BACKGROUND_JOBS_AND_EVENTS.md](BACKGROUND_JOBS_AND_EVENTS.md), `APPROVED`. The broker product is `OQ-115`|
| ~~Observability, backup and recovery targets~~| **Written** — [OBSERVABILITY_AND_RECOVERY.md](OBSERVABILITY_AND_RECOVERY.md), `APPROVED`|
| SMS provider, **transactional email provider** and OTP parameters| `OQ-048`. No provider is selected; the credential service sends through one port with a non-production capture adapter ([SECURITY_DESIGN.md](SECURITY_DESIGN.md) §13.9a)|
| ~~Rate-limit figures~~| **Settled by `MSC-DEC-371`** — six buckets valued, `OQ-067` closed|
| Service-account permissions| `OQ-047`. **Gate B rules out a human `RoleBundle`** and settles nothing else|
| ~~Evidence signed-URL lifetime · audit checkpoint interval~~| **Settled by `MSC-DEC-297`** — upload **15 min**, retrieval **5 min**, checkpoint **15 min**. `OQ-102` and `OQ-103` closed|
| ~~Offline set beyond collection~~| **Settled for Version 1 by `MSC-DEC-415`** — hub-handover submission is the whole offline scope, collection and every other command online-only, the wider design formally deferred under §50.4. **The one queued command's design is written** (`MSC-DEC-419`, `OQ-027` closed); the criteria that exercise it are `OQ-030`'s|

**One flag against my own work.** §4's *"`_minor` suffix enforced by a lint rule"* and §6's *"a test that enumerates every route"* are mechanisms this document proposes, not rules any contract states. They implement approved intent — the money convention at `domain-model.md` §3.2 and deny-by-default at §37.1 — but the specific mechanisms are engineering judgement and should be reviewed as such rather than cited as approved.

## 13. Session transport — the definition the contracts pointed at

**`domain-model.md` §6.8 said the session token is *"delivered by the transport mechanism defined in Solution Architecture."* This document did not define it.** Everything about the `Session` record was specified except what the client presents on the next request. Gate A closes that; the full mechanics are at [SECURITY_DESIGN.md](SECURITY_DESIGN.md) §13 and the summary below is the part this document owes.

**Opaque server-side sessions. No JWT, no refresh-token subsystem.**

| Surface| Credential| Held in|
|---|---|---|
| Ops Portal, Vendor PWA| `melarc_session` — **`HttpOnly`, `Secure`, `SameSite=Lax`** cookie| Browser; **JavaScript never reads it**|
| Ops Portal, Vendor PWA| `melarc_csrf` — `Secure`, `SameSite=Lax`, **deliberately not `HttpOnly`**| Browser; **JavaScript must read it**, to echo it in `X-CSRF-Token`|
| Melarc Rider| Same opaque secret as a **Bearer** credential, returned **exactly once** in `RiderSessionIssued`| Local storage encrypted by a non-exportable **Android Keystore AES-GCM key** ([SECURITY_DESIGN.md](SECURITY_DESIGN.md) §15.2)|

Only `Session.token_hash` and `Session.csrf_token_hash` are persisted. Unsafe cookie-authenticated requests additionally require the **synchronizer token and `Origin` validation**, failing with `CSRF_VALIDATION_FAILED`.

**The contract enforces that rather than describing it**. `csrfToken` is a security scheme composed with `browserSession`; the global default is the CSRF-bearing alternative, safe reads opt out explicitly, and a mechanical check reports **protected unsafe operations missing browser CSRF requirement: 0**.

**Cookies are declared as cookies.** One real `Set-Cookie` header plus an `x-set-cookies` extension naming which of the three cookies a response sets or expires, resolving against a root registry; `x-set-cookies-for` limits that to a request that presented one security scheme's credential, which is how a browser sign-out clears two cookies while a Rider's bearer sign-out sets none. The contract previously invented `X-Set-Csrf-Cookie` and `X-Set-Vendor-Device-Cookie` — **not HTTP headers**, and a literal implementation would have emitted two headers no browser stores.

**The vendor device credential is a declared pre-session security scheme**. `vendorDevice` sits alongside `browserSession`, `csrfToken` and `riderSession`: it proves *which browser* before any session exists, and `vendorSignIn` requires it. **A credential no operation requires is not a factor**, and this one was required by nothing until R1.2.

**Staff sign-in returns 200 or 202, never one code meaning both**. Ops Staff get a Session and its cookies; Senior Ops and Platform Admin get an `MfaChallenge` and nothing else. That split is what makes **no privileged Session before proven MFA** a property a test can assert against the contract.

**The two cookies have opposite readability rules and that is the mechanism, not an inconsistency**. A synchronizer token the page cannot read cannot be echoed; a session cookie the page can read is one an injected script can steal. **The CSRF token is safe to expose precisely because it is useless without the cookie that is not.**

**The rider's credential is the one place a raw session secret appears in a response body**, because a native client has no `Set-Cookie` equivalent — there is no other moment at which it can receive it. Gate A returned the canonical `Session` resource, correctly carrying no secret, and left the handset **authenticated with nothing to send** (R1). Canonical `Session` representations still never carry it: `getCurrentSession` returns `Session`, never `RiderSessionIssued`.

**Why this and not JWT, in one line:** Melarc already requires immediate revocation, session displacement and one-session enforcement, which erase statelessness — so a JWT would need a revocation list to behave correctly, and a revocation list is a session table.

**Three mechanisms this section owes, written at Gate PD-3R1**. **Revocation** is a state change on the session row — a suspension, a device revocation or replacement, a recovery or an authority change calls `terminateSessions` inside its own transaction — so the revocation store is PostgreSQL and the Redis blocklist an earlier draft proposed is withdrawn ([SECURITY_DESIGN.md](SECURITY_DESIGN.md) §15.3). **Message delivery** is one port, `SecurityMessageDelivery`, called before the issuing transaction commits so a refused send leaves nothing behind, with a capture adapter that reaches no recipient in Local and Staging ([SECURITY_DESIGN.md](SECURITY_DESIGN.md) §13.9a). **Lockout** is a counter on the credential, counting only once a request has reached the credential's own factor, so an attacker who has proved nothing can neither lock an account nor learn that it exists ([SECURITY_DESIGN.md](SECURITY_DESIGN.md) §13.4b).

**The rider app's constraint is real here.** §9 records React Native's cost honestly; the keystore-backed keypair and the secure credential store are **native platform capabilities**, and this is one of the places where that cost is paid rather than avoided.


## 14. §37.8 authentication gate — what this document contributes

**This section replaced two.** §13 and §16 were both tables answering *"what does §37.8 still need?"*, written eight days apart, **and they disagreed**: one said audit events were settled at *45 codes* while the catalogue held 99, one said recovery was **open** and the other **delivered**. Two tables answering the same question is not redundancy — it is a guarantee that one of them is wrong and nobody can tell which. Derived from the contracts as they stand on 27 August:

| §37.8 element| Status| Where|
|---|---|---|
| Factor mechanics| **Delivered**| `MfaFactor` — TOTP, **proven not asserted**; [SECURITY_DESIGN.md](SECURITY_DESIGN.md) §13|
| Token and session mechanics| **Delivered**| §13 here — opaque, hashed, transport defined per surface|
| Device mechanics| **Delivered**| Rider keypair possession; vendor browser device credential|
| Authorization checks| **Delivered**| §6's two gates and four axes|
| Audit events| **Delivered**| **22 `auth` events of 99** in [audit.md](../contracts/audit.md)|
| Recovery| **Delivered**| Password, MFA and device paths **separated**, each with its own authority and its own operation|
| Rate limits| **Complete**| Model `MSC-DEC-224` · buckets and keys `MSC-DEC-285` · **figures `MSC-DEC-371`**|
| Secrets| **Partial**| Plaintext prohibited now; key custody is **Gate B**|
| Negative tests| **Not delivered**| No code exists|

**Two elements were open at Gate A and neither was this Gate's to close**, and both have since closed. **Rate-limit figures** were a Product Owner decision and `MSC-DEC-371` took it on **5 September**, closing `OQ-067`; **key custody** was Gate B's and `MSC-DEC-281` settled it on **27 August**.

**`SLICE-000` reached `READY` on 27 August 2026**, and was never held back by anything in this table. **Its verdict since then is `SLICE-000.md`'s to state** (§4 and the revision history there) and is not restated here, because a verdict that moves would make this sentence wrong each time. Its last blocker that day was specification §44.2 (domain and rule readiness) on **two unsigned state machines** — `MfaFactor` and `SetupGrant` — a signature only the Product Owner could supply, and did: `MSC-DEC-273` and `MSC-DEC-274`.

**Gate PD-3R1 added three rows this table could not have carried in August**, all *Delivered* in [SECURITY_DESIGN.md](SECURITY_DESIGN.md): **lockout and credential strength** (§13.4a, §13.4b), **message delivery** (§13.9a) and the **revocation store** (§15.3) — each a mechanism a contract already named and no document had defined. The table above is a record of 27 August and is not restated.

## 15. Related

- **Security:** [SECURITY_DESIGN.md](SECURITY_DESIGN.md)
- **Contracts:** [openapi.yaml](../contracts/openapi.yaml) · [permissions.md](../contracts/permissions.md) · [domain-model.md](../contracts/domain-model.md)
- **Standards:** [engineering-standards.md](../standards/engineering-standards.md) — the enforcement ladder §4 maps to
- **Slice:** `SLICE-000` in [IMPLEMENTATION_PLAN.md](../delivery/IMPLEMENTATION_PLAN.md)
