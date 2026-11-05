# Melarc Product Design Direction

> **Status:** APPROVED DIRECTION — recorded from the Product Owner's directions of 1 and 5 November 2026. It is direction, not implemented behavior and not verified acceptance (§9)  
> **Version:** 1.0  
> **Date:** 1 November 2026; revised 5 November 2026 (§2a, §3, §4, §6, §6a, §7, §8, §9), and again that day with redesign step R2 (§6a, §7, §9)  
> **Repository path:** `design/PRODUCT_DESIGN_DIRECTION.md`  
> **Depends on:** [BRAND_FOUNDATION.md](BRAND_FOUNDATION.md), [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md), [COMPONENT_PATTERNS.md](COMPONENT_PATTERNS.md)  
> **Owns:** the intended Melarc experience, who the Ops Portal is designed for first, the map of which source owns which design decision, what each inspiration source is consulted for, the direction of the four page templates, and how a significant design proposal is raised  
> **Does not own:** brand ([BRAND_FOUNDATION](BRAND_FOUNDATION.md)); tokens, density, accessibility and the web library policy ([DESIGN_SYSTEM](DESIGN_SYSTEM.md)); reusable presentation and interaction patterns ([COMPONENT_PATTERNS](COMPONENT_PATTERNS.md)); screens, workflows, business rules and acceptance criteria ([surfaces](../surfaces/overview.md), [features](../features/README.md), [contracts](../contracts/CLAUDE.md)); technical architecture and engineering standards ([architecture](../architecture/SOLUTION_ARCHITECTURE.md), [standards](../standards/engineering-standards.md))

---

## 1. Purpose

A new agent should be able to read this page and know what Melarc is meant to feel like, which document decides what, where to look for ideas on a given problem, which foundations to leave alone, and when to ask the Product Owner.

It points to the owning documents and repeats none of their rules. It adds no component API, dimension, endpoint or business rule, and it is not a wireframe: a screen still needs its own design and its own specification.

---

## 2. The intended experience

Melarc should read as a serious, modern logistics system with a disciplined, dependable feel ([BRAND_FOUNDATION §3](BRAND_FOUNDATION.md#3-brand-idea)). In the Ops Portal that means:

- **Work first.** A screen answers what needs attention, what happened and what to do next before it shows anything decorative. Status, blocker and next action are visible without hunting.
- **Calm and precise.** Restraint communicates quality: disciplined alignment, restrained color, exact copy ([DESIGN_SYSTEM §2.2](DESIGN_SYSTEM.md#22-restraint-communicates-quality)).
- **Density follows the task.** The shell and page composition are spacious; forms are balanced; queues and tables are efficient ([DESIGN_SYSTEM §10](DESIGN_SYSTEM.md#10-density-system)).
- **Honest about the server.** A screen shows what the server decided and never computes or implies an authoritative result ([surfaces/overview.md §5](../surfaces/overview.md#5-cross-surface-rules)). Every screen owes the nine interface states ([surfaces/overview.md §4](../surfaces/overview.md#4-the-nine-interface-states)).
- **Its own look.** Not generic SaaS, and not a copy of a third-party product or component library ([BRAND_FOUNDATION §3.2](BRAND_FOUNDATION.md#32-desired-impression), [§14](BRAND_FOUNDATION.md#14-ui-technology-neutrality)).

---

## 2a. Who it is designed for first

**Product Owner, 5 November 2026.** The priority roles for Version 1 are the hub officers (Ops Staff), Senior Ops and Platform Admin. Hub officers use the portal most hours of the day, so every screen is designed for them first, and the hub-floor tasks are designed for a tablet ([DESIGN_SYSTEM §12](DESIGN_SYSTEM.md#12-responsive-model)).

- **Senior Ops** decides exceptions, and also does officer work on busy days.
- **Platform Admin** administers the company, and works the floor on busy days. Their keys and reach are the catalogue's ([permissions.md](../contracts/permissions.md)); this direction adds none. How the portal presents that reach (browsing all hubs while acting in one, and the maker-checker exception) is [the Ops surface's](../surfaces/ops-portal.md#4-navigation-model).
- Roles are administrative bundles. A screen is not drawn for a role name: what a person is offered follows the permissions their session holds ([DESIGN_SYSTEM §22](DESIGN_SYSTEM.md#22-navigation)).

---

## 3. Which source owns what

| Decision | Owner |
|---|---|
| Brand: character, logo, color and type direction, voice, imagery | [BRAND_FOUNDATION](BRAND_FOUNDATION.md) |
| Tokens, density, accessibility, responsive behavior, state presentation, and the web library policy | [DESIGN_SYSTEM](DESIGN_SYSTEM.md) |
| Reusable presentation and interaction patterns: anatomy, variants, states, usage (what is built or being built, and the planned kit as PROPOSED) | [COMPONENT_PATTERNS](COMPONENT_PATTERNS.md) |
| Experience direction, who the portal is designed for first, inspiration mapping, page-template direction, how a significant proposal is raised | this document |
| The finished Overview's composition, authorization and refresh requirements, and delivery approach (reference only, §6a) | [OVERVIEW_DASHBOARD_DESIGN](OVERVIEW_DASHBOARD_DESIGN.md); the section authorization is the [Ops surface](../surfaces/ops-portal.md#the-overview-section-authorization-and-destinations)'s |
| Which screens exist, navigation, permissions per screen, interface states | [surfaces](../surfaces/overview.md) |
| Workflow behavior, business rules, acceptance criteria | [features](../features/README.md) |
| Entities, states, permissions, errors, operations | [contracts](../contracts/CLAUDE.md) |
| Technical architecture, security, engineering standards, how work is done | [architecture](../architecture/SOLUTION_ARCHITECTURE.md), [standards](../standards/engineering-standards.md), [execution plan](../delivery/DEVELOPMENT_EXECUTION_PLAN.md) |
| The sequence of the redesign steps | [implementation plan](../delivery/IMPLEMENTATION_PLAN.md#3a-the-ops-portal-redesign) |

Each rule has one owner. When two sources disagree, the owner wins and the other is corrected in the same change; a disagreement the owners' text does not settle is surfaced to the Product Owner ([execution plan §2](../delivery/DEVELOPMENT_EXECUTION_PLAN.md#2-source-of-truth)).

---

## 4. Foundations to preserve

- **Brand.** Professional, trustworthy, modern and premium; Crimson + Ink, with Ink carrying the work and crimson the brand ([BRAND_FOUNDATION §5.5](BRAND_FOUNDATION.md#55-color-usage-principle)); Inter, with a monospaced face for operational codes; balanced density; a light and a dark theme ([BRAND_FOUNDATION §2.1](BRAND_FOUNDATION.md#21-approved), values in [DESIGN_SYSTEM](DESIGN_SYSTEM.md#36-current-design-system-decision-summary)).
- **Web components.** Native elements where they satisfy the interaction. shadcn/ui (Radix UI under Tailwind CSS), on the R2 tokens, for complex behavior no native element gives, behind Melarc's own UI components: its components are source in the repository, restyled to Melarc's tokens, so the look stays Melarc's own and the behavior is Radix's, and each comes from the official shadcn registry ([DESIGN_SYSTEM §29](DESIGN_SYSTEM.md#292-the-component-foundation)). React Aria Components stays for what is built on it until it is phased out ([COMPONENT_PATTERNS §37](COMPONENT_PATTERNS.md#phasing-out-react-aria-components)). TanStack Table (headless, for the queue data model) is adopted, behind a Melarc component; Motion (animation) is approved in principle and is not adopted. The existing semantic tokens control appearance. No project-wide migration to Ant Design, MUI or another UI framework. Advanced grid behavior is not built by hand: it comes from TanStack Table or, if that cannot serve a screen, from a specialist grid weighed against that screen's requirements first. The policy is [DESIGN_SYSTEM §24a](DESIGN_SYSTEM.md#24a-interaction-primitives), [§23](DESIGN_SYSTEM.md#23-tables-and-dense-operational-data) and [§29](DESIGN_SYSTEM.md#292-the-component-foundation); it is a web policy and does not prescribe Android libraries.
- **Platform-aware, not identical.** Web and Android share semantic foundations, not components ([DESIGN_SYSTEM §1](DESIGN_SYSTEM.md#1-purpose), [§30](DESIGN_SYSTEM.md#30-android-mapping)).

Changing any of these is a foundation change and needs a product decision (§7).

---

## 5. Where to draw inspiration

**These references inform design; Melarc's requirements and contracts govern implementation.** Adapt a principle and make it Melarc's, in Melarc's tokens and components. Do not infer a product's private backend architecture from its interface, and do not treat another system's behavior as an approved Melarc business rule.

| Reference | Consult it for | Starting points |
|---|---|---|
| Linear | hierarchy, navigation, density, list/detail interaction | [Behind the latest design refresh](https://linear.app/now/behind-the-latest-design-refresh), [Custom views](https://linear.app/docs/custom-views) |
| Onfleet | dispatch and logistics workflow comparisons | [Dispatcher help](https://support.onfleet.com/hc/en-us/categories/360001490311-Dispatcher) |
| Stripe's public documentation | reliability and API-behavior comparisons | [Idempotent requests](https://docs.stripe.com/api/idempotent_requests), [Webhooks](https://docs.stripe.com/webhooks) |
| Fleetbase | investigating specific logistics implementation approaches | [fleetbase/fleetops](https://github.com/fleetbase/fleetops) |

Start from the problem, then check Melarc's own sources:

- **A list, its filters or views, how list and detail relate, how dense it is:** Linear, then [COMPONENT_PATTERNS §22f](COMPONENT_PATTERNS.md#22f-queuetable) and [DESIGN_SYSTEM §10](DESIGN_SYSTEM.md#10-density-system).
- **How dispatch, runs, assignment or exceptions read to the people doing them:** Onfleet, then the feature and surface that own the workflow.
- **Retries, duplicate protection, notifications, how a failure is explained:** Stripe, then the `Idempotency-Key` rules in [the OpenAPI contract](../contracts/openapi.yaml), [COMPONENT_PATTERNS §33.2](COMPONENT_PATTERNS.md#332-retry-rejection-and-unknown-outcomes) and [BACKGROUND_JOBS_AND_EVENTS](../architecture/BACKGROUND_JOBS_AND_EVENTS.md).
- **A logistics concern we are unsure how to build:** Fleetbase, as an investigation. Adopting its code or a dependency is a technical-foundation proposal (§7).

A comparison may show a gap in a Melarc contract or feature. Closing it is a change by the owner of that contract or feature, not a design edit.

---

## 6. The four page templates

**Approved design direction (Product Owner, 5 November 2026), built by redesign steps R6 and R7 ([the plan](../delivery/IMPLEMENTATION_PLAN.md#3a-the-ops-portal-redesign)).** The four templates replace the four page patterns of 1 November (queues, booking and tasks, records, account and security). None is built as a template yet. The pickup queue was drawn to the former queue pattern ([COMPONENT_PATTERNS §22f](COMPONENT_PATTERNS.md#22f-queuetable) records what was built); the other Ops screens ([surfaces/ops-portal.md §7](../surfaces/ops-portal.md#7-page-inventory)) predate this direction, and none is claimed to follow a template. A template is recorded in COMPONENT_PATTERNS only when it is built ([DESIGN_SYSTEM §35](DESIGN_SYSTEM.md#35-relationship-to-component-patterns)).

A template shapes a page and adds no rule of its own: what a screen shows, offers and refuses is its feature's, its surface's and the server's. A count, a total or an estimate on a template is the server's; a screen never works one out, and a missing figure is never drawn as zero.

### 6.1 Queue workspace

Work to be done or watched.

- **Title and count.** The queue's name, and how many it holds where the server states a count.
- **View tabs with counts.** Named views of the one queue, each with its count where the server states one (for example Needs decision · Confirmed · Cancelled · All).
- **Filter bar with removable chips.** A short row of the choices this queue needs, none for their own sake. What is applied is visible as a chip, and each chip can be removed on its own.
- **Compact table.** The rows lead; headings, filters and chrome take only the space they need.
- **Selection and inline action.** Rows can be selected, and a bulk-action bar acts on the selection only where the operation is safe and atomic ([surfaces/ops-portal.md §10](../surfaces/ops-portal.md#10-what-this-surface-must-never-do)). The usual next act of a row is its inline primary action.
- **Side panel on open.** Opening a record from the queue shows it in a panel beside the list, with "Open full page". Filters, scroll and selection survive.
- **Freshness and place.** The screen makes clear how current its results are, and results do not shift under an officer who is working on them. When and how a queue refreshes is decided per screen, on the server's answer; this direction chooses no mechanism. Filters, order and place survive going into a record and coming back.
- *Reference:* Linear; Onfleet for dispatch queues.

### 6.2 Record

One thing and its history.

- **Header.** The record's code, its status, a stage tracker, the one primary action and a "more actions" menu. The top says where the record stands and what can be done next, or what stands in the way and why ([surfaces/ops-portal.md §10](../surfaces/ops-portal.md#10-what-this-surface-must-never-do)).
- **Body.** A main column for the work; a side column for facts, people and related records; an activity timeline. Facts are grouped by meaning and labeled, not listed in one run.
- **Acts.** An act the person cannot take is not drawn: hiding is presentation and never enforcement, and the server refuses what is not allowed. A refusal from the server is worded as §6.5 says. Rarer or heavier acts sit in the menu and do not compete with the primary action; destructive acts sit last in it and are always confirmed. Where the Platform Admin's maker-checker exception applies, the screen says so plainly ([surfaces/ops-portal.md §10](../surfaces/ops-portal.md#10-what-this-surface-must-never-do)).
- **Stale versions.** A stale or conflicting version shows as a banner with Reload.
- **People, accounts, devices and sessions** (the rules of the former account-and-security pattern, kept as rules of this template):
  - Administrative status is separate from credential and device readiness. Whether a person or account is active, suspended or awaiting approval is shown apart from whether a password, an authenticator or a device has been set up. Never one badge for both.
  - Readiness is told as facts, never as a credential. The existing rules that no screen shows a PIN, hash, key or recovery link stand ([apps/ops-web/CLAUDE.md](../apps/ops-web/CLAUDE.md)).
  - Acts are grouped by what they change (the account's status, its credentials, its devices) and, when refused, name the capability they need in plain words (§6.5).
- *Reference:* Linear for hierarchy and list/detail; Onfleet for task detail; for people, accounts and devices no single one, the rules being in [SECURITY_DESIGN](../architecture/SECURITY_DESIGN.md) and the authentication features.

### 6.3 Task form

Creating or completing a unit of work.

- **Sections** in the order the officer thinks of the task, and only what this task needs.
- **A field grid** sized to the content of each field.
- **A sticky summary** showing the server's estimate and the rules that apply, in the server's words and numbers (a cut-off, a window, a fee, a limit). A rule that changes a choice also sits beside the choice (§6.5).
- **A short review before submit:** what will be created or changed, and what the server decides. It is a review, not a second form.
- **Success** is a toast with "Open" and "Do another".
- *Reference:* Linear for hierarchy and density; Onfleet for task and booking workflow comparisons.

### 6.4 Builder

Putting a run together from a pool: the pickup run and the delivery run.

- **Two panes,** the pool and the run, with live totals of what has been chosen.
- **Refusals** are shown on the row they name.
- **Stale rows** are flagged and never dropped silently.
- *Reference:* none named yet; the manifest builder of S1.25 is the nearest built screen ([COMPONENT_PATTERNS §22g](COMPONENT_PATTERNS.md#22g-reorderlist)).

### 6.5 On-screen language

For every template. A label is one to three words. A rule that changes a choice sits beside the choice, in one line; a longer explanation sits behind an info control. The security copy rules of the sign-in, recovery and setup screens stand unchanged ([surfaces/ops-portal.md §7](../surfaces/ops-portal.md#7-page-inventory), [COMPONENT_PATTERNS §33](COMPONENT_PATTERNS.md#33-copy-rules-and-interface-states)).

**A refusal names the capability in plain words** (Product Owner, 5 November 2026): "An approver decides this", not `pickup.exception.approve` and not "Requires Senior Ops". It never shows a raw permission key or a role. The key may appear only in a tooltip or in a technical detail meant for support, and never as the message. This is the one rule for every refusal on every screen; the surface, the brand voice and the app's own rules link here and add no wording of their own.

---

## 6a. The Overview dashboard

**The authorization, refresh and progressive-delivery rules stand (1 November 2026); the look is superseded (Product Owner, 5 November 2026). Reference only: nothing is built, and no measure is defined.** The visual reference of 1 November is no longer the visual target: the Overview is drawn in the direction of this document and of [DESIGN_SYSTEM](DESIGN_SYSTEM.md). Its place in the shell is the Today group ([surfaces/ops-portal.md §4](../surfaces/ops-portal.md#4-navigation-model)), as a page of its own when Slice 012 builds it: `/` stays My work (Product Owner, 5 November 2026), and no route is added now. It is not a fifth template, and no screen is claimed to meet it. [OVERVIEW_DASHBOARD_DESIGN.md](OVERVIEW_DASHBOARD_DESIGN.md) is the brief: it owns the section intent, the delivery approach and what an owning domain must settle before it supplies a measure. [The visual reference](reference/MELARC_OVERVIEW_REFERENCE_2026-11-01.html) is a design proposal to open in a browser and not code; every figure, name, hub, date and destination in it is illustrative.

- **Standing:** that the Overview is one design composed from the permissions the session holds, each section its own authorized read ([Authorization and scope](OVERVIEW_DASHBOARD_DESIGN.md#authorization-and-scope)); its refresh requirements, which are automatic while visible, a manual refresh and honest per-section freshness, for the Overview only ([Freshness and updating](OVERVIEW_DASHBOARD_DESIGN.md#freshness-and-updating)).
- **Superseded:** the reference's look: its colors, type, density and component styling, and its shell. The shell is the redesign's.
- **Not decided here:** any formula, threshold, target, period option, refresh cadence or other parameter, endpoint, permission assignment or route. The owning feature, contract and surface settle each, and the brief says how.
- **Delivered progressively:** the reference is preserved now; each domain defines its measures in the reporting data dictionary as it is developed; a section is connected under its own bounded task once its definition, contract, permissions, destinations and states are ready; the final integration and acceptance are Slice 012's ([the brief](OVERVIEW_DASHBOARD_DESIGN.md#progressive-delivery)).

---

## 7. When a proposal needs a product decision

**Proceed without asking** for routine choices within the approved templates and patterns: layout and order inside a template, wording within the copy rules ([COMPONENT_PATTERNS §33](COMPONENT_PATTERNS.md#33-copy-rules-and-interface-states)), reusing tokens and components, choosing which reference to adapt, a component refinement that stays inside the foundations ([DESIGN_SYSTEM §34](DESIGN_SYSTEM.md#34-design-review-expectations)).

**Surface it before implementing** when a proposal would:

- change a business rule, state, permission, money rule, acceptance criterion or contract;
- change a technical foundation: a UI framework or component library, a data grid, a new dependency, how data is fetched or refreshed, or what the browser stores;
- change a brand or design-system foundation (color, typeface, spacing scale, density model, status semantics);
- conflict with a surface, feature or contract. The owner wins, and the conflict is reported;
- need a behavior change to achieve a presentation change. Split them.

State the proposal in the task's handoff ([runbook §8](../delivery/planning/BOOTSTRAP_B0_RUNBOOK.md#8-task-handoff-format)): what is proposed, the reference adapted, the significant alternatives and their tradeoffs, and the document that owns the decision. Implement only what is approved. A decision, once made, goes into the owning document. There is no register.

**Approved browser storage.** One thing, and no other: a person's choice of theme, `light` or `dark`, kept in the browser's local storage as a non-sensitive preference (Product Owner, 5 November 2026). Without it the portal follows the operating system's setting ([DESIGN_SYSTEM §31](DESIGN_SYSTEM.md#31-dark-mode)). It is read and written by the toggle that redesign step R4 builds, and step R2 builds neither. Nothing else is stored in the browser, and a session, a token, a credential or anything about a person is never stored there; the rule that application code uses no web storage ([apps/ops-web](../apps/ops-web/CLAUDE.md)) gets its one exception when the toggle is built.

---

## 8. Working rules for agents

1. Read the owning sources for the task (§3) before designing or changing a screen.
2. Reuse approved tokens, components and page templates. Add a component only when a screen needs it, and record it ([DESIGN_SYSTEM §28](DESIGN_SYSTEM.md#28-component-implementation-rules)).
3. When you adapt a reference, name the pattern, its source, and what you changed.
4. Keep presentation changes distinct from behavior changes: separate steps, and separate sections of the handoff. Never hide a behavior change in a restyle.
5. Put significant alternatives and tradeoffs in the existing task handoff.
6. Surface conflicts and proposed changes to business rules or technical foundations before implementing them (§7).
7. Proceed on routine choices within approved templates and patterns without asking again.

---

## 9. Status

- **Approved direction:** §2 to §8 of this document, including the redesign direction of 5 November 2026 (who the portal is designed for first, the four page templates), and the sources it links.
- **Reference only:** the Overview dashboard (§6a). Its authorization principles, refresh requirements and delivery approach are approved direction and its look is superseded; it is not implemented, its measures are not defined, and its permission assignments and refresh parameters are open.
- **Implemented:** the foundations and the components recorded in [COMPONENT_PATTERNS §40](COMPONENT_PATTERNS.md#40-current-pattern-summary), and what the pickup queue was drawn to before the redesign (focused results, compact filters, the refresh with the time of the page's last check, and the return to the place: [§22f](COMPONENT_PATTERNS.md#22f-queuetable)). **The templates are not built, and only the foundations of the redesign are.** Step R1 recorded the direction and step R2 built the tokens: the palette, the light and the dark theme (switched by the system setting; the toggle is step R4's), the type, the radii, the heights, the one shadow and the motion. Step R3 built the library foundation: Tailwind CSS and the shadcn/ui primitives on the tokens, drawn in the development showcase and used by no screen; it awaits the Product Owner's acceptance. The shell (but for the white lockup that the frame's banner now draws on a dark ground), the component kit, the templates and the screens are as they were until steps R4 to R7. The four page templates are not implemented as templates: the pickup queue is one screen drawn to the former queue pattern, and its freshness and continuity are built for it alone, not for the other queues.
- **Verified:** nothing in this document is acceptance evidence. A screen is accepted by its criteria, its tests and the Product Owner. Known open items on current screens stay in the carried-forward notes of the plans (the rider screens: [plan §7.47](../delivery/planning/SLICE-000-IMPLEMENTATION-PLAN.md#747-carried-from-s053-to-s060-27-october-2026)), not here, and no screen is described here as finished.

---

**End of Melarc Product Design Direction v1.0**
