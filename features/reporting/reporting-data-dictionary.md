# Reporting data dictionary

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Owns:** the canonical definition of each reporting measure, one entry per measure, admitted by the domain that supplies it
> **Slice:** none yet; measures are admitted one at a time by the domain that supplies them, and `SLICE-012` integrates them

> Link paths in this document use `../../`, correct from `features/reporting/<name>.md`.

## 1. Purpose and scope

This is the reporting data dictionary that [Master Specification §32.5](../../PROJECT_MASTER_SPECIFICATION.md) requires and `OQ-049` still owed ([the implementation plan](../../delivery/IMPLEMENTATION_PLAN.md#3-sequence) names this file as its home). A measure has **one** canonical definition: its entry here. An entry records what is counted, from which records, on what date basis and what it is not, and **references the owning feature's business rules instead of restating them**. The rules of the domain stay in the domain's feature; the entry says only how a figure is formed from them.

It is not the [Overview dashboard](../../design/OVERVIEW_DASHBOARD_DESIGN.md) (which only displays a measure, and is not built), not a report, and not a contract: **no measure here is served by an operation yet**, and nothing is built from an entry until its own bounded task says so. A sample figure is never a result. A figure that is unavailable or incomplete is never shown as zero, and a successful, complete, authorized read that finds no matching record is zero (§4).

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

## 6. Entities

[domain-model.md](../../contracts/domain-model.md) §6.2 (`PickupRequest`: `scheduled_service_date`, `state`), §6.3 (`PickupManifest`: `service_date`, `state`) and §6.4 (`PickupStop`: `state`, `resolved_at`, `carryover_snapshot`). Nothing is stored for a measure: each is derived from these.

## 7. States

[state-machines.md](../../contracts/state-machines.md) §3 to §5. The measures read the states `CONFIRMED`, `CANCELLED`, `DECLINED` of a request, the states of a manifest and the stop states `PENDING`, `ARRIVED`, `COLLECTED`, `PARTIALLY_COLLECTED`.

## 8. Permissions and scope

As [the Ops surface matrix](../../surfaces/ops-portal.md#the-overview-section-authorization-and-destinations) states them for the section that shows a measure. Hub scope is the section's, never the vendor's: these measures count work across vendors and are not vendor-readable.

## 9. Settings

None. A threshold or a target would be a setting of the operating policy; **none is defined**.

## 10. Errors

None specified: no operation serves a measure yet.

## 11. Audit and side effects

None. A measure is a read.

## 12. API operations

None yet.

## 13. Acceptance criteria

None are numbered: a measure's acceptance examples (§5) become criteria of the bounded task that contracts it, with their identifiers, when it is admitted.

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
| **The permission, hub scope and masking** of each figure, and the contract operation that serves it| All three| The task that contracts the measure|

## 15. Related documents

[pickup-request.md](../pickup/pickup-request.md); [pickup-manifest.md](../pickup/pickup-manifest.md); [daily-operations-and-cash-report.md](daily-operations-and-cash-report.md); [the Overview dashboard design](../../design/OVERVIEW_DASHBOARD_DESIGN.md); [the Ops surface matrix](../../surfaces/ops-portal.md#the-overview-section-authorization-and-destinations).

## 16. Implementation status

Nothing is implemented. The data these measures need exists in part (`scheduled_service_date`, the manifest and stop tables, `carryover_snapshot`); the collection records that make a pickup *fulfilled* arrive with S1.24 and S1.26. No operation, screen or report serves a measure.
