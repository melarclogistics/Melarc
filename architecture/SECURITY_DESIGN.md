# Security Design

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.37 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** how authentication, authorization, session, device, secrets and security audit are **built**
> **Carries no product authority** — `MSC-DEC-205`, §42.7. This document implements the specification and may never redefine it
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../PROJECT_MASTER_SPECIFICATION.md) §37, §11.1–11.2, §38.4, §40.2
> **Satisfies:** the §37.8 acceptance gate · unblocks `SLICE-000`

## 1. Why this document exists

§37.8 is the hardest gate in the specification:

> *"Login, vendor records, rider access, OTP, payment, suspension, or privileged approval implementation is **not ready** until security architecture and OpenAPI define factor/token/session/device mechanics, authorization checks, audit events, secrets, rate limits, recovery, and negative tests consistent with these confirmed policies."*

**Session and device mechanics are settled as of 23 August.** `MSC-DEC-234` fixed session lifetime and added `session_idle_timeout_minutes`, both per-tier; `MSC-DEC-235` fixed device loss and re-registration; `MSC-DEC-236` supplied the lockout and token figures. **On 23 August rate limits were the last item in that sentence still open**, and `OQ-077` recorded that they had nowhere to be configured. **They are not open now.** `MSC-DEC-285` created the six canonical buckets and their settings keys on **27 August**, closing `OQ-077`; `MSC-DEC-371` supplied their launch values on **5 September**, closing `OQ-067`. **Rate limiting is no longer an open readiness item** — the keying stays **credential-based**, there is **no seventh or eighth bucket and no IP or source-address bucket**, and post-launch telemetry recalibrates the values without touching the architecture.

That is seven named deliverables gating **most of the product**. Until 17 August this document had no home; `MSC-DEC-205` created the `architecture/` layer and `SLICE-000` in the implementation plan depends on it.

**Its authority position matters.** §42.7: *"these technical artifacts implement this Master Specification; they do not silently redefine product behaviour."* Where this document appears to change a rule, it is wrong by construction — raise a contradiction rather than follow it.

## 1a. The payer's PIN, and the provider's credentials — *Gate C C1.4*

`MSC-DEC-355`. **Two absolutes, stated where they will be read.**

**Melarc never requests, receives, transmits, logs or stores a mobile-money PIN.** It belongs entirely to the provider-controlled authorisation prompt on the payer's own handset. Melarc screens may say **approve the payment request on your phone**; they may never say **enter your MoMo PIN here**. **No schema, entity, API field, log or screen carries one** — a field that could hold a PIN is a field that will hold one, and the safe design is the one where the value never reaches Melarc's process at all.

**Provider credentials are server-side only**, held through the existing secret mechanism, and appear in **no** Rider Android build, Ops Portal JavaScript bundle, source-controlled frontend configuration, API response or log line. **Only the Melarc backend speaks to the provider** — a handset or a browser calling Hubtel directly would put a merchant credential on a device Melarc does not control.

**Payer numbers are redacted in logs.** They are personal data, and a collection attempt is a high-volume event.

## 2. What §37 already settles

These are **confirmed product policy** and this document implements them without variation.

| Actor| Authentication| MFA| Session|
|---|---|---|---|
| Ops Staff| Email and password| No| Standard|
| **Senior Ops, Platform Admin**| Email and password| **Required before privileged access** (§11.2, §37.2)| **Privileged**|
| Rider| Registered phone **plus private PIN**| No| **One registered device**|
| Vendor| Shared credential per organization| No| **One active session — a new login ends the previous**|

**Recovery paths, also confirmed:** staff through verified work email; vendors through registered phone or email; riders through **Ops identity verification and device re-registration**. Platform Admin handles exceptional staff and vendor recovery; **Senior Ops handles rider recovery** (§11.2, §37.2).

## 3. The five security principles this design implements

§37.1, each with its architectural consequence:

| Principle| Consequence for the build|
|---|---|
| **Deny by default**, enforced in the backend **against held permissions, not role names**| The authorization layer resolves a permission key, never a bundle name. A check testing `role == "SENIOR_OPS"` is a defect however correct its outcome, because bundles are editable configuration|
| Separate surface, permission, hub scope, vendor ownership, rider assignment, current state, temporary authority| **Seven independent inputs**, evaluated together — see §4|
| Preserve **tamper-evident** audit history for privileged, financial, identity, recovery and device/session actions| Append-only; no update or delete path exists on an audit event|
| **Never trust the frontend** for totals, prices, OTP assertions, payment success, ownership, hub assignment or status transitions| Every one is a server-side decision. The client supplies intent, never conclusions|
| Least privilege across staff, riders, the shared vendor credential, service accounts and integrations| Service-account permissions are `OQ-047` and must not be improvised|

## 4. The authorization check

Seven inputs, and **all seven are evaluated server-side on every protected action**:

1. **Surface** — which application is calling
2. **Permission** — is the key held ([permissions.md](../contracts/permissions.md) §7)
3. **Hub scope** — none, own hub, all hubs
4. **Vendor ownership** — own record, or authorised and audited cross-vendor
5. **Rider assignment** — assigned run or stop only
6. **Current state** — evaluated jointly with the §36 state machine
7. **Temporary authority** — an effective-dated hub assignment, which **never grants company-wide visibility** (§17.5)

**One rule per axis**. This is the architecture view of the table at [errors-and-enums.md](../contracts/errors-and-enums.md) §4; where the two differ, the catalogue wins.

| Input| What fails| Outward answer| Why that answer|
|---|---|---|---|
| **1 Surface**, **2 Permission**| The principal type is not served by the operation, or the bundle lacks the key| `403` `PERMISSION_DENIED`| Both mean *this principal's bundle cannot do this*; a surface mismatch is not a separate bug|
| *Tier*| The key is held and the target needs a higher tier| `403` `INSUFFICIENT_AUTHORITY`| The fix is a higher authority, not a grant|
| **3 Hub scope**| Staff, key held, an **existing** record outside the authorised hubs| `403` `HUB_SCOPE_VIOLATION`| **Informative by Product decision**: staff are told, so they can route the work|
| **3 to 5 Existence**| No such record| `404` `NOT_FOUND`||
| **4 Vendor ownership**| A Vendor asks for, or acts on, another vendor's record| `404` `NOT_FOUND`, identical to the case above| Specification §43.2|
| **5 Rider assignment, lookup**| A Rider looks up a record that is not theirs| `404` `NOT_FOUND`, identical| Specification §19.2|
| **5 Rider assignment, act**| A Rider acts on work they hold a reference to and are not assigned, or no longer hold custody of| `NOT_ASSIGNED_RIDER` or `NOT_CUSTODY_HOLDER`| Informative state-and-authorisation decisions about work the rider legitimately names; custody follows `MSC-DEC-246`|
| **6 State**| The record is in scope and its state forbids the act| The transition's own code| Authorization and the state machine are one decision|
| **7 Temporary authority**| An assignment that has expired or not yet begun| `403` `HUB_SCOPE_VIOLATION`| It is the hub axis with a time bound|

**The table says what an actor is told, not the order the checks run in.** That is one order for every operation: [permission-enforcement.md](../features/identity/permission-enforcement.md) §5.1.

**Identical means identical.** For a Vendor or a Rider the row-level security policy (§14.4) never returns the other party's row, so the handler finds nothing and answers exactly as it does for an identifier that matches nothing — the same code path, with no second query whose latency could differ. A test compares the two responses for status, code, body shape and timing class. **Only staff ever take the extra step** that makes the hub answer informative, and §14.4b says what it is.


## 5. Maker-checker

One uniform shape, everywhere (§37.4, `MSC-DEC-135`): a `*.create` or `*.request` permission, a `*.approve` permission, and **the approver may not be the record's creator**.

Enforced as a **backend constraint, not an honour system**. On a three-person team the approver is often the only qualified reviewer; if nobody else holds `*.approve`, the action blocks. That is the control working, not a defect.

## 6. The shared vendor credential

Version 1 deliberately uses one credential per vendor organization (§37.5). The consequences are architectural, not cosmetic:

- **Audit identifies the vendor account, not a person.** The UI **must not claim person-level attribution** — a screen reading "approved by Ama" asserts what the data cannot support.
- One active session per credential; a new successful login **ends the previous one**.
- **Credential recovery or change must revoke or control prior sessions.**
- A future multi-user model must preserve historical records.

## 7. Data ownership is not tenancy

§37.6 is explicit and prevents a large piece of unnecessary architecture: own-record access for vendors and role/hub-scoped access for staff **do not require** a separate database, schema, subscription tenant, vendor-admin console, or tenancy-management subsystem.

What they **do** require: *"every query, export, notification, file, and API operation must enforce vendor ownership and hub/role scope with **negative-access tests**."*

**Five surfaces, five test obligations.** An API guarded correctly while an export leaks across vendors fails this. See [engineering-standards.md](../standards/engineering-standards.md) §3.1.

**Gate B adds the layers beneath the five surfaces**, because §37.6's *“every query”* includes the ones no surface issues: a pooled connection carrying the previous request's scope, a background job trusting its own payload, and a runtime role that can switch RLS off. [security-test-matrix.md](../standards/security-test-matrix.md) is the canonical enumeration; §14.13 names the families that an ordinary integration test cannot satisfy.

## 8. Security audit coverage

§38.4 names what must be audited beyond business events: login success and failure as appropriate, MFA enrolment, challenge and recovery, rider device registration and replacement, vendor session replacement, logout and revocation, account recovery, **suspension access denial**, and privileged cross-vendor or cross-hub access.

**Failed and denied privileged attempts are events too** (§38.1). Auditing only successes hides exactly the attempts worth seeing.

**Never logged**, under any circumstance (§38.2, §20.4): secrets, full credentials, **raw OTPs**, and unnecessary personal data. An OTP event records that a code was generated — never its value.

## 9. Secrets

§33.3 and §35.9.4: **security-sensitive values are not ordinary business settings.** They require secret management and are never administered through the settings mechanism.

**A settings screen that can display an API key is a defect**, not a convenience. Provider keys, signing secrets and tokens live outside `contracts/settings.md` entirely.

Rotation, storage and access control are named by §39.9 for every integration and remain to be specified against a chosen platform — `SOLUTION_ARCHITECTURE.md`.

**Custody is settled at §14.9**. The rule this section states — that security-sensitive values are not business settings — is unchanged and is now joined by *which* treatment each class of material gets: **TOTP seeds encrypted, passwords peppered and hashed, high-entropy tokens hashed only.** Choosing wrongly between the three is silent, because each of the three wrong choices still produces a system that authenticates correctly on the day it is built.

## 10. §37.8 readiness disposition

Stated plainly rather than papered over. **§37.8 names seven deliverables, and every one now has a settled current disposition** — the table below is the authority for that, and this sentence must not disagree with it. **At the original assessment three of the seven were blocked**; each has since been resolved or passed to its approved current owner, and the rows record which.

| §37.8 deliverable| Status|
|---|---|
| Factor, token, session and device mechanics| **Defined at §13** (Gate A, `MSC-DEC-259`–`266`). Until 26 August this row read *"settled"* while the mechanics existed nowhere — `domain-model.md` pointed at Solution Architecture, which did not define them. Opaque server-side sessions, cookie and Bearer transports, Argon2id, TOTP, rider keypair, vendor device credential, setup grants|
| Authorization checks| **Settled** at §4 for **both** write and read paths. `MSC-DEC-221` supplied sixteen read keys on 20 August, closing what had been the binding constraint|
| Audit events| **Settled** — [audit.md](../contracts/audit.md) is approved|
| Secrets| **Framework settled** at §9; rotation mechanics need the platform|
| **Rate limits**| **Complete.** Model per credential, tightest on the shared vendor login and the rider device; **six buckets and their keys** (`MSC-DEC-285`, closing `OQ-077`, 27 August); **launch figures** (`MSC-DEC-371`, closing `OQ-067`, 5 September) — staff **10** · privileged MFA **10** · vendor **10** · rider challenge **20** · recovery **10** · authenticated API **120**, per minute. **The credential keying is unchanged and no IP or source-address bucket exists.**|
| Recovery| **Settled** at §2|
| Negative tests| **Settled** as an obligation at §7; the cases follow the permission catalogue|

**`OQ-047` was the binding constraint until 20 August, and no longer is.** `MSC-DEC-221` supplied one read key per domain, so authorization is now expressible for every list and detail screen. What remains under `OQ-047` — service-account permissions and bundle overrides — blocks no slice. The original text read:

> ~~Read permissions are undefined, so authorization cannot be fully expressed for any list or detail screen~~ — which is most of the Ops Portal. `SLICE-000` cannot complete without it.

**A gap this document surfaced, and it is closed: general API rate limiting had no owner.** §37.8 names it, §39.9 requires per-integration resilience, and `OQ-048` covers only OTP parameters; **nothing specified request limits for the API itself**, and it was raised as `OQ-060`. **`MSC-DEC-224` answered it on 20 August** — per credential, never per address — and `rate_limit_authenticated_api` now carries **120 / minute** on the active Session ([settings.md](../contracts/settings.md) §7.7, `MSC-DEC-371`).

## 11. §37.8 gate status

| Condition| Met?|
|---|---|
| Security architecture defines the seven deliverables| **Yes — seven of seven.** Secrets and recovery closed by [DEPLOYMENT_AND_ENVIRONMENTS.md](DEPLOYMENT_AND_ENVIRONMENTS.md) §5 and §6 on 20 August|
| OpenAPI defines them consistently| **Yes.** [openapi.yaml](../contracts/openapi.yaml) carries the authentication surface: **the operations tagged `auth`**, whose number is derived from the contract and not restated here — Staff, Vendor and Rider sign-in, the privileged MFA step, session read and sign-out, session revocation, credential recovery request and completion, credential and MFA setup, MFA re-enrolment, the Rider sign-in challenge and device enrolment; the rest are the Ops-side identity acts — MFA reset, credential recovery and device register, re-register and revoke.|
| Consistent with confirmed policies| **Yes** — §2 through §9 restate rather than reinterpret|

**The gate is passed as of 20 August 2026.** All seven deliverables are settled. Login, vendor records, rider access, OTP, payment, suspension and privileged approval are no longer blocked by §37.8.

**That condition was once outside this document's scope and is now met.** §11 also requires OpenAPI to define the auth operations consistently; when this section was written `openapi.yaml` was slice-scoped and carried **none**, and it was recorded as `SLICE-000`'s own contract work rather than a security-architecture gap. **`SLICE-000` did that work**: the contract now carries the authentication surface described in the table above, so **no condition of §37.8 remains unmet**.

What it delivered: five settled deliverables written down, `SLICE-000` with a named artifact rather than a hole, and — **as the position stood on 20 August** — **two remaining blockers rather than three**: `OQ-060` general API rate limiting, and a platform decision that `SOLUTION_ARCHITECTURE.md` had to carry before token, session and device mechanics could be specified. **Both have since closed**, as the paragraph below records.

**Everything this document deferred has since been settled** — `MSC-DEC-221` (read permissions), `MSC-DEC-224` (rate-limit model), `MSC-DEC-225` (platform), and the deployment artifact (secrets, recovery), all on 20 August. **No security artifact is owed.**

## 13. Authentication mechanics

**This section exists because the contracts pointed here and this document did not answer.** `domain-model.md` §6.8 said the session token is *"delivered by the transport mechanism defined in Solution Architecture"*, and no such definition existed. §11 of this document simultaneously recorded *"factor, token, session and device mechanics — **settled**"*. Both could not be true.

Everything below implements `MSC-DEC-259` through `MSC-DEC-266` and **carries no product authority** (§42.7).

### 13.1 Sessions are opaque and server-side

**No JWT. No refresh-token subsystem in Version 1.**

The session credential is a cryptographically random opaque secret. The server stores **only its hash** (`Session.token_hash`); the raw value exists at generation, in transit, and on the client.

**Why opaque, and it is not a stylistic preference.** Melarc already requires immediate revocation, vendor session displacement, rider one-session enforcement, suspension revocation, credential-change revocation, administrative revocation and a server-side session record. **Those erase the statelessness a JWT would buy** — a token checked against a revocation list on every request is a session lookup with extra machinery. Opaque sessions make `MSC-DEC-259`'s authority-change revocation a single `UPDATE`; a JWT architecture would need short lifetimes, a blacklist, rotation and reuse detection to approximate it, and would still be slower to revoke.

**A refresh-token subsystem was rejected** because it adds a second credential lifecycle, its own rotation rules and its own recovery path to solve a problem the approved lifetimes do not have.

### 13.2 Transport

| Cookie| Attributes| Lifetime| Read by JavaScript| Purpose|
|---|---|---|---|---|
| `melarc_session`| `HttpOnly; Secure; SameSite=Lax; Path=/`| **Browser-session cookie**: no `Max-Age`, no `Expires`. The server-side absolute and idle timeouts (§13.3) decide validity| **No**| Opaque browser Session credential|
| `melarc_csrf`| `Secure; SameSite=Lax; Path=/`| **Browser-session cookie**, as above| **Yes, deliberately**| Synchronizer token, echoed in `X-CSRF-Token`|
| `melarc_vendor_device`| `HttpOnly; Secure; SameSite=Lax; Path=/`| **`Max-Age=34560000` (400 days), renewed at each vendor sign-in**| **No**| Vendor registered-browser credential; **outlives the session**, which is what makes it a second factor|

| Surface| Mechanism| Storage|
|---|---|---|
| **Ops Portal**, **Vendor PWA**| The cookies above, set as **real repeated `Set-Cookie` field lines**| The browser|
| **Melarc Rider**| Opaque secret as an HTTP **Bearer** credential, returned **exactly once** at sign-in| **Encrypted local storage under a non-exportable Android Keystore key only** (§15.2)|

**Lifetimes are decided, and `Secure` stays mandatory everywhere** (Product decision, 6 October 2026). The server's record decides whether a session is valid, so the two browser-session cookies carry no `Max-Age` and no `Expires`: a cookie that outlived the browser would be a second place the session lives. The vendor device credential is long-lived on purpose, and **renewing it is not re-issuing it** (§13.8a). `Secure` is never relaxed for Local, and it is **not tested over plain HTTP**: identity journeys run on a trusted HTTPS test origin (below). What each engine does with a `Secure` cookie on `http://127.0.0.1` is recorded as a diagnostic and is no evidence for the supported browsers.

**Browser acceptance runs on a trusted HTTPS origin** (Product decision, 8 October 2026; [SLICE-000-FINAL-DECISIONS.md](../delivery/planning/SLICE-000-FINAL-DECISIONS.md) §11). Local and integration identity testing uses one browser-facing HTTPS origin that serves the Ops build and proxies `/api/v1`, with a locally generated test CA or certificate trusted by the test browser as appropriate; its keys stay outside the repository and every source archive. Staging uses its real trusted TLS configuration. `ignoreHTTPSErrors` and a localhost-specific `Secure` exception are not accepted as the primary evidence. Sign-in, MFA, session, CSRF, recovery and sign-out run in Chromium, Firefox and WebKit, with branded Chrome and Edge and an actual Safari checked as smoke or manual evidence for the declared support baseline; WebKit is engine coverage and not proof that Safari was tested, and a missing engine is reported blocked and never silently skipped. The tests prove the `Secure`, `HttpOnly`, host-only, path and `SameSite` properties, session rotation, server-side expiry and invalidation, and deletion with matching scope — expiry is the literal `Max-Age=0` — and that clearing the browser-session cookies never deletes `melarc_vendor_device`. **Session cookies can survive browser session restoration, so the interface never promises that closing the browser signs the person out**; acceptance includes the protected next request, not only the stored cookie.

**The contract declared two of these three cookies through invented headers until 27 August**. `X-Set-Csrf-Cookie` and `X-Set-Vendor-Device-Cookie` are not HTTP headers, and **an implementation following the contract literally would have emitted two custom headers no browser stores** — the CSRF token and the vendor device credential would never have reached the client at all, and the vendor's second factor would have silently not existed. The contract now declares one real `Set-Cookie` header plus an `x-set-cookies` extension naming which cookies each response sets.

`HttpOnly` is what makes cross-site scripting unable to exfiltrate the session. `Secure` keeps it off plaintext transport. `SameSite=Lax` blocks the cross-site request forgery cases a cookie otherwise invites, and **is not sufficient alone**: unsafe cookie-authenticated requests additionally require a **CSRF token** and **Origin validation**. That is the cost of cookies, and it is smaller than the cost of a token JavaScript can read.

**Bearer here names a transport, not a JWT.** The rider credential is an opaque secret with no claims and nothing to parse.

### 13.3 Idle and absolute expiry

`Session.last_activity_at` is the basis for the idle rule. **It did not exist before Gate A, so the approved idle limits could not be enforced** — `MSC-DEC-234` set 30 minutes standard and 15 privileged against a record with no activity field.

| Tier| Absolute| Idle|
|---|---|---|
| Rider| 1440 min| **None, by rule**|
| Standard — Vendor, Ops Staff, Fleet Manager, Finance/Reconciliation| 720 min| 30 min|
| Privileged — Senior Ops, Platform Admin, **and no other bundle**| 480 min| 15 min|

Implementations **may coalesce** activity writes rather than updating a row per request; the externally observable timeout must remain accurate within the coalescing window.

**Expiry is decided at request time** (Product decision, 8 October 2026). On every request the server compares the absolute expiry and the idle basis with one fresh database time (§13.3a): an absolute bound is exceeded when `now >= expires_at`, and the idle bound when `now - last_activity_at >= idle` — equality is expired for both. The `expire_sessions` job only marks and retains rows; it never decides whether a session is accepted.

### 13.3a Time

Product decision, 8 October 2026 ([SLICE-000-FINAL-DECISIONS.md](../delivery/planning/SLICE-000-FINAL-DECISIONS.md) §15). Instants are persisted as `timestamptz`. For expiry, grants, challenges, sessions and leases, **one fresh database wall-clock value is read after the required locks are held** and used for the single atomic eligibility decision. **Valid means `now < expires_at`; equality is expired.** Transaction-start time is not used, because a request can wait on a lock past an expiry and a transaction-start value would still call the record valid; and the decision point — not the later commit — defines validity, so the rest of the transaction stays short and bounded. Session and authority are re-checked where §13.10 requires. TOTP uses an injected UTC wall clock and an atomic replay-step record under the retained skew policy (§13.5). Process, shutdown and network budgets use a monotonic clock. Tests age persisted rows or inject a clock; **no production switch moves time**. Identity code reads a clock only through the injected clock or the database; parsing a timestamp string is not a clock read.

### 13.4 Credential hashing

**Argon2id** for staff passwords, vendor shared secrets and rider PINs, with unique salts, **versioned parameters**, a **server-side pepper held outside the database**, and **rehash-on-success** when parameters are upgraded.

**No memory or time parameters are fixed here.** They must be **benchmarked on the production deployment** — a figure copied from a general source is either too weak to matter or too slow to serve, and neither outcome is visible from a document.

**The rider PIN is the case that needs saying out loud.** A four- or six-digit PIN is **low entropy**: Argon2id raises the cost per guess and does not reduce the number of guesses, and an attacker holding the database can enumerate the whole keyspace. **The rider control is all four together** — PIN, registered cryptographic device, online attempt and rate controls, and the pepper. **The pepper is what a stolen database does not contain**, and it is the reason a database theft alone is not sufficient for offline enumeration.

### 13.4a Credential strength and input bounds

`MSC-DEC-431`. **Engineering detail under a Product rule, carrying no Product authority.**

**The rule.** A staff password, the bootstrap password and a Vendor shared secret are **12 to 128 characters, spaces permitted, with no composition rule** — no mandatory case, digit or symbol. The rider PIN is separate and unchanged: six numeric digits.

**How it is counted and applied.**

- **Length is counted in Unicode code points** (not UTF-16 units), and the same NFKC normalisation is applied before hashing at set time and at verify time, so a passphrase that looks the same verifies the same. Nothing is trimmed, truncated or case-folded, and spaces count. NFKC is retained here as an explicit compatibility choice (Product decision, 8 October 2026) and is not a claim of full conformity with current NIST guidance, which recommends NFC; a later standards review assesses the whole credential policy and does not swap one function silently.
- **Two bounds apply at establishment, and both are real rules** (Product decision, 8 October 2026; the schema text used to call the first a pre-filter). The request schemas count the string **as sent** — `minLength` 12 and `maxLength` 128 on `CredentialSetup.password`, `VendorCredentialSetup.secret` and `RecoveryComplete.new_credential` — and the credential service counts it again **after NFKC normalisation**, before it hashes; a value must satisfy both. A string whose compatibility characters expand under NFKC is therefore refused by the schema: four U+FB03 ligatures are 4 code points as sent and 12 once normalised, so they are refused, and the UI help and the tests say so. Normalisation is never moved ahead of the schema, which would change the wire contract. Malformed Unicode (a lone surrogate) is refused the same way at every entry point and is never silently encoded to different bytes. A violation is `VALIDATION_FAILED` with `details.field` naming the field and **never the value**.
- **Where it applies:** setup and recovery completion — the two places a person creates the credential. There is no change-password operation in Version 1; recovery is the only way to replace one.
- **Sign-in is bounded, not policed.** `StaffSignIn.password` and `VendorSignIn.secret` carry `maxLength` 128 as sent and **no minimum**, and the service also bounds the length **after NFKC** before it hashes: a value that expands past 128 is answered `INVALID_CREDENTIALS` without being hashed or counted, so an attacker cannot make a hash expensive with a long input and a short guess is simply a wrong credential, answered like any other.
- **Not done in Version 1, so nobody adds it by habit:** composition rules, breached-password screening, expiry and forced rotation. **Each is a Product decision, and `MSC-DEC-431` takes none of them** — it records only the length bounds and the unchanged lockout values.

Argon2id's memory and time parameters stay as §13.4 says: benchmarked at deployment, and not a Product matter.

### 13.4b Sign-in lockout — one mechanism, three identities

`MSC-DEC-431`. The settings (`signin_max_attempts` 5, `signin_lockout_minutes` 15, `mfa_max_attempts` 3), the audit event and a sentence in the state machine existed; **the mechanism did not, and no document said where the count lives, what counts or what a locked caller is told.** The model is [domain-model.md](../contracts/domain-model.md) §6.8, *Failed attempts and lockout*.

**The rule that decides everything.** A failed attempt counts toward a credential's lockout **only once the request has legitimately reached that credential's factor** — that is, every factor that gates it has been proved. Anything earlier is a refusal that touches no counter and says nothing about any lock, so an attacker cannot lock a vendor organisation out from a browser it never registered, cannot lock a rider out from a handset that cannot sign, and cannot learn which accounts exist by locking them.

| Identity| Factors, in the order they are decided| The credential factor is reached when|
|---|---|---|
| **Staff**| 1 password · then, for a privileged role, 2 the MFA code on a live challenge| **Password:** there is no earlier gate — the identity exists, is `ACTIVE` and has a credential. **MFA code:** the password was proved and a live challenge is held|
| **Rider**| 1 challenge · 2 device signature · 3 PIN| The signature verified against the sole `ACTIVE` device's key **and** the status is `ACTIVE`|
| **Vendor**| 1 registered browser · 2 account `ACTIVE` · 3 secret| The `melarc_vendor_device` credential is bound to the account named **and** the account is `ACTIVE`|

**Where the count lives.** `failed_attempt_count` and `locked_until` sit on the embedded credential record of the staff identity, the rider's PIN and the vendor's secret. **They are never returned and never part of the record's version**, so a failed sign-in cannot change an approver's ETag. A **staff** identifier that does not exist has no record and so no counter, which is exactly what lets it be answered like one that is locked.

**The lock.** The `signin_max_attempts`-th consecutive failure sets `locked_until` to now plus `signin_lockout_minutes`. **A request that arrives while `locked_until` is in the future is neither verified nor counted and does not extend the lock.** At the first attempt after it passes the count is reset to zero and the credential is verified normally. The count also resets on a complete sign-in and whenever the credential is established or changed — setup, recovery completion, rider enrolment or replacement.

**What a locked caller is told** — and what is deliberately not told:

| Request| Answer| Why|
|---|---|---|
| Staff **password** sign-in| `INVALID_CREDENTIALS`, as for a wrong password| Nothing has been proved, so announcing a lock would let anyone learn which addresses are real staff by locking one|
| Staff **MFA** step| `CREDENTIAL_LOCKED`| The caller holds a live challenge: the password was proved|
| Rider with a verified signature| `CREDENTIAL_LOCKED`| The caller holds the registered handset's key|
| Vendor from a registered browser| `CREDENTIAL_LOCKED`| The caller holds a browser registered to the account|
| Any request that has **not** reached the factor| The answer it would get anyway, **never** `CREDENTIAL_LOCKED`| A lock is announced only to someone who could already attack that factor|

**The rider order, because it carries the most non-disclosure.** (1) The challenge is checked: unknown or consumed is `CHALLENGE_UNUSABLE`, expired is `CHALLENGE_EXPIRED`, and any other request consumes it, pass or fail. **A challenge is bound to the phone number it was issued for — a number that matches no rider included — so presenting it with another number is `CHALLENGE_UNUSABLE` for every number alike.** (2) A rider with an `ACTIVE` device is held to a valid signature: failing it is `DEVICE_PROOF_INVALID`, **the PIN is never looked at, and nothing is counted**. (3) A phone that is unknown, or a rider with no `ACTIVE` device, offers no proof to check, so the PIN is decided instead: wrong is `DEVICE_PROOF_INVALID` (the answer for an unknown phone) and right is `DEVICE_NOT_ENROLLED`. **Nothing is counted here**, because the factor has not been reached, so these attempts are bounded only by the rate limit, keyed on the submitted phone number: **a rider with no `ACTIVE` device can have a PIN tried, and that is an accepted residual** — a PIN alone never authenticates a rider, and a PIN learned here dies at the next enrolment, which sets a new one. (4) With a valid signature, **a status other than `ACTIVE` is `INVALID_CREDENTIALS`: nothing is counted and no lock is announced**, because the factor has not been reached. (5) With a valid signature and an `ACTIVE` status, a locked rider is `CREDENTIAL_LOCKED`. (6) Otherwise a wrong PIN is `INVALID_CREDENTIALS` and counts.

**The vendor order.** (1) The browser: absent, unknown or bound to another account is `INVALID_CREDENTIALS`, **the secret is not examined and nothing is counted**. (2) An account that is not `ACTIVE` is `INVALID_CREDENTIALS`. (3) A locked account is `CREDENTIAL_LOCKED`. (4) A wrong secret is `INVALID_CREDENTIALS` and counts. The lock is shared by everyone using the credential, because it is one credential (§37.2); `MSC-DEC-431` fixes the rule.

**MFA and the password share one count.** `mfa_max_attempts` limits a **challenge** to three wrong codes, after which it is `UNUSABLE`; **each wrong code also adds one to the identity's count**, so a thief who knows the password cannot guess codes across fresh challenges. Three wrong codes plus two wrong passwords lock the identity. **A completion that finds no `ACTIVE` factor is not a wrong code**: it is answered `MFA_ENROLMENT_REQUIRED` and adds nothing to the count.

**Rate limiting is separate and first.** A request refused with `RATE_LIMITED` is neither verified nor counted. The rate-limit buckets and their figures are unchanged. **A bucket's key is taken from what the request carries, never from whether the server could resolve it** — the canonical work email for staff ([domain-model.md](../contracts/domain-model.md) §6.8), the submitted account identifier with the identity of the device credential **where it identifies a registered device of that account** for a vendor (device material that is absent, malformed or unknown shares the account's one invalid-device partition), the submitted phone number for a rider's challenge request and sign-in — so a request naming an identifier that does not exist is limited exactly as one that does, and `RATE_LIMITED` is never a signal that an account exists. Where each bucket keeps its state and what happens at capacity are §14.12; the exact key of each is [settings.md](../contracts/settings.md) §7.7.

**Concurrency.** A failure is applied by **one atomic conditional update** on the credential record — *add one to the count unless the credential is already locked*, returning whether this update set the lock — so concurrent failures each add one, **none can step over the threshold without setting the lock, a failure that completes after the lock is set neither counts nor moves `locked_until`, and `auth.lockout.applied` is written only by the update that returned *tipped*, which makes it one event per lock.** The comparison with `locked_until` and the new value use a **fresh database wall-clock value read after the lock is taken** (§13.3a), never the transaction's start time and never an application server's clock. A correct attempt that races a lock is serialised on the same record: either order is a correct outcome.

**Timing.** Every step that checks a password, a secret or a PIN and is admitted to hashing (§13.4c) performs exactly one Argon2id verification — against the real hash, at the parameters recorded in it, when a credential was reached and is not locked, and against a fixed dummy hash at the current write profile otherwise (an old hash must verify at the cost it was made with, so while a cost migration is under way the two differ in cost; that window is assessed before a migration is enabled, and the control stays one bounded derivation per branch) — **and a request refused because a lock is in force still performs that one dummy verification and discards the result**, so a locked answer is never faster than a wrong one and latency does not say which stage ended the request. *Not verified*, wherever this section says it of a locked request, means *the verification's result is not used*. **A request refused by the rate limit, or by hash admission, is the exception: it performs no verification at all, dummy or real** (Product decision, 8 October 2026). It never reached identity-dependent work, so there is nothing for its latency to match. The comparison that must hold is between *outwardly equivalent failure branches* — a wrong credential, an unknown identifier, an ineligible status, a lock — and not between those and a throttled or a successful request. Equal timing is a diagnostic and never the proof: the control is that those branches do the same **bounded** work, and no branch spends unbounded work (a dummy write per request, say) only to look like another.

**A refusal that must persist is returned, not thrown.** A failed sign-in whose counter and `auth.session.failed` have to survive commits its transaction and then answers the error outside it; an exception raised inside the transaction would roll the count and the record back (Product decision, 8 October 2026). **Audit.** Each refusal is `auth.session.failed` with the factor reached and one cause from the closed set in `audit.md`; the lock itself is one `auth.lockout.applied`, recording the factor that tipped it and `locked_until`. A refused attempt inside a lock is `auth.session.failed` with cause `LOCKED_OUT`. **Neither records a credential, a code or a signature.** **The factor reached is one of `PASSWORD`, `MFA_CODE`, `SECRET`, `PIN` or `NONE`, and every refusal writes one `auth.session.failed`**; a wrong second-factor code and a failed device signature also write `auth.mfa.failed` and `auth.device.proof_failed`, **in addition**, so that the uniform failure record, the enhanced second-factor record and the signature record each tell their own story once.

**What a lock does not do.** It ends no live session, changes no status, blocks no recovery and has no administrator unlock: recovery completion clears it, and otherwise it ends by itself. Setup-grant and recovery-token failures are **not** lockouts — those tokens are single-use, high-entropy and rate-limited, and lock nothing.

### 13.4c Bounded hash work

Product decision, 8 October 2026 (rationale: [SLICE-000-FINAL-DECISIONS.md](../delivery/planning/SLICE-000-FINAL-DECISIONS.md) §10). Argon2id is expensive on purpose, a **dummy** verification costs what a real one does, and a flood of requests naming *distinct* identifiers trips no per-key bucket while spending the machine's hashing capacity. Per-key limits cannot bound that; a single admission point can.

- **One admission point.** Every operation that verifies, creates or rehashes a password, secret or PIN takes a slot from one bounded **hash admission** *before* any identity-dependent expensive work. When no slot is free the request is refused at once with `RATE_LIMITED`: **nothing is verified, nothing is counted against any credential, and no dummy hash runs.** Until a measured, bounded waiting policy is recorded there is **no waiting queue**.
- **Asynchronous.** Hashing runs off the request's event loop (asynchronous Argon2id behind a hashing port; Node's `crypto.argon2` is the candidate to qualify). A synchronous hash on a request path is a defect. Memory held per hash and contention for the shared worker pool belong to the capacity analysis, not only the CPU count.
- **What passes through it.** Real and dummy verification, creation at setup and at recovery completion, and rehash on success. A request refused by the rate limit (§13.4b) never reaches admission. A request refused because a lock is in force **does** take a slot for its one dummy verification.
- **The number of slots is measured, not chosen here.** The slot count, the memory per hash and the overflow behaviour under load are engineering configuration set by a benchmarking task on a recorded machine, validated at start, and a **release gate** before external authentication exposure. A local figure is never a capacity claim.
- **The answer is the ordinary one.** `RATE_LIMITED` keeps its status and body (`errors-and-enums.md`) and is not told apart from a bucket refusal by the caller. It is counted (a low-cardinality counter with no identifier in its labels, `OBSERVABILITY_AND_RECOVERY.md` §3) and logged as any rate-limit refusal is, and it is not an authentication audit event: no factor was reached.

### 13.5 Privileged MFA

**TOTP authenticator app**, for Senior Ops and Platform Admin. Not SMS.

The seed is **encrypted, not hashed** — verification requires recomputing codes — and is never persisted or logged in plaintext. **Key custody is Gate B's**; this prohibition binds regardless of that outcome. **The code is six digits, computed on a 30-second step with SHA-1, and one step either side of the current one is accepted.** **A code is single use**: one already used is refused again inside its window. The contract's TOTP code fields carry `pattern: ^[0-9]{6}$` (Product decision, 6 October 2026).

**SMS was rejected for this role specifically.** It remains right for operational OTPs to recipients outside Melarc, where the alternative is nothing. As the factor protecting the platform's most powerful accounts it depends on SIM security, on a provider being reachable, and on a per-message cost — and **`OQ-048`'s unresolved provider would otherwise have blocked privileged authentication entirely.**

### 13.6 Rider device possession

The handset generates a **non-exportable keypair** in Android secure hardware. **Only the public key is registered.** Sign-in is challenge-response: the server issues a short-lived single-use challenge, the device signs it, and the server verifies against the stored public key.

**There is no device identifier to copy**. The registration record is identified by `RegisteredDevice.id` on the server; for a rider the registered public key is the binding, and the client neither submits nor selects a device. A string once did that and proved nothing, since anyone who learned it could present it, and it was treated as half of a two-factor credential; it is retired.

The challenge endpoint **is not an enumeration oracle**: a challenge is issued identically whether or not the number belongs to a registered rider, and the response carries no account state.

**The QR payload** (Product decision, 8 October 2026). Version 1 is `melarc-rider://enrol/v1#token=<base64url-token>&challenge=<base64url-challenge>`: the exact scheme, host `enrol` and path `v1`; exactly one `token` and exactly one `challenge` parameter in the fragment; unpadded canonical base64url; and the challenge the encoding of **32 random bytes**. **The size and encoding are exact, and nothing the app accepts is unbounded.** The token is the same 32 random bytes as every grant, recovery token and challenge (§14.9), and the challenge is the fixed 32-byte representation, so each is **exactly 43 characters of `[A-Za-z0-9_-]`** that decode to exactly 32 bytes and re-encode to themselves (the two spare bits of the last character are zero, with no `=` and no `+` or `/`). The whole payload is therefore **exactly 127 ASCII characters** — 30 for `melarc-rider://enrol/v1#token=`, 43, 11 for `&challenge=`, 43 — in that order and no other, with the scheme, host and path compared case-sensitively and nothing before or after. The app reads **no more than 127 characters** of a scan before it refuses it, trims and normalises nothing, and refuses any other length, a query where the fragment belongs, whitespace, control or non-ASCII characters and percent-encoding, all without a network call. The service applies the same shape to a presented grant token before any hash, lookup or limiter key and answers any other value with the same uniform refusal as an unknown token, so a malformed value is neither more expensive nor distinguishable. **Vector obligations:** one published file of vectors is consumed by the Node tests and by the Android tests — the valid payload, and each of: another version, scheme, host or path or case variant; user-info and a port; a query instead of a fragment; a missing, duplicate, extra or reordered parameter; a token or challenge one character short or long; padding, `+`, `/` and a non-zero spare bit; percent-encoding, whitespace, a newline and a non-ASCII character; an input of 128 characters and a very long one that must be refused after a bounded read; and a value that looks like a callback or API origin. The rendered code is decoded by an independent decoder and must give back the complete 127 characters. The device-key encodings are exact in the same way: a `device_signature` is the standard base64 of a DER ECDSA signature of 8 to 72 bytes (12 to 96 characters), and a `public_key` is the standard base64 of exactly the 91-byte DER SubjectPublicKeyInfo of an uncompressed P-256 key (124 characters). The Rider app parses it strictly and rejects an unknown version, a duplicate parameter, user-info, a port, an extra field, an invalid encoding, and any callback, API origin or redirect it might name: the URI never tells the app which host to call. The preferred workflow is a scan inside the official Rider app. The QR's attestation challenge is separate from a sign-in challenge and is never usable as one. If operating-system link handling is offered later, interception and app-link ownership are reviewed on their own — a custom URI scheme is not an exclusive app identity — and possession of the QR alone never replaces the hardware attestation and the package and signer checks.

**The device-key protocol** (Product decision, 8 October 2026). The device key is a hardware-backed ECDSA **P-256** key signing with SHA-256. `public_key` is the canonical standard base64 of the DER SubjectPublicKeyInfo of a P-256 key; trailing DER data, another curve and ambiguous encodings are rejected, and the key is compared with the verified attested key after canonicalisation by the reviewed crypto stack, never as unvalidated strings. The sign-in challenge is the canonical unpadded base64url of 32 random bytes; its server record binds the purpose, the environment and service, the submitted canonical phone, the eligible device context and the expiry, and an unknown phone receives the same outward response. **The signed message is the UTF-8 bytes of `MELARC-RIDER-SIGNIN-V1`, one byte `0A`, and the canonical challenge text** — no trailing newline and no implicit JSON. `device_signature` is the canonical standard base64 of an ASN.1 DER ECDSA signature; the verifier supplies SHA-256 once and never pre-hashes. Replay protection is the challenge's state and never the uniqueness of signature bytes. The enrolment challenge is decoded from base64url to its 32 bytes before it becomes the Android key-generation attestation challenge, and those bytes are matched against the attested extension and `SetupGrant.attestation_challenge_hash`; sign-in and enrolment challenge namespaces stay separate. A challenge is consumed atomically with its expiry checked after the lock, so parallel attempts have one winner, and an invalid proof consumes it where §13.4b says so. Executable Android and Node vectors — valid encodings, a changed prefix or challenge, a double hash, DER against P1363, a wrong key or curve, invalid base64, cross-purpose replay, a consumed and an expired challenge — are published, and the protocol counts as interoperable only when they pass on both sides.

**Enrolment reaches the handset as a scanned QR**. Senior Ops initiates in person; the Ops Portal renders a short-lived, rider-bound, single-use enrolment URI as a QR code; the rider scans it with their own handset, which then generates the keypair and takes the PIN privately.

**Enrolment is attested**. The handset generates the key as a **hardware-backed signing key in the Android Keystore**, with the single-use attestation challenge the QR also carries, and submits its **Key Attestation chain** beside the public key. The server verifies the chain before it registers anything; the policy is at §15.2.1. A software-only key is not eligible, and the one failure of a handset that cannot hold a hardware key is `DEVICE_SECURITY_UNSUPPORTED`.

**Until 27 August there was no transport here at all.** The initiation response returned an expiry and no credential — withheld on the sound reasoning that an officer holding the token could enrol a device the rider never touched — while completion required that credential. **The flow could not be walked**, and both rider lifecycles ended at this step.

**The QR keeps the property the omission was protecting.** It travels from the portal display to the rider's camera in the officer's presence, so the officer has no reason to transcribe it. **The guarantee is narrower than that and exact** (Product decision, 8 October 2026): the QR holds short-lived bearer enrolment material that is necessarily present in the officer's browser to be drawn, so a screenshot or a camera can capture it; what is guaranteed is that the officer **never receives the rider's chosen PIN or private key** (nor the session credential), and the QR is useless without the handset's hardware attestation and the package and signer checks. It is held in transient state and cleared on expiry, navigation and completion. Served `Cache-Control: no-store`, never logged, never audited by value, and kept out of query caches, analytics, screenshots, traces and source archives.

**Revocation is immediate and unverified by design** — verifying identity first leaves a stolen handset live for the length of the check. **A revoked device's live session terminates with `DEVICE_REVOKED`**, which is the one reason that applies: `SUPERSEDED_BY_NEW_LOGIN` is vendor session displacement, and collapsing them would make a stolen handset indistinguishable from a colleague signing in. Replacement is in person and generates a **new** keypair, attested like the first, and leaves the old device `REPLACED` — a different state from `REVOKED`, with its own session reason, `DEVICE_REPLACED`; **a private key is never copied**, which non-exportability makes structurally true rather than merely forbidden.

### 13.7 Vendor browser device

A **server-generated high-entropy device credential**, stored hashed, delivered in a long-lived `HttpOnly` cookie, bound to the `VendorAccount`. **Nobody types it.**

**Rider-style hardware keys are deliberately not used here.** The Vendor PWA is a browser used by several people on a **shared** account; a person-oriented WebAuthn or passkey flow would model an individual that Version 1 deliberately does not have. Vendor sign-in is **shared secret + registered browser**, and the device credential is what a stolen shared secret alone cannot defeat.

### 13.7a The vendor account identifier

`VendorAccount.account_identifier` ([domain-model.md](../contracts/domain-model.md) §6.8). **Sign-in required an identifier that no document defined and no operation returned**; this defines it.

**Form.** Eight characters from `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (31 symbols — no `0`, `O`, `1`, `I` or `L`), drawn from a cryptographically secure generator when the account is created, **unique, immutable, never reused**, stored upper case and **compared case-insensitively**. It is delivered in the setup message beside the grant, and Ops reads it from `getVendorAccount`.

**It is not a secret and it is not a control.** The registered browser and the shared secret are the controls, so the identifier needs only enough entropy to avoid collisions and typing errors, and **its guessability must never be what protects an account** — which is why a wrong identifier is indistinguishable from a wrong secret (§13.8a).

### 13.8 CSRF — synchronizer token

Cookie-authenticated browser sessions carry a **synchronizer token**.

**Issuance.** At session issue the server generates a random CSRF token, stores **only `csrf_token_hash`** on the session, and sets a second cookie `melarc_csrf` with `Secure; SameSite=Lax; Path=/` and **deliberately not `HttpOnly`**.

**That last attribute looks wrong and is the mechanism.** The page must *read* the token to echo it in `X-CSRF-Token`; a token JavaScript cannot read cannot be echoed. **It is safe because it is useless alone** — an attacker who obtains it still cannot send the `HttpOnly` session cookie from their own origin, and a cross-site page cannot read it either.

**Validation.** For every unsafe cookie-authenticated request the server requires the header, compares its hash against `csrf_token_hash`, **and** validates `Origin`. Either failing returns `CSRF_VALIDATION_FAILED`.

**The contract requires it structurally**. `csrfToken` is an OpenAPI **security scheme** composed with `browserSession` as an AND requirement, and the global default is the CSRF-bearing alternative — so an unsafe browser operation that omits it **fails a mechanical check**. Safe reads opt out explicitly; pre-authentication operations carry `security: []`.

**A control that is documented but optional is not a control.** Before this, `CSRF_VALIDATION_FAILED` appeared in operations' error lists while nothing in the contract obliged a client to send a token or a server to demand one.

**Rider Bearer requests carry no CSRF token**, and need none: a Bearer credential is not attached automatically by the browser, so there is nothing for a cross-site request to ride on.

**Pre-authentication browser flows are not session-CSRF flows.** Sign-in, setup, recovery and MFA enrolment have no session and therefore no synchronizer token; they are protected by their **purpose-bound single-use grants or credentials**, rate limits and the client policy below.

**Client policy** (Product decision, 8 October 2026; [SLICE-000-FINAL-DECISIONS.md](../delivery/planning/SLICE-000-FINAL-DECISIONS.md) §9). Each operation is classified by the client it serves, and the contract declares the classification per operation:

- A **browser-only** pre-session credential mutation requires an `Origin` that exactly matches a configured allowlisted origin. A missing, `null` or unapproved `Origin` is `403` `CSRF_VALIDATION_FAILED`.
- A **cookie-authenticated** mutation additionally requires the synchronizer token. Fetch Metadata is checked for an unexpected cross-site browser mutation; `SameSite` and CORS are further layers and never the only one.
- A **native Rider** operation may carry no `Origin` under its declared native protocol, and it never accepts a browser session cookie as an alternative credential.
- An operation shared by two clients declares an explicit credential mode for each and refuses an ambiguous combination. A `User-Agent`, or a client-type string the caller supplies, is never proof of a native client.
- Safe reads, the probes and preflights receive no blanket `Origin` requirement. Opening a recovery or setup page redeems nothing: redemption is a protected `POST`.
- Credentialed CORS uses exact origins — never reflection, never a wildcard — and the trusted edge does not expose internal-only routes.

The `403` and `CSRF_VALIDATION_FAILED` are declared on each browser operation that is subject to the policy and on no native-only one; they are not added mechanically to every pre-authentication operation. The operational `5xx` keeps its established envelope, and a transport `413` or `415` carries no invented `Error.code`.

### 13.8a Vendor sign-in proves three factors

**Account identifier, shared secret, and a valid `melarc_vendor_device` cookie**. The contract declares the third as a `vendorDevice` security scheme, so an implementation cannot omit it and pass a check.

**Until 27 August the third factor was decorative.** Gate A issued the device credential at setup and **no operation required it**, so vendor sign-in was in practice the shared secret alone — from any browser. That is exactly the outcome the credential was introduced to prevent, and it was described as a second factor in three documents while being enforced by none.

**Ordinary sign-in proves the credential and never re-issues it** (it renews the cookie's lifetime, §13.2, which re-issues nothing). A login that silently registers whatever browser presents itself registers the attacker's browser too. Registration happens only where it is the deliberate act: **initial setup** and **recovery**.

**Failure of any of the three is reported identically** — `INVALID_CREDENTIALS`, in content and in timing. Telling an attacker that the secret was right but the browser was not tells them which half they still need. **The one exception is a lock** (§13.4b): a request from a registered browser to a locked credential is told `CREDENTIAL_LOCKED`, because it has already reached the secret and could attack it; a request that has not is never told.

**An unregistered browser cannot sign in at all**, and the only routes to registering one are setup and recovery — both of which require a grant delivered to the account's registered channel. A stolen shared secret alone is not enough, which is the whole point.

### 13.9 Setup grants

Every first credential — staff password, rider PIN, vendor shared secret, the bootstrap password — is established by **its owner**, using a single-use, principal-bound, purpose-bound grant stored hashed and never logged.

**A grant is not a session.** It authorises one act of one purpose on one principal and carries no business authority. **Before Gate A there was no such path**, and the alternative in practice is an administrator choosing another person's permanent credential — which makes it not a credential.

Non-bootstrap grants expire on the existing **30-minute** `recovery_link_ttl_minutes` rather than a new invented figure. **`BOOTSTRAP_SETUP` alone has no expiry**: a clock there can strand provisioning into an environment nobody can sign into.

**Delivery depends on the purpose, and there is no universal rule**. Staff setup goes to the **verified work email**; vendor setup to the **registered channel**; `BOOTSTRAP_SETUP` to the **controlled provisioning channel**; the `MFA_ENROLMENT` continuation grant is **returned in the transaction that created the factor**; and the two rider device grants are **scanned from a screen**. The state machine's §19.1 carries the table.

**`BOOTSTRAP_SETUP` uses the provisioning channel, and not because the principal is missing.** The seed has already created the two bootstrap `StaffIdentity` records, one per designated custodian. It uses them because **first-administrator setup must not depend on ordinary user-controlled or verified application delivery** — there is no work email an approver has passed yet, and trusting one would let whoever provisioned the environment nominate where the highest-authority credential in the system is sent.

**`MFA_REENROLMENT` has one purpose and two authorised transports.** Ordinary administrative reset delivers it to the affected privileged staff principal's **verified work email**. The **bootstrap-resume mechanism under `MSC-DEC-272`** delivers it through the **controlled provisioning channel**. **Purpose answers what the credential may authorise; transport answers how the authorised principal receives it** — and inventing a second purpose for a second delivery route would fragment the enum without adding a rule.

**`SetupGrant` establishes authentication capability; `RecoveryRequest` repairs an existing credential** (R1.3). A first password, a first shared secret, an MFA factor, a device binding — `SetupGrant`. Replacing a password or shared secret somebody already holds — `RecoveryRequest`, whether self-service or Platform-Admin-initiated. **Two token machines governing one act is a guarantee they drift**, which is what the withdrawn `VENDOR_CREDENTIAL_RECOVERY` purpose had already begun to do.

**The bootstrap secret is consumed at password establishment and never presented twice**. A short-lived `MFA_ENROLMENT` continuation grant carries the enrolment step, and it may safely expire because the identity it belongs to already has a password and a `PENDING` factor — a fresh grant re-enters the flow.

**A bootstrap administrator cannot be stranded by an expired continuation** (`MSC-DEC-272`; unchanged under `MSC-DEC-440`, and applied to each of the two identities separately). If the `MFA_ENROLMENT` grant lapses before a code is proven, a **provisioning-only** mechanism — outside the business API, on the same controlled channel that carried the bootstrap secret — issues a fresh `MFA_REENROLMENT` authorisation. It grants **no session, no factor and no password**, does **not** resurrect the consumed `BOOTSTRAP_SETUP` secret, and **refuses to operate for an identity once that bootstrap identity is offboarded, or once that identity holds an `ACTIVE` factor**. See [MIGRATION_AND_SEEDING.md](MIGRATION_AND_SEEDING.md) §3.3a.

**`MFA_ENROLMENT` is the only purpose that activates a factor.** Three purposes create a `PENDING` one; `BOOTSTRAP_SETUP` must never activate, because it is the single grant with no expiry and would otherwise remain a standing key to privileged access.

**Authentication challenges are not setup grants and do not share their lifetime**. `authentication_challenge_ttl_minutes` is **5**: an MFA challenge survives three wrong codes then becomes unusable, and a rider nonce is consumed by a **failed** signature as well as a successful one, so every attempt passes through the rate limiter rather than hammering one challenge.

### 13.9a Delivering a grant or a link — one port, a durable job, never the response path

Gate PD-3R1, `PDA-54`; **replaced on 8 October 2026** by the owner's decision ([SLICE-000-FINAL-DECISIONS.md](../delivery/planning/SLICE-000-FINAL-DECISIONS.md) §4), which retires the provider call inside the issuing transaction. **Every setup grant and recovery link that travels as a message reaches its principal by email or SMS (staff: the verified work email only).** Four grants do not travel as messages and never enter this port: the two rider device grants (returned in the response and shown as a QR), the `MFA_ENROLMENT` continuation grant (returned in the response of the operation that issues it), and the bootstrap secret and the bootstrap-resume authorisation (the controlled provisioning channel). A slow provider held a pooled connection and its locks after the HTTP request had ended, enough requests exhausted the pool, a crash after the answer lost the work, and nothing could repair an ambiguous acceptance. A durable job removes all four.

**One port, on the worker side.** The credential service never calls a provider. It writes a **delivery job** (`CredentialDeliveryJob`, below) beside the grant or request, and a separate worker calls `SecurityMessageDelivery.send(kind, channel, destination, payload)`, where `kind` is `SETUP_GRANT`, `RECOVERY_LINK`, `DEVICE_GRANT` or `MFA_REENROLMENT`, `channel` is `EMAIL` or `SMS`, and the result is *accepted*, *rejected* or *unknown*. **The destination is resolved by the service from the principal's registered channel when the job is written, never from the request** (`requestCredentialRecovery` accepts no destination at all). The payload is the link, the purpose and — for a vendor — the account identifier. **It never contains a password or a secret.**

**The sequence.**

1. **Validate and resolve.** The operation is validated and the registered destination chosen. A request that cannot name a deliverable registered channel, or whose channel is not available in this environment (for example no provider is configured), is refused before anything is written.
2. **One short transaction.** It writes the redemption record — **its hash only** — superseding or coalescing earlier ones as the operation's own rule says, the encrypted delivery job and the audit event, and **commits before acceptance is acknowledged.**
3. **A worker claims the job with a lease** in a short transaction and releases the connection, **calls the provider with no transaction open**, and records the outcome in another short transaction.
4. **Retries touch only the same job and token**, on the bounded Class 1 schedule of [BACKGROUND_JOBS_AND_EVENTS.md](BACKGROUND_JOBS_AND_EVENTS.md) §3.2 cut off at the redemption record's expiry, with a stable provider deduplication identifier wherever the provider supports one. A deterministic rejection, or the end of the schedule, is a terminal failure.

**What the caller is told.** An operation answers when the job is **durably queued**, not when a provider answered. An operation whose effect is a state change keeps its ordinary success status; one whose only effect is the message answers `202`; a bounded delivery status is added only where the caller needs one. **A provider's rejection or timeout after the commit is a job outcome and never a retroactive failure of the request.** A job that cannot be persisted is an operational failure — the platform's generic answer — and **never** a successful acceptance; `CREDENTIAL_DELIVERY_FAILED` remains only for a request that cannot name a deliverable registered channel or whose channel is not available in this environment (step 1).

**`requestCredentialRecovery`.** It answers `202` with one body for an eligible and an unknown identifier (§37.7), **with no provider call on its response path.** The two branches do bounded work of the same order — one lookup, and for an eligible principal one short transaction — and **no branch performs an unbounded dummy write to look like another.** Equal statement counts are not an anti-enumeration proof: the uniform answer is the control, and timing distributions across the branches are a diagnostic. Every such request, coalesced or not, is counted in the limiter. Its recovery-link rule is `credential-recovery.md` §5.5. **Who is eligible is `credential-recovery.md` §5.7** (a `REJECTED`, `OFFBOARDED` or `PENDING_APPROVAL` identity and any principal with no established credential are answered like an unknown identifier): a request and a completion both read that status after taking the identity lock at the identity level of §13.10a, and the offboarding transaction takes the same lock, so a completion racing an offboarding either commits first or is `RECOVERY_TOKEN_INVALID`. The proof is `GBT-B15`. For a vendor the account is the principal, and its organisation's `REJECTED` or `TERMINATED` status is the same kind of terminal state (Product decision, 9 October 2026; the real transition is `SLICE-008`'s).

**The job and its secrecy.** The redemption record stays hash-only. **Among Melarc's stores the raw token of a queued message lives in the job's encrypted payload and nowhere else, with two bounded exceptions**: the sealed replay fields of `registerRiderDevice`, which is not a message (§14.16), and, in non-production only, the capture adapter's restricted sink, which holds the message in clear by design. It necessarily also exists in the message in flight and in the recipient's mailbox or handset, which no Melarc control reaches. The payload is under authenticated encryption with the `credential_delivery` key purpose (§14.9), with the job id, kind, principal and redemption record bound as associated data. The ciphertext is **erased when the provider accepts the message**, and in any case when the job expires, is cancelled or fails terminally; the job's metadata (state, attempt count, a non-secret outcome class) survives under its own retention rule. No credential reaches a log or an audit event. Deleting a live row does not erase backups or the write-ahead log, and the guarantee is worded that way.

**What a job holds:** its id; the `kind`; the redemption record it serves (type and id) and the principal; the `channel`; the `state`; `attempt_count`, `next_attempt_at`, `expires_at` and, when it was accepted, `accepted_at`; the lease (`lease_owner`, `lease_version`, `lease_expires_at`); the stable `provider_dedupe_id` and the provider's non-secret message reference; a closed, non-secret `outcome_class`; and the payload (ciphertext, key version and nonce, with `payload_erased_at` once it is gone). The destination and the raw token exist only inside the ciphertext.

**The states** are `QUEUED · LEASED · ACCEPTED · RETRYABLE · FAILED · EXPIRED · CANCELLED` ([state-machines.md](../contracts/state-machines.md) §22). *Accepted* means the provider took the message, **never that the recipient received it.** Every outcome write presents the job's lease version, so a stale worker cannot overwrite a later outcome. **A timeout may mean the provider accepted the message:** the job is retried with the same link and the same deduplication identifier, or reconciled where the provider offers a status query. **Exactly-once delivery is not promised.**

**Cancellation and the send in flight.** Before it sends, the worker re-reads the redemption record and does not send for one that is expired, consumed, superseded or cancelled. A send already in flight can still arrive after a cancellation, so **redemption — not delivery — is the control**: it rejects a consumed, superseded or cancelled record whatever was delivered. A crash leaves committed work that a later lease reclaims; shutdown stops claiming and finishes or relinquishes leases inside the shutdown budget.

**Redemption and delivery are separate.** A credential's validity is the redemption record's alone. A failed or late message never changes it, and consuming or invalidating the record cancels its pending jobs.

**Adapters.** *Production:* an adapter for the chosen email and SMS providers, which are **external deployment inputs** (`OQ-048` carries the SMS provider and now the transactional email provider; no provider is selected and none is invented here). *Local and CI:* **only** the **capture adapter**, which writes each message, link included, to a developer-visible sink outside the repository (restricted, git-ignored, excluded from `package:source`) and reaches no recipient. *Staging:* the capture adapter **by default**, and a real provider only inside the explicitly controlled release-validation window of `DEPLOYMENT_AND_ENVIRONMENTS.md` §4.1 (a non-production credential, allow-listed recipients, a recorded approval). **Production refuses to start with the capture adapter or without a configured production adapter** (`DEPLOYMENT_AND_ENVIRONMENTS.md` §12.3), and a test proves it, exactly as for the attestation substitute. The adapter's timeout is deployment configuration shorter than the lease, so a provider that is merely slow loses its lease and is retried rather than holding anything.

**A failed send is a delivery outcome and never an identity state**: `StaffIdentity.status` does not move, because Version 1 has no email-verification lifecycle for it to move through.

**The link a message carries** (Product decision, 8 October 2026). Each purpose has its own browser route, under a **configured** origin: staff setup `/setup/credential`, staff recovery `/recovery/complete` and staff MFA re-enrolment `/setup/mfa` on the Ops origin, each with the token in the **URL fragment** (`#token=…`), and the Vendor purposes on purpose-specific Vendor routes documented before real vendor delivery is enabled. The origins are never derived from `Host`, a forwarded header or a submitted redirect URL. The page reads the fragment once into transient state, removes it at once by replacing the history entry, keeps it out of telemetry and error capture, sends `no-referrer` and loads no third-party content, and **posts the token with `fetch`** (a CORS-mode request carries the real `Origin`; a form post or navigation under `no-referrer` can carry `Origin: null`, which the pre-session rule refuses); a reload after that may require reopening the message, and the token is never kept in local or session storage for convenience. The server checks the token's purpose, principal and expiry whatever route it arrives on. The Vendor client belongs to the Vendor client work: the API and the capture adapter can be tested meanwhile, but no real user is sent to a Vendor route that does not exist, and a Vendor user is never routed through a staff screen.

**What the port does not carry.** The two rider device grants are not messages: they are returned in the response and scanned from the officer's screen (§13.9), so a rider's enrolment needs no provider and has no delivery job.

**`CredentialDeliveryJob` is a persistent technical table, declared here for mechanical discovery** (the pattern of §14.11):

```
PERSISTENT-TECHNICAL-TABLE: CredentialDeliveryJob
```

**An outage is a bounded failure.** While a channel is down, jobs retry on the bounded schedule and then fail terminally, and nothing else stops: sign-in, live sessions and every operation are unaffected, and the *Provider down* and *Credential delivery* alerts fire (`OBSERVABILITY_AND_RECOVERY.md` §3). Recovery for the affected principals waits for the channel — which is the correct outcome, because a recovery that could be delivered some other way is a recovery to an address nobody registered.

### 13.10 Session invalidation on authority change

Any security-relevant authority change **terminates live sessions immediately**: bundle change, **a reduction of the bundle the session was issued from** (Product decision, 8 October 2026: a permission removed, or a scope or tier narrowed; the sessions are found by the `bundle_id` and `bundle_revision` each records against the bundle's `reduction_floor`, and ended in the same transaction as the change; an addition or widening raises the revision only and every existing snapshot is retained), hub-scope change, suspension, offboarding, credential change, MFA reset, device revocation or replacement, administrative revocation. The coordination, the lock order and a sign-in racing a reduction are settled in §13.10a below.

**The snapshot is what makes this necessary.** `bundle_snapshot` is deliberately frozen at issue so history reads correctly — and the same property would otherwise let a reduced bundle keep its old permissions for the rest of the session. **An administrator would remove access in the database while the user kept it.**

**The `Session` row is the whole mechanism** (§15.3): each of these is a `TERMINATED` state change made in the same transaction as the act that caused it.

**Fixed Vendor and Rider authority** (Product decision, 8 October 2026; specification only, corrected by the R2 review). Vendor and Rider authority has two parts, and each has its own revision.

1. **The seeded fixed bundles.** Vendor and Rider each carry exactly one fixed, non-configurable `RoleBundle` ([permissions.md](../contracts/permissions.md) §8, [MIGRATION_AND_SEEDING.md](MIGRATION_AND_SEEDING.md) §4). Their sessions snapshot that bundle and record `bundle_id` and `bundle_revision` like any other, and a change to one of those bundles — made only by a seed or a migration — follows the bundle rules of §13.10a.
2. **The compiled fixed policy.** The rules a release itself enforces for those two audiences — which operation requires which key, and the ownership and assignment predicates — are code, and no bundle row can carry them. Each release compiles in a *fixed-policy revision* for each of `VENDOR` and `RIDER`, raised by **every** change to that compiled policy. The database holds, per type, the latest released `revision` and a `minimum_revision` floor (`FixedPermissionPolicy`), and every Vendor and Rider session records the `policy_revision` it was issued under.

A release that changes only the bundle data uses the bundle rules, one that changes only the compiled policy uses the policy rules, and one that changes both uses both, in the lock order of §13.10a. **Authority is the stored snapshot, never recomputed from code at request time.** Terminating today's sessions is not enough on its own when the compiled policy is *reduced*, because during a rolling release (`DEPLOYMENT_AND_ENVIRONMENTS.md` §7) an instance still running the old code could issue a session under the old policy after the migration. Three parts close that, and they are the same for both principal types:

1. **A revision, and a floor.** `revision` is raised by every change to the compiled policy; `minimum_revision` is raised only by a *reduction* of it, to the reducing release's revision. An addition or widening raises `revision` and leaves the floor where it was, so every existing session keeps its snapshot and stays valid.
2. **An instance that cannot be sure of the policy serves nothing of that type.** Two checks, each against the stored values, each answered with the platform's existing operational failure (`503`, retryable, no business code, nothing executed or written), and **neither terminates the session**: the session is valid and the instance serving it is the wrong one, so the next request, reaching a suitable instance, succeeds.
   - An instance whose compiled revision is lower than `minimum_revision` — *below the floor* — **refuses issuance and every authenticated request** on a session of that principal type, and reports itself *not ready* with the reason `policy_superseded` (`DEPLOYMENT_AND_ENVIRONMENTS.md` §7 and the technical probes of §12). Refusing only issuance would leave a below-floor instance serving requests under a policy that has been reduced. A rolled-back release cannot issue or serve either.
   - An instance whose compiled revision is lower than the session's own `policy_revision` — *older than the session* — **refuses that request**, because it does not know the policy the session was issued under (a changed predicate, a stricter key).

   A current instance serves a session whose `policy_revision` is at or above the floor and at or below its own compiled revision: an older session that remains above the floor is served, on its stored snapshot, by any instance that knows at least that policy. The floor is read **under the shared policy lock of §13.10a**, after it is held. **Slice-000 has no cross-version compatibility exception**: an older instance never serves a newer session, and no registry says otherwise. One `FixedPermissionPolicy` row per principal type could not say which older sessions an instance may serve once the row has moved on to a later revision, so a later slice that wants such an exception must design a retained mapping per revision; until then the rule above is the whole rule. **Bundle snapshots need no further rule**: they hold permission keys, an older instance denies a key it does not know (deny by default, [permissions.md](../contracts/permissions.md) §2), so a snapshot fails safe on older code.
3. **The reduction raises the floor and ends what is below it.** The migration or release step that reduces the policy holds the exclusive policy lock of §13.10a, raises `minimum_revision`, ends every `ACTIVE` session of that type whose `policy_revision` is lower with `AUTHORITY_CHANGED`, and writes one `auth.session.authority_revoked` each, all in one transaction. **Every request on a Vendor or Rider session also compares the session's `policy_revision` with the current floor, and a current instance refuses a lower one** (`401 SESSION_INVALID`, the session marked `TERMINATED`), so a session that an old instance committed just before the raise is refused at its next request and is ended by the same rule even if the scan missed it. Only a current instance, or the reduction itself, ever terminates a session for a floor violation; an obsolete or older instance refuses with the operational failure of 2 and writes nothing.

The floor is raised **no later than the step that first lets an instance with the new revision serve traffic**; raising it after the old instances have drained would leave old authority issuable in the meantime. **While old instances drain, every Vendor and Rider request that lands on one — a sign-in or an authenticated call — fails closed and is retried; that is the accepted price of a reduction**, and a reducing release is marked as one in its notes. The first release that issues a Vendor or Rider session ships the `FixedPermissionPolicy` rows, the recorded revision, the issue check and the request check, so that the first reduction does not need an earlier release to have anticipated it.

### 13.10a Authorization-policy coordination, revisions and the lock order

Product decision, 8 October 2026, correcting the first R2 draft. S0.7 builds the **toolkit** this section specifies (the lock-keys module, the planner, the acquisition and the isolation guard, the coordinator with its bounded restart, and the check that forbids the session-level functions) and nothing that uses a policy table. It ran obligations 1 (on fixture tables), 5, 6, 7, 9, 11 and 12 at the toolkit under the runtime login. **S0.27 (migration `0017`) then built the bundle-change primitive and ran, on the real policy tables and rows, under the real runtime and migration logins:** obligation 1 (the runtime holds no write and no row lock on the three tables, and the catalogue shows none), 2, 3 and 4 with the real reduction and the real sign-in and state-changing request in both orders, 5, 6 for the writer and the sign-in, 7 (no lock is left on the connection) and 9, and the writers' half of 12 (canonical order, merged keys, no upgrade, no cycle between two steps in canonical order), each with deliberate breaks that the tests caught (`policy-change.db.test.ts`, `policy-change-races.db.test.ts`; "The primitive" at the end of this section). **Not claimed as run:** obligations 8 and 10 (randomised interleavings; starvation on the pinned server), which are S0.64's, and 13 (two builds against one database), which is S0.63's and S0.64's.

**Two counters for each policy object, and they are different facts.** A *revision* says that the authorization content changed; a *floor* says below which revision a session may no longer be trusted. Conflating them is how an addition would either end good sessions or a reduction would miss bad ones.

| Policy object| Revision (every content change)| Floor (reductions only)| Recorded on the session|
|---|---|---|---|
| `RoleBundle`, including the fixed Vendor and Rider bundles| `revision`| `reduction_floor`| `bundle_id`, `bundle_revision`|
| `FixedPermissionPolicy`, one row per `VENDOR` and `RIDER`| `revision`| `minimum_revision`| `policy_revision`|

- **Every authorization-content change raises the revision**: for a bundle, a `RoleBundleGrant` added, removed, or changed in its permission key, hub scope, ownership scope or tier; for the compiled policy, any change to the rules it enforces. A change to a name alone raises nothing. Revisions only increase, by one, inside the transaction that makes the change.
- **A reduction also raises the floor to the new revision.** A reduction is a removal, or a narrowing of a hub scope, ownership scope or tier; a change that both adds and removes is a reduction. **An addition or widening leaves the floor alone**, so every existing session keeps its snapshot, stays valid, and is not asked to sign in again.
- **A session is trusted for its authority only while its recorded revision is at or above the floor.** In the same transaction as a reduction, every `ACTIVE` session of that object with a recorded revision below the new floor is terminated with `AUTHORITY_CHANGED`, with one `auth.session.authority_revoked` event each. Every request also compares the recorded revision with the floor, so a session the scan missed is refused (`401 SESSION_INVALID`).

**The runtime roles hold only `SELECT` on these tables, and that stays true.** PostgreSQL requires the `UPDATE` privilege for a row-locking `SELECT` — `FOR SHARE` and `FOR KEY SHARE` included — so a shared row lock on `RoleBundle`, `RoleBundleGrant` or `FixedPermissionPolicy` would force an `UPDATE` grant on tables that only a seed or a migration may change. **No such grant is made, and no row lock is taken on these tables by the runtime.** Coordination is by **transaction-scoped advisory locks**, which need no table privilege:

- **Shared** (`pg_advisory_xact_lock_shared(class, key)`) by everything that relies on the content staying put while it acts.
- **Exclusive** (`pg_advisory_xact_lock(class, key)`) by everything that changes the content or a floor.
- **Always the transaction-scoped forms, never the session-level ones**, so a pooled connection never carries a lock past `COMMIT` or `ROLLBACK`; an application-code check forbids the session-level functions and any `pg_try_` loop without a bound.

**Classes and keys.** Two policy classes, each a fixed 32-bit constant defined once in one lock-keys module, whose test asserts that no two advisory classes in the codebase share a value (the limiter's per-key serialisation and any other advisory use take other classes). The numbers are engineering constants, not contract values.

| Class| Key| Protects|
|---|---|---|
| `AUTH_POLICY_BUNDLE`| A stable 32-bit digest of the bundle's `id`| That bundle's grants, `revision` and `reduction_floor`, and the sessions issued from it. A digest collision only adds contention, never a missed exclusion|
| `AUTH_POLICY_FIXED`| The principal type's ordinal (`VENDOR`, `RIDER`)| That type's `FixedPermissionPolicy` row|

**Two kinds of lock in one operation, and they are not the same thing.** *Actor-policy protection* is the shared policy lock on the policy objects the **acting principal's own authority** rests on — the bundle of the session that is acting and, for a Vendor or Rider, the fixed key. It is taken first and held for the whole transaction, so that an act cannot outlive a reduction that ended the authority it relied on. *Target revocation locks* are the identity row and the session rows of the **principal an act is done to**, taken to end or change that principal's sessions. Ending a session is the very state change a reduction makes, so the two commute on session rows and a target revocation takes **no policy lock for the sake of the target's sessions**. A policy lock is taken for a target only when the act **reads or writes policy content about it** — the assignment or approval of a bundle names that bundle — and then the target's bundle is simply one more key in the planned set below.

**Who takes which mode.**

| Transaction| Mode| Why|
|---|---|---|
| Session issue (every sign-in that creates a session)| **Shared** on the bundle key of the identity signing in, then, for Vendor and Rider, shared on the fixed key| It copies the bundle and reads the floor, and must not be ordered after a reduction that it would then survive|
| Any state-changing request on a session| **Shared** on the acting session's bundle key and, for Vendor and Rider, fixed key| An authorised mutation either finishes before a reduction takes its lock or sees the reduction and does not proceed|
| An administrator's act on another principal (a reset, a recovery, a revocation, a reissue, an approval)| Actor-policy protection as above; **no policy lock for the target's sessions**; a shared lock on a bundle only where the act reads or writes it (an assignment, an approval)| The target's identity and session rows are the target revocation locks of the next section|
| A bundle content change: the seed, a migration, and the `SLICE-009` edit operation| **Exclusive** on the bundle key| It reads the current revision, writes the new content and revision, and ends sessions, as one unit|
| A compiled-policy change or floor raise (a migration)| **Exclusive** on the fixed key, after the bundle key if the same step changes a bundle| Same|
| The seed that inserts the first bundles, grants and `FixedPermissionPolicy` rows| **Exclusive** on each key it creates| No session can exist yet, but one protocol has no special case|
| A read-only request| None| It compares the recorded revision with the floor; a read racing a reduction is simply ordered before it|

**Discovery, the planned set and restart.** Some policy keys cannot be known until data is read: a sign-in learns the bundle only through the identity, a state-changing request learns the actor's bundle only through its session, an assignment learns the target's bundle only through the target. Locks must come first, so a transaction that needs them runs in five steps:

1. **Discover, non-authoritatively.** A short read **before the transaction begins** (its own statement at `READ COMMITTED`) finds the bundle ids and principal types involved. It decides nothing, carries no effect and is only a hint about which locks to ask for.
2. **Plan the complete set** of policy keys the transaction will need: every discovered bundle, the fixed key for a Vendor or Rider, and anything the act reads or writes. **Merge duplicates and digest collisions into one entry per `(class, key)`, keeping the strongest mode** (exclusive over shared), and **sort the entries canonically** — class ascending, key ascending.
3. **Acquire the planned set before any other statement that reads or writes data**, in that order. Only transaction configuration may precede it: the isolation level and the transaction-local timeouts (`SET LOCAL lock_timeout`, `statement_timeout`) have to be set first, so that the acquisition itself is bounded. Then take the identity locks, then **revalidate authoritatively**: read again, now under the locks, the facts the plan was built on (the identity's bundle and status, the session's bundle and state, the target's assignment) and compare them with the plan.
4. **If anything changed, roll back the whole transaction, release every lock and restart from step 1**, at most a small bounded number of times, then answer the platform's generic operational failure. The bound is an engineering parameter, not a product value; **before implementation is accepted it has a concrete value that a test exercises**, and **every attempt, restarts included, fits inside one total operation deadline** — a restart never grants a fresh deadline. **No effect precedes the revalidation**: no write, no audit event, no session, no message and no external call.
5. **No upgrades.** A transaction never asks for a key in exclusive mode while it holds it shared, on any path: two holders that both tried would wait for each other for ever. A path that finds it needs exclusive on a key it holds shared rolls back and restarts with exclusive planned from the start.

Two bundles whose 32-bit digests collide simply share a lock, which is **harmless contention**: it can only add waiting inside the finite deadline, never admit an interleaving that the exact key would have excluded.

**One order for every identity transaction.** Locks are taken in this order and never the reverse, and a transaction skips the levels it does not need:

1. **Policy locks** — the planned set above, in canonical order.
2. **Identity locks.** Where an operation touches several principals (an administrator and a target, a revoker and a revoked, an approver and the profile approved), their identity rows are taken **ordered by principal type and then `id` ascending across all of them**, each principal's own credential, factor, challenge, grant and recovery rows following in the order that operation's rules already give. This section changes none of those row orders.
3. **Session rows**, by `id` ascending across **all** the principals involved (revocation, sign-out, supersession, a reduction's termination).
4. **Business rows** of any later slice.

**Nothing that holds a session row ever waits for a policy lock.** The one-way order is what rules out a cycle: a reduction holds the exclusive policy lock and then session rows; an issue holds the shared policy lock and then identity rows and inserts a new session; an individual revocation takes the acting administrator's shared policy lock where there is an acting administrator (a sign-out, an expiry or a system suspension has none), then identity rows, then session rows; a mutation takes the shared policy lock first and its business rows afterwards. The limiter and the credential-delivery claim run in **their own short transactions** that commit before, or independently of, the identity transaction and take none of these locks.

**Reads follow acquisition, and are never cached.** The planned policy locks come before any statement that reads or writes data — only the transaction's own configuration (isolation level and local timeouts) precedes them — and the transaction runs at `READ COMMITTED`, so every read of a bundle, its grants, a revision or a floor starts after the locks are held and sees everything committed by the writer that held them before. The discovery read runs before the transaction and the revalidation read after the locks; neither is the basis of an effect. A snapshot is copied from what a locked read returned; a bundle or a floor is never served from a process cache or a value read in an earlier transaction. A transaction that begins at `REPEATABLE READ` or `SERIALIZABLE` could read a snapshot older than its locks and is refused for these operations; a guard asserts the isolation level.

**Deadlines are finite.** Every acquisition runs under the transaction's `SET LOCAL lock_timeout`, which sits inside the statement timeout, which sits inside the transaction budget (§14.6). On expiry an issue or a mutation rolls back and answers the platform's generic operational failure (`503`, retryable, no session issued and nothing executed), and so does a restart that exhausts its bounded attempts; a writer rolls back everything, so **a reduction never proceeds without its lock and never half-applies**, and a migration or release step that cannot take it fails visibly and is retried. PostgreSQL queues a new shared request behind an exclusive one that is already waiting, which is relied on so that a stream of sign-ins cannot starve a reduction; that behaviour is **proved on the pinned server version**, not assumed.

**Acceptance obligations** — owed by the tasks that build the behaviour, run on real PostgreSQL under the **actual runtime login** and not under the owner, and recorded as open until they pass:

1. **Privilege.** Under the runtime role, an `UPDATE` of `RoleBundle`, `RoleBundleGrant` or `FixedPermissionPolicy` is refused; `SELECT … FOR SHARE` on them is refused; the transaction-scoped advisory functions run; and the catalog check shows no `UPDATE` grant on those tables.
2. **Issue against a reduction, both orders.** A sign-in that reads the bundle before a reduction commits cannot leave a session with the old snapshot ACTIVE; one that starts after reads the reduced content. The same for a fixed-policy floor raise: see 13.
3. **A mutation against a reduction, both orders**, and a mutation already past its lock finishing before the reduction proceeds.
4. **Additions retain snapshots**: an addition raises `revision`, ends no session, and a later reduction ends every session below its floor including those issued after the addition.
5. **Two writers** on one bundle serialise, and a writer on one bundle does not block an issue on a bundle with a **distinct lock key**. Two bundles whose digests collide share a key and may contend inside the deadline (that is the harmless case of the planned set), so the proof uses bundles whose keys differ.
6. **Deadlines**: an expired `lock_timeout` produces the generic failure, no session, no half-applied reduction.
7. **No leaked lock**: after `COMMIT`, `ROLLBACK` and an aborted transaction on a pooled connection, no advisory lock is held (Family A).
8. **Order**: randomised interleavings of issue, mutation, reduction, revocation, sign-out and operations on several principals complete without a deadlock.
9. **Isolation guard**: a transaction at a stricter isolation level is refused.
10. **Starvation**: a continuous stream of sign-ins does not prevent a reduction from acquiring its lock within its deadline on the pinned PostgreSQL version.
11. **Discovery and restart**: a sign-in or a request whose identity is reassigned to another bundle between discovery and lock revalidates, rolls back the whole transaction and restarts; the restarts are bounded, then the generic failure; and nothing — no write, audit event, session, message or external call — happened before the revalidation passed.
12. **The planned set**: duplicate keys and two bundle ids whose digests collide merge into one lock request in the strongest mode; locks are taken in canonical order; no code path takes a key exclusive while holding it shared; two operations with overlapping sets in opposite orders never deadlock; a digest collision costs waiting inside the deadline and no missed exclusion. Target revocation takes no policy lock for the target's sessions and does not block, or get blocked by, a reduction beyond the shared session-row order.
13. **Two versions, a changed predicate** — the runtime proof of the fixed-policy rule of §13.10. Two real application builds with different compiled revisions, whose policies differ in an actual predicate (a required key or an ownership predicate), run against **one** database under the runtime login. Below the floor the older build refuses issuance **and every authenticated request** of that type with the generic failure, writes nothing and leaves the session `ACTIVE`, and the current build then serves it. A session of a newer revision than the build, at or above the floor, is refused by that build with the same failure and stays `ACTIVE`; a session of an older revision that remains above the floor is served by the current build. A session below the floor is refused and terminated by the current build and by the reduction, never by the obsolete one. A bundle snapshot holding a key the older build does not know is denied on it.

**The primitive (S0.27, migration `0017`; decided and recorded 12 October 2026).** A bundle's content, its counters and a fixed policy change after the seed only through two `SECURITY DEFINER` functions owned by `melarc_owner`, executable by the migration login alone: `melarc.change_role_bundle(bundle, name, grants, correlation)` and `melarc.change_fixed_policy(audience, reduction, correlation)`. The form is SQL and not an application command because the only identity the registry names for a policy change after the seed is the migration login, a migration is SQL, and the lock, the diff, the writes, the ending of the sessions and their audit events then form one transaction by construction. Each function refuses a transaction that is not at read committed, takes its exclusive policy lock as its first statement and reads nothing before it, decides *reduction*, *addition*, *name only* or *none* from the difference between the stored and the given grants, writes the content and the counters (the table triggers hold the rule that a revision rises by one and a floor only with a reduction, to the new revision), and for a reduction ends every live session recorded below the new floor with `AUTHORITY_CHANGED` and writes one enhanced `auth.session.authority_revoked` for each, in the caller's transaction; the event is the one `endForAuthority` writes (a test compares the two rows). **A change that cannot be shown to be a widening is a reduction**: the hub scope is the chain `none < own < all`, the tier the chain `null < A < S < P` (a null tier is *not applicable*, never a ranked tier: OB-75), and the ownership scope has `any` over `own` and over `assigned`, which are not ordered between themselves, so a move between them is a reduction; a reduction can only end more sessions, never fewer. The functions assert the new task capability `policy_change` for their own statements (a label is not an identity: the runtime logins can assert it and reach nothing, because they hold `SELECT` on these tables and no more), and the correlation id is an identifier the caller generated or the fixed label of a release step, which the functions check for shape only (1 to 128 letters, digits and `. _ : / # -`): that is validation and no screen for a secret or for personal data, so a caller never passes text that a user supplied. **The seed uses the same SQL for its locks:** `melarc.lock_policy_keys(bundles, audiences)` takes every exclusive key in the one canonical order (bundles by key, then fixed policies by ordinal), and the bundle and fixed lock functions refuse what the protocol forbids and the database cannot see (an upgrade of a shared key the transaction holds, a bundle lock after a fixed lock, a lower key after a higher); the numbers are written twice, in `lock-keys.ts` and in SQL, and a test holds them to each other by what the server reports in `pg_locks`. The provisioning login keeps exactly the two seed functions and `lock_policy_keys` (`APPROVED_DEFINER_EXECUTE`) and cannot change a bundle after the initialization. **Open, and not decided here:** how the `SLICE-009` edit operation, which runs in the API, reaches the function (an `EXECUTE` grant to the runtime would let any code running as the API change any bundle, which is a decision of that slice and of the Product Owner, and nothing here makes it); and whether a change of a bundle's `privileged` flag or audience, which the primitive does not touch, is authorization content.

### 13.11 No action-time elevation

`MSC-DEC-228` withdrew session elevation. **MFA gates sign-in for privileged roles; nothing re-challenges at the moment of a privileged action.** Operations requiring privilege require **an authenticated privileged session holding the permission** — and this document, `permissions.md` and the OpenAPI contract each still said *"elevated session"* until Gate A removed it.

### 13.12 What Gate A does not settle — the Gate B boundary

| Item| Owner|
|---|---|
| Encryption-at-rest and KMS key custody, including the TOTP seed key| **Gate B — now §14.9**|
| PostgreSQL row-level security and connection pooling| **Gate B — now §14.1–§14.6**|
| Production network security and backup security| **Gate B — now §14.8, §14.11**|
| Argon2id memory/time parameters| Benchmarked at deployment (§13.4)|
| ~~Rate-limit figures and their settings keys~~| **Complete** — keys `MSC-DEC-285`, figures `MSC-DEC-371`|

**Gate A depends on Gate B for key custody and does not wait on it.** The prohibition on plaintext seeds and raw session secrets binds now; where those keys ultimately live is Gate B's to decide.

**Gate B decided it on 27 August, and §14 is the answer to every row above marked with it.** Of the two rows that are *not* marked Gate B, one stays where it was — **Argon2id parameters are benchmarked at deployment** — and the other has since been answered: the rate-limit **figures** were supplied by **`MSC-DEC-371` on 5 September, closing `OQ-067`**. **`MSC-DEC-285` supplied their buckets and settings keys and deliberately no numbers**, and the numbers arrived nine days later; the **credential keying is unchanged**, there is **no seventh or eighth bucket and no IP or source-address bucket**, and post-launch telemetry recalibrates the values without touching the architecture.

## 14. Data isolation and security hardening

Everything below implements `MSC-DEC-275` through `MSC-DEC-285` and **carries no product authority** (§42.7). Gate A's signed identity and session invariants are unchanged: opaque server-side Sessions, cookie and Bearer transports, TOTP privileged MFA, the signed `MfaFactor` and `SetupGrant` machines, vendor registered-device authentication, rider cryptographic device authentication, the `RecoveryRequest`/`SetupGrant` boundary, bootstrap setup and succession, and authority-change session invalidation.

**§13.12 recorded four items as Gate B's. This section is them.**

### 14.1 The security context is transaction-local

`MSC-DEC-275`. Every RLS-protected request and every scoped job does its protected work inside a transaction whose context is set with **transaction-local** settings, discarded at commit or rollback.

| Key| Carries|
|---|---|
| `melarc.principal_type`| `STAFF` · `RIDER` · `VENDOR` · `SYSTEM`|
| `melarc.principal_id`| The authenticated principal|
| `melarc.session_id`| The `Session` this authority came from|
| `melarc.surface`| `OPS_PORTAL` · `VENDOR_PWA` · `RIDER_ANDROID` · `SYSTEM`|
| `melarc.task_capability`| **`SYSTEM` only.** The one capability the task works under: a member of the closed list at [data-scope-registry.md](../contracts/data-scope-registry.md) §5.2 or, for a worker context built from an `Outbox` envelope (§14.7), the envelope's task class (§5.1 there). NULL for every other principal, so no SYSTEM branch is ever true for a business principal|
| `melarc.authorization_key`| **The permission key of the grant authorizing *this* operation**. The operation's `x-permission`, resolved against `Session.bundle_snapshot`|
| `melarc.hub_scope_mode`| **`SET`** or **`ALL`** — **resolved from that grant**, never from the Session as a whole|
| `melarc.authorized_hub_ids`| The effective Hub set: **that grant's scope intersected with `Session.authorized_hub_ids`**|
| `melarc.vendor_organization_id`| For `VENDOR` principals|
| `melarc.rider_id`| For `RIDER` principals|
| `melarc.correlation_id`| The request or idempotency identifier `audit.md` §3 already requires|
| `melarc.scope_probe_id`| **Set only by the repository function `existingRecordHub(entity, id)`** (§14.4b), and by nothing else: the one record id the scope probe may read across hubs. NULL otherwise, so the probe policy (§14.4b) admits nothing|

```
BEGIN;
  SELECT set_config('melarc.principal_type',      $1, true);   -- true = TRANSACTION-LOCAL
  SELECT set_config('melarc.hub_scope_mode',      $2, true);
  SELECT set_config('melarc.authorized_hub_ids',  $3, true);
  ...
  -- protected work
COMMIT;   -- every setting above is discarded here
```

**The third argument is the entire control.** `set_config(..., false)` — or a bare `SET` — persists for the *connection*. The connection returns to the pool still carrying one actor's Hub set, and the next request inherits it: a different hub, a different vendor, or no authenticated actor at all. **The leak is silent, non-deterministic, and invisible to every test that opens a fresh connection**, which is why §14.13's pooled tests are required to force reuse of the same physical connection.

**`SOLUTION_ARCHITECTURE.md` §6 has said *"hub set per request from the session"* since 20 August and never said how the set reaches the connection.** On a pooled connection that omission was the vulnerability, not a documentation gap.

**Which session-held authority, though, is exactly the gap**, and §14.1a is where that is settled: the Session says what the actor may do *somewhere*, and the policy needs to know what this actor may do **here, in this operation**.

**Accepted residual risk** (Product decision, 6 October 2026). `set_config` is available to any database role, so the role the API connects as must be able to set the security context itself, and **code that already runs as the API could set a false one**. Row-level security guards against a handler that forgets a filter; **it does not guard against compromised API code**, and this document does not claim it does. The risk is accepted, and four mitigations keep it small: **one transaction helper owns the connection** and is the only code that opens a transaction and sets the context; **nested or leaked transactions are refused**; **the raw pool is never handed to a handler**; and **the migration lint and the catalogue checks keep the database objects locked down** — no `BYPASSRLS`, no ownership, no policy alteration and no DDL for a runtime role (§14.6, §14.13).

**A task capability is a label, not an identity** (Product decision, 8 October 2026). `melarc.task_capability` is set by the same helper as every other value, so it narrows what a *correct* caller can do and does not stop code that already runs as the API from asserting another one. What stops that is the grant set: a `SYSTEM` policy branch always tests the capability it serves — `melarc.task_capability() = '<capability>'` for a capability of [data-scope-registry.md](../contracts/data-scope-registry.md) §5.2, or `melarc.outbox_task_permits('<table>')` for a context built from an `Outbox` envelope (§14.7) — never `SYSTEM` alone, and never an `OR` added to a policy to widen it. The structure is deliberately narrow and is the only one the migration lint and the catalogue check accept: the whole policy expression is one `CASE melarc.principal_type()`, its `ELSE` is `false` or absent, and the `SYSTEM` arm is a conjunction at its own level in which one conjunct is exactly the positive capability test, so that the access succeeds only when it is true; a negated, inverted, ranged or disjunctive comparison is not that conjunct, and a `CASE` wrapped in an `OR`, `AND` or `NOT` is refused. Each capability is usable only against the tables, statements, lookup predicates and returned fields listed for it in §5.2 (and §5.1 for a worker capability), with the DML on those tables granted to the technical identity that legitimately needs it and to no other. **That is a narrowing, not a separation.** Where a table is also written by the API under its own operations — the credential tables — the `authentication` and `bootstrap` branches are bounded by `WITH CHECK` predicates and column-level grants and by nothing more, and code that runs as the API could still assert the label: the accepted residual risk above. Where a stronger boundary than a label is wanted — the provisioning identity (§14.17) and the credential-delivery worker (§14.17b) — it is a separate database role or grant set, not a different string.

### 14.1a The context is bound to the grant authorizing **this** operation

`MSC-DEC-299`. **Scope belongs to the grant, not to the key** — `permissions.md` §7 and `MSC-DEC-221` have said so since 26 August. §14.1 above carried the *key* into the database and left the *grant* behind, deriving `hub_scope_mode` and `authorized_hub_ids` from `Session.authorized_hub_ids` alone. **That answers a question the policy did not ask.**

For every protected API operation, in this order:

| #| Step|
|---|---|
| 1| Authenticate the Gate A `Session` (§13.1). **Unchanged**|
| 2| Identify the current OpenAPI `operationId`|
| 3| Resolve its canonical **`x-permission`**|
| 4| Resolve the **exact grant** in `Session.bundle_snapshot` that authorizes **this** operation|
| 5| Read the **scope attached to that grant**|
| 6| Combine it with the Session's currently authorized Hub membership|
| 7| Construct the transaction security context from the result|
| 8| **Validate every value** (§14.1b)|
| 9| `BEGIN`, and set the validated context **transaction-locally** (§14.1)|
| 10| Execute the RLS-protected statements|

**Steps 4 and 5 are the whole correction.** Everything else was already here. **This is the order in which the security context is built, not the order in which an operation refuses a request**: that order is [permission-enforcement.md](../features/identity/permission-enforcement.md) §5.1.

#### The effective Hub set

| The grant authorizing this operation| `melarc.hub_scope_mode`| `melarc.authorized_hub_ids`|
|---|---|---|
| **Hub-limited**| `SET`| **The intersection** of that grant's hub scope with `Session.authorized_hub_ids`|
| **Explicitly all-Hub**| `ALL`| Not consulted|
| **Absent** — no grant authorizes this operation| —| **Deny.** `PERMISSION_DENIED` (§4)|
| Present, but the intersection is **empty**| `SET`| **Empty. No Hub-scoped rows** — never all|
| An approved **global-resource** operation| Per the registry's global / ownership / authority predicate| **No Hub requirement is fabricated**|

**A read of configuration is an instance of the global-resource row.** `listAssignableStaffRoleBundles` (`permission.assignable_bundle.read`, `MSC-DEC-443`) reads `RoleBundle`, which [data-scope-registry.md](../contracts/data-scope-registry.md) classes `PLATFORM`, with a `global` Staff `SELECT` predicate, and it names no Hub. The policy checks that the actor holds the key; the context carries **no Hub requirement**, so the answer is the same whatever the maker's hub. **This is not the `ALL` row**: `hub_scope_mode` is not set to `ALL` for it, and holding the key at any single hub confers no access to any Hub-scoped record.

**A Hub-limited operation stays Hub-limited however much authority sits beside it in the same Session.** A Senior Ops user may hold `report.read` at all hubs and `pickup.request.reassign_hub` at two; a context built from the Session reports `ALL`, and `MSC-DEC-290`'s requirement that reassignment hold **both** the source and the target hub becomes unenforceable — not by being overridden, but by being answered with the wrong grant's scope.

**The failure widens rather than denies, and it is silent.** Nothing errors. The reassignment simply succeeds. That is the same direction as the empty-set inversion §14.3 describes and the same reason it is worth a rule: the careless implementation is the permissive one.

**`ALL` is still never inferred** (§14.2, §14.4). C1 narrows where it may be *asserted from*: not from the Session, not from a bundle name, not from another grant — only from the explicit all-Hub scope of **the grant being exercised**.

**All-Hub authority is never derived from an unrelated grant.** *This Session contains an all-Hub grant* and *this operation is authorized all-Hub* are different statements, and only the second may set `hub_scope_mode = ALL`. An unrelated grant — one authorizing some other operation — contributes nothing to the scope of this one, in either direction.

**`WITH CHECK` uses the same resolved scope as `USING`**. A statement may not produce a row outside the scope of the grant that authorized it, which is exactly the guarantee `USING` alone never gave.

**`SYSTEM` is unaffected.** A worker holds no permission grant; its authority is the task capability and the trusted `Outbox` envelope (§14.7, `MSC-DEC-287`). **`VENDOR` and `RIDER` are unaffected**: their boundaries are ownership and assignment, and neither consults a Hub set at all (§14.4).

### 14.1b Context is validated before any protected statement runs

`MSC-DEC-275`. **The security-envelope builder validates every value it is about to set. Only validated values reach `set_config`.**

| Value| Validated as|
|---|---|
| `principal_type`| One of `STAFF` · `RIDER` · `VENDOR` · `SYSTEM`|
| `principal_id`| A well-formed UUID|
| `session_id`| A well-formed UUID, where the principal has a Session|
| `authorization_key`| A key present in the closed catalogue (`permissions.md` §7) and held by this actor for this operation|
| `scope_probe_id`| A well-formed UUID, set only by `existingRecordHub` (§14.4b) and never from a request|
| `hub_scope_mode`| Exactly `SET` or `ALL`|
| every Hub id| A well-formed UUID|
| `vendor_organization_id`| A well-formed UUID, **required** for a `VENDOR` principal|
| `rider_id`| A well-formed UUID, **required** for a `RIDER` principal|
| `surface`| One of the four allowed surfaces, and the one that pairs with this principal type: `STAFF` with `OPS_PORTAL`, `VENDOR` with `VENDOR_PWA`, `RIDER` with `RIDER_ANDROID`, `SYSTEM` with `SYSTEM`. No other pairing is permitted and none is inferred|
| `task_capability`| Present exactly when `principal_type` is `SYSTEM` and absent otherwise; a member of the closed list at [data-scope-registry.md](../contracts/data-scope-registry.md) §5.2 or the task class of the `Outbox` envelope the worker context was built from (§5.1 there); and permitted for the technical identity and composition root that is opening the transaction|
| `correlation_id`| Present, and of the form `audit.md` §3 requires|

**If any value fails, security-context establishment fails: the request or job is refused and the protected business query does not execute.** No transaction is opened, so there is nothing to roll back and nothing reaches the pooled connection.

**The audit mapping is deliberate.** A `SYSTEM` context's `principal_id` is the stable technical identifier of its capability, as §14.16 requires of a SYSTEM principal. `audit.md` records a SYSTEM actor with a null `actor_id`. The audit writer makes that mapping explicitly; it never copies the context's identifier into the event.

**Do not rely on a PostgreSQL cast to sanitise a context value.** §14.4a explains why in detail: the cast does not neutralise a malformed value, it **raises** on one, and an error is a different code path from a denial. Validation is where a malformed value is supposed to stop.


### 14.2 `SET` and `ALL` — why Hub scope is not one `hub_id`

`MSC-DEC-275`, §11.6, §37.3. Gate A permits an actor to hold **several** authorised Hubs and permits explicit all-Hub authority, so a single `app.hub_id` setting cannot express the model.

| Mode| Meaning|
|---|---|
| **`SET`**| The actor is authorised for a defined set of Hubs. A row is reachable only when its authoritative Hub is in that set|
| **`ALL`**| Permitted **only** where the authenticated Session authority explicitly grants all-Hub access|

**`ALL` is never inferred.** Not from a client request, not from an empty Hub list, not from a missing context, and **not from a role or bundle name**. `permissions.md` §5 makes Hub scope an attribute of the **grant**, and `Session.bundle_snapshot` plus `Session.authorized_hub_ids` are the source. A policy that read *"Platform Admin"* out of a string would make authority a naming convention.

**Temporary Hub assignment stays a security-authority change.** §5.8's effective-dated `HubAssignment` alters the set, and `MSC-DEC-259` terminates live sessions with `HUB_SCOPE_CHANGED` when it does — because `authorized_hub_ids` is resolved **at issue**, exactly as `bundle_snapshot` is, and would otherwise carry withdrawn scope for the rest of the session's life.

### 14.3 Fail-closed database behaviour

`MSC-DEC-275`. Each condition below denies. **None falls back to an application filter.**

| Condition| Result|
|---|---|
| Security context **invalid at establishment**| **The request or job fails before any protected statement runs** (§14.1b). This is the ordinary application path|
| Security context missing| Protected row access **denied**|
| **Hub set empty**| **No Hub-scoped rows.** It does not mean all Hubs|
| Principal type invalid or unknown| Deny|
| Vendor context missing on a Vendor-owned operation| Deny|
| Rider assignment missing on a Rider-assignment operation| Deny|
| Context and row disagree| Deny, **and emit a security event**|

**The database is the second line here, not the first.** Rows two onward describe what the *policies* do when a context is absent or empty, and they are all reachable in normal operation. **A malformed context is different**: §14.1b rejects it before the transaction opens, so the database never sees it. If one nevertheless reaches a GUC — a direct connection, a test that corrupts the setting by hand — the accessor cast **raises** and the statement aborts. **That is fail-closed and it is not the application path**, and §14.4a used to describe it as though it were.

**The empty-set row is the one that inverts under a careless implementation.** `hub_id = ANY(ARRAY[]::uuid[])` is false for every row, which is correct. `hub_id IN (SELECT ...)` over an empty subquery is also false. But an application that treats an empty list as *"no filter required"* and omits the predicate produces the opposite of the rule, and it produces it for the actor with the **least** authority in the product. Deriving the predicate in SQL rather than assembling it in application code is what makes the failure mode unreachable.

### 14.4 Policy patterns — principal-specific

`MSC-DEC-286`. **Access is evaluated by principal type. It is not composed by applying Hub scope and restricting other actors on top of it.**

Context accessors first, so a missing setting resolves to a denying value rather than raising:

```sql
CREATE FUNCTION melarc.principal_type() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('melarc.principal_type', true), ''), 'NONE')
$$;

CREATE FUNCTION melarc.hub_scope_mode() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('melarc.hub_scope_mode', true), ''), 'NONE')
$$;

CREATE FUNCTION melarc.authorized_hub_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT coalesce(
           string_to_array(nullif(current_setting('melarc.authorized_hub_ids', true), ''), ',')::uuid[],
           ARRAY[]::uuid[])
$$;

CREATE FUNCTION melarc.current_vendor_organization_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('melarc.vendor_organization_id', true), '')::uuid
$$;

CREATE FUNCTION melarc.current_rider_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('melarc.rider_id', true), '')::uuid
$$;

CREATE FUNCTION melarc.task_capability() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('melarc.task_capability', true), ''), 'NONE')
$$;
```

**`current_setting(name, true)` returns NULL instead of raising** — the `missing_ok` form. Without it a missing context raises *inside the policy*, and an error is not a denial: it is a different code path, and the one place it is guaranteed to appear is a health check or a migration that legitimately has no principal.

**`Order` — the canonical shape.** One policy, one branch per principal type, no branch reachable from another:

```sql
CREATE POLICY order_access ON "order" FOR ALL
USING (
  CASE melarc.principal_type()
    WHEN 'STAFF'  THEN melarc.hub_scope_mode() = 'ALL'
                    OR responsible_hub_id = ANY (melarc.authorized_hub_ids())
    WHEN 'VENDOR' THEN vendor_organization_id = melarc.current_vendor_organization_id()
    WHEN 'RIDER'  THEN FALSE                      -- no Rider branch on this table
    WHEN 'SYSTEM' THEN responsible_hub_id = melarc.outbox_hub_id()
                    AND melarc.outbox_task_permits('order')
    ELSE FALSE
  END
)
WITH CHECK ( /* the same expression - see below */ );
```

**Read the `VENDOR` branch carefully, because it is the whole correction.** It does not mention `authorized_hub_ids`, `hub_scope_mode` or any hub at all. **A vendor's own order in a hub no Ops contact of theirs can see is still that vendor's order**, and R0's layered model could not say so: a Vendor principal holds *no* `authorized_hub_ids`, so a Hub predicate evaluated first leaves only *see nothing* or *treat an empty set as permissive* — and the second is the inversion `MSC-DEC-275` exists to prevent, arriving through a different door.

**`PickupManifest` — where the Rider branch is the point.**

```sql
CREATE POLICY manifest_access ON pickup_manifest FOR ALL
USING (
  CASE melarc.principal_type()
    WHEN 'STAFF'  THEN melarc.hub_scope_mode() = 'ALL'
                    OR responsible_hub_id = ANY (melarc.authorized_hub_ids())
    WHEN 'VENDOR' THEN FALSE                      -- carries stops for many vendors
    WHEN 'RIDER'  THEN assigned_rider_id = melarc.current_rider_id()
    WHEN 'SYSTEM' THEN responsible_hub_id = melarc.outbox_hub_id()
                    AND melarc.outbox_task_permits('pickup_manifest')
    ELSE FALSE
  END
)
WITH CHECK ( /* the same expression */ );
```

**Hub equality is not a Rider boundary**. Two riders in one hub are two principals, and a model that starts from the hub makes Rider A's manifest reachable by Rider B until something else stops it. **`MSC-DEC-278`'s `AS RESTRICTIVE` guidance made the layering safe; it did not make it correct** — and safe-by-addition fails the day a restrictive policy is forgotten on one child table.

**Child rows inherit the assignment from the authoritative parent**, never from a hub:

```sql
WHEN 'RIDER' THEN EXISTS (
  SELECT 1 FROM pickup_manifest m
   WHERE m.id = pickup_stop.pickup_manifest_id
     AND m.assigned_rider_id = melarc.current_rider_id())
```

**`WITH CHECK` repeats the expression rather than omitting it.** `USING` bounds the rows a statement may *see*; `WITH CHECK` bounds the row it may *produce*. An `UPDATE` moving a row out of the actor's scope passes `USING` — it was in scope when read — and writes a record the actor can no longer see and never had authority over. An `INSERT` is not covered by `USING` at all.

**One `CASE` policy, or several policies whose branches are mutually exclusive on exact `principal_type`.** Either is permitted. **What is forbidden is an unconditional Hub policy whose result is then intersected with, or `OR`-ed against, another actor's model** — which is what R0 described, and why `AS RESTRICTIVE` no longer appears in this section as the primary mechanism.

**`ALL` is never inferred.** Not from an empty list, a missing context, a client request, a Vendor or Rider context, or a role or bundle **name**. `permissions.md` §5 makes Hub scope an attribute of the **grant**, and `Session.authorized_hub_ids` plus `Session.bundle_snapshot` are the only source. `SYSTEM` uses an explicit task capability, never a fabricated Staff `ALL`.

**Seeds and backfills are a `SYSTEM` task** (Product decision, 6 October 2026). They write forced-RLS tables as the `SYSTEM` principal under an **explicit seed task capability**, as a worker writes under its task capability (§14.17b): **each table's policy has a `SYSTEM` branch for it** beside the `Outbox`-derived one in the templates above, and **the policies keep deciding on the request context only** — no accessor is tied to the migration login, and the migration role holds no `BYPASSRLS`. The seed helper and each table's branch arrive with the first slice that has a table ([MIGRATION_AND_SEEDING.md](MIGRATION_AND_SEEDING.md) §5.1). **The initialization itself is the database's rule, not the helper's** (correction F02 of Stage 1): the provisioning identity holds no privilege on the seven reference tables and writes them only through two `SECURITY DEFINER` functions that only it may execute and the posture check names (`melarc.initialize_reference_data`, which fills the seven tables once, in one statement, serialized against any other, and refuses unless all seven are empty, and `melarc.add_reason_fixtures`, which writes `FIXTURE_` reason codes and nothing else), so after the initialization nothing it holds can append a permission to a bundle; a controlled change to a bundle after the seed is the primitive of `SLICE-009` (task S0.27). They run as the **provisioning identity** (§14.17) under the `seed` or `bootstrap` capability of [data-scope-registry.md](../contracts/data-scope-registry.md) §5.2 (Product decision, 8 October 2026): no API or worker configuration holds that identity's credential. For `seed` the grant layer is the barrier — the API runtime holds no DML grant on a table that only a seed writes, so asserting the label reaches nothing. For `bootstrap` the tables are ones the API also writes under its own operations, so the barrier is the policy: the `bootstrap` branch admits only the bootstrap shape (a `StaffIdentity` whose `created_by` and `approved_by` are the reserved system actor, and the grants and factors of those two identities) and the command itself refuses a non-empty staff table. Code running as the API could still assert the label, which is the accepted residual risk of §14.1.

**No policy names a database role.** The context already carries authoritative scope, and a role name in a policy would create a second, weaker authority model beside `permissions.md` §5 — one a `GRANT` could change with no decision recorded.

### 14.4a Fail-closed, restated for principals

Every one of these denies:

| Condition| Result|
|---|---|
| Missing `principal_type`| **Deny** — the `ELSE` arm|
| Unknown `principal_type`| **Deny**|
| **Missing or empty** principal id| **Deny** — `nullif(current_setting(…, true), '')` is NULL, and every comparison against NULL is not `TRUE`|
| **Malformed** principal id| **Never reaches a policy.** §14.1b rejects it at context establishment and no protected statement runs. Reached directly, the `::uuid` cast **raises** and the statement aborts — fail-closed by abort, **not** by NULL|
| Inconsistent principal-specific context| **Deny**|
| **Vendor identity with no Vendor row boundary**| **Deny**|
| **Rider identity with no required assignment**| **Deny**|
| **Staff Hub `SET` with no matching hub**| **Deny**|
| Empty Staff Hub set| **No Hub-scoped rows.** It never means all hubs|

**`NULL` comparisons carry the fail-closed property for free, and that is worth stating rather than relying on.** `vendor_organization_id = NULL` is `NULL`, which is not `TRUE`, so a Vendor context with no vendor id matches nothing. A predicate assembled in application code would have had to remember that; a predicate written in SQL cannot forget it.

**That property covers the *missing* case and not the *malformed* one, and this document asserted otherwise until C1.** The row above read *the `nullif(...)::uuid` cast yields NULL* — `nullif(x, '')` returns NULL when `x` **is the empty string**, and returns `x` unchanged otherwise. `nullif('not-a-uuid', '')::uuid` therefore casts `'not-a-uuid'` and PostgreSQL raises `invalid input syntax for type uuid`.

**Both outcomes deny, so the error was invisible in every result and wrong in every mechanism.** One is a false predicate inside a policy; the other is an aborted statement, on a different code path, with a different failure signature, and — as `MSC-DEC-275` already observed of `current_setting` without `missing_ok` — **an error is not a denial.** A test asserting *no rows returned* would have passed against an exception. §14.1b is the control that makes the malformed case unreachable from the application at all; the abort is the backstop behind it.

### 14.4b The scope probe — how an informative hub refusal coexists with row-level security

`MSC-DEC-432`. Row-level security hides every row a staff context may not see, so a read of an **existing** record outside the actor's hubs returns **nothing**, exactly as a read of an identifier that matches nothing does. The Product decision is that authenticated staff are told the difference, and **row-level security cannot tell it**. One narrow step does.

1. **A staff read or mutation by id that finds no row in scope is followed by one probe**, and **only a staff principal ever takes it.** A Vendor or Rider is answered `NOT_FOUND` at once, which is why their answer cannot differ from a nonexistent record's.
2. **The probe is a separate, short statement** — `SELECT id, responsible_hub_id FROM <entity> WHERE id = $1` — run under a transaction-local context value, `melarc.scope_probe_id`, set by the repository function `existingRecordHub(entity, id)` and by nothing else. **Every hub-scoped table has, beside its ordinary policy, a second policy `FOR SELECT`** that admits a staff context to the one record the setting names, generated by the policy template and never written by hand: `CREATE POLICY <table>_probe ON <table> FOR SELECT USING (melarc.principal_type() = 'STAFF' AND id = melarc.scope_probe_id())`. With no probe id the accessor is NULL and the policy admits nothing (§14.4a). **The predicate is in that policy and in no other.** PostgreSQL ORs the permissive policies that apply to a command, so a separate `FOR SELECT` policy widens a read and no other command; the same predicate ORed into the ordinary policy, which is `FOR ALL`, would decide which rows an `UPDATE` or a `DELETE` may touch (the old row passes `USING` through the probe, the new row passes `WITH CHECK` through the staff's own hub) and a record of another hub could be moved into one's own. `UPDATE`, `DELETE`, a locking read, an upsert and `INSERT` are therefore judged by the ordinary predicates alone, of the old row (`USING`) and of the new row (`WITH CHECK`). The migration lint and the catalogue check refuse the predicate in any policy that is not `FOR SELECT`.
   **The probe holds its transaction while it runs.** The record is readable to the probe's own statement only, so no other statement of the transaction runs between setting the value and clearing it, and a second probe may not start: a caller that overlaps them (`Promise.all`) is refused, not served, and the value is cleared on success and on failure.
3. **It names one id and reads two columns.** It cannot enumerate. Its result is used for one decision — a row that exists in a hub **outside the scope the operation runs under** is `HUB_SCOPE_VIOLATION`; no row, and a row in a hub the operation reaches that another restriction hides (its owner, for one), is `NOT_FOUND`, because the answer is informative on the hub axis only and an all-hub grant has no hub outside it — and **the probed row is never loaded, returned or logged.**
4. **List endpoints never probe.** A list is filtered silently, and says nothing about what it did not return.
5. **Nothing is added to the audit set.** `audit.md` defines no denied-access event for a hub refusal, and this section does not add one: the refusal is a request-log entry, never carrying the probed row. Which denials need an event is a coverage question the Product Owner approves.

**A test asserts all four properties:** the probe runs only for staff, only after a filtered read found nothing, never returns more than the hub id, and a Vendor or Rider reaching the same id gets the nonexistent answer byte for byte. **Tests under the runtime login assert the rest:** while the value is set, `UPDATE` (a move into the staff's own hub included), `DELETE` under a grant that permits it, `SELECT ... FOR UPDATE` and `ON CONFLICT DO UPDATE` find or change nothing of the probed record, and a read or a second probe that overlaps the probe is refused.

### 14.5 Derived scope metadata, and the constraint that keeps it true

`MSC-DEC-278`. An operational child that would otherwise be reached through a multi-hop join carries `responsible_hub_id` directly. [data-scope-registry.md](../contracts/data-scope-registry.md) §4.3 marks each one *(derived)*.

Two constraints make the copy safe, and **neither is optional**:

```sql
-- 1. the child's hub must be its parent's hub - a composite foreign key, not a comment
ALTER TABLE delivery_run  ADD CONSTRAINT delivery_run_id_hub UNIQUE (id, responsible_hub_id);
ALTER TABLE delivery_stop ADD CONSTRAINT delivery_stop_hub_matches_run
  FOREIGN KEY (delivery_run_id, responsible_hub_id)
  REFERENCES delivery_run (id, responsible_hub_id);

-- 2. it is set at creation and never again
CREATE TRIGGER delivery_stop_scope_immutable BEFORE UPDATE ON delivery_stop
  FOR EACH ROW WHEN (new.responsible_hub_id IS DISTINCT FROM old.responsible_hub_id)
  EXECUTE FUNCTION melarc.reject_scope_mutation();
```

For every derived column, document: **derivation source · creation-time population · immutability · consistency constraint · backfill expectation.** [data-scope-registry.md](../contracts/data-scope-registry.md) carries all five per table.

**Duplicated scope must never become a second mutable business truth**. Without the composite key it is a copy that can disagree with its parent, and a security decision taken on the copy then diverges from the one taken on the source. **Do not blindly add a Hub column to every table** — the registry marks the tables where a direct column earns its place, and `VendorStatement` is the standing example of one where a Hub column would be actively wrong (§5.2.5).

### 14.6 Database roles

`MSC-DEC-276`. §14.17 is the full set of technical identities, and no runtime role can bypass what protects it.

| Role| Login| Owns| DDL| Used by|
|---|---|---|---|---|
| `melarc_owner`| **`NOLOGIN`**| schemas and tables| —| nothing at runtime|
| `melarc_migration_elevated`| **deployment window only**| no| **approved migrations**| the deployment pipeline only — §14.17a|
| `melarc_api_runtime`| yes| no| **no**| HTTP/API|
| `melarc_worker_runtime`| yes| no| **no**| background workers|
| `melarc_scheduler_runtime`| yes| no| **no**| scheduled-work enqueue only|
| `melarc_outbox_relay_runtime`| yes| no| **no**| outbox relay only|

```sql
ALTER ROLE melarc_api_runtime    NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
ALTER ROLE melarc_worker_runtime NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

ALTER TABLE "order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order" FORCE  ROW LEVEL SECURITY;
```

**`ENABLE` alone exempts the table's owner.** A runtime connecting as the owner has RLS enabled on every table and is subject to none of it — the configuration inspects as correct and enforces nothing. Two independent controls close it: the runtime is not the owner, and `FORCE` removes the owner exemption even if that separation is later lost.

**No runtime role** may hold superuser, `BYPASSRLS`, table ownership, RLS-policy modification, schema modification, or role-grant authority. **`MIGRATION_AND_SEEDING.md` §5.1 carries the migration-time obligations** that keep this true as tables are added.

**R1 replaced `melarc_migrator` with `melarc_migration_elevated` and split the runtimes four ways**. The old name is not merely renamed: R0 claimed it performed ownership transfer *and* held no elevated capability, which cannot both be true. **§14.17 is the full set and §14.17a is why the old model was impossible.**

**What the API's posture check inspects** (Product decision, 8 October 2026). It runs as the actual runtime login and never as the owner, and it covers: superuser, `BYPASSRLS`, `CREATEDB`, `CREATEROLE`, replication; ownership of the database, of any schema and of any object — tables, views, sequences, indexes **and functions** — directly or through membership; **`CREATE` on the database or on any schema**, however granted, **including by a role it can switch into or inherit through memberships** (a membership granted `INHERIT FALSE, SET TRUE` gives none of the role's privileges as they stand and all of them after `SET ROLE`, so every role the login is a member of is inspected, directly or indirectly, whatever the options); membership of a `pg_*` predefined role, of the owning role or of any role holding one of these; any stored `melarc.*` setting on the role; and **`EXECUTE` on a `SECURITY DEFINER` function that an approved migration did not grant to it** (directly, through `PUBLIC`, or through a role it can switch into). A migration that creates or alters a role or grants a role to a role is flagged by the migration lint and reviewed. A `SECURITY DEFINER` function fixes its `search_path`, grants `EXECUTE` to named roles and never to `PUBLIC`, and accepts no argument that becomes SQL. **A fixed `search_path` is necessary and not sufficient:** before the first such function is introduced, its trusted schemas, its treatment of the temporary schema and its exact executable signature are validated, and the lint's checks of the first three are not that validation. Default privileges and `PUBLIC` grants are reviewed for future objects. The behavioural test is the proof — each attempt executes as the runtime login and must fail (§14.13) — and the catalogue check is the backstop.

**Resource deadlines** (Product decision, 8 October 2026). A finite deadline bounds every wait: pool acquisition, statement time, lock wait (inside statement time), idle-in-transaction time and total transaction time, with a bounded number of pool waiters and HTTP header and request deadlines. A connection whose state is uncertain after a timeout or a termination is discarded and never reused; cancelling the application's promise is not proof the database stopped. A commit that was in flight when the connection or the request's budget ended has an **unknown outcome**: it is reported as unknown, never as a rollback and never as safe to retry (S0.6 builds the rule for database work). **No provider or verifier call holds a transaction open** (§13.9a, §15.2.1). The values are engineering configuration validated at start (lock wait inside statement time inside transaction time) and set by the benchmark task on a recorded machine; production values need deployment-sized evidence.

### 14.7 Worker and non-human service authority

`MSC-DEC-279`. **A queue message is not authority.** The order of operations is the control:

```
1  receive broker message - the ONLY authority bootstrap it carries is outbox_id
2  BEGIN under the worker technical identity
3  read the TRUSTED Outbox row by outbox_id, via the narrow bootstrap capability
4  verify: exists - task type allowed for this worker - envelope executable - no incompatible prior run
5  establish TRANSACTION-LOCAL SYSTEM context FROM THE STORED ENVELOPE (its task class is the context's task_capability)
6  RELOAD the protected business aggregate UNDER RLS
7  compare the reloaded aggregate's authoritative scope against the IMMUTABLE envelope
8  mismatch -> no business side effect - abort - dead-letter/quarantine - security signal
9  matched  -> perform only the minimum task-authorised DML
10 COMMIT
11 transaction-local context disappears before the connection is reused
```

**Step 3 is the correction, and its position is the whole of it**. R0 required *establish scope, reload, compare* and left the scope being established **coming from the job payload** — so the payload selected the authority under which it was then validated, and **a forged or stale envelope validated itself**, because both sides of the comparison came from the same untrusted source.

**The envelope is written by the application inside the same business transaction as the mutation it describes**, carrying `outbox_id`, aggregate type and id, event/task type, authoritative `responsible_hub_id`, `vendor_organization_id` and rider/assignment id, originating principal, `operation_id`, correlation id, idempotency linkage, timestamp and the minimum payload. **Every scope field is derived from the authoritative row inside that transaction** and none is ever accepted from HTTP input, client payload, broker headers or worker payload.

**Immutable once committed:** aggregate identity · event/task identity · Hub, Vendor and Rider scope · originating authority · correlation and idempotency linkage. **The relay may update only its narrow delivery bookkeeping columns and may never rewrite the envelope.**

**The broker carries `outbox_id` and nothing authoritative.** Convenience metadata may ride along; it never establishes scope, never overrides the stored row, and is rejected or ignored when inconsistent.

**The bootstrap read is a technical capability, not business authority.** `Outbox` is a `SYSTEM` table whose business-principal branches are all `DENY`; the worker may fetch **one row by id**, and **no API operation exposes an arbitrary Outbox read**.

`BACKGROUND_JOBS_AND_EVENTS.md` §3.4 already required the re-check and named the hazard — *"a notification job that resolves its recipient from a stale payload can send one vendor's parcel details to another"*. This fixes the sequence that makes the re-check mean something.

**One worker does not start from the `Outbox`** (Product decision, 8 October 2026). The credential-delivery worker (§13.9a) claims `CredentialDeliveryJob` rows by lease. The job is a trusted technical record written by `platform/auth` inside the issuing transaction; it names no business aggregate, so there is no aggregate scope to verify against an envelope, and the payload rule above — no credentials in a payload — is the reason it is not an `Outbox` message. The worker runs as `melarc_worker_runtime` plus `melarc_worker_cap_credential_delivery` (§14.17b); its `SYSTEM` context carries the `credential_delivery` capability of [data-scope-registry.md](../contracts/data-scope-registry.md) §5.2, never scope taken from a broker message, and it claims jobs from its own table without reading any business table.

**Payloads carry no** customer addresses, OTPs, payment secrets, credentials or signed Evidence URLs unless the task cannot run without them.

**Technical capability sets, never `RoleBundle`s:**

| Identity| May|
|---|---|
| API runtime| Business DML under RLS. No DDL, no audit mutation|
| Worker| Task-required DML under RLS, outbox consume, audit **insert**|
| Scheduler| Enqueue only. No business DML|
| Outbox relay| Read and mark outbox rows. **No business DML at all**|
| Migration / deployment| Approved DDL. **No broad business-data read**|
| Backup / restore| The backup plane only (§14.11). No application database credential|
| Webhook / provider ingress| Write to a quarantined ingress surface; nothing downstream trusts it as authority|

**§11.1 makes a `RoleBundle` editable configuration.** Attaching one to the outbox relay would put the relay's authority one settings screen away from being the whole product. **`OQ-047`'s service-account half stays open** — the *product* question of integration permissions is untouched; this settles only that the answer is not a human bundle.

### 14.8 Browser origin, network and transport

`MSC-DEC-280`.

| Surface| Host| Browser API path|
|---|---|---|
| Ops Portal| `https://ops.<melarc-domain>/`| `https://ops.<melarc-domain>/api/...`|
| Vendor PWA| `https://vendor.<melarc-domain>/`| `https://vendor.<melarc-domain>/api/...`|

Both reverse-proxied to the backend. **No parent-domain authentication cookie.** The Gate A cookies stay **host-only** — no `Domain` attribute, which is what `contracts/openapi.yaml`'s `x-cookies` registry now states explicitly. Rider, native and provider traffic may use a dedicated API hostname.

**This is not a hardening preference. It is the topology in which Gate A's architecture is the architecture that runs.** `MSC-DEC-261` and `MSC-DEC-270` fixed `SameSite=Lax` cookies, a readable `melarc_csrf` echoed in `X-CSRF-Token`, and `Origin` validation. A browser surface calling a cross-origin API host would need **credentialed CORS** to send the cookie at all, `SameSite=Lax` would suppress it on exactly the cross-site requests the attribute exists to describe, and the deployment would then be pushed toward a parent-domain cookie — which hands the Ops Portal's session to the Vendor PWA's origin and back. **§37.3's three authentication models that never mix would then be enforced by application code alone.**

**Network:** public Internet reaches the managed edge only. PostgreSQL, broker, cache and internal workers take **no public ingress**. Object storage has public access **disabled**. Privileged internal services are not Internet-exposed. `DEPLOYMENT_AND_ENVIRONMENTS.md` §12 carries the trust zones.

**Transport:** TLS 1.3 preferred · TLS 1.2 for compatibility only · TLS 1.0/1.1 disabled · HTTPS everywhere · HSTS after domain and certificate validation.

**Browser headers:** strict allowed `Origin` list · **no wildcard credentialed CORS** · CSP · `frame-ancestors 'none'` unless specifically approved · `X-Content-Type-Options: nosniff` · restrictive Referrer Policy · **`Cache-Control: no-store` on every API response**, sent by the API itself as a platform rule and not as a per-operation contract detail · **exact `Origin` validation on browser-sensitive flows, pre-session endpoints included.**

**The login-CSRF threat model §13.12 deferred is answered by that last clause.** A session-fixation or login-CSRF attempt necessarily arrives at an endpoint where no session yet exists, which is precisely where a session-cookie-based defence has nothing to check.

### 14.9 Key, secret and credential custody

`MSC-DEC-281`. Managed secret store; managed KMS; **workload or federated identity** for production workloads where the platform supports it, rather than embedded long-lived cloud credentials.

| Material| Treatment| Why not the others|
|---|---|---|
| **TOTP seed**| **Encrypted** — authenticated envelope encryption; ciphertext plus key id, key version and nonce; KMS to decrypt; plaintext never persisted, never logged, never in audit or analytics| The server must **recompute** the expected code, so it cannot be hashed|
| **Password / PIN**| Argon2id **plus a versioned pepper held outside PostgreSQL**; the hash records `pepper_version`; successful authentication may rehash at the current version| Must **not** be recoverable, so it cannot be encrypted|
| **Session, `SetupGrant`, `RecoveryRequest`, CSRF, device secrets**| High-entropy random — **for a grant, a recovery token and a challenge, 32 random bytes from the platform's cryptographically secure generator, presented as 43 characters of unpadded base64url** — **cryptographic hash persisted**, never the value. **Two narrow, time-limited exceptions hold the raw value encrypted, never plain:** a delivery job's payload (§13.9a; in non-production the capture sink holds the message in clear by design) and the sealed fields of `registerRiderDevice`'s idempotent replay (§14.16)| Needs neither recovery nor brute-force hardening beyond its own entropy — **human-password cost buys nothing and is paid on every request**|
| **Provider secrets**| Managed secret store, service identity only, quarterly rotation and on suspected compromise (§9, `DEPLOYMENT_AND_ENVIRONMENTS.md` §5)| Never a business setting (§33.3, §35.9.4)|
| **Deployment credentials**| Short-lived federated/OIDC where supported (§14.11)| A long-lived pipeline key is a standing production credential|

**Purpose-separated keys** (Product decision, 8 October 2026). TOTP seeds (`totp_seed`), credential-delivery payloads (`credential_delivery`), idempotent-replay ciphertext (`idempotent_replay`), the limiter's key digests (`limiter_digest`) and the password pepper (`password_pepper`) each have their own key purpose, with their own version, access policy and rotation; no purpose's key decrypts or derives another's. An encrypted envelope is versioned and authenticates its purpose, principal, operation, record and envelope version as associated data. An old key version stays available only for the records it must decrypt or verify, and rotation and recovery are tested. Production rejects an absent key and any test adapter. Local uses explicit substitutes, and **environment variables alone are not presented as KMS-backed custody.**

**Why the pepper is versioned rather than simply rotated.** An unversioned pepper can be rotated exactly once, destructively: every hash computed under the old value becomes unverifiable the moment the new one is installed, and **every user in the product is locked out simultaneously, with no signal saying why.** `pepper_version` on the hash makes rotation additive — old hashes verify under their own version, and rehash-on-successful-authentication migrates the population without a flag day.

**The password hash has one reader, and the table does not let anyone else select it** (S0.24, migration `0016`; the audit of 11 October 2026). The API's runtime login holds `SELECT` on every column of `staff_identity` but `credential_hash`, so no statement under that login, in any context, a staff member reading their own row (which the policy admits) included, can name the hash or say `*` (the owner role and the migration login can read what they own: this is a boundary between application roles, not a claim about administrators); it holds `UPDATE` on the three credential columns, which is also what lets the identity lock be taken (a row lock needs `UPDATE` on at least one column). The `authentication` capability reads the hash through `melarc.staff_credential_hash(identity_id)`, a `SECURITY DEFINER` function that only the runtime may execute and that refuses every other context. That is the same trust as the row-level policies (a capability is a label that the application sets), now enforced by privilege for every context that is not the authentication one. A separate credential table, with its own policy and registry classification, would give the same property and leaves the identity row without a column the runtime may update for the lock; it is the owner's to prefer. **Which credential a sign-in verified** is told by a **generation**, not a moment: `credential_generation` is zero while there is none and rises by one whenever a credential is replaced (a setup, a recovery, a reset, a change) and does not move when the same credential is rehashed at a new cost; `credential_established_at` changes only with a new generation and may equal the previous one; a trigger holds those rules, and cannot tell a replacement from a rehash by the hash string, so the writers keep the two apart. A timestamp cannot do the job: a clock repeats and steps back, and a database timestamp read into a JavaScript date loses its microseconds.

**A suspected pepper compromise is a credential-security incident**, not a routine rotation. The pepper is what makes a stolen hash table useless; losing it retroactively weakens every credential ever hashed under it.

**The rider's private key exists only on the handset**, in Keystore-backed storage, and is never copied — `MSC-DEC-264`, and re-registration reuses the same protocol rather than moving a key (R1).

### 14.10 Evidence

`MSC-DEC-282`. Private by default; public access and listing **disabled**.

**Storage keys are opaque.** No customer name, phone number, Vendor name, address or other personal data in a key. **A key leaks wherever it is printed** — a log line, an error message, a bucket inventory, a support screenshot — without ever granting access to the object, and §38.2's *"never unnecessary personal data"* applies to identifiers as much as to payloads.

**Upload** is narrowly authorised, single-object scoped, time limited, size constrained and checksum constrained. Before `STORED`, the platform verifies **declared size · checksum · allowed MIME type · actual file signature · malicious-content validation appropriate to the supported types.** A mismatch leaves the record `PENDING_UPLOAD` and returns `VALIDATION_FAILED`, which is the behaviour `completeEvidenceUpload` already declares — Gate B widens what is verified, not what is returned.

**Retrieval requires Melarc authorization first**, in order: authentication → permission → Hub scope → Vendor ownership → `access_rule`. Only then may the platform stream the object or issue a **short-lived, single-object** retrieval authorization. **There are no permanent public Evidence URLs.** A signed URL is a temporary bearer capability: short lived, object specific, never permitting listing, **never logged**.

**`Evidence` carries `responsible_hub_id` and a nullable `vendor_organization_id`, added by `MSC-DEC-282`**, because §5.6's polymorphic owner *"cannot be constrained by foreign key"* — and a policy cannot follow `owner_type`/`owner_id` into eight parent tables. Without direct columns the only enforceable answer is application-level filtering, which `SOLUTION_ARCHITECTURE.md` §6 rejects by name.

**The retrieval operation is written** — `createEvidenceRetrievalAuthorization`, and §14.18a carries its check order. **`OQ-091` is narrowed to what R1 did not settle**: legal **retention** and the **deletion and archival** that depend on it. **The `Evidence` business state machine is neither signed nor redesigned; §17 remains unsigned**, and its security envelope may be hardened while it is.

### 14.11 Audit integrity, telemetry, backup and production access

**Integrity**. `AuditEvent` in PostgreSQL stays the searchable operational record. An independent layer sits above it:

```
AuditEvent / audit outbox  ->  periodic signed checkpoint  ->  immutable / WORM storage
```

A checkpoint carries canonical event identifiers and hashes, an ordered batch manifest, **the previous checkpoint's reference and hash**, and a KMS-backed signature or MAC. **Cut every 15 minutes** — `audit_integrity_checkpoint_interval_minutes`.

**`AuditIntegrityCheckpoint` is a persistent technical table, declared here for mechanical discovery**:

```
PERSISTENT-TECHNICAL-TABLE: AuditIntegrityCheckpoint
```

**The declaration lives at the architecture definition point, not in the Registry**, so contract-consistency validation reconciles three independent sets rather than asking the Registry to confirm itself. **The previous-checkpoint link is what makes deletion detectable** — per-event hashes detect a modified event; only a chained manifest detects one that is no longer there, or one that was never there and now sits in the middle of history.

**Append-only was never tamper evidence.** `SOLUTION_ARCHITECTURE.md` §8's table-permission enforcement is strong against the application and says nothing about a credential holder — and the audit log exists to describe the actions of trusted people. **A control administered by the party it constrains is not evidence.**

**The mechanism is tamper-evident, not tamper-proof.** It detects modification, deletion and insertion after the fact and proves the detection with a KMS signature. It does not prevent a sufficiently privileged infrastructure actor from destroying both stores. **No global synchronous hash lock** is imposed on business transactions — that would serialise the product on one lock against a threat with no evidence behind it, and §42.8's availability target is company-wide. Enhanced-audit actions requiring synchronous primary audit **fail closed** when the record cannot be durably written. The mirror may be asynchronous and **must be monitored**; its failure alerts (`OBSERVABILITY_AND_RECOVERY.md` §3). **The chain itself may be deferred during local feature development and not beyond production identity use**, with the writer preserving what it will need ([audit.md](../contracts/audit.md) §2.1, 8 October 2026).

**Telemetry separation.** Logs and traces are not the ledger. Central redaction covers `Authorization`, `Cookie`, `Set-Cookie`, `X-CSRF-Token`, passwords, PINs, TOTP values and seeds, `SetupGrant` and `RecoveryRequest` tokens, Vendor device credentials, Session credentials, signed Evidence URLs, provider secrets, and sensitive authentication, payment and evidence request bodies — across **application logs, worker logs, reverse-proxy logs, traces and APM, and exception reporting.** **Exception handlers leak more than ordinary logs**, because a stack frame carries the arguments an access log never sees, which is why §14.13 requires failure-path redaction tests and not only happy-path ones.

**Backup and production access**. The backup plane — snapshots, WAL/PITR archives, object versions — is encrypted, separately access-controlled, **unreachable with application credentials**, protected against accidental deletion, and restorable only through a controlled procedure. **Encryption at rest defends the medium and does nothing about an application credential that can delete snapshots**, and `DEPLOYMENT_AND_ENVIRONMENTS.md` §6 makes the WAL archive the actual recovery position.

**Restore drills: one full test before production launch, then quarterly**, in an isolated environment, never overwriting production. **No standing shared human production database credential.** Emergency infrastructure access is individually attributable, MFA protected, time bounded, reason bound and infrastructure audited. **CI/CD** uses short-lived federated identity where supported, with build, staging deploy, production deploy and migration separated — and **a migration identity does not thereby gain broad business-data read authority.**

### 14.12 Rate-limit buckets

`MSC-DEC-285`. Six buckets, each keyed on the credential-oriented identity `MSC-DEC-224` already fixed: **Staff sign-in** (normalized Staff identity) · **privileged MFA** (challenge/principal) · **Vendor sign-in** (account **and** registered device) · **Rider challenge/sign-in** (the submitted phone number) · **recovery** (recovery principal) · **authenticated API** (active Session).

The keys live at [settings.md](../contracts/settings.md) §7.7 and **every one carries a launch value**. `OQ-077` — *"how many buckets the limits need is a design choice rather than a value"* — was answered on 27 August, and **`OQ-067`, the figures, on 5 September.** Production readiness distinguishes *the bucket architecture exists* from *the launch values have been supplied*, and **both statements are now true** — which is why they closed nine days apart rather than together. **Post-launch telemetry recalibrates the values through controlled configuration and may not change the bucket architecture or move a bucket off its credential-oriented key.** **The credential setup operations that belong to no other bucket join the recovery bucket**, keyed by the grant or token a request presents — and `requestAdditionalDeviceGrant`, which presents neither, by the authenticated vendor account ([settings.md](../contracts/settings.md) §7.7) — and **a per-address ceiling at the edge** — infrastructure, not a seventh bucket — bounds the cost of the keys an attacker chooses ([DEPLOYMENT_AND_ENVIRONMENTS.md](DEPLOYMENT_AND_ENVIRONMENTS.md) §12.2).

**Where the state lives** (Product decision, 8 October 2026; rationale: [SLICE-000-FINAL-DECISIONS.md](../delivery/planning/SLICE-000-FINAL-DECISIONS.md) §10). The limiter sits behind a port with an **authoritative PostgreSQL implementation** for every integrated or deployed environment. A bounded in-memory adapter serves unit tests and local diagnostics only and is never deployment evidence: a per-process limiter resets on restart and multiplies each bucket by the number of running instances, and a rolling release runs two versions at once ([DEPLOYMENT_AND_ENVIRONMENTS.md](DEPLOYMENT_AND_ENVIRONMENTS.md) §7), so it cannot hold a bucket's meaning. No Redis or broker is added for it now.

- **The decision.** A bucket admits at most its configured number of requests in any rolling 60 seconds; a fixed window would admit a double burst at its boundary. Decisions for one key are serialised, taken on **database time** in a short transaction, and keep only the admitted timestamps the window needs. Consumption commits independently of any later authentication or business rollback, and a refused request does not extend a penalty.
- **The keys** are namespaced by bucket and purpose and formed with a **keyed digest** under the limiter's own key purpose (§14.9), so no identifier or token is stored or logged in clear. Rotating that key is a **staged protocol**, because a lock that two instances share proves that their decisions are ordered and not that each can count what the other wrote: (1) distribute the new version to every instance while the old stays active; (2) establish that every serving instance holds it; (3) switch the active version, from which time rows are written under the new one and every lookup counts the rows of every held version; (4) keep the old version held until the longest live window (60 seconds) has passed with nothing writing under it; (5) retire it. **What enforces the order, and what does not.** At run time the limiter refuses, failing closed, to decide while any live row is under a key version it does not hold (`LimiterKeyVersionError`, inside `LIMITER_STORE_UNAVAILABLE`; counted in `rate_limiter_key_incompatible_total`): an instance given the new version late, or one that retired the old version early, is excluded from admission, for every key, until it holds the version or the rows have left the window, and it writes nothing. The check is made twice in one admission: after the key locks, so that the count it decides on can be trusted, and **again under the capacity lock, immediately before the insert**, which is the one point every insert passes through and by which every earlier admission has committed and shows (the transaction reads committed rows afresh after waiting for the lock). Two instances whose version sets do not overlap (one holds only version 1, the other only version 2) share no key lock, so both can pass the first check on an empty table; the one that takes the capacity lock second then sees the other's row under a version it cannot count, refuses and writes nothing. At most one of them admits, and the other fails closed. Instances that hold a version in common still share one allowance (their key lock orders them and each counts the other's rows), and ordinary contention for the capacity is unchanged. The lock order is unchanged (the key locks in ascending order, the capacity lock last), so the second check adds no cycle. **What this proves:** an instance inserts a row only while it can count every live row in the table, so it never admits against a count it knows to be short. **What it does not prove:** that every serving instance holds the new version before any writes under it, nor anything about an instance it cannot see (one not yet started, or one running a release that predates the check, which does not take the capacity lock). **The deployment owes** step 2 and the retirement discipline of step 4: a release that rotates this key records, before step 3, the instances serving and the versions each holds, and a failure of the check stops the release at step 2 (the old version stays active); and it accepts that an instance excluded by the guard refuses every admission until it holds the version or the rows leave the window, which is the intended failure of a rolling release and an outage of that instance's admissions while it lasts. No platform check of the deployment exists, and none is claimed.
- **Capacity is bounded and never evicts a live penalty.** Key length, rows per key and total rows are bounded, and expired rows are removed by an indexed, bounded cleanup **owned by the limiter itself**: its adapter deletes a bounded batch of expired rows inside admission transactions under its own `rate_limit` capability (data-scope-registry §5.2), so no separate job or capability exists for it and an idle system holds only bounded, already-expired rows. The bound is **strict**: the table never holds more rows than its capacity, live or expired, whatever the number of instances and however many admissions for different keys are in flight, because every insert is made under one capacity lock, taken after the key locks and last, under which the admission removes a bounded batch of the oldest expired rows, counts every row and inserts. That is brief global coordination, stated plainly: admissions that write queue for that lock one at a time, for the length of a cleanup, a count, an insert and the commit; refusals at a bucket's ceiling write nothing and never wait for it. At capacity, **new admissions are refused uniformly** while existing limits stand, so an attacker cannot flush another caller's bucket by inventing keys. How the capacity is shared between buckets (a reserved share for each) is a product and capacity decision not made here. The database itself is protected before any per-identity row is written, by bounded local admission and the edge's per-source ceiling.
- **An unavailable store fails closed** for credential mutations, with the platform's generic operational answer (a `503` outside the operation contract, as §15.3 states for an unreachable database) and never a permissive in-memory fallback.
- **Proof.** Two API processes sharing the same buckets; persistence across a restart; the exact threshold under concurrent admission; expiry; a flood of distinct identifiers; capacity exhaustion; store outage; key rotation; and no counter increment on overload. If measured contention is unacceptable, a replacement behind the port with identical semantics is proposed before capacity is raised. Allowance is never quietly sharded by instance.
- **Six product buckets, and they stay six.** The transport ceilings of `DEPLOYMENT_AND_ENVIRONMENTS.md` §12.5, the hash admission of §13.4c and the edge ceiling are separate engineering admission controls: they are not product permissions, not settings keys and not a seventh bucket.

**`RateLimitAdmission` is a persistent technical table, declared here for mechanical discovery** (the pattern of §14.11):

```
PERSISTENT-TECHNICAL-TABLE: RateLimitAdmission
```

### 14.16 Idempotency identity is principal-scoped

`MSC-DEC-288`. The uniqueness boundary is:

```
principal_type + principal_id + operation_id + idempotency_key
```

with `payload_hash` evaluated **inside** that identity, enforced by the equivalent database unique constraint.

| Case| Behaviour|
|---|---|
| Same principal · operation · key · **same** payload hash| Replay the original result|
| Same principal · operation · key · **different** payload hash| `IDEMPOTENCY_KEY_CONFLICT`|
| **Different principal**, same text key| Independent namespace|
| Same principal, **different operation**, same text key| Independent namespace|

A SYSTEM task principal carries a **stable, non-null** technical or task authority identity — never null, never a global wildcard, never one universal worker identity under which unrelated jobs collide.

**A command in progress under its key: what is built, what a caller observes, and what is decided** (G2 correction, 11 October 2026; decided by the owner on 12 October 2026; plan obligation OB-100). The store gives a command three steps in **one transaction of the caller's**: `begin` (insert the record `IN_PROGRESS`, or find it), the business effect, and `complete` (write the status and the body, byte for byte). The record becomes visible to anyone else **only at commit, and then already `COMPLETED` with its answer**; if the transaction rolls back, the record goes with it and the next attempt owns the command. So a correctly assembled command leaves no committed `IN_PROGRESS` record, and *abandonment* is not a state the store can produce: it has no timeout, no heartbeat and no lease because it needs none. **What a legitimate concurrent caller observes**: a second request with the same key and the same request that arrives while the first transaction is open does not see `IN_PROGRESS` at all. Its `begin` waits on the unique index until the first transaction ends, then finds the saved answer (a replay) or, if the first rolled back, owns the command itself; the wait is bounded by the request's execution budget and by the server's lock time, and a request that runs out of time is answered as any operational timeout. A changed request under the key is `IDEMPOTENCY_KEY_CONFLICT` in either state. **When `IN_PROGRESS` can be reported**: only for a record that was committed without its `complete`, which is a defect of whoever assembled the command (a `begin` and its effect in different transactions, or a path that commits after `begin` and returns early). The store cannot prevent that commit; the pipeline must make `begin`, the handler and `complete` one unit of work, with every early return rolling it back, and a test must prove it (the idempotency stage is the S0.26 fixture operation's: S0.20 to S0.24 build no operation and no stage that could run a command, and S0.20 supplies `fingerprintOfRequest`, which cannot forget the path parameters). A record stranded that way answers every request under its key with the code-less `500` described below and changes nothing, and **nothing reclaims it automatically** (decided 12 October 2026): a person resolves it, and which identity may delete such a record, and the procedure, remain the open OB-113 and OB-114 (plan section 7.14; no identity holds `DELETE` on the table). **Decided (the owner, 12 October 2026; OB-100):** a committed, stranded `IN_PROGRESS` record is an internal invariant failure, and the pipeline answers it with the platform's existing fixed code-less `500` and the request id, with nothing changed. **No contract error code is added** (`errors-and-enums.md` has none, and `STATE_CONFLICT`, the nearest, would mislead a client that can safely retry). The answer is for that case **only**: a duplicate that waits on a first command that has begun and not ended is not that failure, and one that runs out of time is answered as any operational timeout. An `IN_PROGRESS` outcome is never answered as a success or as a replay.

**One operation replays a secret, and only one** (Product decision, 8 October 2026; [SLICE-000-FINAL-DECISIONS.md](../delivery/planning/SLICE-000-FINAL-DECISIONS.md) §5). `registerRiderDevice` takes an `Idempotency-Key` and its response carries the one-time enrolment payload (the grant token and the attestation challenge). An ordinary replay returns the original response, which here would need the raw secret the hash-only rule forbids storing. The exception is therefore explicit and bounded: only those response fields are stored **sealed** — authenticated encryption under the `idempotent_replay` key purpose (§14.9), with principal, operation, record and envelope version as associated data — and the rest of the original response is stored as for any operation.

| Situation| Result|
|---|---|
| Same principal · operation · key · fingerprint, and the grant is still usable| Replay the original response, secret fields included|
| Same key, changed request| `409` `IDEMPOTENCY_KEY_CONFLICT`|
| The grant is expired, consumed, superseded or revoked| `409` `STATE_CONFLICT`; **no secret is disclosed and nothing executes again**|
| The caller has lost authority| The current authentication or authorization refusal, **before** any replay|
| Another principal or operation| A separate namespace: another caller's response is never disclosed|

The disclosure window ends at the **earliest** of grant expiry, consumption, supersession and revocation. **The transaction that consumes, supersedes or revokes the grant erases the sealed fields in the same commit** (it holds the `authentication` capability, [data-scope-registry.md](../contracts/data-scope-registry.md) §5.2), a durable cleanup task is the backstop for expiry, and expiry is also enforced on every read so that a delayed cleanup never extends the window. The record's fingerprint and result references and a *replay unavailable* tombstone stay for the ordinary `idempotency_record_ttl_hours`, so the command never executes twice inside that lifetime; after it, no replay guarantee exists and the ordinary state guards apply. The original business response is stable; request-correlation headers describe the current request. A client never retries an uncertain mutation under a fresh key. Ciphertext erasure from a live row does not erase backups or the write-ahead log.

**R0's defect was a disclosure channel, not a collision.** `Idempotency-Key: retry-1` is an ordinary string, and two vendors choosing it on one operation is what two independent clients *do*. Under a global key the second caller did not receive an error — the record existed, so it received a **replay of the first caller's stored result.** One vendor's response body returned to another, through the mechanism that exists to make retries safe. **`payload_hash` did not save it**: two vendors booking the same shape of request produce the same hash, which reads as *the same call*.

### 14.17 Technical identities, and the migration authority R0 could not describe

`MSC-DEC-289`. These identities are separated **enforceably at the database and infrastructure boundary** rather than by documentation.

| Identity| May| May not|
|---|---|---|
| `melarc_owner`| Own schemas and tables. **`NOLOGIN`**| Ever be a runtime, relay, scheduler or standing human login|
| `melarc_api_runtime`| Application DML under RLS · own-principal idempotency rows · `Outbox` `INSERT` inside an authorised business transaction| DDL · alter policy · own tables · `BYPASSRLS` · grant roles · assume migration or owner authority · mutate audit history|
| `melarc_worker_runtime`| Bootstrap read of the `Outbox` envelope **for an assigned task class** · envelope-derived SYSTEM context · task-required DML · task-required audit writes| **Any default all-business-table read** · unrelated tables · role alteration · DDL|
| `melarc_scheduler_runtime`| Enqueue the minimum scheduled-work intent| Generic business-table DML|
| `melarc_outbox_relay_runtime`| Read relayable `Outbox` rows · publish · update narrow relay bookkeeping columns| Read arbitrary business tables · mutate aggregates · **rewrite envelope authority**|
| `melarc_migration_elevated`| Approved DDL, schema, ownership and RLS operations| Be reused as **any** runtime identity|
| `melarc_provisioning`| Run the approved seed and bootstrap procedures as `SYSTEM` under the `seed` and `bootstrap` capabilities ([data-scope-registry.md](../contracts/data-scope-registry.md) §5.2); the provisioning tool that runs as this identity also hands bootstrap custody material to the controlled provisioning channel| Appear in the API's, a worker's or any request path's configuration · run DDL · be the migration identity · be a standing human login|
| Backup / restore plane| Backup and restore only| Be an application database login|

```sql
ALTER ROLE melarc_api_runtime       NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
ALTER ROLE melarc_worker_runtime    NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
ALTER ROLE melarc_scheduler_runtime NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
ALTER ROLE melarc_outbox_relay_runtime NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
ALTER ROLE melarc_provisioning      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
```

**There is no default *the worker may read all business tables* capability**, and §14.17b is what makes that enforceable rather than aspirational. A single broad worker read is the same shape of defect as a single broad Hub policy: correct for the common case and unbounded for the rest.

#### 14.17b Worker task capabilities

**`melarc_worker_runtime` is a base identity holding no protected-business-table grant.** Task capability is a separate grant set — a PostgreSQL child role, `melarc_worker_cap_<task>` — and a worker process runs as the base identity **plus exactly the capabilities its task class requires**.

| Capability| Documented task| Reads| Writes|
|---|---|---|---|
| `melarc_worker_cap_notification`| `notify_rider_run_dispatched` · `notify_vendor_milestone` · `send_recipient_otp`| `Order` · `DeliveryRun` · `DeliveryStop` · `RiderIdentity` · `VendorOrganization` · `Notification`| `Notification`|
| `melarc_worker_cap_pickup_backstop`| `sweep_failure_backstop`| `PickupRequest` · `PickupManifest` · `PickupStop` · `CollectionRecord`| the same four|
| `melarc_worker_cap_settlement`| `issue_vendor_statements` · `transition_overdue_statements`| `Order` · `Payment` · `VendorOrganization` · `VendorAccountAllowance` · `VendorSuspensionHold` · `VendorBalance` · `VendorStatement` · `StatementLine` · `Adjustment`| `Order` · `VendorBalance` · `VendorStatement` · `StatementLine`|
| `melarc_worker_cap_session_maintenance`| `expire_sessions`| `Session`| `Session`|
| `melarc_worker_cap_fleet_compliance`| `alert_compliance_expiry`| `Motorcycle` · `MotorcycleAssignment` · `MaintenanceScheduleItem` · `MotorcycleComplianceRecord`| `MaintenanceScheduleItem` · `MotorcycleComplianceRecord`|
| `melarc_worker_cap_recipient_confirmation`| Confirmation attempt escalation (§36.8)| `Order` · `DeliveryStop` · `DeliveryAttempt` · `RecipientConfirmation`| `DeliveryStop` · `DeliveryAttempt` · `RecipientConfirmation`|
| `melarc_worker_cap_payment_reconciliation`| **Resolves unknown and long-pending collections** — re-reads the attempt, queries the provider where supported, applies an **idempotent** transition. **It may never fabricate success**: where provider truth stays unknown, the attempt stays unknown| `PaymentAttempt` · `Order`| `PaymentAttempt`|
| `melarc_worker_cap_cash_reconciliation`| Reconciliation reminder — **cutoff 18:00 `Africa/Accra`**, per hub| `RiderCashCustody` · `CashHandover` · `CashReconciliation`| `RiderCashCustody` · `CashReconciliation`|
| `melarc_worker_cap_evidence_validation`| Evidence completion validation (§14.18)| `Evidence`| `Evidence`|
| `melarc_worker_cap_audit_integrity`| Integrity checkpoint (§14.11)| `AuditEvent` · `AuditIntegrityCheckpoint`| `AuditIntegrityCheckpoint` **`INSERT` only**|
| `melarc_worker_cap_credential_delivery`| `deliver_credential_message` (§13.9a) · `erase_expired_credential_material`| `CredentialDeliveryJob` · `SetupGrant` and `RecoveryRequest` (state and expiry only, never the hash) · `IdempotencyRecord` (the sealed columns only)| `CredentialDeliveryJob` · `IdempotencyRecord` (**erasing the sealed columns only**)|

**Every capability exists because a documented job needs it** — the list is `BACKGROUND_JOBS_AND_EVENTS.md` §4 and §3.5 plus the technical tasks R1 and the credential-delivery decision define. **No speculative role is created for work nobody has specified.**

**The base identity keeps only what is not a business grant:** `Setting`, `ReasonCode`, `CourierProvider` and `HubSetting` (**configuration**), the `Outbox` bootstrap row fetched by id, the `IdempotencyRecord` a principal already owns, and `AuditEvent` **`INSERT`**.

**This is what makes *unrelated to its task class* decidable.** R1 stated the rule and defined one worker identity, so the security matrix asserted a denial nothing could test: with a single generic grant, **every** table is related. A capability that names its tables makes the complement of that set the answer.

**These are database grants, never Product `RoleBundle`s**. `OQ-047` stays open.

**The relay is the sharpest separation.** It touches every business transaction by design and holds **no business DML at all** — read relayable rows, publish, mark. A relay that could write a business aggregate would be the widest authority in the product.

#### 14.17a The migration model R0 documented was impossible

R0 said `melarc_migrator` performs `ALTER TABLE ... OWNER TO`, enables and forces RLS and creates protected tables — **and simultaneously held no elevated capability.** Both cannot be true. **An identity that can transfer ownership and alter policies *is* privileged**, and describing it otherwise does not constrain it; it only stops anyone constraining it deliberately.

**R1 names it and bounds it by lifetime instead of by denial.** `melarc_migration_elevated`:

- performs exactly the DDL, schema, ownership and RLS operations an approved migration requires;
- **transfers ownership to `melarc_owner`**, which remains `NOLOGIN`;
- is **never** the API runtime, a worker, the scheduler or the relay;
- has **no standing shared human password**;
- is obtained through the **deployment workload identity**;
- is **infrastructure-audited**;
- has usable credentials **only for the deployment window**, and they are withdrawn, expired or made unusable when the migration finishes.

**The boundary that matters is not *can it do this* but *can it still do this tomorrow*.** A privileged identity that exists for eleven minutes under an audited workload identity is a materially different risk from the same privileges sitting in a runtime's connection string — and R0's phrasing, by denying the privilege existed, prevented anyone from bounding it that way.

### 14.18 Evidence — owner-aware scope, and authorization-private storage

`MSC-DEC-291`.

| Owner| `responsible_hub_id`| `vendor_organization_id`| Boundary|
|---|---|---|---|
| `VENDOR_ORGANIZATION`| **NULL**| **required**| Vendor ownership alone|
| Hub-scoped operational record| **required**, derived from the owner| derived where the owner is vendor-owned| Hub, plus Vendor where applicable|

**Neither field is client-settable**; both stay server-derived. A vendor-organization owner carrying a hub, or a hub-scoped owner carrying none, is **invalid** — not a default to fill in.

**R0 required every Evidence row to carry a hub, and for this owner there is none.** A vendor's business-verification document belongs to the vendor, not to a depot. The rule forced an implementer to **invent** one, and **an invented hub is a real access grant**: whichever hub was chosen, its staff could read the object and the vendor's other hubs could not. A Staff hub set must never convert a globally vendor-owned object into a hub-global one.

#### 14.18a Private means authorization-private, not network-unreachable

The object store has **no** anonymous reads or writes · **no** public bucket or object ACL · **no** unauthenticated listing · **no** public browsing · **no** permanent public URL · and **no** signed authorization able to enumerate a second object.

**The endpoint may be Internet-reachable for a cryptographically valid, short-lived, single-object signed operation.** That is what makes a presigned URL work at all; what makes it safe is that the platform issued it after checking permission, and it grants exactly one object for a few minutes.

**R0 called the storage private and then described signed direct operations against it** — read literally, forbidding the mechanism it specified. The distinction above is the one that was missing.

**Upload** issues the capability only after authentication, the existing Product permission check, principal-specific RLS and Evidence ownership validation. The object stays **private/quarantine** until completion validation passes — expected size · checksum · declared MIME · **actual file signature** · malicious-content validation · object identity — and only then does the existing lifecycle proceed to `STORED`. **The Evidence state machine is untouched and §17 remains unsigned.**

**Retrieval** is `createEvidenceRetrievalAuthorization`: authenticate → verify the caller's existing permission to read the underlying subject → principal-specific RLS → `access_rule` → confirm `STORED` → issue a short-lived single-object capability. **No state transition.** No storage credential, no listing authority, no usable `storage_ref`, no permanent URL, `Cache-Control: no-store`, and **never logged**.

**No new Evidence permission was created.** §11.6's domain list is closed and evidence is always captured in the course of another act, so authorization is that act's authorization — `x-permission: owner`, exactly as `createEvidence` already is.

### 14.19 Encryption at rest

`MSC-DEC-292`. **Provider or storage-level encryption at rest is required** for: the live PostgreSQL primary and its storage · replicas where used · **WAL** · **PITR material** · database snapshots · database backups · Evidence object storage · **Evidence quarantine objects** · Evidence object versions where applicable · object-storage snapshots and backups · **every backup-plane copy**.

**Application-level KMS encryption remains and is not replaced by it.** TOTP seeds stay application-encrypted under an envelope key because the server must **recompute** the expected code (§14.9); a storage-level guarantee protects the medium and gives the application nothing to decrypt with.

**The two layers answer different threats and neither substitutes for the other.** Storage encryption defends a stolen disk or a mishandled snapshot. Application KMS encryption defends a **readable database** — and a TOTP seed sitting in plaintext inside an encrypted volume is plaintext to everything that can issue a query.

**Customer-managed per-row keys for ordinary business rows are explicitly not a V1 requirement**, and this document makes no such claim. Backup-material key and access separation follows §14.11: **the backup plane's keys are not reachable with application credentials.**

### 14.20 Global Vendor master, Hub-local operational history

`MSC-DEC-295`. `VendorOrganization` is **globally identifiable**; authorised Ops may look the master up when operationally necessary. **That is not a grant to global operational history.**

| Actor| May see|
|---|---|
| Hub Ops / Senior Ops| Vendor operational history **only** for their authorised hub set, or all hubs where they explicitly hold that authority|
| Platform Admin| Approved global scope|
| Finance| Its **existing** globally authorised financial and reconciliation read scope. **No new write or administration capability**|
| The Vendor| Its own records **across hubs**, where an existing Vendor permission already permits the read|

**A Senior Ops user in Hub A does not acquire Hub B history by first loading the master.** The master lookup and the operational read are separate policy evaluations against separate tables, which is precisely what §14.4's per-principal branches make expressible: `VendorOrganization` carries a `global` Staff branch, and `Order`, `PickupRequest` and the rest keep `hub∈SET/ALL`.

**`VendorStatement` stays Vendor-global and gains no hub column.** §5.2.5 issues one statement per vendor across all hubs, so a hub filter there would not leak — it would **under-bill**. Hub staff needing operational financial information receive **Hub-filtered projections of the operational rows**.

**Finance is named to stop it drifting.** It appears here because it already holds global financial read authority; this confirms that and grants nothing further, so that *Finance is global* does not later become an argument for Finance administration.

#### Global identification is not global administration

`MSC-DEC-295`, applied to the records rather than to the master alone. **A globally identifiable master does not make every record hanging off it global.**

| Record| Staff reach| Required authority|
|---|---|---|
| `VendorOrganization`, `VendorPickupLocation`| **Global master identity** — identify the organization, locate the right vendor, associate a booking| `vendor.read`, at any grant scope|
| `VendorAccount`| **A global master record, read within the caller's grant** — a vendor has one account whichever hub serves it, but the two authentication-readiness reads reach only accounts whose `VendorOrganization`'s responsible hub is in the caller's grant| `vendor.read`, at the grant the caller holds: **own hubs, or every hub only where the grant reaches every hub**|
| `VendorAccountAllowance`, `VendorSuspensionHold`, `SecurityRiskHold`| **Not ordinary Hub staff.** The canonical control record — grounds, actor, disposition, affected work items| `vendor.read` held with **all-Hub** grant scope|
| `VendorBalance`, `VendorStatement`, `StatementLine`, `Adjustment`| Global-authority financial resources, unchanged| `settlement.read` held with **all-Hub** grant scope — Finance and Platform Admin|
| Any of the above, to the Vendor itself| Its own records across hubs, where a Vendor permission already permits it| Existing Vendor read keys|

**The authentication-readiness reads are master-record reads, scoped to the caller** (Gate PD-3R1, `MSC-DEC-436`; scope corrected at Gate PD-3R3, `MSC-DEC-442`). `getVendorAccount` and `listVendorAccounts` return a vendor account's authentication-readiness projection — whether a secret and a recovery email or phone exist, and the account's browsers — to a `vendor.read` holder **only within that holder's grant**: hub staff read an account where its `VendorOrganization`'s responsible hub is one of theirs, and Platform Admin and Finance read across hubs only where their grant reaches every hub (`hub∈SET/ALL`, resolved per operation as §14.1a says). **An existing account outside the caller's hubs is `HUB_SCOPE_VIOLATION`, and one that does not exist is `NOT_FOUND`** — staff are told which. The account stays a **global master record**: what narrows is the read, not the record. **The projection is derived by `platform/auth` in its own technical context and returns existence booleans, counts and the browsers' own history, never the credential, a hash or an address**; the Staff principal receives **no `SELECT` on `VendorCredential`**, which `data-scope-registry.md` keeps `DENY`. **The mechanism is the two operations' own**: the handler loads the master row and compares the linked organisation's `responsible_hub_id` with the hubs the authorising `vendor.read` grant reaches (§14.1a). `VendorAccount` has no hub column, so the §14.4b probe does not apply — and, as §14.4b says, a list never probes — and whether a Staff row-level rule through `VendorOrganization` should also exist is the Backend Engineer's. `reissueVendorCredentialSetup` acts at the vendor's own hub, and `recoverVendorCredential` is Platform Admin at all hubs.

**§36.12 is why this costs Hub Ops nothing operationally.** `VendorOrganization` carries its **own** lifecycle — `CREATED_BY_OPS` · `PENDING_SENIOR_OPS_REVIEW` · `ACTIVE` · `REJECTED` · `SUSPENDED` · `TERMINATED` — and `VendorAccountAllowance` carries `DISABLED_PREPAYMENT_ONLY` · `ENABLED`. **The operational yes/no a booking flow needs is a state on a record Hub staff already read.** What C1 withholds is the *canonical control record behind that state*: who imposed it, on what grounds, over which parcels, with what disposition.

**§35.12.8 requires the four vendor conditions to stay distinct** — operational suspension, `OVERDUE` financial status, allowance disablement and security/risk holds — and that is exactly what makes the split possible. Because they were never one flag, restricting the security record does not remove the operational signal.

**The write authorities were already narrower than the reads.** `vendor.allowance.enable` / `.disable` is **Platform Admin only at all hubs** (§35.12.3); `vendor.held_parcel.escalate` is **Platform Admin only**. A record that only a Platform Admin may change, readable in full by every hub's Ops staff, is an asymmetry with nothing behind it — and a `SecurityRiskHold` is precisely the record whose subject and grounds are least appropriate to broadcast.

**What C1 does not settle.** §35.12.8's conditions are modelled at summary level; field detail is Phase 4 (`domain-model.md` §7). Where a Hub workflow needs a **projection** of a restricted control record rather than the record itself, **the projection is `VendorOperationalEligibility`** (`MSC-DEC-339`; `OQ-105` closed on 29 August 2026), which this document does not redefine.


### 14.13 The negative tests Gate B requires

§37.6 already makes negative-access tests mandatory at five surfaces (§7). Gate B adds the layers beneath them, and [security-test-matrix.md](../standards/security-test-matrix.md) is the canonical enumeration. The families that cannot be satisfied by an ordinary integration test:

- **Pooled connections** — four cases, each **forcing reuse of the same physical connection**: Hub A then Hub B; Hub A then a request with no context; an all-Hub request then an ordinary one; and a rolled-back transaction followed by a reuse. A test on a fresh connection proves nothing here.
- **Database privilege** — **every runtime identity** (`melarc_api_runtime`, `melarc_worker_runtime`, `melarc_scheduler_runtime`, `melarc_outbox_relay_runtime`) must **fail** when it attempts `BYPASSRLS`, ownership, policy alteration, RLS disablement, DDL on a protected table, self-granting a role, **`CREATE` on a schema or the database, owning a function or a schema, executing a `SECURITY DEFINER` function it was not granted, or assuming `melarc_migration_elevated` or `melarc_owner`**. **Assert the refusal, not the configuration.**
- **Capability and deadlines** — a `SYSTEM` context that asserts a capability its identity was not granted reaches no row; a policy branch that tests `SYSTEM` alone is a defect the policy review refuses; and a statement, a lock wait, an idle transaction and a whole transaction each end at their deadline and leave no usable connection state.
- **Worker isolation** — envelope/object mismatch across Hub and Vendor, missing worker scope, a forged payload scope, all-Hub attempted by a task class not approved for it, and the outbox relay attempting business DML.
- **Failure-path redaction** — every secret category, exercised through an **error** path as well as a success path.

### 14.14 Environment rules

`DEPLOYMENT_AND_ENVIRONMENTS.md` §3 defines three environments; Gate B constrains what each may relax.

| Environment| Rule|
|---|---|
| **Local**| May use simplified infrastructure, but tests must preserve the **logical** security boundaries — RLS policies, role separation and scope classes are exercised, not stubbed|
| **Staging**| Exercises **real** RLS policies, real DB-role separation, and representative cloud security controls where feasible — and, for release proof, **production-like secret custody**: purpose-separated, versioned keys with a rotation rehearsal, not keys held in environment variables alone|
| **Production**| **No "development mode" bypass** of RLS, authentication, KMS-backed secrets, private storage, TLS or audit controls|

**Application startup fails when required production security configuration is missing.** A product that boots degraded is a product that runs degraded, and the condition §33.3 already applies to a missing hub setting — *fail visibly* — applies with more force to a missing KMS key than to a missing fee.

### 14.15 What Gate B does not settle

| Item| Owner|
|---|---|
| ~~Rate-limit **figures**~~| **CLOSED 5 September 2026, `MSC-DEC-371`** — the six buckets carry launch values; keys and credential keying unchanged|
| ~~Evidence signed-URL lifetime~~| **Settled**: upload **15 minutes**, retrieval **5 minutes**. One key could not have carried both, so the ambiguous R0 key was retired. **`OQ-102` closed**|
| ~~Audit checkpoint interval~~| **Settled at 15 minutes**. **`OQ-103` closed**|
| ~~Evidence retrieval operation~~| **Written** — `createEvidenceRetrievalAuthorization`|
| Evidence **retention, deletion and archival**| `OQ-091` narrowed to this, and it waits on `OQ-028` legal retention|
| Legal retention periods| `OQ-028` — unchanged by Gate B|
| ~~Alert thresholds, load volumes, performance percentiles~~| **CLOSED 5 September 2026** — cadence `MSC-DEC-284`, percentile and volumes `MSC-DEC-369`, thresholds `MSC-DEC-370`. `OQ-095` closed in full|
| Service-account and integration **permissions**| `OQ-047` — Gate B rules out a human `RoleBundle` and nothing more|
| `Evidence` §17 signature| **Product Owner. Not Gate B**|

**Two of these were values Gate B R0 deliberately declined to invent, and R1 supplied them** — `MSC-DEC-297`. The R0 refusal was right: the approved answer was **not** the one a default would have produced. *One* signed-URL lifetime was the wrong shape of question, because an upload redeemed by a rider on an unreliable link and a retrieval redeemed immediately by an authorised viewer are different exposures — **15 and 5**, not one figure. And the checkpoint is **15 minutes**, not the hour that reads as natural.

**What is still not chosen is still not chosen.** Retention remains `OQ-028` and is not filled here. **Rate-limit figures are no longer among them** — `MSC-DEC-371` supplied all six on 5 September and closed `OQ-067`.

## 12. Related

- **Contracts implemented:** [permissions.md](../contracts/permissions.md) · [audit.md](../contracts/audit.md) · [errors-and-enums.md](../contracts/errors-and-enums.md) · [data-scope-registry.md](../contracts/data-scope-registry.md)
- **Slice:** `SLICE-000` in [IMPLEMENTATION_PLAN.md](../delivery/IMPLEMENTATION_PLAN.md)
- **Companion:** [SOLUTION_ARCHITECTURE.md](SOLUTION_ARCHITECTURE.md), written 20 August
- **Owed alongside:** the four remaining artifacts §42.7 requires — deployment and environment, background-job and event design, observability, and backup and recovery
- **Gate B tests:** [security-test-matrix.md](../standards/security-test-matrix.md)

---

## 15. Threat model, attack surface, and operational security controls

*Added 13 September 2026 — CRIT-11, HIGH-01, HIGH-02 audit remediation.*

### 15.1 STRIDE threat model — summary

For each STRIDE category: threat identified → system boundary → controls in place → residual risk or open item.

| Category| Key threats identified| Primary controls| Residual risk / open item|
|---|---|---|---|
| **Spoofing**| Rider impersonation by presenting a copied handset string (the retired `device_identifier`); vendor credential shared-secret theft; OTP interception via reassigned phone number| Challenge-response keypair in Android secure hardware (non-exportable, §13.6); device credential `HttpOnly` cookie (vendor); anti-enumeration responses (§37.7); OTP TTL + attempt cap| Phone reassignment: secondary verification policy adopted (recipient-channel.md §5); attestation is as of enrolment, so a handset compromised afterwards is bounded by the device-bound key, the PIN, attempt limits, revocation and the recorded root signal (§15.2)|
| **Tampering**| Audit log modification; in-transit payload modification; manipulated collection count| KMS-signed append-only audit checkpoint chain (§14.11, `MSC-DEC-283`); TLS everywhere; server-side count and idempotency validation| None identified beyond ongoing operational monitoring|
| **Repudiation**| Vendor denying booking action (shared credential); rider denying cash custody| Audit log with actor snapshot (vendor account id, never a person); `auth.session.superseded` event on displacement; `payment.cash.custody_accepted` event| Shared vendor credential means person-level attribution is architecturally unavailable (§37.5) — accepted design decision|
| **Information Disclosure**| API enumeration of rider/vendor existence; PII in logs; session token leakage; Hubtel credentials in client code| Anti-enumeration posture (§37.7) — all auth endpoints respond identically to unknown and known principals; PII never-log list (audit.md §9); `HttpOnly` session cookie; Hubtel credentials server-side only (SECURITY_DESIGN §1a)| Evidence signed-URL retention: OQ-028 and OQ-091|
| **Denial of Service**| SMS fallback rate exhaustion; unbounded list endpoints; brute-force lockout evasion| Per-credential rate limits (six buckets, `MSC-DEC-285`, `MSC-DEC-371`); attempt caps with lockout; SMS fallback rate limit added (pickup-collection.md §5.2, `sms_fallback_max_per_pickup`)| **Closed by `MSC-DEC-386`, 14 September 2026.** No hub-intake exemption is needed: `submitBlindCount` submits one count in one call whatever the parcel quantity, and `MSC-DEC-369`’s launch volumes make 120/minute unreachable by a receiver. `hub_intake_rate_limit` is **removed** from `settings.md` §7.7 rather than valued, and **`RATE_LIMITED` gains an alert** (`OBSERVABILITY_AND_RECOVERY.md` §3) so the ceiling is revisited on telemetry.|
| **Elevation of Privilege**| Ops Staff performing Senior Ops actions; rider accessing another rider's stops; vendor accessing another vendor's data| Permission catalogue enforcement (permissions.md §7); PostgreSQL RLS with `FORCE ROW LEVEL SECURITY` (§14.4); ownership checks on every write; `DENY BY DEFAULT` (§37.1)| Service-account and integration permissions: OQ-047|

### 15.2 Android attack surface controls

**Root detection — recorded, never blocking**. The Rider Android app checks root indicators **at sign-in only**: `su` binary presence, test-keys build fingerprint, known rooting app package signatures, writeable `/system`. **The result is submitted with the challenge response as `client_root_signal` — `NOT_DETECTED`, `DETECTED` or `UNKNOWN` — and recorded on the session and in the audit trail. It refuses nothing**, and it never permits anything either: `NOT_DETECTED` is not evidence that the device is trustworthy, and `UNKNOWN` is valid and means the client could not establish a result.

**Why it does not gate.** The check runs inside the process an attacker controls, so on a genuinely compromised handset it is defeatable — blocking on it stops casual cases and not determined ones, while refusing honest riders on second-hand or modified devices. **The controls that actually bind are the hardware-attested keypair, the proof of possession at every sign-in, and certificate pinning**, none of which root detection strengthens.

**No integrity signal may refuse a rider already holding custody.** No check in this section runs before evidence upload or payment recording, and **none refuses a rider already holding custody**: the device checks run at **enrolment and replacement** (§15.2.1), and sign-in proves possession of the registered key. `state-machines.md` §9 names the **Rider** as the only actor for both exits from `OUT_FOR_DELIVERY`, so an app that refuses mid-run leaves a parcel in a state no one can move — and a system-caused failure the customer would carry is what `MSC-DEC-309` rules against.

**Certificate pinning.** The React Native app pins the Melarc API TLS certificate leaf and intermediate CA. Pin rotation procedure: updated pin list deployed 30 days before certificate expiry; old pin retained in the bundle for the 30-day overlap period. **The 30-day figures are engineering proposals, not approved figures**; the Backend Engineer confirms them by approving this document. App update is required to rotate the pin — this is a forced-update gate. Pin rotation is tracked in [DEPLOYMENT_AND_ENVIRONMENTS.md](DEPLOYMENT_AND_ENVIRONMENTS.md) as a deployment event.

**Distribution and forced update** (`MSC-DEC-418`, clarified by `MSC-DEC-426`). The Rider Android app is **built, signed and distributed privately through a Melarc-managed internal channel and installed manually** on authorised riders' devices. That is the Version 1 mechanism and not a fallback: **no control in this section depends on Google Play installation, Play licensing, `PLAY_RECOGNIZED` or any assumption that Play installed the APK**, and Google Play or Managed Google Play is a future migration option only. Before a security-critical compatibility deadline such as certificate-pin expiry, Melarc may enforce a **server-defined minimum supported app version**: a device below that version must update before normal operational access continues. **Nothing is pushed to the device** — the channel makes each release available, the rider installs it, and the version gate is what makes the update mandatory. This is the update path the forced-update gate above depends on, and the mechanism that makes the 30-day pin-rotation overlap enforceable rather than advisory. The **operational Android floor above the technical minimum of 24** is `OQ-073`'s, held pending real rider-device data (§15.2.1).

**Rider device trust under private distribution**. The server's trust in a rider's handset rests on **Melarc-controlled enrolment, a registered cryptographic identity held in hardware-backed key material, single-use server challenges, proof of possession by signature, explicit device status and revocation, controlled replacement, and Android Key Attestation verified once at enrolment and again at replacement** — and on nothing Google Play provides. Who does what, and when:

| Moment| Melarc's control| What the server checks|
|---|---|---|
| **Enrolment and replacement** (`registerRiderDevice`, `reregisterRiderDevice`, `completeRiderDeviceEnrolment`)| Senior Ops, or a Platform Admin whose grant reaches the rider's hub, in person; the handset generates a hardware-backed signing key with the attestation challenge the QR carries and submits only the public half and its attestation chain; a replaced or revoked record is kept, never deleted| The single-use grant, and with it the challenge; **the attestation policy at §15.2.1**. Nothing is written unless all of it passes|
| **Sign-in** (`requestRiderSignInChallenge`, `riderSignIn`)| A fresh single-use challenge that lives five minutes| Phone and PIN; rider and device status; a signature over the challenge by the registered key; the challenge's freshness and single use. **No attestation is evaluated.** A consumed challenge is `CHALLENGE_UNUSABLE`, an expired one `CHALLENGE_EXPIRED`, a signature that does not verify `DEVICE_PROOF_INVALID`, no `ACTIVE` device `DEVICE_NOT_ENROLLED`. `client_root_signal` is recorded and not judged|
| **Every operational action** — custody, evidence, payment, handover| The existing session and offline rules| **No integrity verification.** `MSC-DEC-387` stands|

**At sign-in, the server owns the Rider-device trust decision.** It evaluates the device's previously verified attested registration, its current state and fresh proof of possession over the server-issued single-use challenge. **A new platform attestation is not required at every sign-in.** Client-side root detection remains a recorded, non-authoritative signal and cannot independently permit or deny authentication (`MSC-DEC-387`, clarified by `MSC-DEC-427`).

**Why a second attestation at every sign-in would add nothing and cost something.** The registered key is hardware-backed and non-exportable, and it signs a fresh single-use challenge at every sign-in; **that signature is the live proof that this handset is the registered one.** A per-sign-in attestation would put a verification service on the path a rider needs to start work and add a failure no rider can fix, to prove nothing about possession that the signature does not.

**What it does not do, said plainly.** Attestation is **as of enrolment**. A handset compromised after it was accepted is not detected by a later attestation; it is bounded by what bound it before — the device-bound hardware key, the PIN, the online attempt limits, explicit revocation on report, and the recorded root signal for Ops follow-up — and by `MSC-DEC-387`'s own argument that a check inside the attacker's process stops casual cases and not determined ones.

**A verification outage never strands a rider.** Nothing after enrolment calls an attestation service, so a rider carrying parcels is not stranded and **no live session is invalidated because attestation infrastructure is unreachable**; existing session expiry and revocation rules remain the only authority. **The one dependency — the trust roots and the revocation list — touches only new enrolment and replacement** (§15.2.1), and is a maintenance dependency, not a dependency of the sign-in path.

**Binary obfuscation.** ProGuard/R8 applied at release build. No JavaScript source maps shipped with the production APK. Minification and class renaming applied to all non-library code.

**Anti-tampering.** APK signature verification performed at runtime using the Android package manager — a client-side measure, defeatable on a compromised handset. **Device integrity is established by the server through Android Key Attestation at enrolment and replacement (§15.2.1), not by a verdict at sign-in**. Evidence that was supplied, evaluated and failed policy results in **`DEVICE_INTEGRITY_FAILED`** — **not** `DEVICE_PROOF_INVALID`, which is a failed **signature** — and a handset that cannot hold a hardware-backed key is **`DEVICE_SECURITY_UNSUPPORTED`**: three conditions, three codes, because *the key did not prove itself*, *the evidence would not vouch for the device* and *the device cannot offer the evidence* need different responses. **No integrity signal may refuse an operation from a rider already holding custody.**

**Secure local storage.** The session `access_token` and the one queued hub-handover payload are held **only** in encrypted local storage whose key is an **Android Keystore AES-256-GCM key**, non-exportable and bound to this app (StrongBox accepted, not required). The storage engine layered on that key — an encrypted-preferences wrapper, an encrypted file or SQLCipher — is the Frontend Engineer's choice at implementation and is not part of the contract, **provided it has exactly these properties**: authenticated encryption, a Keystore-held key, no plaintext copy in shared preferences, logs, backups or crash reports, and a wipe on sign-out, device replacement and revocation. **No library is mandated**: this paragraph named `EncryptedSharedPreferences`, a convenience wrapper over the primitive above, and a design that depends on one wrapper's maintenance has chosen the wrong layer — which is also why `OQ-073` no longer waits on a storage API. The rider's PIN hash is **never** stored on the device — only the server-side Argon2id hash with pepper matters. The device keypair is non-exportable: the private key resides in Android secure hardware and cannot be extracted, copied to a replacement handset, or read by any application process.

### 15.2.1 Rider device key attestation — what the server verifies

**The hardware baseline.** A production Rider device must support Android hardware-backed Keystore Key Attestation with a key at **`TrustedEnvironment` security or better**. **StrongBox is accepted and not required.** A software-only key is not eligible for production enrolment. **The minimum Android version is 24 (Android 7.0)** — the lowest level at which a key can be generated with an attestation challenge (`KeyGenParameterSpec.Builder.setAttestationChallenge`), so below it production enrolment is impossible (`DEVICE_SECURITY_UNSUPPORTED`) and a lower floor would build an app no handset could enrol. **That is a technical floor, not an operational one**: whether an operational floor above 24 is wanted waits for real rider-device data and stays with `OQ-073`; raising it is an engineering change enforced by the minimum-supported-version gate. **The Product Owner accepted 24 as the Version 1 technical minimum** **and not as a commitment that Melarc will operationally support every API 24 handset.**

**The policy.** Evaluated in this order, **after** the grant is found valid and **after** the trust-data check below. The first failure ends it, and nothing is written.

1. **Structure.** The chain parses, and the key attestation extension used is the one **in the certificate nearest the trusted root** that carries it — Android: *only the first occurrence of the extension in the chain can be trusted*, counted **from the root**, and any further instance may have been appended by an attacker. The submitted chain is leaf first (`maxItems` 10); the verifier builds and validates the path from the root and **never scans from the leaf**, never assumes the leaf holds the extension, and ignores an extension in a certificate further toward the leaf. A certificate that carries the extension twice (the only meaning of *duplicate* here), a malformed extension, an oversized chain and unparseable input → `DEVICE_INTEGRITY_FAILED`. When a provisioning-information extension is present, the attestation extension must be in the certificate immediately after it.
2. **Security level.** `attestationSecurityLevel` and `keymasterSecurityLevel` are `TrustedEnvironment` or `StrongBox`. `Software` → **`DEVICE_SECURITY_UNSUPPORTED`**. It is checked here because the missing capability is the cause whatever the chain's root.
3. **Chain validity.** Each certificate signs the next and is within its validity period. **One exception:** the expiry of the device's *factory* attestation certificate alone does not refuse — Google documents devices launched before 2021 as carrying expired factory keys that remain trustworthy unless revoked.
4. **Trust roots.** The chain ends at one of the **accepted Android attestation roots**, the set Google publishes, held as configuration.
5. **Revocation.** No certificate in the chain is on Google's attestation revocation list.
6. **Challenge.** The attested challenge equals the challenge issued with the grant — compared in constant time against `SetupGrant.attestation_challenge_hash`. **Its validity window is the grant's lifetime** (`recovery_link_ttl_minutes`, 30) **and it is single-use with the grant**: an unknown, expired, consumed or superseded grant is `SETUP_GRANT_INVALID` before any evidence is read. A challenge that does not match is `DEVICE_INTEGRITY_FAILED`.
7. **Application identity.** The attested package name equals the configured Melarc Rider package, and **every** signing-certificate SHA-256 digest the extension reports is in the **approved digest set**.
8. **Device state.** In the **hardware-enforced** authorization list's `RootOfTrust`, read from that same extension, `deviceLocked` is `true` **and** `verifiedBootState` is `Verified` — the enumeration is `Verified`, `SelfSigned`, `Unverified`, `Failed`. **Validated at Gate PD-3R1:** both fields are read **only** from the hardware-enforced list, never from the software-enforced one that a compromised operating system could populate; an absent `RootOfTrust`, `SelfSigned` (a boot key the user set, including a custom ROM re-locked with its own key), `Unverified` and `Failed` all fail this step as `DEVICE_INTEGRITY_FAILED`. `verifiedBootKey` and `verifiedBootHash` are recorded in the attestation summary and **compared with nothing**, and the operating-system patch level is not a criterion. Product has no objection to either control. **Consequence, accepted:** a handset running a custom ROM, however well locked, cannot enrol.
9. **Key properties.** The key was generated on the device (`origin` `GENERATED`, never imported), is a signing key (`purpose` includes `SIGN`), and is an EC key on the P-256 curve with the SHA-256 digest (`algorithm` EC, `ecCurve` P-256, `digest` SHA-256) — what `MSC-DEC-264` already requires of the registered key and what the device-key protocol of §13.6 needs.
10. **Key binding.** The attested public key equals, once both are canonicalised by the reviewed crypto stack (§13.6), the `public_key` submitted for registration.

Steps 1 and 3 to 10 failing is `DEVICE_INTEGRITY_FAILED`, audited as `auth.device.attestation_failed` with its cause class; step 2 failing is `DEVICE_SECURITY_UNSUPPORTED`, audited the same way. **Nothing outside the extension is trusted**, and the operating-system patch level is not a criterion, and the minimum Android version is 24 (above).

**Atomic.** On success, in one transaction: the device is registered `ACTIVE`, the grant consumed, the PIN set, and — for a replacement — an `ACTIVE` old device becomes `REPLACED` and its live session ends `DEVICE_REPLACED`, with `auth.device.registered` and `auth.device.replaced` written together. **A refusal creates no device, consumes no grant and sets no PIN, and a refused replacement leaves the existing device exactly as it was.** Two completions of one grant race to one winner; the other is `SETUP_GRANT_INVALID`. A newer grant of the same purpose supersedes an older one, so only the latest can complete.

**Signing-certificate rotation.** The approved digest set is **configuration, not a constant**, and it holds more than one digest. To rotate: add the new certificate's digest before any APK signed with it is released; release; and once the minimum-supported-version gate has retired every build signed with the old certificate, remove the old digest. **Devices already enrolled are unaffected**, because attestation is evaluated at enrolment and not at sign-in; removing a digest refuses only new enrolments and replacements from builds signed with it. **An empty set, or a missing package name, makes production refuse to start** (`DEPLOYMENT_AND_ENVIRONMENTS.md` §12.3). The package name and the digest of the first production certificate exist only when the signing key does; they are a release input.

**The one external dependency: trust data.** The accepted roots and Google's revocation list are a maintenance dependency of **enrolment and replacement only** — of `completeRiderDeviceEnrolment`, the one operation that evaluates the evidence. `registerRiderDevice` and `reregisterRiderDevice` only issue grants, and `requestRiderSignInChallenge` and `riderSignIn` need no trust data at all. **Every parameter — what is held, where it is loaded, what happens at start-up and when a load fails, the cadence, the maximum age, what the last-known-good copy may be used for, where the system fails closed and the alert threshold — is settled at §15.2.2.** **Trust data is checked first**, once the grant is found valid and before step 1: if the held list is older than the maximum age or none is held, or the roots cannot be loaded, **new enrolment and replacement fail closed** — `503` **`TRUST_DATA_UNAVAILABLE`** with a `Retry-After`, nothing written and the grant not consumed — not `DEVICE_INTEGRITY_FAILED`, because nothing is known to be wrong with the device, and not `DEVICE_SECURITY_UNSUPPORTED`; operations raise an alert. A handset that is told this tries again shortly, **and the grant is still good**. **Sign-in, every live session and every operation are unaffected.**

**The verifier sits behind an interface.** Authentication code consumes a `RiderDeviceAttestationVerifier` — for example an `AndroidKeyAttestationVerifier` in production and a `TestAttestationVerifier` elsewhere; the names are engineering's — and sees only its outcome: accepted, unsupported, integrity failed with a cause, or trust data unavailable. **A verifier that cannot answer inside its deadline, is unreachable or is overloaded is reported as the last of these** (`503` `TRUST_DATA_UNAVAILABLE`, retryable, nothing written and the grant not consumed): the evidence could not be evaluated, which says nothing about the device. The port reports the internal cause as well (§15.2.3), and **a verdict the verifier gave is never relabelled**. **It never handles a certificate**, so Android-attestation evaluation lives in one place: **the private verifier service of §15.2.3 behind the production adapter**, which is built on Google's `android/keyattestation` library, and **not** in a Melarc-written certificate parser or path validator. The substitute produces each outcome **deterministically** from a controlled test input, so every row above is testable without a device and without production trust settings. **Production cannot select it**: configuration that does makes the application refuse to start (`DEPLOYMENT_AND_ENVIRONMENTS.md` §12.3), and a test proves it (`AC-SLICE-000-55`).

**One rider, one `ACTIVE` device — and the limit**. A rider has at most one `ACTIVE` production device, and **the database refuses a second one for the same rider**, so a stale grant or a race can never produce two; `registerRiderDevice` refuses it with `STATE_CONFLICT` and a change of handset is a replacement. **What is not enforced is one rider per physical handset.** That is an operating rule — a physical handset is intended for one rider at a time, deliberate sharing is not permitted, and Senior Ops verifies it in person during the enrolment or replacement ceremony. **The system cannot see it, and that is accepted:** each enrolment generates its own key and attestation proves what a key is, not which handset holds it, so two enrolments on one handset cannot be reliably identified as the same one. **Version 1 derives, stores and enforces no handset identifier for this** — no IMEI, serial number, Android ID, advertising ID, device fingerprint or ID attestation — and adds no MDM or Managed Google Play. The enforceable invariant is the rider-to-registered-key binding. Failed enrolment attempts stay rate-limited and every attestation refusal is audited as `auth.device.attestation_failed`.

### 15.2.2 Trust data — what is held, how often it is refreshed, and what happens when it goes stale

`MSC-DEC-429`'s engineering items, settled at Gate PD-3R1 and **accepted by the Product Owner for Version 1 at Gate PD-3R2**. **They remain engineering parameters, carry no Product authority and are deployment configuration, not business settings** — the acceptance records that Product has no objection to the figures, not that Product owns them. The Backend Engineer confirms them by approving this document.

| Question| Production| Local and Staging|
|---|---|---|
| **What is held**| The accepted Android attestation **roots** (configuration, reloaded on change) and Google's attestation **revocation list**, fetched from its published endpoint, validated and **held in memory by each verifier instance** with its fetch time. **Nothing is persisted**: the list is public, small and cheap to fetch again, and a verifier instance that restarts loads it afresh| **Local:** the substitute verifier needs neither, and nothing is loaded. **Staging:** wherever the production adapter is selected, the loader runs and **every row of this table applies**|
| **Where it is loaded**| **Inside each verifier instance (§15.2.3), by its own loader on an in-process timer, from fixed configured sources only** — with network, response-size and freshness limits, and never from a URL a certificate supplies. It is not a scheduled job, a worker task, an outbox message or a broker consumer, so it uses no scheduler, no worker identity, no database write and no lock, and it does not depend on `OQ-115`. It needs egress from the verifier to Google's published endpoint and from nowhere else; the API runtime needs none| Local: not run|
| **At start-up**| A verifier instance **loads at start** and holds no list until the first load succeeds. **No list is treated as infinitely old**: enrolment and replacement answer `503` `TRUST_DATA_UNAVAILABLE` until it does, so a restart never serves a list the verifier has not itself loaded. Sign-in does not wait| —|
| **Refresh cadence**| Every **6 hours**| —|
| **Maximum acceptable age**| **24 hours** from the held list's fetch time — `ATTESTATION_TRUST_DATA_MAX_AGE_HOURS`, **required in production and greater than 6**, so a list always outlives one cadence| —|
| **A load fails while the list is within its maximum age**| The **last-known-good** list this verifier instance holds keeps serving. The loader retries **every 15 minutes**, with no growth in the interval, until it succeeds — **the age alert is its bound** — and logs and counts each failure (`attestation_trust_data_load_failures_total`). A fetched list replaces the held one **only if it parses, validates against its schema and is non-empty**; otherwise it is discarded and counts as a failure. The fetch time-out and a size ceiling are deployment configuration| —|
| **What last-known-good may be used for**| The enrolment and replacement checks, **until the maximum age**, and for nothing else. **Never past 24 hours, and never when the accepted roots failed to load**| —|
| **Where the system fails closed**| When the held list is **older than 24 hours** or none is held, the roots cannot be loaded, or the verifier itself cannot answer (§15.2.3): new enrolment and replacement answer **`503` `TRUST_DATA_UNAVAILABLE`** with a `Retry-After`. Only `completeRiderDeviceEnrolment` evaluates trust data, so a ceremony can begin while the loader is failing and is refused when the handset completes it — **retryable, with the grant still good**. Sign-in, every live session and every operation are unaffected| —|
| **Alert**| The gauge `attestation_trust_data_age_seconds` is, per verifier instance, **the time since the held list was fetched, or since the process started when none is held**. **SEV-3 when the oldest verifier instance's list is older than 12 hours; SEV-2 when it is older than 24 hours**, or when the accepted roots cannot be loaded — enrolment is then failing closed (`OBSERVABILITY_AND_RECOVERY.md` §3.2). **Owner: the Backend Engineer**, through the standard operational alert path of `OBSERVABILITY_AND_RECOVERY.md` §3.1, with the runbook at §4.3a there; the owner tells Senior Ops when an enrolment or replacement is blocked, because that is a rider who cannot yet work. **A failed load inside the bound is not an alert**: it is the design working, and the counter and the log are for diagnosis| —|
| **Startup**| Production **refuses to start** if the maximum age is unset or not greater than 6, or the accepted roots are empty (`DEPLOYMENT_AND_ENVIRONMENTS.md` §12.3)| —|

**Why these numbers.** The revocation list changes rarely, and a stale copy errs toward accepting a revoked certificate, so the bound is a day and not a week. A six-hour cadence with a **fifteen-minute retry** gives a failing source about ninety attempts inside the bound before enrolment stops, so **the retry, not the cadence, is what makes a transient outage harmless**. Twelve hours leaves most of a working day to act before enrolment stops. **They are configuration, recalibrated from telemetry, not redesigned.**

**Why in memory, and what that trades.** The list is public and cheap, so persisting it would add a technical table, a registry classification and a database identity for a value any instance can fetch again — and the scheduler runtime, which only enqueues (§14.6, §14.7), could not have written it. The price is that **a restart loses the last-known-good copy**: if the source is unreachable at the moment a verifier instance starts, that instance refuses enrolment until it can load, where a persisted copy would have served it. Enrolment is rare and retryable, and failing closed at start is the safe side of that trade; a persisted cache would be a later, deliberate change with its own registry row.

**How it is proved.** The loader's cadence, retry, replace rule, start-up behaviour and age arithmetic are unit-tested with an injected clock and a fake source; `AC-SLICE-000-69` proves the refusal and `AC-SLICE-000-75` the substitute's *trust data unavailable* outcome; the two alert thresholds are asserted in the rehearsal that `SLICE-000` §7 item 6 names.

**Root rotation** is a maintenance event, not a code change: Google publishes a new root, it is added to the configured set before chains start ending at it, and nothing else moves. The verifier's refusals are audited with their cause class (`auth.device.attestation_failed`), so a chain ending at an unknown root is visible as a rate and a rotation the configuration missed does not go unnoticed.

### 15.2.3 The private verifier service

Product decision, 8 October 2026 ([SLICE-000-FINAL-DECISIONS.md](../delivery/planning/SLICE-000-FINAL-DECISIONS.md) §3). A Melarc-written DER parser and certificate-path validator is **not** the application's chosen design: Node's `X509Certificate.verify()` checks a signature and nothing else, Android's own guidance recommends its attestation-verification Kotlin library and warns that custom verifiers miss edge cases, and the extension must be taken rootward (§15.2.1 step 1). Attestation is therefore evaluated by `android/keyattestation` inside **one small, persistent, private JVM service**, behind the unchanged `RiderDeviceAttestationVerifier` port. It is not a second application and not a place for business logic.

- **Interface.** A versioned request and response: the chain and the expected policy and context in; the verified attested key and a structured, non-secret outcome out. Input size, concurrency and time are bounded and a deadline applies to every call. A JVM is never started per request.
- **Boundary.** The service holds **no database credential** and no application secret. It binds to loopback or a dedicated private network, authenticates its caller if it crosses hosts, and rejects the public edge. Its egress is Google's published attestation endpoints and nothing else.
- **Policy it enforces.** The approved Melarc Rider package name and release signing-certificate SHA-256 allowlist; the acceptable hardware security level; verified-boot and locked-device state from the hardware-enforced list; a challenge match; key purpose, origin and algorithm; chain and revocation validation; and binding to the key actually attested. Permissive example settings of the library (an unknown-package allowance, for instance) are not Melarc policy, and a debug signer is rejected in production. The library's factory and remotely-provisioned certificate handling is used as supported, and Melarc's required cases are tested independently.
- **Pinning and build.** The library release, the JDK and the build dependencies are pinned to reviewed versions (a release candidate is *qualified*, not followed as a branch) with a reproducible build, dependency verification, CI coverage and Windows and Linux start and stop instructions. Its build is independent of Node package discovery and its tests are part of the required gate.
- **Who decides what.** NestJS owns authorization, grant lookup and the final atomic enrolment or replacement. PostgreSQL owns grant expiry, consumption and device and session state. The verifier owns certificate and attestation evaluation, and its in-memory replay cache never replaces the database's single use of a grant.
- **Outside the transaction.** The call to the verifier happens **before** the mutation transaction. On return the enrolment locks and re-reads the grant, its expiry, the actor's authority and the relevant device state, and applies one atomic change — another request may have consumed or revoked them while the verifier ran.
- **Trust data** is §15.2.2, loaded by the verifier from its fixed sources. Beyond the permitted age enrolment and replacement fail closed with `503` `TRUST_DATA_UNAVAILABLE`; sign-in and live sessions gain no new dependency on the verifier. Deployment health tells *enrolment degraded* from *the API is down*.
- **Unavailable is not invalid** (Product decision, 8 October 2026). `TRUST_DATA_UNAVAILABLE` covers stale or unloaded trust data **and** a transient verifier fault — unreachable, overloaded, or not answering inside its deadline ([errors-and-enums.md](../contracts/errors-and-enums.md) §4). The port returns one of six closed diagnostic causes with it — `TRUST_DATA_STALE`, `TRUST_DATA_NOT_LOADED`, `TRUST_ROOTS_UNLOADABLE`, `VERIFIER_UNREACHABLE`, `VERIFIER_TIMEOUT`, `VERIFIER_OVERLOADED` — which go to the structured log and to a bounded `cause` label on `attestation_verifier_unavailable_total`, and **never into the response**; no `auth.device.attestation_failed` event is written, because nothing was decided about the device. A verdict the verifier gave (`DEVICE_INTEGRITY_FAILED`, `DEVICE_SECURITY_UNSUPPORTED`) is returned exactly as it was and is never relabelled as unavailable, and a verifier answer that breaks its own interface is a defect — the platform's generic operational failure, alerted — and never a device refusal. Only `completeRiderDeviceEnrolment` calls the verifier, so no sign-in, session or other operation depends on it.
- **Distribution.** Internal distribution of a signed Rider APK stays valid: the app needs neither Play Store publication nor Google hosting. Device eligibility and Google-rooted hardware attestation are separate requirements from how the APK is distributed.
- **Evidence it is done.** Package and signer policy tests; wrong and unknown roots; revoked certificates; duplicate and malformed extensions; rootward selection; wrong challenge, package and key; input limits; stale trust data; a verifier timeout; concurrent consume and replacement; no production substitute; and a **real internally signed APK on eligible hardware**. Synthetic fixtures alone never close hardware acceptance.

### 15.3 Mid-session revocation — the Session record is the revocation store

*Rewritten at Gate PD-3R1. Added on 13 September 2026 by CRIT-02 as a Redis blocklist; withdrawn here.*

**The selected component is PostgreSQL, and no other store exists.** §13.1 made sessions opaque and **server-side**: every request looks the session up by `token_hash` and refuses one that is not `ACTIVE`. Revocation is therefore a state change on that same row, made **in the same transaction as the act that caused it**: a suspension, a status change, an administrative revocation, a device revocation or replacement, a credential change or an authority change each set the session `TERMINATED` with its reason ([state-machines.md](../contracts/state-machines.md) §13). The next request is refused with `401 SESSION_INVALID`. **There is no interval in which a decision exists and its effect does not.**

| Question| Answer|
|---|---|
| **Store**| PostgreSQL: `Session`, and `RegisteredDevice` for device status|
| **Key model**| Primary key `id`; a **unique index on `token_hash`**, the lookup key of every request; a partial index on `(principal_type, principal_id)` where the state is `ACTIVE`, for *all live sessions of this principal*, and one on `bundle_id` where the state is `ACTIVE`, for *all live sessions issued from this bundle*|
| **Lifetime**| `expires_at` and, for browsers, `last_activity_at` are evaluated on every request, and the `expire_sessions` job (`BACKGROUND_JOBS_AND_EVENTS.md` §3.5) closes the records. A record that is not `ACTIVE` is history, kept under the audit retention rule|
| **Failure behaviour**| **Fail closed.** If PostgreSQL cannot be reached the request cannot authenticate and is answered `503` **by the platform, outside the operation contract** (no operation declares a `5xx` for an infrastructure outage); **nothing is served from a stale copy**|
| **Process ownership**| The `platform/auth` module is the only writer of `Session`. Every authority-changing operation calls its `terminateSessions(principal, reason)` — a bundle reduction its `terminateSessionsIssuedFromBundle(bundle, reason)` — inside its own transaction|
| **Environment configuration**| None beyond the database connection: no cache, no broker, no TTL setting, and the same in Local, Staging and production|

**The platform's own answers for its resources, outside the operation contract** (S0.20; the owner's decision of 11 October 2026, OB-55). None carries an `Error.code`, none sets `Retry-After`, and the text of each is fixed and takes nothing from the failure. An exhausted request budget, a database time bound, a saturated pool, an expired wait for a connection and a closed pool are `503`: it is known that the work did not take effect. **A commit whose outcome is unknown** (the connection ended, or the budget ran out, while `COMMIT` was in flight) is a `500` with its own text, "The outcome of the request could not be confirmed", and is never a `503`: a `503` tells a client to try again, and trying again is safe only through the operation's idempotency key (§14.16: a client never retries an uncertain mutation under a fresh key). A definite rollback is a defect of the work and is an ordinary `500`. A request refused at transport admission (`413`, `415`, `408`, and the `503` of a full admission gate) is code-less too, for the same reason: no code is invented for it.

**Why the Redis blocklist is withdrawn.** It solved a problem this design does not have. It added a second store and a failure mode — the cache write and the database commit could disagree, and no ordering was stated — put a component in the authorisation path that no topology declared, and called itself *authoritative* beside a `Session` row that already was. `CRIT-02`'s requirement, that a suspended rider's token dies immediately, is met by the row.

**What a rider's suspension does** is a `terminateSessions` call inside the operation that changes the rider's status, which belongs to rider administration (`SLICE-009`). `SLICE-000` proves the mechanism with the terminating operations it owns — `revokeSession`, `revokeRiderDevice`, replacement and recovery.

### 15.4 Session expiry during an active delivery run

*Rewritten at Gate PD-3R1. Required by HIGH-01.*

When a rider's session ends mid-run — its 1440-minute absolute lifetime, or an administrative revocation:

1. **The app sees `401 SESSION_INVALID`** on any call and **keeps the in-progress stop state in memory.**
2. **It shows the ordinary sign-in as an overlay on the current stop**, without navigating away: the rider enters the PIN, the app fetches a fresh challenge and signs it. **There is no separate re-authentication factor.** Biometrics, which no contract or feature defines, are not an alternative; this section offered *biometric if enrolled* until PD-3R1 and no operation could have accepted it.
3. **On success** a new session is issued and the failed operation is retried with its original `Idempotency-Key`, so nothing is recorded twice.
4. **On failure** — the rate limit, a lockout or no signal — the in-progress stop is kept locally and the app says *contact your hub*. **The stop is not recorded as failed or as a consumed delivery attempt**: a session expiry is a Melarc-originated event and must not be charged to the customer. The attempt limit is `signin_max_attempts` and the lock is §13.4b's; this section no longer carries a figure of its own.
5. **Audit.** The session's `EXPIRED` termination is already recorded by `auth.session.terminated`. **No `auth.session.expired` event is added**: it was *to be added* with no question beside it, and a second record of one fact is not needed.

### 15.5 Secrets rotation — timelines (engineering proposals)

*Required by HIGH-02. Independent of automation mechanism.* **The intervals below are engineering proposals, not approved figures**: no decision or specification section sets them, `DEPLOYMENT_AND_ENVIRONMENTS.md` says plainly that a quarterly interval is *engineering judgement*, and they carry no Product authority. The Backend Engineer confirms them by approving this document, and any of them may change without a design change.

| Secret type| Maximum rotation interval| Notes|
|---|---|---|
| API keys (Hubtel, SMS provider, transactional email provider)| **90 days**| Rotation via the provider's key management console. Old key retained for 24-hour overlap before revocation|
| Database credentials (`melarc_api_runtime`, `melarc_worker_runtime`, et al.)| **180 days**| Automated rotation preferred; manual rotation is an accepted fallback with mandatory incident ticket|
| TOTP seed encryption key (a KMS key)| **Per the KMS key policy; rotate on compromise**| Rotation adds a **key version**: seeds encrypted under an older version still decrypt and are re-encrypted lazily when next used (§14.9). A seed is **encrypted, never hashed**, so nothing is ever *re-hashed*|
| Argon2id pepper| **No scheduled rotation — rotate on compromise**| **Versioned and additive** (`pepper_version`, §14.9): old hashes verify under their own version and rehash on a successful sign-in. A suspected compromise is a credential-security incident, not a routine rotation|

**Rotation mechanism is a blocking gate.** No secret may be provisioned in production without the rotation mechanism (manual procedure, Vault, AWS Secrets Manager, or equivalent) being in place and end-to-end tested before go-live. The mechanism does not need to be fully automated, but it must be documented, assigned, and rehearsed.

**Telemetry.** A rotation-due alert fires 14 days before each deadline. An overdue rotation is a `P1` security incident per [OBSERVABILITY_AND_RECOVERY.md](OBSERVABILITY_AND_RECOVERY.md) §5.1.

### 15.6 OWASP Top 10 (2021) mapping

| OWASP category| Applicable controls already specified| Gap / open item|
|---|---|---|
| A01 — Broken Access Control| RLS with `FORCE ROW LEVEL SECURITY`; deny by default; ownership checks on every write; assigned-work scope for riders| OQ-047 (service-account permissions)|
| A02 — Cryptographic Failures| Argon2id + server-side pepper for PIN/password; TLS everywhere; KMS-backed audit checkpoint; evidence signed-URL (15 minutes, `MSC-DEC-297`)| Encryption at rest specification: §14.19 (covered)|
| A03 — Injection| Parameterised queries throughout; RLS context variables not user-controlled| None identified|
| A04 — Insecure Design| STRIDE model (§15.1); state machines with explicit guards; audit append-only chain| No design-phase threat model review process formally documented — this section is the first iteration|
| A05 — Security Misconfiguration| Application startup fails on missing production security config (§14.14); no "development mode" bypass in production; Gate B environment rules| Auto-detection of configuration drift is **not designed for Version 1**: start-up validation (§14.14) is the only check, and drift detection is a hardening item for the Backend Engineer to take up with deployment|
| A06 — Vulnerable Components| ProGuard/R8 obfuscation; native module pinning; no source maps in production APK| A dependency vulnerability scan runs on every pull request and fails on a high or critical finding unless a recorded exception names it and its expiry ([engineering-standards.md](../standards/engineering-standards.md) §3.3)|
| A07 — Identification and Authentication Failures| Challenge-response keypair; Argon2id PIN hashing; MFA for privileged roles; lockout with attempt caps; anti-enumeration responses| Revocation as a `Session` state change with no second store: §15.3; the lockout mechanism: §13.4b|
| A08 — Software and Data Integrity| APK signature verification; Key Attestation verified at enrolment and replacement (§15.2.1, `MSC-DEC-427`); outbox relay trusted envelope pattern (§14.7)| Attestation is as of enrolment; trust-data maintenance (§15.2.1)|
| A09 — Security Logging and Monitoring| Append-only KMS-signed audit log; checkpoint every 15 minutes; enhanced audit for privileged acts; SIRP in OBSERVABILITY_AND_RECOVERY.md §5| Alert thresholds per `MSC-DEC-370`|
| A10 — Server-Side Request Forgery| Provider credentials server-side only (§1a); no client-initiated outbound calls to external URLs| Webhook or callback receiver not yet in scope — when added, SSRF controls required|

## 16. Privacy and sensitive data — §37.7

*Added 14 September 2026 — MED-01 audit remediation.*

**This document governs §37 and had never once addressed §37.7 by name.** §37.7 lists eight things a privacy design must cover — purpose, masking, encryption, export, retention, deletion/anonymization, breach response, legal review — and assigns them to "security/privacy design work," which is this document's job under its own header. Five of the eight already exist, scattered across sections that never cite §37.7 as the reason they exist. Two do not exist anywhere. Naming the gap is the fix; none of the five existing controls changes.

| §37.7 element| Where it already lives| Status|
|---|---|---|
| **Purpose**| Each personal-data field's reason for existing is stated once, at its entity, in [domain-model.md](../contracts/domain-model.md) — never restated here, to avoid duplicated definitions| Covered by pointer|
| **Masking**| The never-log list (§8, `audit.md` §9): secrets, full credentials, raw OTPs, unnecessary personal data. Payer numbers redacted in logs (§1a)| Covered|
| **Encryption**| At rest: §14.19, KMS-backed. In transit: TLS everywhere (§13.2). TOTP seeds encrypted, not hashed (§13.5)| Covered|
| **Breach response**| [OBSERVABILITY_AND_RECOVERY.md](OBSERVABILITY_AND_RECOVERY.md) §5 — the Security Incident Response Plan added at CRIT-12 audit remediation, including the 72-hour Ghana DPC / GDPR notification table| Covered|
| **Legal review**| Interim accountable owner and starting regulatory reference point (Ghana Data Protection Act 2012, Act 843; GDPR for European users) confirmed at specification §8.2, `MSC-DEC-159`–`160`. The review itself has not happened — that is what `OQ-028` and the two rows below track| Owner confirmed; review pending|
| **Retention**| Governance model — per-category configurable, legal-hold exemption, Platform Admin editing authority — confirmed at specification §38.7, `MSC-DEC-150`–`153`, carried in [settings.md](../contracts/settings.md). **Exact periods per category are `OQ-028`**, awaiting qualified legal input this programme cannot supply| Model settled; values open|
| **Deletion / anonymization**| Specification §30.10 is a **confirmed, approved product decision**, not a gap: offboarding a staff member or rider "immediately revokes system access and credentials," and "all historical records — parcel history, audit trail, permission-review history — are preserved and never deleted." Vendor offboarding retention detail is `OQ-028`'s (`OQ-033` closed at `MSC-DEC-397`). **Whether that blanket preservation needs an exception path for a data-subject deletion request is undecided** and is now folded into `OQ-028`, since the same legal review answers both| §30.10 stands; exception path is `OQ-028`|
| **Export** *(data residency)*| **Not decided anywhere in this programme.** [DEPLOYMENT_AND_ENVIRONMENTS.md](DEPLOYMENT_AND_ENVIRONMENTS.md) §3 picks the production region **"on measured latency to Accra"** alone and says so explicitly — a European region may win on latency while moving Ghanaian residents' personal data across a border nothing has assessed for lawfulness. Registered as `OQ-120`| Not covered — new gap|

**The unresolved residency and deletion exceptions require explicit legal/product input.** They are not engineering defaults. Keep the affected requirements visible here until the decision is reflected in the owning contracts.
