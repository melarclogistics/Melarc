# Reporting data dictionary

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Owns:** the canonical definition of each reporting measure, one entry per measure, admitted by the domain that supplies it
> **Slice:** none yet; measures are admitted one at a time by the domain that supplies them, and `SLICE-012` integrates them

> Link paths in this document use `../../`, correct from `features/reporting/<name>.md`.

## 1. Purpose and scope

This is the reporting data dictionary that [Master Specification §32.5](../../PROJECT_MASTER_SPECIFICATION.md) requires and `OQ-049` still owed ([the implementation plan](../../delivery/IMPLEMENTATION_PLAN.md#3-sequence) names this file as its home). A measure has **one** canonical definition: its entry here. An entry records what is counted, from which records, on what date basis and what it is not, and **references the owning feature's business rules instead of restating them**. The rules of the domain stay in the domain's feature; the entry says only how a figure is formed from them.

It is not the [Overview dashboard](../../design/OVERVIEW_DASHBOARD_DESIGN.md) (which only displays a measure, and is not built), not a report, and not a contract: **the four measures of §5.1 to §5.4 are served by no operation yet**, and the six queue counts of §5.5.1 to §5.5.6 are served by `getQueueSummary` alone (task C1, [the plan](../../delivery/IMPLEMENTATION_PLAN.md#3a-the-ops-portal-redesign)); nothing else is built from an entry until its own bounded task says so. A sample figure is never a result. A figure that is unavailable or incomplete is never shown as zero, and a successful, complete, authorized read that finds no matching record is zero (§4).

An entry carries the eleven points of [the dashboard brief](../../design/OVERVIEW_DASHBOARD_DESIGN.md#where-a-measure-is-defined). Points an entry cannot yet settle are stated as unresolved in §14, never filled with a default.

## 2. Governing requirements

[Master Specification §32.5](../../PROJECT_MASTER_SPECIFICATION.md) (the reporting data dictionary), `OQ-049`; the owning features [pickup-request.md](../pickup/pickup-request.md) and [pickup-manifest.md](../pickup/pickup-manifest.md); [domain-model.md](../../contracts/domain-model.md) §6.2 to §6.4. The decisions of 2 November 2026 (the Product Owner's, on the reviewer's recommendation, on the carry-over of overdue work) are the source of the entries below, and the corrections of the same day (zero against not available, and the backlog against the planned runs) are in §4 and §5.3 to §5.4.

## 3. Actors and surfaces

None here. A measure is read by the surface and the permission that [the Ops surface matrix](../../surfaces/ops-portal.md#the-overview-section-authorization-and-destinations) assigns to the section that shows it; this document invents no permission, scope or masking.

## 4. Preconditions

- **The promise is a date.** A pickup is promised for `PickupRequest.scheduled_service_date`, a calendar day on the hub's clock (`Africa/Accra`). There is no promised hour or window on the record, so **lateness is measured in whole days**. Lateness by the hour or the minute would need a promised window that is authoritative, which does not exist and is not invented.
- **A manifest never rewrites the promise** ([pickup-manifest.md](../pickup/pickup-manifest.md) §4): a request carried over to a later day keeps the day it was promised, so **a carry-over never resets lateness**.
- **Every figure is as of a hub-local date `D`**, and counts **distinct requests**, once each, however many manifests or stops they were on.
- **A figure is zero, or it is not available, and never both.** A successful, complete, authorized read that finds no matching record answers **zero**. A read that failed, whose data is incomplete or not yet in, or that the caller may not see, is **not available** and is never shown as zero. (An earlier line of this document said that a date with no records is never zero. That is wrong as a general rule, and was corrected on 2 November 2026.)
- **A manifest's day is its planned execution date.** `PickupManifest.service_date` is the day the run is to be worked, not a guarantee that every event of the run falls on it. A run that has started keeps its `service_date` and its actual moments if it goes on past midnight, and the system does not cancel, complete or redate it at midnight. Each pickup's outcome is dated by the hub-local date of its own actual event (`resolved_at`), never by the run's date. A run whose date has passed is not dispatched or started: it is cancelled, and its outstanding requests are planned again for a day that has not passed, each carried over for a stated reason ([pickup-manifest.md](../pickup/pickup-manifest.md) §5.2).

## 5. Behavior — the measures

### 5.1 `pickup.overdue_backlog` — Overdue backlog

| Point| Entry|
|---|---|
| 1. Name, purpose, unit, owner| *Overdue backlog.* How much promised pickup work is still waiting after its promised day. Unit: requests (distinct). Owning domain: pickup|
| 2. Source and inclusion| `PickupRequest` rows that are `CONFIRMED` (a promise Melarc made), whose `scheduled_service_date` is **before `D`**, and for which **no stop has reached `COLLECTED` or `PARTIALLY_COLLECTED`**. A `CANCELLED` or `DECLINED` request is not in it, and a `PENDING` request is not (nothing is promised until it is confirmed). A request leaves it when it is fulfilled or cancelled|
| 3. Formula| The count of those requests as of `D`. Its day-level age is `D − scheduled_service_date` in calendar days|
| 4. Date basis| Scheduled-date basis, `Africa/Accra`, as of `D`. The request stays in it for as long as it is unfulfilled, **whatever manifest it is on and however many times it has been carried over**|
| 5. Age origin, buckets, targets| Age origin: the promised day. **No ageing bucket, target, threshold or escalation is defined** (they are defined with the operating policy before any automated escalation is built)|
| 6. Money| None|
| 7. Permission, scope, masking| As the Ops surface matrix states for the section that shows it; hub scope as that section's|
| 8. As-of and latency| As of `D`; the latency of the contract operation that serves it, not yet specified|
| 9. Contract| None yet. When admitted, an operation of its own, with the validation and error behaviour of a read|
| 10. Drill-down| The requests it counts, by the filters of `listPickupRequests`; the destination permission is the request list's|
| 11. Acceptance examples| A confirmed request promised today is **not** overdue; promised yesterday and unfulfilled it is overdue by one day; carried over to tomorrow's manifest it is still in the backlog and still overdue by the same promise (now two days); collected tomorrow it leaves the backlog and enters *Completed late*; cancelled it leaves the backlog and enters nothing; an empty population is **zero** requests when the read is complete and authorized (no confirmed request is overdue: the backlog is zero), and a read that failed or whose data is incomplete is *not available* and is never shown as zero|

### 5.2 `pickup.completed_late` — Completed late

| Point| Entry|
|---|---|
| 1. Name, purpose, unit, owner| *Completed late.* Pickups that were done, but after the day promised. Unit: requests (distinct). Owning domain: pickup|
| 2. Source and inclusion| `PickupRequest` rows for which a stop reached `COLLECTED` or `PARTIALLY_COLLECTED` (**fulfilled**; a short count is a variance on a fulfilled pickup, not an unfulfilled one) on a hub-local date **after** `scheduled_service_date`. The date fulfilled is the hub-local date of that stop's `resolved_at`|
| 3. Formula| The count of those requests whose fulfilment date falls in the period reported. Its day-level lateness is `fulfilled_on − scheduled_service_date` in calendar days, at least one|
| 4. Date basis| Event date (the fulfilment) against scheduled date (the promise), `Africa/Accra`. **The promise is the original one, always**: a carry-over to a later manifest day never makes a request on time|
| 5. Age origin, buckets, targets| Lateness origin: the promised day. No bucket, target or threshold is defined|
| 6. Money| None|
| 7. to 10.| As for *Overdue backlog*|
| 11. Acceptance examples| Promised Monday, carried over to Tuesday's manifest and collected on Tuesday: completed late by one day. Promised Monday and collected Monday: not late, whatever the hour. Promised Monday, carried over twice and collected on Thursday: completed late by three days, counted once, in the period of Thursday. A request fulfilled in a period appears in that period only|

### 5.3 `pickup.carryover_planned` — Carryover planned

| Point| Entry|
|---|---|
| 1. Name, purpose, unit, owner| *Carryover planned.* Overdue work that has been given a later run and is not yet done. Unit: requests (distinct). Owning domain: pickup|
| 2. Source and inclusion| Stops that carry a carry-over reason (`carryover_snapshot` is not null: the request was promised for an earlier day than its manifest's) whose manifest is `DRAFT`, `DISPATCHED` or `IN_PROGRESS` and whose stop is `PENDING` or `ARRIVED`. A stop that is resolved, or whose manifest is `CANCELLED`, is not in it|
| 3. Formula| The count of those requests, by the `service_date` of the manifest they are planned on. **It is a count by planned execution date and is never subtracted from a backlog of another date**: a request carried over to a later day than today may not be overdue yet, so the two populations differ. The part of the backlog that already has a run is *Overdue and on an active run* (§5.4), defined on the backlog's own population and date|
| 4. Date basis| The manifest's `service_date` (the day the run is worked), against the promise. **Planned is not completed**: when the stop is collected the request leaves this measure and enters *Completed late*|
| 5. Age origin, buckets, targets| As for *Overdue backlog*; the reason given at the carry-over (the `PICKUP_CARRYOVER` code) may be a breakdown of this measure once the owner has supplied the codes|
| 6. Money| None|
| 7. to 10.| As for *Overdue backlog*|
| 11. Acceptance examples| An overdue request placed on tomorrow's draft manifest: planned for tomorrow, still in the backlog. The manifest cancelled: no longer planned, still in the backlog. The stop skipped because its request was cancelled: neither planned nor in the backlog. A request promised today and put on tomorrow's draft is counted here for tomorrow and is **not** in the backlog as of today|

### 5.4 `pickup.overdue_on_active_run` — Overdue and on an active run

| Point| Entry|
|---|---|
| 1. Name, purpose, unit, owner| *Overdue and on an active run.* The part of the overdue backlog that already has a run to be worked on. Unit: requests (distinct). Owning domain: pickup|
| 2. Source and inclusion| The requests of *Overdue backlog* as of `D` (the same population and the same boundary) that hold a stop (an unreleased claim) that is `PENDING` or `ARRIVED` on a manifest that is `DRAFT`, `DISPATCHED` or `IN_PROGRESS`, whatever that manifest's `service_date` (today or a later day). A request whose manifest was cancelled, or whose stop is resolved without the request being fulfilled, is not on an active run|
| 3. Formula| The count of those requests as of `D`. It is a subset of *Overdue backlog* as of the same `D`, so **the overdue backlog with no active run is the backlog less this, and only because the population and the date match** (a derived figure, not an entry of its own)|
| 4. Date basis| Scheduled-date basis, `Africa/Accra`, as of `D`. The run's `service_date` decides nothing about membership; it is the breakdown below|
| 5. Age origin, buckets, targets| As for *Overdue backlog*. A breakdown by the manifest's `service_date` (the planned execution date) shows when the overdue work is planned to be done; it is not subtracted from anything|
| 6. Money| None|
| 7. to 10.| As for *Overdue backlog*|
| 11. Acceptance examples| Promised yesterday, on today's draft: in the backlog and on an active run. Promised yesterday, on tomorrow's draft: the same, planned for tomorrow. Promised today, on tomorrow's draft: **not** in the backlog as of today (it is not overdue yet), so not in this measure as of today, though it is in *Carryover planned* for tomorrow. Promised yesterday, its manifest cancelled: in the backlog, not on an active run. Promised yesterday, its stop skipped because the request was cancelled: in neither|

### 5.5 The queue counts (`queue.*`): what they have in common

The six entries that follow (§5.5.1 to §5.5.6) are **the work waiting in a queue of the Ops Portal, counted by the server** (master specification §17.4: "queue counts and filters that make pending work visible"). They exist so that the navigation, the landing (*My work*) and the Decisions inbox can say how much is waiting without reading a page of each queue. Their entry is decided here, once, and every one of them is served by the one read `getQueueSummary`; a queue's own list operation stays the owner of what is in the queue and of who may see it.

- **A count is of the queue now.** It has no date basis and no `D`: it is what the queue holds at the moment of the read, in one snapshot per key (the read runs at `REPEATABLE READ`), so that the counts of one key agree with each other. It is exact: never capped, never an estimate, never rounded.
- **Identical to its list, by construction.** A count is the number of records that the queue's own list operation returns for the same session and the same filter: the same predicate (one function that the list and the count both call), read under the security context of the key that list requires (the grant's scope, the hubs the session reaches, row-level security). A count therefore never reaches a record the same grant's list would not, and the portal's link to a queue shows what the count counted. **With the hub filter too** (`hub_id`, task C3): the list is given the hub as its own filter and the count is given the same, by the one function ([hub filters](../operations/hub-filters.md)), so a hub's count is the number of records the list returns with that `hub_id`.
- **Present, absent and zero.** An entry exists only for a queue the session may read (the list's key, and for an approver's queue the decision key as well). **A queue the session may not read is absent, never `0`**, so that its absence tells nothing. A `0` is a successful read that found no record. A read that failed is no entry at all, and the client says so; it never draws a count it was not given.
- **The age is the oldest item's.** `oldest_at` is the moment the oldest record in the queue entered it (the basis is each entry's fifth point) and is **absent when the count is 0**. It is a moment, not a number of days: no bucket, target or threshold exists (§14), and none is invented.
- **Nothing else is returned.** An entry holds a queue identifier, the count and the moment. No record, code, name, hub, vendor or breakdown, so that a figure lets a reader infer nothing the same grant's list would not give them. A request that names a hub gets the same shape: the answer does not repeat the hub and has no breakdown by hub.
- **By hub (task C3).** With a `hub_id` every count is the number of the records its list returns with that `hub_id` ([hub filters](../operations/hub-filters.md) owns the rule). **The per-hub counts of a queue need not add up to the count of all hubs, and for the staff approver's queue they do not, by decision** (Product Owner, 6 November 2026): a profile with no primary hub is counted when a session whose `staff.read` grant is of every hub chooses no hub, and in no single hub's count (§5.5.6).

**The P-1 assessment** ([the Ops surface matrix](../../surfaces/ops-portal.md#the-overview-section-authorization-and-destinations), "P-1. Work summaries"), recorded for the two domains these counts read, before any summary of them is served. The four points, in order:

1. *What is covered.* Exactly the six counts and their six moments of §5.5.1 to §5.5.6, named one by one. No other count, age, state or total of the two domains is served by this read, and none is summed with another (a total across queues, or across hubs of different scopes, is never formed, and the counts of the hubs are not added up to the count of all hubs, by the server or by a client: [§5.5.6](#556-queuestaffawaitingapproval--staff-profiles-waiting-for-approval) owns why, for the staff approver's queue).
2. *Scope and visibility.* `pickup.read` and `staff.read` keep the grant scope and the record visibility they have for their lists ([permissions.md](../../contracts/permissions.md) §5, and §7 "Read permissions", and [the data-scope registry](../../contracts/data-scope-registry.md)): each count runs under the context its list's key gives (the effective scope of that grant, never the widest grant the session holds), and a test holds each count equal to its list for an Ops Staff, a Senior Ops and a Platform Admin. No new key is added.
3. *Protected information.* None of the records read has a blind count, a price or a credential in what the summary returns, because it returns none of the record. A small count (`1`) names one record only to a reader who could already list it. Money: none.
4. *Workflow restrictions.* The two approver's queues (§5.5.3, §5.5.6) are the work of the holders of their decision key, and appear for no one else. Every other queue is the work of anyone who may read the list. A Vendor or a Rider session reads nothing here.

`staff.read` is not one of the domains the P-1 text lists, and the staffing aggregates of the Overview are still unresolved ([the matrix](../../surfaces/ops-portal.md#the-overview-section-authorization-and-destinations)); this assessment covers only the one count of §5.5.6, for the one audience that already reads the staff list (Senior Ops and Platform Admin).

#### 5.5.1 `queue.pickup.awaiting_confirmation` — Pickup requests waiting for confirmation

| Point| Entry|
|---|---|
| 1. Name, purpose, unit, owner| *Pickup requests waiting for confirmation* (queue `PICKUP_AWAITING_CONFIRMATION`). The requests an officer has yet to confirm, decline or cancel. Unit: requests (distinct). Owning domain: pickup|
| 2. Source and inclusion| `PickupRequest` rows in state `PENDING` ([state-machines.md](../../contracts/state-machines.md) §3: `PENDING → CONFIRMED` and `PENDING → DECLINED` are Ops's). A `PENDING` request that carries an exception not yet approved is in it (it cannot be confirmed until the exception is, and is also in §5.5.3: each queue is defined by its own filter, and the two are never netted). `CONFIRMED`, `DECLINED` and `CANCELLED` requests are not in it|
| 3. Formula| The count of those rows within the caller's scope. `oldest_at` is the least `created_at` of them|
| 4. Date basis| None: the queue as it stands at the read|
| 5. Age origin, buckets, targets| The moment the request was created (`created_at`): it waits from creation. None defined (§14)|
| 6. Money| None|
| 7. Permission, scope, masking| `pickup.read`, at the scope of the grant (Ops Staff and Senior Ops hold it at their hub, the Platform Admin at all hubs): the scope of `listPickupRequests`. No masking: a count and a moment|
| 8. As-of and latency| As of the read; one statement|
| 9. Contract| `getQueueSummary`, `queue` = `PICKUP_AWAITING_CONFIRMATION`|
| 10. Drill-down| `listPickupRequests` with `state=PENDING`; the destination permission is the list's|
| 11. Acceptance examples| Three requests of the officer's hub are `PENDING`: the count is 3 and `oldest_at` is the earliest `created_at` of the three. One is confirmed: 2. A `PENDING` request of another hub is not counted for an officer of this hub (and is for a session whose `pickup.read` grant is of all hubs). A session without `pickup.read` has no entry. No request waits: `count` 0 and no `oldest_at`, when the read succeeded|

#### 5.5.2 `queue.pickup.cutoff_review` — Late bookings waiting for the cut-off decision

| Point| Entry|
|---|---|
| 1. Name, purpose, unit, owner| *Late bookings waiting for the cut-off decision* (queue `PICKUP_CUTOFF_REVIEW`). The confirmed requests whose booking passed the hub's cutoff and which Ops has yet to resolve (`resolveCutoffException`). Unit: requests (distinct). Owning domain: pickup|
| 2. Source and inclusion| `PickupRequest` rows in state `CONFIRMED` whose `cutoff_exception_state` is `PENDING_OPS_REVIEW` ([state-machines.md](../../contracts/state-machines.md) §3, `AC-SLICE-001-04`: "a late booking queues, it does not fail"). A request whose review was resolved (`SAME_DAY_APPROVED`, `RESCHEDULED`) is not in it|
| 3. Formula| The count of those rows within the caller's scope. `oldest_at` is the least `confirmed_at` of them|
| 4. Date basis| None: the queue as it stands at the read|
| 5. Age origin, buckets, targets| The moment the request was confirmed (`confirmed_at`): the confirmation is what raises the review. None defined (§14)|
| 6. Money| None|
| 7. Permission, scope, masking| `pickup.read`, the scope of `listPickupRequests`|
| 8. As-of and latency| As of the read; one statement|
| 9. Contract| `getQueueSummary`, `queue` = `PICKUP_CUTOFF_REVIEW`|
| 10. Drill-down| `listPickupRequests` with `state=CONFIRMED` and `cutoff_exception_state=PENDING_OPS_REVIEW` (the filter task C1.1 added, `AC-QSUM-10`; [openapi.yaml](../../contracts/openapi.yaml)): the list returns exactly the requests the count counts, and the two call one function for the filter|
| 11. Acceptance examples| A request confirmed after the cutoff and not yet resolved: counted. The same request after `resolveCutoffException`: not counted. A confirmed request booked in time: not counted. A `PENDING` request: not counted (nothing has queued yet)|

#### 5.5.3 `queue.pickup.exception_approval` — One-package exceptions waiting for approval

| Point| Entry|
|---|---|
| 1. Name, purpose, unit, owner| *One-package exceptions waiting for approval* (queue `PICKUP_EXCEPTION_APPROVAL`): the approver's queue. Unit: requests (distinct), each counted once however many exceptions it has had. Owning domain: pickup|
| 2. Source and inclusion| `PickupRequest` rows whose one-package exception, the one the request carries or else the latest raised for it, is `REQUESTED` (`AC-SLICE-001-03`; the filter `one_package_exception_state=REQUESTED` of `listPickupRequests`), **of the requests in state `PENDING` alone** (Product Owner, 5 and 6 November 2026; `AC-QSUM-12`): a request that is not pending (one cancelled while its exception was `REQUESTED` keeps that exception in that state) can no longer have its exception decided (`approveOnePackageException` refuses a request that is not `PENDING` with `STATE_CONFLICT`), so it is not the approver's work and the list and the count both leave it out|
| 3. Formula| The count of those rows within the caller's scope. `oldest_at` is the least `requested_at` of the exceptions that put them in|
| 4. Date basis| None: the queue as it stands at the read|
| 5. Age origin, buckets, targets| The moment the exception was requested (`requested_at` of that exception). None defined (§14)|
| 6. Money| None|
| 7. Permission, scope, masking| **Two keys.** `pickup.read` (the list's, which decides the scope) and `pickup.exception.approve` (the decision key, which decides that the queue is the session's work): no entry unless the session holds both. The scope is the list's|
| 8. As-of and latency| As of the read; one statement. **Measured at 400,000 requests** (task P1.1, 6 November 2026; 850 exceptions asked for, 400 of them on pending requests; the runtime role under the real security context): the count took 19 ms for a session of one hub and 17 ms for a Platform Admin, and the list 14 ms. The plan starts from the exceptions asked for (`one_package_exception_state_idx`), and the condition of `AC-QSUM-12` (`state = 'PENDING'`) is a filter on the requests it reaches: it changes neither the plan nor the time (the form it replaced took 23 and 19 ms)|
| 9. Contract| `getQueueSummary`, `queue` = `PICKUP_EXCEPTION_APPROVAL`|
| 10. Drill-down| `/approvals`, which lists `listPickupRequests` with `one_package_exception_state=REQUESTED`|
| 11. Acceptance examples| An exception requested and not decided: counted, and `oldest_at` is its `requested_at`. Approved or rejected: not counted. A request whose first exception was rejected and which was given a new one, not yet decided: counted once, for the new one, and `oldest_at` is the new exception's `requested_at` (a request that carries an approved exception takes no other, `STATE_CONFLICT`). A request that is not `PENDING` (a cancelled one, for example) while its exception was `REQUESTED`: not counted, because its exception can no longer be decided (`AC-QSUM-12`). A session that holds `pickup.read` and not the decision key has no entry|

#### 5.5.4 `queue.pickup.unmanifested_pool` — Confirmed pickups not yet on a run

| Point| Entry|
|---|---|
| 1. Name, purpose, unit, owner| *Confirmed pickups not yet on a run* (queue `PICKUP_UNMANIFESTED_POOL`): the manifest pool (`AC-SLICE-001-11`). Unit: requests (distinct). Owning domain: pickup|
| 2. Source and inclusion| `PickupRequest` rows in state `CONFIRMED` that no manifest holds (no unreleased stop claims them), less those whose `cutoff_exception_state` is `PENDING_OPS_REVIEW`, which the plain list of confirmed requests still shows ([pickup-manifest.md](../pickup/pickup-manifest.md) §4; `listPickupRequests` with `state=CONFIRMED` and `manifested=false`)|
| 3. Formula| The count of those rows within the caller's scope. `oldest_at` is the least `confirmed_at` of them|
| 4. Date basis| None: the queue as it stands at the read|
| 5. Age origin, buckets, targets| The moment the request was confirmed (`confirmed_at`). A request that returned to the pool when its manifest was cancelled has waited since then, and the confirmation is the earlier moment: the figure never understates the wait (accepted by the Product Owner, 5 November 2026). None defined|
| 6. Money| None|
| 7. Permission, scope, masking| `pickup.read`, the scope of `listPickupRequests`. The `manifested` filter is staff-only, and so is this entry (a Vendor or Rider session reads none of the summary)|
| 8. As-of and latency| As of the read; one statement. **It is the one count whose cost grows with the history of the hub.** A request that was collected keeps its unreleased stop and stays `CONFIRMED`, so "no unreleased stop" is asked of every confirmed request (task C1 measured 0.7 to 2.3 seconds at 380,000 confirmed requests, a hub's 190,000 of them read at the hub's scope; each of the five others took under 2.5 milliseconds). The list's own `manifested=false` filter has the same cost for its first page. No index can make "has no row" a lookup; a marker kept on the request would (§14), and since task P1.1 the summary fails whole if this count passes 3 seconds (`AC-QSUM-13`)|
| 9. Contract| `getQueueSummary`, `queue` = `PICKUP_UNMANIFESTED_POOL`|
| 10. Drill-down| The manifest builder's pool, from `listPickupRequests` with `state=CONFIRMED` and `manifested=false`|
| 11. Acceptance examples| Three confirmed requests, one of them on a draft manifest: 2. The manifest cancelled, its claim released: 3. A confirmed request awaiting its cutoff review: not counted here, counted in §5.5.2|

#### 5.5.5 `queue.pickup.runs_in_progress` — Pickup runs in progress

| Point| Entry|
|---|---|
| 1. Name, purpose, unit, owner| *Pickup runs in progress* (queue `PICKUP_RUNS_IN_PROGRESS`). The runs a rider has started and not completed. Unit: manifests. Owning domain: pickup|
| 2. Source and inclusion| `PickupManifest` rows in state `IN_PROGRESS` ([state-machines.md](../../contracts/state-machines.md) §4; `listPickupManifests` with `state=IN_PROGRESS`, with **no** `service_date`: a started run keeps its date past midnight). `DRAFT`, `DISPATCHED`, `COMPLETED` and `CANCELLED` are not in it|
| 3. Formula| The count of those rows within the caller's scope. `oldest_at` is the least `started_at` of them|
| 4. Date basis| None: the queue as it stands at the read|
| 5. Age origin, buckets, targets| The moment the rider started the run (`started_at`). None defined (§14)|
| 6. Money| None|
| 7. Permission, scope, masking| `pickup.read`, the scope of `listPickupManifests`. The rider's own reads of its manifests are not this: the entry is for staff|
| 8. As-of and latency| As of the read; one statement|
| 9. Contract| `getQueueSummary`, `queue` = `PICKUP_RUNS_IN_PROGRESS`|
| 10. Drill-down| `listPickupManifests` with `state=IN_PROGRESS` (`/manifests?state=IN_PROGRESS`)|
| 11. Acceptance examples| A dispatched run is not counted; once the rider starts it, it is, with its `started_at`. When its last stop turns terminal and the system completes it, it leaves. A run of another hub is not counted for an officer of this hub|

#### 5.5.6 `queue.staff.awaiting_approval` — Staff profiles waiting for approval

| Point| Entry|
|---|---|
| 1. Name, purpose, unit, owner| *Staff profiles waiting for approval* (queue `STAFF_AWAITING_APPROVAL`): the approver's queue. Unit: staff identities. Owning domain: identity (staff)|
| 2. Source and inclusion| `StaffIdentity` rows whose `status` is `PENDING_APPROVAL` (`AC-SLICE-000-86`; `listStaffIdentities` with `status=PENDING_APPROVAL`). Whether the approver may approve this one (the maker's own, a bundle above the approver's tier) is not part of the count: those are refused by the act, and the list shows them (`AC-SLICE-000-85`)|
| 3. Formula| The count of those rows within the caller's scope. `oldest_at` is the least `created_at` of them. **With a hub** (`hub_id`, task C3): the rows whose primary hub is that hub, as `listStaffIdentities` filters them. A profile with no primary hub (the seeded Platform Admin has none) is counted for a session whose `staff.read` grant is of every hub when it chooses no hub, and in no single hub's count: the per-hub counts of this queue do not add up to the all-hub count, by decision of the Product Owner of 6 November 2026 ([hub filters](../operations/hub-filters.md), section 14)|
| 4. Date basis| None: the queue as it stands at the read|
| 5. Age origin, buckets, targets| The moment the profile was made (`created_at`): it is `PENDING_APPROVAL` from creation. None defined (§14)|
| 6. Money| None|
| 7. Permission, scope, masking| **Two keys.** `staff.read` (the list's: Senior Ops at their hub, Platform Admin at all hubs, Ops Staff none, on purpose) and `staff.identity.approve` (the decision key): no entry unless the session holds both. The scope is `listStaffIdentities`'s. A count of colleagues' profiles reveals no name|
| 8. As-of and latency| As of the read; one statement|
| 9. Contract| `getQueueSummary`, `queue` = `STAFF_AWAITING_APPROVAL`|
| 10. Drill-down| `/admin/staff` with the approver's view (`listStaffIdentities` with `status=PENDING_APPROVAL`)|
| 11. Acceptance examples| Two profiles are pending at the Senior Ops user's hub: 2, and a third pending at another hub is not counted for them. A profile approved or rejected leaves. An Ops Staff session has no entry (it holds neither key). A profile with no primary hub is in a Platform Admin's count when no hub is chosen and in no single hub's count|

## 6. Entities

[domain-model.md](../../contracts/domain-model.md) §6.2 (`PickupRequest`: `scheduled_service_date`, `state`, `cutoff_exception_state`, `created_at`, `confirmed_at`; `OnePackageException`: `state`, `requested_at`), §6.3 (`PickupManifest`: `service_date`, `state`, `started_at`), §6.4 (`PickupStop`: `state`, `resolved_at`, `carryover_snapshot`, `released_at`) and §6.8 (`StaffIdentity`: `status`, `created_at`). Nothing is stored for a measure: each is derived from these.

## 7. States

[state-machines.md](../../contracts/state-machines.md) §3 to §5 and §13.3. The measures read the states `PENDING`, `CONFIRMED`, `CANCELLED`, `DECLINED` of a request, the exception states `REQUESTED`, `APPROVED`, `REJECTED`, the cutoff review state `PENDING_OPS_REVIEW`, the states of a manifest, the stop states `PENDING`, `ARRIVED`, `COLLECTED`, `PARTIALLY_COLLECTED`, and the staff status `PENDING_APPROVAL`.

## 8. Permissions and scope

As [the Ops surface matrix](../../surfaces/ops-portal.md#the-overview-section-authorization-and-destinations) states them for the section that shows a measure. Hub scope is the section's, never the vendor's: these measures count work across vendors and are not vendor-readable. **The queue counts of §5.5** add no key: each is gated by the key of its list (`pickup.read`, `staff.read`) and, for the two approver's queues, by their decision key as well (`pickup.exception.approve`, `staff.identity.approve`), and each is counted in the scope of its list's grant ([the P-1 assessment](#55-the-queue-counts-queue-what-they-have-in-common)).

## 9. Settings

None. A threshold or a target would be a setting of the operating policy; **none is defined**.

## 10. Errors

The measures of §5.1 to §5.4: none specified, no operation serves them yet. `getQueueSummary` answers the errors of a read of the caller's own session: `SESSION_INVALID` for a session that has ended and for a Rider's bearer credential (the operation takes none), and `PERMISSION_DENIED` for a Vendor session. It answers `VALIDATION_FAILED`, naming `hub_id`, for a `hub_id` that is not a UUID or is given twice ([hub filters](../operations/hub-filters.md), task C3), and no `HUB_SCOPE_VIOLATION` or `NOT_FOUND` (it names no record, and a hub outside the grant or that names no hub is a `0`): a queue the session may not read is absent from the answer, which is how it is told.

## 11. Audit and side effects

None. A measure is a read. **`getQueueSummary` writes no event and changes nothing**, including no `auth.hub_boundary.crossed`: that event is written for a read of a record and for the page of a list, without contents, and the audit rule ([audit.md](../../contracts/audit.md) §5.4 and §6) says nothing of an aggregate that holds neither (the Product Owner accepted that on 5 November 2026). Its route is `background` ([the access declaration](../../apps/api/CLAUDE.md)): reading it never extends the idle lifetime of a session, because the portal asks for it without a person's act (when it loads and when a page is returned to).

## 12. API operations

`getQueueSummary` (`GET /ops/queue-summary`, task C1, with the optional `hub_id` of task C3 that [hub filters](../operations/hub-filters.md) owns): one read, for any signed-in Ops Portal staff session, that returns one entry for each queue of §5.5 the session may read: `queue`, `count` and, when the count is not 0, `oldest_at`. It is `self` in the permission catalogue (`x-permission: self`): no key admits the call, and each key of §8 admits its entries. Nothing else of any measure of this document is served by an operation.

## 13. Acceptance criteria

The measures of §5.1 to §5.4 have none numbered: their acceptance examples (§5) become criteria of the bounded task that contracts them, with their identifiers, when they are admitted. **The queue counts of §5.5 are contracted by task C1, and its criteria are these.** Each is held by a test of the layer it names. The hub filter of the summary (`hub_id`, task C3) has its criteria in [hub filters](../operations/hub-filters.md#13-acceptance-criteria), and no `AC-QSUM` row repeats them.

| ID| Criterion| Held by|
|---|---|---|
| `AC-QSUM-01`| **Only the queues the session may read, and a queue it may not read is absent, never `0`.** An Ops Staff session, a Senior Ops session and a Platform Admin session each get exactly the entries of the queues whose keys (§8) they hold; a session that holds none gets an empty list. An entry for a queue is never present with a `0` in place of an absence| API database tests (`queue-summary.db.test.ts`)|
| `AC-QSUM-02`| **A count is what its list returns.** For each of the six queues and for each of the three roles, `count` equals the number of items that the queue's own list operation returns for the same session and filter (all pages), and `oldest_at` is the earliest of the moments of §5.5's fifth point among them. The late bookings (§5.5.2) equal the items of the list with `state=CONFIRMED` and `cutoff_exception_state=PENDING_OPS_REVIEW` (`AC-QSUM-10`)| API database tests|
| `AC-QSUM-03`| **A count is scoped as its list is.** A record of another hub is not counted for a session whose grant is of its own hub; a grant of all hubs counts every hub; a session whose grant reaches no hub has its entry with `0`. Taking another key's scope, or the widest grant the session holds, is never what scopes a count| API database tests|
| `AC-QSUM-04`| **An approver's queue needs the decision key.** A session that holds `pickup.read` and not `pickup.exception.approve` has no `PICKUP_EXCEPTION_APPROVAL` entry; one that holds `staff.read` and not `staff.identity.approve` has no `STAFF_AWAITING_APPROVAL` entry| API database tests|
| `AC-QSUM-05`| **Nothing but the count and the moment.** An entry holds `queue`, `count` and, when `count` is not 0, `oldest_at`, and no other property; no record, code, name, hub, vendor or breakdown appears anywhere in the answer| API database tests, contract check|
| `AC-QSUM-06`| **Ops staff only, and fresh.** A Vendor session is `PERMISSION_DENIED`, a Rider's bearer credential and a session that has ended are `SESSION_INVALID`; the answer is `Cache-Control: no-store`; the read writes no audit event and does not extend the session's idle lifetime| API database tests|
| `AC-QSUM-07`| **The menu draws a count only when it has one.** A count is drawn beside the entry of its queue ([the Ops surface](../../surfaces/ops-portal.md#4-navigation-model)) only when the summary was read and holds that queue; a count that is loading, missing or failed is not drawn, never as `0`, and a failed read leaves the menu working| Portal component tests, browser spec|
| `AC-QSUM-08`| **My work says what the summary says.** The landing has a card for each queue the summary returned **that holds something**, with its count and a link to the queue (to the set, where the queue's page takes the filter) and the moment its oldest record has waited since, the oldest first; the queues the summary returned with `0` are not cards but one line, *Also clear: …*, naming them (the Product Owner's brief of 6 November 2026); it says *nothing is waiting* only when the summary was read, every count it returned is `0` and the page has words for every queue it returned (a queue it has none for makes the summary *incomplete*: the page says *Some queues cannot be shown on this page.* and never that nothing is waiting); a session the summary gave no queue is told who is signed in and never that nothing is waiting; a failed read says the summary could not be read and offers *Try again*| Portal component tests, browser spec|
| `AC-QSUM-09`| **Read on load, on a change of page, on request, on a change of hub and after an act that changes a queue; never on a timer.** The summary is read when the signed-in shell loads, when the person goes to another page (a change of path: a filter on the page they are on is not one), when they ask for a refresh of a queue, when they choose another hub (a read for that hub, `AC-HUBF-09`) and after an act that can change what a queue holds, once the server has answered it with success (the Product Owner's decision D11(b), 6 November 2026; the acts are the Ops Portal's table in `platform/queue-summary/queue-changing-acts.ts`, held to the contract by a test, and a refused or failed act causes no read); the portal sets no interval for it, and it is not read on a change of focus or of connection| Portal component tests|
| `AC-QSUM-10`| **The late bookings have a filter of their own.** `listPickupRequests` takes an optional `cutoff_exception_state` (`PENDING_OPS_REVIEW`, `SAME_DAY_APPROVED` or `RESCHEDULED`; any other value is `VALIDATION_FAILED`, and an absent one changes nothing). With `state=CONFIRMED` and `cutoff_exception_state=PENDING_OPS_REVIEW` the list returns, to the same session and across all its pages, exactly the requests that `PICKUP_CUTOFF_REVIEW` counts, for an Ops Staff, a Senior Ops and a Platform Admin session. The count calls the same function for that filter as the list does| API database tests|
| `AC-QSUM-11`| **The landing opens the set that was counted for the late bookings.** The link of `PICKUP_CUTOFF_REVIEW` opens the pickup requests with that filter (`/pickup-requests?state=CONFIRMED&cutoff=PENDING_OPS_REVIEW`); the page sends the filter to the server, says in words that it is set and offers to take it off, and keeps it when the person returns to the list from a request. **The late bookings are the confirmed requests whose decision is pending**, so the filter is a refinement of the Confirmed state: any other state takes it off, an address that has it without `state=CONFIRMED` does not apply it, and a request cancelled since (which keeps the decision it had) is never asked to be decided on a row (the review of C1.1, 6 November 2026)| Portal component tests, browser spec|
| `AC-QSUM-12`| **Only a pending request is in the approver's queue.** A request in any state but `PENDING` (a cancelled one, a confirmed one, a declined one) is neither in the list `one_package_exception_state=REQUESTED` nor counted by `PICKUP_EXCEPTION_APPROVAL`, because the exception of a request that is not `PENDING` can no longer be decided (`approveOnePackageException` answers `STATE_CONFLICT`: the queue is the guard's by the state of the request, the Product Owner's decision of 6 November 2026, which widened the exclusion C1.1 made of the cancelled requests; the guard also refuses by who asks and by hub, which a queue of what is waiting does not model); the list and the count agree, for Ops Staff, Senior Ops and a Platform Admin, and every `PENDING` request whose exception is `REQUESTED` stays| API database tests|
| `AC-QSUM-13`| **A count is bounded.** Every count of `getQueueSummary` runs under a statement timeout of 3 seconds (a `SET LOCAL`, the first statement of the transaction of its counts once its security context is set, which only ever lowers the bound the configuration set; the Product Owner's decision of 6 November 2026). A count that cannot finish in that time ends the whole read as the platform's failed read (`503`, no code, nothing of the answer), and is never told as a queue of `0` or as a queue that is missing; the Ops Portal draws no count in the menu (`AC-QSUM-07`) and a failure with a way to try again on the landing (`AC-QSUM-08`), and the next read, which meets no leftover setting, answers whole| API unit and database tests (the limiter, and a count held on a lock for longer than 3 seconds)|

## 14. Unresolved requirements

| What is not decided| Affects| Needed|
|---|---|---|
| **Whether a `PENDING` request is ever overdue.** This entry counts only `CONFIRMED` requests, because nothing is promised until a request is confirmed. If a request awaiting confirmation past its day must be reported, it is another measure| *Overdue backlog*| Before the measure is contracted|
| **Lateness across a rescheduled chain.** A failed attempt is rescheduled as a cancellation and a new request with its own promise (`replaces_request_id`). Whether the lateness of the work counts from the first promise or from each, is not decided; each request is measured against its own promise until it is| All three| Before the measures are contracted|
| **Calendar days or operating days.** Lateness here is in calendar days; the hub does not operate on Sunday, so a Saturday promise collected on Monday is two days late by this count, and one by an operating-day count| *Overdue backlog*, *Completed late*| With the operating policy|
| **Targets, ageing buckets and escalation thresholds** for old work. None is defined and none is invented; the rule of 2 November 2026 is that old work stays visible until it is explicitly resolved, with no automatic expiry| All three| With the operating policy, before any automated escalation|
| **A promised window.** Without an authoritative promised window there is no lateness by the hour or the minute| All three| If the business promises a window|
| **How a report presents a run that straddles midnight.** The lifecycle is decided (2 November 2026, §4): the run keeps its `service_date` and its actual moments, and each pickup is dated by its own event. What is open is only the presentation: the run under its planned date with its pickups under their own| *Completed late*, *Carryover planned*| With the report that shows it|
| **The meaning of "fulfilled" for custody.** A pickup is fulfilled when a stop is collected or partly collected. If fulfilment must wait for the hub's count, the date basis moves| *Completed late*| Before the measure is contracted|
| **The permission, hub scope and masking** of each figure, and the contract operation that serves it| The four of §5.1 to §5.4 (the six of §5.5 have theirs)| The task that contracts the measure|
| **The cost of the pool at scale.** The count of §5.5.4 (and the list filter it follows, `manifested=false`) reads every confirmed request, because a collected request stays `CONFIRMED` with an unreleased stop: 0.7 seconds at 380,000 confirmed requests with a hub that reads none, 1.7 seconds at all hubs and 2.3 at one hub of 190,000. There were three options: a marker kept on the request that says it is on a run (set and cleared with the stop, by the database), ending the claim of a request whose pickup is closed, or bounding the pool by a date. **The Product Owner chose the marker on 5 November 2026.** It is not built: [the implementation plan](../../delivery/IMPLEMENTATION_PLAN.md#3a-the-ops-portal-redesign) holds it as a performance task for before production volumes. Until then a read of the summary pays this cost whenever the session may read the pool, and a hub that grows into the hundreds of thousands of confirmed requests will feel it, and since task P1.1 a pool count that passes 3 seconds ends the whole summary as a failed read (`AC-QSUM-13`; [the plan's performance task](../../delivery/IMPLEMENTATION_PLAN.md#3a-the-ops-portal-redesign) says at what size)| *Confirmed pickups not yet on a run*, `getQueueSummary` and `listPickupRequests`| Before a hub's history passes about 100,000 confirmed requests|

**Decided on 5 November 2026 (tasks C1 and C1.1), so no longer open:** a queue's age is the moment the record entered the queue (the fifth point of each entry of §5.5, a returned request being old from its confirmation); the summary writes no audit event and, as background activity, never extends the idle session (§11); the late bookings have a filter of their own (`AC-QSUM-10`); a cancelled request leaves the approver's queue because its exception can no longer be decided (`AC-QSUM-12`; task P1.1 made it every request that is not pending, on 6 November 2026); and every Ops Staff member holds `pickup.exception.approve`, as [permissions.md](../../contracts/permissions.md) and [pickup-request.md](../pickup/pickup-request.md) say. **The Platform Admin holds every key it holds at all hubs** (Product Owner, 5 November 2026; task P1, `AC-SLICE-001-83`), so a Platform Admin with no primary hub counts every hub's pickup work, exactly as its lists show it, and the five pickup queues are no longer `0` for it.

## 15. Related documents

[pickup-request.md](../pickup/pickup-request.md); [pickup-manifest.md](../pickup/pickup-manifest.md); [daily-operations-and-cash-report.md](daily-operations-and-cash-report.md); [the Overview dashboard design](../../design/OVERVIEW_DASHBOARD_DESIGN.md); [the Ops surface matrix](../../surfaces/ops-portal.md#the-overview-section-authorization-and-destinations).

## 16. Implementation status

The four measures of §5.1 to §5.4 are not implemented. The data they need exists in part (`scheduled_service_date`, the manifest and stop tables, `carryover_snapshot`); the collection records that make a pickup *fulfilled* arrive with S1.24 and S1.26. No operation, screen or report serves them.

**The six queue counts of §5.5 are implemented by task C1:** `getQueueSummary` serves them, the navigation of the Ops Portal draws them beside the entries of the queues that have one, and the landing lists them (`AC-QSUM-01` to `AC-QSUM-09`). **Task C1.1 (6 November 2026)** gives `listPickupRequests` the filter of the late bookings, sends the landing's link for them to that set, and leaves the cancelled requests out of the approver's queue (`AC-QSUM-10` to `AC-QSUM-12`); **task P1.1 (6 November 2026)** leaves every request but a pending one out of it (`AC-QSUM-12`) and bounds each count of the summary at 3 seconds (`AC-QSUM-13`); **task C3 (6 November 2026)** gives the summary an optional `hub_id` that narrows every count to one hub, as the list of each queue is narrowed (`AC-HUBF-04` and `-06` of [hub filters](../operations/hub-filters.md)). No Overview section, report or total is built from them.
