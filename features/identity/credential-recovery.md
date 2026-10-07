# Credential recovery

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.15 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** the three recovery paths, who authorises each, and what recovery must do to existing sessions
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §11.2, §37.2, §37.5, §30.3, §30.4, and cross-cutting §35, §37.1, §38, §42
> **Slice:** `SLICE-000`

## 1. What this is, and why

Three principal types, **three different recovery paths, three different authorities** (§11.2, §37.2):

| Principal| Channel| Exceptional authority|
|---|---|---|
| **Staff**| Verified work email| **Platform Admin**|
| **Vendor**| Registered phone or email| **Platform Admin**|
| **Rider**| **Ops identity verification and device re-registration**| **Senior Ops**|

The rider path is not a channel at all — it is a **human verification step**. A rider who has lost their handset cannot receive a link, because the device *is* half the credential. That asymmetry is the whole reason this feature exists separately.

## 2. Governing sections

| Section| What it governs here|
|---|---|
| §11.2| The three recovery channels and the two exceptional authorities|
| §37.2| The same as security policy|
| §37.5| **Recovery must "revoke or control prior sessions"** — the binding requirement for the shared vendor credential|
| §30.3| Staff credential setup and recovery|
| §30.4| Rider assigned device and phone|
| §37.1| Deny by default|


## 3. Surfaces and actors

| Surface| Actor| Can do| Gated by|
|---|---|---|---|
| Melarc Ops| Staff (self)| Request recovery to their own verified work email| —|
| Melarc Ops| **Platform Admin**| Exceptional staff and vendor recovery (§11.2)| Privileged — and the role cannot sign in without a second factor|
| Melarc Ops| **Senior Ops**| Rider identity verification and device re-registration| Privileged — and the role cannot sign in without a second factor|
| Melarc Ops| Ops Staff| **Cannot recover anyone**, including themselves beyond the ordinary email path| —|
| Melarc Vendor| Vendor account| Request recovery to a registered phone or email| —|
| Melarc Rider| Rider| **No self-service path exists**| —|

## 4. Preconditions

- **Staff:** the work email on the identity record (§37.2). **Version 1 has no separate email-verification lifecycle or state, by decision** (`MSC-DEC-435`; [staff-authentication.md](staff-authentication.md) §4), so there is no *unverified* case to refuse and none to test: the address is accurate because the authorised create-and-approve process established it, the message goes to that address and to no other, and **a failed delivery is a delivery and recovery outcome — recovery is still answered the same way — and not an identity state**. An identity with no credential has none to repair and is re-issued a setup grant instead (§6).
- **Vendor:** at least one registered phone or email on `VendorCredential`.
- **Rider:** an existing `RiderIdentity`. Verification is performed by a human, so no stored channel is required.

## 4.1 Password recovery never touches MFA

**This is the single most important rule in this feature**. Recovering or changing a privileged staff password **does not reset, remove, bypass or replace the MFA factor.**

**Consider what the alternative buys an attacker.** The recovery channel for a staff password is the verified work email. If recovery also cleared MFA, then compromising that mailbox would convert *"password **and** a second factor"* into *"control of the email account"* — and the email account is the thing the password recovery already trusts. **The second factor would protect nothing it was added to protect.**

**MFA loss now has a completion path, which it did not have until R1.** `resetStaffMfa` revoked the factor and issued an `MFA_REENROLMENT` grant, and **no operation in the contract could redeem that grant for a new TOTP secret** — the identity held an authorisation to re-enrol and no way to act on it. `beginMfaReenrolment` provisions the new `PENDING` factor and issues a short-lived `MFA_ENROLMENT` continuation grant; **activation still requires a proven code**, so a reset authorisation never substitutes for possession of the new authenticator.

**MFA loss is therefore a separate event with a different authority.** `resetStaffMfa`, held by `staff.mfa.reset`, **Platform Admin only**, mandatory reason, enhanced-audited: the old factor is revoked, every target session terminates with `MFA_RESET`, and a re-enrolment grant is issued to the target's own verified email — **never returned to the acting administrator**, who must not be able to complete someone else's enrolment.

**What `resetStaffMfa` refuses** (Product decision, 6 October 2026). **A Platform Admin cannot reset their own factor** (`SELF_APPROVAL_FORBIDDEN`): another Platform Admin acts, which is why the product keeps two. A target whose factor is only `PENDING` has no `ACTIVE` factor to revoke, and a non-privileged identity has no MFA at all: both are `STATE_CONFLICT`. **The other bootstrap administrator is a valid actor**, as is any other Platform Admin. A stranded bootstrap administrator is resumed through the provisioning channel (§5.6). The `reason_code` is a code of the MFA-reset domain ([domain-model.md](../../contracts/domain-model.md) §3.9): `REASON_REQUIRED` when empty, `REASON_NOT_ACTIVE` when unknown, retired or from another domain.

**There are no backup codes, bypass codes or support overrides.** Each would be a weaker secret that silently defeats the stronger one, which is the failure this section exists to prevent.

## 5. Behaviour

### 5.1 The three paths

**Staff — self-service to a verified channel.** The staff member requests recovery; a time-bounded link goes to the **verified work email only**. Never to an address supplied in the request — that would let anyone redirect a colleague's recovery.

**Vendor — self-service to a registered channel.** Same shape, to the credential's `delivery_channel`: the registered phone or the registered email, whichever the approver chose at approval ([domain-model.md](../../contracts/domain-model.md) §6.8). **Never to a channel supplied in the request.**

**Vendor recovery is also the controlled way to register a new browser.** Completing it revokes obsolete device credentials and issues a fresh `melarc_vendor_device` to the browser that completed recovery — which, since ordinary sign-in requires that credential and never issues one, makes recovery and initial setup **the only two routes a browser becomes registered**. That is deliberate: the alternative is a login that registers whoever asks.

**Recovery issues no session.** The vendor signs in afterwards, presenting the new secret **and** the new device credential.

**Rider — Ops verification, then re-registration.** Senior Ops verifies the rider's identity by means outside the system, then calls `reregisterRiderDevice`, which returns a **scannable enrolment URI**. The Ops Portal renders it as a QR code; the **new handset** scans it and redeems it through `completeRiderDeviceEnrolment` — the same operation, and the same transport, as first registration. **The replacement generates its own non-exportable keypair; no private key is ever moved between devices.** The rider sets a new PIN on the newly registered handset.

### 5.2 What recovery must do to sessions, and why it is the point

§37.5 requires recovery to **"revoke or control prior sessions."** This feature implements that as: **completing recovery terminates every session for that principal**, with `CREDENTIAL_CHANGED`.

**For the shared vendor credential this is the entire purpose of recovery.** A vendor changing the secret is usually trying to remove access from a former employee who knows it. If prior sessions stay live, that person keeps working until their session happens to expire — and recovery achieved nothing except a new password.

**The session performing the change is terminated too.** Making an exception for the initiator is the reflexive kindness, and it is wrong: on a shared credential the system cannot tell whether the initiator is the legitimate owner or the person being removed.

### 5.3 Exception paths

| Path| Behaviour| Error code|
|---|---|---|
| Recovery requested for an unknown identifier| **Responds identically to a known one** — `202`, the same body, the same timing. No enumeration (§37.7)| — *(`202`)*|
| Recovery requested with a destination| **Rejected outright.** The request has no destination field and no extra property is accepted, so an address cannot be supplied to be ignored. Only the registered channel is ever used| `VALIDATION_FAILED`|
| A suspended principal requests recovery| **Proceeds like any other.** Completion sets the new credential and **the suspension stands**; sign-in still fails. A suspension is not undone by a password reset| — *(`202`)*|
| The recovery message cannot be delivered, self-service| The request is **rolled back**, the caller is told nothing different (`202`), and the failure is logged and counted by the provider-failure alert — never disclosed| — *(`202`)*|
| The recovery message cannot be delivered, Platform-Admin-initiated| The operation is rolled back; nothing was sent and the administrator may issue again| `CREDENTIAL_DELIVERY_FAILED`|
| Rider requests self-service| **No path exists.** The surface offers none| —|
| Ops Staff or Senior Ops attempts staff or vendor recovery, or Ops Staff attempts rider re-registration| Refused — the key (`staff.credential.recover`, `vendor.credential.recover`, `staff.device.reregister`) is not in their bundle| `PERMISSION_DENIED`|
| Recovery link malformed, expired, already consumed or superseded| **One answer for all four.** It never says which, and a reused link is not signalled to the person holding it| `RECOVERY_TOKEN_INVALID`|
| Repeated recovery requests| Rate-limited per recovery principal, 10 a minute| `RATE_LIMITED`|
| New credential shorter than 12 or longer than 128 characters| Refused by the schema; the message names the field and **never the value**| `VALIDATION_FAILED`|
| Ops-initiated recovery with a stale `If-Match`, or against an identity that holds no credential| Refused| `STATE_CONFLICT`|
| Ops-initiated recovery with an empty `reason_code`| Refused| `REASON_REQUIRED`|
| Ops-initiated recovery with an unknown, retired or foreign-domain `reason_code`| Refused| `REASON_NOT_ACTIVE`|
| A second self-service request inside `recovery_request_supersede_guard_seconds` of the pending link| **Nothing happens and nothing is revealed**: the pending link stands and no other is issued (§5.5)| — *(`202`)*|
| `resetStaffMfa` on oneself; on a target whose factor is only `PENDING`; on a non-privileged identity| Refused (§4.1)| `SELF_APPROVAL_FORBIDDEN`; `STATE_CONFLICT` for the other two|
| `reissueStaffCredentialSetup` naming a bootstrap identity| Refused (§5.6)| `STATE_CONFLICT`|
| A principal locked by failed sign-ins completes recovery| **The lock is cleared**: the failed-attempt count is zero and `locked_until` is empty| —|

**Why a destination is rejected and not ignored.** An earlier version of this table, `AC-SLICE-000-20` and the `SLICE-000` script said it was *ignored entirely*; the contract has always said *rejected outright* and its request body is `additionalProperties: false`. A request that carries a destination is a request someone is attempting to redirect, and an API that accepts it silently teaches the attacker which field to try next.

### 5.4 What this feature must never do

- **Never send recovery to an address or number supplied in the request.** Registered channels only. This is the single most exploitable mistake available in this feature.
- **Never reveal whether an identifier exists.** A recovery request for an unknown email must respond exactly as for a known one (§37.7).
- **Never leave a session alive after recovery completes**, including the initiator's (§37.5).
- **Never let a rider self-re-register.** §37.2 makes rider recovery a human verification step, and self-service would make the one-device binding voluntary.
- **Never let recovery lift a suspension.** They are different states with different authorities; a suspended principal who recovers a credential is still suspended.
- **Never log, display or return the new credential** to the staff member performing a recovery. Recovery re-establishes a path to set a credential; it never reveals one.
- **Never let a role without a second factor reach these operations.** `MSC-DEC-228` gates that at sign-in rather than at the action, so by the time a Senior Ops or Platform Admin session exists the factor has already been presented.

### 5.5 A second request inside the guard window

A self-service request made **less than `recovery_request_supersede_guard_seconds` after the pending link was issued** (60 at launch, [settings.md](../../contracts/settings.md) §7.5) **neither supersedes that link nor issues another** (Product decision, 6 October 2026). Nothing is sent and nothing is stored, and the answer is **the same `202`**, in content and timing, as for any request, so it reveals neither the guard nor that a link is pending. A request made after the window supersedes the pending link as before ([domain-model.md](../../contracts/domain-model.md) §6.8, `RecoveryRequest`). The guard counts toward `rate_limit_recovery` like any request. **It is stated for the self-service request, whose answer is the `202`**: `recoverStaffCredential` and `recoverVendorCredential` return the `RecoveryRequest` they create, and the decision does not extend the guard to them.

### 5.6 A stranded bootstrap administrator

An identity that is one of the two seeded bootstrap Platform Admins, holds a password and a `PENDING` factor, and whose continuation grant has lapsed is **stranded** ([MIGRATION_AND_SEEDING.md](../../architecture/MIGRATION_AND_SEEDING.md) §3.3a). Three rules (Product decision, 6 October 2026). **`reissueStaffCredentialSetup` refuses a bootstrap identity** (`STATE_CONFLICT`), because a fresh 30-minute grant would go to an address nobody verified. **The provisioning-channel resume command works for a stranded identity for as long as that identity itself holds no `ACTIVE` factor**, whether or not the other bootstrap administrator is ready, and it refuses by itself once the identity's factor is `ACTIVE` or the identity is offboarded, so it is never a standing way in. **The other Platform Admin uses `resetStaffMfa`** for an identity whose factor is `ACTIVE`, which a stranded identity's is not.

**Still open (Product Owner).** An ordinary privileged identity in the same state (a password, a `PENDING` factor, a lapsed enrolment grant) is not one of the seeded pair, so it has no provisioning command, and `resetStaffMfa` refuses a `PENDING`-only target (§4.1): no route reaches it. Whether `resetStaffMfa` accepts such a target when an approval verified its work email is not decided ([MIGRATION_AND_SEEDING.md](../../architecture/MIGRATION_AND_SEEDING.md) §7).

## 6. Entities — *pointer*

| Entity| Where|
|---|---|
| `StaffIdentity`, `RiderIdentity`, `VendorCredential`, `RegisteredDevice`, `Session`, **`RecoveryRequest`**, `SetupGrant`| [domain-model.md](../../contracts/domain-model.md) §6.8|

**`RecoveryRequest` is the entity this feature runs on**, and it is present.

**`RecoveryRequest` repairs an existing credential; `SetupGrant` establishes a new authentication capability** (R1.3). Every path in this feature is a `RecoveryRequest` — self-service **and** Platform-Admin-initiated. Device enrolment and first credentials are `SetupGrant`, and belong to the features that own them.

**The boundary has a third case, and it is not a recovery** (MED-10 audit remediation). A `STAFF_CREDENTIAL_SETUP` or `VENDOR_CREDENTIAL_SETUP` grant that expires before anyone acts on it leaves a principal with **no credential to repair** — this feature's own operations cannot reach it, by the same rule that keeps them apart from establishment in the first place. `reissueStaffCredentialSetup` and `reissueVendorCredentialSetup` ([staff-authentication.md](staff-authentication.md) §12, [vendor-authentication.md](vendor-authentication.md) §12) re-issue the lapsed `SetupGrant` itself — establishment repeated, not recovery performed — and belong to the features that own establishment, for the identical reason the first grant does.

## 7. States — *pointer*

[state-machines.md](../../contracts/state-machines.md) **§13 `Session`** — recovery drives `→ TERMINATED` with `CREDENTIAL_CHANGED`. **Approved 21 August** by `MSC-DEC-227`.

## 8. Permissions — *pointer*

[permissions.md](../../contracts/permissions.md) §7. **`staff.credential.recover`, `vendor.credential.recover`, `staff.device.reregister` and `staff.device.register` all exist**, and Gate A adds **`staff.mfa.reset`** (Platform Admin only).

## 9. Settings — *pointer*

[settings.md](../../contracts/settings.md) §7.5 — **the lockout keys do not apply to recovery**: a recovery token is single-use, high-entropy and rate-limited (`rate_limit_recovery`), a failed token locks nothing, and completing recovery **clears** a lock on the credential it repairs ([SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.4b). **`recovery_link_ttl_minutes` = 30 sets the recovery-link lifetime**. **`recovery_request_supersede_guard_seconds` = 60 sets the window of §5.5.**

## 10. Errors — *pointer*

[errors-and-enums.md](../../contracts/errors-and-enums.md) — `RECOVERY_TOKEN_INVALID`, `VALIDATION_FAILED`, `RATE_LIMITED`, `PERMISSION_DENIED`, `STATE_CONFLICT`, `REASON_REQUIRED`, `REASON_NOT_ACTIVE`, `SELF_APPROVAL_FORBIDDEN`, `NOT_FOUND`, `HUB_SCOPE_VIOLATION`, `CREDENTIAL_DELIVERY_FAILED`, `SETUP_GRANT_INVALID`. **`CODE_EXPIRED` was listed here and is a doorstep-handshake code**; the contract's expired, consumed or malformed link is `RECOVERY_TOKEN_INVALID`, one answer for all three. **`INSUFFICIENT_AUTHORITY` was listed here and does not apply**: it means *the key is held and the tier is too low*, and every recovery key is held by exactly one tier.

## 11. Audit events — *pointer*

[audit.md](../../contracts/audit.md) §5.4 — `auth.credential.changed`, `auth.device.registered` *(enhanced)*, `auth.session.terminated`, `auth.mfa.reset` and `auth.lockout.applied`. **No event records a refused recovery message**: the refusal is a request-log entry and a provider-failure alert, and it is never shown to the caller.

**`auth.credential.changed` records that a credential changed and never the value** — the same rule §20.4 applies to OTPs.

## 12. API operations — *pointer*

**They exist.** [openapi.yaml](../../contracts/openapi.yaml) carries `requestCredentialRecovery` and `completeCredentialRecovery` for the two self-service paths, and Gate A added `resetStaffMfa`, `completeStaffCredentialSetup`, `completeMfaEnrolment`, `registerRiderDevice`, `completeRiderDeviceEnrolment` and `completeVendorCredentialSetup`.

**R1 replaced `performOpsRecovery` with three operations** — `recoverStaffCredential`, `recoverVendorCredential` and `reregisterRiderDevice` — and added `beginMfaReenrolment`. **`recoverStaffCredential` and `recoverVendorCredential` take a `CredentialRecoveryInitiation`** — a required `reason_code` and an optional `note`; the polymorphic `OpsRecovery` body is gone, because its path already names the principal and its `principal_type` and `principal_id` were dead fields. **`reregisterRiderDevice` takes a `RiderDeviceReregistration`**: a `reason_code` and a **mandatory `verification_note`** saying how Senior Ops verified the rider in person. Their `If-Match` comes from `getStaffIdentity`, `getVendorAccount` and `getRider`.

**One operation, one authority.** `performOpsRecovery` declared a single `x-permission` while its own description named **three different authorities** for the three principal types, so the permission actually enforced depended on the request body. **No mechanical check can verify that, and no reader can rely on it**: `permissions.md` already held `staff.credential.recover` (Platform Admin), `vendor.credential.recover` (Platform Admin) and `staff.device.reregister` (Senior Ops, own hub) as three separate keys with three different scopes. The split introduced no new permission — **it connected the operations to the keys that were already there.**

**R1.3 finished the job by making them one *entity* as well as one authority.** Both replacements claimed to issue a **`SetupGrant`** while returning a **`RecoveryRequest`** and directing the principal to a consumer that reads recovery tokens and reports `RECOVERY_TOKEN_INVALID`. **Producer, response and consumer named three different lifecycles for one act.** They now create a `RecoveryRequest` from end to end.


## 13. Acceptance criteria

### `AC-SLICE-000-20` — Recovery goes only to a registered channel, and a supplied destination is rejected

```text
Given a staff member or a vendor account requesting recovery,
When the request includes an alternative email address or phone number,
Then the request is rejected outright with VALIDATION_FAILED, because the request has no destination field,
And nothing is sent and no RecoveryRequest is created,
And when the request carries only the identifier, the link is sent to the verified work email on the staff record, or to the registered phone or email of the vendor account that its `delivery_channel` names, and to no other address.
```

**Governs:** §37.2 · **Surface:** Melarc Ops, Melarc Vendor · **Test level:** API · **Code:** `VALIDATION_FAILED`

### `AC-SLICE-000-21` — Recovery does not disclose whether an account exists

```text
Given an identifier that belongs to no principal,
When recovery is requested for it,
Then the response is identical in content and timing to a request for a real principal,
And no message, status code or delay distinguishes the two,
And this holds when the delivery adapter is made to take its full timeout for the real principal.
```

**Governs:** §37.7 · **Surface:** Melarc Ops, Melarc Vendor · **Test level:** API

### `AC-SLICE-000-22` — Completing recovery terminates every session

```text
Given a vendor account with a live session on a registered browser,
When recovery completes and the shared secret changes,
Then every session for that account terminates with CREDENTIAL_CHANGED,
And no session exists for the account afterwards,
And the browser that was using it cannot continue working.
```

**Governs:** §37.5 · **Surface:** Melarc Vendor · **Test level:** integration

### `AC-SLICE-000-23` — Recovery authority is split and enforced

```text
Given an Ops Staff user,
When they attempt to re-register a rider device,
Then it is refused with PERMISSION_DENIED, because staff.device.reregister is Senior Ops's and the Ops Staff bundle does not carry it,
And a Senior Ops user at the rider's hub succeeds,
And a Senior Ops user attempting exceptional vendor recovery is refused with PERMISSION_DENIED, because vendor.credential.recover is Platform Admin's,
And a Platform Admin succeeds at that,
And the privileged roles that succeed hold sessions that could only have been issued after a proven second factor.
```

**Governs:** §11.2, §37.2, §37.4, `MSC-DEC-432` · **Surface:** Melarc Ops · **Test level:** API · **Code:** `PERMISSION_DENIED`

### `AC-SLICE-000-24` — Recovery does not lift a suspension

```text
Given a suspended vendor account,
When recovery is requested and completed with a new secret,
Then the request is answered 202 like any other and completion sets the new secret and terminates every session with CREDENTIAL_CHANGED,
And the account remains suspended and a sign-in is refused with INVALID_CREDENTIALS, indistinguishable from any other refusal,
And no recovery path changes an account's operational state.
```

**Governs:** §37.3, §29.6 · **Surface:** Melarc Vendor · **Test level:** API · **Code:** `INVALID_CREDENTIALS`

### `AC-SLICE-000-36` — Password recovery leaves the MFA factor untouched

```text
Given a Platform Admin with an ACTIVE MfaFactor,
When they complete self-service password recovery,
Then the password is replaced,
And every session is terminated with CREDENTIAL_CHANGED,
And the MfaFactor remains ACTIVE and unchanged,
And the next sign-in still requires that factor.
```

**Governs:** `MSC-DEC-259` · **Surface:** Melarc Ops · **Test level:** integration

### `AC-SLICE-000-37` — MFA reset requires another Platform Admin and cannot disable MFA

```text
Given a Platform Admin whose authenticator has been lost,
When a Senior Ops user attempts resetStaffMfa,
Then it is refused with 403 PERMISSION_DENIED, because staff.mfa.reset is Platform Admin's,
And when another Platform Admin performs it with a reason_code,
Then the old factor is REVOKED,
And all target sessions terminate with MFA_RESET,
And the re-enrolment grant is delivered to the target's own work email and never returned to the acting administrator,
And the target cannot obtain a privileged session until a new factor is proven,
And no request shape exists that leaves the target privileged without a factor.
```

**Governs:** `MSC-DEC-259` · **Surface:** Melarc Ops · **Test level:** integration · **Code:** `PERMISSION_DENIED`

### `AC-SLICE-000-103` — An expired, consumed or malformed recovery link is one answer

```text
Given a recovery token that is malformed, expired, already consumed, or superseded by a newer request,
When completeCredentialRecovery is called with it,
Then every case is refused with RECOVERY_TOKEN_INVALID, identical in status, body and timing class,
And nothing in the response tells the caller that a consumed link had already been used,
And no credential changes and no session ends.
```

**Governs:** §37.7, `MSC-DEC-236` · **Surface:** Melarc Ops, Melarc Vendor · **Test level:** API · **Code:** `RECOVERY_TOKEN_INVALID`

### `AC-SLICE-000-104` — Recovery requests are rate-limited without disclosure

```text
Given a staff or vendor principal and the recovery limit of 10 a minute,
When more than ten recovery requests are made for it within a minute,
Then the excess requests are refused with RATE_LIMITED,
And an identifier that matches nothing is limited by the same bucket in the same way,
And every request within the limit is answered 202 whether or not the principal exists.
```

**Governs:** `MSC-DEC-224`, `MSC-DEC-371`, §37.7 · **Surface:** Melarc Ops, Melarc Vendor · **Test level:** API · **Code:** `RATE_LIMITED`

### `AC-SLICE-000-105` — Platform Admin starts staff recovery, and the new password reaches nobody

```text
Given an ACTIVE credentialed staff identity read with getStaffIdentity by a Platform Admin,
When the Platform Admin calls recoverStaffCredential with a reason_code and that ETag,
Then a RecoveryRequest with initiated_by set to the administrator is created and its link is delivered to the identity's work email only,
And the response carries no token and no credential, the password is unchanged and no session is created,
And when the staff member completes recovery themselves the password is replaced, every session ends with CREDENTIAL_CHANGED and the MfaFactor stays ACTIVE,
And an empty reason_code is refused with REASON_REQUIRED, a stale ETag with STATE_CONFLICT, and a Senior Ops caller with PERMISSION_DENIED.
```

**Governs:** §11.2, §37.2, `MSC-DEC-259` · **Surface:** Melarc Ops · **Test level:** integration · **Code:** `REASON_REQUIRED`, `STATE_CONFLICT`, `PERMISSION_DENIED`

### `AC-SLICE-000-106` — A completed recovery clears a lock

```text
Given a staff identity locked by five wrong passwords and a vendor account locked by five wrong secrets,
When each principal completes credential recovery with a valid new credential,
Then the failed-attempt count is zero and the lock is cleared,
And the next sign-in with the new credential succeeds, a vendor from a browser registered by the recovery,
And the recovery itself was never blocked by the lock.
```

**Governs:** `MSC-DEC-431` · **Surface:** Melarc Ops, Melarc Vendor · **Test level:** integration

### `AC-SLICE-000-107` — A refused recovery message is invisible to the caller and leaves nothing behind

```text
Given a registered staff identity and a delivery channel that refuses the message,
When requestCredentialRecovery is called for it,
Then the answer is 202, identical to a request for an identifier that matches nothing,
And no RecoveryRequest exists afterwards and an earlier pending request is untouched,
And the refusal is counted by the provider-failure alert and is never disclosed,
And CREDENTIAL_DELIVERY_FAILED is not returned.
```

**Governs:** [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.9a, §37.7 · **Surface:** backend · **Test level:** integration

### `AC-SLICE-000-108` — A device re-registration records why, and how identity was verified

```text
Given a rider with an ACTIVE device read with getRider, and Senior Ops at the rider's hub with the rider present,
When Senior Ops calls reregisterRiderDevice with a reason_code, a verification_note and that ETag,
Then a RIDER_DEVICE_REREGISTRATION grant is returned as a scannable enrolment URI and no PIN, key or token is shown to the officer,
And a call with no verification_note is refused with VALIDATION_FAILED and one with an empty reason_code with REASON_REQUIRED,
And a stale ETag is refused with STATE_CONFLICT,
And a rider outside the actor's hubs is refused with HUB_SCOPE_VIOLATION and one that does not exist with NOT_FOUND.
```

**Governs:** §37.2, §30.4, `MSC-DEC-235`, `MSC-DEC-432` · **Surface:** Melarc Ops · **Test level:** API · **Code:** `VALIDATION_FAILED`, `REASON_REQUIRED`, `STATE_CONFLICT`, `HUB_SCOPE_VIOLATION`

### `AC-SLICE-000-119` — MFA reset refuses a self-reset, a PENDING-only target and a non-privileged identity

```text
Given two Platform Admins A and B, a Senior Ops user, an Ops Staff user and a privileged identity whose only factor is PENDING,
When A calls resetStaffMfa naming A, and then naming the Ops Staff user and the PENDING-only identity,
Then naming A is refused with SELF_APPROVAL_FORBIDDEN and nothing changes,
And naming the Ops Staff user, who has no MFA, and the identity whose factor is only PENDING are each refused with STATE_CONFLICT and nothing changes,
And B calling resetStaffMfa naming A, whose factor is ACTIVE, succeeds,
And when A and B are the two bootstrap Platform Admins, each is a valid actor for the other,
And an empty reason_code is refused with REASON_REQUIRED and a retired, unknown or foreign-domain one with REASON_NOT_ACTIVE.
```

**Governs:** [state-machines.md](../../contracts/state-machines.md) §18 · **Surface:** Melarc Ops · **Test level:** API · **Code:** `SELF_APPROVAL_FORBIDDEN`, `STATE_CONFLICT`, `REASON_REQUIRED`, `REASON_NOT_ACTIVE`

### `AC-SLICE-000-120` — A bootstrap identity cannot be re-issued a setup grant, and the resume command is not a standing way in

```text
Given the two bootstrap Platform Admins, A stranded with a password, a PENDING factor and a lapsed MFA_ENROLMENT grant, and B holding an ACTIVE credential and an ACTIVE factor,
When B calls reissueStaffCredentialSetup naming A, and again naming a bootstrap identity that has not yet set a password,
Then each is refused with STATE_CONFLICT and no grant is issued,
And the provisioning-only resume command run for A issues the fresh MFA_REENROLMENT authorisation, although B is authentication-ready,
And once A holds an ACTIVE factor the same command refuses for A,
And run for an identity that is not one of the two bootstrap identities it refuses,
And no API operation and no screen can invoke the command.
```

**Governs:** [MIGRATION_AND_SEEDING.md](../../architecture/MIGRATION_AND_SEEDING.md) §3.3a · **Surface:** Melarc Ops, backend · **Test level:** integration · **Code:** `STATE_CONFLICT`

### `AC-SLICE-000-121` — A recovery request inside the guard window changes nothing and reveals nothing

```text
Given a staff member or a vendor account with a pending recovery link issued less than recovery_request_supersede_guard_seconds ago,
When requestCredentialRecovery is called for it again,
Then the answer is 202, identical in content and timing to a request for an identifier that matches nothing,
And the pending link is not superseded and still completes recovery, and no second link is issued or sent,
And once the guard window has passed a further request supersedes the pending link and issues a new one,
And the setting recovery_request_supersede_guard_seconds defaults to 60.
```

**Governs:** [settings.md](../../contracts/settings.md) §7.5, §5.5 above · **Surface:** Melarc Ops, Melarc Vendor · **Test level:** integration

### `AC-SLICE-000-125` — The credential setup operations share the recovery bucket

```text
Given the credential setup and recovery bucket, rate_limit_recovery, at 10 a minute,
When completeStaffCredentialSetup, completeMfaEnrolment, beginMfaReenrolment, completeVendorCredentialSetup, completeAdditionalDeviceEnrolment, completeRiderDeviceEnrolment and completeCredentialRecovery are each called more than ten times in a minute with the grant or token they take, a made-up one included,
Then the excess requests are refused with RATE_LIMITED from that bucket, keyed by the grant or token each request presents whether or not it matches a record,
And a request presenting a different grant or token has a key of its own,
And requestAdditionalDeviceGrant counts in the same bucket, under a key that is an open input (settings.md §9),
And no seventh bucket exists.
```

**Governs:** [settings.md](../../contracts/settings.md) §7.7 · **Surface:** Melarc Ops, Melarc Vendor, Melarc Rider · **Test level:** API · **Code:** `RATE_LIMITED`

## 14. Open questions blocking this feature

**Nothing in this section's original table is still missing.** Re-derived from the repository on 27 August rather than carried forward — the table below records what was absent when this feature was written and where each item now lives.

| ~~Missing~~| Where it belongs| Status, derived 27 Aug|
|---|---|---|
| ~~A `RecoveryRequest` entity — token, channel, expiry, single-use~~| `domain-model.md` §6.8| **Present**, with `SetupGrant` beside it|
| ~~Recovery-link lifetime and single-use rule~~| `settings.md` §7.5| **Present** — `recovery_link_ttl_minutes` = 30|
| ~~Recovery permissions for Platform Admin and Senior Ops~~| `permissions.md` §7| **Present** — `staff.credential.recover`, `vendor.credential.recover`, `staff.device.reregister`, `staff.mfa.reset`|
| ~~Every recovery API operation~~| `openapi.yaml`| **Present** — `requestCredentialRecovery`, `completeCredentialRecovery`, `recoverStaffCredential`, `recoverVendorCredential`, `reregisterRiderDevice`, `resetStaffMfa`, `beginMfaReenrolment`|

**This table asserted all four were missing until 27 August**, six days after the first of them landed. It is the reason §17 of the R1.1 instruction exists: a feature's *"what's missing"* section is read as current, and nothing had been re-deriving it.

| ID| What it blocks here| Type|
|---|---|---|
| —| **`OQ-050` is closed** — its device half by `MSC-DEC-235` (report revokes immediately, re-registration is in person at a hub; `staff.device.revoke` added for Ops Staff) and **offboarding authority** by `MSC-DEC-253`, which this feature does not touch| —|
| `OQ-048`| The SMS provider **and the transactional email provider**. Every recovery link and setup grant leaves through one delivery port, whose capture adapter keeps Local and Staging off real recipients ([SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.9a); choosing the providers is external| `EXTERNAL_INPUT`|

**The permission gap was the third of its kind** — after `OQ-047`'s reads and `OQ-065`'s manifest writes — and it is closed. Recovery is a write performed by staff on another principal's credential, and §11.4's matrix never enumerated it. **Three separate features have now each found a missing write permission by the same method** — naming the permission each actor needs and checking it against the catalogue. That is worth treating as evidence about the catalogue rather than three coincidences, and it was raised as `OQ-070`, which closed at `MSC-DEC-256`: §11.4's matrix is the policy view and `permissions.md` §7 the enforcement source.

## 15. What this feature still owes its slice

Use the current transition tables and feature criteria. No additional document-signing step is required for this feature; production dependencies remain in the relevant deployment and slice sections.

**All four artifacts this section called missing now exist**: the `RecoveryRequest` entity (§6.8), its settings (§7.5), its three permissions and its three operations. §13 `Session` was signed by `MSC-DEC-227`, and `MSC-DEC-235` settled rider device recovery — the gap this document called the reason `SLICE-000` could not be built.

**Readiness is not assessed here.** [definition-of-ready.md](../../standards/definition-of-ready.md) assesses it **for the complete vertical slice** and records the verdict in the slice document; a feature cannot answer §44.3 or §44.4 alone. This section feeds that assessment instead of duplicating it (`MSC-DEC-239`, closing `CONFLICT-029`).

## 16. Build status — *honest, per surface*

| Surface| Status|
|---|---|
| Melarc Ops| **Specified and buildable.** `recoverStaffCredential` and `recoverVendorCredential` exist under `staff.credential.recover` and `vendor.credential.recover`; both create a **`RecoveryRequest`** with `initiated_by` and neither returns a credential to the actor.|
| Melarc Vendor| **Specified and buildable against the delivery port.** Completion rotates the shared secret **and** the browser device credential and creates no session. `OQ-048` carries the SMS and the transactional email providers, neither selected; the port and its capture adapter are specified, so the choice blocks production and not the build|
| Melarc Rider| **No self-service path by design.** The Ops-side path is settled by `MSC-DEC-235` — revoke on report, re-register in person|

## 17. Related

- **Siblings:** [staff-authentication](staff-authentication.md) · [rider-authentication](rider-authentication.md) · [vendor-authentication](vendor-authentication.md) · [permission-enforcement](permission-enforcement.md)
- **Architecture:** [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md)
- **Contracts:** [domain-model.md](../../contracts/domain-model.md) §6.8 · [audit.md](../../contracts/audit.md) §5.4
