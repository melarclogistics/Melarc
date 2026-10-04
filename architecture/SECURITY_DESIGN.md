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

**Gate B adds the layers beneath the five surfaces**, because §37.6's *“every query”* includes the ones no surface issues: a pooled connection carrying the previous request's scope, a background job trusting its own payload, and a runtime role that can switch RLS off. [security-test-matrix.md](../standards/security-test-matrix.md) is the canonical enumeration; §14.13 names the four families that an ordinary integration test cannot satisfy.

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

| Cookie| Attributes| Read by JavaScript| Purpose|
|---|---|---|---|
| `melarc_session`| `HttpOnly; Secure; SameSite=Lax; Path=/`| **No**| Opaque browser Session credential|
| `melarc_csrf`| `Secure; SameSite=Lax; Path=/`| **Yes, deliberately**| Synchronizer token, echoed in `X-CSRF-Token`|
| `melarc_vendor_device`| `HttpOnly; Secure; SameSite=Lax; Path=/`| **No**| Vendor registered-browser credential; **outlives the session**, which is what makes it a second factor|

| Surface| Mechanism| Storage|
|---|---|---|
| **Ops Portal**, **Vendor PWA**| The cookies above, set as **real repeated `Set-Cookie` field lines**| The browser|
| **Melarc Rider**| Opaque secret as an HTTP **Bearer** credential, returned **exactly once** at sign-in| **Encrypted local storage under a non-exportable Android Keystore key only** (§15.2)|

**The contract declared two of these three cookies through invented headers until 27 August**. `X-Set-Csrf-Cookie` and `X-Set-Vendor-Device-Cookie` are not HTTP headers, and **an implementation following the contract literally would have emitted two custom headers no browser stores** — the CSRF token and the vendor device credential would never have reached the client at all, and the vendor's second factor would have silently not existed. The contract now declares one real `Set-Cookie` header plus an `x-set-cookies` extension naming which cookies each response sets.

`HttpOnly` is what makes cross-site scripting unable to exfiltrate the session. `Secure` keeps it off plaintext transport. `SameSite=Lax` blocks the cross-site request forgery cases a cookie otherwise invites, and **is not sufficient alone**: unsafe cookie-authenticated requests additionally require a **CSRF token** and **Origin validation**. That is the cost of cookies, and it is smaller than the cost of a token JavaScript can read.

**Bearer here names a transport, not a JWT.** The rider credential is an opaque secret with no claims and nothing to parse.

### 13.3 Idle and absolute expiry

`Session.last_activity_at` is the basis for the idle rule. **It did not exist before Gate A, so the approved idle limits could not be enforced** — `MSC-DEC-234` set 30 minutes standard and 15 privileged against a record with no activity field.

| Tier| Absolute| Idle|
|---|---|---|
| Rider| 1440 min| **None, by rule**|
| Standard — Vendor, Ops Staff| 720 min| 30 min|
| Privileged — Senior Ops, Platform Admin| 480 min| 15 min|

Implementations **may coalesce** activity writes rather than updating a row per request; the externally observable timeout must remain accurate within the coalescing window.

### 13.4 Credential hashing

**Argon2id** for staff passwords, vendor shared secrets and rider PINs, with unique salts, **versioned parameters**, a **server-side pepper held outside the database**, and **rehash-on-success** when parameters are upgraded.

**No memory or time parameters are fixed here.** They must be **benchmarked on the production deployment** — a figure copied from a general source is either too weak to matter or too slow to serve, and neither outcome is visible from a document.

**The rider PIN is the case that needs saying out loud.** A four- or six-digit PIN is **low entropy**: Argon2id raises the cost per guess and does not reduce the number of guesses, and an attacker holding the database can enumerate the whole keyspace. **The rider control is all four together** — PIN, registered cryptographic device, online attempt and rate controls, and the pepper. **The pepper is what a stolen database does not contain**, and it is the reason a database theft alone is not sufficient for offline enumeration.

### 13.4a Credential strength and input bounds

`MSC-DEC-431`. **Engineering detail under a Product rule, carrying no Product authority.**

**The rule.** A staff password, the bootstrap password and a Vendor shared secret are **12 to 128 characters, spaces permitted, with no composition rule** — no mandatory case, digit or symbol. The rider PIN is separate and unchanged: six numeric digits.

**How it is counted and applied.**

- **Length is counted in Unicode code points after NFKC normalisation**, and the same normalisation is applied before hashing at set time and at verify time, so a passphrase that looks the same verifies the same. Nothing is trimmed, truncated or case-folded, and spaces count.
- **It is enforced structurally and again in the credential service.** The request schemas carry `minLength` 12 and `maxLength` 128 on `CredentialSetup.password`, `VendorCredentialSetup.secret` and `RecoveryComplete.new_credential`; the service repeats the check before it hashes. A violation is `VALIDATION_FAILED` with `details.field` naming the field and **never the value**.
- **Where it applies:** setup and recovery completion — the two places a person creates the credential. There is no change-password operation in Version 1; recovery is the only way to replace one.
- **Sign-in is bounded, not policed.** `StaffSignIn.password` and `VendorSignIn.secret` carry `maxLength` 128 and **no minimum**, so an attacker cannot make a hash expensive with a long input and a short guess is simply a wrong credential, answered like any other.
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

**MFA and the password share one count.** `mfa_max_attempts` limits a **challenge** to three wrong codes, after which it is `UNUSABLE`; **each wrong code also adds one to the identity's count**, so a thief who knows the password cannot guess codes across fresh challenges. Three wrong codes plus two wrong passwords lock the identity.

**Rate limiting is separate and first.** A request refused with `RATE_LIMITED` is neither verified nor counted. The rate-limit buckets and their figures are unchanged. **A bucket's key is taken from what the request carries, never from whether the server could resolve it** — the normalised email for staff, the submitted account identifier with the device credential presented (or its absence) for a vendor, the submitted phone number for a rider's challenge request and sign-in — so a request naming an identifier that does not exist is limited exactly as one that does, and `RATE_LIMITED` is never a signal that an account exists.

**Concurrency.** A failure is applied by **one atomic conditional update** on the credential record — *add one to the count unless the credential is already locked*, returning whether this update set the lock — so concurrent failures each add one, **none can step over the threshold without setting the lock, a failure that completes after the lock is set neither counts nor moves `locked_until`, and `auth.lockout.applied` is written only by the update that returned *tipped*, which makes it one event per lock.** The comparison with `locked_until` and the new value use the **database clock**, never an application server's. A correct attempt that races a lock is serialised on the same record: either order is a correct outcome.

**Timing.** Every step that checks a password, a secret or a PIN performs exactly one Argon2id verification at the current parameters — against the real hash when a credential was reached and is not locked, against a fixed dummy hash otherwise — **and a request refused because a lock is in force still performs that one dummy verification and discards the result**, so a locked answer is never faster than a wrong one and latency does not say which stage ended the request. *Not verified*, wherever this section says it of a locked request, means *the verification's result is not used*.

**Audit.** Each refusal is `auth.session.failed` with the factor reached and one cause from the closed set in `audit.md`; the lock itself is one `auth.lockout.applied`, recording the factor that tipped it and `locked_until`. A refused attempt inside a lock is `auth.session.failed` with cause `LOCKED_OUT`. **Neither records a credential, a code or a signature.** **The factor reached is one of `PASSWORD`, `MFA_CODE`, `SECRET`, `PIN` or `NONE`, and every refusal writes one `auth.session.failed`**; a wrong second-factor code and a failed device signature also write `auth.mfa.failed` and `auth.device.proof_failed`, **in addition**, so that the uniform failure record, the enhanced second-factor record and the signature record each tell their own story once.

**What a lock does not do.** It ends no live session, changes no status, blocks no recovery and has no administrator unlock: recovery completion clears it, and otherwise it ends by itself. Setup-grant and recovery-token failures are **not** lockouts — those tokens are single-use, high-entropy and rate-limited, and lock nothing.

### 13.5 Privileged MFA

**TOTP authenticator app**, for Senior Ops and Platform Admin. Not SMS.

The seed is **encrypted, not hashed** — verification requires recomputing codes — and is never persisted or logged in plaintext. **Key custody is Gate B's**; this prohibition binds regardless of that outcome. A code accepted once may not be accepted again inside its window.

**SMS was rejected for this role specifically.** It remains right for operational OTPs to recipients outside Melarc, where the alternative is nothing. As the factor protecting the platform's most powerful accounts it depends on SIM security, on a provider being reachable, and on a per-message cost — and **`OQ-048`'s unresolved provider would otherwise have blocked privileged authentication entirely.**

### 13.6 Rider device possession

The handset generates a **non-exportable keypair** in Android secure hardware. **Only the public key is registered.** Sign-in is challenge-response: the server issues a short-lived single-use challenge, the device signs it, and the server verifies against the stored public key.

**There is no device identifier to copy**. The registration record is identified by `RegisteredDevice.id` on the server; for a rider the registered public key is the binding, and the client neither submits nor selects a device. A string once did that and proved nothing, since anyone who learned it could present it, and it was treated as half of a two-factor credential; it is retired.

The challenge endpoint **is not an enumeration oracle**: a challenge is issued identically whether or not the number belongs to a registered rider, and the response carries no account state.

**Enrolment reaches the handset as a scanned QR**. Senior Ops initiates in person; the Ops Portal renders a short-lived, rider-bound, single-use enrolment URI as a QR code; the rider scans it with their own handset, which then generates the keypair and takes the PIN privately.

**Enrolment is attested**. The handset generates the key as a **hardware-backed signing key in the Android Keystore**, with the single-use attestation challenge the QR also carries, and submits its **Key Attestation chain** beside the public key. The server verifies the chain before it registers anything; the policy is at §15.2.1. A software-only key is not eligible, and the one failure of a handset that cannot hold a hardware key is `DEVICE_SECURITY_UNSUPPORTED`.

**Until 27 August there was no transport here at all.** The initiation response returned an expiry and no credential — withheld on the sound reasoning that an officer holding the token could enrol a device the rider never touched — while completion required that credential. **The flow could not be walked**, and both rider lifecycles ended at this step.

**The QR keeps the property the omission was protecting.** It travels from the portal display to the rider's camera in the officer's presence; there is no point at which the officer transcribes it or could redirect it to a handset the rider is not holding. Senior Ops is already the authority approving this binding, and still never learns the **PIN**, the **private key** or the **session credential**. Served `Cache-Control: no-store`, never logged, never audited by value.

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

**Pre-authentication browser flows are not session-CSRF flows.** Setup, recovery and MFA enrolment have no session and therefore no synchronizer token; they are protected by their **purpose-bound single-use grants**, strict `Origin` validation and rate limits.

### 13.8a Vendor sign-in proves three factors

**Account identifier, shared secret, and a valid `melarc_vendor_device` cookie**. The contract declares the third as a `vendorDevice` security scheme, so an implementation cannot omit it and pass a check.

**Until 27 August the third factor was decorative.** Gate A issued the device credential at setup and **no operation required it**, so vendor sign-in was in practice the shared secret alone — from any browser. That is exactly the outcome the credential was introduced to prevent, and it was described as a second factor in three documents while being enforced by none.

**Ordinary sign-in proves the credential and never re-issues it.** A login that silently registers whatever browser presents itself registers the attacker's browser too. Registration happens only where it is the deliberate act: **initial setup** and **recovery**.

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

**A bootstrap administrator cannot be stranded by an expired continuation** (`MSC-DEC-272`; unchanged under `MSC-DEC-440`, and applied to each of the two identities separately). If the `MFA_ENROLMENT` grant lapses before a code is proven, a **provisioning-only** mechanism — outside the business API, on the same controlled channel that carried the bootstrap secret — issues a fresh `MFA_REENROLMENT` authorisation. It grants **no session, no factor and no password**, does **not** resurrect the consumed `BOOTSTRAP_SETUP` secret, and **refuses to operate for an identity once that bootstrap identity is offboarded**. See [MIGRATION_AND_SEEDING.md](MIGRATION_AND_SEEDING.md) §3.3a.

**`MFA_ENROLMENT` is the only purpose that activates a factor.** Three purposes create a `PENDING` one; `BOOTSTRAP_SETUP` must never activate, because it is the single grant with no expiry and would otherwise remain a standing key to privileged access.

**Authentication challenges are not setup grants and do not share their lifetime**. `authentication_challenge_ttl_minutes` is **5**: an MFA challenge survives three wrong codes then becomes unusable, and a rider nonce is consumed by a **failed** signature as well as a successful one, so every attempt passes through the rate limiter rather than hammering one challenge.

### 13.9a Delivering a grant or a link — one port, handed over before commit

Gate PD-3R1, `PDA-54`. **Every setup grant and recovery link reaches its principal by email or SMS (staff: the verified work email only), and no document named a mechanism, a provider, a non-production substitute or what a failed send does.**

**One port.** The credential service calls `SecurityMessageDelivery.send(kind, channel, destination, payload)`, where `kind` is `SETUP_GRANT`, `RECOVERY_LINK`, `DEVICE_GRANT` or `MFA_REENROLMENT`, `channel` is `EMAIL` or `SMS`, and the result is *accepted* or *rejected*. **The destination is resolved by the service from the principal's registered channel, never from the request** (`requestCredentialRecovery` accepts no destination at all). The payload is the link, the purpose and — for a vendor — the account identifier. **It never contains a password or a secret.**

**The sequence, inside the issuing transaction.** (1) Write the grant or request — **its hash only** — and supersede any earlier pending one. (2) Call the port with the raw token. (3) *Accepted:* commit. *Rejected, or the adapter's timeout elapsed:* **roll back**, so no grant exists and an earlier pending one is untouched, and answer `CREDENTIAL_DELIVERY_FAILED`. The raw token exists in memory only — **never persisted, never logged, never placed in an outbox row.** If the commit fails after an accepted send, the recipient holds a dead link: its token matches no row.

**Why not the outbox.** The hash-only rule means the raw token cannot be stored, and an outbox payload would carry it. **Why before commit:** so a failed send never leaves a live grant nobody received, and never kills a valid one.

**`requestCredentialRecovery` is the exception on the outside, not the inside.** It answers `202` identically whether or not a message was sent (§37.7), **and its response time can depend on neither**: `AC-SLICE-000-21` says no delay distinguishes a known identifier from an unknown one, and the provider's latency, which only a known principal incurs, would. **So this one handler responds before it calls the port.** It resolves the identifier, **performs the same statements for an unknown identifier as for a known one, against a throwaway row that is rolled back**, flushes the `202`, and only then sends, **inside the transaction it still holds open** — so a rejected or timed-out send still rolls the request back, **logged and counted by the provider-failure alert** (`OBSERVABILITY_AND_RECOVERY.md` §3), never disclosed. The transaction is held for at most the adapter's timeout after the response. Every other operation that issues a grant or a link answers after the send, because its caller is authenticated and is told the outcome.

**Adapters.** *Production:* an adapter for the chosen email and SMS providers, which are **external deployment inputs** (`OQ-048` carries the SMS provider and now the transactional email provider; no provider is selected and none is invented here). *Local and Staging:* **only** the **capture adapter**, which writes each message, link included, to a developer-visible sink (a local mail catcher or a capture log) and reaches no recipient. **Production refuses to start with the capture adapter or without a configured production adapter** (`DEPLOYMENT_AND_ENVIRONMENTS.md` §12.3), and a test proves it, exactly as for the attestation substitute. The adapter's timeout is deployment configuration, **set below the critical-write budget** of `OBSERVABILITY_AND_RECOVERY.md` §5.1 (*The measurement contract*), so that a provider that is merely slow is refused rather than allowed to hold a transaction open past it.

**A failed send is a delivery outcome and never an identity state**: `StaffIdentity.status` does not move, because Version 1 has no email-verification lifecycle for it to move through.

**What the port does not carry.** The two rider device grants are not messages: they are returned in the response and scanned from the officer's screen (§13.9), so a rider's enrolment needs no provider and has no `CREDENTIAL_DELIVERY_FAILED`.

**An outage is a bounded failure.** While a channel is down, issuing a grant over it fails with `CREDENTIAL_DELIVERY_FAILED` and nothing else stops: sign-in, live sessions and every operation are unaffected, and the *Provider down* alert fires. Recovery for the affected principals waits for the channel — which is the correct outcome, because a recovery that could be delivered some other way is a recovery to an address nobody registered.

### 13.10 Session invalidation on authority change

Any security-relevant authority change **terminates live sessions immediately**: bundle change, hub-scope change, suspension, offboarding, credential change, MFA reset, device revocation or replacement, administrative revocation.

**The snapshot is what makes this necessary.** `bundle_snapshot` is deliberately frozen at issue so history reads correctly — and the same property would otherwise let a reduced bundle keep its old permissions for the rest of the session. **An administrator would remove access in the database while the user kept it.**

**The `Session` row is the whole mechanism** (§15.3): each of these is a `TERMINATED` state change made in the same transaction as the act that caused it.

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
| `melarc.authorization_key`| **The permission key of the grant authorizing *this* operation**. The operation's `x-permission`, resolved against `Session.bundle_snapshot`|
| `melarc.hub_scope_mode`| **`SET`** or **`ALL`** — **resolved from that grant**, never from the Session as a whole|
| `melarc.authorized_hub_ids`| The effective Hub set: **that grant's scope intersected with `Session.authorized_hub_ids`**|
| `melarc.vendor_organization_id`| For `VENDOR` principals|
| `melarc.rider_id`| For `RIDER` principals|
| `melarc.correlation_id`| The request or idempotency identifier `audit.md` §3 already requires|
| `melarc.scope_probe_id`| **Set only by the repository function `existingRecordHub(entity, id)`** (§14.4b), and by nothing else: the one record id the scope probe may see across hubs. NULL otherwise, so the probe disjunct is never true|

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

**Steps 4 and 5 are the whole correction.** Everything else was already here.

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
| `surface`| One of the four allowed surfaces, and permitted for this principal type|
| `correlation_id`| Present, and of the form `audit.md` §3 requires|

**If any value fails, security-context establishment fails: the request or job is refused and the protected business query does not execute.** No transaction is opened, so there is nothing to roll back and nothing reaches the pooled connection.

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
2. **The probe is a separate, short statement** — `SELECT id, responsible_hub_id FROM <entity> WHERE id = $1` — run under a transaction-local context value, `melarc.scope_probe_id`, set by the repository function `existingRecordHub(entity, id)` and by nothing else. **The STAFF branch of every hub-scoped policy carries one further disjunct**, generated by the policy template and never written by hand: `OR id = melarc.scope_probe_id()`. With no probe id the accessor is NULL and the disjunct is never true (§14.4a).
3. **It names one id and reads two columns.** It cannot enumerate. Its result is used for one decision — a row that exists is `HUB_SCOPE_VIOLATION`, no row is `NOT_FOUND` — and **the probed row is never loaded, returned or logged.**
4. **List endpoints never probe.** A list is filtered silently, and says nothing about what it did not return.
5. **Nothing is added to the audit set.** `audit.md` defines no denied-access event for a hub refusal, and this section does not add one: the refusal is a request-log entry, never carrying the probed row. Which denials need an event is a coverage question the Product Owner approves.

**A test asserts all four properties:** the probe runs only for staff, only after a filtered read found nothing, never returns more than the hub id, and a Vendor or Rider reaching the same id gets the nonexistent answer byte for byte.

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

`MSC-DEC-276`. Four roles at first and six in the table now — §14.17 is the full set of seven identities — and neither runtime role can bypass what protects it.

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

### 14.7 Worker and non-human service authority

`MSC-DEC-279`. **A queue message is not authority.** The order of operations is the control:

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

**Step 3 is the correction, and its position is the whole of it**. R0 required *establish scope, reload, compare* and left the scope being established **coming from the job payload** — so the payload selected the authority under which it was then validated, and **a forged or stale envelope validated itself**, because both sides of the comparison came from the same untrusted source.

**The envelope is written by the application inside the same business transaction as the mutation it describes**, carrying `outbox_id`, aggregate type and id, event/task type, authoritative `responsible_hub_id`, `vendor_organization_id` and rider/assignment id, originating principal, `operation_id`, correlation id, idempotency linkage, timestamp and the minimum payload. **Every scope field is derived from the authoritative row inside that transaction** and none is ever accepted from HTTP input, client payload, broker headers or worker payload.

**Immutable once committed:** aggregate identity · event/task identity · Hub, Vendor and Rider scope · originating authority · correlation and idempotency linkage. **The relay may update only its narrow delivery bookkeeping columns and may never rewrite the envelope.**

**The broker carries `outbox_id` and nothing authoritative.** Convenience metadata may ride along; it never establishes scope, never overrides the stored row, and is rejected or ignored when inconsistent.

**The bootstrap read is a technical capability, not business authority.** `Outbox` is a `SYSTEM` table whose business-principal branches are all `DENY`; the worker may fetch **one row by id**, and **no API operation exposes an arbitrary Outbox read**.

`BACKGROUND_JOBS_AND_EVENTS.md` §3.4 already required the re-check and named the hazard — *"a notification job that resolves its recipient from a stale payload can send one vendor's parcel details to another"*. This fixes the sequence that makes the re-check mean something.

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

**Browser headers:** strict allowed `Origin` list · **no wildcard credentialed CORS** · CSP · `frame-ancestors 'none'` unless specifically approved · `X-Content-Type-Options: nosniff` · restrictive Referrer Policy · `no-store` on authentication, recovery and other sensitive responses · **exact `Origin` validation on browser-sensitive flows, pre-session endpoints included.**

**The login-CSRF threat model §13.12 deferred is answered by that last clause.** A session-fixation or login-CSRF attempt necessarily arrives at an endpoint where no session yet exists, which is precisely where a session-cookie-based defence has nothing to check.

### 14.9 Key, secret and credential custody

`MSC-DEC-281`. Managed secret store; managed KMS; **workload or federated identity** for production workloads where the platform supports it, rather than embedded long-lived cloud credentials.

| Material| Treatment| Why not the others|
|---|---|---|
| **TOTP seed**| **Encrypted** — authenticated envelope encryption; ciphertext plus key id, key version and nonce; KMS to decrypt; plaintext never persisted, never logged, never in audit or analytics| The server must **recompute** the expected code, so it cannot be hashed|
| **Password / PIN**| Argon2id **plus a versioned pepper held outside PostgreSQL**; the hash records `pepper_version`; successful authentication may rehash at the current version| Must **not** be recoverable, so it cannot be encrypted|
| **Session, `SetupGrant`, `RecoveryRequest`, CSRF, device secrets**| High-entropy random; **cryptographic hash persisted**, never the value| Needs neither recovery nor brute-force hardening beyond its own entropy — **human-password cost buys nothing and is paid on every request**|
| **Provider secrets**| Managed secret store, service identity only, quarterly rotation and on suspected compromise (§9, `DEPLOYMENT_AND_ENVIRONMENTS.md` §5)| Never a business setting (§33.3, §35.9.4)|
| **Deployment credentials**| Short-lived federated/OIDC where supported (§14.11)| A long-lived pipeline key is a standing production credential|

**Why the pepper is versioned rather than simply rotated.** An unversioned pepper can be rotated exactly once, destructively: every hash computed under the old value becomes unverifiable the moment the new one is installed, and **every user in the product is locked out simultaneously, with no signal saying why.** `pepper_version` on the hash makes rotation additive — old hashes verify under their own version, and rehash-on-successful-authentication migrates the population without a flag day.

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

**The mechanism is tamper-evident, not tamper-proof.** It detects modification, deletion and insertion after the fact and proves the detection with a KMS signature. It does not prevent a sufficiently privileged infrastructure actor from destroying both stores. **No global synchronous hash lock** is imposed on business transactions — that would serialise the product on one lock against a threat with no evidence behind it, and §42.8's availability target is company-wide. Enhanced-audit actions requiring synchronous primary audit **fail closed** when the record cannot be durably written. The mirror may be asynchronous and **must be monitored**; its failure alerts (`OBSERVABILITY_AND_RECOVERY.md` §3).

**Telemetry separation.** Logs and traces are not the ledger. Central redaction covers `Authorization`, `Cookie`, `Set-Cookie`, `X-CSRF-Token`, passwords, PINs, TOTP values and seeds, `SetupGrant` and `RecoveryRequest` tokens, Vendor device credentials, Session credentials, signed Evidence URLs, provider secrets, and sensitive authentication, payment and evidence request bodies — across **application logs, worker logs, reverse-proxy logs, traces and APM, and exception reporting.** **Exception handlers leak more than ordinary logs**, because a stack frame carries the arguments an access log never sees, which is why §14.13 requires failure-path redaction tests and not only happy-path ones.

**Backup and production access**. The backup plane — snapshots, WAL/PITR archives, object versions — is encrypted, separately access-controlled, **unreachable with application credentials**, protected against accidental deletion, and restorable only through a controlled procedure. **Encryption at rest defends the medium and does nothing about an application credential that can delete snapshots**, and `DEPLOYMENT_AND_ENVIRONMENTS.md` §6 makes the WAL archive the actual recovery position.

**Restore drills: one full test before production launch, then quarterly**, in an isolated environment, never overwriting production. **No standing shared human production database credential.** Emergency infrastructure access is individually attributable, MFA protected, time bounded, reason bound and infrastructure audited. **CI/CD** uses short-lived federated identity where supported, with build, staging deploy, production deploy and migration separated — and **a migration identity does not thereby gain broad business-data read authority.**

### 14.12 Rate-limit buckets

`MSC-DEC-285`. Six buckets, each keyed on the credential-oriented identity `MSC-DEC-224` already fixed: **Staff sign-in** (normalized Staff identity) · **privileged MFA** (challenge/principal) · **Vendor sign-in** (account **and** registered device) · **Rider challenge/sign-in** (rider **and** registered device) · **recovery** (recovery principal) · **authenticated API** (active Session).

The keys live at [settings.md](../contracts/settings.md) §7.7 and **every one carries a launch value**. `OQ-077` — *"how many buckets the limits need is a design choice rather than a value"* — was answered on 27 August, and **`OQ-067`, the figures, on 5 September.** Production readiness distinguishes *the bucket architecture exists* from *the launch values have been supplied*, and **both statements are now true** — which is why they closed nine days apart rather than together. **Post-launch telemetry recalibrates the values through controlled configuration and may not change the bucket architecture or the credential keying.**

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

**R0's defect was a disclosure channel, not a collision.** `Idempotency-Key: retry-1` is an ordinary string, and two vendors choosing it on one operation is what two independent clients *do*. Under a global key the second caller did not receive an error — the record existed, so it received a **replay of the first caller's stored result.** One vendor's response body returned to another, through the mechanism that exists to make retries safe. **`payload_hash` did not save it**: two vendors booking the same shape of request produce the same hash, which reads as *the same call*.

### 14.17 Technical identities, and the migration authority R0 could not describe

`MSC-DEC-289`. Seven identities, separated **enforceably at the database and infrastructure boundary** rather than by documentation.

| Identity| May| May not|
|---|---|---|
| `melarc_owner`| Own schemas and tables. **`NOLOGIN`**| Ever be a runtime, relay, scheduler or standing human login|
| `melarc_api_runtime`| Application DML under RLS · own-principal idempotency rows · `Outbox` `INSERT` inside an authorised business transaction| DDL · alter policy · own tables · `BYPASSRLS` · grant roles · assume migration or owner authority · mutate audit history|
| `melarc_worker_runtime`| Bootstrap read of the `Outbox` envelope **for an assigned task class** · envelope-derived SYSTEM context · task-required DML · task-required audit writes| **Any default all-business-table read** · unrelated tables · role alteration · DDL|
| `melarc_scheduler_runtime`| Enqueue the minimum scheduled-work intent| Generic business-table DML|
| `melarc_outbox_relay_runtime`| Read relayable `Outbox` rows · publish · update narrow relay bookkeeping columns| Read arbitrary business tables · mutate aggregates · **rewrite envelope authority**|
| `melarc_migration_elevated`| Approved DDL, schema, ownership and RLS operations| Be reused as **any** runtime identity|
| Backup / restore plane| Backup and restore only| Be an application database login|

```sql
ALTER ROLE melarc_api_runtime       NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
ALTER ROLE melarc_worker_runtime    NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
ALTER ROLE melarc_scheduler_runtime NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
ALTER ROLE melarc_outbox_relay_runtime NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
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

**Every capability exists because a documented job needs it** — the list is `BACKGROUND_JOBS_AND_EVENTS.md` §4 and §3.5 plus the two technical tasks R1 defines. **No speculative role is created for work nobody has specified.**

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

§37.6 already makes negative-access tests mandatory at five surfaces (§7). Gate B adds the layers beneath them, and [security-test-matrix.md](../standards/security-test-matrix.md) is the canonical enumeration. The four families that cannot be satisfied by an ordinary integration test:

- **Pooled connections** — four cases, each **forcing reuse of the same physical connection**: Hub A then Hub B; Hub A then a request with no context; an all-Hub request then an ordinary one; and a rolled-back transaction followed by a reuse. A test on a fresh connection proves nothing here.
- **Database privilege** — **every runtime identity** (`melarc_api_runtime`, `melarc_worker_runtime`, `melarc_scheduler_runtime`, `melarc_outbox_relay_runtime`) must **fail** when it attempts `BYPASSRLS`, ownership, policy alteration, RLS disablement, DDL on a protected table, self-granting a role, **or assuming `melarc_migration_elevated` or `melarc_owner`**. **Assert the refusal, not the configuration.**
- **Worker isolation** — envelope/object mismatch across Hub and Vendor, missing worker scope, a forged payload scope, all-Hub attempted by a task class not approved for it, and the outbox relay attempting business DML.
- **Failure-path redaction** — every secret category, exercised through an **error** path as well as a success path.

### 14.14 Environment rules

`DEPLOYMENT_AND_ENVIRONMENTS.md` §3 defines three environments; Gate B constrains what each may relax.

| Environment| Rule|
|---|---|
| **Local**| May use simplified infrastructure, but tests must preserve the **logical** security boundaries — RLS policies, role separation and scope classes are exercised, not stubbed|
| **Staging**| Exercises **real** RLS policies, real DB-role separation, and representative cloud security controls where feasible|
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
| **Enrolment and replacement** (`registerRiderDevice`, `reregisterRiderDevice`, `completeRiderDeviceEnrolment`)| Senior Ops in person; the handset generates a hardware-backed signing key with the attestation challenge the QR carries and submits only the public half and its attestation chain; a replaced or revoked record is kept, never deleted| The single-use grant, and with it the challenge; **the attestation policy at §15.2.1**. Nothing is written unless all of it passes|
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

1. **Structure.** The chain parses, and the key attestation extension is read from the **first** occurrence in the chain, never assumed to be the leaf. Unparseable → `DEVICE_INTEGRITY_FAILED`.
2. **Security level.** `attestationSecurityLevel` and `keymasterSecurityLevel` are `TrustedEnvironment` or `StrongBox`. `Software` → **`DEVICE_SECURITY_UNSUPPORTED`**. It is checked here because the missing capability is the cause whatever the chain's root.
3. **Chain validity.** Each certificate signs the next and is within its validity period. **One exception:** the expiry of the device's *factory* attestation certificate alone does not refuse — Google documents devices launched before 2021 as carrying expired factory keys that remain trustworthy unless revoked.
4. **Trust roots.** The chain ends at one of the **accepted Android attestation roots**, the set Google publishes, held as configuration.
5. **Revocation.** No certificate in the chain is on Google's attestation revocation list.
6. **Challenge.** The attested challenge equals the challenge issued with the grant — compared in constant time against `SetupGrant.attestation_challenge_hash`. **Its validity window is the grant's lifetime** (`recovery_link_ttl_minutes`, 30) **and it is single-use with the grant**: an unknown, expired, consumed or superseded grant is `SETUP_GRANT_INVALID` before any evidence is read. A challenge that does not match is `DEVICE_INTEGRITY_FAILED`.
7. **Application identity.** The attested package name equals the configured Melarc Rider package, and **every** signing-certificate SHA-256 digest the extension reports is in the **approved digest set**.
8. **Device state.** In the **hardware-enforced** authorization list's `RootOfTrust`, read from the first attestation extension in the chain, `deviceLocked` is `true` **and** `verifiedBootState` is `Verified` — the enumeration is `Verified`, `SelfSigned`, `Unverified`, `Failed`. **Validated at Gate PD-3R1:** both fields are read **only** from the hardware-enforced list, never from the software-enforced one that a compromised operating system could populate; an absent `RootOfTrust`, `SelfSigned` (a boot key the user set, including a custom ROM re-locked with its own key), `Unverified` and `Failed` all fail this step as `DEVICE_INTEGRITY_FAILED`. `verifiedBootKey` and `verifiedBootHash` are recorded in the attestation summary and **compared with nothing**, and the operating-system patch level is not a criterion. Product has no objection to either control. **Consequence, accepted:** a handset running a custom ROM, however well locked, cannot enrol.
9. **Key properties.** The key was generated on the device (`origin` `GENERATED`, never imported) and is a signing key (`purpose` includes `SIGN`) — what `MSC-DEC-264` already requires of the registered key.
10. **Key binding.** The attested public key equals, byte for byte, the `public_key` submitted for registration.

Steps 1 and 3 to 10 failing is `DEVICE_INTEGRITY_FAILED`, audited as `auth.device.attestation_failed` with its cause class; step 2 failing is `DEVICE_SECURITY_UNSUPPORTED`, audited the same way. **Nothing outside the extension is trusted**, and the operating-system patch level is not a criterion, and the minimum Android version is 24 (above).

**Atomic.** On success, in one transaction: the device is registered `ACTIVE`, the grant consumed, the PIN set, and — for a replacement — an `ACTIVE` old device becomes `REPLACED` and its live session ends `DEVICE_REPLACED`, with `auth.device.registered` and `auth.device.replaced` written together. **A refusal creates no device, consumes no grant and sets no PIN, and a refused replacement leaves the existing device exactly as it was.** Two completions of one grant race to one winner; the other is `SETUP_GRANT_INVALID`. A newer grant of the same purpose supersedes an older one, so only the latest can complete.

**Signing-certificate rotation.** The approved digest set is **configuration, not a constant**, and it holds more than one digest. To rotate: add the new certificate's digest before any APK signed with it is released; release; and once the minimum-supported-version gate has retired every build signed with the old certificate, remove the old digest. **Devices already enrolled are unaffected**, because attestation is evaluated at enrolment and not at sign-in; removing a digest refuses only new enrolments and replacements from builds signed with it. **An empty set, or a missing package name, makes production refuse to start** (`DEPLOYMENT_AND_ENVIRONMENTS.md` §12.3). The package name and the digest of the first production certificate exist only when the signing key does; they are a release input.

**The one external dependency: trust data.** The accepted roots and Google's revocation list are a maintenance dependency of **enrolment and replacement only** — of `completeRiderDeviceEnrolment`, the one operation that evaluates the evidence. `registerRiderDevice` and `reregisterRiderDevice` only issue grants, and `requestRiderSignInChallenge` and `riderSignIn` need no trust data at all. **Every parameter — what is held, where it is loaded, what happens at start-up and when a load fails, the cadence, the maximum age, what the last-known-good copy may be used for, where the system fails closed and the alert threshold — is settled at §15.2.2.** **Trust data is checked first**, once the grant is found valid and before step 1: if the held list is older than the maximum age or none is held, or the roots cannot be loaded, **new enrolment and replacement fail closed** — `503` **`TRUST_DATA_UNAVAILABLE`** with a `Retry-After`, nothing written and the grant not consumed — not `DEVICE_INTEGRITY_FAILED`, because nothing is known to be wrong with the device, and not `DEVICE_SECURITY_UNSUPPORTED`; operations raise an alert. A handset that is told this tries again shortly, **and the grant is still good**. **Sign-in, every live session and every operation are unaffected.**

**The verifier sits behind an interface.** Authentication code consumes a `RiderDeviceAttestationVerifier` — for example an `AndroidKeyAttestationVerifier` in production and a `TestAttestationVerifier` elsewhere; the names are engineering's — and sees only its outcome: accepted, unsupported, integrity failed with a cause, or trust data unavailable. **It never handles a certificate**, so Android-attestation parsing lives in one place. The substitute produces each outcome **deterministically** from a controlled test input, so every row above is testable without a device and without production trust settings. **Production cannot select it**: configuration that does makes the application refuse to start (`DEPLOYMENT_AND_ENVIRONMENTS.md` §12.3), and a test proves it (`AC-SLICE-000-55`).

**One rider, one `ACTIVE` device — and the limit**. A rider has at most one `ACTIVE` production device, and **the database refuses a second one for the same rider**, so a stale grant or a race can never produce two; `registerRiderDevice` refuses it with `STATE_CONFLICT` and a change of handset is a replacement. **What is not enforced is one rider per physical handset.** That is an operating rule — a physical handset is intended for one rider at a time, deliberate sharing is not permitted, and Senior Ops verifies it in person during the enrolment or replacement ceremony. **The system cannot see it, and that is accepted:** each enrolment generates its own key and attestation proves what a key is, not which handset holds it, so two enrolments on one handset cannot be reliably identified as the same one. **Version 1 derives, stores and enforces no handset identifier for this** — no IMEI, serial number, Android ID, advertising ID, device fingerprint or ID attestation — and adds no MDM or Managed Google Play. The enforceable invariant is the rider-to-registered-key binding. Failed enrolment attempts stay rate-limited and every attestation refusal is audited as `auth.device.attestation_failed`.

### 15.2.2 Trust data — what is held, how often it is refreshed, and what happens when it goes stale

`MSC-DEC-429`'s engineering items, settled at Gate PD-3R1 and **accepted by the Product Owner for Version 1 at Gate PD-3R2**. **They remain engineering parameters, carry no Product authority and are deployment configuration, not business settings** — the acceptance records that Product has no objection to the figures, not that Product owns them. The Backend Engineer confirms them by approving this document.

| Question| Production| Local and Staging|
|---|---|---|
| **What is held**| The accepted Android attestation **roots** (configuration, reloaded on change) and Google's attestation **revocation list**, fetched from its published endpoint, validated and **held in memory by each API instance** with its fetch time. **Nothing is persisted**: the list is public, small and cheap to fetch again, and an instance that restarts loads it afresh| **Local:** the substitute verifier needs neither, and nothing is loaded. **Staging:** wherever the production adapter is selected, the loader runs and **every row of this table applies**|
| **Where it is loaded**| **Inside each API instance, by the verifier's own loader on an in-process timer.** It is not a scheduled job, a worker task, an outbox message or a broker consumer, so it uses no scheduler, no worker identity, no database write and no lock, and it does not depend on `OQ-115`. It needs egress from the API runtime to Google's published endpoint| Local: not run|
| **At start-up**| An instance **loads at start** and holds no list until the first load succeeds. **No list is treated as infinitely old**: enrolment and replacement answer `503` `TRUST_DATA_UNAVAILABLE` until it does, so a restart never serves a list the instance has not itself loaded. Sign-in does not wait| —|
| **Refresh cadence**| Every **6 hours**| —|
| **Maximum acceptable age**| **24 hours** from the held list's fetch time — `ATTESTATION_TRUST_DATA_MAX_AGE_HOURS`, **required in production and greater than 6**, so a list always outlives one cadence| —|
| **A load fails while the list is within its maximum age**| The **last-known-good** list this instance holds keeps serving. The loader retries **every 15 minutes**, with no growth in the interval, until it succeeds — **the age alert is its bound** — and logs and counts each failure (`attestation_trust_data_load_failures_total`). A fetched list replaces the held one **only if it parses, validates against its schema and is non-empty**; otherwise it is discarded and counts as a failure. The fetch time-out and a size ceiling are deployment configuration| —|
| **What last-known-good may be used for**| The enrolment and replacement checks, **until the maximum age**, and for nothing else. **Never past 24 hours, and never when the accepted roots failed to load**| —|
| **Where the system fails closed**| When the held list is **older than 24 hours** or none is held, or the roots cannot be loaded: new enrolment and replacement answer **`503` `TRUST_DATA_UNAVAILABLE`** with a `Retry-After`. Only `completeRiderDeviceEnrolment` evaluates trust data, so a ceremony can begin while the loader is failing and is refused when the handset completes it — **retryable, with the grant still good**. Sign-in, every live session and every operation are unaffected| —|
| **Alert**| The gauge `attestation_trust_data_age_seconds` is, per instance, **the time since the held list was fetched, or since the process started when none is held**. **SEV-3 when the oldest instance's list is older than 12 hours; SEV-2 when it is older than 24 hours**, or when the accepted roots cannot be loaded — enrolment is then failing closed (`OBSERVABILITY_AND_RECOVERY.md` §3.2). **Owner: the Backend Engineer**, through the standard operational alert path of `OBSERVABILITY_AND_RECOVERY.md` §3.1, with the runbook at §4.3a there; the owner tells Senior Ops when an enrolment or replacement is blocked, because that is a rider who cannot yet work. **A failed load inside the bound is not an alert**: it is the design working, and the counter and the log are for diagnosis| —|
| **Startup**| Production **refuses to start** if the maximum age is unset or not greater than 6, or the accepted roots are empty (`DEPLOYMENT_AND_ENVIRONMENTS.md` §12.3)| —|

**Why these numbers.** The revocation list changes rarely, and a stale copy errs toward accepting a revoked certificate, so the bound is a day and not a week. A six-hour cadence with a **fifteen-minute retry** gives a failing source about ninety attempts inside the bound before enrolment stops, so **the retry, not the cadence, is what makes a transient outage harmless**. Twelve hours leaves most of a working day to act before enrolment stops. **They are configuration, recalibrated from telemetry, not redesigned.**

**Why in memory, and what that trades.** The list is public and cheap, so persisting it would add a technical table, a registry classification and a database identity for a value any instance can fetch again — and the scheduler runtime, which only enqueues (§14.6, §14.7), could not have written it. The price is that **a restart loses the last-known-good copy**: if the source is unreachable at the moment an instance starts, that instance refuses enrolment until it can load, where a persisted copy would have served it. Enrolment is rare and retryable, and failing closed at start is the safe side of that trade; a persisted cache would be a later, deliberate change with its own registry row.

**How it is proved.** The loader's cadence, retry, replace rule, start-up behaviour and age arithmetic are unit-tested with an injected clock and a fake source; `AC-SLICE-000-69` proves the refusal and `AC-SLICE-000-75` the substitute's *trust data unavailable* outcome; the two alert thresholds are asserted in the rehearsal that `SLICE-000` §7 item 6 names.

**Root rotation** is a maintenance event, not a code change: Google publishes a new root, it is added to the configured set before chains start ending at it, and nothing else moves. The verifier's refusals are audited with their cause class (`auth.device.attestation_failed`), so a chain ending at an unknown root is visible as a rate and a rotation the configuration missed does not go unnoticed.

### 15.3 Mid-session revocation — the Session record is the revocation store

*Rewritten at Gate PD-3R1. Added on 13 September 2026 by CRIT-02 as a Redis blocklist; withdrawn here.*

**The selected component is PostgreSQL, and no other store exists.** §13.1 made sessions opaque and **server-side**: every request looks the session up by `token_hash` and refuses one that is not `ACTIVE`. Revocation is therefore a state change on that same row, made **in the same transaction as the act that caused it**: a suspension, a status change, an administrative revocation, a device revocation or replacement, a credential change or an authority change each set the session `TERMINATED` with its reason ([state-machines.md](../contracts/state-machines.md) §13). The next request is refused with `401 SESSION_INVALID`. **There is no interval in which a decision exists and its effect does not.**

| Question| Answer|
|---|---|
| **Store**| PostgreSQL: `Session`, and `RegisteredDevice` for device status|
| **Key model**| Primary key `id`; a **unique index on `token_hash`**, the lookup key of every request; a partial index on `(principal_type, principal_id)` where the state is `ACTIVE`, for *all live sessions of this principal*|
| **Lifetime**| `expires_at` and, for browsers, `last_activity_at` are evaluated on every request, and the `expire_sessions` job (`BACKGROUND_JOBS_AND_EVENTS.md` §3.5) closes the records. A record that is not `ACTIVE` is history, kept under the audit retention rule|
| **Failure behaviour**| **Fail closed.** If PostgreSQL cannot be reached the request cannot authenticate and is answered `503` **by the platform, outside the operation contract** (no operation declares a `5xx` for an infrastructure outage); **nothing is served from a stale copy**|
| **Process ownership**| The `platform/auth` module is the only writer of `Session`. Every authority-changing operation calls its `terminateSessions(principal, reason)` inside its own transaction|
| **Environment configuration**| None beyond the database connection: no cache, no broker, no TTL setting, and the same in Local, Staging and production|

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
