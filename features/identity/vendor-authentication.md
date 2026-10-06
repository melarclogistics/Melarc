# Vendor authentication

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.23 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** the shared vendor credential, its single-session rule, and the attribution limit it imposes on every record a vendor touches
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §11.2, §37.2, §37.3, §37.5, §37.6, §29.3, and cross-cutting §35, §37.1, §38, §42
> **Slice:** `SLICE-000`

## 1. What this is, and why

Each vendor organisation holds **one shared credential**, permitting **one active session and device**. A new successful login **ends the earlier session** (§11.2, §37.2).

This is a deliberate Version 1 simplification with a cost the specification states in its own section — §37.5, *"Shared vendor credential risk"*. Melarc chose it knowing what it gives up, and **the most important consequence is not security but attribution**: the system knows *which vendor* acted and can never know *which person*.

**Version 1 boundary.** Authentication only. Vendor onboarding, suspension and saved pickup locations are §29 features, written as [vendor-onboarding-and-allowance.md](../vendor/vendor-onboarding-and-allowance.md), [vendor-suspension.md](../vendor/vendor-suspension.md) and [vendor-pickup-locations.md](../vendor/vendor-pickup-locations.md); offboarding retention is `OQ-028`'s.

## 2. Governing sections

| Section| What it governs here|
|---|---|
| §11.2| One shared credential, one active session, new login ends the old|
| §37.2| The same as security policy, plus recovery through registered phone or email|
| §37.3| A vendor account accesses **only its own** requests, orders and tracking|
| §37.5| **The shared-credential risk section** — five consequences, all binding|
| §37.6| Data ownership is **not SaaS tenancy**|
| §29.3| Portal access model|
| §37.1| Deny by default|


## 3. Surfaces and actors

| Surface| Actor| Can do| Gated by|
|---|---|---|---|
| Melarc Vendor| Vendor account| Sign in; work as the organisation| —|
| Melarc Ops| Platform Admin| Exceptional vendor recovery (§37.2); end a vendor session (§37.5)| `vendor.credential.recover`, `staff.session.revoke`|
| Melarc Ops| Senior Ops, Platform Admin| Re-issue a lapsed setup grant| `vendor.organization.approve`, own hub|
| Melarc Ops| Ops Staff, Senior Ops, Platform Admin, Finance| Read an account's authentication readiness, within the caller's grant — never a credential| `vendor.read` — own hubs for Ops Staff and Senior Ops, all hubs for Platform Admin and Finance|
| Melarc Ops| Ops Staff| **Cannot** recover a vendor credential| —|
| Melarc Rider| —| **N/A**| —|

## 4. Preconditions

- The `VendorAccount` exists and is **`ACTIVE`**. Suspension blocks the credential (§37.3, §29.6).
- `VendorCredential` carries **at least one** recovery channel — registered phone or email (§37.2).

## 4.1 The registered browser holds a credential nobody types

**The sign-in form does not ask for a device identifier**. The registered browser proves itself with a **server-generated high-entropy device credential**, stored hashed server-side and delivered in a long-lived `HttpOnly` cookie bound to the `VendorAccount` (`Max-Age=34560000`, 400 days, renewed at each vendor sign-in — [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.2).

Vendor sign-in is therefore **shared secret + registered browser**. The shared secret is the human-known half; the device credential is what a stolen shared secret alone cannot defeat.

**Rider-style hardware keys are deliberately not used here.** The Vendor PWA is a browser used by **several people on one shared account**, and a person-oriented passkey flow would model an individual that Version 1 deliberately does not have (§37.5). The device credential protects the account without pretending it belongs to a person.

## 4.2 First credential establishment exists now

Vendor sign-in required an account identifier, a shared secret and a device identifier — and **no process established any of them.**

When an approved `VendorAccount` is ready for access, a one-time `VENDOR_CREDENTIAL_SETUP` grant is issued to its **registered recovery channel** — the credential's `delivery_channel`, the phone or the email the approver chose at approval ([domain-model.md](../../contracts/domain-model.md) §6.8). The vendor uses it to set the shared secret, register the current browser, consume the grant and become authentication-ready.

**The administrator never learns the vendor's permanent shared secret.** Vendor organisation approval and business administration remain `SLICE-008`; Gate A defines only the boundary at which an approved account becomes able to authenticate.

## 4.3 The account identifier

Sign-in asks for an **account identifier**, and until Gate PD-3R1 nothing produced one. `VendorAccount.account_identifier` is **eight characters from an alphabet with no `0`, `O`, `1`, `I` or `L`**, drawn when the account is created, **unique, immutable and never reused**, compared without regard to case, and delivered **in the setup message beside the grant** and shown to Ops by `getVendorAccount` ([SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.7a). **It is not a secret and not a control**: the registered browser and the shared secret are the controls, so a wrong identifier is answered exactly as a wrong secret is and its guessability never protects anything.

## 5. Behaviour

### 5.1 Normal path

1. **The vendor submits the account identifier and the shared secret, and the browser presents its device credential.** **Three factors, all required**. Nobody types a device identifier (§4.1): the `HttpOnly` cookie travels automatically and the server compares it against the stored hash.

   **Until 27 August the third factor was decorative.** The credential was issued at setup and **required by no operation**, so a stolen shared secret alone signed in from any browser — the exact outcome the device credential exists to prevent. The contract now declares it as a `vendorDevice` security scheme, so an implementation cannot omit it and pass a check.
2. **The server verifies the credential and that the account is `ACTIVE`.**
3. **Any existing live session is terminated** with `SUPERSEDED_BY_NEW_LOGIN` (state-machines §13).
4. **A session is issued** as an `HttpOnly` `melarc_session` cookie — a **real `Set-Cookie` field line**, alongside `melarc_csrf`. **The device credential is proved here, never re-issued**: a login that silently registers whatever browser presents itself registers an attacker's browser too. Registration happens only at **setup** and **recovery**. **Renewing is not re-issuing**: a vendor sign-in from a registered browser re-sends the credential it presented with a fresh `Max-Age`, so a browser in daily use never lapses, and the value is neither rotated nor registered anywhere new. The contract declared two of those three through invented `X-Set-…` headers until R1.1; **a literal implementation would have shipped a vendor second factor that never reached the browser**. The session is scoped to *own records only* — the ownership axis, not a hub axis (§37.3). A **readable** `melarc_csrf` cookie is set alongside it, and every unsafe request must echo it in `X-CSRF-Token`. **That cookie is deliberately not `HttpOnly`** — the page must read it to echo it, and it is useless to an attacker who cannot read the session cookie.
5. **No second factor.** §11.2 confines MFA to Senior Ops and Platform Admin.

### 5.2 The attribution limit, and why it is a product rule rather than a technical one

§37.5 states it plainly: **audit identifies the vendor account, not a named employee.**

Every record a vendor creates — a booking, a payer-arrangement edit, a handshake code entry — is attributed to *the organisation*. Melarc cannot know whether Ama or Kwesi entered it, because the credential is shared by design.

**The rule this creates is a UI rule, and it is easy to break with good intentions.** §37.5: *"the UI must not claim person-level attribution."* A screen rendering "Approved by Ama" when the system holds only "vendor account 41" has **manufactured a fact**. A screen saying "Approved by your organisation" is accurate and less friendly, and accuracy wins — because the first version becomes evidence in a dispute Melarc cannot support.

**And a future multi-user model must preserve historical records** (§37.5). When per-person vendor accounts arrive, records made under the shared credential stay attributed to the account. They must not be retrospectively reassigned to individuals who were never identified at the time.

### 5.3 Exception paths

| Path| Behaviour| Error code|
|---|---|---|
| Wrong secret from a registered browser| Refused. Counts toward the lockout (§5.6)| `INVALID_CREDENTIALS`|
| A request from a **registered** browser while the credential is locked *(the fifth consecutive wrong secret is itself `INVALID_CREDENTIALS`)*| The credential is locked for `signin_lockout_minutes` — **for everyone using it**. The caller holds a browser registered to the account, so is told; the request is not verified or counted| `CREDENTIAL_LOCKED`|
| Suspended or otherwise not `ACTIVE` account| Refused. Indistinguishable at the surface| `INVALID_CREDENTIALS`|
| **Sign-in from an unregistered browser**, or with no device credential| **Refused, whatever the secret.** No session, no device credential issued, **nothing counted and never `CREDENTIAL_LOCKED`**. The only routes to registering a browser are setup and recovery, both requiring a grant to the account's registered channel| `INVALID_CREDENTIALS`|
| Unknown or wrong account identifier| Refused exactly as a wrong secret is. There is no account to count against| `INVALID_CREDENTIALS`|
| Colleague signs in elsewhere| This session is terminated. **The displaced device is told**| `SESSION_SUPERSEDED`|
| Rate limit exceeded| **10 a minute, keyed on the account and its registered browser** — one login used by many people is the highest-volume abuse path. Refused first, never verified, never counted| `RATE_LIMITED`|
| A vendor asks for, or acts on, another vendor's record| Refused **exactly as for a record that does not exist** — same status, code, body shape and timing (§37.3, §43.2, `MSC-DEC-432`). A Vendor is never told that a record belongs to someone else| `NOT_FOUND`|
| Shared secret shorter than 12 or longer than 128 characters at setup or recovery| Refused by the schema. The message names the field and **never the value**. Sign-in has a ceiling of 128 and no floor| `VALIDATION_FAILED`|
| Secret changed| **Every session terminates**, including the one making the change *(termination reason, not an error code)*| `CREDENTIAL_CHANGED`|

**The own-records rule is exercised where the records are built.** §37.3's *a vendor reaches only its own requests, orders and tracking* needs pickup requests and orders, which this slice does not create; its criterion is `AC-SLICE-001-79` (`pickup-request.md`), and the same-answer rule above is what that criterion tests.

### 5.4 What this feature must never do

- **Never claim person-level attribution anywhere on any surface.** §37.5. This is the rule most likely to be broken by a well-meaning UI decision.
- **Never permit two live sessions.** §11.2 is unambiguous, and the single-session rule is one of the few controls limiting a shared credential's blast radius.
- **Never distinguish which factor failed.** An unknown account, a wrong secret and an unregistered browser are one response, in content and in timing. Telling an attacker the secret was right but the browser was not tells them exactly which half they still need.
- **Never issue or rotate the device credential on ordinary sign-in.** That is setup's job and recovery's job, and no others.
- **Never present displacement as an error.** A colleague signing in is **routine**. `SESSION_SUPERSEDED` must read as *"someone at your organisation signed in on another device"*, not *"your session expired"* — the second invites a support call about a system working as designed.
- **Never leave prior sessions live after a credential change.** §37.5 requires recovery to *"revoke or control prior sessions"*. For a shared credential this **is** the point of recovery: the vendor is trying to remove someone else's access.
- **Never show permission or bundle management** on this surface (§11.1, `MSC-DEC-134`).
- **Never treat the vendor as a tenant.** §37.6: data ownership is not SaaS tenancy. There is no workspace, no member list, no invitation flow — and building one would contradict §37.3's "simple customer portal".
- **Never let the PWA and the WhatsApp path validate differently**. A rule enforced on one and not the other is a defect.

### 5.5 Adding a browser without credential rotation

**Registering a second or third browser does not require rotating the shared secret** — and before this section was written, there was no path that did not. The two operations `requestAdditionalDeviceGrant` and `completeAdditionalDeviceEnrolment` close that gap.

**`requestAdditionalDeviceGrant`** — called from an already-authenticated session:
- Issues a **time-limited (`recovery_link_ttl_minutes` = 30 minutes), single-use OTP** to the account's registered recovery channel (phone or email).
- **Does not rotate the shared secret.**
- **Does not terminate any live session** — the existing browser and its session remain active.
- Creates a `SetupGrant` of purpose `VENDOR_DEVICE_ENROLMENT`, principal-bound and single-use.

**`completeAdditionalDeviceEnrolment`** — called from the new, as-yet-unregistered browser:
- Consumes the OTP grant.
- **Issues a new `melarc_vendor_device` credential** in the new browser, registered alongside any existing ones.
- **Issues no session** — the vendor signs in on the new browser afterwards, presenting the new device credential and the shared secret.
- The grant is consumed and may not be reused or recovered.

**Why this does not violate the single-session rule.** §11.2 governs *active sessions*, not registered devices. A vendor team may hold multiple registered browsers; only one may hold an active session at a time. Registering a new browser is the act of joining the pool of devices that *may* authenticate — it does not grant an active session, and normal sign-in's displacement behaviour (§5.1 step 3) continues to enforce the one-session ceiling.

**What multi-device still cannot do:**
- It cannot create two simultaneous active sessions — §11.2 is unaffected.
- It cannot bypass the credential-change termination rule — if the shared secret changes, every session terminates regardless of how many devices are registered (§5.3, `CREDENTIAL_CHANGED`).
- It cannot be initiated from an unregistered browser — `requestAdditionalDeviceGrant` requires an authenticated session, and unauthenticated browsers cannot initiate it.

**Rate limit:** `requestAdditionalDeviceGrant` is rate-limited like every credential operation and **never counts toward the sign-in lockout**, which only failed sign-ins do. A vendor organisation adding three devices locks nothing; a credential-stuffing attack meets the sign-in limit first.

### 5.6 Lockout on a shared credential

`MSC-DEC-431`, written at [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.4a and §13.4b.

- **Credential strength.** The shared secret is **12 to 128 characters, spaces permitted, no composition rule**, a constant of the contract. Sign-in has a ceiling of 128 and no floor.
- **The order.** The schema; then the **registered browser** (absent, unknown or bound to another account: `INVALID_CREDENTIALS`, the secret **not examined**); then the account `ACTIVE`; then the lock; then the secret. **A failure counts only once the request has reached the secret** — which is why an attacker on an unregistered browser can neither guess the secret nor lock a team out, the outcome `MSC-DEC-431` exists to prevent.
- **The lock** is set by the fifth consecutive failure and ends fifteen minutes later or when recovery completes. It is shared by every browser and every colleague, which §37.5 already accepts. A locked request from a registered browser is **told** (`CREDENTIAL_LOCKED`): it holds a browser registered to the account, so it could already attack the secret. **The lock ends no live session.**
- **Rate limiting is separate and first**: a request refused by `RATE_LIMITED` is neither verified nor counted.

## 6. Entities — *pointer*

| Entity| Where|
|---|---|
| `VendorAccount`, `VendorCredential`, `RegisteredDevice`, `Session`| [domain-model.md](../../contracts/domain-model.md) §6.8|
| `VendorOrganization`, `VendorSuspensionHold`| §6.9 — named, field detail deferred|

## 7. States — *pointer*

[state-machines.md](../../contracts/state-machines.md) **§13 `Session`** — vendors reach `ACTIVE` and `TERMINATED` only. **Approved 21 August** by `MSC-DEC-227`.

`VendorOrganization` states are §14, tables deferred.

## 8. Permissions — *pointer*

[permissions.md](../../contracts/permissions.md) §7. The Vendor bundle is **fixed and non-configurable** in Version 1 (§11.1, `MSC-DEC-134`), holding reads at **own-record** scope plus the booking and handshake actions.

## 9. Settings — *pointer*

[settings.md](../../contracts/settings.md) §7.5 — `session_lifetime_minutes` **720**, `session_idle_timeout_minutes` **30**, `signin_max_attempts` **5**, `signin_lockout_minutes` **15**. The Vendor PWA sits in the **Standard** tier with Ops Staff.

**The shared credential makes the lockout figure consequential.** `signin_max_attempts` is five for a credential a whole vendor team uses, so five wrong entries lock **everyone** out for fifteen minutes, not one person. `MSC-DEC-224` already identified the shared vendor login as the tightest rate-limit case for the same reason. **The lock is announced only to a registered browser** (§5.6), so nobody outside the team can use it to learn that an account exists.

## 10. Errors — *pointer*

[errors-and-enums.md](../../contracts/errors-and-enums.md) — `INVALID_CREDENTIALS`, `CREDENTIAL_LOCKED`, `SESSION_SUPERSEDED`, `RATE_LIMITED`, `NOT_FOUND`, `VALIDATION_FAILED`, `SETUP_GRANT_INVALID`, `RECOVERY_TOKEN_INVALID`, `PERMISSION_DENIED`, `INSUFFICIENT_AUTHORITY`, `HUB_SCOPE_VIOLATION`, `STATE_CONFLICT`, `REASON_REQUIRED`, `REASON_NOT_ACTIVE`, `CREDENTIAL_DELIVERY_FAILED` and `CSRF_VALIDATION_FAILED`. **`SESSION_SUPERSEDED` is a contract-wide rule, not a per-operation declaration**: every operation that authenticates a vendor session answers it to a displaced session, and none lists it ([errors-and-enums.md](../../contracts/errors-and-enums.md) §4). **`ATTEMPTS_EXHAUSTED` is a handshake code and is not returned by sign-in**, and **`OWNERSHIP_VIOLATION` was withdrawn** at Gate PD-3R1: nothing returns it, because a Vendor is told that another vendor's record is not found and never that it belongs to someone else.

## 11. Audit events — *pointer*

[audit.md](../../contracts/audit.md) §5.4. **Every event here carries the account as actor, never a person** — the audit contract's `actor` field holds the `VendorAccount` id, and no field exists to hold an individual, because none is known. **A refused sign-in is `auth.session.failed` with the factor reached and one cause from the catalogue's closed set; a lock is one `auth.lockout.applied`** — neither records a secret, and neither names a person.

## 12. API operations — *pointer*

`vendorSignIn`, `getCurrentSession`, `signOut`, `revokeSession` and `listSessions` — [openapi.yaml](../../contracts/openapi.yaml).

**Ops reads (Gate PD-3R1, `PDA-47`; confirmed by the Product Owner, `MSC-DEC-436`):** `listVendorAccounts` and `getVendorAccount` under `vendor.read` — identifier, organisation, status, the responsible hub, whether a secret and a recovery email or phone exist, and the account's browsers (identifier, kind, status, when and by whom registered), **never a credential or a recovery address**. **A vendor account is a global master record** (`SECURITY_DESIGN.md` §14.20) **and the two reads enforce the caller's grant scope**: hub staff read an account only where its organisation's responsible hub is one of theirs, and Platform Admin and Finance across hubs only where their grant reaches every hub; an existing account outside the caller's hubs is `HUB_SCOPE_VIOLATION` and one that does not exist is `NOT_FOUND`. `reissueVendorCredentialSetup` acts at the vendor's own hub, and `recoverVendorCredential` is Platform Admin at all hubs. `getVendorAccount` is where `recoverVendorCredential` and `reissueVendorCredentialSetup` take their `If-Match`, and `listVendorDevices` is where `revokeVendorDevice` takes its own.

**Additional browser registration:** `requestAdditionalDeviceGrant` (authenticated, `self`) and `completeAdditionalDeviceEnrolment` (pre-authentication, from the new browser) — §5.5.

**Device visibility and removal:** `listVendorDevices` and `revokeVendorDevice`, both `self`. **Added 21 September 2026 because multi-browser enrolment created the need for them**. While an account held exactly one browser, *“revoke the device”* and *“recover the credential”* were nearly the same act; with several, `completeCredentialRecovery` is a sledgehammer — it rotates the shared secret, ends every session and revokes every device. **Revocation here leaves the secret untouched**, terminates only the session bound to that device (`DEVICE_REVOKED`), and **refuses the browser the caller is using** (`STATE_CONFLICT`), because signing out is what `signOut` is for.

**Both were missing from this list, and from the contract, from 13 to 20 September 2026.** §5.5 described them, `AC-SLICE-000-45` tested them, **this pointer did not name them and `openapi.yaml` did not contain them** — nor did any enum hold the `VENDOR_DEVICE_ENROLMENT` purpose they turn on. A feature document that names an operation the contract lacks is a specification of nothing; that this document also contradicted *itself* two sections apart is what made it survivable for a week. They are built as of `openapi.yaml` v5.35.

**Credential lifecycle:** `completeVendorCredentialSetup` (first secret), `requestCredentialRecovery` and `completeCredentialRecovery` (self-service), **`recoverVendorCredential`** (Platform Admin, exceptional — split out of the former `performOpsRecovery` in R1), and **`reissueVendorCredentialSetup`** (MED-10 audit remediation).

**`reissueVendorCredentialSetup` is establishment repeated, not recovery.** Vendor organisation approval issues exactly one `VENDOR_CREDENTIAL_SETUP` grant, at the ordinary 30-minute lifetime; an account that never acted on it before it lapsed has no shared secret for `recoverVendorCredential` to repair. Senior Ops or Platform Admin re-issues it under `vendor.organization.approve` — the approval authority exercised again — to the credential's `delivery_channel`, guarded on the secret still being `NULL` so an account that has already established one is refused with `STATE_CONFLICT` and pointed at recovery instead.

**Recovery rotates the shared secret *and* the browser device credential together**, and R1.1 made the contract actually do it. Completing recovery replaces the secret, terminates sessions with `CREDENTIAL_CHANGED`, **revokes obsolete device credentials and issues a fresh `melarc_vendor_device`** to the browser completing recovery.

**Until 27 August it rotated only the secret.** The completion response set no cookie at all — so the person the vendor was removing kept a registered browser, which is half the credential, **and the account the vendor had just "recovered" was still reachable from their machine.** On an account shared by design, that is the whole of what recovery exists to prevent.

**Recovery creates no Session.** The vendor signs in normally afterwards. A recovery link that issued a session would be an authentication path, which is the one thing a setup credential must never be.

## 13. Acceptance criteria

### `AC-SLICE-000-14` — A new login displaces the old one, and says so

```text
Given a vendor account with a live session on device A,
When the same credential is used to sign in on device B,
Then device B receives a session,
And device A's session is terminated with SUPERSEDED_BY_NEW_LOGIN,
And device A receives SESSION_SUPERSEDED on its next call,
And the message identifies this as another sign-in rather than an expiry.
```

**Governs:** §11.2, §37.2 · **Surface:** Melarc Vendor · **Test level:** integration · **Code:** `SESSION_SUPERSEDED`

### `AC-SLICE-000-15` — No surface claims person-level attribution

```text
Given a record created under a vendor's shared credential,
When any surface displays who performed the action,
Then it names the vendor organisation,
And no screen, export or notification names an individual,
And the audit event holds the VendorAccount id with no person field populated.
```

**Governs:** §37.5 · **Surface:** Melarc Vendor, Melarc Ops · **Test level:** e2e

### `AC-SLICE-000-17` — A credential change terminates every session

```text
Given a vendor account with one live session, and a second registered browser whose earlier session that one displaced,
When the shared secret is changed,
Then every session terminates with CREDENTIAL_CHANGED,
And the session that performed the change terminates too,
And no session survives the change.
```

**Governs:** §37.5 · **Surface:** Melarc Vendor · **Test level:** integration

### `AC-SLICE-000-18` — The vendor surface exposes no permission management

```text
Given a signed-in vendor account,
When the vendor navigates the entire surface,
Then no screen offers bundle, permission or user management,
And no API operation available to this session returns permission catalogue data.
```

**Governs:** §11.1, `MSC-DEC-134` · **Surface:** Melarc Vendor · **Test level:** e2e

### `AC-SLICE-000-19` — The vendor sign-in ceiling is keyed on the account and its browser

```text
Given a vendor account with a registered browser,
When more than ten sign-in requests arrive within a minute for that account and browser,
Then further requests are refused with RATE_LIMITED,
And the ceiling is 10 a minute, keyed on the Vendor account and its registered device and not on the network address,
And a second registered browser of the same account has a bucket of its own,
And a refused request is neither verified nor counted toward the lockout.
```

**Governs:** `MSC-DEC-224`, `MSC-DEC-371` · **Surface:** Melarc Vendor · **Test level:** API · **Code:** `RATE_LIMITED`

### `AC-SLICE-000-45` — A second browser can be registered without displacing the first

```text
Given a vendor account with an active session on browser A,
When requestAdditionalDeviceGrant is called from browser A,
Then a time-limited single-use OTP is sent to the registered recovery channel,
And browser A's session remains active and unaffected,
And when the OTP is consumed on browser B via completeAdditionalDeviceEnrolment,
Then browser B receives a melarc_vendor_device credential,
And no session is issued to browser B,
And browser A's session is still active,
And browser B can subsequently sign in using its new device credential and the shared secret,
And that sign-in displaces browser A per the single-session rule.
```

**Governs:** §11.2, §37.2, `MSC-DEC-398`, `MSC-DEC-399` · **Surface:** Melarc Vendor · **Test level:** integration

### `AC-SLICE-000-41` — Nobody types a device identifier

```text
Given the vendor sign-in operation,
When its request schema is inspected,
Then it exposes no device_identifier property,
And the registered browser is proved by the device-credential cookie,
And a request from an unregistered browser is refused without revealing whether the secret was correct.
```

**Governs:** `MSC-DEC-265`, §37.7 · **Surface:** Melarc Vendor · **Test level:** contract · **Code:** `INVALID_CREDENTIALS`

### `AC-SLICE-000-42` — The administrator never learns the shared secret

```text
Given a VendorAccount approved and ready for access,
When the setup grant is issued to the credential's delivery_channel,
Then no Melarc staff operation returns the vendor's secret at any point,
And the secret is set by the vendor through completeVendorCredentialSetup,
And it is stored only as an Argon2id hash.
```

**Governs:** `MSC-DEC-265`, `MSC-DEC-263` · **Surface:** Melarc Vendor · **Test level:** integration

### `AC-SLICE-000-95` — Five wrong secrets from a registered browser lock the credential for everyone

```text
Given an ACTIVE vendor account, a registered browser and signin_max_attempts of 5,
When five consecutive wrong secrets are submitted from the registered browser,
Then each is refused with INVALID_CREDENTIALS,
And the fifth sets the lock for signin_lockout_minutes,
And a sixth request from that browser, the correct secret included, is refused with CREDENTIAL_LOCKED, is not verified and does not extend the lock,
And a sign-in from a second registered browser of the same account is refused the same way,
And auth.lockout.applied is recorded once and never holds an attempted value,
And after signin_lockout_minutes the correct secret signs in and the count is zero.
```

**Governs:** `MSC-DEC-431`, §37.5 · **Surface:** Melarc Vendor · **Test level:** API · **Code:** `INVALID_CREDENTIALS`, `CREDENTIAL_LOCKED`

### `AC-SLICE-000-96` — An unregistered browser can neither sign in nor lock the account

```text
Given an ACTIVE vendor account with a registered browser,
When any number of sign-ins, with the correct or a wrong secret, come from a browser that is not registered to the account or carries no device credential,
Then every one is refused with INVALID_CREDENTIALS, whatever the secret,
And none adds to the failed-attempt count, none sets a lock and none is ever answered CREDENTIAL_LOCKED,
And the registered browser can sign in with the correct secret straight afterwards,
And a wrong account identifier answers the same INVALID_CREDENTIALS and locks nothing.
```

**Governs:** `MSC-DEC-431`, `MSC-DEC-265` · **Surface:** Melarc Vendor · **Test level:** API · **Code:** `INVALID_CREDENTIALS`

### `AC-SLICE-000-97` — A shared secret outside 12 to 128 characters is refused

```text
Given a valid VENDOR_CREDENTIAL_SETUP grant and a valid recovery token for a vendor account,
When the secret is submitted at completeVendorCredentialSetup or completeCredentialRecovery as 11 characters, and as 129 characters,
Then each is refused by the schema with VALIDATION_FAILED, naming the field and never echoing the value,
And a 12-character secret and a 128-character secret containing spaces are accepted,
And no composition rule applies,
And vendorSignIn refuses a secret longer than 128 characters at the schema.
```

**Governs:** `MSC-DEC-431`, `MSC-DEC-263` · **Surface:** Melarc Vendor · **Test level:** contract · **Code:** `VALIDATION_FAILED`

### `AC-SLICE-000-98` — The account identifier arrives with the grant and is not a secret

```text
Given a vendor account created by approval,
When its setup grant is issued,
Then the setup message carries the account_identifier beside the grant and getVendorAccount shows it to Ops,
And the identifier is eight characters from the unambiguous alphabet, unique and immutable,
And vendorSignIn with a wrong identifier and the right secret is refused exactly as a wrong secret is,
And knowing the identifier alone changes no answer.
```

**Governs:** [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.7a · **Surface:** Melarc Vendor, Melarc Ops · **Test level:** API · **Code:** `INVALID_CREDENTIALS`

### `AC-SLICE-000-99` — Platform Admin can end a shared vendor session, and Senior Ops cannot

```text
Given a live vendor session found with listSessions,
When a Platform Admin calls revokeSession for it with a reason_code,
Then the session is terminated with ADMIN_REVOKED, an enhanced audit event is written and the vendor's next request is 401 SESSION_INVALID,
And the shared secret and the registered browsers are untouched,
And a Senior Ops user, who holds staff.session.revoke for riders only, is refused with INSUFFICIENT_AUTHORITY, and listSessions for the same principal is refused the same way,
And an Ops Staff user, who does not hold the key, is refused with PERMISSION_DENIED,
And an empty reason_code is refused with REASON_REQUIRED.
```

**Governs:** §37.5, §37.2, `MSC-DEC-432` · **Surface:** Melarc Ops · **Test level:** API · **Code:** `INSUFFICIENT_AUTHORITY`, `PERMISSION_DENIED`, `REASON_REQUIRED`

### `AC-SLICE-000-100` — A vendor sees and removes its own browsers, never the one it is using

```text
Given a vendor account with browsers A and B registered and a live session on A,
When the vendor lists its devices and revokes B with the ETag it read,
Then B is REVOKED, any live session bound to B ends with DEVICE_REVOKED and the shared secret is unchanged,
And revoking A, the browser making the call, is refused with STATE_CONFLICT,
And a request naming another vendor's device is refused with NOT_FOUND, identical to a device that does not exist,
And a stale ETag is refused with STATE_CONFLICT.
```

**Governs:** `MSC-DEC-398`, `MSC-DEC-432` · **Surface:** Melarc Vendor · **Test level:** API · **Code:** `STATE_CONFLICT`, `NOT_FOUND`

### `AC-SLICE-000-101` — A lapsed vendor setup grant is re-issued by approval authority

```text
Given an ACTIVE vendor account whose VENDOR_CREDENTIAL_SETUP grant expired with the secret still null,
When Senior Ops at the account's hub calls reissueVendorCredentialSetup with a reason_code and the ETag read with getVendorAccount,
Then a fresh grant and the account_identifier are delivered to the credential's delivery_channel and an earlier pending grant is superseded,
And an account that already holds a secret is refused with STATE_CONFLICT,
And an Ops Staff user, who does not hold vendor.organization.approve, is refused with PERMISSION_DENIED,
And an existing account outside the actor's hubs is refused with HUB_SCOPE_VIOLATION and one that does not exist with NOT_FOUND, the scope being decided before the version is compared,
And an empty reason_code is refused with REASON_REQUIRED.
```

**Governs:** `MSC-DEC-265`, `MSC-DEC-432` · **Surface:** Melarc Ops · **Test level:** API · **Code:** `STATE_CONFLICT`, `PERMISSION_DENIED`, `HUB_SCOPE_VIOLATION`, `NOT_FOUND`, `REASON_REQUIRED`

### `AC-SLICE-000-102` — An Ops reader sees an account's readiness within their grant, and never a credential

```text
Given a vendor account with a secret set and two registered browsers, whose organisation's responsible hub is Hub A,
When Ops Staff at Hub A call listVendorAccounts and getVendorAccount,
Then the account is shown with its identifier, organisation, status, whether a secret exists and how many browsers are ACTIVE,
And Ops Staff at Hub B do not see it in the list, filtering the list by Hub A returns them an empty page and no refusal, and getVendorAccount for it is refused with HUB_SCOPE_VIOLATION,
And getVendorAccount for an account that does not exist is refused with NOT_FOUND,
And a Platform Admin whose vendor.read grant reaches every hub sees it, and a Platform Admin or Finance user granted vendor.read for Hub B alone does not see it in the list and is refused getVendorAccount with HUB_SCOPE_VIOLATION,
And no response contains a secret, a hash, a device credential or a recovery address,
And the ETag changes when the secret, a device or the status changes and not when a sign-in fails,
And a Vendor or Rider session calling either is refused with PERMISSION_DENIED, whether or not the account exists.
```

**Governs:** `MSC-DEC-432`, `MSC-DEC-442`, [permissions.md](../../contracts/permissions.md) §7 · **Surface:** Melarc Ops · **Test level:** API · **Code:** `PERMISSION_DENIED`, `HUB_SCOPE_VIOLATION`, `NOT_FOUND`

## 14. Open questions blocking this feature

| ID| What it blocks here| Type|
|---|---|---|
| ~~`OQ-067`~~| **Closed 5 September 2026, `MSC-DEC-371`** — the vendor ceiling now has a number: vendor sign-in **10/min**, keyed on the Vendor account **and** its registered device| ~~`VALUE_REQUIRED`~~|
| ~~`OQ-033`~~| **Closed 21 September 2026, `MSC-DEC-397`** — reactivation and termination are decided. **Suspension terminates every live session** ([vendor-suspension.md](../vendor/vendor-suspension.md)) and reactivation issues none: the vendor signs in again normally| ~~`DECISION_NEEDED`~~|

**No `DECISION_NEEDED` blocks this feature.** `OQ-033` concerned the *end* of the vendor lifecycle, not its authentication, and closed on 21 September 2026.

**That gap is closed.** §37.5's requirement to *"revoke or control prior sessions"* is now met on both halves of the vendor credential — secret and registered browser — by `completeCredentialRecovery`, and the exceptional Platform Admin path is `recoverVendorCredential`.

**`AC-SLICE-000-14` described a reachable scenario** — a second browser joining without displacing the first — **that had no implementation path.** `requestAdditionalDeviceGrant` (§5.5) closes the gap.

## 15. What this feature still owes its slice


§13 `Session` was signed by `MSC-DEC-227` on 21 August — the single blocker this section named at the time. `MSC-DEC-234` placed the Vendor PWA in the **Standard** session tier.

**Readiness is not assessed here.** [definition-of-ready.md](../../standards/definition-of-ready.md) assesses it **for the complete vertical slice** and records the verdict in the slice document; a feature cannot answer §44.3 or §44.4 alone. This section feeds that assessment instead of duplicating it (`MSC-DEC-239`, closing `CONFLICT-029`).

## 16. Build status — *honest, per surface*

| Surface| Status|
|---|---|
| Melarc Vendor| **Specified and buildable.** `Session` §13 was signed on **21 August** by `MSC-DEC-227`; its `→ ACTIVE` row's failure cell was amended at `MSC-DEC-434` and re-signed at `MSC-DEC-438`. Authentication requires **account identifier + shared secret + registered `melarc_vendor_device`**, all three enforced by the contract.|
| Melarc Ops| Session revocation specified. Exceptional recovery is `recoverVendorCredential`, which creates a **`RecoveryRequest`** to the registered channel — see [credential-recovery](credential-recovery.md)|
| Melarc Rider| N/A|

## 17. Related

- **Siblings:** [staff-authentication](staff-authentication.md) · [rider-authentication](rider-authentication.md) · [credential-recovery](credential-recovery.md) · [permission-enforcement](permission-enforcement.md)
- **Surfaces:** [vendor-pwa.md](../../surfaces/vendor-pwa.md)
- **Contracts:** [domain-model.md](../../contracts/domain-model.md) §6.8 · [permissions.md](../../contracts/permissions.md)
