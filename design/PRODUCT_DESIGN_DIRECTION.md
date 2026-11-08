# Melarc Product Design Direction

> **Status:** APPROVED DIRECTION — recorded from the Product Owner's direction of 1 November 2026. It is direction, not implemented behavior and not verified acceptance (§9)  
> **Version:** 1.0  
> **Date:** 1 November 2026  
> **Repository path:** `design/PRODUCT_DESIGN_DIRECTION.md`  
> **Depends on:** [BRAND_FOUNDATION.md](BRAND_FOUNDATION.md), [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md), [COMPONENT_PATTERNS.md](COMPONENT_PATTERNS.md)  
> **Owns:** the intended Melarc experience, the map of which source owns which design decision, what each inspiration source is consulted for, the direction of the four page patterns, and how a significant design proposal is raised  
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

## 3. Which source owns what

| Decision | Owner |
|---|---|
| Brand: character, logo, color and type direction, voice, imagery | [BRAND_FOUNDATION](BRAND_FOUNDATION.md) |
| Tokens, density, accessibility, responsive behavior, state presentation, and the web library policy | [DESIGN_SYSTEM](DESIGN_SYSTEM.md) |
| Reusable presentation and interaction patterns: anatomy, variants, states, usage (only what is built or being built) | [COMPONENT_PATTERNS](COMPONENT_PATTERNS.md) |
| Experience direction, inspiration mapping, page-pattern direction, how a significant proposal is raised | this document |
| The finished Overview's composition, authorization and refresh requirements, and delivery approach (reference only, §6a) | [OVERVIEW_DASHBOARD_DESIGN](OVERVIEW_DASHBOARD_DESIGN.md); the section authorization is the [Ops surface](../surfaces/ops-portal.md#the-overview-section-authorization-and-destinations)'s |
| Which screens exist, navigation, permissions per screen, interface states | [surfaces](../surfaces/overview.md) |
| Workflow behavior, business rules, acceptance criteria | [features](../features/README.md) |
| Entities, states, permissions, errors, operations | [contracts](../contracts/CLAUDE.md) |
| Technical architecture, security, engineering standards, how work is done | [architecture](../architecture/SOLUTION_ARCHITECTURE.md), [standards](../standards/engineering-standards.md), [execution plan](../delivery/DEVELOPMENT_EXECUTION_PLAN.md) |

Each rule has one owner. When two sources disagree, the owner wins and the other is corrected in the same change; a disagreement the owners' text does not settle is surfaced to the Product Owner ([execution plan §2](../delivery/DEVELOPMENT_EXECUTION_PLAN.md#2-source-of-truth)).

---

## 4. Foundations to preserve

- **Brand.** Professional, trustworthy, modern and premium; Crimson + Ink; Inter; balanced density ([BRAND_FOUNDATION §2.1](BRAND_FOUNDATION.md#21-approved), values in [DESIGN_SYSTEM](DESIGN_SYSTEM.md#36-current-design-system-decision-summary)).
- **Web components.** Native elements where they satisfy the interaction. React Aria Components for complex behavior no native element gives, behind Melarc's own UI components. The existing semantic tokens control appearance. No project-wide migration to Ant Design, MUI or another framework. A specialist grid is weighed against a concrete screen's requirements before advanced grid behavior is built by hand. The policy is [DESIGN_SYSTEM §24a](DESIGN_SYSTEM.md#24a-interaction-primitives) and [§23](DESIGN_SYSTEM.md#23-tables-and-dense-operational-data); it is a web policy and does not prescribe Android libraries.
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

## 6. The four page patterns

**Approved design direction, awaiting screen-specific design and implementation.** Only the pickup queue has been drawn to it so far, to all four points of §6.1: [COMPONENT_PATTERNS §22f](COMPONENT_PATTERNS.md#22f-queuetable) records what was built. The other Ops screens ([surfaces/ops-portal.md §7](../surfaces/ops-portal.md#7-page-inventory)) predate this direction and are not claimed to follow it. A pattern is recorded in COMPONENT_PATTERNS only when it is built ([DESIGN_SYSTEM §35](DESIGN_SYSTEM.md#35-relationship-to-component-patterns)).

### 6.1 Queues

Work to be done or watched.

- **Focused results.** The rows lead; headings, filters and chrome take only the space they need.
- **Compact filters.** A short row of the choices this queue needs, with what is applied visible; none for their own sake.
- **Deliberate freshness.** The screen makes clear how current its results are, and results do not shift under an officer who is working on them. When and how a queue refreshes is decided per screen, on the server's answer; this direction chooses no mechanism.
- **Working-context continuity.** Filters, order and place survive going into a record and coming back.
- *Reference:* Linear; Onfleet for dispatch queues.

### 6.2 Booking and tasks

Creating or completing a unit of work.

- **Relevant sections.** Show what this task needs, in the order an officer thinks of it, and leave the rest out.
- **Understandable policy information.** Where a rule shapes the choice (a cut-off, a window, a fee, a limit), say it in plain words beside the choice, using the server's words and numbers.
- **Concise review.** Before committing, one short summary of what will be created or changed and what the server decides. It is a review, not a second form.
- *Reference:* Linear for hierarchy and density; Onfleet for task and booking workflow comparisons.

### 6.3 Records

One thing and its history.

- **Immediate status and next action or blocker.** The top says where the record stands and what can be done next, or what stands in the way and why ([surfaces/ops-portal.md §10](../surfaces/ops-portal.md#10-what-this-surface-must-never-do)).
- **Grouped facts.** Facts are grouped by meaning and labeled, not listed in one run.
- **Secondary actions.** Rarer or heavier actions are available but do not compete with the next action.
- *Reference:* Linear for hierarchy and list/detail; Onfleet for task detail.

### 6.4 Account and security

People, accounts, devices and sessions.

- **Administrative status is separate from credential and device readiness.** Whether a person or account is active, suspended or awaiting approval is shown apart from whether a password, an authenticator or a device has been set up. Never one badge for both.
- **Readiness is told as facts, never as a credential.** The existing rules that no screen shows a PIN, hash, key or recovery link stand ([apps/ops-web/CLAUDE.md](../apps/ops-web/CLAUDE.md)).
- **Acts are grouped by what they change** (the account's status, its credentials, its devices) and name the permission they need when refused.
- *Reference:* no single one; the rules are in [SECURITY_DESIGN](../architecture/SECURITY_DESIGN.md) and the authentication features.

---

## 6a. The Overview dashboard

**Accepted visual direction, authorization and refresh requirements, and delivery approach (1 November 2026). Reference only: nothing is built, and no measure is defined.** It is not a fifth page pattern, and no screen is claimed to meet it. [OVERVIEW_DASHBOARD_DESIGN.md](OVERVIEW_DASHBOARD_DESIGN.md) is the brief: it owns the section intent, the delivery approach and what an owning domain must settle before it supplies a measure. [The visual reference](reference/MELARC_OVERVIEW_REFERENCE_2026-11-01.html) is a design proposal to open in a browser and not code; every figure, name, hub, date and destination in it is illustrative.

- **Accepted:** the content hierarchy and the visual composition, in the pickup queue's restrained presentation; that the Overview is one design composed from the permissions the session holds, each section its own authorized read ([Authorization and scope](OVERVIEW_DASHBOARD_DESIGN.md#authorization-and-scope)); and its refresh requirements, which are automatic while visible, a manual refresh and honest per-section freshness, for the Overview only ([Freshness and updating](OVERVIEW_DASHBOARD_DESIGN.md#freshness-and-updating)). The real sidebar, shell and logo stay; the prototype's are only context.
- **Not decided here:** any formula, threshold, target, period option, refresh cadence or other parameter, endpoint, permission assignment or route. The owning feature, contract and surface settle each, and the brief says how.
- **Delivered progressively:** the reference is preserved now; each domain defines its measures in the reporting data dictionary as it is developed; a section is connected under its own bounded task once its definition, contract, permissions, destinations and states are ready; the final integration and acceptance are Slice 012's ([the brief](OVERVIEW_DASHBOARD_DESIGN.md#progressive-delivery)).

---

## 7. When a proposal needs a product decision

**Proceed without asking** for routine choices within the approved patterns: layout and order inside a pattern, wording within the copy rules ([COMPONENT_PATTERNS §33](COMPONENT_PATTERNS.md#33-copy-rules-and-interface-states)), reusing tokens and components, choosing which reference to adapt, a component refinement that stays inside the foundations ([DESIGN_SYSTEM §34](DESIGN_SYSTEM.md#34-design-review-expectations)).

**Surface it before implementing** when a proposal would:

- change a business rule, state, permission, money rule, acceptance criterion or contract;
- change a technical foundation: a UI framework or component library, a data grid, a new dependency, how data is fetched or refreshed, or what the browser stores;
- change a brand or design-system foundation (color, typeface, spacing scale, density model, status semantics);
- conflict with a surface, feature or contract. The owner wins, and the conflict is reported;
- need a behavior change to achieve a presentation change. Split them.

State the proposal in the task's handoff ([runbook §8](../delivery/planning/BOOTSTRAP_B0_RUNBOOK.md#8-task-handoff-format)): what is proposed, the reference adapted, the significant alternatives and their tradeoffs, and the document that owns the decision. Implement only what is approved. A decision, once made, goes into the owning document. There is no register.

---

## 8. Working rules for agents

1. Read the owning sources for the task (§3) before designing or changing a screen.
2. Reuse approved tokens, components and page patterns. Add a component only when a screen needs it, and record it ([DESIGN_SYSTEM §28](DESIGN_SYSTEM.md#28-component-implementation-rules)).
3. When you adapt a reference, name the pattern, its source, and what you changed.
4. Keep presentation changes distinct from behavior changes: separate steps, and separate sections of the handoff. Never hide a behavior change in a restyle.
5. Put significant alternatives and tradeoffs in the existing task handoff.
6. Surface conflicts and proposed changes to business rules or technical foundations before implementing them (§7).
7. Proceed on routine choices within approved patterns without asking again.

---

## 9. Status

- **Approved direction:** §2 to §8 of this document, and the sources it links.
- **Reference only:** the Overview dashboard (§6a). Its visual direction, authorization principles and refresh requirements are approved direction; it is not implemented, its measures are not defined, and its permission assignments and refresh parameters are open.
- **Implemented:** the foundations and the components recorded in [COMPONENT_PATTERNS §40](COMPONENT_PATTERNS.md#40-current-pattern-summary), and the four points of §6.1 on the pickup queue ([§22f](COMPONENT_PATTERNS.md#22f-queuetable): its presentation, the refresh with the time of the page's last check, and the return to the place). The four page patterns are not implemented as patterns: that queue is one screen drawn to the first of them, and its freshness and continuity are built for it alone, not for the other queues.
- **Verified:** nothing in this document is acceptance evidence. A screen is accepted by its criteria, its tests and the Product Owner. Known open items on current screens stay in the carried-forward notes of the plans (the rider screens: [plan §7.47](../delivery/planning/SLICE-000-IMPLEMENTATION-PLAN.md#747-carried-from-s053-to-s060-27-october-2026)), not here, and no screen is described here as finished.

---

**End of Melarc Product Design Direction v1.0**
