# Implementation Plan

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.66 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** the slice sequence, dependencies, and the readiness verdict for each
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../PROJECT_MASTER_SPECIFICATION.md) §44, §45, §13

## 1. What a slice is

A slice delivers a demonstrable product capability across its required surfaces and backend. Implement it as bounded tasks under [DEVELOPMENT_EXECUTION_PLAN.md](DEVELOPMENT_EXECUTION_PLAN.md); a task may cover a small part of a slice. Preserve existing slice IDs.

## 2. How a slice moves

Define scope and unresolved requirements, implement bounded increments, run meaningful checks, fix failures and demonstrate the integrated capability. The readiness and completion standards apply to the actual scope. A specification status is not a build or release result.

## 3. Sequence

Ordered by dependency, not by value. A slice appears after everything it needs.

**What the slices are collectively for — §43.4.** The baseline states the acceptance gate for the whole product, and **no document cited it** until the Phase 4 audit:

> *"Version 1 cannot be accepted until the approved launch transaction can be demonstrated **from booking through a terminal delivery/return and financial outcome, including exception recovery**."*

**That is one continuous demonstration, not a sum of slice demonstrations.** `SLICE-000` through `SLICE-004` are each demonstrable alone; §43.4 asks for booking → pickup → hub → price → dispatch → delivery → payment → reconciliation **in one run, with an exception recovered along the way**. Nothing in this plan produces that until `SLICE-004` completes, and the plan should not be read as implying otherwise.

§43.4 also names what launch acceptance still depends on: payment and reconciliation detail, technical security and OTP contracts, exceptional returns and claims, reporting targets, and measurable NFRs.

| #| Slice| Covers| Depends on| Blocked by|
|---|---|---|---|---|
| **000**| **Identity and access**| Staff, rider and vendor authentication; **credential and MFA setup**; **creating and approving a staff identity (§30.8, `MSC-DEC-425`) with the reads an approver takes a version from and the read a maker takes a bundle from**; session, device and recovery lifecycle; permission enforcement. **42 operations, 20 Ops Portal routes, 133 criteria** (38, 19 and 126 until 25 October 2026, when the Product Owner's trusted browser — *remember this browser*, [staff-authentication.md](../features/identity/staff-authentication.md) §5.8 — added four operations, one route and the criteria `AC-SLICE-000-133` to `-139`) — re-derived 2 October 2026 at Gate PD-3R3 (Gate PD-3R1 had 36 and 108; `MSC-DEC-439` added the bundle read and `MSC-DEC-440` one criterion for the bootstrap pair), again on 6 October 2026, when the Product Owner's decisions added 13 criteria and left the Vendor PWA and Rider app screens (12 of the former 31 routes and screens) to the slices that build those clients, and again on 9 October 2026, when the Product Owner added `listReasonDefinitions` (the reason pickers' read) and `AC-SLICE-000-132` — **until then the Vendor and Rider rows of the demonstration are verified at API level**; the bundle-change operations and six criteria that needed other slices' records are not in it (§4c, `MSC-DEC-433`). *The demonstration's rider and vendor account are non-production fixtures — `MIGRATION_AND_SEEDING.md` §4a and §4b*| — Specification present; implement after Bootstrap B0. Production identity inputs remain in SLICE-000 §6. |
| **001**| **Pickup → hub receiving → itemization**| The proving slice. §21, §22, §23. **Accepted at API and Ops Portal level** (decided 29 October 2026): its Vendor PWA and Rider app halves are verified at API level only, as `SLICE-000`'s are, and the two clients are `SLICE-015` and `SLICE-016`| 000, **014** *(a bounded launch-fee seed — §4a, decided 29 October 2026)* Specification present; requires identity and the launch-fee seed of §4a. |
| **008**| Vendor administration| §29. **Vendor creation is brought forward (5 November 2026, note below)**| 000 Slice document unwritten. Vendor administration features exist; deferred vendor transition design remains required. |
| **009**| Rider and staff administration| §30 — *creating and approving a staff identity is built in `SLICE-000`; the rest of staff administration is here*. **Rider creation is brought forward (5 November 2026, note below)**| 000 Slice document unwritten. Rider/staff administration owns the obligations in §4c. |
| **002**| Recipient confirmation and dispatch| §24, §20.2| 001 Specification present; dispatch requires an eligible priced order and the recipient-confirmation workflow. |
| **003**| Doorstep delivery and OTP| §25, §19.6, §26.2–26.3| 002 Specification present; production payment-provider integration remains an external dependency. |
| **004**| Delivery-fee payment and reconciliation| §26| 003 Slice document unwritten. Finance/adjustment/export features retain accounting and provider gaps, including export retention and event-history completeness. |
| **005**| Outbound third-party handoff| §24.7, §39.6| 002 Slice document unwritten. Carrier-handoff feature specifies both modes and carrier/agent authorization. |
| **006**| Returns and exceptions| §28| 003 Slice document unwritten. Return feature retains claims and exceptional-disposition gaps. |
| **007**| Vendor settlement| §27| 004 Slice document unwritten. Vendor settlement and VendorBalance design remain required. |
| **010**| Notifications — **administration only**| §31, §20.3: editable templates and per-vendor preferences. The notification mechanism and its monitoring are built in `SLICE-001` (task S1.12; decided 29 October 2026)| 002 Slice document unwritten. Notification delivery, providers, templates and retention remain required. |
| **011**| Fleet, fuel and maintenance| §34.10, §35.11| 009 Slice document unwritten. Fleet/fuel/maintenance behavior and configuration require implementation. |
| **012**| Reporting and dashboards| §32| 004 *(what reporting and dashboard work needs to start; final integrated acceptance of the Overview also needs the slice that owns each section it includes, with that section's approved metric definitions and authorization requirements: note below the table)* Slice document unwritten. Reporting feature defines initial requirements; complete remaining formulas and scope. **Owns the final cross-domain integration and acceptance of the Overview dashboard.** |
| **013**| Settings, reason and courier administration, **and background-job / dead-letter administration** *(§4b, CRIT-16)*| §33, §35.9, §17.3, **§42.5**| 000 Slice document unwritten. Include background-job/dead-letter administration (§4b). |
| **014**| **Hub, zone and pricing administration**| §34.9, §35.10, §23.3, §23.9, `MSC-DEC-217–218`| 000 Slice document unwritten. Hub/zone/pricing administration is a dependency of the first priced pickup flow (§4a). |
| **015**| Vendor PWA| [surfaces/vendor-pwa.md](../surfaces/vendor-pwa.md), including the Vendor's in-app notification feed screens| 001 Slice document unwritten. Starts from the inventory of [Stage 8 of the SLICE-001 plan](planning/SLICE-001-IMPLEMENTATION-PLAN.md#stage-8--the-vendor-pwa). |
| **016**| Rider Android app| [surfaces/rider-android.md](../surfaces/rider-android.md)| 001 Slice document unwritten. Starts from the inventory of [Stage 9 of the SLICE-001 plan](planning/SLICE-001-IMPLEMENTATION-PLAN.md#stage-9--the-rider-android-app). Decides the Rider's technology (native Android or React Native) and the offline `If-Match` rule of a queued `submitHubHandover`; the contract keeps `If-Match` required until then. |

Rows 015 and 016 were opened on 29 October 2026, when the Product Owner decided that the two clients get their own slices; **their numbers are placeholders the Product Owner may change.** The two clients start from the screens of `SLICE-001`; the Vendor or Rider screens of a later slice are built with that slice, on the client these two make.

**`SLICE-012` and the Overview.** The Overview dashboard ([design](../design/OVERVIEW_DASHBOARD_DESIGN.md), [section authorization](../surfaces/ops-portal.md#the-overview-section-authorization-and-destinations)) is connected one section at a time, by bounded tasks the owner names, as each owning domain delivers and defines its measures. No domain slice waits for it, and none builds it by implication. The `Depends on` column names what a slice's own build needs in order to begin and run (a slice document records a predecessor as a *build dependency*: [SLICE-001 §9](slices/SLICE-001.md#9-normative-dependencies)). It has never listed what a slice's *acceptance* integrates, and for row 012 the two differ. **To start**, reporting and dashboard work, the daily operations and cash report included, needs `SLICE-004` as listed and waits for no other domain: a measure of another domain is defined, and a section connected, when that domain delivers it. **For final integrated acceptance of the Overview**, `SLICE-012` needs, for every section it includes, the slice that owns that section's domain, the section's approved metric definitions and its authorization requirements. Completing `SLICE-004` alone never permits that acceptance, and a section whose owning slice is not built stays visibly pending and is not accepted. **The canonical home of every measure's definition is [features/reporting/reporting-data-dictionary.md](../features/reporting/reporting-data-dictionary.md)**, created on 2 November 2026 from [the feature template](../features/_TEMPLATE.md) when the first measures were admitted (the three lateness measures of pickup, and no other). Master Specification §32.5 requires a reporting data dictionary and `OQ-049` owed it. It is indexed in [features/README.md](../features/README.md), with one entry per measure that references its owning feature's business rules and the operation that serves it. The domain that supplies a measure may admit its definition at any point before `SLICE-012`; neither the Overview design nor the daily report feature holds a second copy.

**Vendor creation and rider creation are brought forward.** Decided by the Product Owner on 5 November 2026, so that a hub can be set up without database access: the creation of a vendor (`SLICE-008`) and the creation of a rider (`SLICE-009`) are built before the slices that need a working hub, and rows 008 and 009 stand after `SLICE-001` and before `SLICE-002` in the table above. Both depend on `SLICE-000` alone. The slice numbers and the acceptance criteria do not change, and the specifications of the two are not written here: each slice document is written when its slice is built. The decision names the creation of a vendor and of a rider only: what else the two slices owe ([§4c](#4c-what-slice-000-retired-and-who-owes-it-now--msc-dec-433)) is not re-sequenced by it, and the plan of `SLICE-001` is not changed: `SLICE-001` continues on seeded vendors and riders, and the placement above stands (Product Owner, 5 November 2026).

Cash collection remains disabled per hub until its custody, reconciliation and variance-disposition chain is operational. This is a capability condition, not merely a slice-number dependency.

## 3a. The Ops Portal redesign

**Decided by the Product Owner on 5 November 2026, after a review of the portal's flow and interface.** The direction is recorded in the documents that own it: [PRODUCT_DESIGN_DIRECTION.md](../design/PRODUCT_DESIGN_DIRECTION.md) (who the portal is designed for first, the four page templates), [DESIGN_SYSTEM.md](../design/DESIGN_SYSTEM.md) (the palette, type, density, motion, themes, devices and libraries), [BRAND_FOUNDATION.md](../design/BRAND_FOUNDATION.md) (the color roles and the logo), [COMPONENT_PATTERNS.md](../design/COMPONENT_PATTERNS.md) (the planned kit) and [the Ops surface](../surfaces/ops-portal.md#4-navigation-model) (the sidebar groups, the top bar, My work). This section only sequences it.

The redesign is **presentation**. It is not a slice and carries no acceptance criterion, and no step changes a business rule, a contract, a permission or a state. A step that finds it needs one stops and surfaces it as a task of its own: a count served by the server and a search across records each need an operation that does not exist today. Each step is **one bounded task**, started when the owner authorizes it, and ends in the [task handoff](planning/BOOTSTRAP_B0_RUNBOOK.md#8-task-handoff-format).

| Step| Task| What it does|
|---|---|---|
| **R1**| The documents| Records the decisions in the documents that own them. Documentation only: no code, token value, contract, permission or rule changes|
| **R2**| Tokens, light and dark| The palette ([DESIGN_SYSTEM §4.3 and §4.4](../design/DESIGN_SYSTEM.md#43-core-semantic-color-tokens), a light and a dark value for each token), type, density, radius, shadow and motion become token values, with `tokens.css` and the token tests in the same change; JetBrains Mono is self-hosted; both themes are in the token file and follow the system's setting, and the toggle is R4's|
| **R3**| shadcn/ui adoption| shadcn/ui (Radix UI and Tailwind CSS) becomes the component foundation on the R2 tokens, in place of the React Aria and TanStack plan of R1 and R2 ([DESIGN_SYSTEM §29](../design/DESIGN_SYSTEM.md#292-the-component-foundation)). **Built; awaiting the Product Owner's acceptance.** It relaxes `style-src` to `'self' 'unsafe-inline'` and no other directive, adds Tailwind CSS v4 without preflight, 24 primitives behind one door, the pinned shadcn CLI and MCP server, TanStack Table, 16 licence files and a showcase of the primitives in both themes, and draws the white lockup in the frame's banner on a dark ground. It moves no screen and changes no business rule, contract, permission or state. React Aria Components stays until it is phased out, and Motion is not adopted|
| **C1**| Contract task: queue summary| One read that returns, for the calling session, a count for each queue it may read, scoped exactly as each queue is (master §17.4). It is specified and contracted in its own task, and each measure is defined in the reporting data dictionary before it is contracted. Until it exists no count is drawn: a queue never claims a total it was not given. **Built; awaiting the Product Owner's acceptance.** `getQueueSummary` (`GET /ops/queue-summary`, a `self` read of the Ops Portal, `background` for the idle lifetime) returns one entry for each of six queues the session may read (a queue it may not read is absent, never `0`): its count, exact, and the moment its oldest record entered it, each scoped by the grant of the key of its own list and, for the two approver's queues, shown only to a holder of the decision key ([the data dictionary](../features/reporting/reporting-data-dictionary.md#55-the-queue-counts-queue-what-they-have-in-common), `AC-QSUM-01` to `AC-QSUM-09`). A count calls the very function its list calls for its filter, so the two cannot drift, and the filter on an exception's state was rewritten for the planner (its meaning unchanged by C1, held by a comparison with a definition written out by hand) and five indexes added (migration 0074) after the plans at 400,000 requests. The menu draws each count beside its entry and the landing lists the queues, the oldest first; no new key, no change to a state or a scope. **Task C1.1 (5 November 2026)** then made two deliberate changes to the list, each the Product Owner's decision: `listPickupRequests` takes an optional `cutoff_exception_state` filter, which the landing's late-bookings link opens (`AC-QSUM-10`, `AC-QSUM-11`), and a cancelled request leaves the approver's queue, in the list and in the count alike (`AC-QSUM-12`). R4 draws the Decisions inbox and the hub switcher's counts from it|
| **C2**| Contract task: global lookup| An exact operational code opens that record; a name returns the matches within the session's scope; a phone number must be typed in full and is always returned masked. It is specified and contracted in its own task|
| **R4**| Shell v2 and navigation| The top bar, the seven sidebar groups, the account menu, the theme toggle with its stored choice ([PRODUCT_DESIGN_DIRECTION §7](../design/PRODUCT_DESIGN_DIRECTION.md#7-when-a-proposal-needs-a-product-decision)), the logo versions, and My work as the landing. The hub switcher sets which hub's work the screens show, a create form starts with the chosen hub, and an act on an existing record uses that record's own hub: R4 first checks how each operation names its hub. The counts and the search are drawn only where C1 and C2 supply them|
| **R5**| The component kit| The planned kit ([COMPONENT_PATTERNS §37](../design/COMPONENT_PATTERNS.md#37-planned-kit-and-deferred-pattern-register)), a Melarc component composed from the shadcn/ui primitives of R3 for each. What is still built on React Aria Components is moved as [COMPONENT_PATTERNS §37](../design/COMPONENT_PATTERNS.md#phasing-out-react-aria-components) says|
| **R6**| The four templates| The queue workspace, the record, the task form and the builder, as built patterns|
| **R7**| Screen-by-screen migration| The screens move onto the templates, starting with the pickup queue. They also take the wording of a refusal from [PRODUCT_DESIGN_DIRECTION §6.5](../design/PRODUCT_DESIGN_DIRECTION.md#65-on-screen-language): the capability in plain words, never a raw key (`ForbiddenState` and the copy files draw the key today)|

**C1 and C2 are not presentation steps.** They are the two contract tasks the redesign needs (Product Owner, 5 November 2026): no list response carries a count today, and no operation looks up a record across the portal. Each is specified, contracted and built in a task of its own, and this plan writes no OpenAPI. They stand between R3 and R4 because R4 is the first step that draws a count and the search; a step that needs one before it exists draws none.

**P1 is a permission task, not a presentation step (Product Owner, 5 November 2026; built 6 November 2026).** The Platform Admin holds every domain at every hub and works the floor on busy days, and keeps the maker-checker exception: every grant of its bundle that was of its own hub is of all hubs (`staff.device.reregister` excepted, the decision of 8 October 2026), by the seed and, for a database seeded earlier, by migration `0075` as an addition that ends no session ([permissions.md §5](../contracts/permissions.md#5-scope), `AC-SLICE-001-83` and `-84`). It closes `OB-S1-75` and `OB-S1-76` ([the SLICE-001 plan §7.1](planning/SLICE-001-IMPLEMENTATION-PLAN.md)): `createPickupRequest` takes an optional `hub_id` for a walk-in, required when the grant reaches more than one hub (`AC-SLICE-001-82`). R4's hub switcher builds on it.

**A performance task C1 leaves: the marker for the manifest pool (decided by the Product Owner on 5 November 2026; not built).** The count of the pool of confirmed pickups not yet on a run (`PICKUP_UNMANIFESTED_POOL`), and the list filter `manifested=false` that it follows, read every confirmed request, because a collected request stays `CONFIRMED` with an unreleased stop and "has no unreleased stop" cannot be made a lookup by an index. C1 measured it at 380,000 confirmed requests (PostgreSQL 18.6, the runtime role, the real security context): 0.7 seconds for a session that reads no hub, 1.7 seconds at all hubs and 2.3 seconds at one hub of 190,000, where each of the five other counts took 2.5 milliseconds or less. **The Product Owner chose option (a): a marker on the request, set when a stop claims the request and cleared when that stop is released, kept by the database,** so that the pool becomes an indexed lookup. It is a task of its own: a migration, the trigger or function that keeps the marker, the change of the shared filter in `pickup-request-criteria.ts` (so the list and the count change together), and a new run of the scale plans. **It is to be done before production volumes, and in any case before a hub's history passes about 100,000 confirmed requests.** The two other options (ending the claim of a request whose pickup is closed, and bounding the pool by a date) were not chosen. The measurements and the options are in [the data dictionary](../features/reporting/reporting-data-dictionary.md#14-unresolved-requirements).

## 4. Identity foundation

Authentication, credential/session/device mechanics, authorization, audit, secrets, rate limits, recovery and negative-access tests form the foundation for protected product flows. Implement this scope before integrating dependent slices. Production external inputs are listed in SLICE-000 §6.

## 4a. Hub fee configuration before priced pickup integration

The first priced pickup flow requires hub-specific fees. Missing commercial configuration must fail visibly; an ad hoc database write is not an administration path.

**Decided on 29 October 2026.** The Product Owner authorized the second option, a bounded launch-fee seed: `SLICE-001` creates the zone and hub-setting tables (versioned and effective-dated), seeds the launch hub's zones and fees from [settings.md](../contracts/settings.md) §7.2 through the seed path, and reads them through the settings reader; it builds no administration operation, and SLICE-014 later adds proposals and approvals on the same tables. The address becomes a zone through a per-hub alias table, with an authorized Ops selection when the table is silent or ambiguous. The alias data is the Product Owner's to supply. The two existing bootstrap dependencies in [MIGRATION_AND_SEEDING.md](../architecture/MIGRATION_AND_SEEDING.md) do not implicitly authorize another seed.

The SLICE-014 document is unwritten. This is a real integration dependency even though there is no slice file to link yet. Bootstrap workspace/API/database tasks can proceed independently.

## 4b. The dead-letter triage queue has an architecture requirement and no slice

*CRIT-16 audit remediation, 13 September 2026.*

**§42.5 requires it in the Master Specification's own words**: *"Failed jobs must be visible and recoverable without duplicating business effects."* [BACKGROUND_JOBS_AND_EVENTS.md](../architecture/BACKGROUND_JOBS_AND_EVENTS.md) §3.3 restates the requirement in operational terms — *"a queue a person can look at,"* with audited, idempotent replay — and **nothing in this table, `surfaces/ops-portal.md`, or any slice document names the screen that satisfies it.** A dead-lettered job carrying a financial or custody effect is invisible not because the architecture failed to say so, but because no slice was ever told to build what it said.

**Assigned to `SLICE-013`, engineering scope rather than a Product sequencing call.** §42.5 sits in §42's cross-cutting API/backend engineering section, not in any of the operational domains §21–§34 map to a specific slice — the same reason `SLICE-013` exists at all: **Settings, reason-catalogue and courier administration is cross-cutting platform operation that belongs to no single parcel-flow domain**, and background-job/dead-letter administration is the identical shape of concern, one layer further down the stack. `IMPLEMENTATION_PLAN.md`'s own approver line routes **sizing** to engineers and reserves only **sequence and priority** for the Product Owner; which existing slice's scope a screen falls under is a sizing call, not a priority one, and this section makes it rather than leaving the requirement unscoped indefinitely. **The Product Owner may reassign it** — to a dedicated slice, or elsewhere — at any point without this reasoning standing in the way; what this section removes is the state where nobody owns it at all.

**No new slice is opened, and no slice count changes.** `SLICE-013`'s `Depends on` (`000`) is unaffected — the dead-letter queue's own dependency is the background-job infrastructure `000` already requires nothing beyond, since audit and permission enforcement are the only cross-cutting foundations a triage-and-replay screen needs.

## 4c. What `SLICE-000` retired, and who owes it now — `MSC-DEC-433`

Gate PD-3R1, `PDA-55`. **`SLICE-000` is not widened and the sequence does not change.** Six of its criteria and four of its demonstration rows exercised records and operations that later slices build; each moved to the first slice that owns its resource or operation, or was found already covered. **What is recorded here is what a later slice must not lose.** None of these is a decision and none blocks `SLICE-000`.

| Owed by| What| Was| Why it could not stay in `SLICE-000`|
|---|---|---|---|
| **`SLICE-001`** *(delivered)*| A vendor reaches only its own pickup requests, and a rider only assigned work; neither is told another's exists| `SLICE-000` criteria 16, 28 (the request half) and 12| Pickup requests, manifests and stops are `SLICE-001`'s. **Written as `AC-SLICE-001-79` and `-80`**|
| **`SLICE-001`** *(covered)*| State is evaluated with permission: vendor self-cancellation closes at assignment| `SLICE-000` criterion 27| `cancelPickupRequest` is `SLICE-001`'s. **`AC-SLICE-001-05` and `-12` already prove it**; no criterion is added|
| **`SLICE-009`** — rider administration| **A rider's status change to `INACTIVE` or `SUSPENDED` ends the live session in the same transaction**, and the next call is `SESSION_INVALID`. It must call the same `terminateSessions` that `revokeRiderDevice` does ([SECURITY_DESIGN.md](../architecture/SECURITY_DESIGN.md) §15.3)| the status-change half of `AC-SLICE-000-46`, which now stands on the two revocation operations| **No operation in `SLICE-000` sets a rider's status.** The revocation mechanism is proved there on `revokeRiderDevice` and `revokeSession`|
| **`SLICE-009`** — staff administration| **`proposeBundleChange` and `approveBundleChange`**, with `proposeBundleChange` taking its `If-Match` from `getStaffIdentity` (built in `SLICE-000`). Two criteria are owed with them: **a reduced bundle ends every live session with `AUTHORITY_CHANGED` and the next sign-in carries the reduced snapshot**, and **removing a permission from a bundle takes effect with no code change** — it ends the holders' live sessions in the same transaction, and a session created afterwards carries the reduced snapshot (the lineage and the invalidation primitive are built in `SLICE-000`)| `SLICE-000` criterion 34, and the operation-level form of criterion 31| **No operation edits a role bundle's contents in `SLICE-000`.** The no-code-change principle is already proved there by `AC-SLICE-000-05` and `-06`|
| **`SLICE-009`** — staff offboarding| **Succession**: each of the two bootstrap administrators is offboarded only after two non-bootstrap successors are approved, credentialed, MFA-ready and have each signed in, and **neither is ever deleted** ([MIGRATION_AND_SEEDING.md](../architecture/MIGRATION_AND_SEEDING.md) §3, `MSC-DEC-440`). Its termination reason is `OFFBOARDED`| the demonstration row *Succession*| Offboarding is staff administration. The bootstrap path up to and including the first sign-in, **for both identities**, **is** `SLICE-000`'s (`AC-SLICE-000-92`, `-93`, `-118`)|
| **`SLICE-009`** — staff offboarding| **The offboarding transaction takes the identity lock and, in the same transaction, ends every outstanding `RecoveryRequest` and `SetupGrant` of the identity (`SUPERSEDED`) and cancels their delivery jobs**, so a completion racing it either commits first or is `RECOVERY_TOKEN_INVALID` ([credential-recovery.md](../features/identity/credential-recovery.md) §5.7, [state-machines.md](../contracts/state-machines.md) §13.3). The recovery half and `GBT-B15` are built in `SLICE-000`| — *(recorded 9 October 2026)*| **No operation in `SLICE-000` offboards**, so the offboarding half cannot be built or tested there; `SLICE-000` proves the recovery side by changing the status through the test kit|
| **`SLICE-008`** — vendor termination and rejection| **The transaction that rejects or terminates a `VendorOrganization` takes its account's lock and, in the same transaction, ends every outstanding `RecoveryRequest` and `SetupGrant` of the account (`SUPERSEDED`), cancels their delivery jobs and ends its sessions and device credentials**, so a completion racing it either commits first or is `RECOVERY_TOKEN_INVALID` ([credential-recovery.md](../features/identity/credential-recovery.md) §5.7, [state-machines.md](../contracts/state-machines.md) §14, the `VendorOrganization` note). `SLICE-000` builds the consumer-side guard and tests it with a fixture | — *(Product decision, 9 October 2026)*| **No `SLICE-000` operation rejects or terminates a vendor organisation**, so only the guard is built and fixture-tested there; a fixture is not proof of a termination endpoint|
| **`SLICE-013`** — reason administration| **`upsertReasonDefinition` is proved against the identity reason domains**: it creates no row in, and changes nothing but `label` and `active` of, any of the six; only a Platform Admin holding `settings.reason.manage` explicitly may, and a Senior Ops holder is `INSUFFICIENT_AUTHORITY`; a body that carries `permittedOperations` or changes `code`, `domain` or behaviour metadata is `VALIDATION_FAILED` naming the field (the request schema is `ReasonDefinitionWrite`); and each permitted change writes the enhanced `settings.reason.catalog_changed` event with the old and new values| — *(recorded 9 October 2026)*| **`SLICE-000` builds only the read, `listReasonDefinitions`.** The refusals are specified in [permissions.md](../contracts/permissions.md) §7 and on the operation, and nothing can test them until the operation exists|
| **The first slice that returns an order to a Vendor**| A vendor asking for another vendor's **order** is refused exactly as for an order that does not exist (`NOT_FOUND`, `MSC-DEC-432`)| the order half of `SLICE-000` criterion 28| **No order-read operation exists yet**; `itemizeOrder` is Ops's. The rule is stated in the contract and tested on requests by `AC-SLICE-001-79`|
| **`SLICE-008`** — vendor administration| **`VendorAccount.account_identifier` is generated at account creation** ([SECURITY_DESIGN.md](../architecture/SECURITY_DESIGN.md) §13.7a) and delivered with the setup grant. The `SLICE-000` fixture generates one for the demonstration| — *(new at `PDA-67`)*| Vendor creation is `SLICE-008`'s; sign-in needs the identifier and no document had a producer for it|
| **Every slice that builds one of the operations that require `If-Match` and have no read that sets an ETag**| **The read that returns the record's `ETag`.** At Gate PD-3R2 that is 35 of the 54 operations that require `If-Match`: manifests (7), vendor organisations (6), pickup and delivery stops (5), delivery runs (4), order-level acts (4), saved locations (3), holds (2), cash handovers (2), evidence (1) and custody returns (1)| — *(found at the Gate PD-3R2 Backend Engineer review)*| `openapi.yaml` 5.73 states its rule 3 for the identity domain only: Gate PD-3R1 gave nine operations their read and these never had one. Each read is added with its resource|
| **`SLICE-009`** — staff administration| **`proposeBundleChange` has no reader for one of its holders**: `permission.bundle.assign` is held by Ops Staff, `getStaffIdentity` needs `staff.read`, and Ops Staff do not hold it. Decide whether the key's holders or the read's change| — *(found at the Gate PD-3R2 review)*| The operation is `SLICE-009`'s; `permissions.md` and `openapi.yaml` record the gap and leave it open|

**Two decisions the Gate PD-3R2 review recorded as open are made, and neither is an obligation** (Gate PD-3R3). **`PDA-68`** — no operation returned the `role_bundle_id` that `createStaffIdentity` requires — is closed by `listAssignableStaffRoleBundles`, built inside `SLICE-000`. **`PDA-69`** — the seed created one identity and §30.8 forbids a maker approving their own profile — is closed by a bootstrap **pair** of two Platform Admins, one creating the first profile and the other approving it. **Neither moves an obligation in the table above, and `SLICE-000`'s rows 1, 2 and 12 can be walked from a clean environment.**

**The obligations in Given/When/Then form, without identifiers** (`MSC-DEC-433` item 6). Each is numbered when its owning slice's feature is written, and each stands on operations that slice builds.

*`SLICE-009`, rider administration — a status change ends the session:*

```text
Given a rider with a live session and a valid access_token,
When an authorised officer sets the rider's status to INACTIVE or SUSPENDED,
Then every live session of that rider is terminated in the same transaction as the status change,
And the rider's next API call returns 401 SESSION_INVALID,
And no later sign-in succeeds while the status stands.
```

*`SLICE-009`, staff administration — a reduced bundle ends the session:*

```text
Given a Senior Ops user with an ACTIVE session issued four hours ago,
When a Platform Admin approves a bundle change that reduces that user's authority,
Then every live session for that identity is terminated with AUTHORITY_CHANGED,
And the next request returns 401 SESSION_INVALID,
And a fresh sign-in receives a snapshot carrying the reduced bundle.
```

*`SLICE-009`, staff administration — removing a permission needs no code change:*

```text
Given a bundle holding a permission,
When an approved bundle change removes that permission,
Then every live session issued from that bundle ends with AUTHORITY_CHANGED in the same transaction, a session created after the edit is refused with PERMISSION_DENIED,
And no deployment or code change was required.
```

*`SLICE-009`, staff offboarding — succession:*

```text
Given a bootstrap Platform Admin and two non-bootstrap successor Platform Admins who are approved, credentialed, MFA-ready and have each signed in,
When that bootstrap identity is offboarded,
Then its live sessions end with OFFBOARDED and the bootstrap-resume mechanism refuses to operate for it,
And auth.bootstrap.succeeded is written once for that identity, as an enhanced record,
And offboarding a bootstrap identity with fewer than two such successors is refused with the code the offboarding operation declares, and neither bootstrap identity is ever deleted.
```

*`SLICE-009`, staff offboarding — recovery cannot outlive the identity:*

```text
Given a staff identity with a PENDING recovery request, a PENDING setup grant and their delivery jobs,
When it is offboarded while a completion of that recovery link waits for the identity lock, and again with the completion first,
Then with the offboarding first the completion is RECOVERY_TOKEN_INVALID and changes nothing, and with the completion first it stands and the offboarding ends what is left,
And in the same transaction as the offboarding every PENDING request and grant of the identity is SUPERSEDED and its delivery job is CANCELLED,
And a later recovery request for the identity is answered like an unknown identifier.
```

*`SLICE-008`, vendor termination — recovery cannot outlive the account's organisation:*

```text
Given a vendor account with a PENDING recovery request, a PENDING setup grant and their delivery jobs,
When its organisation is terminated while a completion of that recovery link waits for the account lock, and again with the completion first,
Then with the termination first the completion is RECOVERY_TOKEN_INVALID and changes nothing, and with the completion first it stands and the termination ends what is left,
And in the same transaction as the termination every PENDING request and grant of the account is SUPERSEDED and its delivery job is CANCELLED,
And a later recovery request for the account is answered like an unknown identifier.
```

*The first slice that returns an order to a Vendor — the order half of the existence rule:*

```text
Given two vendor organisations each holding orders,
When one requests the other's order by id,
Then the response is 404 NOT_FOUND, identical in status, code, body shape and timing class to an identifier that matches nothing,
And every order list returns only the caller's own orders.
```

*`SLICE-008`, vendor administration — the account identifier:*

```text
Given a vendor organisation approved at SLICE-008,
When its account is created,
Then account_identifier is generated once, unique, immutable and never reused,
And it is delivered with the setup grant and shown to Ops by getVendorAccount.
```

## 5. Readiness status

Slice documents 000–003 exist. Later slice documents are unwritten; feature specifications alone do not establish complete slice scope. Assess readiness for the selected bounded task using the current standards, preserving real product, configuration and provider dependencies. No historical signature or audit verdict certifies an implementation.

## 6. What Phase 2 established

The retained features and contracts define the initial identity, pickup, dispatch and delivery threads. Implement their demonstrations and acceptance criteria incrementally. Keep scope, contract conformance and cross-surface behavior aligned; specification detail is not code completion.

## 7. Pre-launch proofs — specified by Gate D, and not yet run

**Gate D closing does not mean these have passed.** It means their inputs, procedure and pass/fail criteria are fixed, so implementation cannot invent them. **Both are release blockers.**

| Proof| What must be run| Passes when|
|---|---|---|
| **Launch load tests**| Baseline **1×** · peak **3× for 30 minutes** at up to 75 concurrent staff-equivalent · soak **2× for 4 hours** · **stress to degradation** · and the eleven outage and burst scenarios at [OBSERVABILITY_AND_RECOVERY.md](../architecture/OBSERVABILITY_AND_RECOVERY.md) §5.5| p95 targets hold · **no duplicate business effect** · no lost asynchronous work · **no cross-Hub, Vendor or Rider leakage under concurrency** · queue age recoverable · §5.4's per-run criteria|
| **Pre-launch restore drill**| The full isolated restore at §4.4 of that document, on the cadence `MSC-DEC-284` set| **Calculated RPO ≤24h and calculated RTO ≤4h**, both recorded, plus PostgreSQL integrity, Evidence, KMS/TOTP, audit integrity, provider reconciliation, and proof that **no live SMS or payment credential is reachable** from the drill environment|

**A scenario is not a PASS because HTTP requests returned**, and a restore is not a PASS because it completed — **it must produce both numbers.** A drill that finishes in six hours has proved a restore is possible and disproved the RTO.

**These are launch gates, not readiness gates.** No slice's `READY` verdict depends on them, and none becomes `NOT_READY` because they are outstanding — the same distinction `SLICE-000` has carried throughout between a launch item and a readiness item.

## 8. Related

- **Slices:** [SLICE-000](slices/SLICE-000.md) · [SLICE-001](slices/SLICE-001.md) · [SLICE-002](slices/SLICE-002.md) · [SLICE-003](slices/SLICE-003.md) — **the four §3 says are specified.** `SLICE-004` to `SLICE-016` are named in §3 and have no document yet
- **Gates:** [definition-of-ready.md](../standards/definition-of-ready.md) · [definition-of-done.md](../standards/definition-of-done.md)
- **Standards:** [engineering-standards.md](../standards/engineering-standards.md) — the enforcement ladder and test obligations every slice inherits
