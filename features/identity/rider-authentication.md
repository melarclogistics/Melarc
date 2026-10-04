# Rider authentication

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.26 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** how riders authenticate, and the one-device binding that makes a rider's session a custody fact
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §11.2, §37.2, §37.3, §30.4, §30.6, and cross-cutting §35, §37.1, §38, §40.5, §42
> **Slice:** `SLICE-000`

## 1. What this is, and why

Riders sign in with a **registered phone number and a private PIN, on one registered device** (§11.2, §37.2).

The device binding is the part that matters. A rider's session is not merely an access grant — **it is attached to the handset that will photograph evidence, record collected counts and submit the hub handover.** Every custody record a rider produces is traceable to a specific device, and that is only true because the binding is one-to-one.

**Version 1 boundary.** Authentication only. Rider *work* — runs, stops, collection — belongs to the pickup features. Rider *administration* — onboarding, suspension, offboarding — belongs to §30 features not yet written.

## 2. Governing sections

| Section| What it governs here|
|---|---|
| §11.2| Phone plus private PIN on one registered device|
| §37.2| The same, as security policy, plus recovery through Ops verification|
| §37.3| Riders access **only assigned work** and permitted personal or vehicle information|
| §30.4| Rider lifecycle — identity capture, assigned device and phone|
| §30.6| `ACTIVE` / `INACTIVE` / `TEMPORARILY_UNAVAILABLE`, manually set|
| §40.5| Supported Android versions, device registration, local security|
| §37.1| Deny by default|


## 3. Surfaces and actors

| Surface| Actor| Can do| Gated by|
|---|---|---|---|
| Melarc Rider| Rider| Sign in with phone, PIN and registered device| —|
| Melarc Ops| Senior Ops| **Verify a rider's identity and re-register a device** (§37.2)| `staff.device.reregister`, own hub|
| Melarc Ops| Ops Staff, Senior Ops, Platform Admin| **Revoke** a lost or stolen device; read the rider roster| `staff.device.revoke`, `dispatch.read`, own hub|
| Melarc Ops| Ops Staff| **Cannot** re-register. Rider recovery is Senior Ops| —|
| Melarc Vendor| —| **N/A**| —|

## 4. Preconditions

- The `RiderIdentity` exists and is **`ACTIVE`** (§30.6). `INACTIVE` blocks dispatch and action.
- The phone number is registered, normalised E.164, and **does not collide with an ad-hoc sender identity** (§30).
- A device is registered to this rider.
- **The handset runs a Melarc-signed APK installed manually from the internal channel**. The feature never reads, requires or trusts where an APK was installed from.

## 4.1 Device possession is proved, not asserted

**There is no device identifier**. `RegisteredDevice.id` identifies a registration record on the server; for a rider the **registered public key is the device binding**, and sign-in proves possession of its private key. **The client neither submits nor selects a device**: a rider has at most one `ACTIVE` production device, so the server resolves it. *Historical:* a `device_identifier` string was once half of the rider's two-factor credential, and it was removed because anyone who learned it could present it and it proved no possession.

**The binding is a non-exportable keypair** generated in Android secure hardware. Only the **public key** is registered server-side; the private key never leaves the handset and cannot be exported, copied to a replacement, or extracted from a stolen device's storage.

**Sign-in is challenge-response:**

1. `requestRiderSignInChallenge` — the server issues a short-lived, **single-use** nonce.
2. The handset signs the nonce with the registered private key.
3. `riderSignIn` submits phone, **the six-digit numeric private PIN**, the challenge, the **signature** and the app's `client_root_signal`.
4. All factors verify, or no session is issued.

**The challenge endpoint is not an enumeration oracle.** A challenge is issued identically whether or not the number belongs to a registered rider, and the response carries no name, hub, or device state. §37.7's non-disclosure posture is preserved: an attacker learns nothing by asking.

**The PIN is six digits, numeric** — a fixed constant, not a runtime setting, set at First Device Enrolment and entered at Sign-in. **Why the PIN alone was never enough, stated plainly.** A six-digit PIN is low entropy, and Argon2id raises the cost per guess without reducing the number of guesses. **The rider control is four things together** — PIN, registered cryptographic device, online attempt limits, and a server-side pepper the database does not contain.

## 4.2 First registration exists now

The contract defined **re-registration and no first registration**, so a rider could become authentication-capable only by an administrator writing rows.

1. Senior Ops initiates in person — `registerRiderDevice`, `staff.device.register`, own hub. The grant, and the **single-use attestation challenge** that lives and dies with it, reach the handset in the QR. **In person, Senior Ops also verifies the operating rule: this handset is the rider's own and is not shared with another rider** (`MSC-DEC-429`, section 4.4).
2. The handset generates a **hardware-backed signing key** in the Android Keystore with that challenge, and submits the **public half** and its **Key Attestation chain** (`key_attestation`).
3. **The server verifies the attestation before it registers anything** — [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §15.2.1. A handset that cannot hold a hardware-backed key is refused with `DEVICE_SECURITY_UNSUPPORTED`, and evidence that fails policy with `DEVICE_INTEGRITY_FAILED`; **either way nothing is created.**
4. **The rider establishes their own PIN**, privately, on their own device.
5. The device is registered `ACTIVE`, the grant is consumed and the PIN is set, together; the rider is authentication-ready.

**The registering officer never learns the PIN.** That is what makes it a second factor rather than a shared secret between rider and hub.

## 4.3 Private distribution, and what the device proves

**The Rider app is built, signed and distributed privately and installed manually**; Google Play is not part of Version 1. **Nothing in this feature depends on Google Play installation, Play licensing or a Play recognition verdict**, and a request carries no field that would.

**The device is trusted because of what happened at enrolment, and sign-in proves it is still the same device**.

- **At enrolment and replacement** the server verifies the handset's **Android Key Attestation** before it registers anything: a hardware-backed, non-exportable signing key at `TrustedEnvironment` or `StrongBox` (StrongBox is not required); the Melarc Rider package and an approved signing-certificate digest; an acceptable lock and boot state; the single-use challenge issued with the grant; and the attested key being exactly the key registered. The policy is [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §15.2.1.
- **At sign-in nothing is attested again.** The server decides on the rider's authentication material, the current device record and its status, the registered public key, a signature over a fresh single-use challenge, and the fact that the registration was accepted through attestation. **No third-party service is called**, so a sign-in never waits on one.
- **`client_root_signal` is recorded and never decides.** The app sends `NOT_DETECTED`, `DETECTED` or `UNKNOWN`; `DETECTED` is recorded as a risk signal and does not by itself block sign-in, `NOT_DETECTED` is not evidence of trust, and `UNKNOWN` is valid. It cannot permit or deny authentication.
- **Nothing after sign-in asks anyone about the device**, so no outage can strand a rider who is carrying parcels, and no live session is invalidated because attestation infrastructure is unreachable.

**Replacement.** Senior Ops performs it in person and the new handset undergoes **the same attestation as a first enrolment**. **Nothing about the old device changes until the new enrolment succeeds**: a refused replacement leaves it exactly as it was. On success an `ACTIVE` old device becomes **`REPLACED`** and its live session ends `DEVICE_REPLACED`; a device already `REVOKED` stays `REVOKED`. **Neither state returns to `ACTIVE` — a new device is a new enrolment**.

**Version 1 admits one `ACTIVE` device per rider, no self-enrolment and no override**: a failed attestation is not bypassed by Ops, by staff or by any workflow, and an unsupported handset is not permitted anyway.

## 4.4 One rider, one active device, one handset — a rule and its limit

**The rule**. A rider has **at most one `ACTIVE` production device at a time**, and a rider who changes handset uses the controlled replacement workflow. **A physical production handset is intended for one rider at a time, and deliberately sharing a handset between riders is not permitted operationally.** Senior Ops verifies this **in person, during the enrolment or replacement ceremony** this feature already requires.

**What the system enforces** is the **rider-to-registered-key binding**: one `ACTIVE` device for a rider, held structurally and not only by convention (`SECURITY_DESIGN.md` §15.2.1), so that `registerRiderDevice` refuses a second one (`AC-SLICE-000-76`) and a stale grant or a race can never produce two; a registered key that signs every sign-in; and a device status that can be revoked or replaced.

**What it does not enforce, and that is accepted rather than a defect.** Two separate enrolments on the same physical Android handset **cannot be reliably identified as the same handset** under Version 1: each generates its own key, and attestation proves what a key is and not which handset holds it. Version 1 **does not derive, store or enforce a physical-handset identifier** — an IMEI, a serial number, an Android ID, an advertising ID, a device fingerprint or ID attestation — to police sharing, and **adds no MDM or Managed Google Play for it**. **It is an operating rule checked by a person, and no implementation may quietly turn it into a technical control.**

**Failed enrolment attempts stay controlled.** `completeRiderDeviceEnrolment` remains rate-limited like every rider credential operation, and every refusal on attestation grounds is audited as `auth.device.attestation_failed`, so repeated attempts show up as a rate.

## 5. Behaviour

### 5.1 Normal path

0. **The handset already holds a registered keypair.** Enrolment happened in person: Senior Ops called `registerRiderDevice`, the Ops Portal displayed a **QR code**, and the rider scanned it with this handset, which generated the keypair and took the PIN privately. **That QR is the transport, and until 27 August it did not exist** — the initiation response returned an expiry and no credential while completion required one, so no rider could reach this step at all.
1. **The handset requests a challenge** — `requestRiderSignInChallenge` returns a short-lived single-use nonce. It lives for `authentication_challenge_ttl_minutes` (**5**, `MSC-DEC-268`), and a **failed** signature consumes it just as a successful one does.
2. **Rider submits phone, PIN, the challenge, the signature and `client_root_signal`.** All five, always. **The rider types two of them; the handset produces the other three.**
3. **The server decides the factors in a fixed order** (§5.5): the challenge, then the signature against the registered public key, then the PIN. It checks that the challenge is fresh and unused and the device `ACTIVE`, and **records `client_root_signal` without judging it**.
4. **Any existing live session for this rider is terminated with `REPLACED_BY_NEW_SESSION`**. The displaced handset receives a plain **`401 SESSION_INVALID`** on its next call. **It is never told `SESSION_SUPERSEDED`** — that code exists so a vendor colleague can tell displacement from expiry on a shared credential, and a rider replacing their own session on their own registered handset has nobody to distinguish from. R1.1 reported this gap rather than inventing a value; `MSC-DEC-271` supplies it.
5. **A session is issued**, bound to the device, carrying the rider's primary hub and any effective temporary assignment (§34.9). The response is `RiderSessionIssued` and carries the opaque `access_token` **exactly once** — the only place in the contract a raw session credential is returned in a body (`MSC-DEC-261`, R1). The handset stores it only in local storage encrypted by a non-exportable **Android Keystore** key ([SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §15.2) and nowhere else.
6. **No second factor.** §11.2 gives riders phone, PIN and device — MFA is a staff-role rule. **The device half is now proved rather than asserted**, which is a change of mechanism, not of factor count.

### 5.2 Why the device is part of the credential, not a convenience

A rider's handset produces **evidence**: collection photographs, recorded counts, the hub-handover declaration. If a rider could sign in anywhere, a collection record would say only *who* claimed it — not *from what*. The one-device rule makes every custody record attributable to a physical object Melarc issued or registered.

It also bounds a stolen PIN. A PIN alone is useless without the handset, which is why the specification pairs them rather than treating the device as a nicety.

### 5.3 Exception paths

| Path| Behaviour| Error code|
|---|---|---|
| Wrong PIN, with a signature that verifies| Refused. **Counts toward the lockout** (§5.5)| `INVALID_CREDENTIALS`|
| A request that carries a valid signature while the PIN is locked *(the fifth consecutive wrong PIN is itself `INVALID_CREDENTIALS`)*| The PIN is locked for `signin_lockout_minutes`. The caller holds the registered handset, so is told; the request is not verified, counted or extended| `CREDENTIAL_LOCKED`|
| Signature that does not verify against the sole `ACTIVE` device's key — a wrong key, another rider's handset, a replaced handset| Refused. **The PIN is never looked at and nothing is counted**, so nobody who does not hold the handset can guess the PIN or lock the rider out. Never reported as an expired or consumed challenge| `DEVICE_PROOF_INVALID`|
| Unknown phone, or a rider with no `ACTIVE` device, and a wrong or absent PIN| No proof can be checked, so the PIN is decided instead: wrong is the **same answer as for a wrong signature**, nothing is counted| `DEVICE_PROOF_INVALID`|
| A rider whose device was revoked and not replaced, and the **correct PIN**| The one answer that tells a caller about the device — and only a caller who has proved the PIN. **It is what sends the app to its Device-blocked screen**| `DEVICE_NOT_ENROLLED`|
| Rider `INACTIVE`, `TEMPORARILY_UNAVAILABLE` or `SUSPENDED`, with a valid signature| Refused. **Indistinguishable from a wrong PIN** at the surface, a locked PIN included; **nothing is counted**| `INVALID_CREDENTIALS`|
| Rider signs in again| Earlier session terminated **`REPLACED_BY_NEW_SESSION`**; the displaced handset sees an ordinary invalid session, **not** a displacement message| `SESSION_INVALID`|
| Challenge past its lifetime| Refused; **the rider starts again**| `CHALLENGE_EXPIRED`|
| Challenge already used, **including a replay of a request that succeeded**| Refused; **this challenge is finished** and a fresh one is required| `CHALLENGE_UNUSABLE`|
| `client_root_signal` is `DETECTED`| **Sign-in proceeds.** The signal is recorded as a risk signal for Ops follow-up and refuses nothing| —|
| PIN that is not exactly six decimal digits| Refused by the schema, at enrolment and at sign-in| `VALIDATION_FAILED`|
| Rate limit exceeded| **Tight ceiling** — rider traffic is a bounded run of stops, so a low limit costs nothing legitimate. Refused first, never verified, never counted| `RATE_LIMITED`|
| Phone collides with an ad-hoc sender| **Registration is refused**, not sign-in. The invariant is enforced when the identity is created (§30)| `VALIDATION_FAILED`|
| A rider's device is revoked, or the session is revoked, mid-session| **The `Session` record changes state in the same transaction as the act that caused it.** The next API call is refused. There is no cache, no blocklist and no interval in which the old token works. `revokeRiderDevice` and `revokeSession` do this in `SLICE-000`; the rider's own status change to `INACTIVE` or `SUSPENDED` belongs to rider administration (`SLICE-009`), which calls the same termination ([SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §15.3)| `SESSION_INVALID`|

### 5.4 What this feature must never do

- **Never issue a session to an unregistered device**, however valid the phone and PIN. The device is part of the credential.
- **Never let a rider self-re-register.** §37.2 routes rider recovery through **Ops identity verification**, and self-service would make the one-device rule voluntary.
- **Never override a failed attestation** — not Ops, not staff, not a workflow. A handset that cannot be attested is not enrolled.
- **Never put an attestation or any third-party call on the sign-in path**, or on any operation after it. The one external dependency, trust data, touches enrolment and replacement only.
- **Never derive, store or enforce a physical-handset identifier** — IMEI, serial number, Android ID, advertising ID, a device fingerprint or ID attestation — to police one rider per handset. Version 1 does not.
- **Never allow two live rider sessions.** A rider working two handsets breaks the custody attribution the binding exists to provide.
- **Never expose another rider's work.** §37.3: assigned work only. A stop list that returns a colleague's stops is an access-boundary failure, not a filtering bug.
- **Never log or return the PIN**, and never display it to Ops during recovery. Recovery re-registers a device; it does not reveal a credential.
- **Never treat `TEMPORARILY_UNAVAILABLE` as a sign-in problem to explain.** §30.6 makes it a manually set operational state; the rider knows why, and the surface must not leak roster information at the sign-in screen.
- **Never leave an `INACTIVE` or `SUSPENDED` rider's active token valid.** A status change is immediate and retroactive — the session must end in the transaction that changes the status, not at its next natural expiry. The mechanism is the `Session` record itself ([SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §15.3):

### 5.5 Lockout, and the order the factors are decided in

`MSC-DEC-431`, written at [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.4b. **The PIN is the only factor that locks, and an attempt that counts can be made only by a caller who holds the registered handset** — that is the whole of the design, because a six-digit PIN has a million values and a rider who could be locked out by anyone who knows a phone number would be locked out by anyone.

1. **The challenge** — unknown or consumed is `CHALLENGE_UNUSABLE`, expired is `CHALLENGE_EXPIRED`, and every other request consumes it, pass or fail.
2. **The signature.** A rider with an `ACTIVE` device is held to a valid signature; failing it is `DEVICE_PROOF_INVALID`, **the PIN is not examined and nothing is counted**.
3. **No device to prove.** An unknown phone, or a rider with no `ACTIVE` device, offers no proof, so the PIN is decided: wrong is `DEVICE_PROOF_INVALID` (the unknown phone's answer) and right is `DEVICE_NOT_ENROLLED`. A rider who never enrolled holds no PIN, so for that rider every answer is the first. **Nothing is counted**, because the factor has not been reached, so these attempts are bounded only by the rate limit, keyed on the submitted phone number — **a rider with no `ACTIVE` device can have a PIN tried, and that is an accepted residual**: a PIN alone never authenticates a rider, and a PIN learned here dies at the next enrolment, which sets a new one.
4. **A valid signature and a status other than `ACTIVE`** is `INVALID_CREDENTIALS`: nothing is counted and no lock is announced, because the factor has not been reached.
5. **A valid signature, an `ACTIVE` status and a locked PIN** is `CREDENTIAL_LOCKED`; the PIN is not examined.
6. **Otherwise** a wrong PIN is `INVALID_CREDENTIALS` and counts. A correct PIN resets the count and issues the session.

**The count and the lock** sit on the PIN record, are never returned and are not part of the rider's version. **A lock ends no live session**; the count also resets when a PIN is set at enrolment or replacement. **The Rider app's Device-blocked screen is shown on `DEVICE_NOT_ENROLLED` and on nothing else** — every other device refusal is the one uniform sign-in failure, which the screen must not distinguish.

## 6. Entities — *pointer*

| Entity| Where|
|---|---|
| `RiderIdentity`, `RegisteredDevice`, `Session`| [domain-model.md](../../contracts/domain-model.md) §6.8|

## 7. States — *pointer*

[state-machines.md](../../contracts/state-machines.md) **§13 `Session`** — `ACTIVE` → `TERMINATED`, two states. **Approved 21 August** by `MSC-DEC-227`, amended by `MSC-DEC-228`.

`RiderIdentity.status` transitions belong to §30 administration features, unwritten.

## 8. Permissions — *pointer*

[permissions.md](../../contracts/permissions.md) §7. Riders hold `pickup.read` and `delivery.read` at **assigned** scope, plus `pickup.run.execute`, `pickup.collection.confirm` and `pickup.failure.report`.

**`staff.device.reregister` and `staff.device.revoke` both exist**, and Gate A adds **`staff.device.register`** for the *initial* binding — deliberately a separate key, because widening re-registration would leave the catalogue unable to say which act was authorised.

## 9. Settings — *pointer*

[settings.md](../../contracts/settings.md) §7.5 — `signin_max_attempts` **5**, `signin_lockout_minutes` **15**, `session_lifetime_minutes` **1440** for the rider tier. **The lockout counts wrong PINs after a valid signature and nothing else** (§5.5, `MSC-DEC-431`).

**The rider tier has no `session_idle_timeout_minutes`, and that is a rule rather than a missing value**. A rider taps nothing while riding between stops and **cannot sign in again without signal**. An idle logout would strand one at a customer's door, unable to complete the §19.6 OTP and **interrupting an active doorstep verification and handover workflow**. That is a **Melarc-originated operational failure**, and `MSC-DEC-309` is explicit that such a failure **must not be charged to the customer** — it may not be recorded as a consumed physical delivery attempt.

## 10. Errors — *pointer*

[errors-and-enums.md](../../contracts/errors-and-enums.md) — `INVALID_CREDENTIALS`, `CREDENTIAL_LOCKED`, `DEVICE_NOT_ENROLLED`, `DEVICE_PROOF_INVALID`, `DEVICE_INTEGRITY_FAILED`, `DEVICE_SECURITY_UNSUPPORTED`, `CHALLENGE_EXPIRED`, `CHALLENGE_UNUSABLE`, `SETUP_GRANT_INVALID`, `SESSION_INVALID`, `RATE_LIMITED`, `PERMISSION_DENIED`, `INSUFFICIENT_AUTHORITY`, `HUB_SCOPE_VIOLATION`, `NOT_FOUND`, `REASON_REQUIRED`, `VALIDATION_FAILED` and `STATE_CONFLICT`. **`DEVICE_SECURITY_UNSUPPORTED` and `DEVICE_INTEGRITY_FAILED` are returned at enrolment and replacement only, never at sign-in**. **`SESSION_SUPERSEDED` is the vendor displacement code and is never shown to a rider; `ATTEMPTS_EXHAUSTED` is a doorstep-handshake code; `OWNERSHIP_VIOLATION` was withdrawn** at Gate PD-3R1 — a Rider is told a record is not found and never that it belongs to someone else.

## 11. Audit events — *pointer*

[audit.md](../../contracts/audit.md) §5.4 — `auth.session.issued`, `auth.session.failed`, `auth.session.terminated`; `auth.device.registered`, `auth.device.revoked` and `auth.device.replaced`, all **enhanced**, and `auth.device.attestation_failed` for a refused enrolment or replacement. A rider's `auth.session.issued` records `client_root_signal`. **A refused sign-in is `auth.session.failed` with the factor reached and one cause from the catalogue's closed set** (`WRONG_PIN`, `DEVICE_PROOF_INVALID`, `NO_ACTIVE_DEVICE`, `LOCKED_OUT`, `CHALLENGE_EXPIRED`, `CHALLENGE_UNUSABLE`, `UNKNOWN_PRINCIPAL` or `INELIGIBLE_PRINCIPAL`), **and a lock is one `auth.lockout.applied`**; neither records a PIN or a signature.

**`auth.session.superseded` is not emitted for riders**. It is the vendor colleague-displacement code — its purpose is to let a vendor account tell displacement from expiry on a shared credential. A rider replacing their own session on their own registered handset has no colleague to distinguish from. Rider session replacement emits `auth.session.terminated` with reason `REPLACED_BY_NEW_SESSION`.

**Every identifier is spelled in full.** The suffix form — `` `.dispatched` `` after `` `pickup.manifest.created` `` — is not a resolvable identifier: no check can verify it, and it still reads correctly after the code it points at is renamed.

**Device registration is enhanced for a reason worth stating:** it is the moment a rider's identity becomes usable on a specific handset, and therefore the moment custody attribution starts pointing somewhere new.

## 12. API operations — *pointer*

`requestRiderSignInChallenge`, `riderSignIn`, `getCurrentSession`, `signOut`, `revokeSession` and `listSessions` — [openapi.yaml](../../contracts/openapi.yaml).

**The rider roster (Gate PD-3R1, `PDA-47`; confirmed by the Product Owner, `MSC-DEC-436`):** `listRiders` and `getRider` under `dispatch.read`, on the browser surface only — identity and readiness, **never a PIN, a hash, a key or an attestation**. `getRider` is where `reregisterRiderDevice` takes its `If-Match`; `revokeRiderDevice` takes none, deliberately, because revocation is unverified and low-friction.

**Device lifecycle:** `registerRiderDevice` and `completeRiderDeviceEnrolment` (first binding), `reregisterRiderDevice` (replacement handset; takes a `RiderDeviceReregistration` — a `reason_code` and a mandatory `verification_note`), `revokeRiderDevice` (loss or theft; takes a `DeviceRevocation` — a mandatory `reason`).

**Both registration operations return a scannable enrolment URI**, served `Cache-Control: no-store` and never logged or audited by value. The rider's handset consumes it at `completeRiderDeviceEnrolment`. **Senior Ops sees a QR code and never learns the PIN, the private key or the session credential.** **The URI also carries the single-use attestation challenge** the handset binds into its key, which lives and dies with the grant.

**Revocation terminates the live session with `DEVICE_REVOKED`** — one reason, not two. The operation's own description previously ended by naming `SESSION_SUPERSEDED`, contradicting its preceding paragraph, and pointed at `performOpsRecovery`, which no longer exists.

**`reregisterRiderDevice` completes through `completeRiderDeviceEnrolment`** — the same operation as first registration. **One registration protocol, not two**: the replacement handset generates its own non-exportable keypair and submits only the public half, because a private key cannot be copied between devices and must not appear to be. **It also leaves the old device `REPLACED`** — not `REVOKED` — when it succeeds, and changes nothing when it is refused.

## 13. Acceptance criteria

### `AC-SLICE-000-08` — Phone, PIN and registered device are all required

```text
Given an active rider with a registered device,
When the rider submits the correct phone and PIN with a valid signature over a live challenge,
Then a session is issued bound to the device,
And the response carries the opaque access_token exactly once,
And the session carries the rider's primary hub and any effective temporary assignment,
And no device identifier is submitted: the server resolves the rider's sole ACTIVE device and verifies the signature against its public key.
```

**Governs:** §11.2, §37.2 · **Surface:** Melarc Rider · **Test level:** API

### `AC-SLICE-000-09` — A caller who has not proved the PIN learns nothing about a rider's device

```text
Given an unknown phone, a rider who never enrolled a device and a rider whose only device was revoked,
When a sign-in carrying a signature that verifies against no registered key is submitted for each with a PIN that is wrong or that no record could match,
Then all three are refused with DEVICE_PROOF_INVALID,
And no response, status or timing class says which of the three it was,
And none counts toward a lock,
And no partial or limited session is created as a fallback.
```

**Governs:** §11.2, §37.2, `MSC-DEC-431` · **Surface:** Melarc Rider · **Test level:** API · **Code:** `DEVICE_PROOF_INVALID`

### `AC-SLICE-000-10` — One live session per rider

```text
Given a rider with a live session,
When the same rider signs in after a device re-registration,
Then the earlier session is terminated,
And the displaced handset receives 401 SESSION_INVALID on its next call,
And it is never told SESSION_SUPERSEDED, which is the vendor displacement code,
And two live rider sessions never coexist.
```

**Governs:** §37.2, `MSC-DEC-271` · **Surface:** Melarc Rider · **Test level:** integration · **Code:** `SESSION_INVALID`, termination reason `REPLACED_BY_NEW_SESSION` — *(was `SESSION_SUPERSEDED`)*

### `AC-SLICE-000-11` — Inactive riders cannot sign in, and cannot tell why

```text
Given a rider whose status is INACTIVE, TEMPORARILY_UNAVAILABLE or SUSPENDED,
When correct credentials are submitted from the registered device,
Then the response is INVALID_CREDENTIALS,
And it is indistinguishable in content and timing from a wrong PIN,
And no roster or availability information is disclosed at the sign-in surface.
```

**Governs:** §30.6, §37.7 · **Surface:** Melarc Rider · **Test level:** API · **Code:** `INVALID_CREDENTIALS`

### `AC-SLICE-000-46` — A revoked rider session is invalid on the very next request

```text
Given a rider with a live session and a valid access_token,
When Ops Staff or Senior Ops at the rider's hub calls revokeRiderDevice, or Senior Ops ends the session with revokeSession,
Then the device is REVOKED, or the session is terminated with ADMIN_REVOKED, in the same transaction as the call,
And the rider's next API call returns 401 SESSION_INVALID, with no interval in which the old token still works,
And no cache or blocklist is consulted: the session record itself carries the decision,
And a revocation made with no reason is refused with VALIDATION_FAILED and changes nothing,
And no later sign-in succeeds from the revoked handset.
```

**Governs:** §37.2, `MSC-DEC-235`, [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §15.3 · **Surface:** Melarc Rider · **Test level:** integration · **Code:** `SESSION_INVALID`

### `AC-SLICE-000-13` — Re-registration is never self-service

```text
Given a rider who has lost their registered device,
When the rider attempts to register a replacement from the app,
Then no path exists to do so,
And re-registration succeeds only when performed by Senior Ops after identity verification,
And an enhanced audit event records the authorising actor.
```

**Governs:** §37.2, §30.4 · **Surface:** Melarc Ops · **Test level:** API

### `AC-SLICE-000-38` — A rider's phone and PIN without the registered key do not authenticate

```text
Given an attacker who knows a rider's phone and PIN,
And who does not possess the registered handset,
When they request a sign-in challenge and attempt to sign in,
Then no valid signature over the challenge can be produced,
And the attempt is refused with DEVICE_PROOF_INVALID,
And no Session is issued.
```

**Governs:** `MSC-DEC-264` · **Surface:** Melarc Rider · **Test level:** integration

### `AC-SLICE-000-39` — The challenge endpoint does not enumerate riders

```text
Given a phone number belonging to no rider,
And a phone number belonging to an active rider with a registered device,
When a sign-in challenge is requested for each,
Then both responses are indistinguishable in shape, status and timing class,
And neither reveals account existence, hub or device state.
```

**Governs:** §37.7, `MSC-DEC-264` · **Surface:** Melarc Rider · **Test level:** integration

### `AC-SLICE-000-40` — First registration never exposes the PIN to the officer

```text
Given a Senior Ops user performing in-person first device registration,
When the enrolment grant is issued,
Then the response contains no PIN field, and the grant appears only inside the no-store enrolment URI that the officer's screen turns into a QR code,
And the rider establishes the PIN on their own handset,
And the request schema for enrolment accepts no private key.
```

**Governs:** `MSC-DEC-264` · **Surface:** Melarc Rider · **Test level:** contract

### `AC-SLICE-000-47` — Sign-in does not depend on how the APK was installed

```text
Given an active rider with a registered device,
And a Melarc-signed APK installed manually from the internal channel,
When the rider signs in with the correct phone and PIN and a valid signature over a live challenge,
Then a session is issued exactly as it would be for any other installation route,
And no request field, header or server check refers to Google Play, an installer package or a Play licence verdict,
And the same holds at first enrolment and at replacement.
```

**Governs:** `MSC-DEC-426`, §11.2 · **Surface:** Melarc Rider · **Test level:** integration

### `AC-SLICE-000-48` — A revoked device cannot sign in

```text
Given a rider whose registered device was revoked by revokeRiderDevice and who has not been re-registered,
When the rider submits the correct phone and PIN with a signature from that handset,
Then it is refused with DEVICE_NOT_ENROLLED,
And no session is issued,
And no limited or fallback session is created.
```

**Governs:** `MSC-DEC-235`, `MSC-DEC-264` · **Surface:** Melarc Rider · **Test level:** integration · **Code:** `DEVICE_NOT_ENROLLED`

### `AC-SLICE-000-49` — A replaced handset can no longer sign in

```text
Given a rider whose device was replaced through reregisterRiderDevice and completed on a new handset,
When the rider submits the correct phone and current PIN with a signature from the old handset,
Then it is refused with DEVICE_PROOF_INVALID,
And the old device record is retained, never deleted, and reads `REPLACED`,
And no session is issued.
```

**Governs:** `MSC-DEC-235`, `MSC-DEC-264`, `MSC-DEC-428` · **Surface:** Melarc Rider · **Test level:** integration · **Code:** `DEVICE_PROOF_INVALID`

### `AC-SLICE-000-50` — A rider's credentials from another rider's device are refused

```text
Given two active riders, each with a registered device,
When the first rider's phone and PIN are submitted with a valid signature from the second rider's handset,
Then it is refused with DEVICE_PROOF_INVALID,
And no session is issued to either rider.
```

**Governs:** `MSC-DEC-264` · **Surface:** Melarc Rider · **Test level:** integration · **Code:** `DEVICE_PROOF_INVALID`

### `AC-SLICE-000-51` — A sign-in with no device proof is refused

```text
Given an active rider with a registered device,
When riderSignIn is called with the correct phone and PIN and no device_signature,
Then the request is refused by the request schema with VALIDATION_FAILED,
And no session is issued,
And a PIN alone never authenticates a rider.
```

**Governs:** `MSC-DEC-264`, §11.2 · **Surface:** Melarc Rider · **Test level:** contract · **Code:** `VALIDATION_FAILED`

### `AC-SLICE-000-52` — A replayed challenge is refused

```text
Given a sign-in challenge that has already been used in an attempt, successful or not,
When the same challenge is submitted again with a valid signature,
Then it is refused with CHALLENGE_UNUSABLE,
And a replay of a request that already succeeded is refused the same way,
And no session is issued,
And the rider must request a fresh challenge.
```

**Governs:** `MSC-DEC-268`, `MSC-DEC-264`, `MSC-DEC-428` · **Surface:** Melarc Rider · **Test level:** integration · **Code:** `CHALLENGE_UNUSABLE`

### `AC-SLICE-000-53` — An expired challenge is refused

```text
Given a sign-in challenge older than authentication_challenge_ttl_minutes,
When it is submitted with a valid signature,
Then it is refused with CHALLENGE_EXPIRED,
And no session is issued,
And the rider is told to start again.
```

**Governs:** `MSC-DEC-268`, `MSC-DEC-428` · **Surface:** Melarc Rider · **Test level:** integration · **Code:** `CHALLENGE_EXPIRED`

### `AC-SLICE-000-54` — A signed-in rider is never stranded by an attestation outage

```text
Given a rider with a live session and parcels in custody,
And the attestation trust data is unavailable,
When the rider records a collection, uploads evidence, takes a payment or submits a hub handover,
Then each action proceeds under the existing session and offline rules,
And no attestation is requested for it,
And the live session is not invalidated,
And the outage is never reported to the rider as a device-integrity failure.
```

**Governs:** `MSC-DEC-387`, `MSC-DEC-427` · **Surface:** Melarc Rider · **Test level:** integration

### `AC-SLICE-000-55` — No test substitute, for attestation or for message delivery, can run in production

```text
Given a non-production environment configured with the substitute attestation verifier,
When that configuration is presented to production startup,
Then the application refuses to start,
And the same refusal applies when the accepted attestation roots, the Rider package name or the approved signing-certificate digest set is missing, or the trust-data maximum age is unset or not greater than six hours,
And the same refusal applies when the credential-message delivery port's capture adapter is selected, or no production delivery adapter is configured,
And no production enrolment path accepts a substitute's outcome or skips verification.
```

**Governs:** `MSC-DEC-427`, [DEPLOYMENT_AND_ENVIRONMENTS.md](../../architecture/DEPLOYMENT_AND_ENVIRONMENTS.md) §12.3, [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.9a · **Surface:** backend · **Test level:** integration

### `AC-SLICE-000-56` — A root signal of DETECTED is recorded and blocks nothing

```text
Given an active rider with a registered device,
When the rider signs in correctly with client_root_signal DETECTED,
Then a session is issued,
And the signal is recorded on the session and in auth.session.issued,
And sign-in is not blocked, delayed or reworded by it.
```

**Governs:** `MSC-DEC-387`, `MSC-DEC-427` · **Surface:** Melarc Rider · **Test level:** integration

### `AC-SLICE-000-57` — A root signal of NOT_DETECTED relaxes nothing

```text
Given an active rider with a registered device,
When a signature that does not verify is submitted with client_root_signal NOT_DETECTED,
Then it is refused with DEVICE_PROOF_INVALID,
And no session is issued,
And no check is skipped or relaxed because the signal reads NOT_DETECTED.
```

**Governs:** `MSC-DEC-427` · **Surface:** Melarc Rider · **Test level:** integration · **Code:** `DEVICE_PROOF_INVALID`

### `AC-SLICE-000-58` — A root signal of UNKNOWN is valid and is recorded as UNKNOWN

```text
Given an active rider with a registered device,
When the rider signs in correctly with client_root_signal UNKNOWN,
Then a session is issued,
And the signal is recorded as UNKNOWN and never converted to NOT_DETECTED,
And sign-in is not blocked by it.
```

**Governs:** `MSC-DEC-427` · **Surface:** Melarc Rider · **Test level:** integration

### `AC-SLICE-000-59` — A sign-in with no root signal is refused

```text
Given an active rider with a registered device,
When riderSignIn is called with the correct phone, PIN and signature and no client_root_signal,
Then the request is refused by the request schema with VALIDATION_FAILED,
And no session is issued.
```

**Governs:** `MSC-DEC-427` · **Surface:** Melarc Rider · **Test level:** contract · **Code:** `VALIDATION_FAILED`

### `AC-SLICE-000-60` — A hardware-attested key is enrolled

```text
Given an enrolment grant issued by Senior Ops for an authorised rider,
And a handset running the Melarc-signed Rider APK,
When the handset submits the PIN, a public key and an attestation chain for a hardware-backed key at TrustedEnvironment or StrongBox,
And the chain carries the challenge issued with the grant, the Melarc Rider package, an approved signing-certificate digest, a locked device in Verified boot state, and a key equal to the public key submitted,
Then the device is registered ACTIVE,
And the grant is consumed and the PIN set,
And auth.device.registered records the attestation summary and never the chain,
And no session is issued,
And StrongBox is accepted but not required.
```

**Governs:** `MSC-DEC-427`, [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §15.2.1 · **Surface:** Melarc Rider · **Test level:** integration

### `AC-SLICE-000-61` — A handset that cannot hold a hardware-backed key is refused

```text
Given a valid enrolment grant,
When the handset submits an attestation showing a key below TrustedEnvironment security,
Then it is refused with DEVICE_SECURITY_UNSUPPORTED,
And no device record is created,
And the grant is not consumed and no PIN is set,
And auth.device.attestation_failed records the outcome.
```

**Governs:** `MSC-DEC-427` · **Surface:** Melarc Rider · **Test level:** integration · **Code:** `DEVICE_SECURITY_UNSUPPORTED`

### `AC-SLICE-000-62` — Evidence for the wrong application is refused

```text
Given a valid enrolment grant,
When the attestation names another package, or a signing-certificate digest outside the approved set,
Then it is refused with DEVICE_INTEGRITY_FAILED,
And no device record is created,
And the grant is not consumed,
And auth.device.attestation_failed records the outcome and its cause class.
```

**Governs:** `MSC-DEC-427` · **Surface:** Melarc Rider · **Test level:** integration · **Code:** `DEVICE_INTEGRITY_FAILED`

### `AC-SLICE-000-63` — An untrusted attestation chain is refused

```text
Given a valid enrolment grant,
When the chain is invalid, does not end at an accepted Android attestation root, or contains a revoked certificate,
Then it is refused with DEVICE_INTEGRITY_FAILED,
And no device record is created,
And the grant is not consumed,
And auth.device.attestation_failed records the outcome and its cause class.
```

**Governs:** `MSC-DEC-427` · **Surface:** Melarc Rider · **Test level:** integration · **Code:** `DEVICE_INTEGRITY_FAILED`

### `AC-SLICE-000-64` — Evidence for a different challenge is refused

```text
Given a valid enrolment grant,
When the attestation carries a challenge other than the one issued with that grant, including evidence produced for another enrolment,
Then it is refused with DEVICE_INTEGRITY_FAILED,
And no device record is created,
And the grant is not consumed,
And auth.device.attestation_failed records the outcome and its cause class.
```

**Governs:** `MSC-DEC-427` · **Surface:** Melarc Rider · **Test level:** integration · **Code:** `DEVICE_INTEGRITY_FAILED`

### `AC-SLICE-000-65` — An unlocked or unverified device is refused

```text
Given a valid enrolment grant,
When the attestation reports an unlocked bootloader, or a verified boot state other than Verified,
Then it is refused with DEVICE_INTEGRITY_FAILED,
And no device record is created,
And the grant is not consumed,
And auth.device.attestation_failed records the outcome and its cause class.
```

**Governs:** `MSC-DEC-427` · **Surface:** Melarc Rider · **Test level:** integration · **Code:** `DEVICE_INTEGRITY_FAILED`

### `AC-SLICE-000-66` — A key that is not the attested key is refused

```text
Given a valid enrolment grant,
When the attested public key differs from the public_key submitted for registration,
Then it is refused with DEVICE_INTEGRITY_FAILED,
And no device record is created,
And the grant is not consumed,
And auth.device.attestation_failed records the outcome and its cause class.
```

**Governs:** `MSC-DEC-427` · **Surface:** Melarc Rider · **Test level:** integration · **Code:** `DEVICE_INTEGRITY_FAILED`

### `AC-SLICE-000-67` — An expired, consumed or superseded grant is refused before any evidence is read

```text
Given an enrolment grant that has expired, been consumed or been superseded,
When the handset submits valid attestation evidence with it,
Then it is refused with SETUP_GRANT_INVALID,
And the attestation is not evaluated,
And no device record is created.
```

**Governs:** `MSC-DEC-427`, `MSC-DEC-269` · **Surface:** Melarc Rider · **Test level:** integration · **Code:** `SETUP_GRANT_INVALID`

### `AC-SLICE-000-68` — An enrolment with no attestation is refused

```text
Given a valid enrolment grant,
When completeRiderDeviceEnrolment is called without key_attestation,
Then the request is refused by the request schema with VALIDATION_FAILED,
And no device record is created,
And the grant is not consumed.
```

**Governs:** `MSC-DEC-427` · **Surface:** Melarc Rider · **Test level:** contract · **Code:** `VALIDATION_FAILED`

### `AC-SLICE-000-69` — Stale trust data fails enrolment closed and touches nothing else

```text
Given an enrolment grant and valid attestation evidence,
And revocation data older than the configured maximum age, or none loaded yet after a start, or accepted roots that cannot be loaded,
When the handset completes enrolment,
Then it fails closed with 503 TRUST_DATA_UNAVAILABLE and a Retry-After,
And the error is neither DEVICE_INTEGRITY_FAILED nor DEVICE_SECURITY_UNSUPPORTED,
And no device record is created and the grant is not consumed, so the same completion succeeds once the data is available,
And sign-in and every live session are unaffected,
And an operational alert is raised.
```

**Governs:** `MSC-DEC-427` · **Surface:** backend · **Test level:** integration · **Code:** `TRUST_DATA_UNAVAILABLE`

### `AC-SLICE-000-70` — The signing certificate can be rotated

```text
Given an approved digest set holding two signing-certificate digests,
When enrolments attested under each digest are submitted,
Then both succeed,
And when the older digest is removed from the set, a new enrolment attested under it is refused with DEVICE_INTEGRITY_FAILED,
And devices already enrolled under it keep signing in.
```

**Governs:** `MSC-DEC-427`, `MSC-DEC-418` · **Surface:** backend · **Test level:** integration · **Code:** `DEVICE_INTEGRITY_FAILED`

### `AC-SLICE-000-71` — A replacement supersedes the old device atomically

```text
Given a rider with an ACTIVE device and a RIDER_DEVICE_REREGISTRATION grant,
When the new handset completes enrolment with acceptable attestation,
Then the new device is ACTIVE and the old device is REPLACED,
And any live session on the old device ends with DEVICE_REPLACED,
And auth.device.registered and auth.device.replaced are written together and name both devices,
And the old key can no longer authenticate,
And Senior Ops supplied no identifier for the new handset, which established its own key during enrolment.
```

**Governs:** `MSC-DEC-428`, `MSC-DEC-235`, `MSC-DEC-427` · **Surface:** Melarc Rider · **Test level:** integration

### `AC-SLICE-000-72` — A failed replacement leaves the existing device untouched

```text
Given a rider with an ACTIVE device and a RIDER_DEVICE_REREGISTRATION grant,
When the new handset's attestation fails with DEVICE_SECURITY_UNSUPPORTED or DEVICE_INTEGRITY_FAILED,
Then no new device is created,
And the existing device is still ACTIVE, its key still authenticates and its live session is unaffected,
And the grant is not consumed.
```

**Governs:** `MSC-DEC-428`, `MSC-DEC-427` · **Surface:** Melarc Rider · **Test level:** integration

### `AC-SLICE-000-73` — A replayed or concurrent replacement has one winner

```text
Given one RIDER_DEVICE_REREGISTRATION grant,
When two handsets complete it concurrently, or one completes it twice,
Then exactly one succeeds,
And the other is refused with SETUP_GRANT_INVALID,
And a newer grant of the same purpose supersedes an older one, so only the latest can complete.
```

**Governs:** `MSC-DEC-428`, `MSC-DEC-269` · **Surface:** Melarc Rider · **Test level:** integration · **Code:** `SETUP_GRANT_INVALID`

### `AC-SLICE-000-74` — A revoked device stays revoked through a replacement

```text
Given a rider whose device was revoked by revokeRiderDevice,
When a replacement completes,
Then the new device is ACTIVE,
And the old device stays REVOKED and no auth.device.replaced is written,
And no REPLACED or REVOKED device ever returns to ACTIVE.
```

**Governs:** `MSC-DEC-428`, `MSC-DEC-235` · **Surface:** Melarc Rider · **Test level:** integration

### `AC-SLICE-000-75` — The substitute verifier produces each outcome deterministically

```text
Given a non-production environment using the substitute attestation verifier,
When controlled test input requests accepted, unsupported, each integrity failure cause, and trust data unavailable,
Then each produces its outcome and its error code,
And the same input produces the same outcome every time,
And no device or production trust setting is needed.
```

**Governs:** `MSC-DEC-427` · **Surface:** backend · **Test level:** integration

### `AC-SLICE-000-76` — A rider never holds two ACTIVE devices

```text
Given a rider with an ACTIVE registered device,
When Senior Ops calls registerRiderDevice for that rider,
Then it is refused with STATE_CONFLICT,
And no grant is issued and the existing device is untouched,
And a change of handset is made only through reregisterRiderDevice,
And at no moment, including during a concurrent replacement, does the rider hold two ACTIVE devices.
```

**Governs:** `MSC-DEC-429`, §11.2, §37.2 · **Surface:** Melarc Ops · **Test level:** integration · **Code:** `STATE_CONFLICT`

### `AC-SLICE-000-109` — Five wrong PINs from the registered handset lock the PIN

```text
Given an ACTIVE rider with an ACTIVE device and signin_max_attempts of 5,
When five consecutive sign-ins each carry a valid signature over a fresh challenge and a wrong PIN,
Then each is refused with INVALID_CREDENTIALS,
And the fifth sets the lock for signin_lockout_minutes,
And a sixth carrying a valid signature, the correct PIN included, is refused with CREDENTIAL_LOCKED, is not verified and does not extend the lock,
And auth.lockout.applied is recorded once and never holds a PIN,
And after the lock the correct PIN signs in and the count is zero,
And a completed enrolment or replacement sets a new PIN and clears the count,
And a rider whose status is not ACTIVE is refused with INVALID_CREDENTIALS from a valid signature whether or not the PIN is locked, and nothing is counted.
```

**Governs:** `MSC-DEC-431`, `MSC-DEC-264` · **Surface:** Melarc Rider · **Test level:** API · **Code:** `INVALID_CREDENTIALS`, `CREDENTIAL_LOCKED`

### `AC-SLICE-000-110` — A handset that cannot sign can neither guess the PIN nor lock the rider

```text
Given an ACTIVE rider with an ACTIVE device,
When any number of sign-ins arrive with a signature that does not verify against the registered key, whatever the PIN,
Then every one is refused with DEVICE_PROOF_INVALID,
And the PIN is not examined, nothing is counted and no lock is set,
And a later sign-in from the registered handset with the correct PIN succeeds,
And CREDENTIAL_LOCKED is never returned to a request that has not produced a valid signature.
```

**Governs:** `MSC-DEC-431`, `MSC-DEC-264` · **Surface:** Melarc Rider · **Test level:** API · **Code:** `DEVICE_PROOF_INVALID`

### `AC-SLICE-000-111` — A PIN that is not six digits is refused by the schema

```text
Given the rider enrolment request and the rider sign-in request,
When the PIN submitted is not exactly six decimal digits — five digits, seven digits, letters or spaces,
Then the request is refused by the schema with VALIDATION_FAILED, at enrolment and at sign-in,
And no device is registered, no grant is consumed and no session is issued.
```

**Governs:** `MSC-DEC-418` · **Surface:** Melarc Rider · **Test level:** contract · **Code:** `VALIDATION_FAILED`

### `AC-SLICE-000-112` — Revocation is bounded to the actor's hubs

```text
Given a rider at hub B and an Ops Staff user authorised for hub A only who holds staff.device.revoke,
When the user calls revokeRiderDevice for that rider, and for an identifier that matches nothing,
Then the first is refused with HUB_SCOPE_VIOLATION, the device stays ACTIVE and the session stays live,
And the second is refused with NOT_FOUND,
And a user who does not hold staff.device.revoke is refused with PERMISSION_DENIED.
```

**Governs:** `MSC-DEC-235`, `MSC-DEC-432` · **Surface:** Melarc Ops · **Test level:** API · **Code:** `HUB_SCOPE_VIOLATION`, `NOT_FOUND`, `PERMISSION_DENIED`

### `AC-SLICE-000-113` — The rider roster shows readiness and never a credential

```text
Given riders at two hubs and an Ops Staff user authorised for one,
When the user calls listRiders and getRider,
Then only that hub's riders are listed, and getRider for a rider at the other hub is refused with HUB_SCOPE_VIOLATION,
And each rider shows name, phone, status, hub, whether a PIN exists and whether an ACTIVE device exists,
And no response contains a PIN, a PIN hash, a public key or an attestation,
And the ETag changes when the status or the device set changes and not when a sign-in fails,
And a Vendor session, and a Rider session although the Rider bundle holds dispatch.read, calling either is refused with PERMISSION_DENIED.
```

**Governs:** `MSC-DEC-432`, `MSC-DEC-436`, [permissions.md](../../contracts/permissions.md) §7 · **Surface:** Melarc Ops · **Test level:** API · **Code:** `HUB_SCOPE_VIOLATION`, `PERMISSION_DENIED`

## 14. Open questions blocking this feature

| ID| What it blocks here| Type|
|---|---|---|
| ~~`OQ-113`~~| **Closed 1 October 2026, `MSC-DEC-427`** — Android Key Attestation at enrolment and replacement, proof of possession at sign-in.| ~~`ARTIFACT_REQUIRED`~~|
| ~~`OQ-027`~~| **Closed 28 September 2026, `MSC-DEC-419`** — the design of the one queued offline act, hub handover, is written at [rider-android.md](../../surfaces/rider-android.md) §4.1, including §19.8's *session expiration while queued* — see below.| ~~`ARTIFACT_REQUIRED`~~|

**Device loss is settled, and it added a permission.** `MSC-DEC-235` closed the device half of `OQ-050`: reporting a lost or stolen handset **revokes the binding immediately, before any identity verification**, and re-registration requires the rider to **attend a hub in person**. There is no remote re-binding path, and that is a decision rather than an omission — phone-based identity verification is the weakest link in this model, and it is the vector `RecoveryRequestCreate`'s no-destination guard exists to block.

**`staff.device.revoke` was added for it**, held by **Ops Staff** while `staff.device.reregister` stays Senior Ops. The asymmetry is deliberate: revocation is cheap and reversible so it must be low-friction; re-registration grants access so it stays gated. That makes **five** permissions found by naming what an actor needs rather than by reading the catalogue.

**The cost, recorded rather than glossed.** A rider who loses a handset in Kasoa is out of service until they reach a hub. That is accepted.

**The queued handover and an expiring session are answered.** Version 1's offline scope is **hub-handover queuing only** — collection submission and every other rider command are online-only. If a session expires while a hub handover sits queued, the queued command is not discarded: [rider-android.md](../../surfaces/rider-android.md) §4.1 item 7 binds it to the rider and the registered device, not to the session token, so the rider re-authenticates and the command syncs under the new session with its idempotency key unchanged (`MSC-DEC-419`, closing `OQ-027`).

## 15. What this feature still owes its slice

| Owed| Blocks which DoR area| Owner|
|---|---|---|
| ~~**Criteria for four cases that needed evidence a request can carry**~~ — **discharged by `MSC-DEC-427`, 1 October 2026**: `AC-SLICE-000-60` to `-69` cover them and `-56` to `-59` cover the root signal.| —| ~~`OQ-113`~~|
| **Suspension and deactivation must end the live session in the same transaction.** `INACTIVE` and `SUSPENDED` are set by rider administration, which `SLICE-009` builds; it owes a criterion that its status change calls the same session termination `revokeRiderDevice` does ([IMPLEMENTATION_PLAN.md](../../delivery/IMPLEMENTATION_PLAN.md) §4c). The criterion that stood here, `AC-SLICE-000-46`, tested an operation this slice does not contain and is now written on the two that it does| —| `SLICE-009`|
| ~~**The queued hub handover's session-expiry behaviour**~~ — **discharged by `MSC-DEC-419`, 28 September 2026**: [rider-android.md](../../surfaces/rider-android.md) §4.1 item 7 specifies it. Sign-in has no offline path and needs none.| —| ~~`OQ-027`~~|

**Both causes this section once named are closed.** §13 `Session` was signed by `MSC-DEC-227`; `MSC-DEC-235` settled device loss and `MSC-DEC-236` supplied the intervals.

**Readiness is not assessed here.** [definition-of-ready.md](../../standards/definition-of-ready.md) assesses it **for the complete vertical slice** and records the verdict in the slice document; a feature cannot answer §44.3 or §44.4 alone. This section feeds that assessment instead of duplicating it (`MSC-DEC-239`, closing `CONFLICT-029`).

## 16. Build status — *honest, per surface*

| Surface| Status|
|---|---|
| Melarc Rider| **Sign-in and recovery both specified.** Loss is `revokeRiderDevice` — immediate, unverified, session terminated `DEVICE_REVOKED`. Restoration is `reregisterRiderDevice` in person, delivering the same **QR enrolment handoff** as first registration to the rider's new handset.|
| Melarc Ops| **Specified.** `staff.device.revoke` (Ops Staff) and `staff.device.reregister` (Senior Ops, in person) — `MSC-DEC-235`|
| Melarc Vendor| N/A|

## 17. Related

- **Siblings:** [staff-authentication](staff-authentication.md) · [vendor-authentication](vendor-authentication.md) · [credential-recovery](credential-recovery.md) · [permission-enforcement](permission-enforcement.md)
- **Architecture:** [SOLUTION_ARCHITECTURE.md](../../architecture/SOLUTION_ARCHITECTURE.md) §9 — the native modules device binding requires
- **Contracts:** [domain-model.md](../../contracts/domain-model.md) §6.8 · [state-machines.md](../../contracts/state-machines.md) §13
