# Data Scope Registry

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.18 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** the **principal-specific** security classification of every persistent table — which predicate each principal type is evaluated against, and which technical identity may read or write
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../PROJECT_MASTER_SPECIFICATION.md) §37.3, §37.6, §34.1, §34.9, §35.1.3
> **Created by:** `MSC-DEC-277`. **Refactored to v2 by `MSC-DEC-286`**, with the technical-table inventory required by `MSC-DEC-294`. **R1.1 corrections under the same decisions** — `MSC-DEC-289` worker capability, `MSC-DEC-296` block reach
> **Derives from:** [domain-model.md](domain-model.md) §4, which stays the product-level statement of the two scoping axes. **This document may never contradict it**

## 1. What this document is for, and what v1 got wrong

`MSC-DEC-277` created it so that **an unclassified persistent table is impossible to miss.** That purpose is unchanged.

**What changed at R1 is the shape of the answer.** v0.1 gave each table a single RLS family — `HUB`, `VENDOR`, `RIDER`, `AUDIT` or `NONE` — and left a reader to compose them. The composition it implied was: *apply Hub scope, then restrict further for Vendor and Rider.* **That is the wrong model, and on one table it is wrong in the direction that denies legitimate access.**

**`Order` is the clearest case.** A vendor's order sits in whichever hub is fulfilling it. Under the layered model a Vendor principal would have been evaluated against a Hub predicate first — and a Vendor holds no `authorized_hub_ids` at all, so the honest outcomes were *see nothing* or *quietly treat an empty Hub set as permissive*. **The second is the failure `MSC-DEC-275` spent a whole decision preventing.** The vendor's boundary was never the hub; it was always `vendor_organization_id`.

**So access is evaluated by principal type, not composed across principals**:

| Principal| Boundary|
|---|---|
| `STAFF`| Table-specific Staff predicate, Hub `SET` or explicit `ALL` where the table is Hub-operational, global-master lookup only where explicitly allowed|
| `VENDOR`| `vendor_organization_id` = current Vendor. **Never inherits Staff Hub scope**|
| `RIDER`| Assignment or custody relationship to the current Rider. **Never inherits Staff Hub scope**|
| `SYSTEM`| Explicit task capability, or trusted `Outbox`-derived authority where a business object is involved|
| anything else, missing or malformed| **`DENY`**|

**`DENY` is written, never implied.** An empty cell in v0.1 could mean *denied*, *not yet considered*, or *inherits something*. All three read identically, and only one of them is a control.

## 2. Scope classes still describe the table. They no longer describe the access rule

The six classes remain, because they answer a real question — *what is this table's authoritative boundary* — and they carry the naming the rest of the programme cites:

`PLATFORM` · `HUB` · `VENDOR` · `RIDER_ASSIGNMENT` · `AUDIT` · `SYSTEM`

**But a class is not an access rule.** `Order` is class `HUB` and Vendor-owned to a Vendor. `PickupManifest` is class `HUB`, assignment-scoped to a Rider, and unavailable to a Vendor at all. `VendorStatement` is class `VENDOR` and Vendor-global, while Hub staff get Hub-filtered operational projections instead. `Evidence` is class `HUB` and carries **either** a Hub boundary **or** a Vendor-global one depending on its owner.

**`SYSTEM` is not a parking space**. A table whose scope is genuinely ambiguous is a finding in §8, not a `SYSTEM` row.

## 3. How to read the predicate columns

| Value| Meaning|
|---|---|
| **`DENY`**| This principal type has **no branch**. The `CASE` arm returns false|
| `hub&isin;SET/ALL`| Row's authoritative Hub is in `authorized_hub_ids`, **or** the Session explicitly grants all-Hub authority|
| `global`| Any authenticated Staff principal, subject to the operation's own permission key. Used for platform master data|
| `global *(master)*`| Identity lookup only. **Does not carry operational history**|
| `all-Hub <key>`| The named key **held with all-Hub grant scope**. A Hub-limited grant of the same key does not reach the row. Used for the global Vendor **control** records C1 separated from the master|
| `own`| `vendor_organization_id` = `melarc.current_vendor_organization_id()`. **Hub-independent**|
| `self`| The row's own principal — a Session, a factor, a device, an identity|
| `admin key`| Staff write gated by the existing administration permission for that domain|
| `task cap`| An explicit SYSTEM task capability, granted per task class|
| `task cap *(authentication)*`| **The pre-authentication read path.** Sign-in, MFA proof, device proof and grant redemption all read these tables **before any principal exists**, so no `self` or hub predicate can serve them. It is a narrow SYSTEM capability bound to the authentication task, and it is written explicitly because the alternative — leaving the row `DENY` for every principal — describes a table nothing can reach and a product that cannot authenticate|
| `outbox scope`| SYSTEM authority derived from the immutable `Outbox` envelope|
| `api` `worker` `relay` `sched` `migration`| Technical identities of §5 — `melarc_api_runtime`, `melarc_worker_runtime`, `melarc_outbox_relay_runtime`, `melarc_scheduler_runtime`, `melarc_migration_elevated`|
| `worker:<task>`| A **worker task capability** — `melarc_worker_cap_<task>` (§5.1). **Bare `worker` on a protected business table is a defect**, because the base runtime holds no such grant: it is the capability that reaches the table, and the consistency test must reject the mismatch if the base identity acquires one|

**A predicate here is a security boundary, never a permission.** Holding `pickup.request.create` is a separate gate that runs first; this document says which **rows** the holder may then reach.

**The `Staff authority` column says which gate that is** (`MSC-DEC-299`, C1). `operation key` means the row needs nothing beyond the calling operation's own `x-permission`, because its predicate is already bounded by hub, self or ownership. A **named** key means the read is not bounded that way and the key is what bounds it. **Every named key already exists in [permissions.md](permissions.md) §7** — the column reports the catalogue, it does not extend it.

**`hub&isin;SET/ALL` is resolved per operation, not per Session**. `SET` is the **intersection** of the authorizing grant's hub scope with the Session's authorized membership; `ALL` requires **that grant** to carry explicit all-Hub authority. An unrelated all-Hub grant held for some other operation does not widen this one, and an empty intersection returns no rows rather than all of them. See [SECURITY_DESIGN.md](../architecture/SECURITY_DESIGN.md) §14.1a.

---

## 4. The registry

### 4.1 `PLATFORM` — 16 tables
| Table| Hub source| Vendor source| Rider source| Staff SELECT| Staff WRITE| **Staff authority**| Vendor SELECT| Vendor WRITE| Rider SELECT| Rider WRITE| SYSTEM| All-Hub| Immutable| Controlled exception| Read identity| Write identity| Notes|
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `Hub`| &mdash; *(is the Hub)*| &mdash;| &mdash;| global| admin key| operation key *(platform reference)*| **DENY**| **DENY**| **DENY**| **DENY**| task cap| n/a| yes| &mdash;| `api`| `api`| The Hub registry. Readable platform-wide; Hub-scoped configuration is `HubSetting`|
| `Setting`| &mdash;| &mdash;| &mdash;| global| admin key| `settings.read`| **DENY**| **DENY**| **DENY**| **DENY**| task cap| n/a| yes| &mdash;| `api` `worker`| `api`| Platform-scoped settings. Hub-scoped values are `HubSetting`|
| `ReasonCode`| &mdash;| &mdash;| &mdash;| global| admin key| operation key *(platform reference)*| **DENY**| **DENY**| **DENY**| **DENY**| task cap| n/a| yes| &mdash;| `api` `worker`| `api`| Reason **labels** reach Vendor and Rider clients inside operation responses composed under Staff/SYSTEM context, never by direct table read — which is why both say `DENY` rather than `global`|
| `Permission`| &mdash;| &mdash;| &mdash;| global| admin key| `permission.read` **P only**| **DENY**| **DENY**| **DENY**| **DENY**| task cap *(authentication)*| n/a| yes| &mdash;| `api`| `api`| The closed key catalogue|
| `RoleBundle`| &mdash;| &mdash;| &mdash;| global| admin key| `permission.read` **P only** for the table; **`permission.assignable_bundle.read`** for the assignable-bundles projection| **DENY**| **DENY**| **DENY**| **DENY**| task cap *(authentication)*| n/a| yes| &mdash;| `api`| `api`| §11.1 editable bundles. **Never held by a technical identity**. **`listAssignableStaffRoleBundles` returns each assignable staff bundle's `id`, `name` and approval flag to any `permission.assignable_bundle.read` holder** (`MSC-DEC-439`; the gate is `MSC-DEC-443`'s): the `api` identity computes the projection, it returns no permission and no holder, and the key is not hub-scoped for it — a bundle is configuration (`SECURITY_DESIGN.md` §14.1a)|
| `CourierProvider`| &mdash;| &mdash;| &mdash;| global| admin key| `courier.read`| **DENY**| **DENY**| **DENY**| **DENY**| task cap| n/a| yes| &mdash;| `api` `worker`| `api`| §24.7 courier registry, platform-wide. **Written by `courier.registry.manage` at all hubs**. **`ACTIVE` entries reach a Rider inside `listCourierProviders`**, composed under Staff/SYSTEM context and never by direct table read — `ReasonCode`'s pattern, which is why the Rider column still says `DENY`|
| `VendorOrganization`| **&mdash; never**| self (`id`)| &mdash;| global *(master)*| admin key| `vendor.read` *(master identity)*| self| **DENY**| **DENY**| **DENY**| task cap| n/a| yes| &mdash;| `api` `worker:settlement` `worker:notification`| `api`| **Moved from `VENDOR` at R1**. The **master identity** is globally identifiable so authorised Ops can look a vendor up. **That lookup is not a grant to global operational history** — history stays Hub-bounded on the operational tables below|
| `AdHocSender`| &mdash;| &mdash;| &mdash;| global| admin key| `vendor.read`| **DENY**| **DENY**| **DENY**| **DENY**| task cap| n/a| yes| &mdash;| `api`| `api`| Phone identity is globally unique — §30 forbids collision with a Rider — which is what makes the record platform-scoped. **Block reach is `AdHocSenderBlock`**|
| `AdHocSenderBlock`| `hub_id` where `scope = HUB_LOCAL`| &mdash;| &mdash;| `HUB_LOCAL`: hub&isin;SET/ALL &middot; `PLATFORM_WIDE`: global| `HUB_LOCAL`: hub&isin;SET/ALL &middot; `PLATFORM_WIDE`: **P only**| `vendor.read`; write `vendor.sender_block.create` &mdash; **S: `HUB_LOCAL`, own hub · P: `PLATFORM_WIDE`**| **DENY**| **DENY**| **DENY**| **DENY**| task cap| yes *(write)*| yes| &mdash;| `api`| `api`| **Read follows reach** (R1.1). A `HUB_LOCAL` block record is visible only to Staff authorised for **that** hub, or to explicit all-Hub authority; a `PLATFORM_WIDE` block is visible to any authenticated Staff because it binds every hub. **R1 made every block globally readable, which disclosed one hub’s local grounds and reason to every other hub’s staff** — a `HUB_LOCAL` block is a local operational judgement, not platform information. **Enforcement is not disclosure**: a Hub B booking flow needs to know a **platform-wide** block exists, and that is answered by the `PLATFORM_WIDE` row it can already read, never by exposing Hub A’s record|
| `Session`| &mdash; *(carries `authorized_hub_ids`)*| &mdash;| &mdash;| self + `staff.session.revoke`| self + revoke key| self &middot; `staff.session.revoke` for another principal &middot; `staff.read` for `listSessions`, at the same tier| self| **DENY**| self| **DENY**| task cap *(authentication)*| n/a| yes| &mdash;| `api` `worker:session_maintenance`| `api` `worker:session_maintenance`| **The source of Hub scope, never its subject.** Filtering the record that establishes the filter is circular. **`listSessions` returns another principal's `ACTIVE` sessions — never a token hash or a bundle — to a `staff.read` holder at `revokeSession`'s tier**, so the revoke screen has something to show (Gate PD-3R2)|
| `MfaFactor`| &mdash;| &mdash;| &mdash;| self + admin key| self + admin key| self &middot; `staff.mfa.reset` **P only**| **DENY**| **DENY**| **DENY**| **DENY**| task cap *(authentication)*| n/a| yes| &mdash;| `api`| `api`| Bound to a `StaffIdentity`. Ciphertext only. `getStaffIdentity` returns one derived boolean, `mfa_enrolled`, to a `staff.read` holder; **no Staff query reads this row**|
| `MfaChallenge`| &mdash;| &mdash;| &mdash;| self| self| self| **DENY**| **DENY**| **DENY**| **DENY**| task cap *(authentication)*| n/a| yes| &mdash;| `api`| `api`| Short-lived. `authentication_challenge_ttl_minutes`|
| `RiderSignInChallenge`| &mdash;| &mdash;| `rider_id`| **DENY**| **DENY**| &mdash;| **DENY**| **DENY**| self| self| task cap *(authentication)*| n/a| yes| &mdash;| `api`| `api`| Nonce consumed by a **failed** signature as well as a successful one. **`rider_id` is null for a challenge issued to a number that matched no rider**, which is what keeps issuance from disclosing whether a number is registered; the row also carries `phone_hash` (`domain-model.md` §6.8)|
| `SetupGrant`| &mdash;| &mdash;| &mdash;| self + admin key| self + admin key| self &middot; `staff.credential.recover` **P only**| self| **DENY**| self| **DENY**| task cap *(authentication)*| n/a| yes| &mdash;| `api`| `api`| Hash only. Principal-bound and purpose-bound|
| `RecoveryRequest`| &mdash;| &mdash;| &mdash;| self + admin key| self + admin key| self &middot; `staff.credential.recover` **P only**| self| **DENY**| **DENY**| **DENY**| task cap *(authentication)*| n/a| yes| &mdash;| `api`| `api`| Hash only. **Repairs an existing credential; it does not establish one**|
| `RegisteredDevice`| &mdash;| via `VendorAccount`| `rider_id`| self + admin key| admin key| self &middot; `staff.device.register` / `.reregister` / `.revoke` &middot; `dispatch.read` for a rider's device history and `vendor.read` for a vendor's, inside `getRider` and `getVendorAccount`| self| **DENY**| self| **DENY**| task cap *(authentication)*| n/a| yes| &mdash;| `api`| `api`| Public key and device-credential hash only. **A private key never leaves the handset.** The two reads that list devices return identity, status and dates — never a key or a hash (Gate PD-3R2)|

**Why the identity tables carry `self` rather than a Hub predicate.** Authentication happens *before* Hub scope exists — a `Session` row is what **produces** `authorized_hub_ids`, and a `SetupGrant` is presented by someone with no session at all. A Hub predicate here would make establishing scope depend on already holding it.

**`VendorOrganization` moved here at R1**. The master identity is globally identifiable so an authorised Ops user can look a vendor up. **Global existence of the master is not a grant to global operational history** — the operational tables in §4.2 keep their Hub boundary, so a Hub A Senior Ops user who loads the master still cannot read Hub B history.

**Nor is it a grant to the Vendor's global control records** (C1). §4.3 separates the master identity from `VendorAccountAllowance`, `VendorSuspensionHold` and `SecurityRiskHold`, which R1 left readable by any authenticated Staff principal on the strength of the master being global.

### 4.2 `HUB` — 47 tables
| Table| Hub source| Vendor source| Rider source| Staff SELECT| Staff WRITE| **Staff authority**| Vendor SELECT| Vendor WRITE| Rider SELECT| Rider WRITE| SYSTEM| All-Hub| Immutable| Controlled exception| Read identity| Write identity| Notes|
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `StaffIdentity`| `primary_hub_id` + `HubAssignment`| &mdash;| &mdash;| self &middot; hub&isin;SET/ALL &middot; global for **P**| admin key| `staff.read` *(not Ops Staff)*; global for **P**| **DENY**| **DENY**| **DENY**| **DENY**| task cap| yes| **no** — see §4.7| §30.5 transfer, §34.9 assignment| `api`| `api`| Hub membership is a **security-authority change**: `MSC-DEC-259` terminates live sessions with `HUB_SCOPE_CHANGED`|
| `RiderIdentity`| `primary_hub_id` + `HubAssignment`| &mdash;| self (`id`)| hub&isin;SET/ALL &middot; global for **P**| admin key| `dispatch.read` for the roster (`listRiders`, `getRider`; `MSC-DEC-436`) &middot; `staff.read`; global for **P**| **DENY**| **DENY**| self| **DENY**| task cap| yes| **no** — see §4.7| §30.5 transfer, §34.9 assignment| `api` `worker:notification`| `api`| A Rider reads its own identity row and no other. **The roster reads return identity and readiness only** — whether a PIN is established and whether an `ACTIVE` device exists — **never a PIN, a key or a failed-attempt count, and on the browser surface only**: a Rider's Bearer session holds `dispatch.read` and is refused them (`PERMISSION_DENIED`)|
| `HubAssignment`| `hub_id` *(receiving hub)*| &mdash;| `principal_id` where rider| hub&isin;SET/ALL| admin key| `staff.read`| **DENY**| **DENY**| self| **DENY**| task cap| yes| yes| &mdash;| `api`| `api`| §5.8 effective-dated. **Never overwrites primary membership** (§34.9)|
| `ServiceZone`| `hub_id`| &mdash;| &mdash;| hub&isin;SET/ALL| admin key| `settings.read`| **DENY**| **DENY**| **DENY**| **DENY**| task cap| yes| yes| &mdash;| `api`| `api`| §35.10 serviceability. **No longer a price input**|
| `HubSetting`| `hub_id`| &mdash;| &mdash;| hub&isin;SET/ALL| admin key| `settings.read`| **DENY**| **DENY**| **DENY**| **DENY**| task cap| yes| yes| &mdash;| `api` `worker`| `api`| §33.4: settings never inherit. A missing value **fails visibly**|
| `ZonePairRate`| `hub_id`| &mdash;| &mdash;| hub&isin;SET/ALL| admin key| `pricing.read`| **DENY**| **DENY**| **DENY**| **DENY**| **DENY**| yes| yes| &mdash;| `api`| `api`| **Finding §8.1** — survives a pricing model withdrawn by `MSC-DEC-207`|
| `PickupRequest`| **direct**| `vendor_organization_id`| &mdash;| hub&isin;SET/ALL| hub&isin;SET/ALL| operation key| own| own, pre-assignment| **DENY**| **DENY**| outbox scope| yes| **controlled**| **`MSC-DEC-290`** — pre-custody hub reassignment| `api` `worker:pickup_backstop`| `api` `worker:pickup_backstop`| **The one approved scope-mutation exception in the registry.** `reassignPickupRequestHub` only, never a generic `PATCH`|
| `PickupManifest`| **direct**| **&mdash; deliberately**| `assigned_rider_id`| hub&isin;SET/ALL| hub&isin;SET/ALL| operation key| **DENY**| **DENY**| **`assigned_rider_id` = current rider**| assigned run execution| outbox scope| yes| yes| &mdash;| `api` `worker:pickup_backstop`| `api` `worker:pickup_backstop`| **Carries stops for many vendors** — exposing one to the Vendor PWA leaks other vendors. **Rider access is assignment, never hub membership**|
| `PickupStop`| **direct** *(derived)*| via `PickupRequest`| via `PickupManifest`| hub&isin;SET/ALL| hub&isin;SET/ALL| operation key| via own request| **DENY**| **via assigned manifest**| assigned stop only| outbox scope| yes| yes| &mdash;| `api` `worker:pickup_backstop`| `api` `worker:pickup_backstop`| Child rows inherit the Rider assignment from the authoritative manifest relationship|
| `CollectionRecord`| **direct** *(derived)*| via `PickupStop`| via `PickupStop`| hub&isin;SET/ALL| hub&isin;SET/ALL| operation key| **DENY**| **DENY**| **via assigned stop**| assigned stop only| outbox scope| yes| yes| &mdash;| `api` `worker:pickup_backstop`| `api` `worker:pickup_backstop`| Blind-count independence is a domain invariant, not a scope rule|
| `PickupIntake`| **direct**| via `PickupRequest`| &mdash;| hub&isin;SET/ALL| hub&isin;SET/ALL| operation key| **DENY**| **DENY**| **DENY**| **DENY**| outbox scope| yes| yes| &mdash;| `api`| `api`| **The blind count is withheld structurally**, not by policy|
| `Order`| **direct**| `vendor_organization_id`| &mdash;| hub&isin;SET/ALL| hub&isin;SET/ALL| operation key| **own, across hubs**| **DENY**| **DENY**| **DENY**| outbox scope| yes| yes| &mdash;| `api` `worker:settlement` `worker:notification` `worker:recipient_confirmation`| `api` `worker:settlement`| **The clearest case for `MSC-DEC-286`.** Hub-operational to Staff and Vendor-owned to the Vendor, and the Vendor branch **must not** intersect Hub scope — a vendor’s own order in an unauthorised hub is still the vendor’s|
| `DeliveryRun`| **direct**| **&mdash; deliberately**| `rider_id`| hub&isin;SET/ALL| hub&isin;SET/ALL| operation key| **DENY**| **DENY**| **`rider_id` = current rider**| assigned run execution| outbox scope| yes| yes| &mdash;| `api` `worker:notification`| `api`| Same multi-vendor leak as `PickupManifest`. The vendor sees its own stop, never the run|
| `DeliveryStop`| **direct** *(derived)*| via `Order`| via `DeliveryRun`| hub&isin;SET/ALL| hub&isin;SET/ALL| operation key| via own order| **DENY**| **via assigned run**| assigned stop only| outbox scope| yes| yes| &mdash;| `api` `worker:notification` `worker:recipient_confirmation`| `api` `worker:recipient_confirmation`| &mdash;|
| `OperationalPaymentDemand`| via `Order`| via `Order`| **via assigned stop**| hub&isin;SET/ALL| hub&isin;SET/ALL| operation key| **DENY**| **DENY**| **via assigned stop**| **DENY**| outbox scope| yes| yes| &mdash;| `api` `worker:payment_reconciliation`| `api`| **A Rider reads the demand for a stop they are assigned and writes none of it** — the amount is the server's|
| `PaymentDemandLine`| via `OperationalPaymentDemand`| via `Order`| **via assigned stop**| hub&isin;SET/ALL| hub&isin;SET/ALL| operation key| **DENY**| **DENY**| **via assigned stop**| **DENY**| outbox scope| yes| yes| &mdash;| `api` `worker:payment_reconciliation`| `api`| **Frozen once an attempt exists.** No human predicate writes a line amount|
| `FinancialAdjustmentRequired`| **direct**| &mdash;| &mdash;| hub&isin;SET/ALL| hub&isin;SET/ALL| operation key| **DENY**| **DENY**| **DENY**| **DENY**| outbox scope| yes| yes| &mdash;| `api` `worker:payment_reconciliation`| `api` `worker:payment_reconciliation`| **Ops and Finance read within existing authority; Rider and Vendor have none.** A rider needs to know a payment is unresolved, **not that a customer is owed money back**|
| `FinancialAdjustmentResolution`| **direct**| &mdash;| &mdash;| hub&isin;SET/ALL| hub&isin;SET/ALL| operation key| **DENY**| **DENY**| **DENY**| **DENY**| outbox scope| yes| yes| &mdash;| `api` `worker:payment_reconciliation`| `api` `worker:payment_reconciliation`| **Ops and Finance read within existing authority; Rider and Vendor have none**. It inherits the adjustment’s scope because it inherits its `hub_id`. A vendor sees a credit on their balance and their statement, **never the record that decided it**|
| `PaymentReceipt`| **direct**| via `Order`| **via assigned stop**| hub&isin;SET/ALL| hub&isin;SET/ALL| operation key| **DENY**| **DENY**| **via assigned stop**| **DENY**| outbox scope| yes| yes| &mdash;| `api` `worker:payment_reconciliation`| `api` `worker:payment_reconciliation`| **A Rider sees what was received against the stop they are assigned and writes none of it** — a cash receipt is written by the server on the collection they recorded. **Provider and manual receipts are written by the trusted service and Ops path alone.** A Vendor is not the payer and has no access|
| `PaymentAllocation`| via `PaymentReceipt`| via `Order`| **via assigned stop**| hub&isin;SET/ALL| hub&isin;SET/ALL| operation key| **DENY**| **DENY**| **via assigned stop**| **DENY**| outbox scope| yes| yes| &mdash;| `api` `worker:payment_reconciliation`| `api` `worker:payment_reconciliation`| **No human predicate writes an allocation.** Settlement arithmetic is the server's, and **no permission represents the act** — a screen that could re-allocate could move a customer's money between obligations|
| `PaymentFallbackAuthorization`| **direct**| &mdash;| **via assigned stop** *(read)*| hub&isin;SET/ALL| hub&isin;SET/ALL| operation key| **DENY**| **DENY**| **read only, via assigned stop**| **DENY**| outbox scope| yes| yes| &mdash;| `api` `worker:payment_reconciliation`| `api`| **A Rider may read the grant covering their own stop and can never create one** — they supply its id to the fallback they are taking. **Creation is authorised Ops; consumption is the server's.** A Vendor has no access|
| `PaymentAttempt`| via `Order`| via `Order`| **via assigned stop**| hub&isin;SET/ALL| hub&isin;SET/ALL| operation key| **DENY**| **DENY**| **via assigned stop**| **initiate only**| outbox scope| yes| yes| &mdash;| `api` `worker:payment_reconciliation`| `api` `worker:payment_reconciliation`| **A Rider initiates on their own assigned stop and writes nothing else** — no state, no amount, no confirmation. **Provider truth is applied by the trusted service identity alone**; no human predicate reaches it. Vendor has **no access**|
| `RedeliveryRecord`| via `Order`| via `Order`| **via assigned run**| hub&isin;SET/ALL| hub&isin;SET/ALL| operation key| **via own order**| **DENY**| **via assigned stop**| **DENY**| outbox scope| yes| yes| &mdash;| `api` `worker:notification`| `api`| **Ops schedules; nobody else writes.** A Rider reads the trip they are assigned and **writes nothing** — the fee snapshots are commercial truth. A Vendor reads their own order's redelivery and is **not the payer**|
| `RecipientContactAttempt`| via `Order`| via `Order`| **via assigned run**| hub&isin;SET/ALL| hub&isin;SET/ALL| operation key| **via own order**| **DENY**| **via assigned stop**| **assigned stop only**| outbox scope| yes| yes| &mdash;| `api` `worker:notification` `worker:recipient_confirmation`| `api` `worker:recipient_confirmation`| **A Rider writes only the checkpoints on their own assigned stop**, and a Vendor reads only their own order's exceptions — never the recipient's contact number, which no Vendor predicate reaches|
| `RecipientConfirmation`| via `Order`| via `Order`| &mdash;| hub&isin;SET/ALL| hub&isin;SET/ALL| operation key| **DENY**| **DENY**| **DENY**| **DENY**| outbox scope| yes| yes| &mdash;| `api` `worker:recipient_confirmation`| `api` `worker:recipient_confirmation`| Worker writes on attempt escalation|
| `ThirdPartyHandoff`| via `Order`| via `Order`| via `DeliveryRun`| hub&isin;SET/ALL| hub&isin;SET/ALL| operation key| via own order| **DENY**| **via assigned run**| assigned handoff only| outbox scope| yes| yes| &mdash;| `api`| `api`| &mdash;|
| `DeliveryAttempt`| via `DeliveryStop`| via `Order`| via `DeliveryRun`| hub&isin;SET/ALL| hub&isin;SET/ALL| operation key| via own order| **DENY**| **via assigned run**| assigned stop only| outbox scope| yes| yes| &mdash;| `api` `worker:recipient_confirmation`| `api` `worker:recipient_confirmation`| &mdash;|
| `ReturnRecord`| via `Order`| via `Order`| &mdash;| hub&isin;SET/ALL| hub&isin;SET/ALL| operation key| via own order| **DENY**| **DENY**| **DENY**| outbox scope| yes| yes| &mdash;| `api`| `api`| &mdash;|
| `ParcelCustodyReturn`| **direct**| &mdash;| `rider_id`| hub&isin;SET/ALL| hub&isin;SET/ALL| operation key| **DENY**| **DENY**| **own return** — `rider_id` = current rider| own declaration only| outbox scope| yes| yes| &mdash;| `api`| `api`| **`received_by_staff_id` is never the rider**. Class `HUB`: the record belongs to the responsible hub, and a vendor sees none of it|
| `ApprovedAgent`| `approving_hub_id`| &mdash;| &mdash;| hub&isin;SET/ALL| admin key| `courier.read`; write `courier.agent.approve` &mdash; **S P, own hub**| **DENY**| **DENY**| **DENY**| **DENY**| task cap| yes| yes| &mdash;| `api`| `api`| **Hub-scoped**: an agent is approved for the approving hub's handoffs. **No vendor or rider reads it** — a rider names the agent by phone at the counter and the server resolves it under SYSTEM context, so names, phones and identity documents stay with Ops|
| `RunCustodyHandover`| **direct**| &mdash;| `from_rider_id` / `to_rider_id`| hub&isin;SET/ALL| hub&isin;SET/ALL| operation key| **DENY**| **DENY**| **party to the handover**| party to the handover| outbox scope| yes| yes| &mdash;| `api`| `api`| **`from_rider_id` is never rewritten**|
| `Payment`| **direct**| where vendor-paid| &mdash;| hub&isin;SET/ALL| hub&isin;SET/ALL| operation key| own, where vendor-paid| **DENY**| **DENY**| **DENY**| outbox scope| yes| yes| &mdash;| `api` `worker:settlement`| `api`| &mdash;|
| `CashHandover`| **direct**| &mdash;| `rider_id`| hub&isin;SET/ALL| hub&isin;SET/ALL| operation key| **DENY**| **DENY**| **own handover**| own declaration only| outbox scope| yes| yes| &mdash;| `api` `worker:cash_reconciliation`| `api`| Received by the hub; hub staff adjudicate the variance|
| `CashReconciliation`| **direct**| &mdash;| &mdash;| hub&isin;SET/ALL| hub&isin;SET/ALL| operation key| **DENY**| **DENY**| **DENY**| **DENY**| outbox scope| yes| yes| &mdash;| `api` `worker:cash_reconciliation`| `api` `worker:cash_reconciliation`| §26.3. **Cutoff is `OQ-094`** and is not a scope question|
| `Motorcycle`| **direct**| **never**| &mdash;| hub&isin;SET/ALL| hub&isin;SET/ALL| `fleet.read`| **DENY**| **DENY**| **via current `MotorcycleAssignment`**| **DENY**| task cap| yes| yes| &mdash;| `api` `worker:fleet_compliance`| `api`| §4: *hub-scoped and never vendor-owned*. A Rider reads the machine currently assigned to them|
| `BreakdownIncident`| via `Motorcycle`| &mdash;| `rider_id`| hub&isin;SET/ALL| hub&isin;SET/ALL| `fleet.read`| **DENY**| **DENY**| **own incident**| own incident| task cap| yes| yes| &mdash;| `api`| `api`| &mdash;|
| `MaintenanceScheduleItem`| via `Motorcycle`| &mdash;| &mdash;| hub&isin;SET/ALL| hub&isin;SET/ALL| `fleet.read`| **DENY**| **DENY**| **DENY**| **DENY**| task cap| yes| yes| &mdash;| `api` `worker:fleet_compliance`| `api` `worker:fleet_compliance`| &mdash;|
| `MaintenanceRecord`| via `Motorcycle`| &mdash;| &mdash;| hub&isin;SET/ALL| hub&isin;SET/ALL| `fleet.read`| **DENY**| **DENY**| **DENY**| **DENY**| task cap| yes| yes| &mdash;| `api`| `api`| &mdash;|
| `MotorcycleComplianceRecord`| via `Motorcycle`| &mdash;| &mdash;| hub&isin;SET/ALL| hub&isin;SET/ALL| `fleet.read`| **DENY**| **DENY**| **DENY**| **DENY**| task cap| yes| yes| &mdash;| `api` `worker:fleet_compliance`| `api` `worker:fleet_compliance`| §34.10: an expired document blocks rider assignment|
| `FuelRecord`| via `Motorcycle`| &mdash;| `rider_id`| hub&isin;SET/ALL| hub&isin;SET/ALL| `fleet.read`| **DENY**| **DENY**| **own record**| own record| task cap| yes| yes| &mdash;| `api`| `api`| **No rider claim workflow**|
| `Evidence`| **direct, nullable** — `MSC-DEC-291`| **direct, nullable**| via owner| `hub` owner: hub&isin;SET/ALL &middot; vendor-global owner: **finance/P**| hub&isin;SET/ALL| the key of the act evidenced; **vendor-global owner: `settlement.read` @ all-Hub**| **own** — hub-independent where the owner is vendor-owned| **DENY**| **via assigned owner**| own capture only| outbox scope| yes| yes| &mdash;| `api` `worker:evidence_validation`| `api` `worker:evidence_validation`| **Owner-aware, and the row that most needed R1**. A `VENDOR_ORGANIZATION`-owned object has `responsible_hub_id` **NULL** and is bounded by vendor ownership alone; **no synthetic hub is invented**|
| `Notification`| via subject| via subject| &mdash;| hub&isin;SET/ALL| **DENY**| `notification.read`| **DENY**| **DENY**| **DENY**| **DENY**| outbox scope| yes| yes| &mdash;| `api` `worker:notification`| `worker:notification`| **Finding §8.3** — field detail deferred to `SLICE-010`|
| `DeliveryCommitment`| `responsible_hub_id` *(derived)*| via own `Order`| via assigned run| hub&isin;SET/ALL| `delivery.commitment.revise`| operation key| via own order| **DENY**| **via assigned stop**| **DENY**| outbox scope| yes *(read)*| **append-only**| &mdash;| `api` `worker:notification`| `api`| **Append-only**. A row is written, never edited except to set `superseded_at`. The Vendor reads the commitment on its **own** order across hubs; the Rider sees the commitment for a stop **assigned to them**, because a delivery date they cannot see is a promise they cannot keep|
| `RoadExpense`| `responsible_hub_id` *(derived)*| &mdash;| `rider_id`| hub&isin;SET/ALL| `payment.road_expense.record` &middot; approve: `payment.road_expense.approve`| operation key| **DENY**| **DENY**| **own record**| **own record, `CLAIMED` only**| task cap| yes *(read)*| scope yes; `status` no| &mdash;| `api` `worker:settlement`| `api`| The Rider records and reads **their own** expenses and may never write `status` &mdash; **approval is the act that moves money out of their cash accountability**. A Vendor has no interest in it at all|
| `HubCashReconciliation`| `hub_id`| &mdash;| &mdash;| hub&isin;SET/ALL &middot; finance/**P** all hubs| `payment.cash.reconcile_hub`| `payment.cash.reconcile_hub`; all-Hub for Finance| **DENY**| **DENY**| **DENY**| **DENY**| task cap| yes *(read)*| `business_date` yes| &mdash;| `api` `worker:settlement`| `api`| One row per hub per operating day. **Hub variance is not rider variance** &mdash; a Rider has no read at all, because the hub's position is not their record|
| `CashDisposition`| `hub_id` *(derived)*| &mdash;| &mdash;| hub&isin;SET/ALL &middot; finance/**P** all hubs| `payment.cash.disposition`| `payment.cash.disposition`; all-Hub for Finance| **DENY**| **DENY**| **DENY**| **DENY**| task cap| yes *(read)*| yes| &mdash;| `api` `worker:settlement`| `api`| Where the money actually went. **The last custody transfer, and the one nobody naturally records**|
| `AccountingExport`| `hub_id` *(conditional — null for `ALL_HUBS`)*| &mdash;| &mdash;| hub&isin;SET/ALL &middot; finance/**P** all hubs| `payment.ledger.export`| `payment.ledger.export`; all-Hub for Finance| **DENY**| **DENY**| **DENY**| **DENY**| task cap| yes *(read)*| yes| &mdash;| `api` `worker:settlement`| `api`| A canonical extract of payment facts for a closed period. **Creates no accounting entry and moves no money**, the same boundary `CashDisposition` and `FinancialAdjustmentResolution` already hold. `storage_ref` is **never returned to a client**|

**`Order` and `PickupManifest` are the two rows that justify v2.** Both are class `HUB` and neither is Hub-only: `Order` is Vendor-owned to the Vendor **across hubs**, and `PickupManifest` is assignment-scoped to the Rider and **`DENY` to the Vendor entirely** — it carries stops for many vendors, so exposing one would leak the others.

**Two rows say `Scope immutable: no`, and the exception is deliberate.** A staff or rider identity's Hub membership is *supposed* to change: that is §30.5 transfer and §34.9 temporary assignment. **It is a security-authority change**, so `MSC-DEC-259` terminates every live session with `HUB_SCOPE_CHANGED`. `MSC-DEC-278`'s immutability rule governs **derived** scope copied onto operational children, not authoritative membership.

**`PickupRequest` carries the one approved *controlled* mutation** — pre-custody hub reassignment through a named command, never a generic `PATCH`.

### 4.3 `VENDOR` — 10 tables
| Table| Hub source| Vendor source| Rider source| Staff SELECT| Staff WRITE| **Staff authority**| Vendor SELECT| Vendor WRITE| Rider SELECT| Rider WRITE| SYSTEM| All-Hub| Immutable| Controlled exception| Read identity| Write identity| Notes|
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `VendorPickupLocation`| **&mdash; never**| `vendor_organization_id`| &mdash;| global *(master)*| admin key| `vendor.read` *(master identity)*| own| own| **DENY**| **DENY**| task cap| n/a| yes| &mdash;| `api`| `api`| &mdash;|
| `VendorAccount`| **&mdash; never**| `vendor_organization_id`| &mdash;| global *(master)*| admin key| `vendor.read` *(master identity)*| own| **DENY**| **DENY**| **DENY**| task cap| n/a| yes| &mdash;| `api`| `api`| The shared credential’s account (§37.5). **A global master record whose two reads are narrowed by their operations** (`MSC-DEC-442`, overruling the Gate PD-3R2 reading): at the persistence level nothing changes — the table is classed `global *(master)*` because a vendor has one account whichever hub serves it, and the Staff `DENY` on `VendorCredential` stands — **but `getVendorAccount` and `listVendorAccounts` return only accounts whose linked `VendorOrganization`'s responsible hub is in the caller's grant** (`hub&isin;SET/ALL` semantics, resolved per operation as §3 says, through `vendor_organization_id`), and an existing account outside it is `HUB_SCOPE_VIOLATION` while one that does not exist is `NOT_FOUND`. **The narrowing is the two operations', not a Staff row-level rule**; §8.5 records the one question that leaves. `reissueVendorCredentialSetup` acts at the vendor's own hub, and `recoverVendorCredential` is Platform Admin at all hubs|
| `VendorCredential`| **&mdash; never**| via `VendorAccount`| &mdash;| **DENY**| admin key| &mdash;| **DENY**| **DENY**| **DENY**| **DENY**| task cap *(authentication)*| n/a| yes| &mdash;| `api`| `api`| Hash only. **No Staff read** — nothing in the product requires a human to see it. **The vendor-account reads return three indicators derived from it by the `api` identity** — a secret exists, a recovery email exists, a recovery phone exists — **never a value**, so the Staff `DENY` stands|
| `VendorAccountAllowance`| **&mdash; never**| `vendor_organization_id`| &mdash;| all-Hub `vendor.read` &mdash; **not ordinary Hub staff**| admin key| **`vendor.read` @ all-Hub** *(C1)*| own| **DENY**| **DENY**| **DENY**| task cap| n/a| yes| &mdash;| `api` `worker:settlement`| `api`| §35.12.8 condition three of four|
| `VendorSuspensionHold`| **&mdash; never**| `vendor_organization_id`| &mdash;| all-Hub `vendor.read` &mdash; **not ordinary Hub staff**| admin key| **`vendor.read` @ all-Hub** *(C1)*| own| **DENY**| **DENY**| **DENY**| task cap| n/a| yes| &mdash;| `api` `worker:settlement`| `api`| §35.12.8 condition one|
| `SecurityRiskHold`| **&mdash; never**| `vendor_organization_id`| &mdash;| all-Hub `vendor.read` &mdash; **not ordinary Hub staff**| admin key| **`vendor.read` @ all-Hub** *(C1)*| **DENY**| **DENY**| **DENY**| **DENY**| task cap| n/a| yes| &mdash;| `api`| `api`| §35.12.8 condition four. **Vendor cannot read its own risk hold** — telling the subject is the failure mode|
| `VendorBalance`| **&mdash; never**| `vendor_organization_id`| &mdash;| finance/**P** global| **DENY**| **`settlement.read` @ all-Hub**| own| **DENY**| **DENY**| **DENY**| task cap| n/a| yes| &mdash;| `api` `worker:settlement`| `api` `worker:settlement`| **Global-authority Staff read only** — hub staff get Hub-filtered operational projections, not the cross-Hub balance|
| `VendorStatement`| **&mdash; never** (§5.2.5)| `vendor_organization_id`| &mdash;| finance/**P** global| **DENY**| **`settlement.read` @ all-Hub**| own| **DENY**| **DENY**| **DENY**| task cap| n/a| yes| &mdash;| `api` `worker:settlement`| `api` `worker:settlement`| **One weekly statement per vendor across all hubs.** A Hub filter here does not leak — it **under-bills**. Hub Senior Ops does **not** receive it|
| `StatementLine`| **&mdash; never**| via `VendorStatement`| &mdash;| finance/**P** global| **DENY**| **`settlement.read` @ all-Hub**| own| **DENY**| **DENY**| **DENY**| task cap| n/a| yes| &mdash;| `api` `worker:settlement`| `api` `worker:settlement`| &mdash;|
| `Adjustment`| **&mdash; never**| via statement / `Order`| &mdash;| finance/**P** global| finance admin key| **`settlement.read` @ all-Hub**| own| **DENY**| **DENY**| **DENY**| task cap| n/a| yes| &mdash;| `api` `worker:settlement`| `api`| §35.6.7 linked corrections. **A correction posts; it never rewrites**|

**Hub staff do not read the canonical financial rows**. `VendorBalance`, `VendorStatement`, `StatementLine` and `Adjustment` are Vendor-global; a Hub Senior Ops user needing operational financial information receives **Hub-filtered projections of the operational rows**, not the cross-Hub statement. Adding a Hub column to `VendorStatement` would not leak — §5.2.5 issues one statement per vendor across all hubs, so a Hub filter would **under-bill**.

**`SecurityRiskHold` denies the Vendor its own row.** Every other vendor-owned condition here is readable by the vendor; a risk hold is not, because telling the subject is the failure mode §35.12.8 exists to prevent.

**The global Vendor rows, reconciled against `MSC-DEC-295`** (C1). R1 moved the master identity to `PLATFORM` and marked five `VENDOR` rows `global *(master)*` beside it. **Three of those five are not master identity.**

| Row| R1| C1| Why|
|---|---|---|---|
| `VendorPickupLocation`| `global *(master)*`| **unchanged**| A pickup address is what an Ops user needs to **associate a booking**. §10.A master identification|
| `VendorAccount`| `global *(master)*`| **unchanged**| The account identity. Its **credential** is `VendorCredential`, Staff `DENY`, and its **security state** is the three control rows below — §35.12.8 keeps them distinct, so the master carries none of it; the reads derive their indicators — a secret exists, a browser count, a recovery channel exists — when they run, and store none on the master|
| `VendorAccountAllowance`| `global *(master)*`| **all-Hub `vendor.read`**| A global commercial **control**. `vendor.allowance.enable` / `.disable` is **Platform Admin only** (§35.12.3)|
| `VendorSuspensionHold`| `global *(master)*`| **all-Hub `vendor.read`**| The canonical suspension record — grounds, actor, held work items, disposition (§35.12.9)|
| `SecurityRiskHold`| `global *(master)*`| **all-Hub `vendor.read`**| §35.12.8's fourth condition. The record whose subject and grounds are least appropriate to broadcast to every hub|

**No Hub workflow loses an operational answer.** §36.12 gives `VendorOrganization` its own lifecycle — `ACTIVE`, `SUSPENDED`, `TERMINATED` and the rest — and `VendorAccountAllowance` its own `DISABLED_PREPAYMENT_ONLY` / `ENABLED` states. **The yes/no a booking flow needs is a state on a record Hub staff already read.** What C1 withholds is the control record *behind* that state.

**The financial rows were already right and are now explicit.** `VendorBalance`, `VendorStatement`, `StatementLine` and `Adjustment` stay global-authority resources at `settlement.read` held with all-Hub scope — Finance and Platform Admin. Hub staff use Hub-filtered projections of the **operational** rows (`SECURITY_DESIGN.md` §14.20); that has never widened access to the canonical statement.

**Where a Hub workflow would need a projection of a restricted control record, this document does not invent one.** The four §35.12.8 conditions are modelled at summary level and field detail is Phase 4. `OQ-105` carries it.

### 4.4 `RIDER_ASSIGNMENT` — 2 tables
| Table| Hub source| Vendor source| Rider source| Staff SELECT| Staff WRITE| **Staff authority**| Vendor SELECT| Vendor WRITE| Rider SELECT| Rider WRITE| SYSTEM| All-Hub| Immutable| Controlled exception| Read identity| Write identity| Notes|
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `RiderCashCustody`| `responsible_hub_id` *(context)*| &mdash;| **`rider_id`**| hub&isin;SET/ALL| hub&isin;SET/ALL| operation key| **DENY**| **DENY**| **`rider_id` = current rider**| own declaration only| outbox scope| yes| yes| &mdash;| `api` `worker:cash_reconciliation`| `api` `worker:cash_reconciliation`| **`rider_id` survives a `RunCustodyHandover`**: parcels move, cash does not. Hub is context and **must not be the boundary**|
| `MotorcycleAssignment`| via `Motorcycle`| &mdash;| **`rider_id`**| hub&isin;SET/ALL| hub&isin;SET/ALL| `fleet.read`| **DENY**| **DENY**| **`rider_id` = current rider**| **DENY**| task cap| yes| yes| &mdash;| `api` `worker:fleet_compliance`| `api`| The rider-to-motorcycle binding §34.10 governs|

**The class exists because Hub equality is not a Rider boundary.** Both rows are reachable by Hub staff *and* bounded to one Rider, and the Rider's boundary is the one that matters. `MSC-DEC-250` makes it concrete: a stranded rider's parcels transfer to a colleague and **the cash does not**, so a hub-only policy would show a receiving hub's staff cash the original rider still owes.

### 4.5 `AUDIT` — 2 tables
| Table| Hub source| Vendor source| Rider source| Staff SELECT| Staff WRITE| **Staff authority**| Vendor SELECT| Vendor WRITE| Rider SELECT| Rider WRITE| SYSTEM| All-Hub| Immutable| Controlled exception| Read identity| Write identity| Notes|
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `AuditEvent`| `responsible_hub_id`| `vendor_organization_id`| via `device_context`| auditor bundle &middot; hub&isin;SET/ALL| **INSERT only**| `audit.log.read` *(auditor bundle)*| **DENY**| **DENY**| **DENY**| **DENY**| INSERT only| **yes** — auditor| yes| &mdash;| `api` `worker:audit_integrity`| `api` `worker` *(INSERT)*| §39.7 requires the Hub context. **No `UPDATE`, no `DELETE` grant to any runtime identity**|
| `AuditIntegrityCheckpoint`| &mdash;| &mdash;| &mdash;| auditor bundle| **DENY**| `audit.log.read` *(auditor bundle)*| **DENY**| **DENY**| **DENY**| **DENY**| **INSERT only**| yes| yes| &mdash;| `api` `worker:audit_integrity`| `worker:audit_integrity` *(INSERT)*| Created by `MSC-DEC-283`. Batch manifest, previous checkpoint hash, KMS signature|

**`INSERT only` is the structural half of append-only.** No runtime identity holds `UPDATE` or `DELETE`. That constrains the **application** and not a credential holder, which is why `MSC-DEC-283` puts an independent KMS-signed chained checkpoint above it.

### 4.6 `SYSTEM` — 2 tables
| Table| Hub source| Vendor source| Rider source| Staff SELECT| Staff WRITE| **Staff authority**| Vendor SELECT| Vendor WRITE| Rider SELECT| Rider WRITE| SYSTEM| All-Hub| Immutable| Controlled exception| Read identity| Write identity| Notes|
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `Outbox`| **authoritative, transaction-derived**| **authoritative, transaction-derived**| **authoritative, transaction-derived**| **DENY**| **DENY**| &mdash;| **DENY**| **DENY**| **DENY**| **DENY**| **bootstrap read by `outbox_id`** &middot; relay bookkeeping| n/a| **yes — envelope**| &mdash;| `relay` `worker` *(by id)*| `api` *(INSERT in business txn)* &middot; `relay` *(bookkeeping)*| **The envelope is written inside the business transaction and is immutable**. **No API operation exposes an arbitrary Outbox read**|
| `IdempotencyRecord`| &mdash;| &mdash;| &mdash;| own principal record| own principal record| operation key| own principal record| own principal record| own principal record| own principal record| own task principal record| n/a| yes| &mdash;| `api` `worker`| `api` `worker`| **Principal-scoped at R1**: unique on `principal_type + principal_id + operation_id + idempotency_key`. **One principal never receives another’s saved result**|

**Both tables hold no business rows, which is what makes `SYSTEM` correct rather than convenient.** An `Outbox` row *names* a business object; it does not contain one. **Its scope columns exist to be verified against a reloaded aggregate, never to grant access to it** — step 7 of `MSC-DEC-287`'s sequence.

**Every business-principal branch is `DENY`.** A worker's ability to read one `Outbox` row by `outbox_id` is a narrow **bootstrap capability**, not business-row read authority, and **no API operation exposes an arbitrary Outbox read**.

### 4.7 The two rows whose scope is deliberately mutable

`StaffIdentity` and `RiderIdentity` carry `Immutable: no` because Hub membership is **meant** to change — §30.5 transfer and §34.9 temporary assignment are product behaviour, not drift. Both changes are **security-authority changes** and terminate live sessions with `HUB_SCOPE_CHANGED`.

`PickupRequest` carries `Immutable: controlled` — the single approved exception, reachable only through `reassignPickupRequestHub`, only before custody, and only by an actor authorised for **both** hubs.

**Everything else is immutable at creation.** `MSC-DEC-278`'s composite foreign key and immutability trigger apply unchanged.

---

## 5. Technical identities

| Identity| Role| May|
|---|---|---|
| `owner`| `melarc_owner` — **`NOLOGIN`**| Owns schemas and tables. **Never a runtime login**|
| `api`| `melarc_api_runtime`| Application DML under RLS; own-principal idempotency rows; `Outbox` `INSERT` inside a business transaction|
| `worker`| `melarc_worker_runtime`| Bootstrap read of one `Outbox` row by id; task-required DML under `Outbox`-derived context; audit `INSERT`|
| `sched`| `melarc_scheduler_runtime`| Enqueue scheduled work intent. **No business DML**|
| `relay`| `melarc_outbox_relay_runtime`| Read relayable `Outbox` rows; publish; update relay bookkeeping columns only. **No business table at all**|
| `migration`| `melarc_migration_elevated`| Approved DDL, ownership transfer and policy changes **for the deployment window only**|
| backup plane| isolated infrastructure identity| Backup and restore only. **Not an application database login**|

**No technical identity holds a `RoleBundle`**. `OQ-047` stays open for the Product question of integration permissions.

### 5.1 Worker task capabilities

`MSC-DEC-289`. **`melarc_worker_runtime` is a base identity and holds no protected-business-table grant.** Every business table above names the **task capability** that reaches it, and each capability is a `melarc_worker_cap_<task>` grant set.

| Capability| Documented task| Reads| Writes|
|---|---|---|---|
| `worker:notification`| `notify_rider_run_dispatched` · `notify_vendor_milestone` · `send_recipient_otp`| `Order` · `DeliveryRun` · `DeliveryStop` · `RiderIdentity` · `VendorOrganization` · `Notification`| `Notification`|
| `worker:pickup_backstop`| `sweep_failure_backstop`| `PickupRequest` · `PickupManifest` · `PickupStop` · `CollectionRecord`| the same four|
| `worker:settlement`| `issue_vendor_statements` · `transition_overdue_statements`| `Order` · `Payment` · `VendorOrganization` · `VendorAccountAllowance` · `VendorSuspensionHold` · `VendorBalance` · `VendorStatement` · `StatementLine` · `Adjustment`| `Order` · `VendorBalance` · `VendorStatement` · `StatementLine`|
| `worker:session_maintenance`| `expire_sessions`| `Session`| `Session`|
| `worker:fleet_compliance`| `alert_compliance_expiry`| `Motorcycle` · `MotorcycleAssignment` · `MaintenanceScheduleItem` · `MotorcycleComplianceRecord`| `MaintenanceScheduleItem` · `MotorcycleComplianceRecord`|
| `worker:recipient_confirmation`| Confirmation attempt escalation (§36.8)| `Order` · `DeliveryStop` · `DeliveryAttempt` · `RecipientConfirmation`| `DeliveryStop` · `DeliveryAttempt` · `RecipientConfirmation`|
| `worker:payment_reconciliation`| **Resolves unknown and long-pending collections** — re-reads the attempt, queries the provider where supported, applies an **idempotent** transition. **It may never fabricate success**: where provider truth stays unknown, the attempt stays unknown| `PaymentAttempt` · `Order`| `PaymentAttempt`|
| `worker:cash_reconciliation`| Reconciliation reminder — **cutoff 18:00 `Africa/Accra`**, per hub| `RiderCashCustody` · `CashHandover` · `CashReconciliation`| `RiderCashCustody` · `CashReconciliation`|
| `worker:evidence_validation`| Evidence completion validation| `Evidence`| `Evidence`|
| `worker:audit_integrity`| Integrity checkpoint| `AuditEvent` · `AuditIntegrityCheckpoint`| `AuditIntegrityCheckpoint` **INSERT only**|

**Every capability exists because a documented job needs it.** Nothing here is speculative: the list is the jobs at [BACKGROUND_JOBS_AND_EVENTS.md](../architecture/BACKGROUND_JOBS_AND_EVENTS.md) §4 and §3.5, plus the two technical tasks R1 defines.

**What the base identity keeps, and why it is not a business grant.** `Setting`, `ReasonCode`, `CourierProvider` and `HubSetting` are **configuration** every task reads; `Outbox` is the **bootstrap** row fetched by id; `IdempotencyRecord` is the row a principal already owns; `AuditEvent` is **`INSERT` only**. **No protected business table appears in that list**, which is what makes *unrelated to its task class* a decidable question rather than a slogan.

**R1 claimed task-specific capability and then wrote `worker` across most of the schema.** The claim was unenforceable — with a single generic identity, *unrelated* had no definition, and the security matrix's *a worker cannot read a table outside its task class* asserted something nothing could test.

---

## 6. Canonical persistent technical-table inventory

`MSC-DEC-294`. **This section is the authority contract-consistency validation reads.** Before R1 the three tables below were named in a hard-coded `ACCEPTED_EXTRA` dictionary **inside the validator** — which meant the check's expected table universe was defined by the check, and a new technical table could be added to the architecture without anything failing.

**A validator's private exception list is not an inventory.** It is invisible to every reader of the contracts, it cannot be reviewed as part of a change, and it silently absolves exactly the tables nobody has classified.

<!-- TECHNICAL-TABLE-INVENTORY:BEGIN -->

| Table| Source| Purpose| Class| Principal / technical access model| Read identities| Write identities| Enforcement|
|---|---|---|---|---|---|---|---|
| `Outbox`| BACKGROUND_JOBS_AND_EVENTS.md §3.7 &middot; SECURITY_DESIGN.md §14.7| Transactional outbox carrying the immutable server-derived security envelope for asynchronous work| `SYSTEM`| SYSTEM bootstrap only — no business principal branch| `relay` &middot; `worker` *(single row, by `outbox_id`)*| `api` *(INSERT inside the business transaction)* &middot; `relay` *(relay bookkeeping columns only)*| RLS enabled; **all business-principal branches DENY**. Worker access is a narrow bootstrap capability, not business-row authority|
| `IdempotencyRecord`| SOLUTION_ARCHITECTURE.md §7 &middot; SECURITY_DESIGN.md §14.16| Replay protection keyed to the calling principal and operation| `SYSTEM`| Each principal reaches only its own records| `api` &middot; `worker`| `api` &middot; `worker`| RLS enabled on `principal_type + principal_id`; unique constraint carries `operation_id` and `idempotency_key`|
| `AuditIntegrityCheckpoint`| audit.md §2.1 &middot; SECURITY_DESIGN.md §14.11| KMS-signed chained manifest over a batch of `AuditEvent` rows| `AUDIT`| Auditor bundle reads; no business principal writes| `api` &middot; `worker`| `worker` *(INSERT only)*| RLS enabled; **no `UPDATE` or `DELETE` grant exists for any runtime identity**|

<!-- TECHNICAL-TABLE-INVENTORY:END -->

**Adding a persistent technical table now requires this section and a §4 row in the same controlled change** ([MIGRATION_AND_SEEDING.md](../architecture/MIGRATION_AND_SEEDING.md) §5.3). Until both exist, the consistency test must reject the mismatch — which is the behaviour the `ACCEPTED_EXTRA` list was suppressing.

---

## 7. Coverage and implementation requirements

Every persistent business or technical table requires a scope classification and explicit applicable principal predicates. Cross-check the domain model, architecture's technical-table declarations and the inventory here whenever a table is introduced. Embedded values and non-persistent projections are not tables.

### 7.1 Implementation validation

Use [security-test-matrix.md](../standards/security-test-matrix.md) for positive and negative controls at their specified enforcement layer. Classifications are requirements, not proof that database policies exist. Implement and test the actual policies for the task's scope. No documentation admission or signature package is required.

## 8. Findings — recorded, not resolved

### 8.1 `ZonePairRate` outlived the model that needed it

`MSC-DEC-207` withdrew the zone-pair matrix for flat service-area pricing, and [settings.md](settings.md) §7.6 lists `zone_pair_matrix` as **retired — must not govern**. **The entity is still in [domain-model.md](domain-model.md) §6.9's Hub row.** Classified so it cannot be created unclassified, and reported so it is not created at all without a decision.

### 8.2 ~~`AdHocSender` block reach~~ — closed at R1

Recorded at v0.1 as underdetermined. **`MSC-DEC-296` settles it**: Hub Senior Ops blocks are `HUB_LOCAL`, Platform Admin blocks are `PLATFORM_WIDE` with mandatory reason and enhanced audit. `AdHocSenderBlock` carries the discriminator explicitly, and **platform-wide reach is never inferred from a null `hub_id`**. `OQ-104` closes.

### 8.3 `Notification` inherits a scope whose field detail does not exist

A cross-cutting entity at §6.9 with **no field detail** — deferred to Phase 4 and `SLICE-010`. Its Hub and Vendor columns say *via subject*, which is the correct rule and is not yet a column a policy can read. `BACKGROUND_JOBS_AND_EVENTS.md` §3.4 names the hazard exactly. **The classification is sound; the fields it points at are owed by `SLICE-010`.**

### 8.4 Two persistent tables exist in architecture and in no contract

`Outbox` and `IdempotencyRecord` are required by `SOLUTION_ARCHITECTURE.md` §7 and `BACKGROUND_JOBS_AND_EVENTS.md` §3.7 and appear in **no** contract document. **R1 gives them a canonical home in §6** — which is a security inventory, not a domain model. **Whether they belong in the domain model is a contract question this document may not settle**; architecture carries no product authority (§42.7).

### 8.5 `VendorAccount`'s hub boundary lives in two operations and in no row-level rule

`MSC-DEC-442` narrows `getVendorAccount` and `listVendorAccounts` to accounts whose linked `VendorOrganization`'s responsible hub is in the caller's grant, **and says the record stays a global master at the persistence level** — so the Staff `SELECT` predicate stays `global *(master)*` and the narrowing is the two operations', which load the master row and compare the organisation's `responsible_hub_id` with the hubs the authorising grant reaches. **`VendorAccount` has no hub column, so [SECURITY_DESIGN.md](../architecture/SECURITY_DESIGN.md) §14.4b's scope probe does not apply to it.** Whether a Staff row-level rule through `VendorOrganization` should also exist, and with it the probe, is the Backend Engineer's.

---

## 9. Related

- **Decisions:** `MSC-DEC-275` · `277` · `278` · `282` · **`286` (v2)** · `287` · `288` · `289` · `290` · `291` · **`294` (technical inventory)** · `295` · `296`
- **Product-level source:** [domain-model.md](domain-model.md) §4, §5.6, §6.8–§6.11
- **Policy patterns:** [SECURITY_DESIGN.md](../architecture/SECURITY_DESIGN.md) §14.4
- **Checks:** [engineering-standards.md](../standards/engineering-standards.md) §4 — contract-consistency validation
