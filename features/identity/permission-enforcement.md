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

**One order for every operation** (Product decision, 6 October 2026), and the first refusal wins:

1. **Rate limit.** `RATE_LIMITED`, before anything is verified or counted.
2. **Authentication.** No usable session is `401` `SESSION_INVALID` (`SESSION_SUPERSEDED` for a displaced vendor session).
3. **CSRF.** A cookie-authenticated unsafe request without a matching token and an allowed `Origin` is `403` `CSRF_VALIDATION_FAILED`.
4. **Surface gate.** Is this application permitted to expose this category of work? A vendor session calling an Ops-only operation fails here, before ownership is considered.
5. **Permission held?** Does the session's snapshotted bundle contain the key? **No key, no exception** — §37.1.
6. **Tier.** The key is held and the target needs a higher tier: `INSUFFICIENT_AUTHORITY`.
7. **Hub scope and ownership.** Is the record's hub in the session's authorized set, and is the record the caller's own, assigned or any — per the grant, not the key (§11.6)? Ordinary staff are hub-restricted (§37.3). Row-level security hides a record outside the set, so **for staff only** a read that found nothing is followed by one narrow probe that decides between `HUB_SCOPE_VIOLATION` (it exists) and `NOT_FOUND` (it does not) — [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) §14.4b. A Vendor or a Rider is answered `NOT_FOUND` throughout.
8. **Request validation.** The schema and the documented ranges: `400` `VALIDATION_FAILED`.
9. **Idempotency.** A replay of a command that already succeeded returns its original answer; the same key with a different payload is `IDEMPOTENCY_KEY_CONFLICT`.
10. **Version check.** `If-Match` against the record's current version: `STATE_CONFLICT`.
11. **State precondition.** Does the §36 machine permit this transition from the record's current state?
12. **Maker-checker.** For maker-checker actions, is the actor distinct from the maker (§37.4): `SELF_APPROVAL_FORBIDDEN`.

**Why this order.** A caller who may not use an operation learns nothing about its schema, because validation (8) follows permission, tier and scope (5 to 7). And a replay of a command that already succeeded returns its original answer and not a state conflict, because idempotency (9) is decided before the version (10) and the state (11) that the first success changed. **For a Vendor's own records scope still comes before version** (`AC-SLICE-000-101`): step 7 precedes step 10.

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
- **Never let a Platform Admin read across hubs unrecorded.** A read of a record outside the admin's own hub writes one `auth.hub_boundary.crossed` event — the actor, the hub and a reference to the record, never its contents — and a read inside the admin's own hub writes none ([audit.md](../../contracts/audit.md) §5.4, `AC-SLICE-000-128`).
- **Never treat hub scope as a filter to remember.** It is row-level security in `SOLUTION_ARCHITECTURE.md` §6 precisely because a forgotten `WHERE hub_id = ?` is a cross-hub leak, and there will be hundreds of queries.

### 5.5 When an edit to a bundle takes effect

**At the next sign-in** (Product decision, 6 October 2026). Editing a bundle's contents — adding or removing a permission by configuration — changes the snapshot of the sessions created **after** the edit. **A live session keeps the permission snapshot it was issued with** (§5.4: the bundle is never resolved at read time) and ends by its own expiry, idle timeout or sign-out. **A narrowing that must act at once is done by ending the sessions with `revokeSession`**, which is why that operation exists. This is not the authority change that ends sessions with `AUTHORITY_CHANGED`: that is a **different bundle assigned to an identity**, built with the bundle-change operations in `SLICE-009` ([IMPLEMENTATION_PLAN.md](../../delivery/IMPLEMENTATION_PLAN.md) §4c).

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

[audit.md](../../contracts/audit.md) §3 — **a Platform Admin's read of a record outside their own hub writes `auth.hub_boundary.crossed`** (§5.4 there). **`actor_bundle` is snapshotted, not joined.** This feature is why: bundles are editable configuration, and resolving an actor's authority at read time would misreport every historical action.

## 12. API operations — *pointer*

**No operations of its own.** This feature is enforced on *every* operation in [openapi.yaml](../../contracts/openapi.yaml), which is what makes it a slice-zero concern rather than a feature that can be added later.

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

### `AC-SLICE-000-128` — A Platform Admin's read outside their own hub is audited once, without contents

```text
Given a Platform Admin whose own hub is hub A, and a record in hub A and another in hub B,
When the Platform Admin reads the hub-B record, then the hub-A record, then the hub-B record again,
Then each read of the hub-B record writes one auth.hub_boundary.crossed event, two in all,
And each event records the actor, the hub and a reference to the record and holds no content of the record,
And the read of the hub-A record writes none.
```

**Governs:** §37.3, §38.4, [audit.md](../../contracts/audit.md) §5.4 and §6 · **Surface:** Melarc Ops · **Test level:** API

### `AC-SLICE-000-130` — Every operation refuses in one order

```text
Given an operation that takes a request body, an Idempotency-Key and an If-Match,
When a caller who is not signed in, and then a signed-in caller who does not hold the permission, each send a malformed body,
Then the first is refused 401 SESSION_INVALID and the second 403 PERMISSION_DENIED, and neither is told anything about the schema,
And a cookie-authenticated request with no synchronizer token is refused with CSRF_VALIDATION_FAILED before the permission is considered,
And a caller holding the permission who names a record outside their hubs is refused HUB_SCOPE_VIOLATION or NOT_FOUND before the body is validated, and a malformed body from a caller who may proceed is VALIDATION_FAILED,
And a request that repeats a command which already succeeded, with its Idempotency-Key and its body, returns the original answer and not STATE_CONFLICT, and the same key with a different body is IDEMPOTENCY_KEY_CONFLICT,
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
