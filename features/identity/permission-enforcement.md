# Permission enforcement

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.16 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** how the two gates and four scope axes are evaluated on every request
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §11.1, §11.5, §11.6, §37.1, §37.3, §37.4, §35.1.2, and cross-cutting §35, §36, §38, §42
> **Slice:** `SLICE-000`

## 1. What this is, and why

Every request passes **two independent checks**, and passing one never implies the other (§11.1, §35.1.2):

1. **The surface gate** — which application this is. Melarc Ops, Vendor and Rider are different tools, not one system behind three logins.
2. **The permission and ownership gate** — whether *this actor* may perform *this action* on *this record*, given the held permission and the four scope axes.

§35.1.2 states the failure mode directly: *"being allowed into a portal does not imply permission to perform every action shown in that portal."*

This is a feature rather than a contract section because **enforcement has behaviour** — what a refusal says, when it is evaluated, and what it must not reveal.

## 2. Governing sections

| Section| What it governs here|
|---|---|
| §11.1| The authorization model; **permissions are enforced, never role names**|
| §11.5| The catalogue is write-oriented; **reads were undefined until `MSC-DEC-221`**|
| §11.6| Key grammar, closed domains, the four scope axes|
| §37.1| **Deny by default.** No matching permission means refused|
| §37.3| Access boundaries per principal type|
| §37.4| Maker-checker and the privileged-action list|
| §35.1.2| The two gates, stated as a business rule|
| §36| State preconditions — evaluated **with** authorization, not before it|


## 3. Surfaces and actors

| Surface| Actor| Can do| Gated by|
|---|---|---|---|
| All three| Every principal| Nothing without a matching permission| Deny by default (§37.1)|
| Melarc Ops| Platform Admin| Read who holds what *(held in the catalogue; no operation in the contract requires the key)*| `permission.read` — **Platform Admin only**|
| Melarc Vendor| Vendor account| **No permission surface at all** (§11.1, `MSC-DEC-134`)| —|
| Melarc Rider| Rider| **No permission surface at all** (§11.1, `MSC-DEC-134`)| —|

## 4. Preconditions

- A session exists, carrying the **bundle snapshotted at issue** and the authorized hub set (`domain-model.md` §6.8).
- The action maps to a permission key from the closed catalogue (`permissions.md` §7).

## 5. Behaviour

### 5.1 The evaluation, in order

**Transport admission comes first and is not one of the twelve steps** (Product decision, 8 October 2026; [SLICE-000-FINAL-DECISIONS.md](../../delivery/planning/SLICE-000-FINAL-DECISIONS.md) §9). Before any step below, resource limits are enforced promptly: header and body bytes (received bytes, chunked requests included), framing, encoding, an unsupported media type or compression, and the header, body and admission deadlines. A request refused there may carry no application envelope — a bare `413` or `415`, or an answer from the edge — and the server never buffers more than the limit merely to return a preferred code. Identity operations accept UTF-8 JSON and reject compressed request bodies. A small, **bounded** JSON syntax error is not refused at this stage: it is carried as a parse-failure marker to step 8, so an unauthenticated caller who sends one meets steps 1 to 7 first (`AC-SLICE-000-130`). A limiter that needs an identifier — an email, a phone number, a token — takes it with a bounded extraction at step 1, without the full validation of step 8; where it cannot be extracted the request meets the coarse admission limits.

**One order for every operation** (Product decision, 6 October 2026), and the first refusal wins:

1. **Rate limit.** `RATE_LIMITED`, before anything is verified or counted.
2. **Authentication.** No usable session is `401` `SESSION_INVALID` (`SESSION_SUPERSEDED` for a displaced vendor session).
3. **CSRF and Origin.** A cookie-authenticated unsafe request without a matching synchronizer token, and any **browser** credential mutation — a pre-session one included — whose `Origin` is missing, `null` or not on the exact allowlist, is `403` `CSRF_VALIDATION_FAILED`; Fetch Metadata marking an unexpected cross-site browser mutation counts the same way. A native Rider operation carries no `Origin` and no browser cookie and is never refused for its absence ([SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.8).
4. **Surface gate.** Is this application permitted to expose this category of work? A vendor session calling an Ops-only operation fails here, before ownership is considered.
5. **Permission held?** Does the session's snapshotted bundle contain the key? **No key, no exception** — §37.1.
6. **Tier.** The key is held and the target needs a higher tier: `INSUFFICIENT_AUTHORITY`.
7. **Hub scope and ownership.** Is the record's hub in the session's authorized set, and is the record the caller's own, assigned or any — per the grant, not the key (§11.6)? Ordinary staff are hub-restricted (§37.3). Row-level security hides a record outside the set, so **for staff only** a read that found nothing is followed by one narrow probe that decides between `HUB_SCOPE_VIOLATION` (it exists) and `NOT_FOUND` (it does not) — [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §14.4b. A Vendor or a Rider is answered `NOT_FOUND` throughout.
8. **Request validation.** The schema and the documented ranges: `400` `VALIDATION_FAILED`.
9. **Idempotency.** A replay of a command that already succeeded returns its original answer; the same key with a different payload is `IDEMPOTENCY_KEY_CONFLICT`. **One exception, time-limited:** the sealed replay of `registerRiderDevice` ends with its grant, after which a replay is `STATE_CONFLICT` and discloses no secret ([SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §14.16).
10. **Version check.** `If-Match` against the record's current version: `STATE_CONFLICT`.
11. **State precondition.** Does the §36 machine permit this transition from the record's current state?
12. **Maker-checker.** For maker-checker actions, is the actor distinct from the maker (§37.4): `SELF_APPROVAL_FORBIDDEN`.

**Why this order.** A caller who may not use an operation learns nothing about its schema, because validation (8) follows permission, tier and scope (5 to 7). And a replay of a command that already succeeded returns its original answer and not a state conflict (with the one time-limited exception of step 9), because idempotency (9) is decided before the version (10) and the state (11) that the first success changed. **For a Vendor's own records scope still comes before version** (`AC-SLICE-000-101`): step 7 precedes step 10.

### 5.2 The state axis is the one most easily dropped

`permissions.md` §5 warns about it and it is worth repeating where an engineer will read it: **a permission check is not answerable from the actor alone.**

`pickup.request.cancel` held with *own record* scope **still fails** once a rider is assigned to the request's manifest — because `MSC-DEC-195` closes vendor self-cancellation at assignment. The actor is unchanged, the permission is unchanged, the record's state decides.

**Authorization and the state machine are one decision, not two.** That is why every transition in [state-machines.md](../../contracts/state-machines.md) carries an actor column, and why an implementation that checks permissions in middleware and states in the service layer will produce the wrong answer at the boundary between them.

### 5.3 What a refusal may say

**One rule per axis**. What a refusal reveals is decided by the axis that failed, not once for the product.

| Situation| Code| What the surface may reveal|
|---|---|---|
| No permission held, or the key's surface does not serve the operation| `PERMISSION_DENIED`| That the action is not available. **Not whether the record exists**|
| Key held, tier too low (a privileged bundle approved by Senior Ops; a vendor session revoked by Senior Ops)| `INSUFFICIENT_AUTHORITY`| That a higher authority is needed|
| An **existing** record outside the staff member's hubs| `HUB_SCOPE_VIOLATION`| That the record is outside the actor's hubs. **Not its contents.** Informative by Product decision: authenticated staff are told, so they can route the work|
| No such record| `NOT_FOUND`| Nothing beyond that|
| A **Vendor** asks for another vendor's record, or a **Rider** looks up a record that is not theirs| `NOT_FOUND`, **identical**| Nothing: the same status, code, body shape and timing class as for a record that does not exist (§43.2, §19.2)|
| Held, in scope, but state forbids it| The transition's own code| The state reason. This is operational information, not a secret|
| Maker equals checker| `SELF_APPROVAL_FORBIDDEN`| That a different approver is required|

**`MFA_REQUIRED` never appears here.** Since `MSC-DEC-228` made the second factor a sign-in gate, a session that exists is already privileged to whatever its bundle allows — there is no unelevated privileged session to refuse. An authorization layer returning `MFA_REQUIRED` has confused authentication with authorization.

### 5.4 What this feature must never do

- **Never test a role name.** §11.1, `MSC-DEC-133`. `user.role == "SENIOR_OPS"` is wrong however correct its outcome, because bundle contents are configuration and must never require a code change.
- **Never leave a declared control optional.** `CSRF_VALIDATION_FAILED` appeared in operations' error lists while nothing obliged a client to send a token or a server to demand one. **A control that is documented but not required is documentation.** `csrfToken` is now an OpenAPI security scheme composed with `browserSession`, so an unsafe browser operation that omits it fails a mechanical check.
- **Never let one operation carry more than one authorization rule.** An operation whose effective permission depends on its request body cannot be checked mechanically, cannot be read off the contract, and cannot be tested per-rule. **R1 removed the one instance** — `performOpsRecovery` declared a single `x-permission` while its description named three authorities across three hub scopes; it is now three operations bound to the three keys `permissions.md` already held.
- **Never permit by framework default.** §37.1 and §11.5: *"no implementation may infer missing permissions from UI convenience or framework defaults."* A route with no declared permission is **refused**, not open.
- **Never resolve the bundle at read time.** The session snapshots it; live resolution shows today's authority against yesterday's action.
- **Never tell a Vendor or a Rider that another party's record exists.** A vendor asking for another vendor's order and a vendor asking for an order that does not exist must be indistinguishable (§37.3, §37.6, §43.2). **Authenticated staff are the deliberate exception on the hub axis** and only there; this bullet and §5.3 once said both things at once.
- **Never evaluate permission without state.** See §5.2.
- **Never expose permission management on a vendor or rider surface** (§11.1, `MSC-DEC-134`) — a surface constraint as much as a permission one.
- **Never let a staff principal read across hubs unrecorded.** A read of a record outside the actor's primary hub — a Platform Admin, or any approved HQ or Finance role (Product decision, 8 October 2026) — writes one `auth.hub_boundary.crossed` event, the actor, the hub and a reference to the record, never its contents; a list writes one bounded event per foreign hub it represents; and a read inside the actor's own hub writes none ([audit.md](../../contracts/audit.md) §5.4, `AC-SLICE-000-128`).
- **Never treat hub scope as a filter to remember.** It is row-level security in `SOLUTION_ARCHITECTURE.md` §6 precisely because a forgotten `WHERE hub_id = ?` is a cross-hub leak, and there will be hundreds of queries.

### 5.5 When a change to a bundle takes effect

**A reduction takes effect at once; an addition retains every existing snapshot and applies to later sessions** (Product decision, 8 October 2026, replacing the decision of 6 October that every edit waited for the next sign-in). A session keeps an **immutable snapshot** of the bundle it was issued from (§5.4: the bundle is never resolved at read time), so history reads correctly. But **a security-reducing change atomically ends every active session issued from that bundle**: the change to the bundle, the termination of those sessions with `AUTHORITY_CHANGED` and their `auth.session.authority_revoked` events (one per session, [audit.md](../../contracts/audit.md) §5.4) are one transaction, and **no second action is needed** to make the reduction effective. A **reduction** is the removal of a permission, or a narrowing of its hub scope, ownership scope or tier. A change that touches only metadata, a name for instance, is not one. An **addition or widening** applies to the sessions issued after it, with any second factor the new authority requires. Reassigning an identity's bundle, suspension, offboarding, device revocation and the loss of hub authority keep their own immediate invalidation.

To know which sessions a reduction ends, each session records the **bundle and the bundle revision** it was issued from. The bundle carries two counters ([SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.10a): a `revision`, raised by **every** change to its authorization content, and a `reduction_floor`, raised to the new revision **only by a reduction**. An addition or widening raises the revision and ends nothing — every existing session keeps its snapshot and stays valid. A reduction ends every active session of that bundle whose recorded revision is below the new floor, in the same transaction as the change, and a request that nonetheless carries such a session is refused. A protected request after the commit finds its session terminated and is `401` `SESSION_INVALID`, and the client returns to sign-in.

**Concurrency is by transaction-scoped advisory locks, never by a row lock.** The runtime roles hold only `SELECT` on the policy tables, and PostgreSQL needs `UPDATE` for a row-locking `SELECT`, so a `FOR SHARE` on a bundle is not available to them and no `UPDATE` grant is made to provide it. Instead: session issue and every state-changing request take the **shared** policy lock for their bundle first; a bundle change, a seed and a migration take the **exclusive** one; and every transaction takes locks in one order — **policy locks, then the identity locks the operation already takes, then session rows** — and never the reverse (§13.10a). A mutation already authorised may therefore finish before a reduction takes its lock, and one that starts afterwards sees its session terminated and does not proceed. **A sign-in racing a reduction cannot keep a stale snapshot**: issue holds the shared lock while it reads the bundle, so it either sees the reduced content or is ordered before the reduction and is ended by it. A completed external effect is not undone.

**What SLICE-000 has.** No operation of this slice edits a bundle's contents (the bundle-change operations are `SLICE-009`'s, [IMPLEMENTATION_PLAN.md](../../delivery/IMPLEMENTATION_PLAN.md) §4c), so contents change here only by seed or migration. SLICE-000 therefore provides the **lineage and the invalidation primitive** — one function that, holding the exclusive policy lock, raises the revision (and the floor, for a reduction) and ends the sessions below the floor in the same transaction — which a seed or migration that changes a bundle must call and which `SLICE-009`'s edit operation reuses. The primitive and its concurrency are tested now (the obligations of §13.10a), and the real edit workflow when it exists. **Vendor and Rider each carry one fixed bundle** ([permissions.md](../../contracts/permissions.md) §8), so their sessions record a bundle and revision like any other and a change to one follows the same rules. The rules a release compiles in for those audiences are versioned separately, by a `policy_revision` and a floor: an instance below the floor refuses issuance **and every authenticated request** of the type with the operational failure and ends no session, and an instance older than a session's revision refuses that request the same way (no compatibility exception exists in Slice-000) ([SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §13.10, `AC-SLICE-000-05`).

## 6. Entities — *pointer*

| Entity| Where|
|---|---|
| `Session`, `StaffIdentity`, `HubAssignment`| [domain-model.md](../../contracts/domain-model.md) §6.8|
| `Permission`, `RoleBundle`| §6.9 — named, field detail deferred|

## 7. States — *pointer*

Every machine in [state-machines.md](../../contracts/state-machines.md). **This feature consumes all of them** — the state axis means authorization cannot be specified against one machine in isolation.

## 8. Permissions — *pointer*

[permissions.md](../../contracts/permissions.md) — the whole document. **Every grantable key is in its catalogue; the count is derived there and is not restated here.**

## 9. Settings — *pointer*

None. Permission content is configuration held in `RoleBundle`, not in [settings.md](../../contracts/settings.md).

## 10. Errors — *pointer*

[errors-and-enums.md](../../contracts/errors-and-enums.md) — `PERMISSION_DENIED`, `INSUFFICIENT_AUTHORITY`, `HUB_SCOPE_VIOLATION`, `NOT_FOUND`, `SELF_APPROVAL_FORBIDDEN`. **`OWNERSHIP_VIOLATION` was withdrawn at Gate PD-3R1**: nothing returned it, and returning it would have told a Vendor that a record exists. **`INSUFFICIENT_AUTHORITY` means the key is held and the tier is too low; a key that is not carried at all is `PERMISSION_DENIED`** — the selection rule `AC-SLICE-000-114` tests.

## 11. Audit events — *pointer*

[audit.md](../../contracts/audit.md) §3 — **an authorised staff read of a record outside the actor's own hub writes `auth.hub_boundary.crossed`** (§5.4 there; first decided for a Platform Admin and widened on 8 October 2026). **`actor_bundle` is snapshotted, not joined.** This feature is why: bundles are editable configuration, and resolving an actor's authority at read time would misreport every historical action.

## 12. API operations — *pointer*

**One operation of its own: `listReasonDefinitions`** (Product decision, 9 October 2026), the read that lets the Ops screens offer only the reasons an identity operation accepts (`AC-SLICE-000-132`). Beyond that read, this feature is enforced on *every* operation in [openapi.yaml](../../contracts/openapi.yaml), which is what makes it a slice-zero concern rather than a feature that can be added later.

## 13. Acceptance criteria

### `AC-SLICE-000-25` — A route with no declared permission is refused

```text
Given an API route with no permission declaration,
When any authenticated principal calls it,
Then it is refused,
And a test enumerating every route fails if any route lacks a declaration,
And no framework default grants access.
```

**Governs:** §37.1, §11.5 · **Surface:** all · **Test level:** integration · **Code:** `PERMISSION_DENIED`

### `AC-SLICE-000-26` — Both gates are independent

```text
Given a vendor session,
When it calls an Ops-only operation whose permission the vendor bundle does not hold,
Then it is refused at the surface gate,
And a staff session holding no relevant permission calling the same operation is refused at the permission gate,
And passing either gate never implies the other.
```

**Governs:** §11.1, §35.1.2 · **Surface:** all · **Test level:** API · **Code:** `PERMISSION_DENIED`

### `AC-SLICE-000-29` — Authorization returns only its own codes, never an authentication code

```text
Given any signed-in principal,
When an action is refused by the authorization layer,
Then the code is PERMISSION_DENIED, INSUFFICIENT_AUTHORITY, HUB_SCOPE_VIOLATION, NOT_FOUND or a state code,
And MFA_REQUIRED is never returned from a business operation,
And a session that exists is already privileged to whatever its bundle allows,
And OWNERSHIP_VIOLATION is not a code any operation can return.
```

**Governs:** §37.2, `MSC-DEC-228`, `MSC-DEC-432` · **Surface:** all · **Test level:** API · **Code:** `PERMISSION_DENIED`

### `AC-SLICE-000-30` — Hub scope is enforced structurally

```text
Given a Senior Ops user authorised for hub A,
When staff identities are listed and read for that session,
Then identities in other hubs are unreachable through any list query,
And the restriction holds for a query whose own code omits any hub filter, run in a test against the same table,
And a deliberately unfiltered query in a test returns only the session's hubs,
And reading an identity outside the hubs by id is HUB_SCOPE_VIOLATION through the scope probe alone, which returns the hub id and nothing else and runs only for a staff principal.
```

**Governs:** §37.3, §11.6, `MSC-DEC-432`, [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §14.4b · **Surface:** Melarc Ops · **Test level:** integration · **Code:** `HUB_SCOPE_VIOLATION`

### `AC-SLICE-000-43` — Anonymity is declared, never inferred

```text
Given the OpenAPI contract,
When every operation is inspected,
Then exactly the deliberate pre-authentication operations declare security: [], with one exception that is not anonymous: vendorSignIn declares the vendorDevice scheme alone, because the registered browser must prove itself before any session exists,
And every other operation inherits an authenticated session scheme,
And no operation relies on x-permission: none to express anonymity.
```

**Governs:** `MSC-DEC-266` · **Surface:** backend · **Test level:** contract

### `AC-SLICE-000-44` — 401 and 403 are different answers to different questions

```text
Given a request carrying no session credential,
When it calls a protected operation,
Then it is refused 401 with SESSION_INVALID,
And given an authenticated actor lacking the required permission,
When that actor calls the same operation,
Then it is refused 403 with PERMISSION_DENIED,
And a missing session never returns 403,
And an authorization failure never returns 401.
```

**Governs:** `MSC-DEC-266`, §37.1 · **Surface:** backend · **Test level:** integration

### `AC-SLICE-000-114` — A missing key is PERMISSION_DENIED and a held key at too low a tier is INSUFFICIENT_AUTHORITY

```text
Given a Senior Ops user and an Ops Staff user,
When the Senior Ops user calls resetStaffMfa, which needs staff.mfa.reset that no Senior Ops bundle carries,
Then it is refused with PERMISSION_DENIED,
And when the Senior Ops user calls revokeSession naming a vendor session, holding staff.session.revoke without the tier for vendors, it is refused with INSUFFICIENT_AUTHORITY,
And when the Senior Ops user approves a staff identity whose bundle is privileged, holding staff.identity.approve without the tier, it is refused with INSUFFICIENT_AUTHORITY,
And when the Ops Staff user calls reregisterRiderDevice, which needs a key the Ops Staff bundle does not carry, it is refused with PERMISSION_DENIED,
And no refusal carries both codes.
```

**Governs:** `MSC-DEC-432`, [errors-and-enums.md](../../contracts/errors-and-enums.md) §4 · **Surface:** Melarc Ops · **Test level:** API · **Code:** `PERMISSION_DENIED`, `INSUFFICIENT_AUTHORITY`

### `AC-SLICE-000-128` — A staff read outside the actor's primary hub is audited once, without contents

```text
Given a Platform Admin whose primary hub is hub A, an approved cross-hub staff principal with the same primary hub, and a record in hub A and another in hub B,
When the Platform Admin reads the hub-B record, then the hub-A record, then the hub-B record again,
Then each read of the hub-B record writes one auth.hub_boundary.crossed event, two in all,
And each event records the actor, the hub and a reference to the record and holds no content of the record,
And the read of the hub-A record writes none,
And the same holds for the other staff principal,
And a list that returns rows from hub A and hub B writes one bounded event naming hub B and the operation, with object_type HUB and no row content and no returned ids, and none for hub A,
And a principal with no primary hub has every hub it reads treated as foreign, one bounded event per hub represented in a list.
```

**Governs:** §37.3, §38.4, [audit.md](../../contracts/audit.md) §5.4 and §6 · **Surface:** Melarc Ops · **Test level:** API

### `AC-SLICE-000-130` — Every operation refuses in one order

```text
Given an operation that takes a request body, an Idempotency-Key and an If-Match,
When a caller who is not signed in, and then a signed-in caller who does not hold the permission, each send a bounded malformed JSON body,
Then the first is refused 401 SESSION_INVALID and the second 403 PERMISSION_DENIED, and neither is told anything about the schema,
And an oversized or unframable request is refused at transport admission, promptly and without the server buffering more than its limit, and is not claimed to meet steps 1 to 7 first,
And a cookie-authenticated request with no synchronizer token, and a browser credential mutation with a missing, null or unapproved Origin, are refused with CSRF_VALIDATION_FAILED before the permission is considered, while a native Rider request with no Origin is not refused for it,
And a caller holding the permission who names a record outside their hubs is refused HUB_SCOPE_VIOLATION or NOT_FOUND before the body is validated, and a malformed body from a caller who may proceed is VALIDATION_FAILED,
And a request that repeats a command which already succeeded, with its Idempotency-Key and its body, returns the original answer and not STATE_CONFLICT, except registerRiderDevice, whose original answer carries a one-time secret: it replays that answer only while its grant is still usable and the caller still holds the authority (a caller who lost it meets the authentication or authorization refusal first), it is STATE_CONFLICT and discloses no secret once the grant has ended, its sealed copy is erased in the transaction that consumes, supersedes or revokes the grant, and another principal or operation never receives it; and the same key with a different body is IDEMPOTENCY_KEY_CONFLICT,
And a stale If-Match is STATE_CONFLICT before the state precondition is evaluated, and SELF_APPROVAL_FORBIDDEN is decided last,
And a request refused by the rate limit is refused before anything else is examined.
```

**Governs:** §5.1, [errors-and-enums.md](../../contracts/errors-and-enums.md) §4 · **Surface:** all · **Test level:** API · **Code:** `RATE_LIMITED`, `SESSION_INVALID`, `CSRF_VALIDATION_FAILED`, `PERMISSION_DENIED`, `HUB_SCOPE_VIOLATION`, `NOT_FOUND`, `VALIDATION_FAILED`, `IDEMPOTENCY_KEY_CONFLICT`, `STATE_CONFLICT`, `SELF_APPROVAL_FORBIDDEN`

### `AC-SLICE-000-131` — Statuses follow one rule

```text
Given the OpenAPI contract and the running API,
When every operation's declared responses and every refusal the tests provoke are inspected,
Then VALIDATION_FAILED is always 400 and is declared under 422 by no operation,
And CSRF_VALIDATION_FAILED is 403,
And IDEMPOTENCY_KEY_CONFLICT is 409 and is declared on every operation that takes an Idempotency-Key,
And a named business-rule code is 422, except MFA_ENROLMENT_REQUIRED, which is 403,
And SESSION_SUPERSEDED is answered 401 to a displaced vendor session by every operation that authenticates a vendor session, and is declared by none.
```

**Governs:** [errors-and-enums.md](../../contracts/errors-and-enums.md) §4 · **Surface:** backend · **Test level:** contract

### `AC-SLICE-000-132` — The reason catalogue is readable for the operations and branches that take a reason, and by no one else

```text
Given Ops Staff, Senior Ops and a Platform Admin at hub A whose session snapshots hold settings.reason.read, a Vendor session, a Rider session with no assigned stop or run, a staff identity T whose factor is ACTIVE and a staff identity U whose enrolment is unfinished,
When each staff caller calls listReasonDefinitions with operation=resetStaffMfa&branch=FACTOR_ACTIVE, with operation=resetStaffMfa&branch=ENROLMENT_UNFINISHED, and with no filter,
Then the first returns exactly MFA_AUTHENTICATOR_UNAVAILABLE and the second exactly MFA_ENROLMENT_EXPIRED, both active, ordered by code, each with permittedOperations naming resetStaffMfa and the matching branch,
And the unfiltered response carries every active reason, the identity ones with permittedOperations and every other domain with null, and no response contains a hub value, a credential or a note,
And resetStaffMfa on T with MFA_ENROLMENT_EXPIRED is REASON_NOT_ACTIVE, because the server derives the branch from T's recorded state under the identity lock and not from the client,
And getStaffIdentity returns mfa_reset_state FACTOR_ACTIVE for T and ENROLMENT_UNFINISHED for U, and NOT_ELIGIBLE for a non-privileged identity, an identity with no factor record, an identity whose latest factor the system ended and a bootstrap administrator whose enrolment is stranded, the same function deciding resetStaffMfa so that its answer for each is the projection's,
And a reset submitted for T after T's factor was revoked in between is STATE_CONFLICT or REASON_NOT_ACTIVE, never a success with the wrong reason, and the screen never chose its branch from mfa_enrolled,
And a Rider session is refused PERMISSION_DENIED because the assignment-based scope is false while no stop or run exists, a Vendor session is refused PERMISSION_DENIED, and a request with no session is SESSION_INVALID,
And a branch without an operation, or an operation or branch outside its enumeration, is VALIDATION_FAILED,
And a session whose bundle lost settings.reason.read through the reduction primitive ends AUTHORITY_CHANGED and a session issued afterwards is refused PERMISSION_DENIED,
And holding the key lets no caller act on another principal: the act's own permission, tier and scope still decide, and a reason used outside its operation or branch is still REASON_NOT_ACTIVE,
And the schema marks permittedOperations readOnly and nothing in this slice writes the catalogue.
```

**Governs:** [domain-model.md](../../contracts/domain-model.md) §3.9 and §6.8, [permissions.md](../../contracts/permissions.md) §7, [state-machines.md](../../contracts/state-machines.md) §18 · **Surface:** Melarc Ops · **Test level:** API · **Code:** `PERMISSION_DENIED`, `SESSION_INVALID`, `VALIDATION_FAILED`, `REASON_NOT_ACTIVE`, `STATE_CONFLICT`

## 14. Open questions blocking this feature

| ID| What it blocks here| Type|
|---|---|---|
| `OQ-047`| **Service-account and integration permissions.** Every human path is now defined; machine callers are not. **Blocks nothing in `SLICE-000`** — the register says so, and no integration exists to decide the rules against| `ARTIFACT_REQUIRED`|
| `OQ-047`| Whether a bundle may carry **per-user overrides**, or bundles are strictly fixed. Affects whether the session snapshot is a bundle or a resolved set| `ARTIFACT_REQUIRED`|
| ~~`OQ-070`~~| **Closed.** Three features had each found a missing **write** permission by the same method, raised as evidence about the catalogue rather than three coincidences| `DECISION_NEEDED`|

**The per-user override question has a design consequence worth surfacing now.** If bundles are strictly fixed, `Session.bundle_snapshot` can be the bundle itself. If overrides exist, the snapshot must be the **resolved permission set**, because the bundle alone would no longer describe the actor's authority. That is a schema decision waiting on `OQ-047`, and choosing wrong means a migration.

## 15. What this feature still owes its slice

| Owed| Blocks which DoR area| Owner|
|---|---|---|
| Whether a bundle may carry per-user overrides — **it shapes `Session.bundle_snapshot`**, so choosing wrong means a migration. **It blocks no Definition-of-Ready area** (the existing requirement treats it as non-blocking for this bounded slice); it is owed before the first integration needs it| —| `OQ-047`|

§13 `Session` was signed by `MSC-DEC-227` on 21 August. Read permissions closed on 20 August.

**Readiness is not assessed here.** [definition-of-ready.md](../../standards/definition-of-ready.md) assesses it **for the complete vertical slice** and records the verdict in the slice document; a feature cannot answer §44.3 or §44.4 alone. This section feeds that assessment instead of duplicating it (`MSC-DEC-239`, closing `CONFLICT-029`).

## 16. Build status — *honest, per surface*

| Surface| Status|
|---|---|
| Melarc Ops| **Specified and buildable for human actors** — every grantable key in `permissions.md`, both gates and all four axes. Service accounts remain `OQ-047`, which is `ARTIFACT_REQUIRED` and **does not block `SLICE-000`**|
| Melarc Vendor| Specified — and the specification is largely *"no permission surface exists"*|
| Melarc Rider| Same|

## 17. Related

- **Siblings:** [staff-authentication](staff-authentication.md) · [rider-authentication](rider-authentication.md) · [vendor-authentication](vendor-authentication.md) · [credential-recovery](credential-recovery.md)
- **Contracts:** [permissions.md](../../contracts/permissions.md) · [audit.md](../../contracts/audit.md) §3
- **Architecture:** [SOLUTION_ARCHITECTURE.md](../../architecture/SOLUTION_ARCHITECTURE.md) §6
