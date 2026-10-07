# Security test matrix

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.9 (development-clean edition)
> **Date:** 4 October 2026
> **Owns:** the canonical enumeration of Melarc's negative security tests — what each one sets up, who attacks, what they attempt, what must happen, and **which layer is responsible for making it happen**
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../PROJECT_MASTER_SPECIFICATION.md) §37.6, §37.3, §38.4, §40.4

## 1. Why the responsible layer is a column

§37.6 requires **negative-access tests** and [engineering-standards.md](engineering-standards.md) §3.1 makes them mandatory at five surfaces. This matrix adds a column those tests never carried: **which layer must produce the denial.**

**A negative test that does not name its layer can pass for the wrong reason, indefinitely.** An application `WHERE hub_id = ?` denies a cross-hub read whether or not the RLS policy exists. The test is green, the control is absent, and the day it matters is the day someone writes the one query that forgot the clause — which is the exact failure `SOLUTION_ARCHITECTURE.md` §6 chose RLS to make impossible.

**Where the responsible layer is `RLS`, the test is written against the database** — with application filtering disabled or bypassed — or it is not testing what it claims to test.

| Layer| Meaning|
|---|---|
| `RLS`| A PostgreSQL row-level-security policy refuses|
| `GRANT`| Database privileges refuse. The role does not hold the right|
| `CONSTRAINT`| A relational constraint or trigger refuses|
| `APP`| Application code refuses — a guard, a validator, a state machine|
| `EDGE`| The reverse proxy, CORS configuration or a security header refuses|
| `INFRA`| Cloud IAM, bucket policy, KMS policy or network policy refuses|
| `WORKER`| The job's own envelope verification refuses|

## 2. Principal-first scope model

These tests use a **principal-first authorization model**:

- **Staff** authority is bounded by the Hub scope resolved for the operation.
- **Vendor** authority is bounded by `vendor_organization_id`, not by Hub membership.
- **Rider** authority is bounded by assignment and the relevant Rider-facing permission.
- **SYSTEM** authority is bounded by the trusted task capability and stored execution envelope.

A Vendor principal therefore does not inherit Staff Hub restrictions. A vendor's order may be fulfilled by different hubs, while Vendor access remains ownership-bound: **Vendor A may read its own authorized rows in Hub A and Hub B, and must never read Vendor B's row in either.**

**Hub authorization is the Staff boundary**, tested in Family B.

---

## 3. Family A — Pooled connections

**Every test here must force reuse of the same physical PostgreSQL connection.** A test on a fresh connection proves nothing and passes against a session-wide `SET` — the defect the family exists to catch.

| ID| Setup| Actor| Attempts| Expected| Layer|
|---|---|---|---|---|---|
| `GBT-A1`| Staff Hub A transaction **commits**; the same physical connection is issued to a Staff Hub B request| Hub B staff| Read orders| **No Hub A rows**| `RLS`|
| `GBT-A2`| Staff Hub A transaction **rolls back**; same connection reused with **no context**| Unauthenticated / internal caller| Read any protected table| **Zero rows.** Not Hub A's, not anyone's| `RLS`|
| `GBT-A3`| Explicit **all-Hub** transaction completes; same connection reused for an ordinary `SET` request| Ops Staff, one hub| Read orders| **All-Hub authority does not leak**| `RLS`|
| `GBT-A4`| **Vendor** transaction completes; same connection reused by a **Staff** request| Hub A staff| Read orders| Staff sees Hub A only — **no vendor context survives**| `RLS`|
| `GBT-A5`| **Rider** transaction completes; same connection reused by a **Vendor** request| Vendor A| Read own orders| Vendor sees its own rows — **no rider assignment survives**| `RLS`|

## 4. Family B — Staff principal

Hub scope is the **Staff** boundary and only the Staff boundary. These tests assert that boundary directly.

| ID| Setup| Actor| Attempts| Expected| Layer|
|---|---|---|---|---|---|
| `GBT-B1`| Staff authorised for Hub A only| Ops Staff| Read a Staff-accessible Hub A operational row| **Visible**| `RLS`|
| `GBT-B2`| Staff authorised for Hub A only| Ops Staff| Read the equivalent Hub B row| **Denied**| `RLS`|
| `GBT-B3`| Session explicitly grants all-Hub authority| Platform Admin| Read across hubs| **Permitted**, and §38.5 category 4 emits an enhanced audit event| `RLS` + `APP`|
| `GBT-B4`| Session grants `SET`; client requests `hub_scope_mode=ALL`| Ops Staff| Cross-hub read| **Ignored.** Mode comes from the Session, never the request| `APP`|
| `GBT-B5`| Session carries an **empty** Hub set| Ops Staff| Any Hub-scoped read| **Zero rows.** Empty never means all| `RLS`|
| `GBT-B6`| Bundle **name** looks privileged; Session grants `SET`| Ops Staff| Cross-hub read| **Denied.** Authority is never read from a role or bundle name| `RLS`|
| `GBT-B7`| A live session; a `HubAssignment` then changes| The same actor| Continue using the session| **Terminated** with `HUB_SCOPE_CHANGED`| `APP`|
| `GBT-B8`| Context carries **no** `principal_type`| —| Read any protected table| **Zero rows**; write denied| `RLS`|
| `GBT-B9`| Context carries an **unknown** `principal_type`| —| Read any protected table| **Zero rows**; write denied| `RLS`|
| `GBT-B10`| A request whose resolved context would carry a **malformed** principal id| Any principal| Any protected operation, through the ordinary application path| **Context establishment fails.** No transaction opens, **no protected statement runs**, no row is disclosed, and the refusal is not a query returning zero rows| `APP`|
| `GBT-B11`| `melarc.principal_id` corrupted **by hand** on a direct connection, bypassing the application| —| Read any protected table| **No row is disclosed.** The `::uuid` cast **raises** and the statement aborts — fail-closed **by abort**, which is a different code path from a policy returning false| `RLS`|

## 5. Family C — Vendor principal

A Vendor's boundary is `vendor_organization_id` and **never a Hub**. Vendor ownership, not Staff Hub scope, determines Vendor row visibility.

| ID| Setup| Actor| Attempts| Expected| Layer|
|---|---|---|---|---|---|
| `GBT-C1`| Vendor A owns row A1 in Hub A **and** row A2 in Hub B| Vendor A| Read both| **Both visible** where the existing Product operation permits Vendor read| `RLS`|
| `GBT-C2`| As above, and the Vendor context carries **no** `authorized_hub_ids`| Vendor A| Read both| **Both still visible.** The Vendor branch reads no hub at all| `RLS`|
| `GBT-C3`| As above, with an **empty** Hub set explicitly present| Vendor A| Read both| **Both still visible** — and an empty set grants a Vendor nothing extra either| `RLS`|
| `GBT-C4`| Vendors A and B both hold rows in Hub A| Vendor A| Read Vendor B's row| **Denied**| `RLS`|
| `GBT-C5`| Vendors A and B hold rows in **different** hubs| Vendor A| Read Vendor B's row| **Denied**| `RLS`|
| `GBT-C6`| Vendor context, forged `hub_scope_mode = ALL`| Vendor A| Read any Hub-scoped row| **Denied.** A Vendor never reaches the Staff branch| `RLS`|
| `GBT-C7`| Vendor context, forged arbitrary `authorized_hub_ids`| Vendor A| Read another vendor's row in that hub| **Denied**| `RLS`|
| `GBT-C8`| Vendor context with **no** `vendor_organization_id`| Vendor A| Read any vendor-owned row| **Denied** — `NULL` comparison is not `TRUE`| `RLS`|
| `GBT-C9`| A `PickupManifest` carrying stops for several vendors| Vendor A| Read the manifest| **Denied.** The Vendor branch on that table is `DENY`| `RLS`|
| `GBT-C10`| `SecurityRiskHold` against Vendor A| Vendor A| Read its own risk hold| **Denied.** Telling the subject is the failure mode| `RLS`|

## 6. Family D — Rider assignment

**Hub equality is not a Rider boundary.** Every test places both riders in the **same hub**, so a hub match cannot make it pass.

| ID| Setup| Actor| Attempts| Expected| Layer|
|---|---|---|---|---|---|
| `GBT-D1`| Riders A and B, same hub, each with their own manifest| Rider A| Read Rider B's `PickupManifest`| **Denied**| `RLS`|
| `GBT-D2`| As above| Rider A| Mutate Rider B's `PickupManifest`| **Denied** by `WITH CHECK`| `RLS`|
| `GBT-D3`| As above| Rider A| Read Rider B's `PickupStop`| **Denied** — the child inherits assignment from the manifest, not the hub| `RLS`|
| `GBT-D4`| Riders A and B, same hub, each with a delivery run| Rider A| Read Rider B's `DeliveryRun`| **Denied**| `RLS`|
| `GBT-D5`| As above| Rider A| Read or mutate Rider B's `DeliveryStop`| **Denied**| `RLS`|
| `GBT-D6`| As above| Rider A| Read Rider B's `CollectionRecord` and `DeliveryAttempt`| **Denied**| `RLS`|
| `GBT-D7`| Rider A hands custody to Rider B via `RunCustodyHandover`| Rider B| Read Rider A's `RiderCashCustody`| **Denied.** Parcels move; **cash does not**| `RLS`|
| `GBT-D8`| Riders A and B, same hub, each assigned a motorcycle| Rider A| Read Rider B's `MotorcycleAssignment` or `FuelRecord`| **Denied**| `RLS`|
| `GBT-D9`| Rider context with **no** assignment on the target aggregate| Rider A| Read that aggregate| **Denied**| `RLS`|
| `GBT-D10`| Rider context, forged `authorized_hub_ids` covering the row's hub| Rider A| Read Rider B's row| **Denied.** A Rider never reaches the Staff branch| `RLS`|
| `GBT-D11`| A row carrying a `rider_id` that no existing Product permission exposes to a Rider| Rider A| Read it| **Denied.** No current Rider permission exposes that row| `RLS`|

## 7. Family E — SYSTEM principal

SYSTEM is an explicit task capability plus the trusted envelope — **never a fabricated Staff `ALL`**.

| ID| Setup| Actor| Attempts| Expected| Layer|
|---|---|---|---|---|---|
| `GBT-E1`| Worker context established from a valid `Outbox` envelope| SYSTEM| Read the named aggregate| **Permitted**, bounded to the envelope's scope| `RLS`|
| `GBT-E2`| Worker sets `hub_scope_mode = ALL` directly| SYSTEM| Read across hubs| **Denied.** SYSTEM has no Staff `ALL` branch| `RLS`|
| `GBT-E3`| Task class not permitted on the target table| SYSTEM| Read or write it| **Denied** by the task capability predicate| `RLS`|
| `GBT-E4`| SYSTEM context with no task capability| SYSTEM| Any protected read| **Denied**| `RLS`|

## 8. Family F — Writes and scope mutation

`USING` bounds the row a statement may **see**; `WITH CHECK` bounds the row it may **produce**. Both are tested separately because a `USING`-only policy passes every read test.

| ID| Setup| Actor| Attempts| Expected| Layer|
|---|---|---|---|---|---|
| `GBT-F1`| Staff authorised for Hub A only| Ops Staff| `INSERT` a row with `responsible_hub_id` = Hub B| **Refused by `WITH CHECK`**| `RLS`|
| `GBT-F2`| Staff authorised for Hub A, holding a Hub A row| Ops Staff| `UPDATE` its hub to Hub B| **Refused by `WITH CHECK`.** `USING` alone permits this| `RLS`|
| `GBT-F3`| Vendor A holds its own row| Vendor A| `UPDATE` `vendor_organization_id` to Vendor B| **Refused by `WITH CHECK`**| `RLS`|
| `GBT-F4`| Rider A holds an assigned stop| Rider A| Substitute Rider B's assignment| **Refused**| `RLS`|
| `GBT-F5`| A `DeliveryStop` with derived `responsible_hub_id`| Any writer| Mutate the derived scope column| **Refused** by the immutability trigger| `CONSTRAINT`|
| `GBT-F6`| A Hub A `DeliveryRun` exists| Any writer| Insert a Hub B `DeliveryStop` referencing it| **Refused** by the composite foreign key| `CONSTRAINT`|

## 9. Family G — PickupRequest hub reassignment

The one **explicitly permitted** scope mutation in the registry. Every negative below is a way it must not become a general edit.

| ID| Setup| Actor| Attempts| Expected| Layer|
|---|---|---|---|---|---|
| `GBT-G1`| Pre-custody request; actor authorised for source **and** target hub| Ops / Senior Ops / Platform Admin| `reassignPickupRequestHub`| **Succeeds**, scope changes atomically, audit written| `APP` + `RLS`|
| `GBT-G2`| Request already planned into a manifest, run **not started**| Authorised actor| Reassign| **Succeeds**; old stop and planning assignments **revoked atomically**| `APP`|
| `GBT-G3`| As above, after the command| Previous hub's staff| Read the request through the old manifest| **Denied.** No stale artifact keeps conferring the former scope| `RLS`|
| `GBT-G4`| As above, after the command| Previously assigned rider| Read the request| **Denied**| `RLS`|
| `GBT-G5`| Any actor| Any| Generic `PATCH` of `responsible_hub_id`| **Refused.** No such field is accepted| `APP`|
| `GBT-G6`| Actor authorised for the **target** hub only| Ops Staff| Reassign| **`HUB_SCOPE_VIOLATION`**| `APP` + `RLS`|
| `GBT-G7`| Actor authorised for the **source** hub only| Ops Staff| Reassign into an unauthorised hub| **`HUB_SCOPE_VIOLATION`** — exporting work beyond your own authority| `APP` + `RLS`|
| `GBT-G8`| Rider pickup or run has started| Authorised actor| Reassign| **`STATE_CONFLICT`**| `APP`|
| `GBT-G9`| Custody exists| Authorised actor| Reassign| **`STATE_CONFLICT`.** Inter-hub transfer is never simulated this way| `APP`|
| `GBT-G10`| A completed reassignment| —| Inspect historical custody records| **They do not move.** History stays with the hub that made it| `APP`|
| `GBT-G11`| A completed reassignment| —| Inspect the audit trail| `pickup.request.hub_reassigned`, **enhanced**, carrying previous hub, new hub, actor, correlation id and every revoked artifact| `APP`|

## 10. Family H — Trusted Outbox envelope

The family that proves the broker cannot create authority.

| ID| Setup| Actor| Attempts| Expected| Layer|
|---|---|---|---|---|---|
| `GBT-H1`| A business mutation commits| —| Compare `Outbox` authority fields to the aggregate| **Equal**, and written in the **same transaction**| `APP`|
| `GBT-H2`| HTTP request carrying `responsible_hub_id` / `vendor_organization_id` in its body| Any client| Create work| **Envelope scope is server-derived.** Client input never reaches it| `APP`|
| `GBT-H3`| Broker message carrying forged Hub, Vendor or Rider scope| Attacker| Deliver to worker| **Ignored.** The stored row is authoritative; inconsistent metadata is rejected| `WORKER`|
| `GBT-H4`| Normal execution| Worker| Observe ordering| **`Outbox` is read before any business context is established**| `WORKER`|
| `GBT-H5`| Normal execution| Worker| Observe context source| Established **from the stored envelope**, transaction-locally| `WORKER`|
| `GBT-H6`| Normal execution| Worker| Observe aggregate load| Reloaded **under RLS**, after context| `RLS`|
| `GBT-H7`| Envelope scope and reloaded aggregate disagree| Worker| Execute| **No business side effect** · abort · dead-letter · security signal · **never widen scope**| `WORKER`|
| `GBT-H8`| Relay identity| Relay| Update an envelope authority field| **Refused**| `GRANT`|
| `GBT-H9`| Relay identity| Relay| Any business `INSERT`/`UPDATE`/`DELETE`| **Refused**| `GRANT`|
| `GBT-H10`| Worker whose task class does not cover this event type| Worker| Execute the task| **Refused at step 4**| `WORKER`|
| `GBT-H11`| Any API caller| Any| Read arbitrary `Outbox` rows through the API| **No such operation exists**| `APP`|

## 11. Family I — Idempotency

The critical failure mode is not merely a key collision — it is **one caller receiving another caller's stored response**.

| ID| Setup| Actor| Attempts| Expected| Layer|
|---|---|---|---|---|---|
| `GBT-I1`| Vendors A and B both send `Idempotency-Key: retry-1` on the same operation| Vendor B| Submit| **Executes normally.** Independent namespace — **no replay of Vendor A's result**| `APP`|
| `GBT-I2`| A Staff principal and a Vendor principal use the same text key| Either| Submit| **No collision**| `APP`|
| `GBT-I3`| Same principal · same operation · same key · **same** payload| Any| Resubmit| **Replays** the original result| `APP`|
| `GBT-I4`| Same principal · same operation · same key · **changed** payload| Any| Resubmit| **`IDEMPOTENCY_KEY_CONFLICT`**| `APP`|
| `GBT-I5`| Same principal · **different operation** · same key| Any| Submit| **No collision**| `APP`|
| `GBT-I6`| Any stored result| A different principal| Present the matching key| **Never returned**| `RLS` + `APP`|
| `GBT-I7`| A SYSTEM task| SYSTEM| Write an idempotency record| Principal is a **stable non-null task identity** — never null, never a wildcard, never one shared worker identity| `APP`|
| `GBT-I8`| The uniqueness constraint| —| Inspect| Covers `principal_type + principal_id + operation_id + idempotency_key`| `CONSTRAINT`|

## 12. Family J — Technical identities

**Assert the refusal, not the configuration.** A role's effective authority is what the database refuses, never what a settings table claims — so every row executes the attempt.

| ID| Setup| Actor| Attempts| Expected| Layer|
|---|---|---|---|---|---|
| `GBT-J1`| `melarc_api_runtime`| API runtime| DDL on a protected table| **Error**| `GRANT`|
| `GBT-J2`| `melarc_api_runtime`| API runtime| `ALTER POLICY` / `CREATE POLICY`| **Error**| `GRANT`|
| `GBT-J3`| `melarc_api_runtime`| API runtime| `ALTER TABLE ... OWNER TO` / become owner| **Error**| `GRANT`|
| `GBT-J4`| `melarc_api_runtime`| API runtime| `ALTER ROLE ... BYPASSRLS`| **Error**| `GRANT`|
| `GBT-J5`| `melarc_api_runtime`| API runtime| `GRANT` itself a role| **Error**| `GRANT`|
| `GBT-J6`| `melarc_api_runtime`| API runtime| `UPDATE` or `DELETE` on `AuditEvent`| **Error.** Insert-only grant| `GRANT`|
| `GBT-J7`| `melarc_worker_runtime`| Worker| Read a business table unrelated to its task class| **Error.** There is no default all-table read| `GRANT`|
| `GBT-J8`| `melarc_worker_runtime`| Worker| DDL, or alter a role| **Error**| `GRANT`|
| `GBT-J9`| `melarc_scheduler_runtime`| Scheduler| Arbitrary business DML| **Error**| `GRANT`|
| `GBT-J10`| `melarc_outbox_relay_runtime`| Relay| Mutate a business aggregate| **Error**| `GRANT`|
| `GBT-J11`| `melarc_outbox_relay_runtime`| Relay| Rewrite an `Outbox` security field| **Error**| `GRANT`|
| `GBT-J12`| Any runtime identity| API / worker / scheduler / relay| `SET ROLE melarc_migration_elevated`| **Error**| `GRANT`|
| `GBT-J13`| Any runtime identity| API / worker / scheduler / relay| `SET ROLE melarc_owner`| **Error** — and `melarc_owner` is `NOLOGIN`| `GRANT`|
| `GBT-J14`| `melarc_owner`| —| Log in| **Refused.** `NOLOGIN`| `GRANT`|
| `GBT-J15`| Normal application database credential| API runtime| Perform backup-plane authority| **Denied**| `INFRA`|

## 13. Family K — Migration and deployment authority

Not *tested* by observing that the role names differ. The choreography is executed.

| ID| Setup| Actor| Attempts| Expected| Layer|
|---|---|---|---|---|---|
| `GBT-K1`| Deployment begins| Deployment workload identity| Obtain `melarc_migration_elevated`| **Succeeds**, and the acquisition is infrastructure-audited| `INFRA`|
| `GBT-K2`| Migration running| `melarc_migration_elevated`| Required ownership / schema / RLS operation| **Succeeds** — it is the privileged identity and is treated as one| `GRANT`|
| `GBT-K3`| Migration completes| —| Inspect table ownership| Owned by **`melarc_owner`**, which is **`NOLOGIN`**| `GRANT`|
| `GBT-K4`| Migration completes| —| Elevated credential lifecycle| **Withdrawn, expired or made unusable**| `INFRA`|
| `GBT-K5`| After deployment| API runtime| Use the elevated credential| **Fails**| `INFRA` + `GRANT`|
| `GBT-K6`| After deployment| Worker runtime| Use the elevated credential| **Fails**| `INFRA` + `GRANT`|
| `GBT-K7`| A migration adding a protected table| —| Inspect the migration| `ENABLE` **and** `FORCE ROW LEVEL SECURITY` in the same migration| `GRANT`|

## 14. Family L — Vendor master versus operational history

Vendor X operates in Hub A and Hub B throughout.

| ID| Setup| Actor| Attempts| Expected| Layer|
|---|---|---|---|---|---|
| `GBT-L1`| Hub A authority| Hub A Ops / Senior Ops| Look up the Vendor X **master**| **Permitted** where operationally allowed| `RLS`|
| `GBT-L2`| Hub A authority| Hub A Senior Ops| Read Vendor X **Hub A** operational history| **Permitted**| `RLS`|
| `GBT-L3`| Hub A authority, after loading the master| Hub A Senior Ops| Read Vendor X **Hub B** history| **Denied.** The master lookup grants nothing operational| `RLS`|
| `GBT-L4`| Hub B authority| Hub B Senior Ops| Read Vendor X **Hub A** history| **Denied**| `RLS`|
| `GBT-L5`| Hub A authority| Hub A Senior Ops| Read the canonical cross-Hub `VendorStatement`| **Denied**| `RLS`|
| `GBT-L6`| Global authority| Platform Admin| Read permitted global scope| **Permitted**| `RLS`|
| `GBT-L7`| Existing Finance authority| Finance| Read globally authorised financial / reconciliation data| **Permitted** under the existing Finance authority| `RLS`|
| `GBT-L8`| Existing Finance authority| Finance| Vendor administration or write| **Denied.** Finance authority does not grant Vendor administration or write| `APP`|
| `GBT-L9`| Vendor's own records across hubs| Vendor X| Read them| **Permitted** where an existing Vendor permission allows the read| `RLS`|
| `GBT-L10`| Vendor X records| Vendor Y| Read them| **Denied**| `RLS`|
| `GBT-L11`| Hub A authority only| Hub A Senior Ops| Read the canonical `VendorSuspensionHold` record — grounds, actor, held items, disposition| **Denied.** Requires `vendor.read` at **all-Hub** grant scope| `RLS`|
| `GBT-L12`| Hub A authority only| Hub A Senior Ops| Read a `SecurityRiskHold`| **Denied.** §35.12.8's fourth condition is not platform-visible| `RLS`|
| `GBT-L13`| Hub A authority only| Hub A Senior Ops| Read the canonical `VendorAccountAllowance` control record| **Denied.** Its control key is Platform Admin only (§35.12.3)| `RLS`|
| `GBT-L14`| `vendor.read` held at **all-Hub** scope| Platform Admin| Read all three control records| **Permitted**| `RLS`|
| `GBT-L15`| Hub A authority only| Hub A Ops| Read `VendorOrganization.status` and the allowance **state** to decide whether to book| **Permitted.** §36.12 carries the operational yes/no on records Hub staff already read| `RLS`|
| `GBT-L16`| Hub A authority only, **no** all-Hub `settlement.read`| Hub A Senior Ops| Read the canonical global `VendorStatement`| **Denied.** Hub-filtered operational projections are a different resource| `RLS`|
| `GBT-L17`| Global Vendor master is readable| Hub A Ops| Reach a control record **through** the master lookup| **Denied.** Global identification is not global administration| `RLS`|

## 15. Family M — Evidence owner-aware scope

A `VENDOR_ORGANIZATION` Evidence owner has **no Hub**. These tests prove that the model does not invent one.

| ID| Setup| Actor| Attempts| Expected| Layer|
|---|---|---|---|---|---|
| `GBT-M1`| `owner_type = VENDOR_ORGANIZATION`, Vendor A, `responsible_hub_id` **NULL**| Vendor A| Read| **Permitted** where Evidence read is authorised — **no hub invented**| `RLS`|
| `GBT-M2`| As above| Vendor B| Read| **Denied**| `RLS`|
| `GBT-M3`| As above| Hub A staff with a hub set| Read| **A Staff hub set does not convert a vendor-global object into a hub-global one**| `RLS`|
| `GBT-M4`| Hub-scoped operational owner in Hub A| Hub A staff| Read| **Permitted** per existing authorization| `RLS`|
| `GBT-M5`| Hub-scoped operational owner in Hub A| Hub B-only staff| Read| **Denied**| `RLS`|
| `GBT-M6`| `VENDOR_ORGANIZATION` owner **carrying a hub**| Any writer| Persist| **Rejected as invalid** — not a default to fill in| `CONSTRAINT`|
| `GBT-M7`| Vendor owner id **mismatching** `vendor_organization_id`| Any writer| Persist| **Rejected**| `CONSTRAINT`|
| `GBT-M8`| Hub-scoped owner **with no hub**| Any writer| Persist| **Rejected**| `CONSTRAINT`|
| `GBT-M9`| Either scope field| Any client| Set it on create| **Not accepted.** Both are server-derived| `APP`|

## 16. Family N — Evidence signed object operations

*Private* is tested as **authorization-private**, not as unreachable.

| ID| Setup| Actor| Attempts| Expected| Layer|
|---|---|---|---|---|---|
| `GBT-N1`| A stored object| Anonymous| `GET` it directly| **Denied**| `INFRA`|
| `GBT-N2`| The object store| Anonymous| `PUT` an object| **Denied**| `INFRA`|
| `GBT-N3`| The bucket / container| Anonymous or any| List objects| **Denied**| `INFRA`|
| `GBT-N4`| Any object| —| Obtain a permanent public URL| **None exists**| `INFRA`|
| `GBT-N5`| An authorised upload| Authorised caller| Redeem the signed capability| **Succeeds for exactly one object**| `INFRA`|
| `GBT-N6`| An upload authorization| Holder| Redeem after **15 minutes**| **Denied.** `evidence_upload_authorization_ttl_minutes`| `INFRA`|
| `GBT-N7`| An authorised retrieval| Authorised caller| Redeem the signed capability| **Succeeds for exactly one object**| `INFRA`|
| `GBT-N8`| A retrieval authorization| Holder| Redeem after **5 minutes**| **Denied.** `evidence_retrieval_authorization_ttl_minutes`| `INFRA`|
| `GBT-N9`| A signed authorization for object A| Holder| Alter the key or path to object B| **Signature invalid — denied**| `INFRA`|
| `GBT-N10`| A signed authorization| Holder| Enumerate siblings| **No listing authority**| `INFRA`|
| `GBT-N11`| Evidence not yet `STORED`| Authorised caller| Request a retrieval authorization| **`EVIDENCE_NOT_STORED`**| `APP`|
| `GBT-N12`| Evidence that principal-specific RLS denies| Another principal| Request a retrieval authorization| **Denied** — the authorization is never issued| `RLS` + `APP`|
| `GBT-N13`| An issued authorization| —| Search every log, trace and error report| **The signed URL appears in none of them**| `APP`|
| `GBT-N14`| A completed upload with a spoofed MIME type| Uploader| Complete| **Rejected on the actual file signature**; record stays `PENDING_UPLOAD`, `VALIDATION_FAILED`| `APP`|
| `GBT-N15`| Oversize, checksum mismatch, or malicious content| Uploader| Complete| **Never reaches `STORED`**| `APP`|

## 17. Family O — Settings values

Mechanical assertions against the canonical settings authority.

| ID| Setup| Actor| Attempts| Expected| Layer|
|---|---|---|---|---|---|
| `GBT-O1`| `contracts/settings.md`| —| Extract `evidence_upload_authorization_ttl_minutes`| **15**, exactly once, `CONFIRMED`| `APP`|
| `GBT-O2`| `contracts/settings.md`| —| Extract `evidence_retrieval_authorization_ttl_minutes`| **5**, exactly once, `CONFIRMED`| `APP`|
| `GBT-O3`| `contracts/settings.md`| —| Extract `audit_integrity_checkpoint_interval_minutes`| **15**, exactly once, `CONFIRMED`| `APP`|
| `GBT-O4`| `contracts/settings.md`| —| Look for `evidence_signed_url_ttl_minutes` as a live key| **Absent from §7.1–§7.5 and §7.7.** Retired to §7.6| `APP`|
| `GBT-O5`| `contracts/settings.md` §7.7| —| Extract the rate-limit buckets and compare the runtime limiter against the contract| **Exactly six canonical buckets**, names and **credential keying unchanged** — staff identity · MFA challenge and principal · Vendor account **and** registered device · Rider submitted phone number · recovery principal · active Session. **Launch values read from the contract, never hard-coded in the test**: staff **10** · privileged MFA **10** · vendor **10** · rider challenge **20** · recovery **10** · authenticated API **120**, per minute. **No IP or source-address bucket exists.** The two sub-ceilings — report/export initiation **10/min**, provider-initiating operation **20/min** — are **inside** `rate_limit_authenticated_api` and must not be counted as a seventh or eighth bucket| `APP`|

## 18. Family P — Encryption at rest

Structural assertions that a posture exists for every required class.

| ID| Setup| Actor| Attempts| Expected| Layer|
|---|---|---|---|---|---|
| `GBT-P1`| Architecture| —| Live PostgreSQL primary and storage| **Encryption at rest required**| `INFRA`|
| `GBT-P2`| Architecture| —| **WAL and PITR material**| **Required** — the class most often left outside the guarantee| `INFRA`|
| `GBT-P3`| Architecture| —| Snapshots and database backups| **Required**| `INFRA`|
| `GBT-P4`| Architecture| —| Evidence object storage and **quarantine objects**| **Required**, before validation as well as after| `INFRA`|
| `GBT-P5`| Architecture| —| Object versions and backup-plane copies| **Required**| `INFRA`|
| `GBT-P6`| Architecture| —| Application-level KMS encryption for TOTP| **Still required and not replaced** by storage encryption| `APP`|

## 19. Family Q — OpenAPI topology

Parsed from the contract, because the contract is what generates clients.

| ID| Setup| Actor| Attempts| Expected| Layer|
|---|---|---|---|---|---|
| `GBT-Q1`| `contracts/openapi.yaml`| —| Read the default server| **Relative `/api/v1`**| `APP`|
| `GBT-Q2`| `contracts/openapi.yaml`| —| Check the default is not a dedicated API host| **No `https://api…` default** drives Ops/Vendor cookie calls| `APP`|
| `GBT-Q3`| `contracts/openapi.yaml`| —| Inspect the retained API host entry| Present **and explicitly labelled non-browser**| `APP`|
| `GBT-Q4`| `contracts/openapi.yaml`| —| Cookie declarations| All three remain **host-only**| `APP`|
| `GBT-Q5`| `contracts/openapi.yaml`| —| Browser Session + CSRF schemes| **Unchanged**| `APP`|
| `GBT-Q6`| `contracts/openapi.yaml`| —| Rider Bearer semantics| **Unchanged**| `APP`|
| `GBT-Q7`| `contracts/openapi.yaml`| —| `createEvidenceRetrievalAuthorization`| **Present**| `APP`|
| `GBT-Q8`| `contracts/openapi.yaml`| —| `reassignPickupRequestHub`| **Present**| `APP`|
| `GBT-Q9`| `contracts/openapi.yaml`| —| `Evidence.responsible_hub_id`| **Nullable and not required** — the Vendor-global representation is valid| `APP`|
| `GBT-Q10`| Deployed Ops surface| Browser| Issue an API call| Same-origin `https://ops.<domain>/api/v1/…`| `EDGE`|
| `GBT-Q11`| `contracts/openapi.yaml`| —| Count the **root** `servers` entries| **Exactly one**, and it is relative| `APP`|
| `GBT-Q12`| `contracts/openapi.yaml`| —| Look for a cross-origin host in the **root** list| **Absent.** No operation inherits one| `APP`|
| `GBT-Q13`| `contracts/openapi.yaml`| —| Inspect the Rider native operations| Each declares its **own** `servers`, carrying the dedicated host **and** same-origin first| `APP`|
| `GBT-Q14`| Generated **browser** client| Ops / Vendor| Resolve the server for any cookie-authenticated operation| **Same-origin `/api/v1`**, never `https://api.…`| `APP`|
| `GBT-Q15`| Generated **native** client| Rider Android| Resolve the server for `riderSignIn`| The **dedicated host is available** to it, structurally and not by prose| `APP`|

## 20. Family R — AdHocSender block reach

Two reach levels and exactly two. **Reversal and reactivation are not tested because that behavior has not yet been specified.**

| ID| Setup| Actor| Attempts| Expected| Layer|
|---|---|---|---|---|---|
| `GBT-R1`| Hub A Senior Ops creates a `HUB_LOCAL` block| Hub A Senior Ops| Create| **Succeeds** with mandatory reason and audit| `APP`|
| `GBT-R2`| That block exists| Sender| Book in **Hub A**| **Refused**| `APP`|
| `GBT-R3`| That block exists| Sender| Book in **Hub B**| **Permitted.** A Hub A block does not silently ban elsewhere| `APP`|
| `GBT-R4`| Hub A Senior Ops| Hub A Senior Ops| Create a `PLATFORM_WIDE` block| **Denied**| `APP`|
| `GBT-R5`| Platform Admin| Platform Admin| Create a `PLATFORM_WIDE` block| **Succeeds** — mandatory reason, **enhanced audit**| `APP`|
| `GBT-R6`| That block exists| Sender| Book in any hub| **Refused everywhere**| `APP`|
| `GBT-R7`| A block row| —| Inspect the representation| Explicit `scope` discriminator. **Platform-wide reach is never inferred from a null `hub_id`**| `CONSTRAINT`|
| `GBT-R8`| A block row with `scope` absent| Any writer| Persist| **Rejected as invalid** — a missing value is never maximal| `CONSTRAINT`|

## 21. Family S — Persistent-table classification

The family that replaces a validator's private exception list.

| ID| Setup| Actor| Attempts| Expected| Layer|
|---|---|---|---|---|---|
| `GBT-S1`| `data-scope-registry.md`| —| Every persistent **business** table| **Represented** in §4| `APP`|
| `GBT-S2`| `data-scope-registry.md`| —| Every persistent **technical** table| **Represented** in §6 **and** §4| `APP`|
| `GBT-S3`| `data-scope-registry.md`| —| Every §6 row| Carries source document and section — **no row lacks source authority**| `APP`|
| `GBT-S4`| contract-consistency validation's source| —| Search for a technical-table exception dictionary| **None exists**| `APP`|
| `GBT-S5`| A new technical table added to architecture only| —| Compare the current contract declarations| **Fails** until declared in §6 and §4| `APP`|

## 22. Family T — Audit integrity

Detection, not prevention. **No row here claims tamper-proof.**

| ID| Setup| Actor| Attempts| Expected| Layer|
|---|---|---|---|---|---|
| `GBT-T1`| Existing audit history| Any runtime identity| `UPDATE` or `DELETE` an `AuditEvent`| **Error**| `GRANT`|
| `GBT-T2`| The immutable archive| Any runtime identity| Delete an archived object| **Denied**| `INFRA`|
| `GBT-T3`| A historical event modified out of band| Verifier| Verify against the checkpoint| **Detected** — hash no longer matches the manifest| `APP`|
| `GBT-T4`| A historical event deleted out of band| Verifier| Verify| **Detected** — the manifest names an identifier the store lacks| `APP`|
| `GBT-T5`| A fabricated event inserted into history| Verifier| Verify| **Detected** — the batch hashes to a different manifest| `APP`|
| `GBT-T6`| A checkpoint removed or replaced| Verifier| Verify the chain| **Detected** — the next previous-hash does not resolve| `APP`|
| `GBT-T7`| A checkpoint signature| Verifier| Validate through KMS| **Verifies**; a forged one does not| `INFRA`|
| `GBT-T8`| Checkpoint cadence| —| Measure the interval| **15 minutes** — `audit_integrity_checkpoint_interval_minutes`| `APP`|
| `GBT-T9`| The archive write fails| —| —| **Alert fires**| `INFRA`|
| `GBT-T10`| An enhanced-audit action whose primary audit write cannot commit| Privileged actor| Perform it| **The action does not happen.** Fail closed, and it alerts| `APP`|

## 23. Family U — Secret and telemetry redaction

**Every row runs twice — once on a successful request and once on a failing one** — and *Attempts* always means the same act: **search every sink** (application, worker and reverse-proxy logs, traces and APM spans, exception reports).

| ID| Setup| Actor| Attempts| Expected| Layer|
|---|---|---|---|---|---|
| `GBT-U1`| Staff sign-in, both outcomes| Telemetry auditor| Search every sink| **No `Authorization`, `Cookie` or `Set-Cookie` value**| `APP`|
| `GBT-U2`| Any unsafe browser request, accepted and rejected| Telemetry auditor| Search every sink| **No `X-CSRF-Token`, no `melarc_csrf` value**| `APP`|
| `GBT-U3`| Credential setup and sign-in, both outcomes| Telemetry auditor| Search every sink| **No password, no PIN**| `APP`|
| `GBT-U4`| MFA enrolment and challenge, both outcomes| Telemetry auditor| Search every sink| **No TOTP value and no seed**| `APP`|
| `GBT-U5`| Setup and recovery flows, both outcomes| Telemetry auditor| Search every sink| **No `SetupGrant` or `RecoveryRequest` token**| `APP`|
| `GBT-U6`| Vendor sign-in, both outcomes| Telemetry auditor| Search every sink| **No `melarc_vendor_device` value**| `APP`|
| `GBT-U7`| Any authenticated request, both outcomes| Telemetry auditor| Search every sink| **No Session credential**| `APP`|
| `GBT-U8`| An authorised Evidence retrieval| Telemetry auditor| Search every sink| **No signed Evidence URL** — a bearer capability, so a logged one is an access grant| `APP`|
| `GBT-U9`| A provider call, success and timeout| Telemetry auditor| Search every sink| **No provider secret**| `APP`|
| `GBT-U10`| Rider sign-in, both outcomes| Telemetry auditor| Search every sink| **No rider private key material**| `APP`|

## 24. Family V — Backup, restore and key custody

| ID| Setup| Actor| Attempts| Expected| Layer|
|---|---|---|---|---|---|
| `GBT-V1`| Production backup plane| Application database credential| Enumerate or read snapshots / WAL archive| **Denied**| `INFRA`|
| `GBT-V2`| Production backup plane| Application or worker identity| Delete a snapshot or archived object| **Denied**| `INFRA`|
| `GBT-V3`| Production database| Any human| Connect with a standing shared credential| **No such credential exists**| `INFRA`|
| `GBT-V4`| Emergency access is used| Named human| Any action| **Attributable, MFA-proved, time-bounded, reason-bound, infrastructure-audited**| `INFRA`|
| `GBT-V5`| Pre-launch restore drill| Operator| Run the full sequence into an **isolated** environment| **Every step verifies and both numbers are produced**: **measured RPO ≤24h** against the latest verified recoverable point · **measured RTO ≤4h** using the clock defined in `architecture/OBSERVABILITY_AND_RECOVERY.md` §4.4b · PostgreSQL recovery integrity · required **Evidence/object recovery** · **KMS access** · **audit-integrity verification** · **provider/payment records inside the loss window identified and placed into safe reconciliation or hold handling**. Live-credential isolation is proved by `GBT-V6` and KMS-bound TOTP by `GBT-V7`; this row does not repeat them. **A drill that completes without both numbers is a FAIL**| `INFRA`|
| `GBT-V6`| Restored isolated environment| —| Attempt an SMS send or payment call| **Cannot reach a live provider credential**| `INFRA`|
| `GBT-V7`| Restored environment| —| Decrypt a representative TOTP seed| **Succeeds only with restored KMS access**| `INFRA`|
| `GBT-V8`| KMS unavailable| Application| Start up| **Fails to start.** No degraded mode| `APP`|
| `GBT-V9`| KMS unavailable at runtime| Privileged user| Sign in with TOTP| **Fails closed.** No fallback that skips the second factor| `APP`|
| `GBT-V10`| Pepper rotated to a new version| Existing user| Sign in with an existing password| **Succeeds** under the recorded `pepper_version`, and may rehash| `APP`|

## 25. Family W — Browser origin, cookies and CSRF

| ID| Setup| Actor| Attempts| Expected| Layer|
|---|---|---|---|---|---|
| `GBT-W1`| A valid Ops Portal session cookie| Holder| Authenticate to the Vendor PWA surface| **Rejected.** Host-only cookies, separate origins| `EDGE` + `APP`|
| `GBT-W2`| A valid Vendor PWA session cookie| Holder| Authenticate to the Ops Portal surface| **Rejected**| `EDGE` + `APP`|
| `GBT-W3`| A cookie issued by `ops.<domain>`| Browser| Send it to `vendor.<domain>`| **Not sent.** No `Domain` attribute is set| `EDGE`|
| `GBT-W4`| CORS configuration| Any origin| Obtain a credentialed wildcard response| **Impossible.** Strict allowed-origin list| `EDGE`|
| `GBT-W5`| An unexpected `Origin` header| Attacker| Any browser-sensitive request| **Rejected, including on pre-session endpoints**| `EDGE` + `APP`|
| `GBT-W6`| A cookie-authenticated unsafe request with no CSRF token| Attacker| Submit| **`CSRF_VALIDATION_FAILED`**| `APP`|
| `GBT-W7`| A Rider Bearer request| Rider| Submit without a CSRF token| **Succeeds.** Bearer credentials are not attached automatically| `APP`|
| `GBT-W8`| Every API response, authentication and recovery included| —| Inspect cache headers| **`Cache-Control: no-store`**, sent by the API itself as a platform rule| `EDGE` + `APP`|
| `GBT-W9`| Any browser surface response| —| Inspect security headers| CSP · `frame-ancestors 'none'` · `nosniff` · restrictive Referrer Policy · HSTS| `EDGE`|
| `GBT-W10`| A safe read operation| Any| Submit with a CSRF token| **Not required**| `APP`|

## 26. Family X — Evidence object storage topology

**The family that could not exist while the deployment forbade the endpoint.** *Private* is tested as **authorization-private**, and reachability is tested as a separate property.

| ID| Setup| Actor| Attempts| Expected| Layer|
|---|---|---|---|---|---|
| `GBT-X1`| Evidence object store, no capability held| Anonymous| `GET` an object directly| **Denied**| `INFRA`|
| `GBT-X2`| As above| Anonymous| `PUT` an object| **Denied**| `INFRA`|
| `GBT-X3`| As above| Anonymous| List the bucket or browse the container| **Denied**| `INFRA`|
| `GBT-X4`| Any object| —| Obtain a permanent public URL| **None exists**| `INFRA`|
| `GBT-X5`| A valid short-lived single-object **upload** capability| Authorised caller| Redeem it against the **Internet-reachable** object endpoint| **Succeeds** — the endpoint is reachable and the capability is what authorises| `INFRA`|
| `GBT-X6`| A valid short-lived single-object **retrieval** capability| Authorised caller| Redeem it against the same endpoint| **Succeeds for exactly one object**| `INFRA`|
| `GBT-X7`| A valid capability for object A| Holder| Alter the key or path to object B| **Signature invalid — denied**| `INFRA`|
| `GBT-X8`| A valid capability| Holder| Use it to enumerate siblings| **No listing authority**| `INFRA`|
| `GBT-X9`| An object uploaded, validation not yet passed| Any reader| Retrieve it| **Denied — quarantine/private until completion validation**| `INFRA` + `APP`|
| `GBT-X10`| Deployment configuration| —| Read the public-entry-point statement| **Names the object-service endpoint** as the narrow exception, and the bucket as closed| `INFRA`|

**`GBT-X5` proves the required distinction between reachability and authorization.** The object-service endpoint must be reachable by a holder of a valid signed capability while the bucket remains non-public. **Reachability and access are different properties**, and the matrix asserts both.

## 27. Family Y — Worker task capability

**`unrelated to its task class` is only testable once a capability names its tables.**

| ID| Setup| Actor| Attempts| Expected| Layer|
|---|---|---|---|---|---|
| `GBT-Y1`| Worker running under `melarc_worker_cap_notification`| Worker| Read `VendorStatement`| **Denied** — outside the capability| `GRANT`|
| `GBT-Y2`| Worker running under `melarc_worker_cap_settlement`| Worker| Read `PickupManifest`| **Denied**| `GRANT`|
| `GBT-Y3`| Worker running under `melarc_worker_cap_evidence_validation`| Worker| Write `Order`| **Denied**| `GRANT`|
| `GBT-Y4`| Worker running under `melarc_worker_cap_audit_integrity`| Worker| `UPDATE` or `DELETE` an `AuditEvent`| **Denied — `INSERT` only on the checkpoint**| `GRANT`|
| `GBT-Y5`| **Base `melarc_worker_runtime` alone**, no capability granted| Worker| Read any protected business table| **Denied — the base identity holds no such grant**| `GRANT`|
| `GBT-Y6`| Base identity alone| Worker| Read `Setting`, `HubSetting`, `ReasonCode`| **Permitted** — configuration is not a business grant| `GRANT`|
| `GBT-Y7`| Base identity alone| Worker| Read one `Outbox` row by `outbox_id`| **Permitted** — the bootstrap capability| `GRANT`|
| `GBT-Y8`| A capability grant set| —| Inspect it against the Registry row| Every table the Registry names for that capability is granted, **and no other**| `GRANT`|
| `GBT-Y9`| Any worker| Worker| Acquire a second capability at runtime| **Denied** — capabilities are granted to the process, not requested by it| `GRANT`|

**`GBT-Y5` proves that the base worker identity alone has no protected-business-table authority.** Task capabilities add only the grants required for their task class.

## 28. Family Z — Technical-table discovery and cross-document consistency

**Structural tests over the record itself.** These are the failure modes the independent audit demonstrated, and they are here because no behavioural test would have caught any of them.

| ID| Setup| Actor| Attempts| Expected| Layer|
|---|---|---|---|---|---|
| `GBT-Z1`| A technical table declared in architecture only, absent from the Registry| Validator| Compare the current contract declarations| **Fails** — three-way reconciliation is exact| `APP`|
| `GBT-Z2`| A technical table in the Registry inventory, declared in no architecture source| Validator| Compare the current contract declarations| **Fails**| `APP`|
| `GBT-Z3`| Registry inventory and §4 classifications disagree| Validator| Compare the current contract declarations| **Fails**| `APP`|
| `GBT-Z4`| Current normative text calls Evidence retrieval unwritten| Validator| Compare the current contract declarations| **Fails**| `APP`|
| `GBT-Z5`| Current normative text calls a signed-URL lifetime unresolved| Validator| Compare the current contract declarations| **Fails**| `APP`|
| `GBT-Z6`| Current normative text describes the checkpoint interval as unresolved even though the canonical setting is defined| Validator| Compare the current contract declarations| **Fails**| `APP`|
| `GBT-Z7`| The settings authority is read| Validator| Extract the three timings| **15 · 5 · 15**, `CONFIRMED`, once each| `APP`|
| `GBT-Z8`| Any normative section defines idempotency as `Idempotency-Key` + route + payload hash| Validator| Compare the current contract declarations| **Fails**| `APP`|
| `GBT-Z9`| Any worker sequence establishes scope before reading the trusted `Outbox`| Validator| Compare the current contract declarations| **Fails**| `APP`|
| `GBT-Z10`| A deployment rule forbids object-storage ingress while signed authorization exists| Validator| Compare the current contract declarations| **Fails**| `APP`|
| `GBT-Z14`| `createEvidenceRetrievalAuthorization` declares `EVIDENCE_NOT_STORED`| Validator| Read the canonical condition| **Covers a single targeted record**, not only an `evidence_ids` collection| `APP`|
| `GBT-Z15`| `domain-model.md` §4's `Evidence` row| Reader| Ask whether a Hub is always required| **No** — conditional, and null for a `VENDOR_ORGANIZATION` owner| `APP`|
| `GBT-Z16`| The `Idempotency-Key` parameter description| Validator| Compare against the operations that declare it| **Covers every declaring operation**, including the non-Rider `reassignPickupRequestHub`| `APP`|

## 29. Family SB — Sender-block reach and disclosure

**Enforcement is not disclosure**, and the two are tested separately.

| ID| Setup| Actor| Attempts| Expected| Layer|
|---|---|---|---|---|---|
| `GBT-SB1`| Hub A Senior Ops creates a `HUB_LOCAL` block| Hub A Senior Ops| Create| **Succeeds** — reason mandatory, audited| `APP`|
| `GBT-SB2`| That block exists| Sender| Book in **Hub A**| **Refused**| `APP`|
| `GBT-SB3`| That block exists| Sender| Book in **Hub B**| **Permitted** — a local block binds one hub| `APP`|
| `GBT-SB4`| That block exists| Hub A Senior Ops| Read the block record, grounds and reason| **Permitted** — authorised for that hub| `RLS`|
| `GBT-SB5`| That block exists| **Unrelated Hub B Staff**| Read the block record, grounds or reason| **Denied** — a local operational judgement is not platform information| `RLS`|
| `GBT-SB6`| That block exists| Hub B booking flow| Determine whether a **platform-wide** block applies| **Answerable without reading Hub A's record**| `RLS` + `APP`|
| `GBT-SB7`| Hub A Senior Ops| Hub A Senior Ops| Create a `PLATFORM_WIDE` block| **Denied**| `APP`|
| `GBT-SB8`| Platform Admin| Platform Admin| Create a `PLATFORM_WIDE` block| **Succeeds** — mandatory reason, **enhanced audit**| `APP`|
| `GBT-SB9`| A platform-wide block exists| Sender| Book in any hub| **Refused everywhere**| `APP`|
| `GBT-SB10`| A platform-wide block exists| Any authenticated Staff| Read it| **Permitted** — it binds every hub| `RLS`|
| `GBT-SB11`| A block row with `scope` absent| Any writer| Persist| **Rejected** — reach is never inferred from a null `hub_id`| `CONSTRAINT`|

**`GBT-SB5` proves that local sender-block grounds are not platform-visible.** **`GBT-SB6` proves enforcement does not require that disclosure**: a booking flow can determine whether a platform-wide block applies without reading an unrelated Hub's local block record.

## 30. Family GS — Operation-bound grant scope

**This family tests operation-bound grant scope.** Every test holds the Session constant and varies only *which grant authorized the operation*.

Throughout: a Staff Session holds **Grant A** — a permission with **`ALL`** Hub scope — and **Grant B** — a different permission scoped to **Hub A only**. Hub B is reachable under Grant A and not under Grant B.

| ID| Setup| Actor| Attempts| Expected| Layer|
|---|---|---|---|---|---|
| `GBT-GS1`| Session holds all-Hub Grant A **and** Hub-A-limited Grant B| Senior Ops| Invoke the operation requiring **Grant B** against a **Hub B** resource| **Denied.** The unrelated all-Hub grant does not broaden this operation| `RLS`|
| `GBT-GS2`| The same Session| Senior Ops| Invoke the **Grant B** operation against a **Hub A** resource| **Permitted**| `RLS`|
| `GBT-GS3`| The same Session| Senior Ops| Invoke the operation requiring **Grant A** against a **Hub B** resource| **Permitted** — that grant does carry all-Hub authority| `RLS`|
| `GBT-GS4`| Session holds **no** grant authorizing the operation| Ops Staff| Invoke it| **Denied**, `PERMISSION_DENIED`. Never a widened scope| `APP`|
| `GBT-GS5`| Grant B scoped to Hub A; Session's authorized membership is **Hub C only**| Ops Staff| Invoke the Grant B operation| **Zero rows.** The intersection is empty, and empty never means all| `RLS`|
| `GBT-GS6`| Grant B scoped to Hubs A **and** B; Session authorized for **Hub A only**| Ops Staff| Read a Hub B row| **Denied.** The effective set is the **intersection**, never the union| `RLS`|
| `GBT-GS7`| Session context inspected mid-transaction| —| Read `melarc.authorization_key`| **Present, and equal to the operation's declared `x-permission`**| `APP`|
| `GBT-GS8`| Session context inspected mid-transaction| —| Read `melarc.hub_scope_mode` while exercising Grant B| **`SET`**, not `ALL`, though Grant A is in the same Session| `APP`|
| `GBT-GS9`| Exercising Hub-A-limited Grant B| Senior Ops| **Write** a row whose authoritative hub is Hub B| **Denied by `WITH CHECK`** against the same operation-resolved scope| `RLS`|
| `GBT-GS10`| Session holds all-Hub `report.read` and `pickup.request.reassign_hub` for Hub A only| Senior Ops| `reassignPickupRequestHub` from Hub A to Hub B| **Denied.** The grant authorizing reassignment must cover **both the source and target hubs**; an unrelated reporting grant supplies neither| `RLS` + `APP`|
| `GBT-GS11`| Session holds an all-Hub **global-resource** permission and a Hub-limited operational one| Senior Ops| Invoke the global-resource operation| **Permitted**, against the registry's global / ownership predicate. **No Hub requirement is fabricated** for a resource that has none| `RLS`|
| `GBT-GS12`| Session holds an all-Hub global permission| Senior Ops| Use it to reach a **Hub-scoped operational** row in an unauthorized hub| **Denied.** A global grant reaches global resources, not Hub-scoped ones| `RLS`|

**`GBT-GS1` is the core behavior of this family:** an unrelated all-Hub grant must not broaden an operation authorized by a Hub-limited grant. **`GBT-GS7` and `GBT-GS8` are the structural pair**: they read the operation-resolved context itself rather than only its consequences, so application filtering alone cannot make the suite pass.

## 31. Coverage

| Family| Tests| Focus|
|---|---|---|
| A — Pooled connections| 5| Transaction-local security context on reused connections|
| B — Staff principal| 11| Staff Hub scope and fail-closed principal context|
| C — Vendor principal| 10| Vendor ownership scope independent of Staff Hub scope|
| D — Rider assignment| 11| Rider assignment scope|
| E — SYSTEM principal| 4| Trusted task capability for SYSTEM work|
| F — Writes and scope mutation| 6| `WITH CHECK`, constraints and forbidden scope mutation|
| G — PickupRequest hub reassignment| 11| Controlled Hub reassignment and stale-scope revocation|
| H — Trusted Outbox envelope| 11| Server-derived task scope and worker envelope verification|
| I — Idempotency| 8| Principal- and operation-bound replay isolation|
| J — Technical identities| 15| Least-privilege runtime database identities|
| K — Migration and deployment authority| 7| Privileged migration lifecycle and ownership|
| L — Vendor master versus operational history| 17| Global Vendor identity versus scoped operational history|
| M — Evidence owner-aware scope| 9| Evidence ownership and conditional Hub scope|
| N — Evidence signed object operations| 15| Signed single-object upload/retrieval capabilities|
| O — Settings values| 5| Canonical security-sensitive settings|
| P — Encryption at rest| 6| Required encrypted storage classes|
| Q — OpenAPI topology| 15| Server topology, cookies and generated-client routing|
| R — AdHocSender block reach| 8| Sender-block scope and enforcement|
| S — Persistent-table classification| 5| Complete business/technical table classification|
| T — Audit integrity| 10| Tamper-evident audit verification|
| U — Secret and telemetry redaction| 10| Secret exclusion from logs, traces and error sinks|
| V — Backup, restore and key custody| 10| Restore proof, recovery isolation and KMS availability|
| W — Browser origin, cookies and CSRF| 10| Browser-origin separation, cookies, CORS and CSRF|
| X — Evidence object storage topology| 10| Object-store reachability versus authorization|
| Y — Worker task capability| 9| Task-scoped worker grants|
| Z — Technical-table discovery and cross-document consistency| 13| Retained-specification and contract consistency|
| SB — Sender-block reach and disclosure| 11| Sender-block reach versus disclosure|
| GS — Operation-bound grant scope| 12| Operation-resolved permission and Hub scope|
| **Total**| **274**||

### 31.1 What this matrix does not cover, stated rather than implied

- **Rate-limit behavior is testable** against the six canonical buckets, keying rules and launch values defined in `contracts/settings.md` §7.7.
- **Evidence retrieval tests in Family N are executable** because `createEvidenceRetrievalAuthorization` exists. **Storage-service binding, retention and deletion remain unresolved implementation dependencies** and must not be treated as settled behavior.
- **Family K's migration choreography is a procedure, not an automated test**, and its evidence is a recorded deployment runbook result.
- **No test asserts tamper _prevention_.** Family T proves detection. The mechanism is **tamper-evident**, and nothing here claims more than the storage and KMS provide.
- **Reversal and reactivation of a sender block are not tested because that behavior has not yet been specified.**
- **Alert thresholds, load volumes and performance percentiles are read from their retained owning specifications.** Tests must not hard-code historical audit values when the canonical architecture or settings source provides the current requirement.

### 31.2 Implementation status

These rows specify security tests to implement at the named layer. They do not claim tests already exist or have passed. Rows describing cross-document consistency require a targeted comparison of the relevant declarations; they do not depend on a removed historical validator. Resolve any real conflict with the owning product contract before implementing its test.

### 31.3 STRIDE and OWASP Top 10 traceability

**Family-level, not per-test.** [SECURITY_DESIGN.md](../architecture/SECURITY_DESIGN.md) §15.1 and §15.6 map STRIDE and OWASP Top 10 (2021) at the **category** level, not per control — this table matches that granularity rather than inventing a finer one for 274 individual rows, which would assert a precision neither source claims.

| Family| Primary STRIDE| OWASP Top 10| Why|
|---|---|---|---|
| A — Pooled connections| Elevation of Privilege, Information Disclosure| A01| A later request on a reused connection inherits an earlier actor's authority|
| B — Staff principal| Elevation of Privilege| A01| Hub-scope bypass, bundle-name inference, client-asserted scope|
| C — Vendor principal| Information Disclosure, Elevation of Privilege| A01| Cross-vendor row access, forged Hub scope on a principal that has none|
| D — Rider assignment| Information Disclosure, Elevation of Privilege| A01| Cross-rider access where hub equality alone must not pass the test|
| E — SYSTEM principal| Spoofing, Elevation of Privilege| A01, A04| A worker asserting fabricated all-Hub authority or exceeding its task capability|
| F — Writes and scope mutation| Tampering, Elevation of Privilege| A01, A08| `WITH CHECK` and constraint enforcement against a row rewritten into a different scope|
| G — PickupRequest hub reassignment| Elevation of Privilege, Repudiation| A01| The one explicitly permitted scope mutation, tested against becoming a general edit; `GBT-G11` is the audit-trail half|
| H — Trusted Outbox envelope| Spoofing, Tampering| A08| A forged or rewritten broker message must not create authority — the exact pattern `SECURITY_DESIGN.md` §15.6's A08 row already names|
| I — Idempotency| Information Disclosure, Tampering| A01, A04| A collision must never return one caller's stored result to another|
| J — Technical identities| Elevation of Privilege| A01, A05| Database role escalation attempts — `SET ROLE`, self-`GRANT`, ownership transfer|
| K — Migration and deployment authority| Elevation of Privilege| A01, A05| An elevated migration credential that outlives the migration|
| L — Vendor master versus operational history| Information Disclosure| A01| Global identification must not become cross-hub operational visibility|
| M — Evidence owner-aware scope| Information Disclosure, Elevation of Privilege| A01| A vendor-global object (no hub) must not be reached by inventing one|
| N — Evidence signed object operations| Information Disclosure, Tampering| A01| Signed-capability scope, TTL and single-object binding|
| O — Settings values| *Not STRIDE-mapped*| —| Configuration-consistency assurance against the contract, not a runtime attack surface|
| P — Encryption at rest| Information Disclosure| A02| Every required class — primary, WAL/PITR, backups, evidence and quarantine objects|
| Q — OpenAPI topology| Spoofing, Tampering| A05| Cross-origin host resolution, cookie scoping, server-list integrity|
| R — AdHocSender block reach| Elevation of Privilege, Tampering| A01| Reach-level bypass and a `scope` discriminator that must never default to maximal|
| S — Persistent-table classification| *Not STRIDE-mapped*| —| Documentation-completeness assurance — ensures no technical table escapes classification, not itself an attack surface|
| T — Audit integrity| Repudiation, Tampering| A09| Detection of modified, deleted or fabricated audit history — matches `SECURITY_DESIGN.md` §15.6's A09 row exactly|
| U — Secret and telemetry redaction| Information Disclosure| A02, A09| Every sink searched for credentials, tokens and secrets on both a success and a failure path|
| V — Backup, restore and key custody| Information Disclosure, Denial of Service| A02, A05| Standing credentials, live-provider isolation in a restored environment, and the measured RPO/RTO drill|
| W — Browser origin, cookies and CSRF| Spoofing, Tampering| A01, A05| Cross-surface cookie leakage, CORS, CSRF, security headers|
| X — Evidence object storage topology| Information Disclosure| A01, A05| Reachability and access are tested as separate properties over the one permitted public entry point|
| Y — Worker task capability| Elevation of Privilege| A01| A worker reaching a table outside its granted task class|
| Z — Technical-table discovery and cross-document consistency| *Not STRIDE-mapped*| —| Structural checks over the record itself — the failure modes an independent audit found, not a runtime attack surface|
| SB — Sender-block reach and disclosure| Elevation of Privilege, Information Disclosure| A01| Reach bypass, and `GBT-SB5`'s finding that enforcement had been leaking disclosure of an unrelated hub's grounds|
| GS — Operation-bound grant scope| Elevation of Privilege| A01| An unrelated all-Hub grant in the same Session must not widen a Hub-limited operation|

**Three families carry no STRIDE category by design.** `O`, `S` and `Z` validate consistency between retained specifications, configuration and canonical contracts. These are documentation/configuration defect classes rather than runtime attacker capabilities, so assigning a STRIDE category would be misleading.

Three obsolete current-state bookkeeping tests were removed because they did not test runtime or retained-specification behavior. The remaining security matrix contains **274 tests** and keeps the same family-level STRIDE/OWASP mapping granularity as `SECURITY_DESIGN.md` §15.1/§15.6.

## 32. Related

- [SECURITY_DESIGN.md](../architecture/SECURITY_DESIGN.md) §14 — the design these tests verify
- [data-scope-registry.md](../contracts/data-scope-registry.md) — the per-principal predicate for every table
- [engineering-standards.md](engineering-standards.md) §3.1, §4 — the five-surface obligation and the mechanical checks
