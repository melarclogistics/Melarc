# Pickup Manifest

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.11 (cleaned edition)
> **Date:** 4 October 2026
> **Domain:** `pickup`
> **Owns:** the behaviour and acceptance criteria for planning a pickup run — building the manifest, ordering stops, assigning a rider, dispatching, starting and completing
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §21.2, §35.3, §36.3, §36.4
> **Slice:** `SLICE-001`

## 1. What this is, and why

A manifest is **one rider's pickup run for one day**: an ordered set of stops, built by Ops, assigned to one rider, dispatched, then started by that rider. It converts a pool of confirmed requests into physical work.

**Version 1 boundary.** Stop ordering is **manual** — route optimisation is explicitly outside the launch baseline (§35.3.2, §7.6). One manifest, one rider. The rider executes; the rider never plans.

**This feature carries the cancellation cutoff.** Assigning a rider is the moment a vendor loses the ability to self-cancel its own request (`MSC-DEC-195`, dormant in V1 under `MSC-DEC-196`). That makes assignment a recorded event rather than an incidental field write.

## 2. Governing sections

| Section| What it governs here|
|---|---|
| §21.2| Manifest planning: pool eligibility, ordering, assignment, dispatch, start, completion|
| §35.3| Manifest and rider rules — including the nine offline-sync obligations|
| §36.3| The manifest state machine|
| §36.4| Stop states, and the zero-count rule that bounds completion|
| §34.10| Fleet — a rider needs a serviceable assigned motorcycle|


## 3. Surfaces and actors

| Surface| Actor| Can do| Gated by|
|---|---|---|---|
| Melarc Ops| Ops Staff| Build the manifest, add and reorder stops, assign a rider, dispatch, cancel before start| `pickup.manifest.create`, `pickup.manifest.dispatch`|
| Melarc Ops| Senior Ops, Platform Admin| All Ops actions| same|
| Melarc Rider| Rider| **Start** the owned run; work its stops; complete it| `pickup.run.execute` — assigned run only|
| Melarc Vendor| Vendor account| **N/A** — a manifest carries stops for many vendors. Exposing one would leak other vendors' records *(domain model §4)*| —|
| Recipient channel| —| **N/A**| —|

**The manifest is hub-scoped and never vendor-owned.** This is the trap the domain model §4 names explicitly: a vendor sees its own stop, never the run.

## 4. Preconditions

- One or more requests are `CONFIRMED` and **unmanifested** — §21.2: "only confirmed, unmanifested requests appear in the pool."
- An eligible **active** rider **of the manifest's hub** exists with a **serviceable assigned motorcycle** (§34.10). A rider is eligible for the hub they belong to (`primary_hub_id`); the reach of an officer's grant does not make a rider eligible, and the temporary assignment to another hub (§30.5, `HubAssignment`) is not built, so nothing makes a rider eligible elsewhere (the Product Owner, 2 November 2026, on the reviewer's recommendation).
- All stops belong to the manifest's responsible hub.
- **A request is unmanifested while no stop holds it.** A stop holds its request until that claim is explicitly released by an authorized cancellation or recovery transition. Skipping a stop, failing it or collecting from it does not release the claim (the Product Owner, 1 November 2026).
- **A manifest's day is the day the run is worked; a request's day is its promise.** The manifest's service date is a day the hub operates (Monday to Saturday) that has not passed on the hub's clock. A request may go on a manifest for the day it was promised or for a later one, which **carries it over**: it keeps the day it was promised (`scheduled_service_date`, which a manifest never changes), so lateness is measured from that promise and the manifest's day, and nothing new is stored. A request promised for a later day than the manifest's is refused. A request that is to be promised another day is cancelled and rebooked, or rescheduled, and has a new promise (the Product Owner, 1 November 2026, on the reviewer's recommendation: Melarc's own delay is not answered by a cancellation and a rebooking). **The manifest's day is its planned execution date** (the Product Owner, 2 November 2026): the day the run is to be worked, not a guarantee that every event of the run falls on it ([the midnight rule](#52-exception-paths)). A manifest for a later day may be dispatched in advance, which only publishes its stops to the assigned rider; the run is started on its day.
- **A carried-over request is carried over for a stated reason, and is never refused for its age** (the Product Owner, 2 November 2026, on the reviewer's recommendation). Creating a manifest that holds a request promised for an earlier day takes, for each such request, a reason of the `PICKUP_CARRYOVER` domain ([domain-model.md](../../contracts/domain-model.md) §3.9) and its note where the reason asks for one. One reason covers several requests only because it is given, expressly, for each of them and is true of each. Work stays visible until it is resolved: there is no automatic expiry, no age at which it is refused, and no higher tier merely because it is overdue (the manifest's own authority, and the exception restrictions that already exist, apply as for any manifest). The promise is never rewritten, so a carry-over never resets lateness. The eight reasons are seeded (2 November 2026; [domain-model.md](../../contracts/domain-model.md) §3.9): each explains the carry-over and does nothing else, so a reason never creates a charge, consumes a pickup attempt or resets the original promise, and `VENDOR_ASKED_FOR_LATER_PICKUP` needs a factual note that names what the vendor said, when and through which channel, never an assumption. An escalation threshold for old work is defined with the operating policy before any automated escalation is built; none is invented here. **Lateness has three separate measures**, defined in [reporting-data-dictionary.md](../reporting/reporting-data-dictionary.md): overdue backlog, completed late and carry-over planned. A date-only promise supports lateness by the day; lateness by the hour needs a promised window that is authoritative, and there is none.
- **A request awaiting the review of its cutoff is not in the pool** (`cutoff_exception_state` is `PENDING_OPS_REVIEW`) until Ops decides it; it stays visible in the request queues.

---

## 5. Behaviour

### 5.1 Normal path

1. **Ops builds the manifest.** It enters `DRAFT`. Ops selects confirmed unmanifested requests from the pool, each becoming a `PickupStop` with a manual `sequence` (§35.3.1–2): at creation the order Ops listed them in, which `setManifestStopOrder` then replaces. A manifest holds one to 64 requests (Version 1): the limit of the batch the software accepts, **not** a statement that a rider can carry 64 parcels or finish 64 visits (parcel volume, weight, geography and working time are separate operational limits), and independent of anything the audit trail holds. A larger workload uses more than one manifest, and raising the limit later is a decision that checks the operation's needs and the system's capacity.
2. **Ops assigns a rider.** `assigned_rider_id` and `assigned_at` are set on the `DRAFT` manifest, and every confirmed request on it is marked as committed to a rider. The rider must be `ACTIVE` and belong to the manifest's hub (the reach of the officer's grant is not the rider's eligibility); the manifest stays a draft and the rider does not see it. **This is the cancellation cutoff** — from this moment vendor self-cancellation of any request on this manifest is closed, and a cancellation by the office must decide the charge, **for as long as the request is held by this manifest**: cancelling the manifest returns the requests that are still confirmed to the pool and ends their commitment ([pickup-request.md](pickup-request.md) §5.3). Ordering the stops stays open until dispatch.
3. **Ops dispatches.** The manifest becomes `DISPATCHED` and the stops become visible to the assigned rider, and to no other. **A cancelled request is never sent:** the cancellation has already resolved its stop (§5.2), and dispatch is refused, as a second safeguard, while a stop still to be worked is for a request that is no longer `CONFIRMED`. **A run whose day has passed is never sent** (§5.2). Each stop still to be worked is given what the rider needs at the door, made once from its request (§5.4). One run-level text is queued for the rider in the same transaction (`RUN_DISPATCHED_RIDER`, D-11; its words were approved by the Product Owner on 2 November 2026, [rider-android.md](../../surfaces/rider-android.md)); it is a courtesy and never the guarantee, because the rider reads the stops in the app. **The dispatch is successful once it commits with its envelope**: whether and when a provider delivers the text is a separate fact (the message log), never a condition of the dispatch. **Dispatch does not start the run** (§21.2, §36.3).
4. **The rider starts the run, on its day.** The manifest becomes `IN_PROGRESS`, and all member pickup work moves to dispatched/active context **atomically** (§21.2). A run is started on its `service_date` on the hub's clock and not before it or after it has passed (the Product Owner, 2 November 2026; built with `startRun`, S1.22); one dispatched in advance waits for its day. A run all of whose pickups were cancelled or resolved is not started (`MANIFEST_EMPTY`): it stays dispatched and Ops cancels it unstarted (the Product Owner, 2 November 2026).
5. **The rider works the stops**, in any order. The system maintains a **recommended next stop** without enforcing it (§21.2).
6. **The manifest completes** once every stop is terminal — `COLLECTED`, `PARTIALLY_COLLECTED`, `FAILED` or `SKIPPED` (§21.2, §36.3) — **in one of two ways**: where anything was collected, **the custody holder's hub handover is the completion**, one row per collected pickup request; where nothing was, **System completes the run** with no handover and no intake (§22.2).

### 5.2 Exception paths

| Path| Behaviour| Error code|
|---|---|---|
| Dispatch with no stop left to be worked (no stop, or every stop resolved)| Refused| `MANIFEST_EMPTY`|
| Start with no stop left to be worked (every pickup cancelled or resolved)| Refused; the run stays dispatched and Ops cancels it unstarted| `MANIFEST_EMPTY`|
| Rider not eligible, inactive or of another hub| Refused at the assignment and again at dispatch, which judges the rider's status and hub as they are when the manifest goes out| `RIDER_UNAVAILABLE`|
| Rider has no serviceable motorcycle| Refused. A confirmed breakdown makes the motorcycle unavailable for new runs (§34.10)| `NO_SERVICEABLE_MOTORCYCLE`|
| A rider other than the assignee acts| Refused. §35.3.5: a rider may act only on an assigned run| `NOT_ASSIGNED_RIDER`|
| Rider tries to add or substitute a stop| Refused. Membership is Ops-determined (§35.3.1, §35.3.5)| `PERMISSION_DENIED`|
| Completion with unresolved stops| Refused| `STOPS_UNRESOLVED`|
| **Run with nothing collected**| System completes it when the last stop turns terminal — no handover, no intake (§22.2, `MSC-DEC-416`). A `PENDING` `RunCustodyHandover` holds it until that resolves| —|
| Handover rows not exactly the run's collected requests| Refused| `VALIDATION_FAILED`|
| Completion attempted by someone not holding custody| Refused. **After a handover the assigned rider is precisely who may no longer act**, which is why this is not `NOT_ASSIGNED_RIDER`| `NOT_CUSTODY_HOLDER`|
| Cancel after the run started| Refused. Cancellation is `DRAFT` or `DISPATCHED` only| `RUN_ALREADY_STARTED`|
| Stop worked before the run started| Refused| `MANIFEST_NOT_STARTED`|
| **Rider offline**| **Only hub-handover submission is offline-capable** — Version 1's whole offline scope; every other act on a run, arrival, collection and failure included, requires a connection and is idempotent for connection resilience. The queued handover's sync preserves **capture time, idempotency and conflict status** (§35.3.9), and `AC-SLICE-001-18` tests it.| —|
| Concurrent dispatch by two Ops users| Deterministic rejection on record version| `STATE_CONFLICT`|
| **A request is cancelled after its manifest was made**| The cancellation succeeds: a manifest does not withdraw the office's right to cancel, and a vendor still cannot cancel a confirmed request. **In the same transaction the stop that holds the request is skipped** if it is still to be worked: `PENDING` or `ARRIVED` becomes `SKIPPED` with the system's reason `REQUEST_CANCELLED`, in its place in the order, with the arrival it recorded, and **holding its claim** (the request is cancelled and must not return to the pool; only an explicit, authorized transition releases a claim). The manifest keeps its state; its `ETag` moves, because a stop it shows changed. The cancellation charge is decided as for any cancellation and independently of the stop. Ops finds the stop with `state=CANCELLED&manifested=true`| —|
| Dispatch while a stop still to be worked is for a request that is no longer `CONFIRMED`| Refused, naming the stops; nothing is sent. **A second safeguard:** the cancellation resolves the stop itself, so a stop is left only if it was arranged some other way, and dispatch does not depend on `skipPickupStop` being built| `STATE_CONFLICT`|
| **Dispatch of a run whose service date has passed** on the hub's clock| Refused (`details.rule` `service_date_passed`); nothing is sent. **The unstarted manifest is cancelled and its outstanding requests are planned again** on a manifest for a day that has not passed, each carried over with a reason (§4). Nothing is dispatched or started after its day has passed (the Product Owner, 2 November 2026, on the reviewer's recommendation)| `STATE_CONFLICT`|
| **A request is cancelled after its manifest was dispatched**| **The cancellation takes effect at once, and the rider's acknowledgement decides nothing.** The stop is skipped as above, with `REQUEST_CANCELLED` and its arrival kept. The rider's next successful read of the manifest shows the stop `SKIPPED` and offers no collection on it; an act of the rider on it from an outdated screen is refused against the cancelled request and the resolved stop, never accepted. Notification is a courtesy and never the guarantee, and the cancellation raises no text of its own. **While the rider is travelling, the office contacts the rider** (the Product Owner, 2 November 2026, on the reviewer's recommendation): **the officer who handles the cancellation owns that contact** when the run is dispatched or in progress; if the rider cannot be reached, the officer escalates to the duty Senior Ops and **keeps the contact attempt unresolved until the rider acknowledges or someone takes it over**. The rider reads on the stop *Pickup cancelled — do not collect*, then *Pickup {reference} has been cancelled. Continue with your remaining stops. If you have already received any parcels, contact Ops immediately.* ([rider-android.md](../../surfaces/rider-android.md)), a message that does not ask for interaction while riding, and the rider's acknowledgement never delays the cancellation: the server is authoritative. The procedure is documented and not automated, and the system fixes no threshold for it. **The note of the cancellation is the reason for the cancellation and is no substitute for what follows it**: the officer's later attempts to reach the rider, an escalation to the duty Senior Ops and the rider's acknowledgement are events of their own and belong in a separate, append-only record of the office's contact with the rider (OB-S1-34: the requirement and the design were approved on 2 November 2026, in [the plan](../../delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md#74-the-proposed-record-of-the-offices-contact-with-a-rider-ob-s1-34), and the record is a separate bounded task and **not built**). The system holds no such record today, and until it exists the procedure is not one the platform supports: that record is a prerequisite of operating the procedure, and blocks no local backend development. **The cancellation never waits for it, for a notification or for an acknowledgement**| —|
| **A request is cancelled after a collection was recorded on its stop**| The cancellation proceeds (office cancellation is available at every point) and **erases nothing**: a `COLLECTED` or `PARTIALLY_COLLECTED` stop stays as it is, is not turned into a skip, and no skip event is written for it. What the cancellation means for the parcels already in custody is for the collection and the custody to decide ([pickup-collection.md](pickup-collection.md))| —|
| **Ops orders the stops** (`setManifestStopOrder`)| The complete sequence of a `DRAFT` manifest, every stop once, the stop at place `n` numbered `n`, judged against the manifest's `ETag` (which digests the stops, so a read from before a request on the manifest was cancelled is stale). A stop left out, named twice or not on this manifest is refused at its place; **a stop that is no longer to be worked keeps its place** and the others are ordered around it (`resolved_stop_moved`). Once however many times it is sent| `VALIDATION_FAILED`, `STATE_CONFLICT`|
| **Ops assigns a rider** (`assignRider`)| A `DRAFT` manifest only (a manifest that has gone out is not given another rider by this act: the way out is to cancel it and plan its requests again, and the reassignment before the start that a breakdown needs is SLICE-011's). A rider who is not `ACTIVE`, does not exist, is outside the officer's grant or **belongs to another hub** is one answer, and nothing is changed; the database holds the same rule for every writer. The rider the manifest already has changes nothing| `RIDER_UNAVAILABLE`, `STATE_CONFLICT`|
| **Ops cancels a manifest** (`cancelPickupManifest`)| A `DRAFT` or `DISPATCHED` manifest, with a mandatory note: the stops still to be worked are skipped (`MANIFEST_CANCELLED`), every claim is released and the requests still confirmed return to the pool **with their rider commitment ended in the same transaction** (a request cancelled meanwhile keeps its decision and its mark, frozen); a run that has started is refused| `RUN_ALREADY_STARTED`, `STATE_CONFLICT`, `REASON_REQUIRED`|
| **A collection and a cancellation of the same stop meet**| They are serialised on the stop (the request is locked first, then the stop), so only a valid outcome commits: the collection that committed first stands, or the cancellation that committed first skips the stop and the collection is refused| `STATE_CONFLICT`|
| A manifest dated in the past, or a request promised for a later day than the manifest's| Refused, at the place of the day or of the request| `VALIDATION_FAILED`|
| A request promised for an earlier day than the manifest's (carried over)| Accepted **with a reason for it** (`carryover`: one entry per carried-over request, a code of the `PICKUP_CARRYOVER` domain and a note where the reason asks for one). The stop keeps the reason as given; the audit event of the creation counts how many were carried over. A carried-over request with no entry is refused, and so is a code the catalogue does not hold active| `REASON_REQUIRED`, `REASON_NOT_ACTIVE`|
| An entry for a request that is not on the manifest, is on its own day, or is given twice, or a note the ledger would not keep| Refused at the place of the entry| `VALIDATION_FAILED`|
| **A run that is worked past midnight** (the Product Owner, 2 November 2026)| **A run that has already started may continue.** It keeps its original `service_date`; its actual arrival, collection and completion timestamps are preserved; each pickup's outcome is attributed to the local date of its own actual event; and the system **does not cancel, complete or redate the run at midnight**. A run whose `service_date` has passed is neither dispatched nor started (`startRun`, S1.22, refuses it with `STATE_CONFLICT`), and **dispatch is publication while the start is the day**: a manifest for a later day may be dispatched in advance, and `startRun` is permitted on the `service_date` and refused before it and after it has passed. So `service_date` is the **planned execution date**, not a guarantee that every event of the run falls on it ([state-machines.md](../../contracts/state-machines.md) §4)| —|
| Pre-run breakdown| The run is reassigned to another available rider with a functioning motorcycle. It does **not** silently transfer the original motorcycle assignment (§34.10)|
| **Mid-run breakdown, parcels aboard**| **A `RunCustodyHandover`**. Ops opens it naming another active rider, or **the hub** where a field transfer would be unsafe (§43.4). Custody moves only on acceptance, and **the receiver — not the stranded rider — completes the run**. Stops already worked stay attributed to the original rider| `NOT_CUSTODY_HOLDER`| —|

### 5.3 What this feature must never do

- **Never let dispatch start the run.** Two transitions, two actors — §36.3 requires it, and collapsing them attributes an Ops action to a rider in the audit trail.
- **Never optimise the route.** Ordering is manual and `auto_reschedule` is off. Automation arrives only when §7.6's data and maturity conditions are met.
- **Never expose the manifest to a vendor.** It carries other vendors' stops.
- **Never infer assignment from the manifest existing.** `assigned_rider_id` is nullable and `assigned_at` is recorded, because assignment is a *moment* — the cancellation cutoff depends on it.
- **Never enforce stop order.** The recommendation is advisory; §21.2 permits out-of-order completion, and real runs need that.
- **Never drop the offline ordering guarantee.** Idempotency alone is insufficient — §35.3.9 requires order and conflict status too.

### 5.4 What the rider is shown for a stop (the pickup summary)

The registry denies a rider any read of the request, so what a rider needs at the door is **made once, at dispatch, from the request, and kept on the stop** (`pickup_summary`; the Product Owner's decision of 2 November 2026, on the reviewer's recommendation; OB-S1-21):

| Member| From| Note|
|---|---|---|
| `reference`| the request's code (the one the sender is texted)| How the rider and Ops name the same pickup, and what a cancelled pickup is announced by. **Approved by the Product Owner on 2 November 2026** (OB-S1-21, closed): it was added by the build for the approved cancellation wording, which names it|
| `sender_display_name`| the request's `sender_name`, as booked| —|
| `declared_package_count`| the request's declared count| **Declared** by the booking; the screen labels it so, and the count that counts is the rider's at the door|
| `resolved_pickup_location`| the request's resolved location| The resolved address, landmark, map link and coordinates, those the request has|
| `location_note`| — (**null**)| No pickup-instructions field exists on the request. It is never the landmark and never made from a location override; its absence does not block a dispatch|
| `contact_phone`| the request's primary contact| The secondary contact is not shown|

Nothing of the payer, the price, the destination, the one-package recipient or any other request of the run is in it, and the database holds the set (a check on the stop). It is made for the stops still to be worked at dispatch, **not for a stop already resolved** (a cancelled request is never sent to a rider), and it is not changed afterwards: an operation that later changes the pickup facts of a request while a stop holds it (a hub reassignment, an amendment) must say what it does to the summary (OB-S1-33). The rider reads it with the manifest (`getPickupManifest`), only on the manifest assigned to the rider and dispatched.

---

## 6. Entities — *pointer*

| Entity| Home|
|---|---|
| `PickupManifest`| [domain-model.md](../../contracts/domain-model.md) §6.3|
| `PickupStop`| [domain-model.md](../../contracts/domain-model.md) §6.4|
| `Motorcycle`, `BreakdownIncident`| [domain-model.md](../../contracts/domain-model.md) §6.8|

Non-obvious: `assigned_rider_id` is **nullable** while `DRAFT`; `assigned_at` records the cutoff moment; `sequence` is manual and advisory.

## 7. States — *pointer*

| Machine| Home| Transitions this feature drives|
|---|---|---|
| `PickupManifest.state`| [state-machines.md](../../contracts/state-machines.md) §4| assign rider; `DRAFT → DISPATCHED → IN_PROGRESS → COMPLETED`; `→ CANCELLED`|
| `PickupStop.state`| [state-machines.md](../../contracts/state-machines.md) §5| `PENDING → ARRIVED`, `→ SKIPPED`|

## 8. Permissions — *pointer*

| Key| Holders| Scope| Home|
|---|---|---|---|
| `pickup.manifest.create`| Ops, Senior Ops, Platform Admin| own hub| [permissions.md](../../contracts/permissions.md) §7|
| `pickup.manifest.dispatch`| Ops, Senior Ops, Platform Admin| own hub||
| `pickup.run.execute`| **Rider only**| assigned run||

## 9. Settings — *pointer*

| Key| Why this feature reads it| Home|
|---|---|---|
| Operating calendar| Runs occur Monday–Saturday| [settings.md](../../contracts/settings.md) §7.3|
| `auto_reschedule`| `CONFIRMED` off — Ops rescheduling only||

## 10. Errors — *pointer*

`MANIFEST_EMPTY`, `RIDER_UNAVAILABLE`, `NO_SERVICEABLE_MOTORCYCLE`, `NOT_ASSIGNED_RIDER`, `STOPS_UNRESOLVED`, `RUN_ALREADY_STARTED`, `MANIFEST_NOT_STARTED`, `STATE_CONFLICT`, `PERMISSION_DENIED`, `ALREADY_MANIFESTED`, `REASON_REQUIRED`, `REASON_NOT_ACTIVE`, `VALIDATION_FAILED` — [errors-and-enums.md](../../contracts/errors-and-enums.md).

## 11. Audit events — *pointer*

`pickup.manifest.created`, `pickup.manifest.stops_ordered` *(CRIT-09 audit remediation)*, `pickup.manifest.rider_assigned`, `pickup.manifest.dispatched`, `pickup.manifest.started`, `pickup.manifest.completed`, `pickup.stop.arrived`, `pickup.stop.skipped` — [audit.md](../../contracts/audit.md) §5.1. `pickup.stop.skipped` is written by Ops's skip (S1.23) and, with the system's reason `REQUEST_CANCELLED`, once for each stop the cancellation of a request skips, by the actor of the cancellation and after its own event.

**Every identifier is spelled in full.** The suffix form — `` `.dispatched` `` after `` `pickup.manifest.created` `` — is not a resolvable identifier: no check can verify it, and it still reads correctly after the code it points at is renamed.

`pickup.manifest.rider_assigned` matters beyond the run: it is the moment vendor self-cancellation closes on every request the manifest carries. The mark it sets on the requests (`rider_assigned`) means **the request is committed to a rider now**, which ends with the claim: the cancellation of the manifest lowers it, and `pickup.manifest.cancelled` counts the commitments it ended (`detail.commitments_ended`) ([pickup-request.md](pickup-request.md) §5.3; OB-S1-35). The assignment history stays in the trail. `pickup.manifest.dispatched` records the rider and how many stops were sent.

## 12. API operations — *pointer*

| Operation| Home|
|---|---|
| `createPickupManifest`| [openapi.yaml](../../contracts/openapi.yaml). Refuses a request already on a manifest with `ALREADY_MANIFESTED`; takes a reason for each request it carries over (`carryover`); one to 64 requests|
| `listPickupManifests`||
| `getPickupManifest`||
| `assignRider`| Built (S1.21): a `DRAFT` manifest, an `ACTIVE` rider of the officer's hubs, `pickup.manifest.assign`|
| `setManifestStopOrder`| Built (S1.21): the complete sequence of a `DRAFT` manifest, `pickup.manifest.create`|
| `dispatchManifest`| Built (S1.21): `DRAFT` to `DISPATCHED`, `pickup.manifest.dispatch`, `If-Match`; the pickup summary of each stop still to be worked (§5.4); the rider's one run text queued in the same transaction|
| `startRun`| Built (S1.22): `DISPATCHED` to `IN_PROGRESS`, the assigned rider only, `pickup.run.execute`, `If-Match` (the run as the rider read it, stops included); on the run's `service_date` on the hub's clock (`service_date_not_reached`, `service_date_passed`); records the moment and writes nothing else; refused with `MANIFEST_EMPTY` when no stop is left to be worked|
| `arriveAtPickupStop`| Built (S1.22): `PENDING` to `ARRIVED`, in any order, on a run in progress, `pickup.run.execute`, `Idempotency-Key`; writes the stop and nothing else; `MANIFEST_NOT_STARTED` before the start|
| `cancelPickupManifest`| Built (S1.21): `DRAFT` or `DISPATCHED` to `CANCELLED` with a note; the stops still to be worked are skipped and every claim released; `RUN_ALREADY_STARTED` after the start|
| `getPickupStop`| Built (S1.22): the `ETag` read of a stop, `pickup.read`; the stop of the manifest read, member for member; staff by the hubs of the grant, a rider through its assigned and dispatched run, a vendor none (OB-S1-23); the stop operations take its `ETag` as `If-Match`|
| `initiateRunCustodyHandover`, `acceptRunCustodyHandover`, `failRunCustodyHandover`, `listRunCustodyHandovers`, `getRunCustodyHandover`| Built (S1.24): the run custody handover of AC-67 and AC-68 (permission domain `fleet`, `src/fleet/`). One open handover per run; the origin is the run's custody holder, never sent; opening moves nothing; acceptance makes the receiver the holder and records a count that seeds nothing; the resolutions can complete a run with nothing collected by System. `getRunCustodyHandover` is the read whose `ETag` the acceptance and the failure take|
| `skipPickupStop`| **Added `MSC-DEC-412`**, built (S1.23) — the Ops act that lets a run with an unresolvable stop reach `COMPLETED`: `pickup.stop.skip`, the stop's `ETag`, an `Idempotency-Key`, an active `PICKUP_STOP_SKIP` reason with a note where it requires one; the Vendor's notice is queued in the same transaction; the run is completed by System when this was its last stop to work and nothing was collected|
| `submitHubHandover`| **The run's completion where anything was collected** — one row per collected pickup request. Owned by [hub-intake.md](../hub/hub-intake.md)|

**This section said the opposite until 23 August.** It read *“Manifest operations are not yet in the slice-scoped contract… added when this feature reaches `READY`, never in anticipation.”* They were added on 20 August as one of `SLICE-001`'s five missing operation groups, and this pointer was never updated — so the feature told a developer the operations did not exist while seven of them did.

---

## 13. Acceptance criteria

### `AC-SLICE-001-11` — Only confirmed unmanifested requests are eligible

```text
Given a mix of PENDING, CONFIRMED-unmanifested and CONFIRMED-manifested requests,
When Ops opens the manifest pool,
Then only the CONFIRMED and unmanifested requests appear,
And a request already on another manifest cannot be added to a second, and is refused with ALREADY_MANIFESTED.
```

**Governs:** §21.2, §35.2.8 · **Surface:** Melarc Ops · **Test level:** API · **Code:** `ALREADY_MANIFESTED`

### `AC-SLICE-001-12` — Assignment closes the cancellation window

```text
Given a CONFIRMED request on a DRAFT manifest with no assigned rider,
When Ops assigns a rider to that manifest,
Then assigned_at is recorded,
And any subsequent vendor self-cancellation of that request is refused with PERMISSION_DENIED,
And office cancellation of it still succeeds,
And the stop that holds the cancelled request is SKIPPED in the same act with the reason REQUEST_CANCELLED (on a DRAFT manifest and on a DISPATCHED one), its claim is not released, and the rider's next read of the manifest shows it skipped.
```

**Governs:** `MSC-DEC-195`, §21.2 · **Surface:** Melarc Ops · **Test level:** service · **Code:** `PERMISSION_DENIED`

### `AC-SLICE-001-13` — Dispatch does not start the run

```text
Given a DRAFT manifest with stops and an assigned rider,
When Ops dispatches it,
Then the manifest becomes DISPATCHED and the rider is notified,
And the manifest is not IN_PROGRESS,
And no stop may yet be worked: arriveAtPickupStop on one of its stops is refused with MANIFEST_NOT_STARTED,
And each stop still to be worked carries the pickup summary the rider needs and no more, which the assigned rider reads and no other rider does,
And a manifest whose service date has passed on the hub's clock is refused with STATE_CONFLICT, and nothing is sent.
```

**Governs:** §21.2, §36.3 · **Surface:** Melarc Ops · **Test level:** API · **Code:** `MANIFEST_NOT_STARTED`, `STATE_CONFLICT`

*Extended on 2 November 2026 with the summary and the day (no new identifier). The refusal of `arriveAtPickupStop` is asserted by S1.22 (`pickup-stop-arrival.db.test.ts`, on a run dispatched through the office's own routes).*

### `AC-SLICE-001-14` — Only the assigned rider may start

```text
Given a DISPATCHED manifest assigned to rider A,
When rider B attempts to start it,
Then the backend rejects with NOT_ASSIGNED_RIDER,
And when rider A starts it the manifest becomes IN_PROGRESS,
And all member pickup work moves to active context in one atomic change.
```

**Governs:** §21.2, §35.3.5 · **Surface:** Melarc Rider · **Test level:** API · **Code:** `NOT_ASSIGNED_RIDER`

### `AC-SLICE-001-15` — A rider without a serviceable motorcycle cannot be dispatched

```text
Given a rider whose assigned motorcycle has a confirmed breakdown,
When Ops attempts to dispatch a manifest assigned to that rider,
Then the backend rejects with NO_SERVICEABLE_MOTORCYCLE,
And the manifest remains DRAFT.
```

**Governs:** §34.10 · **Surface:** Melarc Ops · **Test level:** API · **Code:** `NO_SERVICEABLE_MOTORCYCLE`

### `AC-SLICE-001-16` — Stops may be worked out of order

```text
Given an IN_PROGRESS manifest with stops sequenced 1, 2, 3,
When the rider works stop 3 first,
Then the action succeeds,
And the system continues to present a recommended next stop without enforcing it.
```

**Governs:** §21.2 · **Surface:** Melarc Rider · **Test level:** API

### `AC-SLICE-001-17` — Completion requires every stop terminal

```text
Given an IN_PROGRESS manifest with one stop still PENDING,
When the rider attempts to complete the run,
Then the backend rejects with STOPS_UNRESOLVED,
And once every stop is COLLECTED, PARTIALLY_COLLECTED, FAILED or SKIPPED the completion succeeds.
```

**Governs:** §21.2, §36.3 · **Surface:** Melarc Rider · **Test level:** API · **Code:** `STOPS_UNRESOLVED`

### `AC-SLICE-001-18` — The queued hub handover keeps its capture time, lands once, and is never dropped

```text
Given a rider whose run has every stop terminal, and who submits the hub handover with no connection,
When the device reconnects,
Then the queued submission is delivered carrying its original capture time, distinct from its upload time,
And however many times it is retried, one handover results — a replay returns the original result,
And a submission the server rejects is shown to the rider as an actionable rejected-sync state and is never dropped,
And a stop outcome attempted with no connection shows the no-connectivity state and is not queued.
```

**Governs:** §35.3.9, §19.5, §19.8, §7.8, `MSC-DEC-415` · **Surface:** Melarc Rider · **Test level:** offline sync

**Retargeted 26 September 2026** (`MSC-DEC-415`, the Product Owner's choice in session).

### `AC-SLICE-001-19` — A rider cannot alter run membership

```text
Given an IN_PROGRESS manifest,
When the rider attempts to add a stop or substitute one pickup for another,
Then the backend rejects the attempt,
And run membership remains exactly as Ops determined it.
```

**Governs:** §35.3.1, §35.3.5 · **Surface:** Melarc Rider · **Test level:** API · **Code:** `PERMISSION_DENIED`

---

### `AC-SLICE-001-67` — A stranded run is closed by whoever took the parcels

```text
Given a started run with 9 of 12 stops worked and parcels aboard,
And the assigned rider cannot act,
When Ops opens a custody handover to a second rider and that rider accepts,
Then Ops skips the remaining stops with a PICKUP_STOP_SKIP reason and the second rider, who holds custody, completes the run by the hub handover,
And the second rider attempting the skip is refused with PERMISSION_DENIED, because skipPickupStop is an Ops act (AC-74),
And the assigned rider attempting to complete it receives NOT_CUSTODY_HOLDER,
And the stops worked before the transfer remain attributed to the original rider.
```

**Governs:** §36.14, §43.4, `MSC-DEC-246`, `MSC-DEC-412` · **Surface:** Melarc Ops, Melarc Rider · **Test level:** integration · **Code:** `PERMISSION_DENIED`, `NOT_CUSTODY_HOLDER`

### `AC-SLICE-001-68` — A handover creates no custody gap, and no count

```text
Given a custody handover opened on a started run,
When the named receiver has not yet accepted,
Then custody remains with the original rider and the run stays IN_PROGRESS,
And a handover marked FAILED leaves custody unchanged,
And the parcel count recorded at acceptance does not seed the hub blind count.
```

**Governs:** §22.4, §36.14, `MSC-DEC-246` · **Surface:** Melarc Ops · **Test level:** integration

---

### `AC-SLICE-001-74` — An authorised skip closes a run that could not close

```text
Given an IN_PROGRESS manifest with one PENDING stop that cannot be attempted,
When Ops skips that stop with an active PICKUP_STOP_SKIP reason,
Then the stop is SKIPPED and the manifest may reach COMPLETED,
And completing it before the skip is refused with STOPS_UNRESOLVED,
And the PickupRequest attempt chain is unchanged and MELARC_MAX_PICKUP_ATTEMPTS is not approached,
And the Vendor is notified with the request, the reason and the requested action,
And a rider attempting the skip is refused with PERMISSION_DENIED,
And a skip submitted with a DELIVERY_FAILURE code is refused with REASON_NOT_ACTIVE.
```

**Governs:** `MSC-DEC-412`, `MSC-DEC-246`, state-machines.md §5, §4 · **Surface:** Melarc Ops, backend · **Test level:** integration · **Expected code on rejection:** `STOPS_UNRESOLVED`, `PERMISSION_DENIED`, `REASON_NOT_ACTIVE`

### `AC-SLICE-001-78` — A run with nothing collected completes itself, with no handover and no intake

```text
Given a run in progress whose stops are all FAILED or SKIPPED,
When the last stop turns terminal,
Then the manifest moves to COMPLETED by System,
And no hub handover is recorded and no intake opens,
And a hub handover attempted on the completed run is refused with STATE_CONFLICT,
And while a RunCustodyHandover on such a run is PENDING, the run stays IN_PROGRESS until the handover resolves, and then completes.
```

**Governs:** §22.2, `MSC-DEC-416`, state-machines.md §4 · **Surface:** Melarc Rider, backend · **Test level:** integration · **Expected code on rejection:** `STATE_CONFLICT`

### `AC-SLICE-001-80` — A rider sees only assigned work, and is never told a colleague's exists

```text
Given two riders each holding a dispatched manifest with stops,
When one requests the other's manifest by id with getPickupManifest,
Then the response is 404 NOT_FOUND, identical in status, code, body shape and timing class to a manifest that does not exist,
And a manifest list for the rider returns only the manifests assigned to that rider,
And a rider who acts on a stop of a manifest they hold a reference to and are not assigned to is refused with NOT_ASSIGNED_RIDER, which is an informative state-and-authorisation decision and never NOT_FOUND,
And an Ops user who reads an existing manifest outside their hubs is told HUB_SCOPE_VIOLATION and one who reads a manifest that does not exist is told NOT_FOUND.
```

**Governs:** §19.2, §37.3, `MSC-DEC-246`, `MSC-DEC-432` · **Surface:** Melarc Rider, Melarc Ops · **Test level:** API · **Code:** `NOT_FOUND`, `NOT_ASSIGNED_RIDER`, `HUB_SCOPE_VIOLATION`

## 14. Open questions blocking this feature

| ID| What it blocks here| Type|
|---|---|---|
| —| None| —|

No open question blocks this feature. The manifest operations are in the OpenAPI contract — see §12.

## 15. What this feature still owes its slice

| Owed| Blocks which DoR area| Owner|
|---|---|---|
| **Nothing outstanding.** The queued hub handover's design was decided by `MSC-DEC-419` (closing `OQ-027`; see [surfaces/rider-android.md](../../surfaces/rider-android.md)), and `AC-SLICE-001-18` states what it must do.| —| —|

**Seven manifest operations exist** and have since 20 August; this section and §12 both said otherwise. `surfaces/ops-portal.md` and `surfaces/rider-android.md` exist, and their page inventories were accepted as the low-fidelity interaction specification.

**Readiness is not assessed here.** [definition-of-ready.md](../../standards/definition-of-ready.md) assesses it **for the complete vertical slice** and records the verdict in the slice document; a feature cannot answer §44.3 or §44.4 alone. This section feeds that assessment instead of duplicating it (`MSC-DEC-239`, closing `CONFLICT-029`).

## 16. Build status — *honest, per surface*

| Surface| Status| Gap|
|---|---|---|
| Melarc Ops| 🟡 API and screens built; the screens are not accepted| `createPickupManifest` (with the reason for each carried-over request), `listPickupManifests` and `getPickupManifest` exist and are verified in the API (1 and 2 November 2026), and the cancellation of a request resolves its stop (`cancelPickupRequest`). The ordering of the stops, the assignment of a rider and the cancellation of a manifest are built and verified in the API (S1.21, 2 November 2026). **Dispatch is built and verified in the API (S1.21, 2 November 2026):** it gives each stop still to be worked its pickup summary (§5.4) and queues the rider's text. The summary's mapping was decided on 2 November 2026, and the payload a rider reads, `reference` included, was accepted by the Product Owner the same day (OB-S1-21 is closed). **The API for planning and dispatch is complete in code, and the Ops screens for it are built (S1.25, 3 November 2026, not committed and not accepted by the Product Owner; their custody half is written from the contract and not yet proved against the API; the list is filtered by state and by service date, by the server, OB-S1-25, and keeps its place on the pickup queue's terms, [patterns §22f](../../design/COMPONENT_PATTERNS.md#22f-queuetable)); the manifest is not operationally released**: no real text may be sent before the controlled window and the owner's credentials, and the record of the office's contact with a rider, which the cancellation procedure needs, is designed and approved but not built (OB-S1-34). Start and arrival are built in the API for the rider (S1.22, 2 November 2026); every other stop act is not built|
| Melarc Rider| 🟡 API built; the app is not| `startRun` and `arriveAtPickupStop` are built and verified in the API (S1.22, 2 November 2026); the Rider app is SLICE-016's|
| Melarc Vendor| N/A| Manifest is never vendor-visible|
| Recipient channel| N/A| —|

## 17. Related

- **Upstream:** [pickup-request.md](pickup-request.md) — supplies the confirmed unmanifested pool
- **Downstream:** [pickup-collection.md](pickup-collection.md) — what happens when the rider reaches a stop
- **Sibling:** [pickup-failure.md](pickup-failure.md) — the failure path from a stop
- **Slice:** `SLICE-001`
- **Surfaces:** `surfaces/ops-portal.md`, `surfaces/rider-android.md` *(not yet written)*
