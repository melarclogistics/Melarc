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
- An eligible **active** rider exists with a **serviceable assigned motorcycle** (§34.10).
- All stops belong to the manifest's responsible hub.

---

## 5. Behaviour

### 5.1 Normal path

1. **Ops builds the manifest.** It enters `DRAFT`. Ops selects confirmed unmanifested requests from the pool, each becoming a `PickupStop` with a manual `sequence` (§35.3.1–2).
2. **Ops assigns a rider.** `assigned_rider_id` and `assigned_at` are set. **This is the cancellation cutoff** — from this moment vendor self-cancellation of any request on this manifest is closed.
3. **Ops dispatches.** The manifest becomes `DISPATCHED` and the stops become visible to the rider. A run-level notification is sent. **Dispatch does not start the run** (§21.2, §36.3).
4. **The rider starts the run.** The manifest becomes `IN_PROGRESS`, and all member pickup work moves to dispatched/active context **atomically** (§21.2).
5. **The rider works the stops**, in any order. The system maintains a **recommended next stop** without enforcing it (§21.2).
6. **The manifest completes** once every stop is terminal — `COLLECTED`, `PARTIALLY_COLLECTED`, `FAILED` or `SKIPPED` (§21.2, §36.3) — **in one of two ways**: where anything was collected, **the custody holder's hub handover is the completion**, one row per collected pickup request; where nothing was, **System completes the run** with no handover and no intake (§22.2).

### 5.2 Exception paths

| Path| Behaviour| Error code|
|---|---|---|
| Dispatch with no stops| Refused| `MANIFEST_EMPTY`|
| Rider not eligible or inactive| Refused| `RIDER_UNAVAILABLE`|
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
| Pre-run breakdown| The run is reassigned to another available rider with a functioning motorcycle. It does **not** silently transfer the original motorcycle assignment (§34.10)|
| **Mid-run breakdown, parcels aboard**| **A `RunCustodyHandover`**. Ops opens it naming another active rider, or **the hub** where a field transfer would be unsafe (§43.4). Custody moves only on acceptance, and **the receiver — not the stranded rider — completes the run**. Stops already worked stay attributed to the original rider| `NOT_CUSTODY_HOLDER`| —|

### 5.3 What this feature must never do

- **Never let dispatch start the run.** Two transitions, two actors — §36.3 requires it, and collapsing them attributes an Ops action to a rider in the audit trail.
- **Never optimise the route.** Ordering is manual and `auto_reschedule` is off. Automation arrives only when §7.6's data and maturity conditions are met.
- **Never expose the manifest to a vendor.** It carries other vendors' stops.
- **Never infer assignment from the manifest existing.** `assigned_rider_id` is nullable and `assigned_at` is recorded, because assignment is a *moment* — the cancellation cutoff depends on it.
- **Never enforce stop order.** The recommendation is advisory; §21.2 permits out-of-order completion, and real runs need that.
- **Never drop the offline ordering guarantee.** Idempotency alone is insufficient — §35.3.9 requires order and conflict status too.

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

`MANIFEST_EMPTY`, `RIDER_UNAVAILABLE`, `NO_SERVICEABLE_MOTORCYCLE`, `NOT_ASSIGNED_RIDER`, `STOPS_UNRESOLVED`, `RUN_ALREADY_STARTED`, `MANIFEST_NOT_STARTED`, `STATE_CONFLICT`, `PERMISSION_DENIED` — [errors-and-enums.md](../../contracts/errors-and-enums.md).

## 11. Audit events — *pointer*

`pickup.manifest.created`, `pickup.manifest.stops_ordered` *(CRIT-09 audit remediation)*, `pickup.manifest.rider_assigned`, `pickup.manifest.dispatched`, `pickup.manifest.started`, `pickup.manifest.completed`, `pickup.stop.arrived`, `pickup.stop.skipped` — [audit.md](../../contracts/audit.md) §5.1.

**Every identifier is spelled in full.** The suffix form — `` `.dispatched` `` after `` `pickup.manifest.created` `` — is not a resolvable identifier: no check can verify it, and it still reads correctly after the code it points at is renamed.

`pickup.manifest.rider_assigned` matters beyond the run: it is the moment vendor self-cancellation closes on every request the manifest carries.

## 12. API operations — *pointer*

| Operation| Home|
|---|---|
| `createPickupManifest`| [openapi.yaml](../../contracts/openapi.yaml)|
| `listPickupManifests`||
| `getPickupManifest`||
| `assignRider`||
| `setManifestStopOrder`||
| `dispatchManifest`||
| `startRun`||
| `skipPickupStop`| **Added `MSC-DEC-412`** — the Ops act that lets a run with an unresolvable stop reach `COMPLETED`|
| `submitHubHandover`| **The run's completion where anything was collected** — one row per collected pickup request. Owned by [hub-intake.md](../hub/hub-intake.md)|

**This section said the opposite until 23 August.** It read *“Manifest operations are not yet in the slice-scoped contract… added when this feature reaches `READY`, never in anticipation.”* They were added on 20 August as one of `SLICE-001`'s five missing operation groups, and this pointer was never updated — so the feature told a developer the operations did not exist while seven of them did.

---

## 13. Acceptance criteria

### `AC-SLICE-001-11` — Only confirmed unmanifested requests are eligible

```text
Given a mix of PENDING, CONFIRMED-unmanifested and CONFIRMED-manifested requests,
When Ops opens the manifest pool,
Then only the CONFIRMED and unmanifested requests appear,
And a request already on another manifest cannot be added to a second.
```

**Governs:** §21.2, §35.2.8 · **Surface:** Melarc Ops · **Test level:** API

### `AC-SLICE-001-12` — Assignment closes the cancellation window

```text
Given a CONFIRMED request on a DRAFT manifest with no assigned rider,
When Ops assigns a rider to that manifest,
Then assigned_at is recorded,
And any subsequent vendor self-cancellation of that request is refused,
And office cancellation of it still succeeds.
```

**Governs:** `MSC-DEC-195`, §21.2 · **Surface:** Melarc Ops · **Test level:** service

### `AC-SLICE-001-13` — Dispatch does not start the run

```text
Given a DRAFT manifest with stops and an assigned rider,
When Ops dispatches it,
Then the manifest becomes DISPATCHED and the rider is notified,
And the manifest is not IN_PROGRESS,
And no stop may yet be worked.
```

**Governs:** §21.2, §36.3 · **Surface:** Melarc Ops · **Test level:** API · **Code:** `MANIFEST_NOT_STARTED`

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
Then the second rider may skip the remaining stops and complete the run,
And the assigned rider attempting to complete it receives NOT_CUSTODY_HOLDER,
And the stops worked before the transfer remain attributed to the original rider.
```

**Governs:** §36.14, §43.4, `MSC-DEC-246` · **Surface:** Melarc Ops, Melarc Rider · **Test level:** integration

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

No open question blocks this feature. Manifest operations are absent from the OpenAPI contract by design, not by blockage — see §12.

## 15. What this feature still owes its slice

| Owed| Blocks which DoR area| Owner|
|---|---|---|
| **The queued hub handover's design** — `AC-SLICE-001-18` states what it must do, and how is `OQ-027`'s, due before the rider hub-handover build. The scope is decided, so no readiness area waits on it.| —| `OQ-027`|

**Seven manifest operations exist** and have since 20 August; this section and §12 both said otherwise. `surfaces/ops-portal.md` and `surfaces/rider-android.md` exist, and their page inventories were accepted as the low-fidelity interaction specification.

**Readiness is not assessed here.** [definition-of-ready.md](../../standards/definition-of-ready.md) assesses it **for the complete vertical slice** and records the verdict in the slice document; a feature cannot answer §44.3 or §44.4 alone. This section feeds that assessment instead of duplicating it (`MSC-DEC-239`, closing `CONFLICT-029`).

## 16. Build status — *honest, per surface*

| Surface| Status| Gap|
|---|---|---|
| Melarc Ops| ⚪ not built| Everything|
| Melarc Rider| ⚪ not built| Everything|
| Melarc Vendor| N/A| Manifest is never vendor-visible|
| Recipient channel| N/A| —|

## 17. Related

- **Upstream:** [pickup-request.md](pickup-request.md) — supplies the confirmed unmanifested pool
- **Downstream:** [pickup-collection.md](pickup-collection.md) — what happens when the rider reaches a stop
- **Sibling:** [pickup-failure.md](pickup-failure.md) — the failure path from a stop
- **Slice:** `SLICE-001`
- **Surfaces:** `surfaces/ops-portal.md`, `surfaces/rider-android.md` *(not yet written)*
