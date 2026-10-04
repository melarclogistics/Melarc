# Staff authentication

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.23 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** how Ops, Senior Ops and Platform Admin authenticate, and the second factor privileged roles cannot sign in without
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §11.2, §37.2, §37.3, §30.3, and cross-cutting §35, §37.1, §38, §40, §42
> **Slice:** `SLICE-000`

## 1. What this is, and why

Melarc staff sign in with **email and password**. Senior Ops and Platform Admin additionally complete **MFA before privileged access** (§11.2, §37.2).

This exists as its own feature because **the second factor is a gate on obtaining a session at all**, for two of the three staff roles. §37.2 requires MFA *"before privileged access"*, and `MSC-DEC-228` reads that as **at sign-in**: a Senior Ops or Platform Admin user without a factor does not get a reduced session, they get none.

**The cost is carried by session controls, and there are now two of them.** Once issued, a privileged session stays privileged for its whole life — nothing re-challenges the user before a price correction at 16:00. `MSC-DEC-234` closed `OQ-071` by making both controls **per-tier**: a privileged session expires absolutely at **480 minutes** and after **15 minutes idle**. The idle figure is the one that matters here, because the exposure is an unattended browser rather than a long working day.

**Version 1 boundary.** This feature covers staff only. Riders and vendors authenticate differently and have their own features. It does not cover permission *content* — that is [permission-enforcement](permission-enforcement.md) — nor recovery, which is [credential-recovery](credential-recovery.md).

## 2. Governing sections

| Section| What it governs here|
|---|---|
| §11.2| The confirmed authentication baseline — email/password, MFA for privileged roles|
| §37.2| The same policy restated as security policy, plus session policy|
| §37.3| Access boundaries — ordinary staff are restricted to authorized hubs|
| §37.1| **Deny by default.** No permission means refused, never permitted by framework default|
| §30.3| Staff lifecycle — credential setup, device and session management, permission-review history|
| **§30.8**| **Onboarding authority** — who creates a staff record and who approves it. Added 24 August: this feature stated an `active` record with a bundle as a precondition while citing no section that says how one comes to exist|
| §30.9| Suspension authority and its effect on in-progress work|
| §38| Audit obligations for authentication and privileged access|
| §40| Non-functional targets the login path must meet|


## 3. Surfaces and actors

| Surface| Actor| Can do| Gated by|
|---|---|---|---|
| Melarc Ops| Ops Staff| Sign in with email and password| —|
| Melarc Ops| Senior Ops| Sign in with email, password **and a second factor**| —|
| Melarc Ops| Platform Admin| Sign in with email, password **and a second factor**| —|
| Melarc Vendor| —| **N/A** — vendors use a shared credential, see [vendor-authentication](vendor-authentication.md)| —|
| Melarc Rider| —| **N/A** — riders use phone and PIN, see [rider-authentication](rider-authentication.md)| —|

**Three surfaces, three authentication models, and they never mix.** §37.3: *"Melarc Vendor is a simple customer portal, not a SaaS tenant workspace."* A staff member does not sign into the Vendor portal with staff credentials to "check something" — that path does not exist.

## 4. Preconditions

- The staff record exists, is **active**, and has an assigned permission bundle (§30.3).
- **The identity is authentication-ready**: a credential has been established by the employee through a `SetupGrant`, and — for Senior Ops or Platform Admin — an **`ACTIVE` `MfaFactor`** exists.
- **Being approved is not being able to sign in.** An `ACTIVE` identity that has not completed setup grants **zero authenticated access**, and no session may be issued against it. **Reaching that state has been possible since 24 August and was not before** — no operation created a staff identity and none granted a bundle, so this precondition named a state the product could not produce. It is reached through §30.8's maker-checker: `createStaffIdentity` then `approveStaffIdentity` by a different actor ([state-machines.md](../../contracts/state-machines.md) §13.3, `MSC-DEC-247`). A `PENDING_APPROVAL` record **fails this precondition** and no session is issued against it.
- The staff member has a **verified work email** — it is also the recovery channel (§37.2). **Version 1 has no separate email-verification lifecycle or state, by decision**: the address is accurate because the authorised create-and-approve process established it — the maker entered it and the independent approver passed it at §30.8 approval — and every setup grant, recovery link and re-enrolment link goes to it and nowhere else. **No verification state of any name exists and no criterion tests one**, and a failed delivery is a delivery and recovery outcome, not an identity state. This feature specifies no further verification.
- For Senior Ops and Platform Admin, an **`ACTIVE` `MfaFactor`** exists — a **record that was proven**, not the `mfa_enrolled` boolean, which is now derived from it and is never accepted as evidence.

## 5. Behaviour

### 5.1 Normal path

1. **Staff submits email and password.** The server verifies against the stored credential.
2. **A session is established**, carrying the staff identity, the assigned bundle **snapshotted at issue**, and the authorized hub set (§37.3).
3. **For Ops Staff, work begins.** No further step.
4. **For Senior Ops and Platform Admin, no session is issued yet.** The response is **`202 Accepted` with an `MfaChallenge`** — a different status code from the Ops Staff `200`, and **no cookie of any kind is set**. It grants nothing and is not a partial session. One `200` returning either shape could not distinguish a session correctly withheld from one wrongly issued; two codes make **"no privileged Session before proven MFA"** a property a test asserts against the contract. It lives for `authentication_challenge_ttl_minutes` (**5**, `MSC-DEC-268`), survives up to `mfa_max_attempts` wrong codes and then becomes permanently unusable — `CHALLENGE_EXPIRED` and `CHALLENGE_UNUSABLE` are separate codes because they tell the user different things: **start again, versus this one is finished.**
5. **Presenting a valid factor issues the session**, already privileged to whatever the bundle allows.
6. **The session arrives as an `HttpOnly` `melarc_session` cookie**, with a readable `melarc_csrf` cookie alongside it; unsafe requests echo it in `X-CSRF-Token` or fail with `CSRF_VALIDATION_FAILED`. **Senior Ops and Platform Admin are `Privileged`-tier for session lifetime and idle timeout** — 480 and 15 minutes, not the standard figures.

### 5.2 The reading behind this, and the one it replaced

§37.2's *"complete MFA before privileged access"* supports two readings, and `MSC-DEC-227` chose the other one first: **session elevation**, where a user signs in freely and presents a factor at the moment of each privileged action.

**The Product Owner overturned it on 21 August**. MFA gates the login for those roles.

**What that trades away, recorded so nobody rediscovers it as a bug.** Elevation bound the second factor to the moment of risk. Without it, a Senior Ops user who signs in at 07:00 holds privileged authority in an unattended browser until the session ends.

**`MSC-DEC-234` bounds that exposure at 15 minutes rather than removing it.** The reversal is still a reversal: nothing re-challenges a present, working user. What changed is that an **absent** one is no longer the same case as a working one. `session_lifetime_minutes` alone could not tell them apart, which is why tuning it forced a choice between interrupting active officers and leaving abandoned browsers live — and why the answer was a second key rather than a smaller number.

### 5.3 Exception paths

| Path| Behaviour| Error code|
|---|---|---|
| Wrong password| Refused. Counts toward the lockout (§5.5)| `INVALID_CREDENTIALS`|
| Fifth consecutive wrong password| The credential is locked for `signin_lockout_minutes`. **Nobody is told**: sign-in during the lock is answered exactly as a wrong password, the correct password included — it is not verified and does not extend the lock| `INVALID_CREDENTIALS`|
| Unknown, `PENDING_APPROVAL`, `REJECTED`, `SUSPENDED` or `OFFBOARDED` identity, or one with no credential yet| Refused. **Indistinguishable from a wrong password** on the sign-in surface, in content and in timing. Counts nothing and locks nothing| `INVALID_CREDENTIALS`|
| Senior Ops or Platform Admin with the correct password| **Not a refusal.** `202` with an `MfaChallenge`, no session and no cookie. The catalogue calls this outcome `MFA_REQUIRED`; it is a sign-in challenge and is never returned from a business operation| `MFA_REQUIRED` *(the challenge)*|
| Wrong MFA code| Refused. Counts once against the challenge (`mfa_max_attempts`) **and** once toward the identity's lockout count| `MFA_PROOF_INVALID`|
| A further code on a challenge that already holds three wrong ones, or a challenge already consumed, superseded or unknown| **This challenge is finished.** It accepts nothing further, the correct code included| `CHALLENGE_UNUSABLE`|
| Challenge older than `authentication_challenge_ttl_minutes`| **Start again**| `CHALLENGE_EXPIRED`|
| Lock reached while the caller holds a live challenge| The password was proved, so the caller is told| `CREDENTIAL_LOCKED`|
| A challenge id presented to a business operation| It is not a session, so there is no session| `SESSION_INVALID`|
| Key not held, or the key's surface does not serve the operation| Refused before any record is considered| `PERMISSION_DENIED`|
| Key held, tier too low (a privileged bundle approved by Senior Ops)| Refused| `INSUFFICIENT_AUTHORITY`|
| An existing record outside the actor's hubs (§37.3)| Refused, and the staff member **is told** why — authenticated staff may know a record exists elsewhere| `HUB_SCOPE_VIOLATION`|
| No such record| Refused| `NOT_FOUND`|
| Rate limit exceeded| Refused first, before any factor is verified or counted — sign-in has its own bucket (`rate_limit_staff_signin`, keyed on the email the request carries, whether or not it matches a staff identity), and an authenticated staff session's API ceiling is **moderate** so that a busy hub's intake is not throttled| `RATE_LIMITED`|
| Password shorter than 12 or longer than 128 characters at setup or recovery; a sign-in password longer than 128| Refused by the schema. The message names the field and **never the value**| `VALIDATION_FAILED`|

**`CODE_EXPIRED` and `ATTEMPTS_EXHAUSTED` are not in this table, and an earlier version put them here.** Both belong to the doorstep handshake (`verifyHandshake`); the catalogue says so and no staff operation declares either.

### 5.4 What this feature must never do

- **Never distinguish "no such account" from "wrong password" on the sign-in surface.** Both return `INVALID_CREDENTIALS`. A distinct message confirms which email addresses are real staff — and Melarc staff emails follow a predictable pattern.
- **Never test a role name.** §11.1 and §11.1, `MSC-DEC-133`: authorization checks a **held permission**. `user.role == "SENIOR_OPS"` is wrong however correct its outcome, because changing a bundle's contents is configuration and must never require a code change.
- **Never resolve the bundle at read time.** The session snapshots it at issue, matching the audit rule at [audit.md](../../contracts/audit.md) §3 — resolving live would show today's authority against yesterday's action.
- **Never treat the MFA challenge as a session.** It grants nothing, carries no authority, and is single-use. A partial session issued before the factor is presented would defeat the gate entirely.
- **Never log a password, an MFA code, or a session token** — §20.4's rule for OTPs applies identically. Audit records that authentication occurred, never the material.
- **Never grant cross-hub access by default.** §37.3 restricts ordinary staff to authorized hubs; cross-hub is Platform Admin and approved HQ roles, **and it is audited**.

### 5.5 Lockout, credential strength and the order of checks

`MSC-DEC-431`, written at [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.4a and §13.4b. **The values were always set; the mechanism and the rule for what counts were not.**

- **Credential strength.** A staff password, and the bootstrap administrator's password, is **12 to 128 characters, spaces permitted, with no composition rule** — no mandatory case, digit or symbol. The bound is a constant of the contract, not a setting. Sign-in itself has a ceiling of 128 and no floor, so a short guess is simply a wrong password.
- **The order.** The schema; then the identity is resolved (an unknown, ineligible or credential-less one gets a dummy hash verification and `INVALID_CREDENTIALS`); then, if the credential is locked, the answer is `INVALID_CREDENTIALS` **after one dummy hash verification whose result is discarded**, so a locked answer is no faster than a wrong one; then the password. **A failure counts only once the request has reached the password**, which for staff has no earlier gate.
- **The lock.** The fifth consecutive failure sets `locked_until` fifteen minutes ahead. A request inside the lock is neither verified nor counted and does not extend it. At the first attempt after it the count is zero. The count also resets on a complete sign-in and when a credential is set or recovered — `completeStaffCredentialSetup` and `completeCredentialRecovery`.
- **Silent at the password, announced at the second factor.** A caller who has proved nothing cannot be told a lock exists: that would let anyone learn which addresses are real staff by locking one. A Senior Ops or Platform Admin who holds a live MFA challenge **has** proved the password, so is told `CREDENTIAL_LOCKED`.
- **One count for the password and the code.** `mfa_max_attempts` limits a **challenge** to three wrong codes; each wrong code also adds one to the identity's count, so a thief who knows the password cannot guess codes across fresh challenges.
- **A lock ends no session, changes no status and blocks no recovery.** There is no administrator unlock: recovery completion clears it, and otherwise it ends by itself. The count and the lock are **not part of the identity's version**, so a failed sign-in never moves an approver's `ETag`.

### 5.6 Reads and versions — how an approver finds the record and its version

The maker learns the new identity's id from the creation response. **A different person, the approver, finds it with `listStaffIdentities` and reads `getStaffIdentity`**; each staff-targeted mutation takes its `If-Match` from that read, and a stale version is `STATE_CONFLICT`. Both reads are gated by `staff.read`, which **Ops Staff do not hold** — so the maker, who may be Ops Staff, cannot read the record back, and that is deliberate. `proposeBundleChange` takes its `ETag` from the same read, and `SLICE-009` builds it.

**The maker chooses the bundle from a read, not from a list the screen carries**. `listAssignableStaffRoleBundles` returns to any holder of `permission.assignable_bundle.read` (`MSC-DEC-443` — Ops Staff, Senior Ops and Platform Admin, the bundles that hold `staff.identity.create`), at any hub, only the staff bundles currently valid for assignment to human staff — each with its identifier, its display name and whether a Platform Admin must approve the assignment, **never its permissions or its holders**. The key is global configuration with no hub scope, it does not itself permit creation, assignment or approval, and `createStaffIdentity` stays gated by `staff.identity.create`. **Choosing a privileged bundle grants nothing**: the profile is created `PENDING_APPROVAL` and a Platform Admin must approve a privileged target. `createStaffIdentity` validates the id itself, and one that names no assignable bundle is `VALIDATION_FAILED` — **validation inside the signed §13.3 `→ PENDING_APPROVAL` row**, which already requires a bundle to be named and already carries that code, and which the Product Owner confirmed this does not amend.

## 6. Entities — *pointer*

| Entity| Where|
|---|---|
| `StaffIdentity`, `HubAssignment`| [domain-model.md](../../contracts/domain-model.md) **§6.8** — now in field detail|
| `RoleBundle`, `Permission`| §6.9 cross-cutting — named and scoped, field detail deferred|
| `Session`| **Added at §6.8 on 20 August.** It had been named nowhere|

**Closed on 20 August.** `domain-model.md` §6.8 now carries the identity set in field detail, including the `Session` entity that had been named nowhere.

**`Session` was the real omission, and it is now modelled.** It is at [domain-model.md](../../contracts/domain-model.md) §6.8 with a machine at [state-machines.md](../../contracts/state-machines.md) §13.

## 7. States — *pointer*

[state-machines.md](../../contracts/state-machines.md) **§13 `Session`** — `ACTIVE` → `TERMINATED`, added on 20 August with a third state and reduced to two by `MSC-DEC-228`, which withdrew elevation. **Approved 21 August** by `MSC-DEC-227`, which extended `MSC-DEC-200`'s sign-off scope; **its `→ ACTIVE` row's failure cell was amended at `MSC-DEC-434` and re-signed by the Product Owner at `MSC-DEC-438`**.

## 8. Permissions — *pointer*

[permissions.md](../../contracts/permissions.md) §7. **This feature consumes the model rather than defining it.** Note `permission.read` is **Platform Admin only** and must never surface on a vendor or rider screen (§11.1, §11.3, `MSC-DEC-134`).

## 9. Settings — *pointer*

| Key| Status|
|---|---|
| `signin_max_attempts`| [settings.md](../../contracts/settings.md) §7.5 — **5**. The fifth consecutive wrong password locks the credential, **silently** at the password step (§5.5)|
| `signin_lockout_minutes`| §7.5 — **15**|
| `mfa_max_attempts`| §7.5 — **3**, counted **per challenge**, and each wrong code also adds one to the identity's lockout count. Deliberately **lower** than `signin_max_attempts`: a user at this step has already proved the password, so a wrong code is more suspicious than a wrong password|
| `session_lifetime_minutes`| §7.5 — **480 minutes** for Senior Ops and Platform Admin; per-tier since `MSC-DEC-234`|
| `session_idle_timeout_minutes`| §7.5 — **15 minutes** privileged. Added by `MSC-DEC-234`; **this is the control on unattended-browser exposure**, not the absolute lifetime|

## 10. Errors — *pointer*

[errors-and-enums.md](../../contracts/errors-and-enums.md) — `INVALID_CREDENTIALS`, `MFA_PROOF_INVALID`, `CHALLENGE_EXPIRED`, `CHALLENGE_UNUSABLE`, `CREDENTIAL_LOCKED`, `RATE_LIMITED`, `SESSION_INVALID`, `PERMISSION_DENIED`, `INSUFFICIENT_AUTHORITY`, `HUB_SCOPE_VIOLATION`, `NOT_FOUND`, `SELF_APPROVAL_FORBIDDEN`, `STATE_CONFLICT`, `VALIDATION_FAILED`, `REASON_REQUIRED`, `SETUP_GRANT_INVALID`, `MFA_ENROLMENT_REQUIRED`, `CREDENTIAL_DELIVERY_FAILED` and `CSRF_VALIDATION_FAILED`. **`MFA_REQUIRED` names the sign-in challenge and is never returned from a business operation.** **`ATTEMPTS_EXHAUSTED` and `CODE_EXPIRED` are handshake codes** — this section said `ATTEMPTS_EXHAUSTED` *now serves both the handshake and sign-in*, which the catalogue and the contract deny. **`DEVICE_NOT_REGISTERED` was listed here and was withdrawn on 27 August** as a dead synonym of `DEVICE_NOT_ENROLLED` — and it had no business on a **staff** feature in the first place, which returns no device code at all.

## 11. Audit events — *pointer*

[audit.md](../../contracts/audit.md) §5.4 — the **`auth` family**. `auth.session.issued`, `auth.session.failed`, `auth.session.superseded`, `auth.session.terminated`; **`auth.mfa.completed`**, `auth.mfa.failed`; `auth.lockout.applied`; `auth.device.registered`, `auth.device.revoked`; `auth.credential.changed`. **`auth.session.failed` records the precise cause while the response stays undifferentiated** — otherwise nobody can tell a typo from an attack. **Also `auth.setup_grant.issued`, `auth.setup_grant.consumed`, `auth.mfa.enrolled`, `auth.mfa.reset`, `auth.session.authority_revoked` and `auth.csrf.rejected`.** The cause on `auth.session.failed` is one of a closed set the catalogue names — `UNKNOWN_PRINCIPAL`, `INELIGIBLE_PRINCIPAL`, `WRONG_PASSWORD`, `WRONG_MFA_CODE`, `LOCKED_OUT`, `CHALLENGE_EXPIRED`, `CHALLENGE_UNUSABLE` for staff — and **never a password, a code or a token**.

**This section cited `auth.mfa.elevated` until 23 August — an event that no longer exists.** `MSC-DEC-228` withdrew elevation on 21 August and `audit.md` renamed the code to `auth.mfa.completed`, which records a second factor accepted **at sign-in**. The stale name survived because a suffix-abbreviated list is not checkable: nothing could compare it to the catalogue.

**Every identifier is spelled in full.** The suffix form — `` `.dispatched` `` after `` `pickup.manifest.created` `` — is not a resolvable identifier: no check can verify it, and it still reads correctly after the code it points at is renamed.

## 12. API operations — *pointer*

[openapi.yaml](../../contracts/openapi.yaml) — `staffSignIn`, `completeStaffMfaSignIn`, `getCurrentSession`, `signOut`, `revokeSession`. **The `Session` schema carries no token and no bundle contents**: a client asks the server what it may do rather than deciding from a list it was handed.

**Establishment and re-enrolment:** `completeStaffCredentialSetup`, `completeMfaEnrolment`, `resetStaffMfa`, **`beginMfaReenrolment`** (R1), **`recoverStaffCredential`** (R1, split out of the former `performOpsRecovery`) and **`reissueStaffCredentialSetup`** (MED-10 audit remediation).

**Onboarding — creating and approving the identity:** **`createStaffIdentity`** (`staff.identity.create`) and **`approveStaffIdentity`** (`staff.identity.approve`), §30.8, **and `listAssignableStaffRoleBundles`** (`permission.assignable_bundle.read`, `MSC-DEC-439` and `MSC-DEC-443`) — the read that gives the maker's form its bundle choices. **Built in `SLICE-000`**: the script's first rows are made of them and `AC-SLICE-000-33` tests the creation. The maker supplies no credential, and the approver must be a different person (`SELF_APPROVAL_FORBIDDEN`); approval issues the single `STAFF_CREDENTIAL_SETUP` grant described below.

**Reads (Gate PD-3R1, `PDA-47`):** `listStaffIdentities` and `getStaffIdentity` (`staff.read`) and `listSessions` — the reads every staff-targeted mutation takes its `If-Match` from and the revocation screen needs. `approveStaffIdentity`, `resetStaffMfa`, `reissueStaffCredentialSetup` and `recoverStaffCredential` each name `getStaffIdentity` as the source of their `ETag`; `proposeBundleChange` does too and belongs to `SLICE-009` with `approveBundleChange`, which this slice does not build.

**`reissueStaffCredentialSetup` closes the gap the other five leave open.** `approveStaffIdentity` issues exactly one `STAFF_CREDENTIAL_SETUP` grant, at the ordinary 30-minute lifetime; nothing before this operation could reach an `ACTIVE` identity whose grant expired before the employee acted on it, because `recoverStaffCredential` repairs a credential that already exists and this one does not. Senior Ops or Platform Admin re-issues it — the same `staff.identity.approve` authority exercised again, not a new permission — superseding any stale `PENDING` grant and delivering the fresh one to the same verified work email.

**`MFA_ENROLMENT` is the only grant purpose that activates a factor**, whatever created the pending one. The contract accepted `BOOTSTRAP_SETUP` at `completeMfaEnrolment` until R1.2 — which would have left the **one grant with no expiry** able to install a factor at any later date.

**`beginMfaReenrolment` is the step the reset lifecycle was missing.** `resetStaffMfa` revoked the factor and issued a re-enrolment grant, and **nothing in the contract ever returned a new TOTP secret** — so a reset identity held an authorisation to re-enrol and no means of doing it. It provisions a `PENDING` factor and issues a short-lived `MFA_ENROLMENT` continuation grant; **only that second grant with a proven code activates anything**, so a reset authorisation can never stand in for possession of the new authenticator.

**The browser session's raw credential travels only as `Set-Cookie`** — which is why staff sign-in needs no equivalent of the rider's `RiderSessionIssued`. The precise rule is that a raw credential never appears in an **ordinary Session resource representation**; rider issuance returns one **exactly once** because a native client has no `Set-Cookie` equivalent.

**Every unsafe request carries `X-CSRF-Token`, and the contract requires it structurally** — `csrfToken` is a security scheme composed with `browserSession`, not an optional parameter. An operation that omits it fails a mechanical check.

## 13. Acceptance criteria

### `AC-SLICE-000-01` — Ops staff sign in with email and password

```text
Given an active Ops Staff record with a verified work email,
When the user submits the correct email and password,
Then a session is established carrying the identity, the snapshotted bundle and the authorized hub set,
And no MFA step is required,
And the session grants no authority beyond the bundle's contents.
```

**Governs:** §11.2, §37.2 · **Surface:** Melarc Ops · **Test level:** API

### `AC-SLICE-000-02` — A privileged role cannot sign in without a second factor

```text
Given a Senior Ops user submitting a correct email and password,
When the sign-in is attempted,
Then no session is issued and no cookie is set,
And the response is 202 with an MFA challenge, the outcome the catalogue calls MFA_REQUIRED,
And the challenge grants no access to any operation,
And presenting a valid factor issues a session that is privileged immediately.
```

**Governs:** §37.2, §37.4 · **Surface:** Melarc Ops · **Test level:** API · **Code:** `MFA_REQUIRED`

### `AC-SLICE-000-03` — The challenge is single-use, short-lived and grants nothing

```text
Given a Senior Ops user holding an unconsumed MFA challenge,
When the challenge id is presented to any business operation,
Then it is refused with 401 SESSION_INVALID, because a challenge is not a session,
And when the correct factor is presented and the same challenge is presented again, the second attempt is refused with CHALLENGE_UNUSABLE,
And a challenge older than authentication_challenge_ttl_minutes is refused with CHALLENGE_EXPIRED.
```

**Governs:** §37.2, `MSC-DEC-228`, `MSC-DEC-268` · **Surface:** Melarc Ops · **Test level:** API · **Code:** `SESSION_INVALID`, `CHALLENGE_UNUSABLE`, `CHALLENGE_EXPIRED`

### `AC-SLICE-000-04` — Sign-in failure does not disclose account existence

```text
Given an email address that belongs to no staff record,
When a sign-in is attempted,
Then the response is INVALID_CREDENTIALS,
And a suspended identity, a pending, rejected or offboarded identity, an identity with no credential yet and a wrong password produce the identical response and timing,
And no response distinguishes which of them occurred.
```

**Governs:** §37.1, §37.7 · **Surface:** Melarc Ops · **Test level:** API · **Code:** `INVALID_CREDENTIALS`

### `AC-SLICE-000-05` — Authorization tests permissions, never role names

```text
Given a Senior Ops user whose bundle has had a permission removed by configuration,
When the user attempts the action that permission gated,
Then it is refused,
And the refusal required no code change to take effect,
And no code path anywhere tests the string SENIOR_OPS.
```

**Governs:** §11.1, `MSC-DEC-133` · **Surface:** Melarc Ops · **Test level:** integration · **Code:** `PERMISSION_DENIED`

### `AC-SLICE-000-06` — The bundle is snapshotted at session issue

```text
Given a signed-in staff user,
When an administrator changes that user's bundle,
Then actions already audited retain the bundle held at the time,
And the audit record shows the historical bundle rather than the current one.
```

**Governs:** §11.1, [audit.md](../../contracts/audit.md) §3 · **Surface:** Melarc Ops · **Test level:** integration

### `AC-SLICE-000-07` — Ordinary staff cannot reach another hub, and are told why

```text
Given a Senior Ops user authorised for hub A who holds staff.read,
And one staff identity whose primary hub is A and another whose primary hub is B,
When the user reads each with getStaffIdentity and then reads an identifier that matches nothing,
Then the hub-A identity is returned,
And the hub-B identity is refused with HUB_SCOPE_VIOLATION, which says the record is outside the actor's hubs and returns none of its contents,
And the identifier that matches nothing is refused with NOT_FOUND,
And a user who does not hold staff.read is refused with PERMISSION_DENIED before either record is considered,
And listStaffIdentities returns only the hub-A identity.
```

**Governs:** §37.3, `MSC-DEC-432` · **Surface:** Melarc Ops · **Test level:** API · **Code:** `HUB_SCOPE_VIOLATION`, `NOT_FOUND`, `PERMISSION_DENIED`

### `AC-SLICE-000-32` — An approved privileged identity cannot sign in before MFA is proven

```text
Given a Senior Ops identity that is ACTIVE with its bundle assigned,
And whose password has been established through a setup grant,
And which has no ACTIVE MfaFactor,
When the correct email and password are submitted,
Then an MFA challenge is returned,
And no Session is created,
And presenting no factor leaves the identity with zero authenticated access.
```

**Governs:** §37.2, `MSC-DEC-259` · **Surface:** Melarc Ops · **Test level:** integration

### `AC-SLICE-000-33` — The maker never supplies a credential

```text
Given a Senior Ops user creating a staff identity,
When the creation request includes a password or an mfa_enrolled value,
Then the request is rejected by the schema,
And the created identity has a null credential,
And a setup grant is issued to the verified work email on approval.
```

**Governs:** `MSC-DEC-259` · **Surface:** Melarc Ops · **Test level:** contract · **Code:** `VALIDATION_FAILED`

### `AC-SLICE-000-35` — A browser session expires on idle

```text
Given a privileged browser session with last_activity_at 16 minutes ago,
And session_idle_timeout_minutes of 15 for that tier,
When any authenticated request is made,
Then it is refused with 401 SESSION_INVALID,
And the session is terminated with EXPIRED,
And an equivalent rider session with no idle rule is unaffected.
```

**Governs:** `MSC-DEC-234`, `MSC-DEC-261` · **Surface:** backend · **Test level:** integration

### `AC-SLICE-000-77` — A fifth wrong password locks the credential and nobody is told

```text
Given an ACTIVE credentialed Ops Staff identity and signin_max_attempts of 5,
When five consecutive wrong passwords are submitted for it,
Then each is refused with INVALID_CREDENTIALS,
And the fifth sets locked_until to signin_lockout_minutes from now,
And a sixth request carrying the correct password is also INVALID_CREDENTIALS, is not verified and does not extend the lock,
And its status, body and timing class equal those of a wrong password on an unlocked identity,
And an email that matches no identity answers the same way and never locks,
And auth.lockout.applied is recorded once, naming the factor and locked_until and no credential, even when the failures race: concurrent wrong passwords at the limit set one lock and record one event.
```

**Governs:** `MSC-DEC-431`, §37.7 · **Surface:** Melarc Ops · **Test level:** API · **Code:** `INVALID_CREDENTIALS`

### `AC-SLICE-000-78` — A lock ends on its own and a correct sign-in resets the count

```text
Given an Ops Staff identity locked by five wrong passwords,
When signin_lockout_minutes have passed and the correct password is submitted,
Then the password is verified normally and a session is issued,
And the failed-attempt count is zero,
And four wrong passwords followed by the correct one never lock the identity,
And a lock that is in force does not end any live session of the identity.
```

**Governs:** `MSC-DEC-431` · **Surface:** Melarc Ops · **Test level:** integration

### `AC-SLICE-000-79` — A wrong MFA code is refused and counted twice

```text
Given a Senior Ops user holding a live MFA challenge after a correct password,
When a wrong code is submitted,
Then it is refused with MFA_PROOF_INVALID and no session is issued,
And it counts once against the challenge and once toward the identity's lockout count,
And after mfa_max_attempts wrong codes the challenge answers CHALLENGE_UNUSABLE to every code, the correct one included,
And a code already used within its window is refused with MFA_PROOF_INVALID.
```

**Governs:** `MSC-DEC-268`, `MSC-DEC-431` · **Surface:** Melarc Ops · **Test level:** API · **Code:** `MFA_PROOF_INVALID`, `CHALLENGE_UNUSABLE`

### `AC-SLICE-000-80` — A lock reached at the second factor is announced only to someone who proved the password

```text
Given a Senior Ops identity with four consecutive wrong passwords counted,
And a live MFA challenge obtained with the correct password,
When one wrong code is submitted and then the correct code on the same challenge,
Then the wrong code is refused with MFA_PROOF_INVALID and is the fifth failure, which sets the lock,
And the correct code is refused with CREDENTIAL_LOCKED, because the caller holds a live challenge and has proved the password,
And a new password sign-in for the identity answers INVALID_CREDENTIALS with no mention of a lock,
And no session is issued at any point.
```

**Governs:** `MSC-DEC-431` · **Surface:** Melarc Ops · **Test level:** API · **Code:** `CREDENTIAL_LOCKED`, `MFA_PROOF_INVALID`, `INVALID_CREDENTIALS`

### `AC-SLICE-000-81` — A rate-limited request is neither verified nor counted

```text
Given an Ops Staff identity and the staff sign-in limit of 10 a minute,
When more than ten sign-in requests for it arrive within the minute,
Then the excess requests are refused with RATE_LIMITED, and a correct password among them is not examined,
And a refused request adds nothing to the failed-attempt count, so only the fifth wrong password that was verified sets a lock,
And the limit is keyed on the normalised email the request carries, whether or not it matches a staff identity, and not on the network address, so RATE_LIMITED never tells a caller that an address is real.
```

**Governs:** `MSC-DEC-224`, `MSC-DEC-371`, `MSC-DEC-431` · **Surface:** Melarc Ops · **Test level:** API · **Code:** `RATE_LIMITED`

### `AC-SLICE-000-82` — Signing out ends the session

```text
Given a signed-in principal with a live session,
When the principal calls signOut with the synchronizer token where the surface requires one,
Then the response is 204 and the session is terminated with SIGNED_OUT,
And the next request on that credential is refused with 401 SESSION_INVALID,
And auth.session.terminated records the reason and never the token,
And a second signOut on the same credential is refused with 401 SESSION_INVALID and changes nothing.
```

**Governs:** §37.2, `MSC-DEC-261` · **Surface:** Melarc Ops, Melarc Vendor, Melarc Rider · **Test level:** API · **Code:** `SESSION_INVALID`

### `AC-SLICE-000-83` — The current-session read returns no credential and no bundle contents

```text
Given a signed-in principal of each type,
When getCurrentSession is called,
Then the response names the principal, the authorised hub set and the expiry,
And it contains no session token, no token hash, no CSRF value and no bundle contents,
And the Session schema has no property that could hold any of them.
```

**Governs:** `MSC-DEC-261`, §37.2 · **Surface:** Melarc Ops, Melarc Vendor, Melarc Rider · **Test level:** contract

### `AC-SLICE-000-84` — An unsafe request without the synchronizer token is refused and audited

```text
Given a signed-in browser session,
When an unsafe request carries the session cookie and no X-CSRF-Token, a token that does not match, or an Origin that is not allowed,
Then it is refused with CSRF_VALIDATION_FAILED and nothing changes,
And auth.csrf.rejected records the route and the principal and never the token,
And the same request with the correct token and Origin succeeds,
And a safe read needs no token.
```

**Governs:** `MSC-DEC-261`, `MSC-DEC-270` · **Surface:** Melarc Ops, Melarc Vendor · **Test level:** API · **Code:** `CSRF_VALIDATION_FAILED`

### `AC-SLICE-000-85` — The maker cannot approve, and a bundle above the approver's tier needs a Platform Admin

```text
Given a Senior Ops user who created a staff identity in PENDING_APPROVAL,
When the same user calls approveStaffIdentity for it,
Then it is refused with SELF_APPROVAL_FORBIDDEN and the identity stays PENDING_APPROVAL,
And when a different Senior Ops user approves an identity whose role_bundle_id names a privileged bundle, it is refused with INSUFFICIENT_AUTHORITY,
And when a Platform Admin approves it, the identity becomes ACTIVE and exactly one STAFF_CREDENTIAL_SETUP grant is issued,
And an Ops Staff user, who does not hold staff.identity.approve, is refused with PERMISSION_DENIED.
```

**Governs:** §30.8, `MSC-DEC-247`, `MSC-DEC-248` · **Surface:** Melarc Ops · **Test level:** API · **Code:** `SELF_APPROVAL_FORBIDDEN`, `INSUFFICIENT_AUTHORITY`, `PERMISSION_DENIED`

### `AC-SLICE-000-86` — An approver finds a pending identity and approves the version they read

```text
Given a staff identity created by one user and a different Senior Ops user at the same hub,
When the approver lists staff identities, reads the pending one with getStaffIdentity and calls approveStaffIdentity with that ETag in If-Match,
Then the identity is listed with its status PENDING_APPROVAL and the read returns an ETag,
And the approval succeeds,
And an approval carrying an ETag from before a later change is refused with STATE_CONFLICT,
And failed sign-in attempts against the identity do not change its ETag.
```

**Governs:** §30.8, `MSC-DEC-247`, `getStaffIdentity` in `openapi.yaml` · **Surface:** Melarc Ops · **Test level:** API · **Code:** `STATE_CONFLICT`

### `AC-SLICE-000-87` — A password outside 12 to 128 characters is refused, and nothing else is required

```text
Given a valid STAFF_CREDENTIAL_SETUP grant and a valid recovery token for a staff identity,
When the password is submitted at completeStaffCredentialSetup or completeCredentialRecovery as 11 characters, and as 129 characters,
Then each is refused by the schema with VALIDATION_FAILED, naming the field and never echoing the value, and the grant or token is not consumed,
And a 12-character password of lower-case letters only is accepted,
And a 128-character passphrase containing spaces is accepted,
And staffSignIn refuses a 129-character password at the schema, while a short wrong password at staffSignIn is INVALID_CREDENTIALS.
```

**Governs:** `MSC-DEC-431`, `MSC-DEC-263` · **Surface:** Melarc Ops · **Test level:** contract · **Code:** `VALIDATION_FAILED`

### `AC-SLICE-000-88` — A setup grant is single-use, and two completions have one winner

```text
Given one STAFF_CREDENTIAL_SETUP grant,
When two completeStaffCredentialSetup requests carrying it arrive concurrently, and a third arrives after one has succeeded,
Then exactly one succeeds and sets the password,
And the others are refused with SETUP_GRANT_INVALID,
And an expired grant and a grant issued for another principal are refused with the same code,
And the winner's password is the one that verifies.
```

**Governs:** `MSC-DEC-259`, `MSC-DEC-267` · **Surface:** Melarc Ops · **Test level:** integration · **Code:** `SETUP_GRANT_INVALID`

### `AC-SLICE-000-89` — A lapsed setup grant is re-issued, and an identity that already has a credential is refused

```text
Given an ACTIVE staff identity whose STAFF_CREDENTIAL_SETUP grant expired unused,
When Senior Ops or Platform Admin calls reissueStaffCredentialSetup with a reason code and the ETag read with getStaffIdentity,
Then a fresh grant is delivered to the identity's work email and an earlier pending grant is superseded and refused at completeStaffCredentialSetup with SETUP_GRANT_INVALID,
And an identity that already holds a credential is refused with STATE_CONFLICT,
And an empty reason_code is refused with REASON_REQUIRED,
And a Senior Ops caller for an identity whose bundle is privileged is refused with INSUFFICIENT_AUTHORITY.
```

**Governs:** `MSC-DEC-247`, `MSC-DEC-248` · **Surface:** Melarc Ops · **Test level:** API · **Code:** `STATE_CONFLICT`, `REASON_REQUIRED`, `INSUFFICIENT_AUTHORITY`

### `AC-SLICE-000-90` — A refused delivery rolls the approval back

```text
Given a staff identity in PENDING_APPROVAL and a delivery channel that refuses the message,
When a different Senior Ops user calls approveStaffIdentity,
Then the answer is CREDENTIAL_DELIVERY_FAILED,
And the identity is still PENDING_APPROVAL, no grant exists and no auth.setup_grant.issued was recorded,
And when the channel accepts, a second call succeeds and issues exactly one grant,
And the raw token appears in no log, no row and no audit event.
```

**Governs:** [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.9a, `MSC-DEC-247` · **Surface:** backend · **Test level:** integration · **Code:** `CREDENTIAL_DELIVERY_FAILED`

### `AC-SLICE-000-91` — A failed sign-in is audited with its precise cause and answers the same to everyone

```text
Given an unknown email, a wrong password, a suspended identity, a locked identity and a wrong MFA code,
When each is submitted,
Then the four password-step cases receive the one INVALID_CREDENTIALS answer and the code receives MFA_PROOF_INVALID,
And each writes auth.session.failed with the factor the request had reached and one cause from the catalogue's closed set — UNKNOWN_PRINCIPAL, INELIGIBLE_PRINCIPAL, WRONG_PASSWORD, LOCKED_OUT or WRONG_MFA_CODE,
And no record holds a password, a code or a token.
```

**Governs:** §37.7, `MSC-DEC-431`, [audit.md](../../contracts/audit.md) §5.4 · **Surface:** Melarc Ops · **Test level:** API · **Code:** `INVALID_CREDENTIALS`, `MFA_PROOF_INVALID`

### `AC-SLICE-000-92` — The bootstrap secret is consumed when the password is set and can never start MFA enrolment

```text
Given one of the two seeded bootstrap Platform Admins, holding their own BOOTSTRAP_SETUP secret, no password and no factor,
When the secret is presented to completeMfaEnrolment before any password exists,
Then it is refused with SETUP_GRANT_INVALID because it is not an MFA_ENROLMENT grant, and the secret is not consumed,
And when the administrator calls completeStaffCredentialSetup with the secret and a valid password,
Then the password is established, the secret is consumed and a PENDING MfaFactor is provisioned with a separate MFA_ENROLMENT continuation grant,
And a second use of the bootstrap secret is refused with SETUP_GRANT_INVALID,
And presenting the continuation grant with a proven code makes the factor ACTIVE and the identity authentication-ready,
And auth.bootstrap.completed is written once for this identity, as an enhanced record,
And none of these operations issues a session.
```

**Governs:** `MSC-DEC-260`, `MSC-DEC-267`, `MSC-DEC-440`, [MIGRATION_AND_SEEDING.md](../../architecture/MIGRATION_AND_SEEDING.md) · **Surface:** Melarc Ops · **Test level:** integration · **Code:** `SETUP_GRANT_INVALID`

### `AC-SLICE-000-93` — An expired continuation grant is recovered by a provisioning mechanism no API operation or screen can invoke

```text
Given either bootstrap Platform Admin, who set a password and whose MFA_ENROLMENT continuation grant expired with the factor still PENDING, whatever state the other is in,
When the provisioning-only resume command is run,
Then a fresh MFA_REENROLMENT authorisation is delivered through the controlled provisioning channel and an enhanced audit record is written under the reserved system actor,
And beginMfaReenrolment consumes it, supersedes the unusable PENDING factor and issues a new continuation grant,
And no session is granted, the password is neither reset nor revealed and BOOTSTRAP_SETUP is not resurrected,
And no API operation and no Ops Portal screen can invoke the command.
```

**Governs:** `MSC-DEC-272`, `MSC-DEC-440`, [MIGRATION_AND_SEEDING.md](../../architecture/MIGRATION_AND_SEEDING.md) · **Surface:** backend · **Test level:** integration

### `AC-SLICE-000-94` — A wrong enrolment code leaves the factor PENDING

```text
Given a staff identity with a PENDING MfaFactor and a live MFA_ENROLMENT grant,
When completeMfaEnrolment is called with a wrong code,
Then it is refused with MFA_PROOF_INVALID, the factor stays PENDING and the grant is not consumed,
And a privileged sign-in for the identity still yields no session,
And a correct code on the same grant then makes the factor ACTIVE.
```

**Governs:** `MSC-DEC-262`, `MSC-DEC-267` · **Surface:** Melarc Ops · **Test level:** API · **Code:** `MFA_PROOF_INVALID`

### `AC-SLICE-000-115` — The creation screen offers the bundles the contract returns, and none of its own

```text
Given an Ops Staff user who holds staff.identity.create and permission.assignable_bundle.read and does not hold permission.read,
When the staff creation screen opens,
Then the bundle field offers exactly the bundles listAssignableStaffRoleBundles returns for that user, by name,
And each bundle in that response carries only its identifier, its display name and requires_platform_admin_approval,
And the Rider and Vendor bundles are never offered,
And the screen carries no bundle list of its own, so a bundle withdrawn from the response is gone from the field on the next load.
```

**Governs:** `MSC-DEC-439`, `MSC-DEC-443`, [permissions.md](../../contracts/permissions.md) §8 · **Surface:** Melarc Ops · **Test level:** e2e

### `AC-SLICE-000-116` — The bundle read needs its own key, and neither staff.identity.create nor permission.read substitutes

```text
Given a Platform Admin whose bundle has had permission.assignable_bundle.read removed by configuration and still holds staff.identity.create and permission.read,
When they call listAssignableStaffRoleBundles,
Then the answer is PERMISSION_DENIED and nothing is returned,
And an Ops Staff user, who holds permission.assignable_bundle.read and not permission.read, receives the list,
And a user whose bundle holds permission.assignable_bundle.read and not staff.identity.create receives the list and is refused createStaffIdentity with PERMISSION_DENIED,
And a Finance/Reconciliation user, who holds neither key, is refused with PERMISSION_DENIED,
And a request with no session is answered SESSION_INVALID.
```

**Governs:** `MSC-DEC-439`, `MSC-DEC-443`, `MSC-DEC-432` · **Surface:** Melarc Ops · **Test level:** API · **Code:** `PERMISSION_DENIED`, `SESSION_INVALID`

### `AC-SLICE-000-117` — Choosing a privileged bundle grants nothing, and the list reveals no authority

```text
Given the list marks the Senior Ops and Platform Admin bundles with requires_platform_admin_approval true,
When a Senior Ops maker creates a staff profile naming one of them from the list,
Then the profile is PENDING_APPROVAL, no session can be issued for it, and only a Platform Admin other than the maker can approve it,
And a different Senior Ops user, not the maker, who tries to approve it is refused with INSUFFICIENT_AUTHORITY,
And no response from the list carries a permission key, a permission count or the holder of any bundle,
And createStaffIdentity naming a Rider or Vendor bundle, which is not on the list, is refused with VALIDATION_FAILED.
```

**Governs:** `MSC-DEC-439`, `MSC-DEC-443`, `MSC-DEC-248`, `MSC-DEC-253` · **Surface:** Melarc Ops · **Test level:** API · **Code:** `INSUFFICIENT_AUTHORITY`, `VALIDATION_FAILED`

### `AC-SLICE-000-118` — The bootstrap is exactly two identities, and the first profile one makes only the other approves

```text
Given an empty staff table and a provisioning run that names two distinct work emails,
When the seed runs and is then run a second time,
Then exactly two StaffIdentity records exist, each ACTIVE with a Platform Admin bundle, its own work email and its own single-use BOOTSTRAP_SETUP secret held only as a hash, and neither holds a password or an MFA factor,
And each records the reserved system actor as created_by and approved_by and writes staff.identity.created and staff.identity.approved as enhanced records,
And the second run creates nothing,
And once both administrators have completed the steps of AC-SLICE-000-92 and signed in, one creates a staff profile and is refused with SELF_APPROVAL_FORBIDDEN when they try to approve it with the version they read with getStaffIdentity,
And the other administrator finds it with listStaffIdentities, reads its version with getStaffIdentity and approves it with that version,
And, in a separate environment that starts with an empty staff table, a run that names one email, three emails or the same email twice creates no identity and leaves the table empty.
```

**Governs:** `MSC-DEC-440`, `MSC-DEC-443`, [MIGRATION_AND_SEEDING.md](../../architecture/MIGRATION_AND_SEEDING.md) §3 · **Surface:** backend · **Test level:** integration · **Code:** `SELF_APPROVAL_FORBIDDEN`

## 14. Open questions blocking this feature

| ID| What it blocks here| Type|
|---|---|---|
| `OQ-047`| Service-account permissions — not this feature's staff paths| `ARTIFACT_REQUIRED`|
| ~~`OQ-067`~~| **Closed 5 September 2026, `MSC-DEC-371`** — staff sign-in **10/min**, privileged MFA **10/min**, on the buckets `MSC-DEC-285` created. The model was fixed by `MSC-DEC-224` and the ceilings are now set| ~~`VALUE_REQUIRED`~~|

**No `DECISION_NEEDED` question blocks this feature.** The authentication policy is confirmed in two places, §11.2 and §37.2, which agree.

**What blocks it is contract work, not decisions**, and this is the honest position:

| ~~Missing~~| Where it belonged| Status|
|---|---|---|
| ~~A `Session` entity~~| `domain-model.md` §6.8| **Done — 20 August**|
| ~~Field detail for `StaffIdentity`~~| `domain-model.md` §6.8| **Done — 20 August**|
| `Session` state machine| `state-machines.md` §13| **Present.** *Elevation is not, and correctly so* — `MSC-DEC-228` withdrew it|
| `INVALID_CREDENTIALS`, `MFA_REQUIRED`, `RATE_LIMITED`, `HUB_SCOPE_VIOLATION`| `errors-and-enums.md`| **Present**, with `SESSION_INVALID`, `MFA_ENROLMENT_REQUIRED`, `MFA_PROOF_INVALID` and `SETUP_GRANT_INVALID` added by Gate A|
| An `auth` audit family| `audit.md` §5.4| **Present** — the count is derived in the catalogue and not restated here|
| Lockout and session settings| `settings.md` §7.5| **Present.** *Elevation settings are not* — `mfa_elevation_minutes` was removed by `MSC-DEC-228`|
| Every authentication operation| `openapi.yaml`| **Present** — every operation `SLICE-000` §3 lists. Absent when this table was written and named by §37.8; delivered by Gate A, completed by R1 and R1.1, and given the reads the approver needs at Gate PD-3R1|

**All seven contracts have since been extended and nothing in the table above is outstanding.**

## 15. What this feature still owes its slice

Use the current transition tables and feature criteria. No additional document-signing step is required for this feature; production dependencies remain in the relevant deployment and slice sections.

**§6.8 now carries the identity entities in full**, including `Session` — this section previously said `Session` was *“not named at all”* and that the entities carried no fields. §37.8's gate passed seven of seven on 20 August, and `MSC-DEC-234` and `MSC-DEC-236` supplied every figure.

**Readiness is not assessed here.** [definition-of-ready.md](../../standards/definition-of-ready.md) assesses it **for the complete vertical slice** and records the verdict in the slice document; a feature cannot answer §44.3 or §44.4 alone. This section feeds that assessment instead of duplicating it (`MSC-DEC-239`, closing `CONFLICT-029`).

## 16. Build status — *honest, per surface*

| Surface| Status|
|---|---|
| Melarc Ops| **Specified and buildable.** All seven contracts carry the identity domain: the operations `SLICE-000` §3 lists, the `Session`, `StaffIdentity`, `MfaFactor` and `SetupGrant` entities, the `auth` audit family, the session and lockout settings.|
| Melarc Vendor| N/A|
| Melarc Rider| N/A|

## 17. Related

- **Siblings:** [rider-authentication](rider-authentication.md) · [vendor-authentication](vendor-authentication.md) · [credential-recovery](credential-recovery.md) · [permission-enforcement](permission-enforcement.md).
- **Architecture:** [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) · [SOLUTION_ARCHITECTURE.md](../../architecture/SOLUTION_ARCHITECTURE.md)
- **Contracts:** [permissions.md](../../contracts/permissions.md) · [audit.md](../../contracts/audit.md)
