# Permissions

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 1.50 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** the permission key grammar, the closed domain list, the scope model, the maker-checker shape, the action-permission catalogue, and the bundle definitions
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../PROJECT_MASTER_SPECIFICATION.md) §11 (roles and permissions), §37 (security and permissions), §35.1.2–3
> **Depends on:** [domain-model.md](domain-model.md) §4 for the ownership and scoping axes — **`APPROVED` v1.0**

## 1. Scope

**This document covers** the permission model §11.6 defines formally: the key grammar, the closed domain list, the four scope axes, the uniform maker-checker shape, the **action/write** permission catalogue, and the eleven bundles from §11.3 with their nesting.

**It deliberately does not cover** four things §11.5 lists as still open, all owned by `OQ-047`:

- **Read and view permissions.** §11.5 states plainly that "the action matrix above, and the catalog derived from it, are write/action-oriented only." Deriving read permissions from a write matrix would be invention.
- **Service-account and integration permissions.**
- **Whether a bundle may carry per-user overrides**, or bundles are strictly fixed.
- **Exact suspension, held-parcel disposition, credential revocation and security-event response mechanics.**

§11.6 says the complete catalogue is "seeded by `DRAFT_PERMISSIONS_CATALOG_V0.1.md` and not yet finalized." **That file was never delivered with the baseline**, like the six control registers. There is no seed. The catalogue below is derived directly from §11.4's action matrix, which is the authoritative human-readable policy view.

## 2. The two gates

§11.1 and §35.1.2: authorization is **two independent checks**, and passing one never implies the other.

1. **Surface gate** — which category of work the application exposes. Melarc Ops, Melarc Vendor and Melarc Rider are different tools, not one system behind three logins.
2. **Permission and ownership gate** — whether this actor may perform this action on this record, given held permissions, responsible hub, vendor ownership, rider assignment, current state, and any approved temporary assignment.

§35.1.2 states the failure mode directly: "being allowed into a portal does not imply permission to perform every action shown in that portal."

**The backend enforces permissions, not role names** (§11.1, `MSC-DEC-133`). A check that tests `user.role == "SENIOR_OPS"` is wrong however correct its outcome, because changing a bundle's contents is a configuration change and must not require a code change.

**Deny by default** (§37.1). An action with no matching permission is refused, never permitted by framework default. §11.5: "no implementation may infer missing permissions from UI convenience or framework defaults."

## 3. Key grammar

§11.6 fixes the form:

```
<domain>.<action>
<domain>.<subresource>.<action>
```

The three-part form is used only where a domain has more than one independently grantable resource. `pricing.correction.approve` is §11.1's own example.

A permission is **binary** — held or not held. There is no partial grant, no permission level, and no numeric rank. Anything resembling a privilege level belongs in the scope attached to the grant, not the key.

`domain` is drawn from a **closed list**. §11.6: "introducing a new domain requires a Product Owner decision, not an ad hoc string in application code."

## 4. The closed domain list

§11.6 requires the list to mirror the specification's own sections. Derived accordingly:

| Domain| Mirrors| Covers|
|---|---|---|
| `pickup`| §21| Requests, manifests, stops, collection, failure, attempt chain|
| `hub`| §22| Handover, intake, blind count, OS&D, itemization, hub settings and zones|
| `pricing`| §23| Price corrections, repricing, pricing structure|
| `dispatch`| §24| Recipient confirmation, delivery runs|
| `delivery`| §25| Delivery execution, handoff, proof|
| `payment`| §26| Collection, reconciliation, cash custody|
| `settlement`| §27| Statements, balances, adjustments|
| `returns`| §28| Return processing, return-fee waivers|
| `vendor`| §29| Organizations, allowance, suspension, held parcels|
| `staff`| §30| Staff and rider identities, assignment, suspension, devices|
| `notification`| §31| Templates and dispatch|
| `report`| §32| Dashboards, reports, exports|
| `settings`| §33| Global settings, reasons, retention|
| `fleet`| §34.10| Motorcycles, assignment, breakdown, maintenance, fuel, compliance|
| `courier`| §24.7| Courier registry|
| `audit`| §38| Audit log search, view, export|
| `permission`| §11| Bundle administration|

Seventeen domains. Adding an eighteenth requires a Product Owner decision recorded in the affected specification.

## 5. Scope

§11.6 is emphatic that scope attaches **to the grant, not to the key**. `pickup.request.create` is one permission; who may create requests for whom is scope. This is what keeps the key list small and the bundles composable.

Four axes, each independent:

| Axis| Values| Source|
|---|---|---|
| **Hub scope**| none · own hub · all hubs| §11.6, §35.10|
| **Ownership scope**| own record · assigned record · any record| §11.6, §37.3|
| **State precondition**| evaluated jointly with the §36 state machine| §11.6|
| **Time window**| optional, reusing the §30.5 temporary-assignment pattern| §11.6, §34.9|

The **state precondition** axis is the one most easily dropped. It means a permission check is not answerable from the actor alone — `pickup.request.cancel` held with *own record* scope still fails once a rider is assigned to the request's manifest (`MSC-DEC-195`, deferred in V1 by `MSC-DEC-196`). Authorization and the state machine are evaluated together, which is why [state-machines.md](state-machines.md) carries the actor column on every transition.

The **time window** axis exists because §34.9 temporary hub assignments "must not overwrite primary membership." A temporarily assigned rider holds real authority in the receiving hub for a bounded period, and that is a scoped grant rather than an edit to their identity.

## 6. Maker-checker

§11.6, §37.4 and §37.4, `MSC-DEC-135` fix **one uniform shape** for every maker-checker action in the product:

- a `*.create` or `*.request` permission,
- a `*.approve` permission,
- and one constraint enforced uniformly: **the approver may not be the actor who created the same record.**

§37.4 lists the instances: vendor activation, financial allowance, one-package exception approval, price correction, hub setting and zone proposals, two-hub temporary staff assignment, return-fee waiver. §35.12.2 adds that vendor creation itself is maker-checker — "the creator and the operational approver must be different actors."

There is no second pattern. A workflow needing two-party control uses this shape or it is wrong.

**Same-actor exclusion.** With a three-person team, the same-actor exclusion is a backend constraint, not an honour system, and it applies regardless of how few people hold the permission. If nobody else holds `*.approve`, the action blocks — that is the control working, not a defect.

## 7. Action permission catalogue

Derived from §11.4's twenty-four-row matrix plus the authorities named in §11.3 and §11.6. **Write and action permissions only** — reads are `OQ-047`.

Legend: **A** Ops Staff · **S** Senior Ops · **P** Platform Admin · **V** Vendor account · **R** Rider

### `pickup`

| Key| Holders| Scope| Notes|
|---|---|---|---|
| `pickup.request.create`| A S P V| V: own vendor only| §11.4 row 1|
| `pickup.request.confirm`| A S P| own hub| **Ops only in V1** — vendor self-confirm deferred|
| `pickup.request.cancel`| A S P V| **V: own `PENDING` request only** in V1. A S P: own hub, pre-assignment| Free cancellation. *Deferred guard for re-enablement: manifest has no assigned rider*|
| `pickup.request.cancel_chargeable`| A S P| own hub. **Never held by a vendor**| Post-assignment office cancellation. The charge is **discretionary** — holding this permission does not mandate applying it|
| `pickup.cancellation_charge.waive`| **S P**| own hub| Waives an applied cancellation charge. Senior Ops floor; actor and reason recorded|
| `pickup.handshake.override`| **A S P**| own hub| Fallback rung 2 — authorises a handshake when portal and SMS both fail, as a recorded exception|
| `pickup.exception.request`| A S P| own hub| One-package exception, maker side|
| `pickup.exception.approve`| **S P, and Ops Staff explicitly granted it**| own hub · P: all hubs| The one-package exception, checker side. **Widened from `P only` by `MSC-DEC-333`** — §11.4 row 3 placed it with Platform Admin, and a hub-floor judgement routed to the busiest authority in the product stops being asked for: the booking is refused or the rule is worked around, and both are worse than the exception. **The permission is authoritative, not the role.** Approver ≠ requester still holds, and it is **never available to vendor self-service** (§35.2.4). **The approved single-package fee becomes due on acceptance**|
| `pickup.request.reassign_hub`| **A S P**| **source hub AND target hub** — explicit all-Hub authority satisfies this only when the actor actually holds it| **New at R1**. Moves a `PickupRequest` to another hub **before rider pickup or custody begins**, revoking stale planning atomically. **Both-hub scope is the control**: a source-hub-only actor moving work into a hub they cannot see would be exporting it beyond their own authority. Never a generic `PATCH` of `responsible_hub_id`|
| `pickup.manifest.create`| A S P| own hub| Build and order stops; ordering is manual (§35.3.2)|
| `pickup.manifest.assign`| A S P| own hub| Sets the rider. **This is the moment vendor self-cancellation closes** — which is why it is its own key and not part of `dispatch`|
| `pickup.manifest.dispatch`| A S P| own hub| Dispatch ≠ start (§35.3.4)|
| `pickup.run.execute`| **R only**| assigned run| §11.4 row 5. Rider may not add or substitute stops (§35.3.5)|
| `pickup.collection.confirm`| V R| V: own pickup · R: ad-hoc code-entry path| §11.4 row 6 — see note below|
| `pickup.failure.report`| **R only**| owned dispatched stop||
| `pickup.failure.resolve`| A S P| own hub| Reschedule, cancel, escalate. **Not a skip** — `pickup.stop.skip` is its own key|
| `pickup.stop.skip`| A S P| own hub| **Authorises the §5 `PENDING/ARRIVED → SKIPPED` transition**, signed 17 August 2026 and performable by nothing until `MSC-DEC-412`. Mandatory reason from the `PICKUP_STOP_SKIP` catalogue domain; **the Vendor is notified always**; **no attempt is consumed**. Ops floor, because a run stranded mid-afternoon must be closable by the people working it|
| `pickup.attempt.extend`| S P| S: own hub, reason and audit mandatory| Force-extend past `MELARC_MAX_PICKUP_ATTEMPTS` (§35.4.5, `MSC-DEC-116`)|

**On `pickup.collection.confirm`:** §11.4's own clarifying note matters here. The Rider value is a *Rider* capability, not an Ad-hoc Sender one. Ad-hoc Sender holds **no permission in this system** — the code goes to them by SMS and the rider enters it (§21.4, `MSC-DEC-115`).

### `hub`

| Key| Holders| Scope| Notes|
|---|---|---|---|
| `hub.handover.submit`| **R only**| owned completed run||
| `hub.intake.count`| A S P| own hub| Blind count. Guarded on read *and* write (§35.5.2)|
| `hub.intake.itemize`| A S P| own hub||
| `hub.intake.close`| A S P| own hub| State precondition: parity met (§35.6.11)|
| `hub.intake.close_exception`| S P| own hub| The only route to closing without parity (§35.5.5)|
| `hub.intake.reopen`| **P only**| all hubs| Privileged, audited (§36.6)|
| `hub.osd.adjudicate`| S P| own hub| §11.4 row 12. **Not Ops Staff**|
| `hub.setting.propose`| S| own hub| Zones, service days, boundaries (§35.10, `HUB-028`)|
| `hub.setting.approve`| **P only**| all hubs||

### `pricing`

| Key| Holders| Scope| Notes|
|---|---|---|---|
| `pricing.correction.create`| A S P| own hub| §11.1's own example of the key form|
| `pricing.correction.approve`| S P| own hub| Approver ≠ creator|
| `pricing.reprice.request`| A S P| own hub| Post-freeze correction that **changes service area or commercial mode** (§35.6.8 as amended by `MSC-DEC-207`). A crossing within one service area moves no money and must not trigger this|
| `pricing.reprice.approve`| S P| own hub| Requires affected-party notification|
| `pricing.structure.propose`| S| own hub| The hub's fee schedule: service-area base fees, corridor off-day fee, station-drop fee, size-class surcharges, outside-Accra margin (§23.9, `MSC-DEC-207`, `MSC-DEC-218`). The zone-pair matrix and corridor rate cards this once named are **withdrawn**|
| `pricing.structure.approve`| **P only**| all hubs||

### `dispatch`, `delivery`, `courier`

| Key| Holders| Scope| Notes|
|---|---|---|---|
| `delivery.stop.execute`| **R only**| assigned stop| Arrival and OTP request at the door. **Ops holds no doorstep write key** — §25.1 gives no ordinary override, and an Ops actor arriving at a stop would be one|
| `delivery.stop.close`| **R only**| assigned stop| Closes the stop `DELIVERED` or `FAILED`. **Separate from `.execute` because closing is where custody and money move** — the pickup side splits its closing acts from `pickup.run.execute` for the same reason|
| `delivery.otp.override`| **S P**| own hub| **Authorises handover without OTP verification** — §25.1's extraordinary path, inheriting `MSC-DEC-198`'s ladder. **Gate C carries the supervised fallback on this key rather than a second one**: `MSC-DEC-326`'s flow *is* the extraordinary path with its review steps written down, and a rider may raise the problem and may never approve it. Senior Ops rather than Platform Admin: the fact needing verification is **local knowledge**, and routing it upward produces approval without inspection. Enhanced-audited; **the control is frequency**|
| `dispatch.recipient_confirmation.work`| A S P, **R**| A S P: own hub · **R: assigned parcels**| **Widened at C1.6**. `MSC-DEC-347` approves the Rider calling a recipient at `PRE_DISPATCH` and **recording the outcome on the same record Ops writes** — and this row held **A S P only**, so the approved act was unbuildable by the actor the rule names. **The permission was authoritative and the holder list had simply never been extended to match it**, exactly the correction `MSC-DEC-333` made for `pickup.exception.approve`. **The rider's reach is their assigned parcels; it is not hub-wide**|
| `dispatch.run.create`| A S P| own hub||
| `dispatch.run.assign`| A S P| own hub| Sets the rider on a delivery run. **Applies `MSC-DEC-222`'s precedent symmetrically** — assignment is a distinct permissioned act, not a step inside dispatch. Holders **confirmed by `MSC-DEC-232`**, mirroring the pickup key|
| `dispatch.run.sequence`| A S P| own hub| Manual stop ordering (§24.4). Version 1 has **no route optimisation**; the sequence is a plan a rider may depart from|
| `dispatch.run.dispatch`| A S P| own hub| Atomic — one order cannot go to two mechanisms (§35.7.5)|
| `dispatch.run.execute`| **R only**| assigned run| **The rider's key to start and work a delivery run.** Mirrors `pickup.run.execute` exactly — dispatch is Ops, **start is Rider** (§24.6), and the rider may not add or substitute stops. **Added 23 August**: the `dispatch` domain held four Ops keys and nothing for the actor who executes the run, so `startDeliveryRun` was gated by nothing|
| `dispatch.outbound.clear`| A S P| own hub| **Clears a paid outbound order for dispatch**. [state-machines.md](state-machines.md) §9's third-party `→ READY_FOR_DISPATCH` row names Ops, and **no operation performed it**, so no outbound order could be dispatched at all. Refuses until the outbound charge is backend-confirmed paid (§35.7.7, §35.7.8). **The same key re-dispatches** an order at `AT_HUB_AFTER_FAILURE` on the third-party lane, after a failed counter or a covered `RETURNED`, with no new charge. Holders match the other dispatch keys — the Product Owner's ruling|
| `delivery.handoff.perform`| **R only**| owned outbound run| Waybill plus photo for registered handoff (§35.7.9). **In the agent mode the photo stands in for the waybill**, and the agent is named by phone and resolved to an `ACTIVE` `ApprovedAgent` at the rider's hub. **A counter that refuses is not this key's act**: the rider fails the stop under `delivery.stop.close`, with a `HANDOFF_FAILURE` reason|
| `delivery.handoff.outcome`| A S P| own hub| **Records a covered-mode third party's reported outcome** — `IN_TRANSIT`, `DELIVERED`, `FAILED` or `RETURNED` on [state-machines.md](state-machines.md) §10 (`MSC-DEC-417`, closing `OQ-135`). §24.7.2 keeps Melarc responsible *"until final delivery, failure, or return is recorded"*, and until this key **nothing could record it**. `DELIVERED` completes the order and earns the covered charge; `RETURNED` brings custody back to the hub. **A Station Drop reaches none of it** — its handoff is terminal. Holders are the Product Owner's ruling|
| `courier.registry.manage`| S P| **all hubs**| §11.4 row 17. **Not Ops Staff**. **Registers, deactivates and reactivates** entries in the one platform-wide courier/station register (`MSC-DEC-417`, closing `OQ-133`'s first half). **Scope widened from own hub** — the register carries no hub, so a hub-scoped grant bounded nothing; the Product Owner's ruling. Deactivation keeps history|
| `courier.agent.approve`| S P| own hub| **Approves an informal driver or agent into the hub's register, and withdraws approval** (`MSC-DEC-417`, closing `OQ-133`'s second half) — in advance, or on the spot while the rider waits, since agents *"cannot all be pre-registered"*. **An ID-document photo is required before the agent can take custody**, and it is Ops-only. **Not Ops Staff**, like `courier.registry.manage` — the Product Owner's ruling|

### `vendor`, `staff`

| Key| Holders| Scope| Notes|
|---|---|---|---|
| `vendor.organization.create`| A S P| own hub| No public self-registration (§35.12.1)|
| `vendor.organization.approve`| S P| own hub| Creator ≠ approver (§35.12.2), `SELF_APPROVAL_FORBIDDEN`. **This one key carries both halves of §18.2's *"approves or rejects"*** — `decideVendorOrganization` takes `approved: true|false` with a mandatory reason on refusal, the same shape `staff.identity.approve` uses. **There is deliberately no `vendor.organization.reject`**: one decision, one key|
| `vendor.allowance.enable` / `.disable`| **P only**| all hubs| Separate decision from operational activation (§35.12.3)|
| `staff.credential.recover`| **P only**| all hubs| Exceptional staff recovery (§11.2). **Requires an authenticated privileged session holding this key** — there is no action-time elevation. **Resets the password and never the MFA factor**|
| `staff.session.revoke`| **P for staff and vendors; S for riders**| P: all hubs · S: own hub| **Terminates a live session, with a reason** (§37.2). §37.5 requires this for a **compromised shared vendor credential**: the session is cut without waiting for the vendor to change a secret several people know. **Added 23 August** — `revokeSession` stated this authority split in prose and no catalogue key carried it. **Its read is `listSessions`, under `staff.read` and tiered identically** (Gate PD-3R1): a Senior Ops caller naming a staff or vendor session holds the key and not the tier, which is `INSUFFICIENT_AUTHORITY`, never `PERMISSION_DENIED`.|
| `staff.device.revoke`| A S P| own hub| **Revokes a rider's device binding on report of loss or theft**. **Ops Staff hold this and not `staff.device.reregister`, deliberately**: revocation is cheap and reversible, so it must be low-friction or it will not happen promptly. Requires **no identity verification** — verifying before revoking leaves a stolen handset live for as long as the check takes|
| `staff.device.reregister`| S P| own hub| **Rider** device re-registration after Ops identity verification (§11.2, §37.2). Senior Ops, **not Ops Staff** — this is the act that **grants** access, so it stays gated. `MSC-DEC-235` requires the rider to attend a hub **in person**; there is no remote re-binding path, and that is a decision rather than an omission|
| `vendor.pickup_location.manage`| A S P V| **V: own vendor only** · **A S P: own hub**| **Add, edit, set default and deactivate a vendor's saved pickup locations.** Both halves are approved: §29.1 makes this an internal Ops capability, §29.4 gives the vendor it. **No serviceability check here** — §11.3 revalidates per request. **No hard delete** — §8|
| `vendor.credential.recover`| **P only**| all hubs| Exceptional vendor recovery (§11.2). Privileged. For a shared credential this is how access is removed from someone who knows the secret|
| `vendor.suspension.create`| S P| S: own hub, reason and audit · P: direct| §29.6, `MSC-DEC-168`|
| `vendor.suspension.lift`| S P| **S: own hub, and only where the suspension was created by hub Senior Ops** · **P: all hubs, and the only authority that can lift a Platform Admin suspension**| **Reactivation** (§29.6, `MSC-DEC-397`). **Symmetric or higher**: a hub suspension is liftable by that hub or by P; a P suspension only by P. Reason and audit mandatory. Lifting **resumes every remaining `HELD` hold in one act** — §29.6 already says the hold persists *until reactivation or a disposition decision*|
| `vendor.organization.terminate`| **P only**| all hubs| **Ends the relationship, not the debt** (§29.6, `MSC-DEC-397`). Entered **only from `SUSPENDED`**, **only with no `VendorSuspensionHold` still `HELD`**, reason mandatory, enhanced audit. Outstanding obligations survive and stay payable|
| `vendor.held_parcel.decide`| S P| own hub| Hold or return (§29.6, `MSC-DEC-142`)|
| `vendor.sender_block.create`| S P| **S: `HUB_LOCAL`, own authorised hub only** · **P: `PLATFORM_WIDE`, all hubs**. Reason mandatory in both; **enhanced audit on the platform-wide act**| **Blocks an individual or ad-hoc sender from future bookings** on one of §29.6's four grounds (`MSC-DEC-258`, closing `OQ-038`). **Attaches to the verified phone identity** (§29.7, `MSC-DEC-172`), never a name — a block against a name blocks nobody. Refusal returns the existing `SENDER_SUSPENDED`. **Reversal is unspecified**: `OQ-033`, `SLICE-008`. Operation lands with that slice|
| `vendor.held_parcel.escalate`| **P only**| all hubs| To claims or security. **A parcel-level act** — the vendor-level hold is `vendor.security_hold.manage`|
| `vendor.security_hold.manage`| **P only**| all hubs| **Opens and clears a vendor-level `SecurityRiskHold`** (`MSC-DEC-414`, closing `OQ-128`) — §35.12.8's fourth condition, which had no authority until now. **Mandatory reason both ways, Enhanced audit.** An open hold stops new business and keeps work in flight. **Platform Admin only**, like the repository's other security path: fewest holders means the fewest people who learn a hold exists|
| `vendor.contact_assistance.submit`| **Vendor only**| own record| **A Vendor responding to a recipient-contact exception on their own order** — a corrected number, an alternative contact, a clarification. **An input, never an authority**: Ops applies the controlled correction, and a response captured by Ops from official WhatsApp carries identical weight. Scope is the Vendor's own order relationship and nothing wider|
| `staff.identity.create`| A S P| own hub| **Creates a staff profile in `PENDING_APPROVAL`.** §30.8's maker. It grants nothing — no session may be issued against a pending record ([state-machines.md](state-machines.md) §13.3). **It gates `createStaffIdentity` and nothing else.** The bundles the maker may name are read under `permission.assignable_bundle.read`, a separate key held by the same three bundles, and `createStaffIdentity` validates the `role_bundle_id` it receives whatever its source.|
| `staff.identity.approve`| S P| own hub| **§30.8's checker — the act that makes a staff record usable.** Approver ≠ creator (§11.6). **`P` required where the named bundle is privileged** (`MSC-DEC-248`, confirmed)|
| `permission.bundle.assign`| A S P| own hub| Proposes a bundle change on an **existing** staff record. §30.8 reaches creation only; §30.3 requires changes and named no authority until `MSC-DEC-248`, **confirmed 26 August**. **One gap, recorded and not closed** (Gate PD-3R2): Ops Staff hold this key and not `staff.read`, and `proposeBundleChange` takes its `If-Match` from `getStaffIdentity`, so an Ops Staff holder cannot read the version the operation requires; `SLICE-009`, which builds it, decides whether the holders or the read changes|
| `permission.bundle.approve`| S P · **P required where the target bundle is privileged**| own hub · P: all hubs| Assigner ≠ approver (`MSC-DEC-248`, **confirmed 26 August**). The privileged-target rule closes a real asymmetry: without it a Senior Ops could **create** a peer they may not **suspend** under §30.9|
| `permission.assignable_bundle.read`| **A S P**| **none — global configuration**| **Reads the staff role bundles a maker may name** (`MSC-DEC-443`, closing `PDA-71`; it replaces the gate `MSC-DEC-439` gave the read). Gates `listAssignableStaffRoleBundles` and **nothing broader**: for each bundle **currently assignable to human staff** it returns only the **identifier, the display name and whether a Platform Admin must approve the assignment** — **never a bundle's permissions, a permission count, a permission holder, the fixed Rider and Vendor bundles or a proposed bundle**. **A read needs a read key** — the consistency test must reject the mismatch any `GET` gated by a key that does not end `.read`, and `payment.ledger.read` is the precedent for a narrow read taking a key of its own. **Scope is none**: a bundle is configuration and not hub data, so the answer is the same at every hub, no hub is named or evaluated, and the key confers **no cross-hub staff-record access** ([SECURITY_DESIGN.md](../architecture/SECURITY_DESIGN.md) §14.1a). **It permits nothing else**: creating a profile is `staff.identity.create`, proposing a change is `permission.bundle.assign`, approving is `staff.identity.approve` and `permission.bundle.approve`, and **`permission.read` is not broadened** — it stays Platform Admin's alone and gates no operation. **Held by exactly the bundles that hold `staff.identity.create`, and not by Rider, Vendor, Finance, Auditor or Executive merely because it is a read**: the Auditor's *every `<domain>.read`* means the sixteen domain-level keys of the read table below, and this narrow key is not one of them|
| `staff.mfa.reset`| **P only**| all hubs| **Resets another privileged identity's MFA factor**. Mandatory reason; **enhanced-audited**. Revokes the factor, terminates every target session with `MFA_RESET`, and issues a re-enrolment grant. **The holder cannot turn MFA off** — reset re-issues, it does not exempt. Platform Admin only **because MFA is the control protecting Platform Admin itself**|
| `staff.device.register`| **S**| own hub| **Initial** rider device binding, in person. Deliberately a **separate key** from `staff.device.reregister` rather than a widened reading of it: widening would leave the catalogue unable to say which act was authorised. The officer initiates the binding and **never learns the rider's PIN**|
| `staff.identity.offboard`| S P| S: own hub · **P required** if the target holds a privileged bundle| **Mirrors §30.9's suspension tiering**. §30.10's effects are fixed: access and credentials revoked immediately, **all history preserved**, any motorcycle through §30.7's formal transfer. **Not maker-checker** — the day this matters most is a security dismissal, and onboarding can wait for a checker while revocation cannot. Operation lands with `SLICE-009`|
| `staff.suspension.create`| S P| S: own hub · **P required** if target is Senior Ops or Platform Admin| §11.4 row 24|
| `staff.assignment.request`| S| own hub| Temporary hub assignment, primary-hub side|
| `staff.assignment.approve`| S| receiving hub| Receiving-hub Senior Ops (§35.10)|

### `settings`, `returns`, `audit`

| Key| Holders| Scope| Notes|
|---|---|---|---|
| `payment.cash.collect`| **R only**| assigned stop| **Records the cash tender a recipient actually handed over at the door** (§26.2) — short, exact or over — as a `CASH` `PaymentReceipt` and as rider custody. Rider-held because the rider is the only actor present. **It satisfies nothing by itself**: the delivery gate is the `OperationalPaymentDemand` reaching `SETTLED`, which a short tender does not reach. And it **closes nothing** — the workday stays financially open until hub reconciliation (§36.11).|
| `payment.cash.handover`| **R only**| own hub| Opens a `CashHandover` at the **responsible hub** with a declared total (§26.3)|
| `payment.cash.confirm`| A S P| own hub| **Hub-confirmed receipt** — the second of §26.3's three figures. **Never held by a rider**: one actor supplying both the declared and the confirmed total makes the comparison meaningless, exactly as at the §22.4 blind count|
| `payment.variance.resolve`| S P| own hub| Dispositions a cash shortage or overage with a **mandatory reason** (§26.3). Senior Ops, not Ops — the run cannot be financially closed until this happens, so it is the act that releases a financial hold|
| `fleet.custody.initiate`| A S P| own hub| Opens a `RunCustodyHandover` on an `IN_PROGRESS` run. Ops-held because a stranded rider cannot open their own — which is the scenario|
| `fleet.custody.return`| **R only**| **the run whose parcels this rider holds**| **Declares the undelivered parcels coming back to the responsible hub** at the end of a delivery run. Rider-held because the rider is the one holding the parcels, and **the scope is written on custody rather than assignment** (`OQ-129` R1): today the two coincide on a delivery run, because no delivery-run custody transfer exists, and writing the rule on custody means creating one later does not require rewriting it. **The operation declares `NOT_ASSIGNED_RIDER` and `NOT_CUSTODY_HOLDER` both**, which describe different people after a transfer. **Declaring is not receiving** — the hub confirms under a different key, exactly as `payment.cash.handover` and `payment.cash.confirm` split the same act for cash|
| `fleet.custody.receive`| A S P| own hub| **Confirms receipt, and this is where custody transfers**. **Never held by a rider**: a rider who can confirm their own return can close a run over parcels nobody counted, the separation `AC-SLICE-003-16` already makes for cash|
| `fleet.custody.variance_resolve`| **S P**| own hub| Dispositions a missing or undeclared parcel on a `VARIANCE_OPEN` return. **Senior floor**, mirroring `payment.variance.resolve`; a variance is dispositioned, not erased|
| `fleet.custody.read`| **R**, A S P| **R: party to the handover, or own parcel custody return** · A S P: own hub| **Reads the custody records an actor is a party to** — `RunCustodyHandover` and, from `OQ-129` R1, `ParcelCustodyReturn`: **R** the handovers they are party to and **their own returns**; A S P their own hub's (`MSC-DEC-406`, closing `OQ-136`). **The authority is not new**: [data-scope-registry.md](data-scope-registry.md) grants a Rider `SELECT` on `RunCustodyHandover` where they are *"party to the handover"*, and **no operation exposed it**, so a rider named as receiver could be told only by telephone. **Narrow on purpose, and not `fleet.read`** — which is `S P` plus Fleet Manager at own hub and would hand a rider the whole fleet domain. The same shape `payment.run_position.read` took at `MSC-DEC-361` for the same reason|
| `fleet.custody.accept`| **R**, A S P| R: named receiving rider · A S P: own hub, where the destination is the hub| Takes custody. **Completion authority follows this key** — only the holder may complete the run or submit the hub handover, which is what makes closing a run whose parcels nobody accepted structurally impossible|
| `pickup.request.override_window`| A S P| own hub| **Schedules or approves a pickup outside the customer service window**. Records the original window, the revision, the actor, the reason, the customer notification state and the timestamp. **An out-of-window act is never counted as ordinary SLA performance**|
| `hub.parcel.assess_handling`| A S P| own hub| **Records a parcel handling assessment** — `STANDARD_HANDLING`, `REQUIRES_REVIEW`, `NOT_ACCEPTABLE`. A transport-safety judgement with a mandatory reason on the latter two. **Never a pricing act**|
| `delivery.commitment.revise`| A S P| own hub| **Revises the committed delivery date or window**, recording the old value, the new value, who requested it, who approved it, the attribution reason and the timestamp. **A rider does not hold this** — an instruction given at a door is recorded and passed to Ops|
| `payment.collection.read`| **R only**, A S P| R: **assigned stop** · A S P: **own hub**| **Reads the state of a collection the holder is entitled to see** — a Rider polls the attempt on **their own assigned stop**; Ops reads within hub scope. **Deliberately narrower than `payment.read`**, which carries hub-wide reconciliation: a rider needed a status poll, not a finance view. **It reaches no other rider's collections and no unrelated customer payment**|
| `payment.momo.collect`| **R only**, A S P| R: **assigned stop** · A S P: **own hub**| **Initiates a digital collection through the shared engine**. The holder asks for money and **supplies only the payer's number** — the amount is server-derived. **It confers no power to confirm receipt**: provider truth is applied by the trusted service identity, and no human key can mark a collection `SUCCEEDED`|
| `payment.momo.confirm_manual`| S P, **Finance**| own hub · all hubs| **Confirms Merchant MoMo receipt out of band** when the integrated provider is unavailable. **Never held by a rider.** A screenshot is not proof, and the person completing the delivery is not the person confirming the payment|
| `payment.run_position.read`| **R only**, A S P| R: **own run** · A S P: **own hub**| **Reads one rider's own run money position** — road-expense status and whether an expense was applied, the run cash summary, the expected handover, the hub's counted result and their **own** variance. **Deliberately narrower than `payment.read`**, which is hub-wide reconciliation held by Ops, Senior Ops, Platform Admin and Finance and **by no rider**. Five approved rider rows named that key and were therefore unbuildable. **It reaches no other rider's run, no hub daily position and no unrelated customer payment**, and **reading a variance is not resolving one**|
| `payment.road_expense.record`| **R only**, A S P| R: own run · A S P: own hub| **Records an operational expense incurred on the road** with its category, amount, funding source and evidence. Rider-held because the rider is the actor who spent the money|
| `payment.road_expense.approve`| S P| own hub| **Approves or rejects a road expense**. Senior Ops, not Ops — **only an approved `COLLECTION_CASH` expense reduces a rider's expected cash handover**, so this key is the one that can move money out of a rider's accountability. A claimed or rejected expense leaves the cash owed|
| `payment.cash.reconcile_hub`| S P, **Finance**| own hub · all hubs| **Completes the end-of-day Hub cash reconciliation** — expected Hub cash against physical count. Separate from `payment.cash.confirm`, which accepts **one rider's** handover: this one closes the **hub's** position, and hub-level variance is not rider-level variance|
| `payment.cash.disposition`| S P, **Finance**| own hub · all hubs| **Records the approved final destination of physical cash** — bank deposit, Merchant MoMo transfer, Finance handover, approved safe custody — with amount, method, destination, reference, actor, timestamp and evidence. **Cash is not settled because a rider handed it to a hub**|
| `payment.adjustment.resolve`| S P| own hub| **Proposes how a `FinancialAdjustmentRequired` is resolved** — refund, credit, allocation or unclaimed disposition, with method, destination and reference. Senior Ops, not Ops: money owed back is not an ordinary operational act|
| `payment.adjustment.approve`| **Finance**, P| all hubs| **Approves or rejects a proposed resolution**. **Never the proposer** — `SELF_APPROVAL_FORBIDDEN`. Finance rather than Senior Ops because outbound and cross-hub money already sits here (`payment.cash.disposition`, `payment.cash.reconcile_hub`), while the maker-checker shape comes from `payment.road_expense.approve`|
| `payment.ledger.export`| **Finance**, P| all hubs| **Requests a canonical accounting export of the payment-fact ledger, and obtains a retrieval authorization over a generated package**. Gates `requestAccountingExport` and `createAccountingExportRetrievalAuthorization`. **Not Senior Ops** — §32 requires company-wide export access to be *"explicit, not implied by ordinary Senior Ops status"*, and that sentence decides the holders rather than any judgment here. Placed where cross-hub money authority already sits: Finance holds `payment.read`, `payment.cash.reconcile_hub`, `payment.cash.disposition` and `payment.adjustment.approve` at all hubs. **Issuing a capability over a period's payment facts is not a lesser act than requesting one**, so the retrieval authorization earns no weaker key than the request. **`SINGLE_HUB` scope still requires the all-hubs holder** because no hub-scoped variant exists.|
| `payment.ledger.read`| **Finance**, P| all hubs| **Lists and reads accounting-export records — metadata, row counts and manifest digest, never a package and never a row of payment data** (`MSC-DEC-401`, v1.39). Gates `listAccountingExports` and `getAccountingExport`. **A read needs a read key, and this catalogue has decided that twice already**: `payment.collection.read` and `payment.run_position.read` both exist because a narrow read was being gated by a broad key. **It confers no retrieval authority whatever** — a package is reached only through `payment.ledger.export`, one object at a time — and it is **deliberately narrower than `payment.read`**, which carries hub-wide reconciliation. Same holders and scope as `payment.ledger.export`, because **the metadata answers who exported what, over which period**, and that is the same company-wide question §32 makes explicit|
| `settings.reason.read`| **R only**, A S P| R: **assigned stop or run** · A S P: **own hub**| **Reads the ACTIVE reason catalogue** — the codes a rider may select and each code's `consumes_delivery_attempt` metadata. **Deliberately narrower than `settings.read`**, which carries a hub's configured values **including its fee schedule**: the doorstep failure screen required that key, which no rider bundle holds, so **an approved rider act was unbuildable**. **It reads codes, never values, and never edits one**|
| `settings.reason.manage`| S P| own hub| Reason pills and their mandatory-field metadata (§35.9.2). **Gate C widens the metadata** to attribution — `CUSTOMER`/`MELARC`/`EXTERNAL` — plus `consumes_delivery_attempt`, `requires_ops_review` and `requires_escalation`. **Selecting a reason in operational work is not this authority**: a rider picks from the catalogue and may never edit what a code does|
| `settings.global.approve`| **P only**| all hubs||
| `settings.retention.manage`| **P only**| all hubs| Sole authority (§38.7, `MSC-DEC-150–152`)|
| `returns.initiate`| A S P| own hub| **Commits a `ReturnRecord`** — the deliberate Ops act that starts financial Return processing. Never a rider, never automatic on a third failed attempt|
| `returns.close`| **R**, A S P| R: assigned return · A S P: own hub| **Requests the return OTP and closes physical custody against it** (§28.4). Held by **both** classes because the signed fulfilment machine names *"Rider or Ops"* as closer — a rider executes a physical drop-off; Ops closes a return the vendor collects in person at the hub counter|
| `returns.waiver.request`| A S P| own hub||
| `returns.waiver.approve`| S P| own hub| Approver ≠ requester (§28.4, `MSC-DEC-163`)|
| `audit.log.read`| Auditor| all hubs||
| `audit.log.export`| Auditor| all hubs| Enhanced-audited per §38.5|

**No `payment.refund.*` key exists, and that is a settled boundary, not an omission** — HIGH-04 audit remediation. `FinancialAdjustmentRequired` (`MSC-DEC-357`, [domain-model.md](domain-model.md)) records that money is owed back and deliberately writes only `OPEN`: *"refund, credit and allocation are Accounting & Reporting's, and deciding them here would put a refund policy in a delivery specification."* A permission key with no operation to gate is unbuildable and untestable — this catalogue does not create speculative authority for work nobody has specified, the same discipline `SECURITY_DESIGN.md` states for worker capabilities. The remedy is owned by `OQ-005`, narrowed at Gate C R1 to *"deeper payment allocation, reversal and refund design"* inside the future Accounting, Finance & Reporting domain — not yet opened, and not this catalogue's to pre-empt.

**The write/action rows and the read entries added by `MSC-DEC-221` are counted by the block below, and this sentence restates no count of either** — only a span of domains, which the block does not derive: the write tables span **fourteen** of the seventeen.

**Seven of those "write/action" keys are reads, and the accounting is deliberate.** `payment.collection.read`, `payment.run_position.read`, `settings.reason.read`, `audit.log.read`, `payment.ledger.read`, `fleet.custody.read` and now `permission.assignable_bundle.read` sit in the §7 catalogue rather than in *Read permissions — all domains*, because that table is **one broad key per domain** and these are narrow sub-domain reads. The count block's *write/action* label is therefore a statement about **which table a row is in**, not about whether the key writes. **Do not "correct" it by moving a row** — the read table would stop being one-key-per-domain, and `payment` already holds `payment.read` there.

**"Sixteen of the seventeen" was wrong here until 24 August**, and it is the recurrent defect in its purest form. The write tables spanned **twelve** domains when that phrase was written; sixteen is the count of *read* keys, sitting in the next clause of the same sentence, and it migrated backwards into a claim about a different table. Nothing failed, because no check reads a domain span. **Derived above, not restated.** **`fleet` gained its first write keys on 23 August**; it had held `fleet.read` alone since the catalogue was written, which is why a stranded run had no operator. **`permission` gained its first write keys on 24 August**; it had held `permission.read` alone, which is why nobody could grant authority to anybody.

**`dispatch.run.execute` and `staff.session.revoke` were added on 23 August, and how they were found is the point.** Neither came from reading this catalogue. Both surfaced while mapping **every operation to the permission that gates it** for `MSC-DEC-243` — `startDeliveryRun` was gated by nothing, and `revokeSession` stated an authority split in prose that no key carried. **That is occasions six and seven** of the pattern `OQ-070` tracks, and it is also that question's answer: deriving the catalogue **from operations** is what finds what reading §11.4's matrix does not. `staff.device.revoke` was added on 23 August by `MSC-DEC-235`.

**These figures were two low until 23 August, and the correction is worth keeping visible.** The block below read 55 rows / 56 keys / 72 grantable. A fresh extraction gives 57 / 58 / 74 **before** `staff.device.revoke` was added — so two keys had been added to §7 without this block being re-derived. The drift is silent by construction: nothing fails when a table grows and a paragraph does not.

**Note what this does to the warning below.** It cautions that a failing count check is a claim about the **extraction** as much as about the document. That remains true — and here the extraction was right and the document was wrong. The warning is a reason to check both, not a reason to trust the prose.

**A counting trap worth naming**, because it produced two wrong answers during this revision before it produced a right one. `vendor.allowance.enable` / `.disable` is **one table row declaring two keys**, so the row count and the key count differ permanently:

|| Count|
|---|---|
| Write/action **rows**| 110|
| Write/action **keys**| 111|
| Read keys| 16|
| **Total grantable keys**| **127**|

Both numbers are correct answers to different questions, and **the key count is the one that matters** — a bundle holds keys, not rows. State which is meant whenever either is written. A check anchored on rows will report a false discrepancy here forever, which is the failure the standards warn about: a failing count check is a claim about the extraction as much as about the document.

### Read permissions — all domains

One key per domain. **Scope is on the grant, not the key**: `pickup.read` held with *own hub* scope reads that hub's pickups; the same key at *all hubs* reads every hub's. The key answers **what** may be read and never **by whom**.

| Key| Holders| Scope| Notes|
|---|---|---|---|
| `pickup.read`| A S P, Rider, Vendor| own hub · assigned · own record| Rider reads **assigned** stops only; Vendor reads **own** requests only|
| `hub.read`| A S P| own hub| Intakes, handovers, OS&D. **Does not lift the blind-count guard** — see below|
| `pricing.read`| A S P, Finance, Vendor| own hub · own record| Vendor reads the fee on **own** orders|
| `dispatch.read`| A S P, Rider| own hub · assigned| Also gates the **rider roster** — `listRiders` and `getRider`: identity and readiness only (name, phone, status, hub, whether a PIN and an `ACTIVE` device exist, and in `getRider` the devices the rider has held — identity, status and dates, never a key), on the browser surface only: **a Rider's Bearer session holds this key for its own assigned work and is refused these two reads (`PERMISSION_DENIED`)**, so no handset can read the roster. It is the roster dispatch already needs to assign a manifest, and the read `registerRiderDevice`, `reregisterRiderDevice` and `revokeRiderDevice` find their target with (Gate PD-3R1; **confirmed by the Product Owner at Gate PD-3R2, `MSC-DEC-436` — no `rider.read` key exists**).|
| `delivery.read`| A S P, Rider, Vendor| own hub · assigned · own record||
| `payment.read`| A S P, **Finance**| own hub · all hubs| Finance holds it at all hubs — reconciliation is cross-hub by nature|
| `settlement.read`| S P, **Finance**, Vendor| own hub · all hubs · own record| Vendor reads **own** statements|
| `returns.read`| A S P, Vendor| own hub · own record||
| `vendor.read`| A S P, **Finance**| own hub · all hubs| Also gates the **vendor-account authentication reads** — `listVendorAccounts` and `getVendorAccount`: identifier, organisation and its responsible hub, status, whether a secret exists, how many browsers are `ACTIVE` and whether a recovery email or phone exists, **never a credential or a recovery address** (Gate PD-3R1; **confirmed at Gate PD-3R2, `MSC-DEC-436` — no new key**). **A `VendorAccount` stays a global master record, but these two reads enforce the caller's grant scope**: a hub's staff read an account only where its `VendorOrganization`'s responsible hub is one of theirs, and Platform Admin and Finance read across hubs only where their grant reaches every hub; an existing account outside the caller's hubs is `HUB_SCOPE_VIOLATION` and one that does not exist is `NOT_FOUND`. **No key is added.** Ops Staff and Senior Ops hold the key at their own hubs, Platform Admin and Finance at all hubs. `reissueVendorCredentialSetup`, which takes the account's ETag, acts at the vendor's own hub, and `recoverVendorCredential` is Platform Admin at all hubs (`data-scope-registry.md`).|
| `staff.read`| S P| own hub| **Not held by Ops Staff.** It also gates the reads that find an approver's target — `getStaffIdentity`, `listStaffIdentities` and `listSessions` — which is why the maker of an identity learns its id from the creation response and a *different* person finds it in the queue (Gate PD-3R1).|
| `notification.read`| A S P| own hub| The domain's first permission of any kind|
| `report.read`| S P, **Finance**, **Executive**| own hub · all hubs| The domain's first permission of any kind|
| `settings.read`| A S P| own hub| A hub's configured values, including its fee schedule|
| `fleet.read`| S P, Fleet Manager| own hub||
| `courier.read`| A S P, **Rider**| own hub · **active entries**| **Staff** read the platform-wide register — it carries no hub, so the grant's hub scope bounds only the hub's approved agents. **A rider reads the register's `ACTIVE` entries and nothing else**: a registered-mode capture names a `courier_provider_id`, and a rider had no way to learn one. **The approved-agent register is withheld from riders structurally** — no operation serves it on a rider session, the way `hub.read` leaves the blind count to the schema. A rider names an agent by phone and the server resolves it|
| `permission.read`| **P only**| all hubs| Who holds what. **Never exposed on a Vendor or Rider surface** (§11.1, `MSC-DEC-134`). **No operation in the contract requires it**: the read that returns the bundles a maker may name is `permission.assignable_bundle.read`'s (`MSC-DEC-443`, which replaced the gate `MSC-DEC-439` gave it)|

**Sixteen keys, not seventeen.** `audit` already holds `audit.log.read` and `audit.log.export`, both explicitly confirmed, and gains nothing here.

**`hub.read` deliberately does not unlock the blind count.** §35.5.2 guards `hub.intake.count` on read as well as write, and that guard is **structural**: `HubIntakePreCount` has no `rider_declared_count` property at all. A domain-level read key must not be mistaken for a route around it — **the count is withheld by schema, not by permission**, so no grant can expose it and no bundle needs to be trimmed to prevent it.

**`staff.read` is withheld from Ops Staff on purpose.** Every other domain read follows the work. This one does not: colleague identity records are personal data, and working alongside someone is not a reason to read their record (§19.9, §38.2).

### 7.1 Domains that can be read and not written

**A domain with a read key and no write keys is a domain nobody can act in.** That sounds like an accounting curiosity and has produced three live defects in one day, so every such domain is listed here with the thing that owns it. **the consistency test must reject the mismatch on any domain missing from this table.**

| Domain| Write keys| Accounted for by|
|---|---|---|
| `settlement`| none| `SLICE-007`. `OQ-005`|
| `notification`| none| `SLICE-010`. `OQ-048` owns the provider|
| `report`| none| `SLICE-012`. **`OQ-049` owns formulas and *report* exports.** The **accounting export** is a different artifact with different authority — §27.4 and §50.2, owned by `OQ-005`, gated by `payment.ledger.export` and `payment.ledger.read`, carrying source payment facts to an external accounting system rather than rendered report data to a person. **Two questions cannot own one artifact**, which is how `OQ-048`/`OQ-109` once let a dependency survive in one while the other closed. **Read-only may well be correct here** — a report is consumed, not written — but that is a conclusion to reach rather than assume|

**`delivery` was never in this table, and a placeholder row claiming it was stood here for two hours on 26 August.** The claim — repeated into three feature documents and a slice — was that `delivery` held `delivery.read` and no write key, a *fourth* instance of the read-only shape. **It is false.** `delivery.handoff.perform` has been in §7 since the catalogue was written, derived from §11.4's *"Perform courier handoff — Rider, owned outbound run only."*

**`payment` left this table on 24 August too**. It had held `payment.read` alone since the catalogue was written, which meant **no actor could record that a recipient paid cash** — the ordinary outcome of §5.2's default payer intent. `RiderCashCustody` is written at [state-machines.md](state-machines.md) §16 and four keys came with it.

**`permission` left this table on 24 August, and it left with operations rather than keys alone.** `permission.read` showed who held what and **nothing changed it**, while `staff-authentication.md` §4 required an assigned bundle — `CONFLICT-035`. `MSC-DEC-248` adds `permission.bundle.assign` and `.approve`; `MSC-DEC-247` adds `staff.identity.create` and `.approve`. **Adding the keys without the calls would have emptied the row while the hole stayed open**, which is the one way this table can be made to lie: it reports what the catalogue says, and the catalogue is not the API. The keys, the operations and the audit events landed in one change.

**`fleet` left this table on 23 August.** It held `fleet.read` alone, which is exactly why a rider stranded mid-run had no operator — `CONFLICT-034`, closed by `MSC-DEC-246`'s two custody keys.

**Why this table is not simply a to-do list.** All three remaining rows are legitimate: their slices are unwritten and adding keys now would be inventing holders for work nobody has specified. **Every live hole it was built to surface is now closed** — `fleet` and `permission` because nobody could act at all, `payment` because nobody could record a cash payment. **`delivery` was never one of them.**

**Three domains left this table in three days, and the table found none of them.** It made them *visible*; a reader had to notice that `SLICE-004` being unwritten did not make it acceptable for the **default** payer intent to have no write path. **An accounting table stops a defect being invisible. It does not stop it being ignored** — which is the argument for keeping the remaining three rows narrated rather than reduced to a slice number.


### 7.2 Gate C reused what already existed

**Ten keys were added and seven authorities were deliberately not.** The instruction asked for the Exception Ownership Matrix to name an authority for each Gate C exception, and the answer was already in this catalogue for these:

| Gate C authority| Existing key|
|---|---|
| Rider cash handover **receiver**| **`payment.cash.confirm`** — A S P, own hub. Already **never held by a rider**, because one actor supplying both compared figures is not a comparison|
| Cash **variance** resolution| **`payment.variance.resolve`** — S P, own hub, mandatory reason. Already Senior Ops rather than Ops|
| **Reason catalogue** administration| **`settings.reason.manage`** — S P. Gate C widens the metadata it governs and adds no key: §35.9.2 already made reason metadata configuration|
| Return Fee **waiver**| **`returns.waiver.request`** and **`returns.waiver.approve`**, approver ≠ requester|
| Rider **cash collection** at the door| **`payment.cash.collect`** — R only, assigned stop|
| Rider **handover declaration**| **`payment.cash.handover`** — R only|
| **Vendor operational eligibility** read| **`vendor.read`** — the projection is derived from records this key already reaches|
| **OTP / verification fallback** authorisation| **`delivery.otp.override`** — S P, own hub. `MSC-DEC-326`'s supervised fallback **is** §25.1's extraordinary path with its review steps written down|
| **Single-package approval**| **`pickup.exception.approve`** — the maker-checker pair already existed. `MSC-DEC-333` **widens its holders** off `P only`; it does not add a key|

**Adding a second key beside an existing one is how a catalogue stops being closed.** §11.6's closed list works only if the first question asked of a new authority is whether it already exists.

## 8. Bundles

§11.3 confirms eleven actors. A bundle is "a named, editable bundle of permissions… it carries no authority beyond the permissions it currently contains" (§11.1).

**Nesting for hub-operational authority** (§11.6, verified against §11.4):

```
Ops Staff
  └─ + hub.osd.adjudicate
     + pricing.correction.approve
     + pickup.attempt.extend          → Senior Ops
        └─ + courier.registry.manage
           + courier.agent.approve
           + settings.reason.manage
```

**`pickup.exception.approve` left the Platform Admin tier at Gate C** and now sits with Senior Ops, or with an Ops Staff member explicitly granted it. It is the clearest case of §11.6's own rule that **scope attaches to the grant**: the key says one-package approval, and who may do it where is a grant.

**This nesting is illustrative, not exhaustive** — §11.6 says so explicitly. Platform Admin additionally holds company-wide authorities with **no Senior Ops equivalent**: global settings and allowance approval, sole retention authority, direct vendor-suspension override, and pricing-structure approval. Treating Platform Admin as "Senior Ops plus one permission" would silently drop those.

The nesting is what makes a new job family additive: a new bundle is composed from the existing catalogue, "not a new authorization code path" (§11.6).

**Two read-only bundles, not three.** Auditor and Executive/Report-consumer hold **no write or approve permission anywhere** (`MSC-DEC-138`, `139`), so their entire contents are reads. **Finance/Reconciliation is not one of them**. Until `MSC-DEC-221` no read key existed and **those bundles could not be defined at all**.

**Finance is the exception, and it became one after this paragraph was written.** `MSC-DEC-136` gave Finance/Reconciliation no write permission on 20 August, and that was true then. **Gate C then gave Finance four**, and nothing re-read the sentence: `payment.momo.confirm_manual`, `payment.cash.reconcile_hub` and `payment.cash.disposition`, and `payment.adjustment.approve` — **the last of which is an approval, the word this paragraph specifically ruled out**. The current permission assignments apply, so **Finance holds write and approve authority today**.

**Settled by `MSC-DEC-396`, 20 September 2026: those four keys belong to Finance/Reconciliation.** There is **one Finance role, and it both reads and acts** — which ratifies what the holders column has said since Gate C rather than renaming four rows to mean something other than the name already on them. A separate operational-finance bundle was the alternative and was set aside for exactly that reason. **`OQ-127` closes.** **The Auditor and Executive rows stay `PROPOSED`**: neither was in question, and signing what nobody asked about is not a decision that was taken. Proposed contents:

| Bundle| Reads| Scope|
|---|---|---|
| **Finance/Reconciliation** — **not read-only**| **Reads:** `payment.read`, `settlement.read`, `vendor.read`, `pricing.read`, `report.read` · **Writes and approvals:** `payment.momo.confirm_manual`, `payment.cash.reconcile_hub`, `payment.cash.disposition`, `payment.adjustment.approve`| all hubs|
| **Auditor**| `audit.log.read`, `audit.log.export` *(existing)* plus every `<domain>.read`| all hubs|
| **Executive/Report-consumer**| `report.read`| all hubs|

**The Finance/Reconciliation row is `CONFIRMED` by `MSC-DEC-396`; the other two remain `PROPOSED`.** Holder assignments remain product choices for the Product Owner. The key list is engineering; **which bundle holds which key is not.** The Auditor and Executive rows still need signature before they govern.

Note what Finance does **not** hold: `fleet.read`, `staff.read`, `hub.read`. Reconciliation does not require reading maintenance records, colleague identities or intake operations — and that separation is precisely what a no-read-key model could not have expressed, since all three bundles sit on the same surface and read across all hubs.

**Fleet Manager** is hub-scoped fleet, maintenance and fuel authority identical to Senior Ops's capabilities, and is **additive only** — it does not narrow Senior Ops (§30.7, `MSC-DEC-141`).

**Vendor and Rider each carry exactly one fixed, non-configurable bundle** in Version 1, and **no Vendor- or Rider-facing screen may expose bundle or permission management** (§11.1, `MSC-DEC-134`). This is a surface constraint as much as a permission one.

## 9. Access boundaries and enforcement

From §37.3 and §37.6, these are testable statements rather than principles:

- A vendor account accesses only its own requests, orders, tracking and directly related approved records. Melarc Vendor is **not a SaaS tenant workspace** — no separate database, schema, tenant or vendor-admin console is implied (§37.6).
- Ordinary Ops and hub staff are restricted to authorized hubs. Platform Admin and approved HQ roles may hold audited cross-hub and cross-vendor access.
- Riders access only assigned work and permitted personal or vehicle information.
- Recipients have no portal account; payment and OTP links reveal **minimum transaction context** only.
- Suspension blocks the shared vendor credential and controlled non-terminal work.

**§37.6 sets a testing obligation, not just a design one:** "every query, export, notification, file, and API operation must enforce vendor ownership and hub/role scope with **negative-access tests**." Negative tests — proving the wrong actor is refused — are required at every one of those five surfaces, not only at the API. An export or a notification that leaks across vendors fails this regardless of how well the API is guarded.

**Never trust the frontend** for totals, prices, OTP assertions, payment success, ownership, hub assignment or status transitions (§37.1). Every one of those is an authorization or integrity decision the backend owns.

## 10. Shared vendor credential

Version 1 deliberately uses one shared credential per vendor organization (§11.1, §37.5), which has consequences this document must carry rather than leave to interpretation:

- **Audit identifies the vendor account, not a named employee.** The UI **must not claim person-level attribution** (§37.5) — a screen reading "approved by Ama" would be a false statement the data cannot support.
- One active session per credential; a new successful login ends the earlier one (§11.2).
- Credential recovery or change must revoke or control prior sessions.
- A future multi-user model must preserve the vendor's historical records.

## 11. Authentication baseline

Confirmed at §11.2 and §37.2. Recorded here because it bounds who can hold a permission at all; mechanics belong to security architecture and OpenAPI.

| Actor| Authentication| Recovery|
|---|---|---|
| Ops, Senior Ops, Platform Admin| Email and password| Verified work email; Platform Admin handles exceptional cases|
| Senior Ops, Platform Admin| **MFA required before privileged access**||
| Rider| Registered phone plus private PIN, **one registered device**| Ops identity verification and device re-registration; Senior Ops handles|
| Vendor| Shared credential, **one active session/device**| Registered phone or email|

§37.8 sets a hard gate: login, vendor records, rider access, OTP, payment, suspension and privileged approval are **not ready** until security architecture and OpenAPI define factor, token, session and device mechanics, authorization checks, audit events, secrets, rate limits, recovery and negative tests. This document does not satisfy that gate and does not claim to.

## 12. Questions this document raised

| ID| Question| Type|
|---|---|---|
| `OQ-055`| §11.6 states the complete permission catalogue is "seeded by `DRAFT_PERMISSIONS_CATALOG_V0.1.md`." That file was never delivered with the baseline, like the six control registers. Does it exist anywhere outside this repository? If so it should be imported and reconciled against §7 above; if not, §7 is the seed and §11.6's reference is a dangling pointer to be recorded as such.| `DECISION_NEEDED`|

`OQ-047` is **split**. Read permissions closed on 20 August as `OQ-066`. What remains under `OQ-047`: service accounts, per-user overrides, and suspension and revocation mechanics. §7's action catalogue can be reviewed and approved independently of it.

## 14. Non-human identities hold capabilities, not bundles

`MSC-DEC-279`. **Infrastructure identities never receive a `RoleBundle`.** They hold fixed technical capability sets, defined in code and configuration, outside the §7 catalogue.

| Identity| Technical capability|
|---|---|
| API runtime — `melarc_api_runtime`| Business DML under row-level security; own-principal idempotency rows; `Outbox` `INSERT` inside an authorised business transaction. No DDL, no audit mutation|
| Worker base — `melarc_worker_runtime`| Bootstrap read of the `Outbox` envelope by id, envelope-derived SYSTEM context, audit **insert**, configuration reads. **No protected-business-table grant at all**|
| Worker task capability — `melarc_worker_cap_<task>`| The tables **one documented task class** requires, and no others. Nine capabilities are defined at [SECURITY_DESIGN.md](../architecture/SECURITY_DESIGN.md) §14.17b and [data-scope-registry.md](data-scope-registry.md) §5.1|
| Scheduler — `melarc_scheduler_runtime`| Enqueue scheduled-work intent only. **No business DML**|
| Outbox relay — `melarc_outbox_relay_runtime`| Read relayable outbox rows, publish, update relay bookkeeping. **No business DML, and no rewrite of envelope authority**|
| Migration — `melarc_migration_elevated`| Approved DDL, schema, ownership and policy operations **for the deployment window only**. **Not reusable as any runtime**|
| Owner — `melarc_owner`| Owns schemas and tables. **`NOLOGIN`**|
| Backup / restore| The backup plane only. **No application database credential**|
| Webhook / provider ingress| Write to a quarantined ingress surface. **Nothing downstream treats it as authority**|

**§11.1 is why this needs saying.** A bundle *"carries no authority beyond the permissions it currently contains"* — **currently** being the operative word, because bundles are editable configuration. A human's bundle changing is a governed act with maker-checker behind it (§6) and session invalidation after it. **A service account has no session to invalidate and no colleague to check the change**, so the same editability that makes bundles right for people makes them wrong here.

**The outbox relay is the sharpest case.** It touches every business transaction in the product by design ([BACKGROUND_JOBS_AND_EVENTS.md](../architecture/BACKGROUND_JOBS_AND_EVENTS.md) §3.7). A bundle attached to it would put the authority of that component one settings screen away from being unlimited — and nothing in the maker-checker model would fire, because editing a bundle is not editing a service account.

**A queue message is not authority**, and **the broker payload does not create authority.** The bootstrap authority is the **stored `Outbox` envelope**, written by the application inside the same business transaction as the mutation it describes:

```
 1  receive the broker message - it carries outbox_id and nothing authoritative
 2  BEGIN under the permitted worker technical identity and task capability
 3  retrieve the TRUSTED immutable Outbox envelope BY outbox_id
 4  verify this worker/task class is allowed to execute it
 5  derive TRANSACTION-LOCAL SYSTEM context FROM THE STORED ENVELOPE
 6  reload the protected aggregate UNDER RLS
 7  compare the aggregate's authoritative scope/identity against the stored envelope
 8  mismatch -> no side effect - dead-letter/quarantine - security event
 9  match    -> perform only task-authorised work
10  COMMIT
11  transaction-local scope disappears before the connection is reused
```

**Step 3 before step 5 is the whole control.** This section previously described *establish scope, reload, compare against the payload* — and a job that establishes its database context **from** the payload it is checking has let the payload choose the authority that validates it, so a forged or stale envelope validates perfectly. Reading a **stored, server-written** row first makes step 7 a comparison between what the broker supplied and what only the business transaction could have written.

**This closes no part of `OQ-047`.** That question asks what integration permissions *should be* — a product question that needs an integration to exist before it can be answered without inventing one. **Gate B answers only the shape: not a human bundle.** §7's catalogue is unchanged, and none of the seven identities above holds a grantable key.


