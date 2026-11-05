# SLICE-001 readiness check

> **Status:** DRAFT for the Product Owner. Written on 28 October 2026 at HEAD `6ce206b` (branch `feat/slice-000-s0-29`, local, not pushed). **Nothing of SLICE-001 is built.** This check changed no contract, specification or code file, and ran no product test. **Decisions taken since:** on 29 October 2026 the owner decided D-01, D-02, D-04, D-05, D-07, D-08, D-09, D-14 and the pricing part of D-13 ([the plan's section 11](SLICE-001-IMPLEMENTATION-PLAN.md#11-decisions-recorded) records them); the findings and readings below are as of 28 October.
> **Repository path:** `delivery/planning/SLICE-001-READINESS-CHECK.md`
> **Owns:** the readiness verdict for [SLICE-001](../slices/SLICE-001.md) against [definition-of-ready.md](../../standards/definition-of-ready.md), the findings behind it, and the decisions the Product Owner must take before the first task of [the plan](SLICE-001-IMPLEMENTATION-PLAN.md) starts.
> **Does not own:** any product rule. The slice, the [features](../../features/README.md), the [contracts](../../contracts/CLAUDE.md) and the [architecture](../../architecture/SOLUTION_ARCHITECTURE.md) own those; this document links to them and names where they disagree.
> **How to read it:** section 1 is the verdict and section 7 the decisions you are asked for; sections 3 to 6 are the evidence behind them.
> **Companions:** [the plan](SLICE-001-IMPLEMENTATION-PLAN.md) (a draft that waits on section 7) · [the SLICE-000 position](SLICE-000-IMPLEMENTATION-PLAN.md#12-current-position) · [Implementation Plan §3, §4a, §4c](../IMPLEMENTATION_PLAN.md)

## 1. Verdict

**SLICE-001 is `NOT_READY` as a complete vertical slice.** [Definition of ready §44.6](../../standards/definition-of-ready.md#verdict-446) asks for the exact missing requirement and the work it affects; section 5 gives each. In short:

1. **The specifications disagree on behaviour the slice must build** (F-01 to F-12). The controlling master specification (version 1.15, 23 July 2026) holds none of the later pricing, intent and handover decisions that the features, settings and domain model rely on. The collection and handshake order is contradictory across the state machine, the error catalogue and the contract. The Rider app is "native Android" in two documents and "React Native" in two others. The execution plan's rule is to stop the affected work and surface the conflict ([§2](../DEVELOPMENT_EXECUTION_PLAN.md#2-source-of-truth)); this is that surfacing.
2. **The contract (5.77) does not yet describe the slice** (F-13 to F-20). Fields the criteria assert are declared nowhere, error codes they expect are not declared by the operation that raises them, operations the specifications require do not exist, no read returns the `ETag` that ten `If-Match` operations take, the role bundles hold none of the slice's keys, and the reason catalogue has no domain for its reasons.
3. **The slice depends on capabilities no built or specified slice supplies** (F-21 to F-32): hub, zone and fee administration (SLICE-014, whose slice document is unwritten and whose operations are absent from the contract), a rule that turns an address into a zone, vendor and fleet records, notifications, SMS to people who are not principals, a scheduler, an evidence store and the credit ledger.
4. **Two client applications that do not exist are in its scope** (F-33 to F-36): the Vendor PWA and the Rider Android app. Their route and screen inventories exist and the features record them as accepted (`MSC-DEC-223`), yet [overview.md](../../surfaces/overview.md) still lists the page-level inventory as owed (`OQ-030`), and several screens the slice needs are specified nowhere (F-34).
5. **Eight of the 80 criteria fail definition of ready §G, and six more name no error code or name one that the error catalogue's own rule contradicts** (F-37).

**What can be built today with no decision:** nothing of the product. **What the owner can unblock first:** D-01 and D-08 (section 7) let Stage 0 of the plan begin. Six more (D-02, D-04, D-05, D-07, D-09, D-14) are needed before its gate; the other six are answered as the stage that needs each is reached.

| Area (definition of ready) | Verdict | Why |
|---|---|---|
| A. Project-specific preconditions | Partly | Scope and sources are identified and enforcement levels stated; the sources do not agree (F-01 to F-12); eight criteria lack a retained governing citation (F-37); some missing values have no stated consequence (F-17, F-28) |
| B. Product readiness (§44.1) | Partly | Objective, users and scope are clear; behaviours the specifications require have no operation (F-15); blocking questions are open (F-02, F-05, F-11) |
| C. Domain and rule readiness (§44.2) | Partly | Actors, states, invalid transitions, settings and idempotency are defined for most of the slice; no reason domain (F-17), two handshake state sets (F-03), no address-to-zone rule (F-22) |
| D. Frontend readiness (§44.3) | Partly | Route and screen inventories exist for the three surfaces and the features record them as the accepted low-fidelity specification (`MSC-DEC-223`), which §44.3 allows in place of wireframes; [overview.md](../../surfaces/overview.md) lines 119 to 125 still lists the page-level inventory as owed (`OQ-030`); no wireframes exist; no route lists its fields or columns and several screens are unspecified (F-34); the Rider technology is stated two ways (F-08) |
| E. Backend and contract readiness (§44.4) | **No** | F-13 to F-32 |
| F. Acceptance and delivery readiness (§44.5) | **No** | Criteria exist in Given/When/Then form; eight fail §G; the slice is not small enough to complete as one unit without staging (F-38); no Android toolchain or environment exists in the repository |
| G. Acceptance-criteria quality gate | **No** | F-37 |

## 2. How this was checked, and its limits

- **Read in full:** the [Development Execution Plan](../DEVELOPMENT_EXECUTION_PLAN.md), the [Implementation Plan](../IMPLEMENTATION_PLAN.md), [SLICE-001](../slices/SLICE-001.md), the three standards, the six feature files, the [SLICE-000 acceptance record](SLICE-000-ACCEPTANCE.md), the area rules of `apps/api`, `contracts` and `features`, and the sections of the [SLICE-000 plan](SLICE-000-IMPLEMENTATION-PLAN.md) that give its structure (1 to 4, the opening of 5 to 7, 7.50, 8 to 10; the plan is 4,126 lines).
- **Read in part, by search:** `contracts/openapi.yaml` (parsed with the repository's own YAML package: every operation, its permission, headers, responses and `x-error-codes`, and the schemas the slice uses), `contracts/domain-model.md`, `contracts/state-machines.md`, `contracts/errors-and-enums.md`, `contracts/settings.md`, `contracts/permissions.md`, the master specification (sections 22.2, 23, 34.9, 35.10), the security test matrix, the three client surface documents, and the API's schema, seed, module and test-support files.
- **Three read-only reviewers** audited the client surfaces, the architecture and infrastructure needs, and the cross-slice dependencies. A claim of theirs appears here only after it was checked against the file; the checked claims carry a path. What I could not check is not relied on.
- **One independent review of this document** checked about 330 of its claims against the files: about 315 were true as stated, 13 were imprecise and 10 gaps were missed. Each point was checked against the source before this version corrected it; one sub-claim (that `adjudicateDiscrepancy` answers a missing piece of evidence with `EVIDENCE_NOT_STORED` where AC-42 expects `REASON_REQUIRED`) was not confirmed, because the operation declares both codes, and is not carried.
- **Scripts** (scratch work, not kept): an inventory of the contract's operations and schemas; a screen of the 80 criteria against the four properties of §G; a check that every identifier a feature cites exists in the document that owns that kind of identifier; a comparison of the error codes each criterion names with the `x-error-codes` of the operations that serve it; a list of the `If-Match` operations against the responses that set an `ETag`. Each result was read against the source before it is stated.
- **Not done:** no product code was run and no product test written; no contract, specification or feature file was edited (the only existing document touched is the "Next" sentence of [the SLICE-000 position](SLICE-000-IMPLEMENTATION-PLAN.md#12-current-position)); wireframes were not reviewed (none exist); the master specification was searched for the decisions that matter and not read end to end, so F-01 lists the contradictions found, not all that exist. Counts here are derived by those scripts from the sources.

## 3. The slice, as the sources define it

[SLICE-001](../slices/SLICE-001.md) §1: a parcel from the sender's booking to a priced, itemized Order, with the Ops Portal, Vendor PWA and Rider Android as surfaces and the recipient channel "only for the ad-hoc handshake SMS". It ends when the intake closes.

| Feature | Criteria | Identifiers |
|---|---|---|
| [pickup-request](../../features/pickup/pickup-request.md) | 20 | 01 to 10, 60 to 64, 69 to 72, 79 |
| [pickup-manifest](../../features/pickup/pickup-manifest.md) | 14 | 11 to 19, 67, 68, 74, 78, 80 |
| [pickup-collection](../../features/pickup/pickup-collection.md) | 11 | 20 to 29, 73 |
| [pickup-failure](../../features/pickup/pickup-failure.md) | 7 | 30 to 36 |
| [hub-intake](../../features/hub/hub-intake.md) | 13 | 37 to 46, 75 to 77 |
| [itemization](../../features/hub/itemization.md) | 15 | 47 to 59, 65, 66 |
| **Total** | **80** | `AC-SLICE-001-01` to `-80`, contiguous (agrees with SLICE-001.md §1) |

**The operations.** The feature pointers (§12 of each file) name 29 operations between them, and pickup-collection.md §15 names four handshake operations that its §12 still calls missing: 33. AC-67 and AC-68 need three more (the run-custody operations, which carry fleet permissions and appear in no feature pointer); the criteria that attach evidence (AC-31, 41, 42, 54, 59) need the three evidence operations, which belong to no feature: 39 in all. The contract's `pickup-requests` tag holds three further operations that no feature names: 42 in the table. The table is a derived inventory and not a claim about scope (F-18).

| Operation| Method and path| Permission| Idempotency-Key| If-Match| ETag set by|
|---|---|---|---|---|---|
| *pickup request*| | | | | |
| `createPickupRequest`| POST `/pickup-requests`| `pickup.request.create`| required| —| 201|
| `listPickupRequests`| GET `/pickup-requests`| `pickup.read`| —| —| —|
| `getPickupRequest`| GET `/pickup-requests/{id}`| `pickup.read`| —| —| 200|
| `confirmPickupRequest`| POST `/pickup-requests/{id}/confirm`| `pickup.request.confirm`| —| required| 200|
| `cancelPickupRequest`| POST `/pickup-requests/{id}/cancel`| `pickup.request.cancel`| required| required| —|
| `waiveCancellationCharge`| POST `/pickup-requests/{id}/cancellation-charge/waiver`| `pickup.cancellation_charge.waive`| —| required| —|
| `escalatePickupRequest`| POST `/pickup-requests/{id}/escalate`| `pickup.failure.resolve`| required| required| —|
| `extendPickupAttempts`| POST `/pickup-requests/{id}/attempt-extension`| `pickup.attempt.extend`| required| required| —|
| `requestOnePackageException`| POST `/pickup-requests/{id}/one-package-exception`| `pickup.exception.request`| —| —| —|
| `approveOnePackageException`| POST `/pickup-requests/{id}/one-package-exception/approve`| `pickup.exception.approve`| —| —| —|
| *pickup manifest*| | | | | |
| `createPickupManifest`| POST `/pickup-manifests`| `pickup.manifest.create`| required| —| —|
| `listPickupManifests`| GET `/pickup-manifests`| `pickup.read`| —| —| —|
| `getPickupManifest`| GET `/pickup-manifests/{id}`| `pickup.read`| —| —| —|
| `setManifestStopOrder`| PUT `/pickup-manifests/{id}/stops`| `pickup.manifest.create`| required| required| —|
| `assignRider`| POST `/pickup-manifests/{id}/assign-rider`| `pickup.manifest.assign`| —| required| —|
| `dispatchManifest`| POST `/pickup-manifests/{id}/dispatch`| `pickup.manifest.dispatch`| —| required| —|
| `startRun`| POST `/pickup-manifests/{id}/start`| `pickup.run.execute`| —| required| —|
| `skipPickupStop`| POST `/pickup-stops/{id}/skip`| `pickup.stop.skip`| required| required| —|
| *run custody handover (AC-67, AC-68; not in the feature pointer)*| | | | | |
| `initiateRunCustodyHandover`| POST `/pickup-manifests/{id}/custody-handover`| `fleet.custody.initiate`| —| required| —|
| `acceptRunCustodyHandover`| POST `/pickup-manifests/{id}/custody-handover/accept`| `fleet.custody.accept`| required| required| —|
| `listRunCustodyHandovers`| GET `/run-custody-handovers`| `fleet.custody.read`| —| —| —|
| *collection and handshake*| | | | | |
| `arriveAtPickupStop`| POST `/pickup-stops/{id}/arrive`| `pickup.run.execute`| required| —| —|
| `recordCollection`| POST `/pickup-stops/{id}/collect`| `pickup.collection.confirm`| required| required| —|
| `initiateHandshake`| POST `/pickup-stops/{id}/handshake`| `pickup.collection.confirm`| required| —| —|
| `verifyHandshake`| POST `/pickup-stops/{id}/handshake/verify`| `pickup.collection.confirm`| —| —| —|
| `requestSmsHandshakeFallback`| POST `/pickup-stops/{id}/handshake/sms-fallback`| `pickup.collection.confirm`| required| —| —|
| `authoriseHandshakeOverride`| POST `/pickup-stops/{id}/handshake/ops-override`| `pickup.handshake.override`| required| —| —|
| *pickup failure*| | | | | |
| `reportPickupFailure`| POST `/pickup-stops/{id}/fail`| `pickup.failure.report`| required| required| —|
| *hub handover, intake and itemization*| | | | | |
| `submitHubHandover`| POST `/pickup-manifests/{id}/hub-handover`| `hub.handover.submit`| required| required| —|
| `listHubIntakes`| GET `/hub-intakes`| `hub.read`| —| —| —|
| `getHubIntake`| GET `/hub-intakes/{id}`| `hub.read`| —| —| 200|
| `acquireIntakeLock`| POST `/hub-intakes/{id}/lock`| `hub.intake.count`| —| —| —|
| `submitBlindCount`| POST `/hub-intakes/{id}/count`| `hub.intake.count`| required| required| —|
| `adjudicateDiscrepancy`| POST `/hub-intakes/{id}/discrepancy`| `hub.osd.adjudicate`| —| required| —|
| `itemizeOrder`| POST `/hub-intakes/{id}/orders`| `hub.intake.itemize`| required| required| —|
| `closeHubIntake`| POST `/hub-intakes/{id}/close`| `hub.intake.close`| required| required| —|
| *evidence (used by AC-31, 41, 42, 54, 59; owner of the operations to be settled)*| | | | | |
| `createEvidence`| POST `/evidence`| `owner`| required| —| —|
| `completeEvidenceUpload`| POST `/evidence/{id}/complete`| `owner`| —| required| —|
| `createEvidenceRetrievalAuthorization`| POST `/evidence/{id}/retrieval-authorization`| `owner`| —| —| —|
| *in the same contract tags, named by none of the six features*| | | | | |
| `reassignPickupRequestHub`| POST `/pickup-requests/{id}/reassign-hub`| `pickup.request.reassign_hub`| required| required| 200|
| `overrideServiceWindow`| POST `/pickup-requests/{id}/service-window-override`| `pickup.request.override_window`| required| —| —|
| `assessParcelHandling`| POST `/pickup-requests/{id}/handling-assessment`| `hub.parcel.assess_handling`| —| —| —|

*Generated from `contracts/openapi.yaml` 5.77. Of the 176 operations in the contract, none of these is in `IMPLEMENTED_OPERATIONS` (`apps/api/src/tools/contract/implemented-scope.ts` holds identity operations only).*

## 4. The starting point

**Built (SLICE-000, committed locally as `6ce206b`; Gate 8 not passed):** opaque sessions for the three principal types; the permission catalogue and six role bundles seeded; row-level security and the existence-rule probe; the audit writer, idempotency store, settings reader, reason validator, PostgreSQL rate limiter and bounded hash admission; a durable credential-delivery queue with a worker process that only captures; the private attestation verifier; the Ops Portal shell and component set with the 20 routes of SLICE-000 and the session boundary; the integrated harness with its closed lists of arrangements and observations; the generated API client. [Open for the owner](SLICE-000-IMPLEMENTATION-PLAN.md#12-current-position): the full gate, the hosted evidence for Firefox, WebKit, HTTPS and Linux, the real handset, the accessibility note, the signature of the acceptance record and ten findings.

**Not built, checked in the code on 28 October 2026:**

| What | State | Evidence |
|---|---|---|
| Any pickup, manifest, stop, collection, handshake, intake, order, evidence or ad-hoc-sender table | None. The 24 tables of migrations `0000` to `0041` are identity, delivery, audit, idempotency, limiter and reference data | `ls apps/api/migrations`; `CREATE TABLE` statements |
| Hub detail | The `hub` table is `id`, `name`, `created_at`: no zone, cutoff or fee. The seed creates one hub, Accra, "without a zone" | `reference-data.ts` lines 94 to 105; `tools/seed/hubs.ts`; [MIGRATION_AND_SEEDING.md](../../architecture/MIGRATION_AND_SEEDING.md) line 209 |
| Hub-scoped, versioned, effective-dated settings | The `setting` table has the scopes `COMPANY` and `PLATFORM`, one value per key, no version, no date. The seed says the hub-scoped settings are `HubSetting` rows, "a later table" | `reference-data.ts` lines 213 to 236; `tools/seed/settings.ts` header |
| Reason domains for the slice | The catalogue's domain set is closed by a `CHECK`: four workflow and six identity domains. Only the identity domains are seeded | `reference-data.ts` (`reason_code_domain_closed`); `tools/seed/reasons.ts`; MIGRATION_AND_SEEDING.md line 211 |
| Role-bundle grants for the slice | The six seeded bundles hold only SLICE-000's fifteen keys; "a key of a later slice is granted by the migration that slice adds"; the Vendor bundle holds no key | `tools/seed/bundles.ts` header |
| Domain folders `src/pickup/`, `src/hub/`, `src/pricing/` | None. They are existing permission domains, so [apps/api/CLAUDE.md](../../apps/api/CLAUDE.md) does not make them new domains | `ls apps/api/src`; [SOLUTION_ARCHITECTURE.md](../../architecture/SOLUTION_ARCHITECTURE.md) lines 97 to 106 |
| Vendor records beyond identity | `vendor_organization` holds names, contact, status and responsible hub: no saved location, goods profile, allowance, standing or hold (the domain model specifies saved locations in §6.18 and the contract has four operations on them); the fixture says "The allowance is not made." | `vendor-organization.schema.ts`; `tools/fixtures/vendor-fixture.ts` lines 19 and 20 |
| Fleet records | No motorcycle, assignment or breakdown | No schema file |
| Task capabilities for the slice | The closed list holds six; the `Outbox` classes "arrive with the `Outbox` table" | `platform/database/task-capabilities.ts` |
| Ops screens | Staff, rider and vendor screens only | `apps/ops-web/src/app/pages/` |
| Vendor PWA, Rider Android app | Neither exists; `apps/` holds `api`, `ops-web` and `attestation-verifier` | `ls apps` |
| Object store, outbox, scheduler | None; `infrastructure/` holds `postgres` only | `ls infrastructure` |

## 5. Findings

Each finding says what is wrong, where (file and line, or operation and schema), what it blocks and what it needs. **A** is a decision or a specification change that is the Product Owner's; **B** is a change to a contract or document that needs no product decision once the owner authorizes the reconciliation (D-08); **C** is a dependency on work another slice owns.

### 5.1 The sources disagree

| ID | Finding | Evidence | Blocks | Needs |
|---|---|---|---|---|
| F-01 | **The master specification (version 1.15, 23 July 2026) holds none of the later decisions the features rely on.** `MSC-DEC-207`, `-209`, `-210`, `-211`, `-218`, `-219`, `-244`, `-335` and `-416` appear in the features, settings or domain model and **nowhere in the master specification**. It still states a zone-pair price matrix of origin and destination (§23.3), four size classes with open surcharges (§23.2, §23.4), a size surcharge on every base fee (§23.4), **no price estimate at booking** (§23.6) and "values still required" for fees that settings.md now confirms (§23.9). **A value also differs:** Amasaman's batch days are "Tuesday and Friday" in the master specification and "Friday only" in settings.md | Master specification lines 1379, 1393, 1404 to 1407, 1428, 1447, 1478, 4052; [itemization.md](../../features/hub/itemization.md) lines 63 to 71, 148 to 156; [settings.md](../../contracts/settings.md) line 121; [domain-model.md](../../contracts/domain-model.md) §6.7 and line 950 (`ZonePairRate` still catalogued though withdrawn, settings.md lines 259 and 260) | AC-01, 48 to 50, 56 and every pricing task | **A** (D-01, D-13) |
| F-02 | **The order of the count and the handshake is contradictory.** The state machine generates the code only after a collection is recorded (`COLLECTION_NOT_RECORDED`) and closes the stop only with a verified handshake (`HANDSHAKE_NOT_VERIFIED`); the contract has one operation, `recordCollection`, that returns the `CollectionRecord`, requires `handshake_type` and can answer `HANDSHAKE_NOT_VERIFIED`, and a separate `initiateHandshake` with no stated precondition. As written, a code cannot be generated before the collection is recorded and a collection cannot be recorded before the code is verified. **The master specification reads a third way:** §21.4 records the confirmation as an overlay (`pending_vendor`, `confirmed`, `disputed`, `unconfirmed`) "independently from physical pickup status" and says "manifest completion does not wait for confirmation"; §21.3 promotes an ad-hoc sender "without waiting for the handshake response"; §36.5 leaves the relationship to design. pickup-collection.md repeats the overlay in its two "never" rules, AC-27 and AC-28, while its §5.1 puts the handshake before the stop closes | [state-machines.md](../../contracts/state-machines.md) lines 129, 130, 162; [errors-and-enums.md](../../contracts/errors-and-enums.md) lines 123, 133; `recordCollection`, `initiateHandshake`; [pickup-collection.md](../../features/pickup/pickup-collection.md) §5.1 and §5.3; master specification lines 1225, 1229, 1236, 2558 | AC-21, 23 to 28, 73; the Rider's collection screens | **A** (D-04) |
| F-03 | **The handshake has two sets of states and two channel names.** State machine: `PENDING`, `CODE_GENERATED`, `CODE_DELIVERED`, `VERIFIED`, `EXPIRED`, `EXHAUSTED`, `DISPUTED`, `MANUALLY_RESOLVED`. Contract `Handshake.state`: `PENDING`, `SENT`, `VERIFIED`, `EXPIRED`, `ATTEMPTS_EXHAUSTED`, `OVERRIDDEN`, `FAILED`, `CANCELLED`. The contract's `Handshake.channel` says `SMS` where `CollectionRecord.handshake_channel` and the domain model say `SMS_FALLBACK`. The master specification's overlay (§21.4) uses a third set of states (F-02) | state-machines.md §6; domain-model.md line 467; the `Handshake` and `CollectionRecord` schemas | AC-23 to 27 | **B** with D-04 |
| F-04 | **Who enters a handshake code is stated two ways, and the ad-hoc direction has no operation.** The feature, the state machine, AC-23 and the permission catalogue ("R: ad-hoc code-entry path") have the rider enter an ad-hoc sender's SMS code; the Rider surface says `verifyHandshake` is "Not a rider act — Vendor" and its Handshake screen calls only `initiateHandshake` and `requestSmsHandshakeFallback`; the contract describes `verifyHandshake` as "Vendor account, own stop only". No operation sends the code to an ad-hoc sender. The catalogue limits the Rider's `pickup.collection.confirm` to that "ad-hoc code-entry path", while the contract and pickup-collection.md line 32 give the same key to the Rider's `recordCollection`, `initiateHandshake` and `requestSmsHandshakeFallback` on every stop | [permissions.md](../../contracts/permissions.md) line 135; [rider-android.md](../../surfaces/rider-android.md) lines 104 and 177; pickup-collection.md line 32, §3 and §5.1; `verifyHandshake` | AC-23, 24, 28 | **A** (D-04, D-14) |
| F-05 | **The high-value surcharge is confirmed in settings and absent from the price.** `MELARC_HIGH_VALUE_TIERS` is `CONFIRMED` (GH₵10 above GH₵500, GH₵20 above GH₵2,000) and AC-54's note says a parcel "may pay a high-value surcharge and still be capped"; the fee table and the `price_components_snapshot` components list no such component, and the `Order.is_high_value` row still says not to implement a surcharge until `OQ-062` closes, which itemization.md says closed on 20 August | itemization.md lines 63 to 69, 153, 306, 384; domain-model.md lines 545 and 552; settings.md line 130 | AC-54 and the price of any high-value parcel | **A** (D-06) |
| F-06 | **Whether the estimate exists and is kept is unclear.** The master specification says a standard request shows no estimate; MSC-DEC-211 (features, contract prose) says it does; the domain model says it is "computed, not persisted"; AC-56 asks that "the estimate and the frozen price are preserved and visibly distinct" | Master specification lines 1428 and 1431; domain-model.md line 412; AC-56 | AC-01, 56 | **A** (D-01) |
| F-07 | **The refusal of a declared count in a count request has two codes.** hub-intake.md §5.2 and the state machine give `BLIND_COUNT_VIOLATED`; AC-38 and the contract (`submitBlindCount`, `additionalProperties: false`) give `VALIDATION_FAILED` | hub-intake.md lines 69 and 163; state-machines.md line 183 | AC-37, 38 | **B** (choose one) |
| F-08 | **The Rider app's technology is stated two ways.** "A native Android application — explicitly not a web app or PWA" ([rider-android.md](../../surfaces/rider-android.md) line 11) and "Rider Android should use native Android components" ([DESIGN_SYSTEM.md](../../design/DESIGN_SYSTEM.md) line 37) against "Rider: React Native" and a section on "the honest cost of React Native" ([SOLUTION_ARCHITECTURE.md](../../architecture/SOLUTION_ARCHITECTURE.md) lines 26 and 176) and "The React Native app pins the Melarc API TLS certificate" ([SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) line 1340) | The files and lines named | Every Rider task: toolchain, tests, the offline store, key handling, CI | **A** (D-03) |
| F-09 | **AC-67 lets a rider skip stops; the contract does not.** "The second rider may skip the remaining stops and complete the run" against `skipPickupStop`: "Ops Staff, Senior Ops or Platform Admin … **Not the rider**: no rider bundle holds this key". **AC-74, in the same file, refuses a rider's skip with `PERMISSION_DENIED`**, so the two criteria disagree | pickup-manifest.md AC-67 (line 270) and AC-74 (line 300); `skipPickupStop` | AC-67, 74 | **A** (D-07) |
| F-10 | **"The rider is notified" has no channel.** AC-13 and pickup-manifest.md §5.1 say dispatch notifies the rider; the Rider surface is "pull-only: a rider learns of a dispatched or reassigned run … only by opening the app", and whether any event deserves a push is open (`OQ-117`) | pickup-manifest.md lines 56 and 184; rider-android.md line 642 | AC-13 | **A** (D-11) |
| F-11 | **The recipient-channel document bars any READY for this slice, and the slice touches more of the channel than it says.** "No `READY` status may be granted to any slice touching the recipient channel until all three are resolved" (`OQ-048` the SMS provider, `OQ-028` the legal basis, `OQ-109` the Hubtel merchant contract). SLICE-001 says it touches the channel "only for the ad-hoc handshake SMS"; the recipient heads-up SMS fires "at itemization close, if enabled" (a confirmed kill switch) | [recipient-channel.md](../../surfaces/recipient-channel.md) lines 32 and 139 to 147; settings.md line 170; SLICE-001.md line 23 | The READY verdict itself | **A** (D-10) |
| F-12 | **Statements that are no longer true**, to be corrected in Stage 0: `confirmPickupRequest`'s description lists the withdrawn `BOOKING_CUTOFF_PASSED`; pickup-collection.md §12 says the handshake operations are not in the contract (its §15 and the contract say they are); pickup-failure.md §12 says the Ops decision operations are missing (its §15 says they were added); pickup-manifest.md §15 lists `OQ-027` as owed (the contract header says `MSC-DEC-419` closed it); domain-model.md line 545 cites `OQ-062` as open; itemization.md §5.1 numbers two steps 8; settings.md says "nine" fee keys in two places and its table holds ten; `OQ-051` names three different questions; MIGRATION_AND_SEEDING.md line 23 says a hub cannot be created without its default zone and line 209 seeds the hub without one; settings.md says the handshake code length, TTL and attempt limit were reviewed and confirmed (`MSC-DEC-256`, 26 August 2026, line 89) while its own rows (lines 161 to 163) and pickup-collection.md (lines 119 and 288) still call them pending security review (`OQ-048`) | errors-and-enums.md line 318; the contract at `confirmPickupRequest`; pickup-collection.md lines 119, 136, 288, 300; pickup-failure.md lines 132, 232; pickup-manifest.md line 344; settings.md lines 23, 89, 116, 121 to 130, 142, 155, 161 to 163 | None alone | **B** |

### 5.2 The contract does not describe the slice

Verified against `contracts/openapi.yaml` 5.77 and the documents named.

| ID | Finding | Blocks | Needs |
|---|---|---|---|
| F-13 | **Fields the criteria assert are in no schema.** The indicative estimate (the prose says the response carries it; `PickupRequest` has no property for it); `cutoff_exception_state` (AC-04; in the domain model §6.2, absent from `PickupRequest`); the **one-package exception's recipient name, phone and delivery address** (AC-03; required by §21.1 and by the domain model's invariant, yet no entity, create schema or exception body holds them, and the contract gives no way for a one-package request to exist for the exception to attach to, since `createPickupRequest` refuses fewer than two packages); the **saved location a request selects** (`vendor_pickup_location_id` is in the domain model; `PickupRequestCreate` has `pickup_location` and `location_overrides` only); the **fixed pickup-failure category** (`reportPickupFailure` takes `reason_code`, `note`, `evidence_ids` and `contact_attempts`; `PickupStop` carries no category; AC-30, 33); `is_serialized_goods` and `serial_imei` (AC-53; domain model lines 536 and 537; absent from `OrderItemize` and `Order`); evidence references on itemization for a high-value parcel and for the waybill behind a carrier cost (AC-54, 59); `delivery_date_override`; the explicit zone authorization the prose mentions; the cancellation charge's snapshot of setting key and version (AC-64); `PickupStop.arrived_at` and the failure snapshot; `PickupManifest.completed_at`; the **declared value, requested delivery date and service level of each parcel** (domain-model.md lines 535, 538 and 539 require them at itemization; `declared_value_minor` exists only on `PickupRequest` and `PickupRequestCreate` and the other two nowhere in the contract, so AC-54's auto-flag has no input and the requested date that `itemizeOrder`'s own description says takes precedence has no field); `payer_override`, an untyped object (AC-55, 66); the **primary and secondary phone** of a request (domain-model.md line 384, §21.1; in no schema; AC-69 reuses "phones"); and **what a stop is to the Rider**: its stop detail shows vendor, packages and a location note from the embedded stops (rider-android.md line 103), but `PickupStop` holds only its identifiers, sequence and state, and the registry denies the Rider any read of `PickupRequest` (data-scope-registry.md lines 107 and 109) | AC-01, 03, 04, 30, 33, 53 to 55, 59, 64, 66, 69; the Rider's stop detail | **A** for the recipient capture and the estimate; **B** for the rest |
| F-14 | **Error codes the criteria expect that the operation does not declare, or that the catalogue's own rule contradicts.** `recordCollection`: `REASON_REQUIRED` (AC-21; its own description says it). `itemizeOrder`: `VALIDATION_FAILED` and `REASON_REQUIRED` (AC-47, 53, 54), and no `400` response is declared. `dispatchManifest`: `NO_SERVICEABLE_MOTORCYCLE` (AC-15; the state-machine row lists it; `assignRider` declares it). `createPickupManifest`: `ALREADY_MANIFESTED` appears in the description and in no catalogue or `x-error-codes`. `cancelPickupRequest`: `PICKUP_ATTEMPT_LIMIT_REACHED` (AC-07; only `confirmPickupRequest` declares it). `closeHubIntake`: no `ORDER_UNPRICED`, `INSUFFICIENT_AUTHORITY` or `REASON_REQUIRED`. `createPickupRequest` declares neither `DESTINATION_UNRESOLVED` nor `SENDER_IDENTITY_AMBIGUOUS`, the catalogue's codes for AC-70 and AC-71 (errors-and-enums.md lines 156 and 157). `COLLECTION_NOT_RECORDED` (the code for generating a handshake code too early) and `EXCEPTION_NOT_AVAILABLE_TO_SELF_SERVICE` (the code a vendor gets from the one-package path) are in the catalogue and **declared by no operation**. **`SIZE_CLASS_REQUIRED` (AC-58) cannot be produced:** `OrderItemize` requires a non-nullable `size_class`, so an omitted class is a schema violation (a `400` that `itemizeOrder` does not declare) and never reaches the rule that raises the code. **AC-42 and AC-76 (and hub-intake.md §5.2) expect `INSUFFICIENT_AUTHORITY` for an Ops Staff user, while the catalogue says "a missing key is `PERMISSION_DENIED`, never this" and `hub.osd.adjudicate` is held by Senior Ops and Platform Admin only.** Outside production the API answers an undeclared refusal as a `500` (`declared-refusals.ts`), so each omission fails the test that provokes it. The wider question of `VALIDATION_FAILED` is the owner's open finding 1 of [SLICE-000 §7.49](SLICE-000-IMPLEMENTATION-PLAN.md#749-stage-8-s062-to-s070-27-and-28-october-2026) | AC-07, 11, 15, 21, 42, 47, 53, 54, 58, 70, 71, 76 | **A** (the contract-wide rule), then **B** |
| F-15 | **Operations the specifications require that the contract lacks.** Decline a request (`PENDING → DECLINED`; the state, the audit event and the schema enum exist). Cancel a manifest (`DRAFT/DISPATCHED → CANCELLED`, `RUN_ALREADY_STARTED`). Mark a custody handover `FAILED` (AC-68). Dispute a collection and resolve an expired or exhausted handshake manually (AC-26, 27). The receiver's recording of a condition and its evidence at count time (AC-41, 42; only the Senior Ops `adjudicateDiscrepancy` carries `condition`, and an Ops Staff receiver cannot create the evidence: `createEvidence` asks for the key of the act the evidence attaches to, here `hub.osd.adjudicate`, which only Senior Ops and Platform Admin hold (permissions.md line 153), while hub-intake.md line 40 gives Ops Staff "record OS&D"). Close an intake by the approved exception (`closeHubIntake` has no body for the reason) and reopen one (`hub.intake.reopen`). Edit the payer arrangement before freeze and apply a post-freeze correction or repricing (AC-55; the `pricing.correction.*` and `pricing.reprice.*` keys exist and **no operation uses any `pricing.*` key**). Correct the pickup origin mid-request (AC-57). A read of the vendor-facing intake-completed and order summary (AC-46). An unmanifested-pool read (AC-11). **A lookup of a returning ad-hoc sender by verified phone (AC-72) and a read of a vendor's saved locations** (no operation lists them). The assisted Ops review of a failure (AC-35). **Resolve a cutoff exception** (state-machines.md line 43; pickup-request.md lines 33 and 115 list it as an Ops act; the contract has no `cutoff_exception` anywhere). **A read of an Order:** only `itemizeOrder` returns one, so the Vendor's `/orders/{id}` route (vendor-pwa.md line 84), AC-56's "visibly distinct" estimate and price, and `pricing.read` ("Vendor reads the fee on own orders", permissions.md line 293) have nothing behind them | AC-04, 11, 26, 27, 35, 41, 42, 46, 55 to 57, 68, 72 | **A** for each (D-07), except the unmanifested-pool read (AC-11), which is **B**, a filter on `listPickupRequests` |
| F-16 | **Reads that return an `ETag` are missing.** 21 operations in the inventory require `If-Match`. `getPickupRequest` and `getHubIntake` set it. **No read sets it for a manifest (seven operations take it: set order, assign, dispatch, start, initiate and accept custody handover, hub handover) or a pickup stop (three: collect, fail, skip), and there is no stop read at all** (the Rider surface says stops are embedded in the manifest read); no response of the evidence operations sets the one `completeEvidenceUpload` takes. [Implementation Plan §4c](../IMPLEMENTATION_PLAN.md#4c-what-slice-000-retired-and-who-owes-it-now--msc-dec-433) says every slice that builds an `If-Match` operation with no read that sets an `ETag` owes "the read that returns the record's `ETag`". **The offline queue meets the same operation:** the Rider surface says the queued hub-handover submit omits `If-Match`, because a stale one would refuse a legitimate queued command (rider-android.md line 78), but `submitHubHandover` requires it; and the Rider's reconcile path reads `listHubIntakes` (line 84), whose key `hub.read` the Rider does not hold (permissions.md line 292) | AC-12 to 18, 20, 21, 29, 30, 74 | **B**; **A** for the offline queue (D-03) |
| F-17 | **The reason catalogue has no domain for the slice's reasons.** Operations take a `reason_code` for cancelling a request (with the mandatory attribution the charge depends on), a pickup failure, a short count, a one-package exception, an escalation, a handshake override, an OS&D adjudication and a custody handover. The catalogue's domains are closed by a `CHECK`; no workflow-domain row is seeded, and MIGRATION_AND_SEEDING.md line 211 says they are "seeded by the slice that uses them, and a failure path that needs one is not accepted before then". The `PICKUP_STOP_SKIP` rows are specified (four codes, domain-model.md §3.9) and not seeded. The other codes and their metadata are product values | AC-05 to 07, 21, 25, 30, 31, 41, 60 to 64, 74 | **A** (D-05) |
| F-18 | **Three operations in the `pickup-requests` tag are named by none of the six features**: `reassignPickupRequestHub` (the security matrix has 11 rows for it, Family G), `overrideServiceWindow` and `assessParcelHandling`. The three evidence operations belong to no feature either | The scope of the plan | **A** (D-09) |
| F-19 | **The role bundles hold none of the slice's keys.** The seed holds SLICE-000's keys only; a later slice's key "is granted by the migration that slice adds", which raises the bundle's revision as an addition. For the Vendor and Rider this is the fixed-policy release procedure proved in S0.63. `pickup.exception.approve` is "S P, and Ops Staff explicitly granted it", but per-user overrides remain open (`OQ-047`, permissions.md line 439) and no mechanism grants it to one Ops Staff member (`tools/seed/bundles.ts` header; permissions.md lines 129 and 439) | Every operation | **B**, and **A** for the explicit grant (D-14) |
| F-20 | **The data-scope registry has no row** for the one-package approval, the handshake, the attempt extension, the cancellation-charge waiver, the parity exception, a dispute's reconciliation item, the vendor-facing summary, price-correction and repricing requests, and setting proposals and versions. A table needs its row first ([data-scope-registry.md](../../contracts/data-scope-registry.md) line 13; [apps/api/CLAUDE.md](../../apps/api/CLAUDE.md)); each is a table or an embedded value, and the documents do not say which | The migrations that create them | **B** |

### 5.3 What the slice needs from other slices

| ID | Finding | Evidence | Blocks | Needs |
|---|---|---|---|---|
| F-21 | **SLICE-014 has no slice document and no operation.** Implementation Plan §3 makes SLICE-001 depend on it "build only" and §4a names two options (implement its administration first, or the owner authorizes "a bounded launch-fee seed") and "chooses neither". The contract has no operation that creates or changes a hub, zone or fee, and **no operation uses any `hub.setting.*`, `pricing.structure.*` or `settings.read` key**, although the keys exist. The zone catalogue's fields, versioning, effective dating, overlap, rollback and snapshots "remain design work". The seeding document says the Accra hub is seeded without a zone "so **no zone-dependent operation can be accepted until zone data exists**" (slice 014). The fees are hub-scoped, effective-dated, snapshotted and never inherited; Senior Ops proposes and Platform Admin approves; a missing value fails visibly | [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md) lines 32, 45, 53 to 59; settings.md lines 19, 73, 120; MIGRATION_AND_SEEDING.md lines 209 and 210; `contracts/openapi.yaml` (no hub, zone or fee operation); permissions.md lines 154, 155, 165, 166 | Every priced path; AC-01, 04, 48 to 50, 56, 60, 61 | **A** (D-02) |
| F-22 | **No rule turns an address into a zone.** The server must resolve the zone: "a free-text address is never authoritative", and the client never sends one. A location is a free-text address, an optional landmark, optional coordinates and optional GhanaPost GPS; "the operation runs on landmarks and phone calls; a model that assumes geocoding will block real bookings". How the seven zones, the three service areas and the corridor batch days are derived from that, and what an "ambiguous" resolution is, is not specified | domain-model.md §3.5 (lines 81 to 86); itemization.md lines 58 and 81 to 82; settings.md line 121 | AC-48, 49, 50, 57; the booking's zone-coverage check | **A** (D-02) |
| F-23 | **Vendor records the slice reads are missing or unspecified** (SLICE-008). No saved-location table in the database (the domain model specifies one and the contract has four operations on it, none that lists them), and no allowance, standing or hold table; the "business goods profile" is an entity nowhere; which stored number is "the registered number" for the SMS fallback is not stated (`VendorOrganization.contact_phone` and `VendorCredential.recovery_phone` both exist); the hold of a suspended vendor's requests has no representation (the hold entity is one row per held **order**, `order_id` non-null). The vendor fixture sets no location, phone or allowance | domain-model.md lines 1465, 2302; state-machines.md line 65; `vendor-fixture.ts` lines 19 and 20; MIGRATION_AND_SEEDING.md line 248 | AC-02, 08, 09, 21, 24, 65, 69, 70 | **C**, **A** (D-14) |
| F-24 | **Fleet records are missing** (SLICE-011). A motorcycle, its assignment to a rider and a breakdown have prose and no table, operation, key or fixture; the "serviceable motorcycle" rule is a guard with no single predicate. The three custody operations are complete except the failure of a handover | master specification lines 2313 to 2346; state-machines.md lines 89, 90, 112; permissions.md lines 228 to 233; no `Motorcycle` operation | AC-15, 67, 68 | **C**, **A** (D-14) |

### 5.4 Infrastructure no document has placed

| ID | Finding | Evidence | Blocks | Needs |
|---|---|---|---|---|
| F-25 | **Notifications have a design and no mechanism.** The architecture specifies an outbox written in the business transaction, a relay, job types `notify_rider_run_dispatched` and `notify_vendor_milestone` and a `worker:notification` capability. None is built: the capability list is closed at six and says the `Outbox` classes "arrive with the `Outbox` table". The `Notification` entity has "no field detail", its fields "owed by SLICE-010"; `notification` has a read key and no write key; SLICE-010 is unwritten and follows SLICE-002. The slice raises at least: the run dispatch to the rider, the short-count flag to the office, the skipped stop to the vendor, request confirmed or declined, handover submitted, intake completed, and the SMS notices of F-26. For several the recipient, channel or content is stated nowhere | [BACKGROUND_JOBS_AND_EVENTS.md](../../architecture/BACKGROUND_JOBS_AND_EVENTS.md) lines 187 to 209, 238, 239; [SECURITY_DESIGN.md](../../architecture/SECURITY_DESIGN.md) line 1150; data-scope-registry.md lines 248, 325; permissions.md line 321; master specification lines 2017 to 2027; `task-capabilities.ts` header | AC-13, 21, 74 and the office queue | **A** (D-11) |
| F-26 | **SMS to people who are not principals has no delivery path.** The one SMS channel and its capture adapter serve credential links: a message carries a link, a redemption record and a STAFF or VENDOR principal. A handshake code to an ad-hoc sender, the vendor fallback to its "registered number only" (cap 3, cooldown 60 s) and the heads-up SMS need a linkless message kind, templates and a code store; the provider is `OQ-048`; whether the send is queued or synchronous is not stated for these messages (BACKGROUND_JOBS_AND_EVENTS.md line 250 asks it only of the delivery OTP); where the handshake code is stored is not in the security design | `platform/auth/ports/delivery-provider.port.ts` (`ProviderMessage.link` required); BACKGROUND_JOBS_AND_EVENTS.md line 250; settings.md lines 167 and 168 | AC-23, 24, 73 | **A** (D-10, D-11) |
| F-27 | **The failure backstop has a worker design and no scheduler or cadence.** `sweep_failure_backstop` and a `melarc_worker_cap_pickup_backstop` over the four pickup tables are designed; the cadence cell reads "Periodic" beside "24 hours — set" (the same figure as the threshold `stale_failure_backstop_hours`); no document says whether the delivery worker's process may carry another lane (it already runs a periodic task) or what a scheduler enqueues; the capability lacks a write on `Notification` though an escalation notifies Senior Ops. The execution plan forbids workers "merely because" they are common; AC-34 is a retained requirement | BACKGROUND_JOBS_AND_EVENTS.md lines 158, 252; SECURITY_DESIGN.md line 1151; data-scope-registry.md line 249; [DEVELOPMENT_EXECUTION_PLAN.md](../DEVELOPMENT_EXECUTION_PLAN.md) §12 | AC-34 | **A** (D-11) |
| F-28 | **The evidence store has an operation design and no store.** Three operations, presigned single-object capabilities (15 and 5 minutes) and a quarantine state are specified; "malicious-content validation" is a listed step with no mechanism; the product and its provisioning are chosen in no document, and retention waits on `OQ-091` and `OQ-028` (SECURITY_DESIGN.md lines 1295 and 1296); the size ceiling and MIME whitelist are `OPEN` (`OQ-121`) and unseeded; `infrastructure/` holds PostgreSQL only; the validation locus is stated two ways (a worker capability, or in the request); evidence is not one of the 17 permission domains, so a folder for it is a new domain, which is the owner's | SECURITY_DESIGN.md lines 1158, 1209, 1295, 1296; settings.md lines 211, 212; hub-intake.md line 318; SOLUTION_ARCHITECTURE.md lines 97 to 106 | AC-31, 41, 42, 54, 59 | **A** (D-09, D-13) |
| F-29 | **`intake.completed` and the vendor summary are defined nowhere.** The event is named in itemization.md, the state machine and the master specification; it is not an audit code (closure is `hub.intake.closed`), not in the events architecture, and not in the contract; the only intake read is `getHubIntake` under `hub.read`, staff-only. What the vendor may see is bounded by what is omitted, not by a schema | itemization.md line 75; state-machines.md line 203; master specification line 1467; hub-intake.md lines 43, 91 | AC-46 | **A** (D-07) |
| F-30 | **The credit ledger does not exist and is SLICE-007's.** "`Payment`, `VendorBalance`, `VendorStatement`, `StatementLine` and `Adjustment` are named … and nowhere given a field table"; reserving credit at itemization is `OQ-005`, `ARTIFACT_REQUIRED`. No criterion of the slice needs `CREDIT_RESERVED`: AC-51 uses `PAYMENT_REQUIRED` and AC-65 and -66 use `NO_VENDOR_CHARGE`; the vendor fixture is allowance-disabled | domain-model.md line 313; itemization.md lines 74, 382; `vendor-fixture.ts` lines 19, 20 | The `CREDIT_RESERVED` branch of the commercial gate | **A** (D-12) |
| F-31 | **The slice's failure modes have no metrics, alerts or runbook steps.** Counters exist for credential delivery, the limiter, the audit and the attestation only. The SMS-fallback ratio must be plotted, a backstop job more than 15 minutes late is SEV-2, evidence and offline-sync failures have no runbook | OBSERVABILITY_AND_RECOVERY.md lines 41 to 46, 111, 141 to 148; `platform/metrics/metric-catalogue.ts` | Gate of the final stage | **B** |
| F-32 | **Code placement has traps.** SMS or notification code must not sit in `platform/delivery` (the `credential_delivery` capability opens only there); every new capability enters `TASK_CAPABILITIES`, `CAPABILITY_ACCESS` and the registry together; an adapter is a `*.adapter.ts` imported only by the composition-root files `architecture.test.ts` lists; domain-to-domain imports (pickup to fleet, hub to pricing) are allowed by no document; evidence and notification are "cross-cutting" with no stated home | SOLUTION_ARCHITECTURE.md lines 97 to 110; `apps/api/src/architecture.test.ts`; apps/api/CLAUDE.md | Placement of S1.11, S1.12 | **A** (D-09) |

### 5.5 The client surfaces

Read from [ops-portal.md](../../surfaces/ops-portal.md) lines 78 to 96, [vendor-pwa.md](../../surfaces/vendor-pwa.md) lines 77 to 86 and [rider-android.md](../../surfaces/rider-android.md) lines 97 to 108 and 72 to 91, with the reviewer's reading checked against them.

| ID | Finding | Blocks | Needs |
|---|---|---|---|
| F-33 | **Neither client exists, and the sign-in screens they need are owned by no slice.** [Implementation Plan §3](../IMPLEMENTATION_PLAN.md) records that SLICE-000 left "the Vendor PWA and Rider app screens (12 of the former 31 routes and screens) to the slices that build those clients". The Vendor PWA's seven authentication routes and the Rider app's enrolment and sign-in screens must exist before any SLICE-001 screen can be used; no document says SLICE-001 builds them | Stages for both clients | **A** (D-03) |
| F-34 | **The screens are partly specified.** Route and screen inventories exist (ops-portal.md lines 82 to 95, vendor-pwa.md lines 79 to 85, rider-android.md lines 99 to 107) and the features record them as the accepted low-fidelity specification (`MSC-DEC-223`: pickup-manifest.md line 346, pickup-request.md line 481, atomic-dispatch.md line 276), yet overview.md lines 119 to 125 still lists the page-level inventory as owed (`OQ-030`) and the documents do not reconcile the two; there are no wireframes; no route lists fields or table columns; the nine states are stated per surface and only the states that "carry a rule" per route. **Specified** at route level: Ops requests, exception and approvals, manifests, stop skip, the intake queue and count; the Rider run list, run detail, collection and hub handover. **Not specified:** the failure decision queue, the handshake override, the shortfall flag, the Ops side of a custody handover, price correction and repricing (Ops); the intake-completed and order summary, payer edit before freeze, dispute, saved locations (Vendor PWA); the rider's entry of an ad-hoc sender's code. Responsive and accessibility baselines are stated for the SLICE-000 screens only | The Ops, Vendor and Rider tasks | **A** |
| F-35 | **The Rider app's open items.** The offline queue is specified in detail (encrypted store under a Keystore key, a client-minted `Idempotency-Key`, FIFO, three sync states); its storage library is unchosen, a skewed device clock has no bound for `captured_at`, and the reconcile and rejected-sync paths have no criteria. Minimum Android 24, privately built and signed, distributed internally (SECURITY_DESIGN.md line 1432); no push. Evidence photo capture on pickup rows is open (camera baseline `OQ-073`, limits `OQ-121`). The device key and attestation of SLICE-000 have no stated use in this slice | Rider tasks | **A** |
| F-36 | **Ops components the screens need and the portal lacks:** a selectable, filterable, paged queue table; a stop-reordering control; a searchable picker (vendor, sender, rider); a radio group; money display and input and an estimate-against-frozen price display; evidence photo upload; a receiver-lock indicator; an attempt-chain timeline. The portal has the 27 components listed in `components/ui/`; the Vendor PWA and Rider have none, and Android must not use web components (DESIGN_SYSTEM.md line 1383) | The Ops and client tasks | **B** |

### 5.6 Criteria quality (definition of ready §G)

Screened with a script and read against the files. The four properties: a specific named initial state; an exact outcome including the error code; a named surface and test level; a traceable governing section.

| ID | Finding | Criteria |
|---|---|---|
| F-37a | **No governing line, surface or test level at all** (properties 3 and 4) | `-69`, `-70`, `-71`, `-72` (pickup-request.md lines 410 to 454) |
| F-37b | **Governs cites only decision identifiers, no retained section** (property 4: a historical identifier is never sufficient on its own) | `-05`, `-24`, `-25`, `-73` |
| F-37c | **A refusal with no error code named** (property 2) | `-12` (vendor self-cancellation after assignment), `-18` (a rejected queued submission), `-33` (the refused ordinary reschedule), `-64` (a partial waiver); `-69`, `-70` and `-71` say only "REJECTED" where the catalogue has `DESTINATION_UNRESOLVED` and `SENDER_IDENTITY_AMBIGUOUS` (errors-and-enums.md lines 156 and 157) |
| F-37d | **An expected code the catalogue's rule contradicts, or that the operation does not declare** | `-42`, `-76` and F-14 |
| F-37e | **Behaviour with no criterion.** Demonstration step 1's cap acknowledgement at booking (a declared value above GH₵500 needs `liability_cap_acknowledged`, with `VALUE_DECLARATION_REQUIRED` otherwise; only AC-54's note mentions it); "address corrected within the same service area: no repricing workflow fires"; the manual stop ordering of step 3. **Required of `itemizeOrder` by the contract and tested by no criterion:** it writes the order's initial `DeliveryCommitment` atomically (`sequence = 1`), starts its SLA clock at the successful pickup-custody time read back through the collection record, stop and manifest, derives the delivery date (next working day, corridor batch days over it) and refuses with `COMMITMENT_SOURCE_UNRESOLVED` and no Order when the custody time cannot be read. **Confirmed settings nothing enforces:** `intake_parcel_cap` (100) has no operation, code or criterion; `provider_initiating_operation_ceiling_per_minute` (20 a minute per session, inside the authenticated-API bucket, for every operation that causes an outbound SMS) is seeded and enforced by no code and covered by no criterion | [SLICE-001.md](../slices/SLICE-001.md) §6; the contract at `itemizeOrder`; errors-and-enums.md line 155; hub-intake.md line 124; settings.md line 210; `tools/seed/settings.ts` |

### 5.7 Open values

| Value | State | Blocks | Source |
|---|---|---|---|
| Credit-reservation ledger (`OQ-005`) | `ARTIFACT_REQUIRED` | Only the `CREDIT_RESERVED` branch (F-30) | itemization.md §14 |
| `intake_lock_idle_ttl_minutes` (`OQ-051`) | `OPEN` | A test of AC-43's takeover needs a value; launch needs the owner's | settings.md line 142 |
| Evidence upload ceiling and MIME whitelist (`OQ-121`) | `OPEN`, absent from the seed | Evidence validation | hub-intake.md line 318; `tools/seed/settings.ts` header |
| Amasaman & Environs batch days | Two values in two documents (F-01); your message of 28 October points to Friday (D-13) | The zone seed; the corridor off-day price | master specification line 1478; settings.md line 121 |
| Handshake length 4, TTL 15 minutes, 5 attempts (`OQ-048`) | `CONFIRMED` by `MSC-DEC-256` (settings.md line 89); settings.md lines 161 to 163 and pickup-collection.md lines 119 and 288 still say security review pending, launch-blocking | Nothing in development; the documents disagree (F-12) | settings.md §7.4; pickup-collection.md |
| Retention periods (`OQ-028`) | `OPEN` | Evidence retention | settings.md §7.1 |

### 5.8 Size (definition of ready §F, last item)

| ID | Finding |
|---|---|
| F-38 | **The slice is not small enough to complete, integrate, review and demonstrate as one unit without staging.** It has 80 criteria and a derived inventory of 42 operations; it needs the hub, zone and fee capability of a slice with no document; several new families of tables, each with row-level security and a registry row; two new client applications, one a native Android app with an offline queue; a notification mechanism, an evidence store and a scheduler. SLICE-000 had 133 criteria and 42 operations on infrastructure the bootstrap had prepared; SLICE-001 has fewer criteria and more to create. The execution plan forbids widening or narrowing a slice for convenience ([§11](../DEVELOPMENT_EXECUTION_PLAN.md#11-product-implementation-after-bootstrap)); the plan therefore **stages** it with a gate for each milestone, and reserves "slice complete" for the point at which every required criterion is met ([§13](../DEVELOPMENT_EXECUTION_PLAN.md#13-completion-definitions)) |

## 6. The 80 criteria, one by one

**My reading of each criterion against the contract as it stands.** *Ready* means buildable as written once the records in *Needs* exist; *Amend* means a contract, document or criterion-text change and no product decision; *Decide* means the owner (or a specification resolution) comes first. Dependencies: `014` hub, zone and fee capability · `008` vendor records · `011` fleet records · `010` notifications · `reasons` the reason catalogue · `evidence` the evidence store · `scheduler` · `SMS` · `value` an open value · `Rider app` the client half · `etag` the manifest and stop `ETag` reads of F-16.

**Of 80: 31 ready, 20 amend, 29 decide** (counted from the table below). A ready criterion that lists a *Needs* entry is ready only when that record or capability exists.

| AC | Feature | Criterion | Reading | Needs | Why |
|---|---|---|---|---|---|
| 01 | request | Standard request confirms with an indicative estimate and no charge | Decide | 014 | Master specification 23.6 says no estimate at booking (MSC-DEC-211 reversed it and the master text does not record that, F-01); no schema field carries the estimate (F-13) |
| 02 | request | Single package is refused | Ready | 008 fixture | — |
| 03 | request | One-package exception needs the permission and recipient details | Decide | — | Recipient name, phone and delivery address have no field anywhere, and it is not stated how a one-package request exists to attach an exception to (F-13) |
| 04 | request | A late booking queues, it does not fail | Amend | 014 | `cutoff_exception_state` is in the domain model and in no schema (F-13); no operation resolves the exception (F-15) |
| 05 | request | Vendor cannot self-cancel a confirmed request | Amend | — | Governs line cites only MSC-DEC-196; behaviour is declared |
| 06 | request | Reschedule creates a linked clone, never an edit | Ready | — | Cancel with `create_replacement` |
| 07 | request | Attempt cap holds without Senior Ops | Amend | — | Which operation refuses at the cap: `cancelPickupRequest` does not declare `PICKUP_ATTEMPT_LIMIT_REACHED`, `confirmPickupRequest` does (F-14) |
| 08 | request | Suspension holds, it does not cancel | Decide | 008 | Suspension is SLICE-008; "controlled hold" has no representation: the hold entity is one row per held order (F-23) |
| 09 | request | Overrides never rewrite saved defaults | Ready | 008 fixture | — |
| 10 | request | Concurrent confirmation is rejected deterministically | Ready | — | — |
| 11 | manifest | Only confirmed unmanifested requests are eligible | Amend | — | No unmanifested filter or pool read (F-15); `ALREADY_MANIFESTED` is in the prose and in no catalogue (F-14) |
| 12 | manifest | Assignment closes the cancellation window | Amend | — | Refusal names no code (F-37c) |
| 13 | manifest | Dispatch does not start the run | Decide | 010 | The Rider app is pull-only and push is open (OQ-117): "the rider is notified" has no channel (F-10) |
| 14 | manifest | Only the assigned rider may start | Ready | Rider app, etag | API half ready once the manifest `ETag` read exists (F-16); the rider surface is the Android app |
| 15 | manifest | A rider without a serviceable motorcycle cannot be dispatched | Amend | 011 fixture | `dispatchManifest` does not declare `NO_SERVICEABLE_MOTORCYCLE` (F-14); motorcycle and breakdown records have no operation (F-24) |
| 16 | manifest | Stops may be worked out of order | Ready | etag | Needs the stop `ETag` (F-16) |
| 17 | manifest | Completion requires every stop terminal | Ready | etag | Completion is the hub handover, which takes the manifest `ETag` (F-16) |
| 18 | manifest | The queued hub handover keeps its capture time, lands once, and is never dropped | Decide | Rider app, etag | `submitHubHandover` requires `If-Match` and the Rider surface says the queued submit omits it; the reconcile read needs a key the Rider lacks (F-16, D-03); a rejected queued submission names no code (F-37c) |
| 19 | manifest | A rider cannot alter run membership | Ready | — | — |
| 20 | collection | Zero collection is a failure, never a completed stop | Ready | etag | Needs the stop `ETag` (F-16) |
| 21 | collection | A short count needs a reason and flags office | Decide | 010 | `recordCollection` does not declare `REASON_REQUIRED` (F-14); the office flag has no destination, queue or screen (F-25, D-11); the moment the stop becomes `PARTIALLY_COLLECTED` depends on D-04 (F-02) |
| 22 | collection | The hub count is independent of the stop count | Ready | — | — |
| 23 | collection | Handshake direction cannot be reversed | Decide | SMS, clients | The ad-hoc direction (the rider enters the sender's SMS code) has no operation and the order of count and handshake conflicts (F-02, F-04) |
| 24 | collection | Fallback ladder escalates in order and logs every rung | Decide | SMS | The same ordering conflict (F-02); Governs line cites only MSC-DEC-198 |
| 25 | collection | Busy is not a fallback trigger | Amend | — | Governs line cites only MSC-DEC-198 and -201; `requestSmsHandshakeFallback` takes no request body, so the server cannot see the "busy" basis the criterion refuses on |
| 26 | collection | TTL expiry blocks late self-confirmation | Decide | — | "Routes to Ops": `MANUALLY_RESOLVED` has no operation (F-15) |
| 27 | collection | A dispute does not reverse physical completion | Decide | — | A dispute and its "reconciliation item" have no operation or entity (F-15, F-20) |
| 28 | collection | Ad-hoc sender promotes on physical completion | Decide | — | Promotion "on physical completion, without waiting for the handshake response" depends on when the stop closes (F-02, D-04) |
| 29 | collection | Collection is idempotent under replay | Ready | etag | Needs the stop `ETag` (F-16) |
| 30 | failure | Category is fixed and mandatory | Amend | reasons | The fixed category has no request field and no stop field (F-13) |
| 31 | failure | Reason metadata drives what else is mandatory | Decide | reasons | No reason domain for pickup failure reasons exists in the closed catalogue (F-17) |
| 32 | failure | Physical failure is terminal | Ready | — | Service-level |
| 33 | failure | Refused collection is escalation-only | Amend | — | The refused reschedule names no code (F-37c); the fixed category has no stop field (F-13) |
| 34 | failure | The backstop escalates an undecided failure | Decide | scheduler | A scheduled backstop needs a scheduler that no document has placed (F-27) |
| 35 | failure | A vendor cannot reverse a failure by complaining | Decide | — | "Assisted Ops review that is itself audited" has no operation: build it or drop the clause (F-15, D-07) |
| 36 | failure | Zero collection arrives here, not at a completed stop | Ready | — | — |
| 37 | intake | The declaration is not served before commit | Amend | — | Feature 5.2 and the state machine say `BLIND_COUNT_VIOLATED` where AC-38 and the contract say `VALIDATION_FAILED` (F-07) |
| 38 | intake | The client cannot submit the declaration | Ready | — | — |
| 39 | intake | Receiving is a distinct act | Ready | — | — |
| 40 | intake | The hub count is the close authority, not the declaration | Ready | — | — |
| 41 | intake | Condition is recordable on a matching count | Decide | — | The receiver's act of recording a condition has no operation: only `adjudicateDiscrepancy` (Senior Ops) carries `condition`, and an Ops Staff receiver cannot create the evidence (F-15) |
| 42 | intake | Damaged and tampered require evidence and senior review | Decide | — | The receiver's act has no operation and an Ops Staff receiver cannot create the evidence (F-15); an Ops Staff user lacks the key, so the refusal is `PERMISSION_DENIED`, not the `INSUFFICIENT_AUTHORITY` the criterion names (errors-and-enums.md line 182) |
| 43 | intake | The soft lock is advisory, not a substitute | Decide | value | `intake_lock_idle_ttl_minutes` is OPEN (OQ-051, section 5.7) |
| 44 | intake | The rider may correct the pre-filled count | Ready | — | — |
| 45 | intake | Handover requires every stop terminal | Ready | — | — |
| 46 | intake | Vendors see the summary, never the internals | Decide | — | No operation returns the vendor-facing intake-completed and order summary, and `intake.completed` is defined nowhere in the events architecture (F-29) |
| 47 | itemization | Price is server-derived, never client-supplied | Amend | — | `itemizeOrder` does not declare `VALIDATION_FAILED` nor a 400 response; the contract-wide rule is the owner's open finding 1 of SLICE-000 §7.49 (F-14) |
| 48 | itemization | Corridors price on batch day, and cost more off it | Decide | 014 | No rule turns a free-text address into a zone (F-22) |
| 49 | itemization | The size surcharge applies outside Accra and nowhere else | Decide | 014 | No rule turns a free-text address into a zone (F-22) |
| 50 | itemization | Pricing is blocked when a zone will not resolve | Decide | 014 | No rule turns a free-text address into a zone (F-22) |
| 51 | itemization | PAYMENT_REQUIRED counts toward parity | Ready | — | — |
| 52 | itemization | Closure accounts for the hub count, not the declaration | Ready | — | — |
| 53 | itemization | Serialized goods require a serial or IMEI | Amend | — | `is_serialized_goods` and `serial_imei` are in the domain model and not in `OrderItemize` (F-13) |
| 54 | itemization | High value auto-flags and demands evidence | Decide | evidence | No evidence reference and no per-parcel declared value in `OrderItemize` (F-13); `REASON_REQUIRED` undeclared (F-14); the high-value surcharge is in no price formula (F-05) |
| 55 | itemization | The freeze is the boundary for payer edits | Decide | — | No operation edits the payer arrangement or applies a post-freeze correction (F-15) |
| 56 | itemization | The booking estimate is indicative; this is the authoritative price | Decide | 014 | The master specification contradicts (F-01); the estimate is "computed, not persisted" yet the criterion says both are preserved (F-06); no operation reads an Order (F-15) |
| 57 | itemization | Origin zone comes from the request, once | Decide | 014 | No operation corrects the pickup origin (F-15), and no address-to-zone rule (F-22) |
| 58 | itemization | The size class is a recorded human judgement | Amend | — | `size_class` is required by the schema, so an omitted class is a `400` and `SIZE_CLASS_REQUIRED` cannot be produced (F-14) |
| 59 | itemization | Carrier cost is transcribed; the price is computed | Amend | evidence | The waybill evidence has no field (F-13) |
| 60 | request | The post-assignment charge is discretionary, not automatic | Ready | 014, reasons | — |
| 61 | request | An unset amount does not block the cancellation | Ready | 014, reasons | — |
| 62 | request | Only Senior Ops may waive an applied charge | Ready | reasons | The waiver's `reason_code` is required by the schema, so a reason row must exist (F-17) |
| 63 | request | A waiver against no charge is refused | Ready | reasons | The waiver's `reason_code` is required by the schema, so a reason row must exist (F-17) |
| 64 | request | A waiver is total, and the charge stays snapshotted | Amend | — | The snapshot (setting key, version) is not on the `PickupRequest` schema (F-13) |
| 65 | itemization | A recipient-pays order clears the gate with no vendor charge | Ready | 008 fixture | Needs an overdue vendor account (a fixture; the vendor record has no standing field) |
| 66 | itemization | The zero test reads the amount, not the intent | Ready | — | — |
| 67 | manifest | A stranded run is closed by whoever took the parcels | Decide | 011 | The criterion lets the second rider skip stops; the contract reserves `skipPickupStop` to Ops and AC-74 refuses a rider's skip (F-09) |
| 68 | manifest | A handover creates no custody gap, and no count | Decide | — | No operation marks a custody handover `FAILED` (F-15) |
| 69 | request | An `OWN_PACKAGES` request reuses the Vendor and asks only what changed | Amend | 008 fixture | No Governs, Surface or Test level; the saved location a request selects and the request's phones have no field (F-13); the rejection names no code (F-37c) |
| 70 | request | A `COLLECT_FOR_VENDOR` request sends the rider to the collection point | Amend | 008 fixture | No Governs, Surface or Test level; `createPickupRequest` does not declare `DESTINATION_UNRESOLVED` (F-14, F-37c) |
| 71 | request | A first-time ad-hoc sender is creatable, and a returning one is reused | Amend | — | No Governs, Surface or Test level; `createPickupRequest` does not declare `SENDER_IDENTITY_AMBIGUOUS` (F-14, F-37c) |
| 72 | request | Today's goods are captured for every ad-hoc booking | Decide | — | No operation finds a returning ad-hoc sender by verified phone (F-15); no Governs, Surface or Test level |
| 73 | collection | SMS fallback is capped and cooled down, server-side | Amend | SMS | Governs line cites only MSC-DEC-198 |
| 74 | manifest | An authorised skip closes a run that could not close | Decide | 010, reasons | The vendor notice has no stated channel (F-25, D-11); AC-67 lets a rider skip where this refuses it (F-09); the `PICKUP_STOP_SKIP` seeds are specified (domain model 3.9) and not yet in the seed |
| 75 | intake | The handover carries one row per collected request, and each row opens one intake | Ready | — | — |
| 76 | intake | A zero declaration opens the intake and forces Senior Ops review | Amend | — | An Ops Staff user lacks `hub.osd.adjudicate`, so the refusal is `PERMISSION_DENIED`, not `INSUFFICIENT_AUTHORITY` (errors-and-enums.md line 182) |
| 77 | intake | The awaiting-receive queue lists pre-count intakes and never a declaration | Ready | — | — |
| 78 | manifest | A run with nothing collected completes itself, with no handover and no intake | Ready | — | — |
| 79 | request | A vendor reaches only its own requests, and is never told another's exists | Ready | — | — |
| 80 | manifest | A rider sees only assigned work, and is never told a colleague's exists | Ready | — | — |

## 7. Decisions for the Product Owner

**D-01 and D-08 start the plan. D-02, D-04, D-05, D-07, D-09 and D-14 are needed before Gate 0, the end of Stage 0; the other six are answered as the stage that needs each is reached** ([the plan's section 10](SLICE-001-IMPLEMENTATION-PLAN.md#10-owner-resolutions--the-status-of-every-item) names the task for each). Each decision lists its options, what I recommend and why, and what it unblocks. A recommendation is mine, not an approval.

### D-01. Which text governs where the master specification and the later documents disagree

**Decided 29 October 2026: the later documents govern (option a).**

*Findings F-01, F-06, F-12.* The features, contracts, settings, domain model and state machines cite decisions (`MSC-DEC-207` and later) that the master specification (version 1.15) does not contain.

- **Options.** (a) The features, contracts, settings, domain model and state machines govern wherever they cite a later decision, and Stage 0 amends the master text to match. (b) Each contradiction is brought to you when its task is reached.
- **Recommendation: (a).** One decision removes the contradictions on the price matrix, the size classes, the estimate, the intents and the handover; (b) leaves about six stop points inside the pricing tasks.
- **Also yours:** the value in F-01, Amasaman & Environs' batch days (Tuesday and Friday, or Friday only), under D-13.
- **Unblocks:** S1.1 and every pricing task.

### D-02. How the hub's zones, fees and operational settings reach the system

**Decided 29 October 2026: option B, a bounded launch-fee seed; the address becomes a zone through a per-hub alias table with an authorized Ops selection when it is silent or ambiguous. The alias data is still owed.**

*Findings F-21, F-22.* No slice document, no operation and no field design exist for hub, zone and fee administration.

- **Options.** **A. Build the administration first** (the SLICE-014 core): versioned store, propose and approve operations (new in the contract), screens. It needs you to specify the zone and `HubSetting` fields, versioning, effective dating, overlap and rollback, which settings.md calls design work. **B. A bounded launch-fee seed** (the second option of Implementation Plan §4a): the zone and `HubSetting` tables are created now, versioned and effective-dated, seeded for Accra from settings.md through the existing seed path, and read through the settings reader; no administration operation. SLICE-014 later adds proposals and approvals on the same tables. **B needs your explicit authorization**, and a recorded rule for what is seeded.
- **Either way you must specify** how an address becomes a zone (F-22): for example a landmark and area alias table kept per hub, an Ops selection from the zone list at itemization recorded as `EXPLICITLY_AUTHORIZED`, or a GhanaPost GPS prefix map. Without it AC-48 to 50 and 57 cannot be built.
- **Recommendation: B**, with the zone resolved by a per-hub alias table and an authorized selection when the table is ambiguous or silent. It is the smallest build that makes pricing real, and it invents no administration design. The plan's Stage 1 is written for B with the additions for A marked (S1.9).
- **Unblocks:** Stage 1 and every priced path.

### D-03. The two clients: scope and the Rider's technology

**Decided 29 October 2026: the Vendor PWA and the Rider Android app get their own slices, and SLICE-001 is accepted at API and Ops level, as SLICE-000 was for its clients. The Rider's technology and the offline `If-Match` rule are decided in the Rider slice.**

*Findings F-08, F-33 to F-36.*

- **Scope.** (i) Build both inside SLICE-001, in the last two stages, with the API and Ops half accepted first as milestones (recommended: the slice's own definition lists the surfaces, and the execution plan forbids narrowing a slice for convenience). (ii) Re-scope: accept SLICE-001 at API and Ops level with the Vendor and Rider rows verified at API level, as SLICE-000 did for its Vendor and Rider halves, and give the two clients their own slices. That changes the slice table and is yours.
- **The clients' sign-in, setup and recovery screens** that SLICE-000 left "to the slices that build those clients" belong to those stages, whichever option you choose.
- **The offline hub handover (F-16).** The Rider surface says the queued submit omits `If-Match` (rider-android.md line 78); the contract requires it on `submitHubHandover`. **Recommendation:** the contract follows the surface. `If-Match` is optional on `submitHubHandover` when the command is a queued replay, and the state guard `IN_PROGRESS → COMPLETED` with the `Idempotency-Key` carries the invariant; the reconcile read is `getPickupManifest`, which the Rider holds (`pickup.read`, assigned stops only), not `listHubIntakes`, which it does not. The alternative is a stale `ETag` and a refused legitimate command.
- **Rider technology.** Native Android (the Rider surface and the design system) or React Native (the solution architecture and the security design). **Recommendation: native Android**, because the surface, the design system and the device-key, attestation and Keystore queue design depend on it, and the architecture document itself states React Native's cost. The decision is yours; the other documents are then corrected in S1.1.
- **Unblocks:** Stages 8 and 9, and the surface text of S1.1.

### D-04. The order of the count and the handshake, and the ad-hoc direction

**Decided 29 October 2026: option 1, count then confirm.**

*Findings F-02, F-03, F-04.* The sources hold three readings and each overturns something; the documents do not settle it.

- **Option 1, count then confirm.** `recordCollection` records the count and creates the `CollectionRecord`; the stop stays `ARRIVED`. The system then generates the code (the state machine's guard: a collection is recorded). The registered vendor enters it in the Vendor PWA; for an ad-hoc sender the system sends the code by SMS and the rider enters it, which needs `verifyHandshake` to accept the rider for an ad-hoc stop. The stop closes `COLLECTED` or `PARTIALLY_COLLECTED` when the handshake is `VERIFIED` (or overridden). `HANDSHAKE_NOT_VERIFIED` leaves `recordCollection`; `handshake_type` and `handshake_channel` leave its request and are set by the handshake; the state names follow the state machine. **It keeps** the feature's order (§5.1 steps 2 to 5), the state machine's guards, the error catalogue and the fallback ladder, which exists because the code gates the stop. **It overturns** the master specification's §21.4 ("recorded independently from physical pickup status"; "manifest completion does not wait for confirmation") and leaves AC-27, AC-28 and the second "never" rule of the feature's §5.3 to be reworded: with the stop closing on verification, "physical completion" in AC-28 has to mean the count being recorded, and the moment of `PARTIALLY_COLLECTED` in AC-21 is the verification.
- **Option 2, confirm then count.** The handshake runs right after arrival and `recordCollection` closes the stop with a verified handshake, as the contract reads today. It removes `COLLECTION_NOT_RECORDED` and makes the handshake confirm presence rather than the count. It overturns the same statements of §21.4.
- **Option 3, the overlay.** `recordCollection` records the count and closes the stop at once; the handshake runs beside it as a confirmation with its own states (`pending_vendor`, `confirmed`, `disputed`, `unconfirmed`, §21.4) and gates nothing: not the stop, not the manifest, not the ad-hoc sender's promotion. **It keeps** §21.4, §35.3 item 7, AC-26 to 28 and the "never" rules. **It overturns** the state machine's two `handshake VERIFIED` guards, `HANDSHAKE_NOT_VERIFIED`, the feature's §5.1 order, and the purpose of the fallback ladder and the "busy" rule, which would no longer decide whether a stop can close.
- **Recommendation: Option 1**, with Option 3 if you want the master specification's wording to stand. I recommend 1 because the state machine, the error catalogue, the contract and the fallback ladder already assume that the code gates the stop, so it rewords AC-27, AC-28 and one "never" rule and amends §21.4 of the master text (D-01 (a)) instead of redrawing the state machine. That is my reading of where the documents lean, not a finding that they agree. The plan is written for Option 1; S1.26 and S1.27 say what Option 3 would change.
- **Unblocks:** Stage 5.

### D-05. The reason catalogue for the slice

**Decided 29 October 2026: a catalogue for cancellation, pickup failure and short count, a mandatory note for the other reasons. The codes are the owner's and are still owed.**

*Finding F-17.* The slice needs reasons for: cancelling a request (with the attribution `CUSTOMER`, `MELARC` or `EXTERNAL` that decides the charge), a pickup failure (the four categories are a fixed enum; the note, contact attempt and photo requirements are reason metadata), a short count, a one-package exception, an escalation, an attempt extension, a handshake override, an OS&D adjudication and a custody handover; and the four `PICKUP_STOP_SKIP` codes that are already specified.

- **Options per field.** A catalogue domain with seeded codes and metadata, decided as `MSC-DEC-409` and `-412` did (a table of code, attribution, requirements); or a mandatory free-text note and no catalogue where no routing depends on a code (for example the waiver, the extension and the override's verification note).
- **Recommendation:** a catalogue for cancellation, pickup failure and short count (their attribution, requirements or routing drive behaviour); a note for the others. You supply the codes; I will not invent them.
- **Unblocks:** S1.7 and the tasks that take a reason.

### D-06. The high-value surcharge and the composition of the price

**Decided 29 October 2026: its own component of the locked price, snapshotted with hub, setting key, version and value and stacked additively; the tiers are those of settings.md.**

*Finding F-05.* Confirm that the surcharge of `MELARC_HIGH_VALUE_TIERS` is its own component of the locked price, snapshotted with its hub, setting key, version and value, and stacked with the others (master specification §23.4: "stack additively"); or defer it and say so. **Unblocks:** S1.6, S1.36.

### D-07. Operations the specifications require and the contract lacks

**Decided 29 October 2026: build the 14 operations (the rows marked Build, the audited Ops review of a failure and the one-package path included); reopening an intake and declining a request are deferred; for AC-67 only Ops skips.**

*Findings F-09, F-15, F-29.* For each row, build in this slice (added to the contract in Stage 0), defer to a named slice, or drop the clause of the criterion.

| Capability | Criteria | Recommendation |
|---|---|---|
| Cancel a manifest before it starts | state machine; `RUN_ALREADY_STARTED` | Build (S1.21) |
| Mark a custody handover `FAILED` | AC-68 | Build (S1.24) |
| Dispute a collection; resolve an expired or exhausted handshake manually | AC-26, 27 | Build (S1.27, S1.29), with the reconciliation item as a table |
| The receiver records a condition and its evidence at count time, with a key an Ops Staff receiver holds (`createEvidence` today asks for `hub.osd.adjudicate`) | AC-41, 42 | Build (S1.34) |
| Close an intake by the approved exception | itemization §5.2; state-machines.md line 189 | Build, as a body on `closeHubIntake` (S1.38) |
| Reopen a closed intake (Platform Admin) | hub-intake §5.2, no criterion | Defer |
| Decline a request | `DECLINED` state, no criterion | Defer, or state that cancel serves |
| Payer edit before freeze; post-freeze correction and repricing | AC-55 | Build the minimal pair AC-55 needs (S1.39), or re-scope the clause |
| Correct the pickup origin mid-request | AC-57 | Build (S1.39), or re-scope the clause |
| The vendor-facing intake-completed and order summary, and a read of an Order | AC-46, 56; vendor-pwa.md line 84 | Build the reads and name the event (S1.38) |
| An unmanifested-pool read | AC-11 | Build (S1.20) |
| How a one-package request exists, and where its recipient's name, phone and delivery address live | AC-03; §21.1; pickup-request.md lines 90 and 113 | Build (S1.16): the recipient on the exception body, the request created `PENDING` with its one package and not confirmable before the exception is approved. My suggestion; the documents state neither |
| Resolve a cutoff exception (Ops approves a same-day exception or reschedules) | AC-04; state-machines.md line 43 | Build (S1.15) |
| Find a returning ad-hoc sender by verified phone | AC-72 | Build (S1.14) |
| List a vendor's saved locations | AC-69 | Build (S1.14) |
| The assisted Ops review of a failure | AC-35 | Build as an audited note on `escalatePickupRequest`, or drop |
| Who may skip stops after a custody handover | AC-67 (AC-74 refuses a rider's skip) | Either change the criterion (Ops skips, as the contract says) or give the receiving rider a narrow key |

### D-08. Authorize Stage 0, the reconciliation

**Decided 29 October 2026: authorized, on a branch, committed once as a checkpoint and not pushed.**

One reviewed change, as SLICE-000's Stage R was: the master specification, the six feature files' stale text and criteria defects (F-12, F-37), the contract (fields, codes, ETag reads and the operations you choose in D-07: F-13 to F-16), the state machines, domain model, errors, permissions, audit, settings and registry (F-03, F-17, F-19, F-20), and the regenerated client. It is made on a branch, committed once as a checkpoint, and **not pushed**. **Unblocks:** everything after it.

### D-09. Operations no feature names, and where evidence code lives

**Decided 29 October 2026: as recommended. The store is Cloudflare R2, with an in-process stand-in for development and CI; evidence is built with its first user, S1.28.**

*Findings F-18, F-28, F-32.* Recommended: `reassignPickupRequestHub` goes with SLICE-014 (§34.9 and §35.10 are hub rules; the matrix has its 11 rows); `overrideServiceWindow` and `assessParcelHandling` wait for the slices that own them; the three evidence operations are in this slice (five criteria need them). Evidence is not one of the 17 permission domains, so a folder for it would be an eighteenth: place its code in `platform/` behind a port with the object-store adapter in the composition root, unless you decide otherwise. **Also yours:** the object-store product and its local stand-in (a development emulator in `infrastructure/` that the developer starts, as PostgreSQL is, or an in-process stand-in), and the malicious-content check; neither is chosen in any document, and a new tool or dependency is a stop condition, not an agent's choice.

### D-10. The recipient-channel bar and the heads-up SMS

**Decided 29 October 2026: a release gate; the provider is Hubtel under the sender ID `Melarc`; real messages are proved in a controlled local window; the heads-up SMS is built and its confirmed value stays On.**

*Findings F-11, F-26.* Rule either that the bar of `recipient-channel.md` (`OQ-048`, `OQ-028`, `OQ-109`) is a **release gate** for this slice, as SLICE-000 treated provider inputs (gate G3), with a capture adapter in development and staging; or that SLICE-001 cannot be READY until the three resolve. And say whether the recipient heads-up SMS at itemization close is in this slice. **Recommendation:** release gate; the heads-up SMS is out of scope, because no criterion covers it, and its kill switch stays on its confirmed value, unused.

### D-11. Notifications, the outbox, the scheduler and what "notified" means

**Decided 29 October 2026: the full notification service now, as the mechanism and its monitoring and not SLICE-010's administration; texts go to the ad-hoc sender, to the vendor's registered number for the handshake fallback and to the rider on dispatch and reassignment.**

*Findings F-10, F-25, F-26, F-27.* Authorize a bounded mechanism inside the slice: outbox rows written in the business transaction, a worker lane that only captures (no provider), the notification types of F-25, a linkless message kind for the handshake SMS, and the backstop as a scheduled lane of the existing worker process with its own capability (no new process, no broker). For the Rider, "notified" means the run appears in the Rider's list when the app is next opened, unless you choose a push (`OQ-117`). **Unblocks:** S1.12, S1.28 and every task that notifies.

### D-12. Credit reservation

**Decided 29 October 2026: no credit reservation; the commercial gate is bounded to the two outcomes named.**

*Finding F-30.* Bound the commercial gate to `NO_VENDOR_CHARGE` and `PAYMENT_REQUIRED`; the vendor fixture is allowance-disabled, no criterion needs `CREDIT_RESERVED`, and the ledger is SLICE-007's. `CREDIT_RESERVED` stays unbuilt. Or supply the `OQ-005` artifact. **Unblocks:** S1.37.

### D-13. Values

**Decided 29 October 2026: Accra & Tema GH₵35 flat Monday to Saturday; Amasaman & Environs and Kasoa Corridor GH₵35 on Friday only; the corridor off-day fee is GH₵70 for Amasaman & Environs and GH₵80 for Kasoa Corridor (one value per corridor). The lock idle time is 15 minutes and the evidence limits are 10 MB and JPEG, PNG or PDF, as development values: the launch values stay the owner's.**

*Findings F-01, F-28; section 5.7.* The development value of `intake_lock_idle_ttl_minutes` for AC-43 (the launch value is yours); a development ceiling and MIME list for evidence uploads; Amasaman & Environs' batch days. **Pricing, from your message of 28 October.** You said the GH₵35 applies to the dedicated zones on Fridays and is higher on other days. [settings.md](../../contracts/settings.md) lines 121 and 122 already hold that for the two corridors (GH₵35 on the batch day, Friday only; GH₵70 off it) and hold Accra & Tema at GH₵35 Monday to Saturday. Please confirm: (a) Accra & Tema stays GH₵35 Monday to Saturday; (b) Amasaman & Environs is Friday only, with no Tuesday batch day; (c) the corridor off-day fee is GH₵70. Until you do, the plan reads settings.md.

### D-14. Records from other slices, and the slice's grants

**Decided 29 October 2026: fixtures and grant migrations authorized; every Ops Staff member holds `pickup.exception.approve` through the bundle, with the approving actor audited.**

*Findings F-19, F-23, F-24.* Authorize non-production fixtures in the manner of [MIGRATION_AND_SEEDING.md](../../architecture/MIGRATION_AND_SEEDING.md) §4a and §4b: vendor saved locations, an allowance state (disabled), a registered phone, a standing (changed by the test kit, never by hand), ad-hoc senders; a motorcycle, its assignment and a breakdown for a rider. The production paths stay SLICE-008, -011 and -009. Also authorize the forward migrations that grant the slice's keys to the Ops Staff, Senior Ops, Platform Admin, Vendor and Rider bundles, the Vendor and Rider through the fixed-policy release procedure; and say how `pickup.exception.approve` reaches "an Ops Staff member explicitly granted it" (a bundle, since per-user grants are open under `OQ-047`). Also say whether the Rider holds `pickup.collection.confirm` for every stop (the contract and the feature use it for `recordCollection`, `initiateHandshake` and `requestSmsHandshakeFallback`) or only for the ad-hoc code-entry path (the catalogue, permissions.md line 135), and which key lets an Ops Staff receiver attach evidence (F-15).


## 8. What can start without a decision

**Nothing of the product.** The first task of the plan (S1.1, the reconciliation of the specifications) needs D-01 and D-08. Independent of every decision, and harmless to wait on: the owner's open SLICE-000 items ([§1.2](SLICE-000-IMPLEMENTATION-PLAN.md#12-current-position)).

## 9. What this check leaves open

- The reviewers' reports are used where checked; a statement of theirs not carried into section 5 was not verified and is not relied on.
- The independent review of this document did not check D-01 to D-14 except D-04 and D-07, F-31 beyond the metric names, F-33, F-36 beyond two components, or the qualitative claims of F-38, and it skim-checked section 6 rows 06, 09, 32, 36, 38 to 40, 44, 45, 51, 52, 66, 75 and 77 to 80 against the contract.
- The client surfaces were assessed for completeness, not for the correctness of their design.
- The master specification was not read end to end; F-01 lists only the contradictions found by searching for the decisions the features cite. Others may exist.
- No criterion is claimed ready beyond the reading in section 6, which is mine and is open to correction.
