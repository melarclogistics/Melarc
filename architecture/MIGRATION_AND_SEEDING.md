# Migration and data seeding

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.16 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** how a Melarc environment comes into existence with the data it cannot function without, and how existing data and code are migrated
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../PROJECT_MASTER_SPECIFICATION.md) §42.6, §42.7, §46.3, §33.1, §45.4, §45.6
> **Authority:** Technical design implements the retained product requirements; it does not redefine product behavior.

## 1. Scope

Three things: what a new environment must be **seeded** with before it can function, how **schema and data migrations** are managed, and how **existing Melarc code and data** are brought across (§46.3).

**It carries no product authority**, and §3 is where that matters most: the bootstrap grants the highest authority in the system, so it is described here and **approved by the Product Owner**, not settled by an architecture document.

## 2. Why seeding is a first-class concern here

Most systems seed for convenience. Melarc has **two hard bootstrap dependencies** where the product does not function at all without seeded data, and both were found by asking who does the first act.

| Dependency| Without it|
|---|---|
| **The first two Platform Admins**| **Nobody can sign in.** No staff record can be created, because creating one requires an authenticated actor holding `staff.identity.create`. **And with one administrator nobody could approve the first profile**, because §30.8 gives the checker's act to someone other than the maker — which is why the seed creates two|
| **The hub default zone**| A hub cannot be created. §33.1 mandates a default that §33.3–4 forbid using at resolution time; `CONFLICT-023` reclassified it as **a hub-creation bootstrap seed**|

## 3. The bootstrap Platform Admins

### 3.1 The problem, stated exactly

`MSC-DEC-247` applied §30.8: a staff identity is created by a holder of `staff.identity.create` and activated by a **different** holder of `staff.identity.approve`. Both are authenticated acts requiring a session, and a session requires an `ACTIVE` staff identity ([state-machines.md](../contracts/state-machines.md) §13).

**At first boot, no identity exists. The maker-checker cannot start itself.** This is not a defect in §30.8 — it is a property of every maker-checker system, and the only question is whether the escape is deliberate and audited or improvised on a deployment call.

### 3.2 What the seed does, and what it deliberately cannot

**Approved by the Product Owner on 26 August, closing `OQ-088`.** The constraints below stand, each for both identities; **two things changed since**: the identity count, which `MSC-DEC-440` supersedes (*exactly one* became *exactly two*), and the credential constraint, which `MSC-DEC-260` corrected.

The seed creates **exactly two** `StaffIdentity` records, each `ACTIVE` with a Platform Admin bundle, outside the API, as part of environment provisioning (`MSC-DEC-440`, which supersedes `MSC-DEC-253`'s *exactly one*) — **each with its own unique work email, no permanent password, no MFA factor, and its own single-use bootstrap setup secret stored only as a hash**. **The pair is created in one transaction, so the staff table is never left holding one** *(derived: a failure between two inserts would leave one identity, and the empty-table guard would then refuse a re-run)*; the seed then refuses to run again, because the table is no longer empty. **Hub reach — decided 6 October 2026: each of the two holds an explicit all-hub grant**, written by the seed, so both reach every hub. It is **never inferred from the Platform Admin bundle's name or from the absence of a hub** ([SECURITY_DESIGN.md](SECURITY_DESIGN.md) §14.2). `staff.identity.create` and `staff.identity.approve` are own-hub keys for every other holder, and the seeded grant is what lets one bootstrap administrator create the first profile, and the other approve it, at whichever hub it names.

**Two custodians, not one person.** **Production requires two distinct designated human custodians**, one for each identity. The pair is **not** two identities that one person controls to satisfy maker-checker: such a pair defeats the control §30.8 exists for and is not the bootstrap this section describes. Who the custodians are is a deployment input, and **the repository cannot verify that two identities belong to two people**, so this is a rule on the deployment and not a mechanical one.

**The bootstrap credential is a setup secret, not the administrator's password.** It grants **no business API authority**, cannot be presented as a session credential, and can invoke bootstrap setup and nothing else.

**Six constraints, each closing a specific way this becomes a permanent back door:**

| Constraint| The failure it prevents|
|---|---|
| **The seed runs only when the staff table is empty** *(checked once for the pair, before either insert)*| It becomes a standing mechanism for creating admins that bypasses §30.8 entirely|
| **No API operation can do this**| `createStaffIdentity` has no `status` field ([openapi.yaml](../contracts/openapi.yaml)), so nothing reachable over the network can create an `ACTIVE` identity. **The bypass is structurally unavailable to a caller**, not merely forbidden|
| **The credential is a single-use setup secret, consumed when the password is established, and never signs in** (`MSC-DEC-260`, replacing *changed at first sign-in*)| A provisioning secret becomes a shared permanent password|
| **`created_by` and `approved_by` both record a reserved system actor**| The record is indistinguishable from one that passed maker-checker, making §30.8's exclusion unverifiable afterwards|
| **The seed emits `staff.identity.created` and `staff.identity.approved` with `enhanced = true`**| The single most privileged act in the product's life leaves no trace. §38.5 category 6 covers account role administration and does not exempt provisioning|
| **The seed sets no password and no MFA factor**| The seeded credential becoming a permanent admin password, and — the defect this replaces — a seed asserting `mfa_enrolled = true` for a factor that does not exist|

**Every constraint above applies to each of the two identities and to the pair.** The reserved system actor is recorded as `created_by` and `approved_by` of **both**, and the seed emits `staff.identity.created` and `staff.identity.approved` as enhanced events for **each**.

**The seed writes as `SYSTEM`**, under an explicit seed task capability, which is how it writes a table whose row-level security is forced (§5.1).

**The fourth constraint is the one that would be dropped.** Writing a real-looking actor into `created_by` is the path of least resistance — it satisfies the non-null constraint and nothing complains. **It also makes every later audit of "was the same-actor rule ever bypassed?" return a false negative**, because the seeded record looks exactly like a compliant one. A reserved actor id makes the bootstrap **visible forever**, which is the point.

### 3.3 What happens immediately afterwards

**Corrected 26 August by `MSC-DEC-260`.** The sequence below previously read: *seed `mfa_enrolled = true`, sign in, then enrol MFA* — which asserts that the factor **both exists before login and is created after it**. That is not a hard ordering constraint; it is an impossible one, and it could only ever have been satisfied by a boolean standing in for a factor that did not exist.

**Each of the two administrators walks steps 1 to 5 separately, with their own secret**; neither depends on the other until step 6.

1. The administrator presents the **single-use bootstrap setup secret** and **establishes their permanent password** (`completeStaffCredentialSetup`). **The password is held to the one credential rule** — 12 to 128 characters, spaces permitted, no composition rule (`MSC-DEC-431`, [SECURITY_DESIGN.md](SECURITY_DESIGN.md) §13.4a) — and **the bootstrap secret is not subject to it**: a provisioning step generates the secret, no person chooses it, and it can only start this one act.
2. **The bootstrap secret is consumed at that moment** and can never be used again. A **`PENDING` `MfaFactor`** is created and a **separate short-lived `MFA_ENROLMENT` continuation grant** is issued.
3. They provision the authenticator and **successfully prove a code** (`completeMfaEnrolment`). The factor becomes `ACTIVE`; a provisioned-but-unproven factor is `PENDING` and is not MFA. **`auth.bootstrap.completed` is written once for this identity**, as an enhanced record.
4. The identity becomes **authentication-ready**.
5. All subsequent access is **ordinary privileged sign-in** — email, password, TOTP.
6. **When both administrators have completed steps 1 to 5**, one of them — signed in through the ordinary privileged sign-in — creates the first real staff profile through §30.8's maker-checker (`createStaffIdentity`, naming a bundle from `listAssignableStaffRoleBundles`), **and the other approves it** (`approveStaffIdentity`). **`SELF_APPROVAL_FORBIDDEN` stays absolute**: the creator of a profile can never approve it, and **there is no bootstrap self-approval exception**.

**For either administrator, no privileged session exists before step 3 completes.** The setup secret authorises setup and never authenticates, so there is no window in which a bootstrap identity is usable without its factor.

**Who approves the first profile — decided** (`MSC-DEC-440`, closing `PDA-69`). §30.8 gives the checker's act to someone other than the maker, and with one seeded identity nobody could approve anything the bootstrap administrator created. **The seed therefore creates a pair, and step 6 has one create and the other approve**, with no exception to maker-checker. A one-time audited rule letting the bootstrap identity approve the first profile it creates was considered and **not taken**: it weakens the control at the act that manufactures every other authority. A non-production fixture as the whole answer was not taken either, because it would have left production with no approver. **Until both administrators are authentication-ready nobody can approve anything**, so `SLICE-000`'s rows 1, 2 and 12 begin only after the pair has completed steps 1 to 5.

**Why the secret is consumed at step 2 rather than step 3**. `MSC-DEC-260` consumed it after TOTP proof, while the contract required a grant at **both** password establishment and MFA enrolment — so a **single-use** secret would have had to be presented twice, which is the one thing a single-use grant cannot do. **Moving the consumption point weakens nothing**: the gate is the factor, not the secret, and `MSC-DEC-259` already put it there.

### 3.3a If the continuation grant expires — the lockout, and how it is closed

**This section said the opposite until 27 August, and the reassurance was false when it was written.** R1 recorded: *"If the continuation grant expires, provisioning is not stranded. The identity holds a password and a `PENDING` factor; a fresh `MFA_ENROLMENT` grant re-enters at step 3."*

**No operation could issue that fresh grant.** `MFA_ENROLMENT` is produced by exactly two operations:

| Operation| What it needs| Available to the stranded bootstrap admin?|
|---|---|---|
| `completeStaffCredentialSetup`| the **`BOOTSTRAP_SETUP`** secret| **No** — single-use, consumed at step 1|
| `beginMfaReenrolment`| an **`MFA_REENROLMENT`** grant, issued only by `resetStaffMfa`| **Not by the stranded administrator** — `resetStaffMfa` is **Platform Admin only**, and a stranded bootstrap administrator cannot authenticate to use it. **The other bootstrap administrator is a valid actor for it** once authentication-ready (below); before then nobody can|

**The result was a permanently unusable environment, reached by thirty minutes passing** — in the one lifecycle whose entire purpose is to make an empty environment usable. Every mechanical check passed over it, because each operation existed and each grant resolved; what did not exist was a path between them.

**`MSC-DEC-272` closes it with a provisioning-only mechanism.** Not an Ops Portal endpoint — a management or deployment action, on the same controlled channel that delivered the bootstrap secret. **Under `MSC-DEC-440` there are two bootstrap identities and either can be stranded, so the mechanism is unchanged except for the seventh condition below, and its conditions are evaluated for each identity on its own.**

**It runs only when all seven conditions hold:**

1. the target is **one of the two seeded bootstrap** Platform Admins;
2. that identity is **not offboarded**;
3. a **permanent password is already established**;
4. **no `ACTIVE` `MfaFactor` exists**;
5. **no privileged session can currently be issued**;
6. bootstrap authentication setup remains **incomplete**;
7. **the other bootstrap Platform Admin does not yet hold an `ACTIVE` credential and an `ACTIVE` `MfaFactor`** (decided 6 October 2026). Once it does, the ordinary `resetStaffMfa` is the way and this mechanism refuses, so it is never a standing way in.

**What it does:** revokes or supersedes stale `PENDING` factor state and grants, issues a fresh short-lived **`MFA_REENROLMENT`** authorisation, delivers it through the **controlled provisioning channel**, and writes an **enhanced** audit record under the reserved system actor.

**That transport is the exception, and it is the only one.** `MFA_REENROLMENT` normally reaches the affected privileged principal by **verified work email**; here there may be no second Platform Admin able to initiate an ordinary reset — the other bootstrap administrator may not have completed setup — so the same channel that carried the bootstrap secret carries the re-enrolment authorisation. **Once the other bootstrap administrator is authentication-ready they reset a stranded one through the ordinary `resetStaffMfa`, and this mechanism then refuses** (decided 6 October 2026). That grant goes to the target's work email, which for a bootstrap identity was seeded and never accepted by an approval; the decision names the route and does not address that. **A gap between two decisions is recorded in §7 and not closed here**: `resetStaffMfa` refuses a target whose factor is only `PENDING` ([state-machines.md](../contracts/state-machines.md) §18), which is exactly a stranded identity's state, so once the other administrator is ready neither route reaches it. **The purpose is unchanged** — begin MFA re-enrolment — because purpose describes what a credential may authorise, not how it travels.

**`reissueStaffCredentialSetup` refuses a bootstrap identity** (`STATE_CONFLICT`; decided 6 October 2026). Once one administrator is authentication-ready they hold `staff.identity.approve`, and that operation's guard is a null credential — which the other identity has until step 1 — so it would issue a fresh 30-minute `STAFF_CREDENTIAL_SETUP` grant to an address nobody verified, beside the unconsumed `BOOTSTRAP_SETUP` secret. **It does not.** The unconsumed secret stays the only way in for an administrator who has not yet set a password.

**What it does not do — and this is why it is not an MFA bypass:**

- **it grants no session**, business or otherwise;
- **it activates no factor** — the administrator still proves a TOTP code at `completeMfaEnrolment`;
- **it neither resets nor reveals the permanent password**;
- **it does not resurrect `BOOTSTRAP_SETUP`.** A single-use credential that can be revived is not single-use, so a *different* purpose is issued.

The administrator then walks the ordinary path — `beginMfaReenrolment` → provisioning → `MFA_ENROLMENT` → **proven** code → `ACTIVE` factor → normal privileged sign-in.

**It stops working as soon as it is no longer needed.** It refuses **for an identity** once the other bootstrap administrator holds an `ACTIVE` credential and an `ACTIVE` factor (the seventh condition), because `resetStaffMfa` then has an authority to run under; and in any case once **that** bootstrap identity is offboarded, which requires **two** proven non-bootstrap Platform Admins (§3.4). **A recovery mechanism that outlives its emergency is an attack surface.**

**The ordering now runs one way.** Nothing is asserted before the thing it asserts exists, and `mfa_enrolled` is derived from the factor rather than written by the seed.

### 3.4 Succession — two proven administrators, not one

**The bootstrap identities are never deleted, and each is retired — offboarded — only after two non-bootstrap Platform Admin successors each** (`MSC-DEC-260`, superseding the trigger in `MSC-DEC-255` item 2; the pair, `MSC-DEC-440`):

- were created through the normal §30.8 maker-checker process, and approved;
- have a **permanent credential established**;
- have an **`ACTIVE` MFA factor**;
- are **authentication-ready**;
- have **completed at least one successful normal privileged MFA sign-in**.

**The condition is the two successors, and it is not multiplied by the number of bootstrap identities retired against them**: retiring both leaves those two, the minimum that lets either reset the other's factor *(derived from the rule above; offboarding itself is `SLICE-009`'s)*.

**Retiring against a single successor produces administrative lockout**, and the arithmetic is short: bootstrap plus one successor, retire the bootstrap, and **one** Platform Admin remains — and with the pair, retire both against one successor and the same one remains. When that person loses their factor, MFA reset requires **another Platform Admin** — and there is not one.

**The proven-sign-in condition is the load-bearing half.** *Approved* is not enough: an account can be approved with no password established, an incomplete enrolment, or a mistyped work email, and offboarding the bootstrap against it converts a formally valid succession into a real lockout. The criterion is **approved + credential-ready + MFA-ready + authentication proven.**

Offboarded, **never deleted** (§30.10), and **`auth.bootstrap.succeeded` is written once for each bootstrap identity retired**. The bootstrap identities' creation and approval events survive with their reserved system actor — **the record of how the product got its first users outlives them.**

**A hard credential expiry was considered at approval and rejected**. Stopping the seeded credential after a fixed window regardless of whether the administrators have completed setup **strands provisioning**: miss the window and nobody can sign in at all, and the environment must be reseeded. Retirement is a policy about when to offboard, not a timer that can lock everyone out.

## 4. Reference data every environment needs

Beyond the bootstrap, an environment is non-functional without these. Each traces to an approved section; **none is invented here.**

| Seed| Why it is required| Governing|
|---|---|---|
| **Permission catalogue** — the closed catalogue, whatever its current size| §11.1 makes permissions the enforcement primitive; §11.5 forbids inferring them from framework defaults. **An empty catalogue denies everything** (§37.1 deny-by-default)| [permissions.md](../contracts/permissions.md) §7|
| **Role bundles** — each with its `name`, `audience` and `privileged` flag: the confirmed staff bundles and the fixed Rider and Vendor bundles| `StaffIdentity.role_bundle_id` is non-null. **No bundle, no staff record, no bootstrap** — and `listAssignableStaffRoleBundles` returns what is seeded here (`MSC-DEC-439`, `domain-model.md` §6.9)| §11.3|
| **At least one hub** with its default zone| §33.1's default is a hub-creation bootstrap seed| `CONFLICT-023`|
| **Settings keys** with approved values| `SETTING_MISSING` fails visibly and **never borrows another hub's value** (§33.4). An unseeded hub cannot price| [settings.md](../contracts/settings.md)|
| **Reason pills** and their mandatory-field metadata| Failure and variance reasons are mandatory; an empty list blocks every failure path| §35.9.2|
| **Error codes and enums**| Compiled from the contract, not seeded as data| [errors-and-enums.md](../contracts/errors-and-enums.md)|

**The settings row is the one that will bite in a fresh environment.** §33.4 forbids borrowing a value or falling back to a global default, and `MSC-DEC-210` makes an order **refused rather than priced** when `outside_accra_margin` is unset for its hub. **A newly seeded hub with incomplete settings accepts bookings and cannot itemize them** — the failure appears one step downstream of its cause, which is exactly the design (fail visibly) working as intended and looking like a bug.

**Settings without values cannot be seeded with invented defaults.** Consult [settings.md](../contracts/settings.md) §7 and §9 for current unresolved inputs. The configured rate-limit values are already specified; production deployment still supplies its required external inputs.

**Identity reasons are a seed with no values yet** (Product decision, 6 October 2026). The identity operations validate their `reason_code` against the reason catalogue, in six new identity domains ([domain-model.md](../contracts/domain-model.md) §3.9). **Which reasons each domain is seeded with, and their wording, is a Product Owner input that has not been supplied, and no code is invented here.** Until it is, those operations refuse every `reason_code` with `REASON_NOT_ACTIVE`, so the demonstration rows that use them cannot be walked from an environment seeded without it.

### 4a. The demonstration rider — a non-production fixture

**`SLICE-000`'s demonstration starts from a rider who already exists, and nothing in the product can create one.** Its script has a rider registered in person, signing in twice, replacing a handset and being revoked. `RiderIdentity` has no creating operation: rider onboarding is `OQ-089`, in `SLICE-009`, and `registerRiderDevice` takes an existing rider's id in its path. [DEPLOYMENT_AND_ENVIRONMENTS.md](DEPLOYMENT_AND_ENVIRONMENTS.md) §3 already says Local holds *seeded fixtures* and that **Staging must be able to run the §45.1 demonstration end to end**, so the rider is a fixture and this is where fixtures are stated.

The fixture creates `RiderIdentity` records — **at least two**, because the exception paths include one rider's credentials presented with another rider's handset (`AC-SLICE-000-50`) — each `ACTIVE`, with the seeded hub as `primary_hub_id`. **Five constraints, each closing a specific way a convenience becomes a back door:**

| Constraint| The failure it prevents|
|---|---|
| **It runs only in Local and Staging** ([DEPLOYMENT_AND_ENVIRONMENTS.md](DEPLOYMENT_AND_ENVIRONMENTS.md) §3), and **refuses to run in production**| A rider with a known phone number becomes a production identity|
| **It sets no PIN and no registered device**| Authentication-readiness is handed over. A rider is authentication-ready only with an `ACTIVE` status, an established PIN **and** an `ACTIVE` device carrying a public key ([domain-model.md](../contracts/domain-model.md) §6.8); the seed supplies the first, and Senior Ops must still call `registerRiderDevice` and the rider must set their own PIN — **the acts the demonstration exists to show**|
| **No API operation can do this**| A rider creation path that bypasses §30.8's maker-checker, which `OQ-089` has yet to write for riders|
| **The phone is a number no real person holds**, and staging holds no production SMS credential ([DEPLOYMENT_AND_ENVIRONMENTS.md](DEPLOYMENT_AND_ENVIRONMENTS.md) §4)| A demonstration sends a live message to a real recipient, or collides with an ad-hoc sender (§30's invariant)|
| **It creates nothing else** — no suspension, availability or offboarding state, no motorcycle assignment, no training acknowledgement| Inventing §30.4 and §30.6 content here, the failure `CONFLICT-036` recorded three times|

**This answers how a rider exists in a demonstration, and nothing about how one exists in production.** `OQ-089` still owns that, and when it is answered `SLICE-009` replaces the fixture in the script with the real operation. **Vendor accounts are the same question and are answered in §4b.** Staff are not a fixture: `createStaffIdentity` and `approveStaffIdentity` are built inside `SLICE-000`, and the bootstrap (§3) supplies the administrator who calls them — **two** administrators, one creating the first profile and the other approving it (§3.3, `MSC-DEC-440`).

### 4b. The demonstration vendor account — a non-production fixture

**`SLICE-000`'s vendor rows start from an approved vendor account, and the operations that make one belong to `SLICE-008`.** `createVendorOrganization` creates an organisation, its shared portal account, its credential and its allowance in one act, and `decideVendorOrganization` is the review a *different* person must perform before the account is `ACTIVE`. That is vendor onboarding, and the foundation slice should not carry it. The same environment boundary as §4a applies.

The fixture leaves **one** vendor where an approval leaves it, **less the setup grant**: the `VendorOrganization` — **its `responsible_hub_id` the seeded hub**, so that hub's Senior Ops is the officer who re-issues the grant, the act being own-hub — and its `VendorAccount` `ACTIVE`; its `VendorCredential` carrying a registered recovery channel, the **`delivery_channel`** an approval chooses (`PHONE` or `EMAIL`, [domain-model.md](../contracts/domain-model.md) §6.8) and a **null secret**; the **`account_identifier`** the account was created with, generated as for any account ([SECURITY_DESIGN.md](SECURITY_DESIGN.md) §13.7a), which the capture adapter shows beside the grant; and the allowance in the state creation gives it, `DISABLED_PREPAYMENT_ONLY` — **approval does not enable it**. **Five constraints, each closing a specific way a convenience becomes a back door:**

| Constraint| The failure it prevents|
|---|---|
| **It runs only in Local and Staging** ([DEPLOYMENT_AND_ENVIRONMENTS.md](DEPLOYMENT_AND_ENVIRONMENTS.md) §3), and **refuses to run in production**| A vendor with a known recovery channel becomes a production account|
| **It sets no secret, registers no browser and issues no setup grant**| Authentication-readiness is handed over. The grant is issued afterwards by `reissueVendorCredentialSetup` (Senior Ops or Platform Admin, own hub), whose guard is a null secret; the vendor then sets **its own** secret and registers **its own** browser — **the acts the vendor-setup row demonstrates**|
| **`created_by` and the deciding actor both record the reserved system actor** (§3.2's fourth constraint)| The record looks like one that passed the §29.2 review, and the same-actor exclusion becomes unverifiable afterwards|
| **No API operation can do this**, and **the recovery channel is one no real person holds**, with no production SMS or email credential in staging and only the capture adapter selected ([DEPLOYMENT_AND_ENVIRONMENTS.md](DEPLOYMENT_AND_ENVIRONMENTS.md) §4 and again [DEPLOYMENT_AND_ENVIRONMENTS.md](DEPLOYMENT_AND_ENVIRONMENTS.md) §12.3)| A review-free approval path; a demonstration that messages a real person|
| **It creates nothing else** — no pickup location, no enabled allowance, no suspension or termination state| Inventing §29 content here, the failure `CONFLICT-036` recorded three times|

**This answers how a vendor exists in a demonstration and nothing about how one is onboarded in production**, which is `SLICE-008`'s.

## 5. Schema migrations

**Forward-only, reviewed, and reversible in effect rather than in form.** §45.6 requires *"migrations, indexes, constraints, data backfills, and rollback/recovery"* to be reviewed before a slice is done.

**Three rules follow from §42.6's historical-integrity requirements rather than from convention:**

- **A migration never rewrites a historical snapshot.** §42.6 requires *"price/settings/reason/provider snapshots required to interpret history"* to be preserved. A backfill that "corrects" a stored price destroys the record of what was charged. Corrections post as **linked adjustments** (§35.6.7).
- **A migration never renames a machine code.** Machine terms are stable; [errors-and-enums.md](../contracts/errors-and-enums.md) §2 makes an error-code rename a **breaking contract change**. A withdrawn code is absent from the `Error` enum, which is what makes "never reused" structural.
- **A migration never deletes history.** §30.10 and §35.1.5: offboarded staff, terminated vendors and failed attempts all stay queryable. Retention deletion is a separate, **enhanced-audited** act (§38.5 category 8), not a migration.

### 5.1 Roles, ownership and RLS at migration time

`MSC-DEC-276`, `MSC-DEC-289`. Migrations run as **`melarc_migration_elevated`** — a **deployment-only** identity obtained through the deployment workload identity, infrastructure-audited, whose credentials are usable **only for the deployment window** and are withdrawn, expired or made unusable when the migration finishes. Tables are owned by **`melarc_owner`** (`NOLOGIN`). **No runtime identity owns a table and none may run DDL.**

**R0 called this identity unprivileged while requiring it to transfer table ownership.** Both cannot be true, and describing an ownership-capable identity as unprivileged does not constrain it — **it only stops anyone constraining it deliberately.** R1 treats it as the privileged identity it is and bounds it by **isolation, duration, workload identity, audit and runtime non-reuse.**

**Every migration that creates a protected table enables and forces row-level security in the same migration**, and grants the runtime roles the minimum DML they need:

```sql
ALTER TABLE <t> OWNER TO melarc_owner;
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE  ROW LEVEL SECURITY;   -- without this the OWNER is exempt from every policy
GRANT SELECT, INSERT, UPDATE ON <t> TO melarc_api_runtime;   -- never ALL, never DELETE by default
-- worker/scheduler/relay grants are per task class, never a blanket business read
```

**`FORCE` is the line that gets left out**, and leaving it out is invisible: the table reports RLS enabled, the policies exist and are correct, and any connection made as the owner is subject to none of them. The role separation above is the first control and `FORCE` is the second, so that losing one does not lose both.

**A migration that adds a persistent table fails review unless [data-scope-registry.md](../contracts/data-scope-registry.md) classifies it**. This is the enforcement point for that rule, because a table's scope class is decided when the table is created or it is decided never — and an unclassified table has no policy, which means it reads and writes correctly for every actor right up until the day a second hub or a second vendor exists.

**Deletes are explicit** (Product decision, 6 October 2026). The migration lint refuses `ON DELETE CASCADE`, `TRUNCATE` and a `DELETE` grant **unless a comment on that statement records the reason**, written `-- allow-delete: <reason>`. A grant is never `ALL` and never `DELETE` by default, as the block above says; this is the mechanical check that keeps it so ([engineering-standards.md](../standards/engineering-standards.md) §7).

**Seeds and backfills write as `SYSTEM`** (Product decision, 6 October 2026). A seed or a backfill writes a forced-RLS table as the `SYSTEM` principal under an **explicit seed task capability** ([SECURITY_DESIGN.md](SECURITY_DESIGN.md) §14.4, §14.17b), never as the migration login and never by bypassing row-level security. **Each table's policy has a `SYSTEM` branch for that capability**, and **the policies keep deciding on the request context alone**: no accessor is tied to the migration login, and the migration role holds no `BYPASSRLS`. The seed helper and each table's branch arrive with the first slice that has a table.

**`melarc_api_runtime` never receives `DELETE` on an audit table** ([data-scope-registry.md](../contracts/data-scope-registry.md) §4.5), which is where §42.6's append-only requirement stops being a convention.

### 5.2 Derived scope columns

`MSC-DEC-278`. A migration adding a derived `responsible_hub_id` to an operational child must, in the same migration:

1. **backfill from the parent**, never from a default or a constant;
2. add the **composite foreign key** to the parent's `(id, responsible_hub_id)`, so a child in one hub cannot reference a parent in another;
3. add the **immutability trigger**;
4. set the column `NOT NULL` only **after** the backfill verifies complete.

**A backfill that defaults is worse than no backfill.** A hub column populated with the launch hub's identifier looks complete, satisfies the constraint, and silently mis-scopes every historical row — and §42.6 forbids a migration that rewrites history, which is exactly what a wrong scope value does to the audit trail that reads it.

### 5.3 A persistent technical table is declared, not excused — Gate B R1

`MSC-DEC-294`. A migration that adds a **persistent technical table** — one required by architecture and defined in no domain contract — must, **in the same controlled change**, add:

1. its row in the canonical inventory at [data-scope-registry.md](../contracts/data-scope-registry.md) **§6**, between the parse markers; and
2. its full per-principal row in Registry **§4**.

**Until both exist, the consistency test must reject the mismatch.** That is the intended behaviour, not an obstacle to route around.

**Contract drift is checked against actual implementation output.** Generate the API description from the NestJS application and compare it with the canonical OpenAPI contract under [engineering-standards.md](../standards/engineering-standards.md) §4. Do not copy the canonical file into the generated-output path.

### 5.4 Expand and contract

`MSC-DEC-374`. The six phases and the rollback boundary live at [DEPLOYMENT_AND_ENVIRONMENTS.md](DEPLOYMENT_AND_ENVIRONMENTS.md) §7.1, because that is the document whose reader runs the release. **What belongs here is what binds the person writing the migration.**

**A destructive step may not run while release N−1 is still supported.** Dropping a column, renaming one, or narrowing a constraint is a **contract-phase** act, and the contract phase begins only once every N−1 instance is gone and the rollback window is closed. **A migration that deletes first is a migration that decides, unilaterally, that rollback is no longer available** — and it makes that decision at the moment rollback is most likely to be wanted.

**Every backfill is:**

| Property| Why it is not optional|
|---|---|
| **Idempotent**| It will be re-run. A backfill that double-applies is a data corruption with a deployment log for an alibi|
| **Restartable**| It will be interrupted. Resuming from the start on a large table means it never finishes|
| **Bounded and batched**| An unbatched update takes a lock the length of the table and the width of the outage|
| **Observable**| A backfill nobody can watch is one nobody can tell has stalled|
| **Safe under live traffic**| It runs against a production the product is still serving|
| **Historically truthful**| **No default may fabricate a historical business fact**|

**The last property is §5.2's rule generalised, and it is the one that looks harmless.** A `NOT NULL` column backfilled with a plausible constant satisfies the constraint, passes every check that counts rows, and **records as fact something nobody observed** — which §42.6 forbids for exactly the reason `MSC-DEC-278` gave about a hub column: a wrong scope value silently mis-scopes every historical row and the audit trail that reads it.

**And no huge synchronous transaction may block startup.** A backfill wired into application boot converts a long migration into a failed deployment, and [DEPLOYMENT_AND_ENVIRONMENTS.md](DEPLOYMENT_AND_ENVIRONMENTS.md) §12.3 already makes a missing security value prevent startup — two reasons to refuse to start is one too many to diagnose at 06:00.

## 6. Migrating from existing code and data

§46.3 lists *"migration strategy from existing code and data"* as an internal dependency, and §46.4's risk table names the hazard directly: *"existing implementation may not match the amended specification"*, risking *"false completion claims, migration defects, and hidden policy violations."*

**The mitigation §46.4 prescribes is a per-slice code audit before the slice begins** — not a single migration project. This document adopts it unchanged.

**Version 1 is greenfield, and that is why the catalogue never arrived**. **There is no legacy Melarc production application or database whose live transactional records must be migrated.** `OQ-097` asked for an inventory before a plan could be written against it, and **the answer is that there is no such database** — which closes the question rather than deferring it again.

**So there is no legacy database migration project**, and this document requires none.

**The per-slice code audit is unaffected**, because it was never about data. §46.4's mitigation applies to existing **code**, and a running operation described in spreadsheets and habits is not a database.

**Still required, and none of it is a migration:** bootstrap (§3) · controlled seeds · the permission catalogue · role bundles · hub and configuration setup · approved reference and reason data · schema migrations (§5) · verified launch configuration.

**If an opening spreadsheet or manual import is later required, it is a separate controlled import artifact.** It **may not** fabricate historical states · manufacture custody or payment history · bypass normal validation · or silently convert uncertain manual data into authoritative transactional fact. **An import that writes a custody event nobody witnessed is not data entry, it is invention** — and §42.6's historical-integrity rules bind it exactly as they bind a migration, which is also §5.4's point about a backfilled default.

**One rule binds regardless of what the audit finds**: where a documented rule would make a working operational practice harder, **that is a finding for the Product Owner, not a rule to enforce quietly during a migration.**

## 7. What this document does not settle

| Item| Owner|
|---|---|
| ~~Approval of the §3 bootstrap~~| **Approved 26 August**, `MSC-DEC-253`|
| ~~Whether the bootstrap identity must be retired, and when~~| **`OQ-096`, closed by `MSC-DEC-255`**; for the pair, `MSC-DEC-440` — each identity is retired only after two non-bootstrap successors, and none is deleted|
| ~~The stranded-continuation mechanism once the other bootstrap administrator is authentication-ready, and `reissueStaffCredentialSetup` aimed at a bootstrap identity (§3.3a)~~| **Decided 6 October 2026** — `reissueStaffCredentialSetup` refuses a bootstrap identity, the resume command stops once the other holds an `ACTIVE` credential and factor, and the other administrator uses `resetStaffMfa`|
| **Open:** a stranded bootstrap administrator whose factor is only `PENDING` once the other administrator is ready — `resetStaffMfa` refuses that target and the resume command has stopped (§3.3a)| **Product Owner**|
| ~~The two bootstrap identities' hub reach (§3.2)~~| **Decided 6 October 2026** — an explicit all-hub grant on each|
| The seeded reasons of the six identity reason domains, and their wording (§4)| **Product Owner** — not supplied|
| ~~An inventory of existing Melarc data~~| **CLOSED 5 September 2026, `MSC-DEC-375`** — Version 1 is greenfield; the inventory described a database that does not exist|
| Migration tooling| Backend Engineer|
| ~~Database role separation and RLS enablement~~| **Settled 27 August**, `MSC-DEC-276` — §5.1|
| Retention deletion procedures| `OQ-028` — legal|
| How a rider is onboarded in production, as opposed to seeded for a demonstration (§4a)| **`OQ-089`** — `SLICE-009`|
| How a vendor is onboarded in production, as opposed to seeded for a demonstration (§4b)| `SLICE-008`|

## 8. Related

[BACKGROUND_JOBS_AND_EVENTS.md](BACKGROUND_JOBS_AND_EVENTS.md) · [OBSERVABILITY_AND_RECOVERY.md](OBSERVABILITY_AND_RECOVERY.md) · [DEPLOYMENT_AND_ENVIRONMENTS.md](DEPLOYMENT_AND_ENVIRONMENTS.md) · [SECURITY_DESIGN.md](SECURITY_DESIGN.md)
