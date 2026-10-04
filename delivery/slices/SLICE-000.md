# `SLICE-000` — Identity and access

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.36 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** the scope, readiness verdict and demonstration script for the foundation slice
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §11, §37, §29, §30, §44, §45

## 1. Scope

**Authentication, session and device policy, and permission enforcement for all three principal types.** Nothing in the product works without it, and §37.8 gated the whole build behind it until 20 August.

### 1.1 What the slice builds

| Feature| Criteria| Operations it specifies|
|---|---|---|
| [staff-authentication](../../features/identity/staff-authentication.md)| 32| `staffSignIn` · `completeStaffMfaSignIn` · `completeStaffCredentialSetup` · `completeMfaEnrolment` · `beginMfaReenrolment` · `createStaffIdentity` · `approveStaffIdentity` · `reissueStaffCredentialSetup` · `listStaffIdentities` · `getStaffIdentity` · `listAssignableStaffRoleBundles` · and the four **session** operations every principal shares: `getCurrentSession` · `signOut` · `revokeSession` · `listSessions`|
| [rider-authentication](../../features/identity/rider-authentication.md)| 44| `requestRiderSignInChallenge` · `riderSignIn` · `registerRiderDevice` · `completeRiderDeviceEnrolment` · `reregisterRiderDevice` · `revokeRiderDevice` · `listRiders` · `getRider`|
| [vendor-authentication](../../features/identity/vendor-authentication.md)| 16| `vendorSignIn` · `completeVendorCredentialSetup` · `requestAdditionalDeviceGrant` · `completeAdditionalDeviceEnrolment` · `listVendorDevices` · `revokeVendorDevice` · `reissueVendorCredentialSetup` · `listVendorAccounts` · `getVendorAccount`|
| [credential-recovery](../../features/identity/credential-recovery.md)| 13| `requestCredentialRecovery` · `completeCredentialRecovery` · `recoverStaffCredential` · `recoverVendorCredential` · `resetStaffMfa`|
| [permission-enforcement](../../features/identity/permission-enforcement.md)| 7| none of its own — it is enforced on every operation|
| **Total**| **112**| **37**|

**Surfaces:** all three — [Ops Portal](../../surfaces/ops-portal.md) (19 routes), [Vendor PWA](../../surfaces/vendor-pwa.md) (7) and [Rider Android](../../surfaces/rider-android.md) (5 screens): **31 in all**, each naming its operations. The [recipient channel](../../surfaces/recipient-channel.md) is untouched: recipients have no account (§20.1).

**In scope, because the script is made of it: creating and approving a staff identity** — `createStaffIdentity` and `approveStaffIdentity` (§30.8, `MSC-DEC-247`, `MSC-DEC-425`) — **with the reads that let a different person do the approving, and the read that lets the maker choose a bundle** (`listStaffIdentities`, `getStaffIdentity`, `listAssignableStaffRoleBundles`, and the roster, account and session reads beside them): **eight of this slice's operations take an `If-Match`** — the ninth identity operation that does, `proposeBundleChange`, is `SLICE-009`'s — and before Gate PD-3R1 none had a read that returned the version.

**The bundle-change operations are not in scope.** `proposeBundleChange` and `approveBundleChange` — which the demonstration script and one criterion used to call — belong to `SLICE-009` with the rest of staff administration. They are no part of the 37.

**Out of scope:** rider *administration* (§30 — onboarding, suspension, status change, offboarding), the rest of staff *administration* (suspension, offboarding, the profile, bundle changes), vendor *administration* (§29), and service-account or integration identity. **Otherwise this slice authenticates identities that already exist** — creating a rider is `SLICE-009` and creating a vendor is `SLICE-008`. **For the demonstration, the rider and the vendor account are the exceptions**: a non-production fixture creates one `ACTIVE` rider with no PIN and no device, and one `ACTIVE` vendor account with no secret, no browser and no setup grant ([MIGRATION_AND_SEEDING.md](../../architecture/MIGRATION_AND_SEEDING.md) §4a and §4b, `MSC-DEC-424`, `MSC-DEC-425`), because no operation in this slice creates either and the script starts from both.

### 1.2 What moved out, and where it went — `MSC-DEC-433`

**A criterion lives in the first slice that owns the resource or operation it exercises, and this slice is not widened to host the ones that do not.** Six criteria needed records that `SLICE-000` does not create — pickup requests, manifests, stops, orders, a bundle-editing operation — and were written against them anyway. The sequence is unchanged. **The identifiers are never reused.**

| Was| Exercised| Where it lives now|
|---|---|---|
| `-12` — a rider sees only assigned work| a manifest and its stops| **`AC-SLICE-001-80`** (`pickup-manifest.md`)|
| `-16` — a vendor reaches only its own records| a vendor's requests and orders| **`AC-SLICE-001-79`** (`pickup-request.md`)|
| `-28` — refusals do not disclose existence| a vendor's order| `AC-SLICE-001-79`; the **order-read** half is owed where an order read operation first exists|
| `-27` — state is evaluated with permission| `cancelPickupRequest` before and after assignment| covered by `AC-SLICE-001-05` and `-12`; no new criterion|
| `-31` — removing a permission takes effect| an operation that edits a bundle| covered here by `-05` and `-06`; the operation-level form is owed to `SLICE-009`|
| `-34` — a reduced bundle ends the live session| `proposeBundleChange` and `approveBundleChange`| owed to `SLICE-009` ([IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md) §4c)|

**Three more were re-expressed on a resource this slice does create** and keep their identifiers: `AC-SLICE-000-07` and `-30` on `StaffIdentity`, and `-46` on `revokeRiderDevice` and `revokeSession`. The demonstration script lost three rows the same way — *Succession*, *Vendor requests another vendor's order* and *Vendor cancels a request after rider assignment* — and one more that the bundle-change operations carried.

## 2. Why this slice exists at all, and why it was nearly invisible

`SLICE-000` **was not in the original thirteen-slice sequence.** It was surfaced by the Phase 1–2 audit, and the reason it was missed is worth recording: the sequence was derived from §16's parcel lifecycle, which describes a parcel moving through the business and says nothing about who is allowed to touch it. Three slices were invisible for that same reason — `000`, `013` and `014` — and all three are **foundation or administration** rather than parcel flow.

**This one gates everything.** §37.8: *"Login, vendor records, rider access, OTP, payment, suspension, or privileged approval implementation is not ready until security architecture and OpenAPI define factor/token/session/device mechanics, authorization checks, audit events, secrets, rate limits, recovery, and negative tests."* That gate passed on 20 August, seven of seven.

## 3. Definition of Ready — re-derived 2 October 2026

Apply [definition-of-ready.md](../../standards/definition-of-ready.md) to the bounded task. Scope, contracts, demonstrations and dependencies are retained below. Resolve an actual product or technical gap before implementing the affected path. Historical approval labels and previous readiness assessments are not additional workflow requirements.

## 4. Verdict

Specification scope is retained; implementation and verification remain to be performed. Do not infer a passing build, integration or release from this document. Report readiness and results for the specific task being executed.

## 5. Demonstration script

§45.1 requires the Product Owner to demonstrate the normal and material exception paths. **Every row below must be walkable without a manual database edit.** The script is a demonstration, **not a test**: every behaviour it shows is also an acceptance criterion, cited beside the row, and `definition-of-done.md` area A requires the criteria — not the script — to pass.

**Precondition — the rider and the vendor account.** The rider rows start from a rider who **already exists**, and the vendor rows from an approved vendor account; **no operation in this slice creates either**. **Both come from the documented non-production fixture** ([MIGRATION_AND_SEEDING.md](../../architecture/MIGRATION_AND_SEEDING.md) §4a and §4b), in Local or Staging only: the rider `ACTIVE` with **no PIN and no registered device**; the vendor account `ACTIVE` with a registered recovery channel, an `account_identifier`, **no secret, no browser and no setup grant**. **Enrolment and replacement in Local and Staging run against the substitute attestation verifier**, and **every message goes to the capture adapter, which reaches nobody** ([SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.9a, §15.2.1); production can select neither. That is a seeded precondition, not a manual database edit, and it leaves every act the rows demonstrate to be performed through the API.

**Staff are not seeded, except the bootstrap pair.** The seed creates **two** bootstrap Platform Admins (`MSC-DEC-440`, [MIGRATION_AND_SEEDING.md](../../architecture/MIGRATION_AND_SEEDING.md) §3.2 and §3.3), each with their own work email and single-use setup secret, and **row 4 establishes both — walk it before rows 1, 2 and 12**. Rows 1, 2 and 12 then create and approve staff through `createStaffIdentity` and `approveStaffIdentity`: **one bootstrap administrator creates the first profile, choosing its bundle from `listAssignableStaffRoleBundles`, and the other approves it** — `SELF_APPROVAL_FORBIDDEN` stays absolute and there is no bootstrap exception. **Both decisions the Gate PD-3R2 review recorded as open are made**, so **rows 1, 2 and 12 can be walked from a clean environment**.

### 5.1 Lifecycles — each must complete end to end

| #| Path| What must be seen|
|---|---|---|
| 1| **Ops Staff setup and login** (`AC-SLICE-000-115`, `-33`, `-85`, `-86`, `-87`, `-01`)| Created by one person, **who chooses the bundle from `listAssignableStaffRoleBundles`**, **found and approved by a different one** — **in a clean environment the first profile is made by one bootstrap administrator and approved by the other** (`AC-SLICE-000-118`) — with the version they read, grant to the work email, employee sets **their own** 12-to-128-character password, signs in, session issued. The maker never supplies a credential|
| 2| **Privileged setup and login** (`AC-SLICE-000-02`, `-32`)| Same to password — then **no session**. TOTP provisioned, a code **proven**, factor `ACTIVE`. Then password → **`202` and a challenge, no cookie** → TOTP → **`200` and the session cookies**|
| 3| **Privileged sign-in before MFA** (`AC-SLICE-000-02`, `-32`)| Password accepted, **MFA challenge only, no session**. The approved bundle grants nothing|
| 4| **Bootstrap — the pair** (`AC-SLICE-000-118`, `-92`)| Seed on an empty staff table creates **two** Platform Admins, each with its own work email and a **single-use setup secret from the deployment channel**; **each in turn: password establishes and consumes their secret**, continuation grant returned **in the same response**, TOTP proven, ordinary sign-in thereafter. The secret cannot start MFA enrolment|
| 4a| **Bootstrap with an expired continuation** (`AC-SLICE-000-93`)| Let one administrator's `MFA_ENROLMENT` grant lapse before proving a code. **The provisioning-only mechanism issues a fresh `MFA_REENROLMENT`**, the admin enrols normally, and **no database edit, no password reset and no MFA bypass occurs**|
| 5| **Bootstrap before MFA** (`AC-SLICE-000-32`)| **No privileged session exists for either administrator** at any point before their factor is proven|
| 6| **MFA reset and re-enrolment** (`AC-SLICE-000-37`, `-94`)| Reset revokes the factor → **`beginMfaReenrolment` returns a new secret** → a wrong code leaves it `PENDING` → a proven code → factor `ACTIVE`. The acting administrator never sees the grant|
| 7| **Rider signs in twice** (`AC-SLICE-000-10`)| The earlier session terminates **`REPLACED_BY_NEW_SESSION`**; the old handset gets a plain `401 SESSION_INVALID` and **is never shown `SESSION_SUPERSEDED`**|
| 8| **Rider registration and sign-in** (`AC-SLICE-000-60`, `-08`, `-40`)| In-person binding: the portal displays a **QR**, the rider scans it on their own handset, which generates a **hardware-backed key** with the QR's attestation challenge and submits its **Key Attestation chain**; **the server verifies it before registering the device**; rider sets **own** six-digit PIN; then challenge → signature → session → **the opaque token is returned once and stored encrypted under a Keystore key**. **The officer never transcribes the code and never learns the PIN**|
| 9| **Rider device replacement** (`AC-SLICE-000-71`, `-108`)| `reregisterRiderDevice` in person, with a reason and a **note on how identity was verified** → **the same QR handoff** → the **new** handset completes through the **same** enrolment operation, **undergoing the same attestation**; the old device becomes **`REPLACED`** and its session ends `DEVICE_REPLACED`|
| 10| **Vendor first setup** (`AC-SLICE-000-42`, `-97`, `-98`, `-101`)| Grant **and account identifier** to the registered channel, vendor sets **own** 12-to-128-character secret, browser registered by a **real `Set-Cookie`**, sign-in works with **no typed device identifier**|
| 10a| **Vendor recovery** (`AC-SLICE-000-22`)| Secret replaced, sessions terminate `CREDENTIAL_CHANGED`, **old device credentials revoked and `melarc_vendor_device` re-issued to the recovering browser**, suspension **preserved**, and **no session created**|
| 10b| **Vendor from an unregistered browser** (`AC-SLICE-000-96`, `-41`)| Correct identifier and correct secret, **different browser → refused**, indistinguishable from a wrong secret — **and no number of attempts locks the account**. This is the demonstration that the second factor exists at all|
| 11| **Exceptional recovery, three authorities** (`AC-SLICE-000-105`, `-23`, `-114`)| Platform Admin starts a staff recovery (reason and the version they read); Platform Admin recovers a vendor credential; **Senior Ops** re-registers a rider device. **Three operations, three permissions**; a bundle without the key is `PERMISSION_DENIED`, a held key at too low a tier is `INSUFFICIENT_AUTHORITY`. The administrator never sees the credential|
| 12| **A lapsed grant is re-issued** (`AC-SLICE-000-89`, `-101`, `-88`)| A staff grant and a vendor grant expire unused; the approver re-issues each with a reason; the earlier grant is dead; an identity that already holds a credential is refused and pointed at recovery; two completions of one grant have one winner|
| 13| **Lockout on three surfaces** (`AC-SLICE-000-77`, `-80`, `-95`, `-109`)| Five wrong passwords lock a staff credential **and nobody is told**; a lock reached at the second factor **is** announced to someone who proved the password; five wrong secrets from a registered browser lock a vendor team; five wrong PINs from the registered handset lock a rider. **None of the four can be started by a caller who has not reached the factor**|
| 14| **Sign out, and read the session** (`AC-SLICE-000-82`, `-83`)| `signOut` ends the session `SIGNED_OUT` and the next request is `SESSION_INVALID`; `getCurrentSession` returns no token and no bundle contents|
| 15| **A shared vendor session is cut** (`AC-SLICE-000-99`, `-100`)| Platform Admin finds a live vendor session and ends it with a reason; Senior Ops is refused; a vendor lists and removes its own browsers but not the one it is using|

*Removed at Gate PD-3R1:* **Succession** — the bootstrap administrators retired by two proven successors need offboarding, which is `SLICE-009`'s; its criterion is owed there (`MSC-DEC-440`: the bootstrap identities are never deleted, and each is retired only after two non-bootstrap Platform Admin successors are proven). **Exceptional staff and vendor recovery** were rows 9a and 9b and are now row 11 and the vendor half of row 10a.

### 5.2 Exception paths — each must be demonstrated

| Path| What must be seen|
|---|---|
| Unknown email at sign-in (`AC-SLICE-000-04`)| `INVALID_CREDENTIALS` — **identical in content and timing** to a wrong password, a suspended account, a pending one and a locked one|
| A failed sign-in, audited (`AC-SLICE-000-91`)| The response is the one undifferentiated answer; `auth.session.failed` records the factor reached and one precise cause, never a credential|
| Rate limit (`AC-SLICE-000-81`)| `RATE_LIMITED` first; the refused request is neither verified nor counted|
| Rider signature that does not verify (`AC-SLICE-000-38`, `-110`)| **Refused** with `DEVICE_PROOF_INVALID`, **the PIN is never examined and nothing is counted**, and the challenge is consumed|
| A caller who has not proved the PIN (`AC-SLICE-000-09`)| An unknown phone, a rider who never enrolled and a rider with a revoked device **all answer `DEVICE_PROOF_INVALID`**; `DEVICE_NOT_ENROLLED` is told only after the PIN is proved (`-48`)|
| A PIN that is not six digits (`AC-SLICE-000-111`)| Refused by the schema, at enrolment and at sign-in|
| MFA challenge older than five minutes (`AC-SLICE-000-03`)| `CHALLENGE_EXPIRED` — *start again*|
| A wrong MFA code, and three of them (`AC-SLICE-000-79`)| `MFA_PROOF_INVALID`; then `CHALLENGE_UNUSABLE` — *this one is finished*. **A different code from expiry, deliberately**; each wrong code also counts toward the identity's lock|
| A challenge id presented to a business operation (`AC-SLICE-000-03`)| `401 SESSION_INVALID` — a challenge is not a session|
| Cookie-authenticated write with no `X-CSRF-Token` (`AC-SLICE-000-84`)| `CSRF_VALIDATION_FAILED`, and **`auth.csrf.rejected` is written**|
| Privileged password accepted (`AC-SLICE-000-02`)| **`202`, an `MfaChallenge`, and no cookie of any kind.** A `200` here, or any `Set-Cookie`, is a defect|
| The maker approves their own creation; a Senior Ops user approves a privileged bundle (`AC-SLICE-000-85`)| `SELF_APPROVAL_FORBIDDEN`; `INSUFFICIENT_AUTHORITY` — and an Ops Staff user is `PERMISSION_DENIED`|
| The bundle list is asked for by a caller without `permission.assignable_bundle.read` (`AC-SLICE-000-116`)| `PERMISSION_DENIED`, and `SESSION_INVALID` with no session — neither `staff.identity.create` nor `permission.read` substitutes|
| A privileged bundle is chosen from the list (`AC-SLICE-000-117`)| The profile is `PENDING_APPROVAL` and grants nothing; only a different Platform Admin approves it; a Rider or Vendor bundle, which is not on the list, is `VALIDATION_FAILED`|
| An approval with a stale version (`AC-SLICE-000-86`)| `STATE_CONFLICT`; failed sign-ins never moved the version|
| A password of 11 or 129 characters (`AC-SLICE-000-87`)| `VALIDATION_FAILED`, the field named and the value never echoed; a 12-character lower-case password and a 128-character passphrase are accepted|
| An approval whose message cannot be delivered (`AC-SLICE-000-90`)| `CREDENTIAL_DELIVERY_FAILED`, **the identity is still `PENDING_APPROVAL` and no grant exists**; a retry issues exactly one|
| A recovery request whose message cannot be delivered (`AC-SLICE-000-107`)| **`202`, exactly as for an unknown identifier**, nothing stored, the provider alert counted|
| A recovery requested with an alternative address (`AC-SLICE-000-20`)| **Rejected outright** with `VALIDATION_FAILED`; nothing is sent.|
| A malformed, expired, reused or superseded recovery link (`AC-SLICE-000-103`)| One answer, `RECOVERY_TOKEN_INVALID`, never saying which|
| Recovery requests past ten a minute (`AC-SLICE-000-104`)| `RATE_LIMITED`, the same for an unknown identifier|
| Recovery requested for an unknown identifier (`AC-SLICE-000-21`)| **202, exactly as for a real one**|
| Recovery completed on a vendor credential (`AC-SLICE-000-22`)| **Every session terminates**, including the one that performed it, **and the browser device credential rotates**|
| Recovery completed on a suspended account (`AC-SLICE-000-24`)| The request was `202`, the credential changes and **the suspension stands**; sign-in is refused with `INVALID_CREDENTIALS`|
| A locked principal completes recovery (`AC-SLICE-000-106`)| The count and the lock are cleared; the next sign-in succeeds|
| Password recovery on a privileged staff identity (`AC-SLICE-000-36`)| Password replaced, sessions terminate `CREDENTIAL_CHANGED`, **MFA factor untouched**|
| Rider device revoked while signed in (`AC-SLICE-000-46`)| Session terminates **`DEVICE_REVOKED`** in the same transaction, the next request is `SESSION_INVALID`, **no cache is consulted**; a revocation with no reason is `VALIDATION_FAILED`|
| Revocation outside the actor's hubs (`AC-SLICE-000-112`)| `HUB_SCOPE_VIOLATION` — the device stays `ACTIVE`; an identifier that matches nothing is `NOT_FOUND`|
| Ops reads the rider roster and the vendor accounts (`AC-SLICE-000-113`, `-102`)| Readiness only — **never a PIN, a hash, a key, a secret or a recovery address**; the version moves on a change and never on a failed sign-in. **Vendor accounts are read within the caller's grant**: an existing account in another hub is `HUB_SCOPE_VIOLATION`, one that does not exist is `NOT_FOUND`, and the list shows no other hub's accounts; **the other-hub half needs a second hub and a vendor whose responsible hub it is, which the acceptance criteria use as a test fixture and the Staging seed does not carry** ([MIGRATION_AND_SEEDING.md](../../architecture/MIGRATION_AND_SEEDING.md) §4b)|
| Enrolment QR scanned twice| **Refused** — single-use. The second scan gets `SETUP_GRANT_INVALID`, and the officer issues a new code|
| `BOOTSTRAP_SETUP` presented at `completeMfaEnrolment` (`AC-SLICE-000-92`)| **Refused.** Only `MFA_ENROLMENT` activates a factor|
| Rider presents the token from a replaced session (`AC-SLICE-000-10`)| **`401 SESSION_INVALID`**, not `SESSION_SUPERSEDED`|
| Rider on a Melarc-signed APK installed manually (`AC-SLICE-000-47`)| **Signs in exactly as on any other route.** Nothing refers to Google Play, an installer or a Play licence verdict|
| Rider signs in from the **old** handset after replacement (`AC-SLICE-000-49`)| **`DEVICE_PROOF_INVALID`**, no session; the old device record is retained, never deleted|
| One rider's phone and PIN with **another rider's** handset signature (`AC-SLICE-000-50`)| **`DEVICE_PROOF_INVALID`**, no session for either rider|
| Sign-in with no device signature (`AC-SLICE-000-51`), or no root signal (`-59`)| **Refused by the request schema**; a PIN alone never authenticates a rider|
| Challenge **already used** (`AC-SLICE-000-52`) / **past its lifetime** (`-53`)| **`CHALLENGE_UNUSABLE`** — this one is finished / **`CHALLENGE_EXPIRED`** — start again|
| `client_root_signal` **`DETECTED`** (`AC-SLICE-000-56`), **`UNKNOWN`** (`-58`), a bad signature sent with **`NOT_DETECTED`** (`-57`)| Signs in and records the signal / signs in as `UNKNOWN` / `DEVICE_PROOF_INVALID` — **no check is relaxed by the signal**|
| First enrolment with a **hardware-attested** key (`AC-SLICE-000-60`)| **Registered `ACTIVE`**, grant consumed, PIN set; no session is issued|
| Enrolment from a handset that **cannot hold a hardware-backed key** (`AC-SLICE-000-61`)| **`DEVICE_SECURITY_UNSUPPORTED`** — no device, grant not consumed, no PIN|
| Enrolment with evidence for the **wrong app**, an **untrusted or revoked chain**, a **different challenge**, an **unlocked or unverified** device, or a **key that is not the attested one** (`AC-SLICE-000-62` to `-66`)| **`DEVICE_INTEGRITY_FAILED`** each time — no device, grant not consumed|
| Enrolment with an **expired, consumed or superseded grant** (`AC-SLICE-000-67`), or with **no attestation** (`-68`)| **`SETUP_GRANT_INVALID`** before any evidence is read; **`VALIDATION_FAILED`** by the schema|
| Enrolment while the **trust data is stale, or this instance has loaded none yet** (`AC-SLICE-000-69`)| **`503` `TRUST_DATA_UNAVAILABLE` with a `Retry-After`** — neither `DEVICE_INTEGRITY_FAILED` nor `DEVICE_SECURITY_UNSUPPORTED`. No device and the grant is not consumed; sign-in and every live session carry on|
| The **signing certificate is rotated** (`AC-SLICE-000-70`)| Enrolments under either digest succeed; after the old digest is removed a new one is refused and enrolled devices keep signing in|
| **Replacement** succeeds, fails, races or follows a revocation (`AC-SLICE-000-71` to `-74`)| Old `ACTIVE` device → **`REPLACED`**, session `DEVICE_REPLACED`; a refused replacement leaves the old device **exactly as it was**; one winner of a race; an already `REVOKED` device **stays `REVOKED`**|
| An **attestation outage** while a rider is signed in (`AC-SLICE-000-54`); the **substitute verifier** (`-75`) and **production refusing it** (`-55`)| Every action proceeds and the session stands; the substitute yields each outcome repeatably; production **refuses to start** with it|
| Senior Ops **registers a rider who already has an `ACTIVE` device** (`AC-SLICE-000-76`)| **`STATE_CONFLICT`** — no grant is issued and the existing device is untouched. **One rider per handset is an operating rule Senior Ops checks in person**|
| Rider Bearer request with no CSRF token| **Accepted.** Bearer requests are not CSRF-exposed and carry no token|
| Staff reads an identity in another hub (`AC-SLICE-000-07`, `-30`)| An **existing** one is `HUB_SCOPE_VIOLATION` — **staff are told** —, one that does not exist is `NOT_FOUND`, a missing key is `PERMISSION_DENIED`; the list never shows another hub|
| A missing key, and a held key at too low a tier (`AC-SLICE-000-114`)| `PERMISSION_DENIED`; `INSUFFICIENT_AUTHORITY` — never both|
| Permission removed from a bundle by configuration (`AC-SLICE-000-05`)| Holder refused on next session. **No deployment, no code change**|
| Ops Staff attempts rider device re-registration; Senior Ops attempts exceptional vendor recovery or an MFA reset (`AC-SLICE-000-23`, `-37`)| `PERMISSION_DENIED` each time — the key is not in their bundle|
| Stolen rider device| Revoked immediately **without identity verification**, session terminated `DEVICE_REVOKED`, old key no longer authenticates|
| Idle privileged browser session past 15 minutes (`AC-SLICE-000-35`)| `401 SESSION_INVALID`, terminated `EXPIRED`. **A rider session is unaffected**|
| Vendor displacement (`AC-SLICE-000-14`)| Second login terminates the first with `SUPERSEDED_BY_NEW_LOGIN`, and the displaced client can **tell that apart** from expiry|
| Missing session / permission denial (`AC-SLICE-000-44`)| `401` with `SESSION_INVALID`, undifferentiated; `403` with `PERMISSION_DENIED`. **A missing session never returns 403**|
| A route with no declared permission (`AC-SLICE-000-25`)| **Refused**, not open by framework default|

**The rows that matter most are the ones that demonstrate something not happening** — no session before MFA, no lock announced to someone who has proved nothing, no lock reachable from an unregistered browser or a handset that cannot sign. An implementation that gets the order of the factors wrong passes every other row here.

## 6. What bears on this slice without blocking it

| Question| Effect|
|---|---|
| `OQ-047`| Service-account permissions, and whether bundles carry per-user overrides. **The override half has a schema consequence** — if overrides exist, `Session.bundle_snapshot` must hold a resolved permission set rather than a bundle. Choosing wrong means a migration. Blocks nothing in this slice|
| `OQ-048`| **The SMS provider and the transactional email provider.** Every setup grant and recovery link leaves through one port with a capture adapter, so the build and the demonstration need neither; **production needs both** (§6.1)|
| `OQ-073` · `OQ-074` · `OQ-030`| The final browser, accessibility and Android baselines, the operation-to-screen map for the other slices, and the full page inventory. **This slice's screens are inventoried, name their operations and have an interim baseline, accepted by the Product Owner for Version 1**; the questions stay open on their wider scope and block none of its screens|
| `OQ-115`| The message broker. **Does not bear on this slice**: credential messages are sent inside the issuing transaction and the trust-data loader runs in each API instance, so neither is a job and neither needs a broker|
| ~~`OQ-113`~~| **Closed 1 October 2026 by `MSC-DEC-427`** — Android Key Attestation at enrolment and replacement, proof of possession at sign-in. [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §15.2.1 carries the policy, §15.2.2 the trust data and [rider-authentication.md](../../features/identity/rider-authentication.md) §4.3 the behaviour|
| ~~`OQ-050`~~ · ~~`OQ-067`~~ · ~~`OQ-069`~~ · ~~`OQ-070`~~ · ~~`OQ-071`~~ · ~~`OQ-077`~~| **Closed.** Device loss is revoke-then-re-register in person; the six rate-limit buckets carry launch values; the session intervals are set; the permission matrix is the policy view and `permissions.md` the enforcement source|

### 6.1 External prerequisites — what completion rests on outside the repository

**None of these blocks the build or the demonstration; each blocks production.** They are listed so that a launch date is not set against a dependency nobody had named.

| Prerequisite| Needed for| State| Owner|
|---|---|---|---|
| An **SMS provider** and a **transactional email provider**, their credentials and a delivery timeout| Every setup grant, recovery link and re-enrolment link in production. **Production refuses to start without them** ([DEPLOYMENT_AND_ENVIRONMENTS.md](../../architecture/DEPLOYMENT_AND_ENVIRONMENTS.md) §12.3)| **Not selected**| Product Owner (provider and cost); Backend Engineer (adapter)|
| The **accepted Android attestation roots**, held as configuration, and egress from the API runtime to Google's published revocation list| Rider enrolment and replacement. Production refuses to start with the roots empty or the maximum age unset| **Roots are a release input; the endpoint is public**| Backend Engineer|
| The **Rider package name** and the **digest of the first production signing certificate**| Rider enrolment — an empty set makes production refuse to start| **Exist only when the signing key does**| Release owner|
| A **KMS key** for TOTP seeds and the **versioned Argon2id pepper**, outside PostgreSQL| Privileged MFA and every hashed credential| **A deployment input** ([SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §14.9)| Backend Engineer|
| A **hardware-backed Android handset** at API 24 or later| The demonstration against real attestation; Local and Staging use the substitute verifier| **A device, not a document**| Frontend Engineer|
| **Two designated human custodians** for the two bootstrap Platform Admin identities, each with their own work email| The production seed, and the first staff profile's approval. **Two identities that one person controls do not satisfy it**| **To be designated** — a deployment input, not a repository value| Product Owner (who is designated)|

## 7. Completion evidence — what Done means for this slice

**`definition-of-done.md` governs; this is what it means here.** The slice is Done when **all** of the following exist and none is a promise:

1. **All 112 criteria pass in the pipeline** of [engineering-standards.md](../../standards/engineering-standards.md) §3.3, each cited by at least one test, **with no hidden skip**.
2. **The 37 operations match the contract** — the drift check passes, every declared code is returned for its documented condition, and no operation returns a code it does not declare.
3. **Negative-access tests at all five surfaces** ([security-test-matrix.md](../../standards/security-test-matrix.md)) — and, for the existence rule, the byte-for-byte comparison of a Vendor's or Rider's refusal with a nonexistent record's.
4. **Startup refusals are tested**: production refuses the substitute verifier, the capture adapter, an unset trust-data age or one not above the six-hour cadence, empty roots, an empty digest set and a missing package name (`AC-SLICE-000-55`).
5. **The Product Owner walks §5 in Staging** against the substitute verifier and the capture adapter, and the walk is recorded — **including rows 1, 2 and 12, which start from the two bootstrap administrators**.
6. **The alert fires in a rehearsal**: the attestation trust-data alert at its two thresholds and the provider-failure alert on a refused credential message ([OBSERVABILITY_AND_RECOVERY.md](../../architecture/OBSERVABILITY_AND_RECOVERY.md) §3).
7. The changed specifications match implementation; applicable checks pass and actual results are reported under the execution plan.
8. **The obligations in [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md) §4c are carried**, so nothing this slice retired is lost.

## 8. Related

- **Features:** [staff-authentication](../../features/identity/staff-authentication.md) · [rider-authentication](../../features/identity/rider-authentication.md) · [vendor-authentication](../../features/identity/vendor-authentication.md) · [credential-recovery](../../features/identity/credential-recovery.md) · [permission-enforcement](../../features/identity/permission-enforcement.md)
- **Architecture:** [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) · [SOLUTION_ARCHITECTURE.md](../../architecture/SOLUTION_ARCHITECTURE.md) · [DEPLOYMENT_AND_ENVIRONMENTS.md](../../architecture/DEPLOYMENT_AND_ENVIRONMENTS.md) · [MIGRATION_AND_SEEDING.md](../../architecture/MIGRATION_AND_SEEDING.md) *(§3, the bootstrap pair, and §4a and §4b, the demonstration rider and vendor account)* · [BACKGROUND_JOBS_AND_EVENTS.md](../../architecture/BACKGROUND_JOBS_AND_EVENTS.md) · [OBSERVABILITY_AND_RECOVERY.md](../../architecture/OBSERVABILITY_AND_RECOVERY.md)
- **Gate B:** [data-scope-registry.md](../../contracts/data-scope-registry.md) · [security-test-matrix.md](../../standards/security-test-matrix.md)
- **Next slice:** [SLICE-001](SLICE-001.md), which cannot run against an unauthenticated system
- **Gates:** [definition-of-ready.md](../../standards/definition-of-ready.md) · [definition-of-done.md](../../standards/definition-of-done.md)

## 9. Normative dependencies


> The following paths identify the retained inputs for this slice. Read the portions relevant to the bounded task; these entries do not require historical approval processing.

| Kind| Document| Role|
|---|---|---|
| `standard`| `standards/definition-of-ready.md`| readiness and completion authority|
| `standard`| `standards/definition-of-done.md`| readiness and completion authority|
| `standard`| `standards/security-test-matrix.md`| readiness and completion authority — Gate B security test authority|
| `feature`| `features/identity/staff-authentication.md`| implementation input|
| `feature`| `features/identity/rider-authentication.md`| implementation input|
| `feature`| `features/identity/vendor-authentication.md`| implementation input|
| `feature`| `features/identity/credential-recovery.md`| implementation input|
| `feature`| `features/identity/permission-enforcement.md`| implementation input|
| `surface`| `surfaces/ops-portal.md`| interaction contract|
| `surface`| `surfaces/vendor-pwa.md`| interaction contract|
| `surface`| `surfaces/rider-android.md`| interaction contract|
| `contract`| `contracts/openapi.yaml`| interface and state authority|
| `contract`| `contracts/domain-model.md`| interface and state authority|
| `contract`| `contracts/state-machines.md`| interface and state authority|
| `contract`| `contracts/permissions.md`| interface and state authority|
| `contract`| `contracts/settings.md`| interface and state authority|
| `contract`| `contracts/audit.md`| interface and state authority|
| `contract`| `contracts/errors-and-enums.md`| interface and state authority|
| `contract`| `contracts/data-scope-registry.md`| interface and state authority|
| `architecture`| `architecture/SECURITY_DESIGN.md`| technical implementation authority|
| `architecture`| `architecture/SOLUTION_ARCHITECTURE.md`| technical implementation authority|
| `architecture`| `architecture/DEPLOYMENT_AND_ENVIRONMENTS.md`| technical implementation authority|
| `architecture`| `architecture/MIGRATION_AND_SEEDING.md`| technical implementation authority — the bootstrap pair, §3, and the demonstration rider and vendor fixtures, §4a and §4b|
| `architecture`| `architecture/BACKGROUND_JOBS_AND_EVENTS.md`| technical implementation authority — §4 records that credential messages and the attestation trust-data loader are not jobs, which is why `OQ-115` does not bear on this slice|
| `architecture`| `architecture/OBSERVABILITY_AND_RECOVERY.md`| technical implementation authority — the attestation trust-data alert and the provider-failure alert, §3|


<!-- NORMATIVE-EXCLUSIONS:BEGIN -->

**Deliberately excluded, and why.** A dependency graph is defined as much by what it refuses as by what it lists:

- `SLICE-001` — **next slice**, not a predecessor. This slice comes first; reading the link the other way inverts the build order
- `surfaces/recipient-channel.md` —  §1 states it **is untouched** here, because recipients have no account (§20.1)

<!-- NORMATIVE-EXCLUSIONS:END -->
