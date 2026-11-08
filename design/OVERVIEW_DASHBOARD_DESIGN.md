# Overview dashboard design and delivery direction

Version: 1.1 · 1 November 2026

Status: Product Owner accepted the visual direction, the progressive delivery approach, the authorization and scope direction, and the refresh and freshness requirements. Reference only: production implementation, measure definitions, permission assignments and the parameters named under Freshness and updating are not complete.

## Purpose and authority

This document preserves the finished-product Overview direction accepted by the Product Owner in the design conversation of 1 November 2026. It gives future feature agents a shared destination without authorizing dashboard implementation as part of unrelated work.

Visual reference: [MELARC_OVERVIEW_REFERENCE_2026-11-01.html](reference/MELARC_OVERVIEW_REFERENCE_2026-11-01.html). Open the downloaded HTML in a browser and explore the hub scope, scenario and analytics selectors. All values, dates, hub examples, names, status distributions and destination previews are illustrative.

The reference owns the accepted content hierarchy and visual composition. This document owns the dashboard delivery direction and the obligations a domain must settle before supplying dashboard measures. Neither overrides business rules, security, contracts or the design system.

Read with these repository authorities:

- `PROJECT_MASTER_SPECIFICATION.md` §§10.2, 17, 32 and 43.4.
- `surfaces/ops-portal.md` and `surfaces/overview.md`.
- `architecture/SECURITY_DESIGN.md` §13.3 (session expiry) and §14.1a (the grant that authorizes an operation).
- `features/operations/hub-daily-operating-cycle.md`.
- `features/operations/exception-ownership-matrix.md`; the permission catalogue wins if its entries disagree.
- `features/reporting/daily-operations-and-cash-report.md`; a dated cash/operations report is distinct from the live Overview.
- `design/PRODUCT_DESIGN_DIRECTION.md`, `design/BRAND_FOUNDATION.md`, `design/DESIGN_SYSTEM.md` and `design/COMPONENT_PATTERNS.md`.
- The current owning feature documents, `contracts/openapi.yaml`, permissions, data scopes, domain model, states, settings and audit contracts.

Later authoritative feature/contract rules remain controlling under the Master Specification's reconciliation policy. Resolve genuine conflicts explicitly; do not derive product rules from sample UI values.

Who owns what: this brief owns the composition, the visual direction, the refresh requirements and the delivery strategy. The section authorization matrix, the scope presentation and the destinations are the Ops surface's ([surfaces/ops-portal.md](../surfaces/ops-portal.md#the-overview-section-authorization-and-destinations)). Permission keys, grants, scopes, tiers and bundle assignments are the permission catalogue's ([contracts/permissions.md](../contracts/permissions.md)). Each measure's canonical definition is the reporting data dictionary's, and the business rules beneath it stay in the owning domain's feature. Sequencing and final integration are the delivery plan's ([IMPLEMENTATION_PLAN.md](../delivery/IMPLEMENTATION_PLAN.md#3-sequence)).

## Accepted direction

Design for the finished Version 1 product, including domains that are not implemented yet. Do not reduce the intended Overview to today's endpoints or features.

The Overview answers: what needs attention; where work is waiting or blocked; how today's operation is progressing; and whether custody, money and execution readiness are controlled.

Keep the existing production sidebar and application shell. The prototype's shell, logo approximation, menu labels, account and destination dialogs provide presentation context. They do not authorize replacing navigation, changing routes or adding permissions. Use the real logo, tokens and existing components when implementing.

Continue the accepted pickup queue's restrained Crimson + Ink styling, Inter direction, balanced density, white workspaces, fine dividers and precise hierarchy. Responsive composition may reflow; screenshot coordinates, mockup CSS, font sizing and thresholds are not production tokens or acceptance criteria. The prototype does not authorize a dark-theme initiative.

### Composition

1. Header: Overview, authorized hub scope, business-date context, freshness and refresh entry point, with a small relevant action group.
2. Four concise summary measures.
3. Needs attention beside Today's operations.
4. Money & reconciliation beside People & fleet.
5. Hub comparison for explicitly authorized all-hub audiences.
6. Performance analytics below the working area.

At narrower widths, stack sections in that reading order and keep all information and actions usable. Preserve keyboard access, visible focus, labels and meaningful announcements. Production implementation owes proper loading, empty, partial failure, retry, stale and permission-restricted states; this reference is not a complete state specification or accessibility certification.

## Section intent

| Section | Intended information | Domain work still required |
|---|---|---|
| Pickups scheduled today | Scheduled requests; outstanding and completed pickup work distinguished | Request membership, scheduled-date basis, cancellations, replacements, partial collection and completion meaning |
| Deliveries due today | Parcels with an applicable delivery commitment today | Commitment inclusion, revision history, service-mode applicability and treatment of carryover |
| Successful service outcomes | Successful outcomes recorded today, separated by service mode | Exact events, entity deduplication, reversals/corrections and distinction from exceptional terminal outcomes |
| Open exceptions | Distinct unresolved exception cases, including carryover | Case identity, lifecycle, membership and deduplication across categories |
| Needs attention | Actionable categories with count, age, accountable function and destination | Eligible states, owner mapping, ageing basis, priority ordering and escalation/threshold rules |
| Today's operations | Pickup, hub, dispatch, delivery, returns and external follow-up | Exact populations, units and permitted detail destinations |
| Money & reconciliation | Outstanding obligations, rider/hub cash, variances and permitted vendor exposure | Ledger reconciliation, amount/date basis, overlapping balances, authorization and financial projection contracts |
| People & fleet | Rider availability, motorcycle readiness, restrictions and upcoming maintenance | Existing availability rules, assignment constraints, compliance triggers and maintenance decisions |
| Hub comparison | Comparable measures across explicitly authorized hubs | Correct aggregation, hub attribution and no double counting |
| Performance in context | Parcel movement over time and service-mode outcome breakdown | Period boundaries, event/cohort basis, zero denominators, aggregation and report reconciliation |

The four top measures and their wording are design candidates within the accepted layout. They require semantic confirmation and exact definitions before implementation. No formula, threshold, percentage, chart scale, period selector option, KPI target or refresh interval is approved solely by appearing in the reference.

## Authorization and scope

Approved product direction (1 November 2026). The section-by-section mapping, the scope presentation and the destinations are in [the Ops surface](../surfaces/ops-portal.md#the-overview-section-authorization-and-destinations); the permission catalogue stays the only authority for keys, grants, scopes, tiers and bundle assignments, and this brief adds none.

- One shared Overview, composed for the signed-in person from the permissions their session holds. Roles are administrative bundles: authorization is a held permission, the scope of the particular grant exercised, the authority tier and any workflow restriction, and nothing compares a role name.
- Sidebar entries, sections, actions and drill-down destinations each follow their own requirement. Session hints guide presentation; the backend enforces every read and every action.
- Unauthorized information is never returned merely to be hidden in the browser: not a record, a count, an aggregate, a financial figure, a comparison, or a total that reveals one.
- All-hub authority belongs to the one grant exercised and never widens an unrelated permission. Choosing "All hubs" creates no access. A section whose authorized scope is narrower than the selection says what it covers or is unavailable, and sections of different scope are never presented as sharing one total or comparison.
- A summary read authorizes neither a detail destination nor an action, and access to a detail page authorizes no aggregate.
- `report.read` does not gate the Overview as a whole: it authorizes only the report projections its owning specification covers, within the scope of the grant. A domain read permission is not taken as summary access either: extending one to defined summaries is a proposal, assessed domain by domain. Each assignment is confirmed in the matrix by an approved source or stays visibly proposed or unresolved.
- Protected financial information keeps the read permissions it independently requires, and every financial act or approval keeps its own permission, tier, scope and workflow restrictions. Finance's existing approved actions and approvals are unchanged. The Executive and Auditor assignments marked `PROPOSED` in the catalogue stay proposed here.

## Non-negotiable meaning and safety

- Requests, parcels, stops, runs and cases are different units. Label them explicitly and never sum them as one throughput measure.
- Stage summaries are not a conversion funnel; their populations and units may differ.
- Outstanding previous-day work remains visible until resolved. A date change must not hide unresolved cash, custody, returns or commitments.
- Attention categories may overlap. Do not sum them into a case total without a defined deduplication rule.
- Doorstep delivery, Station Drop verified handoff and completed Melarc-covered third-party delivery are different outcomes. A station handoff alone is not final completion for covered third-party service. Returns and exceptional terminal outcomes remain distinguishable from successful delivery.
- Operational closure and financial closure remain separate. Terminal parcels with unresolved money remain visible in appropriate financial projections.
- Collected cash, expected cash, earned fees, balances, exposure and profit are different measures. This reference introduces no revenue or profitability formula.
- Preserve blind-count confidentiality, including aggregate or detail projections that could expose protected rider-declared counts before the count commits.
- Use GHS and the canonical Africa/Accra business timezone. Define boundaries explicitly per metric.
- Use backend-authorized summaries derived from authoritative records. Do not count only loaded queue pages or fetch every record into the browser to manufacture totals.
- Every destination must preserve the selected authorized scope and relevant filters. Exact route names and operation mappings must come from the real surface and contract.
- A report aggregate does not imply permission to read its underlying operational records. Use an authorized report breakdown where record access is absent.
- Compose visibility from actual permissions and scope. The prototype assumes broad management permissions and is not a role/permission matrix. Finance, Executive, Auditor, Fleet Manager and Ops do not automatically see the same information ([Authorization and scope](#authorization-and-scope)).

## Progressive delivery

### Now: preserve the reference

Admit this document and the HTML to the repository. Add short discoverable links in existing authoritative entry points. Do not build a disconnected production dashboard with fabricated figures. Do not add a runtime route, dependency, endpoint, timer, storage mechanism or dashboard authorization rule as part of reference admission.

### As each owning domain is developed

Read this brief to understand future dashboard needs. Identify the measures that domain can authoritatively provide, and define each in the reporting data dictionary before it is contracted or built ([Where a measure is defined](#where-a-measure-is-defined)). Definitions may be admitted one measure at a time, whenever the owning domain is ready, well before Slice 012. Surface unresolved product decisions rather than guessing.

Domain work never waits for the Overview. Define and verify the relevant summary contract within a bounded, approved domain or dashboard task, and connect a dashboard section under its own bounded task once its definitions, operation, permission and scope ([the matrix](../surfaces/ops-portal.md#the-overview-section-authorization-and-destinations)), destinations and interface states are ready. Domain implementation does not authorize expanding that task to build its dashboard section unless the owner names it.

Do not weaken a domain or prematurely add speculative endpoints just to match the mockup. If a dependency is not ready, keep it explicitly pending in the existing plan. Never expose sample data as a live production result or present missing data as zero.

### Final integration: Slice 012

The final cross-domain integration and acceptance of the Overview belong to the reporting and dashboards slice, SLICE-012 ([the plan](../delivery/IMPLEMENTATION_PLAN.md#3-sequence)). Two sets of prerequisites are kept apart. Starting reporting and dashboard work needs what the plan lists for the slice, and it does not wait for every domain. Final integrated acceptance needs more: the slice that owns every section it includes, with each section's approved metric definitions and authorization requirements. The slice integrates and validates the sections whose measures their owning domains have defined and delivered. It verifies totals, timing, carryover, mode-specific outcomes, financial reconciliation, hub attribution, permissions and scope, drill-downs, freshness and partial-failure behavior, responsive behavior and interface states. A section whose domain is not built stays visibly pending and is not accepted. The Overview is not the next build, and it is not postponed in full to that slice: sections are connected progressively, and the whole is accepted there.

## Where a measure is defined

Each measure has one canonical definition: an entry in the reporting data dictionary that Master Specification §32.5 requires and `OQ-049` still owes. The entry references the owning feature's business rules instead of restating them, and the contract operation that serves it. The dictionary is [features/reporting/reporting-data-dictionary.md](../features/reporting/reporting-data-dictionary.md), created on 2 November 2026 with the three pickup lateness measures, the first admitted ([the implementation plan](../delivery/IMPLEMENTATION_PLAN.md#3-sequence) records why it lives there); the other measures are admitted by the domains that supply them. This brief holds no formula and creates no second source of truth or register of decisions. An entry records, before the measure is implemented:

1. Stable measure name, purpose, unit and owning domain.
2. Source entities/events and exact inclusion/exclusion states.
3. Formula; deduplication key; distinct cases versus affected records; aggregation rules.
4. Event-date, scheduled-date, commitment-date or as-of basis; Africa/Accra boundaries; revisions and carryover.
5. Age origin, ageing buckets, targets and thresholds, if any.
6. Money meaning, currency, rounding and reconciliation to the authoritative ledger, if applicable.
7. The permission, hub scope, authorized aggregation and masking, as the Ops surface matrix states them for its section.
8. The measure's as-of basis and latency expectation, and how they are told apart from the browser's last successful check ([Freshness and updating](#freshness-and-updating)).
9. Contract operation/schema, runtime validation and error/partial-failure behavior.
10. Drill-down route/report, matching filters and destination permission.
11. Acceptance examples, including empty populations, carryover, boundary dates, duplication and authorization.

Resolve the meaning early enough to avoid incompatible data capture. Finalize exact formulas with the domain before building the measure.

## Freshness and updating

Approved product requirements (1 November 2026), for the Overview only. Master Specification §10.2 and §32.2 call the dashboard live and require every tile to identify its freshness; this section is how the Overview does both. The accepted pickup queue keeps its own refresh behavior ([COMPONENT_PATTERNS §22f](COMPONENT_PATTERNS.md#22f-queuetable)), and nothing here changes it.

**Approved requirements**

- The finished Overview updates automatically while it is visible, offers a manual refresh, and says honestly how fresh each figure is.
- Automatic reads pause while the page is hidden. When it is visible again, information that has gone stale is refreshed. Duplicate refresh requests are combined. Focus, scroll position and selections survive a refresh.
- A failed refresh never advances a freshness timestamp. Two times are kept apart: when the browser last successfully checked, and the calculation or as-of time of the data itself.
- A partial refresh never implies that every section is current. Freshness is told per section, or by another explicitly defined approach that represents partial success exactly.
- After a recoverable transport or service failure, information already shown may stay, with clear stale and error treatment, but only while the same session and authorization context remain valid. This is an Overview-only exception to `ReadState`, which draws no earlier data beside a failed refresh ([COMPONENT_PATTERNS §33.3](COMPONENT_PATTERNS.md#333-reading-the-api-readstate-and-the-problem-copy)); it is recorded in the patterns when the Overview's section state is built.
- When the session ends, authority is revoked or an authorization is refused, the affected protected information is removed under the existing security policy. Stale-data handling never overrides it.
- When the hub selection, a filter or a period changes, old results are never presented as belonging to the new selection. Requests, cached results and response handling respect session, authority, scope and filter boundaries, and an obsolete response never repopulates the current view.
- Automatic reads are background activity: they never extend an unattended session's idle lifetime, and the server's idle expiry, absolute expiry and authority-revocation boundaries are unchanged. A visible but unattended Overview can expire. No keep-alive is introduced, and a browser's claim of human activity is never authority to extend a session.

**Confirmed existing behavior.** A route states on the server whether a request counts as the person acting: `qualifying` extends the idle lifetime and `background` never does. There is no default, and nothing the client sends decides it (decision A of 12 October 2026, [SLICE-000 plan §7.18](../delivery/planning/SLICE-000-IMPLEMENTATION-PLAN.md#718-the-gate-3-completion-batch-12-october-2026); built as `ActivityPolicy` in `apps/api/src/platform/routes/access-declaration.ts`). `getCurrentSession` is `background`; every other authenticated read built so far is `qualifying`, the pickup queue's list included, so a press of that queue's Refresh counts as activity. The idle and absolute limits are [SECURITY_DESIGN §13.3](../architecture/SECURITY_DESIGN.md#133-idle-and-absolute-expiry), which does not yet state the activity policy.

**Pending.** Two things, and nothing else about activity. First, how a manual refresh is classified: no authoritative policy settles it for the Overview (the pickup queue's Refresh counts as activity only because its list route is `qualifying`, and that queue does not poll). Second, the endpoint design and whether it fits the server-controlled activity policy. That the Overview's automatic reads are `background` is not pending; it is the approved requirement above. The policy belongs to the route and a browser's claim is never trusted, so if the automatic and the manual refresh share one operation, the design must keep the automatic reads `background` and must not rely on a client assertion of human activity, and a manual refresh that is to count as activity needs a server-side basis other than the client's claim. Both are decided with the first dashboard read operation, and until then nothing treats a refresh as proof of a person.

**Proposals and open parameters (not approved)**

- Refreshing the operational sections about every 30 seconds while visible is a proposed starting point, subject to query cost and operational need.
- Periodic reads are the preferred first approach; push updates are not required.
- To define before implementation: the analytics cadence, freshness targets per measure, retry and backoff behavior, and whether sections share a snapshot or are read independently, as well as the two pending items above.

## Validation status and reference limitations

The conversation preview was accepted visually by the Product Owner. Script logic was checked for initial rendering, scenario/scope/period changes, preview destinations and refresh interactions using a lightweight DOM harness. A real browser render was not independently verified in the creation environment because the browser executable was unavailable. No production browser matrix, screen-reader validation or API integration is claimed.

Sample figures are illustrative and not a mutually reconciled dataset across every panel. Scenario, scope and period switches demonstrate composition. They are not backend behavior, operational guarantees, actual hub configuration or reporting formulas. Destination dialogs are review aids and are not a proposed production navigation pattern. The preview's Refresh control only changes a sample timestamp and approves no mechanism, and its runtime wrapper keeps display state in the browser's local storage and loads an icon library from a public CDN when opened online: it is a design aid, and the application uses neither.

## Agent instruction

Preserve this destination during feature work. Do not infer new business rules from the preview. Do not silently downgrade the design to current implementation. Do not mark the Overview built or verified because this reference exists. Report material design/contract conflicts and update the correct owning source when an approved decision is made. Approving a direction here adds no permission, endpoint, timer, cache or storage: each arrives with the bounded task that builds it.
