# Melarc Master Product and System Specification

> **Status:** Product Owner–Approved Product and System Baseline — Stage 6 Complete, with Product Owner–approved post-baseline amendments through Sprint 023
> **Version:** 1.15
> **Date:** 2026-07-23
> **Approval:** Approved by the Product Owner as the controlling product and system baseline  
> **Control authority:** `00_SPECIFICATION_CHARTER.md`

## How to read this approved baseline

This file is the complete 52-section Product Owner–approved version 1.15 controlling baseline, incorporating the approved version 1.0 baseline and all approved amendments through Sprint 023. Stages 1–6 are complete: sources were consolidated, all sections were drafted, Product Owner policy was confirmed through controlled decision sprints, every registered source contradiction was resolved or delegated by authority, the review edition was normalized, all 52 sections were manually reviewed and approved, and the final audit passed. Requirements classified `CONFIRMED` or `CONFIRMED_WITH_FOLLOW_UP` carry product-policy authority; baseline approval does not silently promote inferred, proposed, current-implementation, deferred, superseded, conflicting-ledger, or technical-design follow-up statements. The normative requirements in this specification and the retained contracts, features, surfaces, architecture, standards and delivery specifications form the implementation authority. Historical requirement classifications remain provenance only.

## Source consolidation baseline

**Historical Stage 1 input counts** (as first consolidated from the uploaded source baseline): 220 product/system requirement statements, 14 implementation observations, 22 deferred/backlog statements, 37 open questions, and 19 contradictions. These figures are historical consolidation data only and do not define current implementation scope or status. Current product behaviour is defined by this specification together with the retained contracts, features, surfaces, architecture and delivery specifications.

# 1. Document control

**Section status:** `APPROVED`
**Approval status:** APPROVED PRODUCT AND SYSTEM BASELINE

| Field | Value |
|---|---|
| Document title | Melarc Master Product and System Specification |
| Product suite | Melarc Platform |
| Document version | 1.15 |
| Specification stage | Stage 6 complete — Product Owner approved; post-baseline amendment sprints 009–023 incorporated |
| Date | 23 July 2026 |
| Product Owner | Melarc founder / owner |
| Product coverage | Melarc Ops Portal, Melarc Vendor, Melarc Rider, recipient/ad-hoc communication channels, shared backend, and the confirmed logistics-operating-ERP modules |
| Current authority | Approved product and system baseline; requirement classifications and controlled decisions remain the detailed authority |
| Process authority | `00_SPECIFICATION_CHARTER.md` |
| Requirements authority | This Master Specification and the applicable retained contracts, features, surfaces, architecture, standards and delivery specifications |
| Product-policy authority | The current normative text in this Master Specification and the applicable retained specification documents |
| Unresolved implementation dependencies | Stated directly in the retained document that consumes or owns the unresolved requirement |

## 1.1 Document purpose

This document is the human-readable product and system baseline that the Product Owner, frontend engineer, backend engineer, reviewers, and later AI development agents will follow. It defines the product, users, business journeys, application responsibilities, binding rules, acceptance expectations, and unresolved decisions.

It does not replace the future OpenAPI contract, canonical domain model, Figma/UI source, implementation plan, or operational runbooks. Those artifacts must implement this specification and may not silently redefine product behaviour.

## 1.2 Authority rule

A statement is implementation authority only when it is classified `CONFIRMED`, or when a later approved decision explicitly promotes it. Source-derived, proposed, TBD, conflicting, and current-implementation statements remain non-authoritative until resolved.

## 1.3 Revision history

| Version | Date | Status | Summary |
|---|---|---|---|
| 0.1 | 14 July 2026 | Controlled skeleton | Control system and 52-section structure established. |
| 0.2 | 14 July 2026 | Stage 1 complete | Source consolidation completed. |
| 0.8 | 14 July 2026 | Stage 2 complete | All 52 sections received an initial source-informed draft. |
| 0.8.1 | 14 July 2026 | Stage 3 started | Interview Batch 001 issued. |
| 0.8.2 | 16 July 2026 | Stage 3 in progress | Batch 001 decisions incorporated; Batch 002 prepared. |
| 0.8.3 | 16 July 2026 | Stage 3 in progress | Partial Batch 002 decisions incorporated; micro-interview mode adopted. |
| 0.8.4 | 16 July 2026 | Stage 3 in progress | Request-level payer default with parcel-level override confirmed. |
| 0.8.5 | 16 July 2026 | Stage 3 in progress | Fixed-amount or percentage payer split confirmed. |
| 0.8.6 | 16 July 2026 | Stage 3 in progress | Payer-change cutoff and post-freeze maker-checker control confirmed. |
| 0.8.7 | 16 July 2026 | Stage 3 in progress | Version 1 group coverage defined as selected parcels in the current pickup request. |
| 0.8.8 | 16 July 2026 | Stage 3 in progress | No separate redelivery charge in Version 1 confirmed. |
| 0.8.9 | 16 July 2026 | Stage 3 in progress | Ultimate failed delivery returns to vendor with a separate vendor-paid return fee. |
| 0.8.10 | 16 July 2026 | Stage 3 in progress | Original delivery fee reverses after ultimate failed delivery; vendor pays return fee only. |
| 0.8.11 | 16 July 2026 | Stage 3 in progress | Return fee becomes earned and billable when formal return processing starts. |
| 0.8.12 | 16 July 2026 | Stage 3 in progress | Version 1 return fee defined as one configurable flat amount. |
| 0.8.13 | 16 July 2026 | Stage 3 in progress | Return-fee waiver requires Ops request and Senior Ops approval. |
| 0.8.14 | 16 July 2026 | Stage 3 in progress | Registered-vendor return fee goes to the next statement; ad-hoc sender pays before return handover. |
| 0.8.15 | 16 July 2026 | Stage 3 in progress | Weekly approved-vendor credit statements confirmed. |
| 0.8.16 | 16 July 2026 | Stage 3 in progress | Weekly statement payment due three calendar days after issue. |
| 0.8.17 | 16 July 2026 | Stage 3 in progress | Monday issue schedule and prior Monday-through-Sunday coverage confirmed. |
| 0.8.18 | 16 July 2026 | Stage 3 in progress | Exact Monday 8:00 AM Ghana-time issue event confirmed. |
| 0.8.19 | 16 July 2026 | Stage 3 in progress | Exact Thursday 8:00 AM Ghana-time payment cutoff confirmed. |
| 0.8.20 | 16 July 2026 | Stage 3 in progress | Immediate overdue transition with no grace period confirmed. |
| 0.8.21 | 17 July 2026 | Stage 3 in progress | New bookings for overdue vendors continue in vendor-paid prepayment mode. |
| 0.8.22 | 17 July 2026 | Stage 3 in progress | Existing confirmed and in-flight work continues when a vendor becomes overdue. |
| 0.8.24 | 17 July 2026 | Stage 3 in progress | Normal vendor credit terms restore automatically after full overdue clearance. |
| 0.8.27 | 17 July 2026 | Stage 3 in progress | One Admin-configured global vendor-wide account limit confirmed; no per-vendor limit administration. |
| 0.8.29 | 17 July 2026 | Stage 3 in progress | Pre-pickup-only hub reassignment, hub-owned service zones, and independently maintained hub pricing/operational settings confirmed. |
| 0.8.30 | 17 July 2026 | Stage 3 in progress | Two-hub temporary-assignment approval, Senior Ops-to-Platform-Admin hub-setting governance, and role-scoped cross-hub access confirmed. |
| 0.8.37 | 17 July 2026 | Stage 3 in progress | Simplified fuel to a Melarc-paid operating expense recorded for audit and reporting; reimbursement/claim workflow removed. |
| 0.8.38 | 17 July 2026 | Stage 3 in progress | Confirmed weekly routine checks and planned oil changes, Senior Ops repair authorization with emergency documentation, and the minimum maintenance record. |
| 0.8.39 | 17 July 2026 | Stage 3 in progress | Confirmed rider-performed weekly checks, dual-trigger oil changes, and Senior Ops overdue-maintenance review. |
| 0.8.40 | 18 July 2026 | Stage 3 in progress | Confirmed Sunday checks, hub-specific oil-change interval governance, and Senior Ops decision before the motorcycle’s next run. |
| 0.8.41 | 18 July 2026 | Stage 3 in progress | Closed fleet policy questions at the Master Specification boundary and adopted domain decision sprints; Delivery and Returns Sprint opened. |
| 0.8.42 | 18 July 2026 | Stage 3 in progress | Delivery Sprint 001 closed: OTP-only delivery/return proof, payment-before-handover, three total attempts, and mandatory failed-attempt hub return confirmed; Pricing/Payment Sprint 002 opened. |
| 0.8.43 | 18 July 2026 | Stage 3 in progress | Pricing/Payment Sprint 002 closed: flat hub-zone pricing, booking estimate and itemization freeze, same-run/day cash reconciliation, direct-to-Melarc Hubtel recipient MoMo, and Hubtel/MoMo-only vendor statement payment confirmed; Vendor/Admin Sprint 003 opened. |
| 0.8.44 | 18 July 2026 | Stage 3 in progress | Vendor/Admin Sprint 003 closed and Identity/Security Sprint 004 opened. |
| 0.8.45 | 18 July 2026 | Stage 3 in progress | Identity/Access Sprint 004 closed and Dispatch/Courier/Notifications Sprint 005 opened. |
| 0.8.46 | 18 July 2026 | Stage 3 in progress | Sprint 005 closed: both delivery lanes, Ops lane selection after itemization, recipient confirmation gate, mandatory milestone SMS plus vendor in-app notifications, and manual courier-registry/no-API boundary confirmed; Sprint 006 opened. |
| 0.8.48 | 18 July 2026 | Stage 3 in progress | Sprint 006 closed: live dashboards/reports and CSV, Ops responsive web, Vendor PWA, native Android Rider, authoritative OpenAPI contract, and measurable NFR targets confirmed; Sprint 007 contradiction cleanup opened. |
| 0.8.49 | 18 July 2026 | Stage 3 in progress | Sprint 007 contradiction cleanup completed: intake-close authority, zero-collection failure, canonical PickupRequest cancellation, no vendor self-service failure dispute, and mandatory registered-courier photo evidence confirmed; Sprint 008 vendor-account billing policy opened. |
| 0.8.50 | 18 July 2026 | Stage 3 complete; Stage 4 active | Sprint 008 closed vendor account allowance, statement payment/dispute and late-penalty policy; Section 27 unblocked and contradiction resolution activated. |
| 0.8.51 | 19 July 2026 | Stage 4 complete; Stage 5 active | Defined Station Drop and Melarc-covered third-party delivery, resolved all remaining source contradictions, and activated review-draft consolidation. |
| 0.9 | 19 July 2026 | Stage 5 complete; review draft ready | Normalized all 52 sections, removed stale resolved-policy language, classified remaining open work, validated all registers, and produced the Product Owner and Engineering review edition. |
| 1.0 | 19 July 2026 | Stage 6 complete; Product Owner approved | All 52 sections approved; final audit passed; 19 remaining items accepted as controlled follow-ups; source and register integrity validated. |
| 1.1 | 21 July 2026 | Post-baseline amendment (Sprint 009) | `MSC-DEC-133–135` confirmed the permission-primitive authorization architecture (permissions, not role names, as the backend enforcement unit); Section 11, 30.3, 37, and the Section 51 glossary revised; no confirmed Version 1 capability changed for any actor. `MSC-DEC-136–141` closed the Section 11.5/Section 8.1 permission-bundle gap in the same sprint: Finance/Reconciliation, Auditor, Executive/Report-consumer, and Fleet Manager confirmed as dedicated bundles; Customer Support and Warehouse Supervisor deliberately declined. |
| 1.2 | 21 July 2026 | Post-baseline amendment (Sprint 010) | `MSC-DEC-142` closed `OQ-045`: hub Senior Ops decides continued hold or return-to-vendor for a suspended vendor's in-custody parcels, reusing the confirmed Section 28.4 OTP return mechanism; Platform Admin decides escalation to claims/security. |
| 1.3 | 21 July 2026 | Post-baseline amendment (Sprint 011) | `MSC-DEC-143–146` substantially closed `OQ-034`: manually-set availability, maker-checker onboarding, tiered suspension authority reusing the fleet breakdown custody-handover mechanism, and offboarding consequences (access revocation, asset return, record preservation). |
| 1.4 | 21 July 2026 | Post-baseline amendment (Sprint 012) | `MSC-DEC-147–149` substantially closed `OQ-021`: per-hub booking cutoff (hub Senior Ops proposes, Platform Admin approves), Ops-manual-exception handling for late bookings, and a uniform Monday–Saturday operating calendar. |
| 1.5 | 21 July 2026 | Post-baseline amendment (Sprint 013) | `MSC-DEC-150–153` substantially closed `OQ-028`: per-category configurable retention, legal-hold exemption from automatic deletion, Platform Admin sole editing authority, and Auditor audit-log export access. Exact retention periods left open pending compliance/legal input. |
| 1.6 | 21 July 2026 | Post-baseline amendment (Sprint 014) | `MSC-DEC-154–155` closed `OQ-036`'s carrier-identity and commercial-mode questions: one outbound delivery run may freely mix registered/informal carrier stops and `STATION_DROP`/`MELARC_COVERED_THIRD_PARTY_DELIVERY` stops. The Delivery Run glossary entry was corrected to remove a resulting contradiction. |
| 1.7 | 21 July 2026 | Post-baseline amendment (Sprint 015) | `MSC-DEC-156–157` closed `OQ-025`: the high-value surcharge funds enhanced handling/evidence diligence only, no fixed liability promise; claims use the existing Damaged/Dispute process, not a new workflow. |
| 1.8 | 21 July 2026 | Post-baseline amendment (Sprint 016) | `MSC-DEC-158` closed a scope-drift finding under `OQ-019` (launch-scale/quality targets never actually covered by `MSC-DEC-113`'s NFR resolution): ~150 vendors, ~10 riders, under 50 parcels/day, 95%+ delivery success rate, 99%+ reconciliation accuracy — explicit launch-stage assumptions, not a contractual SLA. Also: `OQ-035` corrected from `APPROVED_DEFERRED` to `RESOLVED` (bookkeeping fix; already resolved at the 1.0 baseline via `MSC-DEC-107`/`CONFLICT-017`, registry never updated to match). |
| 1.9 | 23 July 2026 | Post-baseline amendment (Sprint 017) | `MSC-DEC-159–161` closed three enterprise-governance gaps from the 2026-07-21 readiness assessment: Product Owner named interim legal/compliance accountability owner (new Section 8.2); Ghana Data Protection Act 2012 (Act 843) and Payment Systems and Services Act 2019 (Act 987) named as a starting regulatory reference point, explicitly not a compliance determination; and all 12 Section 46.1 principal risks given an owner and probability/impact rating. `OQ-028`'s accountable-owner gap closed; exact retention periods per category remain open. |
| 1.10 | 23 July 2026 | Post-baseline amendment (Sprint 018) | `MSC-DEC-162–163` closed the return-fee "setting change/effective-dating authority" and "permitted waiver reasons and limits" residue of `OQ-042`: hub Senior Ops proposes, Platform Admin approves a company-wide return-fee change; waivers limited to three standard reasons with no hard numeric cap. Exact flat return-fee amount, zone price table, and high-value surcharge tiers remain open, asked directly of the Product Owner as real GH₵ figures. |
| 1.11 | 23 July 2026 | Post-baseline amendment (Sprint 019) | `MSC-DEC-164–167` adopted the zone-pricing model from the separate Melarc Pricing & Coverage Web App project: a zone-pair matrix for the launch hub's 7-zone catalogue (superseding `MSC-DEC-089`'s flat-fee-per-zone model), a universal size surcharge pulled into Version 1 (superseding `MSC-DEC-021`'s Phase-2 deferral), and outer-corridor batch/express/intra-corridor rates for Amasaman & Environs and Kasoa Corridor — all under the existing hub Senior-Ops-proposes/Platform-Admin-approves pricing governance. `MSC-DEC-050`'s hub-owned-zones model stands unchanged (Product Owner declined the company-wide-taxonomy option). Every GH₵ value remains open, entered later through the admin dashboard — the Product Owner declined to adopt the source project's committed corridor figures as final. |
| 1.12 | 23 July 2026 | Post-baseline amendment (Sprint 020) | `MSC-DEC-168–171` closed the "suspension grounds" residue of `OQ-033`/`OQ-034`: hub Senior Ops (Platform Admin may also override) may suspend a vendor, citing one of four grounds categories; the same four-category structure (adapted) applies to staff/rider suspension under the already-confirmed `MSC-DEC-145` authority tier; the Section 28.4 return fee applies uniformly to a suspension-triggered return, with the existing waiver mechanism covering Melarc-caused edge cases rather than a new rule. Reactivation, termination, vendor offboarding retention, staff/rider offboarding authority, and device re-registration authority remain open. |
| 1.13 | 23 July 2026 | Post-baseline amendment (Sprint 021) | `MSC-DEC-172–174` closed three of four `OQ-038` sub-questions: individual/ad-hoc sender phone verified by SMS OTP at first use; a five-category prohibited-item catalogue (drugs, weapons, explosives/hazardous materials, live animals, cash/negotiable instruments); and no individual credit facility in Version 1, formally closing what `MSC-DEC-017` already implied. The Product Owner explicitly declined to decide the fourth sub-question — who may refuse/block an individual sender and on what grounds — which remains open. |
| 1.14 | 23 July 2026 | Post-baseline amendment (Sprint 022) | `MSC-DEC-175` closed `OQ-046`, a booking-time-estimate data gap surfaced by external audit of v1.13: a standard multi-package pickup request shows no monetary price estimate at booking, since the Sprint 019 zone-pair matrix needs both origin and destination zone and destination isn't known until itemization. The first authoritative price now appears at itemization for the standard case; the one-package exception is unaffected (destination already captured at booking). This same audit pass corrected numerous stale Stage 2/3-era approval-status labels, an outdated Section 47 assumptions table, and other text/consistency defects across the document without any change to confirmed product behaviour. |
| 1.15 | 23 July 2026 | Post-baseline amendment (Sprint 023) | `MSC-DEC-176–181` resolved the standard-booking prepayment-timing contradiction, made the GH₵25 Station Drop fee a governed company-wide setting, defined the one-package estimate composition, explicitly confirmed GHS as the launch currency, normalized corridor terminology/codes, and made terminal outcomes mode-specific. The same pass synchronized approval language, risk/assumption/open-question sections, glossary, acceptance criteria, and review history. |

# 2. Executive summary

**Section status:** `APPROVED`

**Melarc Platform** is a logistics operating ERP for managing the complete movement and commercial closure of parcels across Greater Accra. It connects four primary interaction channels:

- **Melarc Ops Portal** for internal operations, administration, finance, fleet, and oversight;
- **Melarc Vendor** for contracting vendors’ booking, account activity, payment choices, tracking, and self-service;
- **Melarc Rider** for pickup, handover, delivery, evidence, and delivery-fee collection in the field; and
- recipient/ad-hoc sender interactions through SMS, phone, and payment prompts rather than recipient accounts.

The governing vision is to provide one controlled and auditable system for moving parcels from booking and pickup through hub processing, dispatch, doorstep delivery or mode-specific third-party closure, and final commercial closure. The system must give vendors appropriate self-service and visibility while giving riders a focused execution tool.

The first major release is explicitly a **logistics operating ERP**. In addition to the logistics core, Version 1 digitally includes vendor administration, rider/staff administration, delivery-fee payment and reconciliation, vendor balances and settlement, online/prepaid payment, operational reports and dashboards, and fleet/fuel/maintenance. Payroll, general accounting, and procurement are deferred.

The vendor or ad-hoc sender is the contracting account party. The recipient is the default delivery-fee payer. The contracting party may instead pay the fee fully or split it with the recipient at booking. Recipient portions are collected at delivery through cash or mobile money using a mini-POS workflow in Melarc Rider. Approved registered-vendor portions may use the approved credit account and weekly statements; an individual/ad-hoc sender-paid portion is paid after itemization calculates it and before the affected order becomes dispatch-ready. Melarc charges per delivery and does not operate a subscription model. Melarc does **not** collect the vendor’s merchandise value.

Version 1 launches with one active hub and serves Greater Accra, while the architecture and domain model must support multiple hubs.

The top priorities are reliable parcel custody, end-to-end operational visibility, and transparent vendor self-service/tracking. Version 1 succeeds only when every parcel reaches its mode-specific recorded terminal outcome: doorstep delivery or completed return; verified third-party handoff for `STATION_DROP`; or final external delivery, failure resolution, or return for `MELARC_COVERED_THIRD_PARTY_DELIVERY`. All associated delivery-fee money must be collected, reconciled, reversed, waived, or otherwise closed, with no parcel or payment untraceable.

Product-policy authority for delivery, finance, account, fleet, security, API, UI, and non-functional rules is established in the sections below and the applicable retained specification documents; the named downstream artifacts (domain model, OpenAPI contract, UI specifications, security/finance/offline design, operations runbooks) govern each area's detailed technical mechanics, subject to their applicable readiness requirements.

# 3. Product vision

**Section status:** `APPROVED`

> **Melarc Platform provides one controlled and auditable system for moving parcels from booking and pickup through hub processing, dispatch, doorstep delivery or mode-specific third-party service closure, and final commercial closure, while giving vendors appropriate self-service and visibility and giving riders a focused field-execution tool.**

## 3.1 Vision outcomes

Melarc Platform is intended to:

- preserve a complete and accountable chain of custody;
- make every operational stage and exception visible to authorized staff;
- give vendors clear self-service, tracking, payer-control, and account visibility;
- give riders a mobile-first field tool with safe payment and evidence capture;
- prevent parcels or delivery-fee money from becoming untraceable;
- support one active hub at launch without hard-coding the business to one hub; and
- provide the administration, reporting, fleet, and financial controls required to operate the logistics service.

The term **ERP** in this release means a logistics operating ERP, not a full general-accounting, payroll, or procurement suite.

# 4. Problem statement

**Section status:** `APPROVED`

Melarc coordinates parcel movement across vendors, ad-hoc senders, operations staff, riders, recipients, hubs, and third-party couriers. The operation includes physical custody changes, scheduled work, money collection, field connectivity constraints, exceptions, and different visibility rights. Without one authoritative system, Melarc risks inconsistent booking, disputed parcel counts, unresolved failures, weak hub controls, premature dispatch, missing evidence, opaque vendor service, untraceable parcels, and unreconciled payments.

Melarc Platform must therefore translate a contracting party’s booking into controlled operational work; preserve parcel and payment traceability through every custody stage; enforce user responsibilities and service policies; expose the right information to each surface; and close every parcel with a terminal operational and financial outcome.

## 4.1 Confirmed priority order

1. Maintain reliable parcel custody.
2. Give operations complete end-to-end visibility.
3. Give vendors transparent self-service and tracking.

## 4.2 Launch context

- Initial service geography: Greater Accra.
- Initial active hubs/operating locations: one.
- Required technical capability: multiple hubs/operating locations.
- Customer model: registered businesses plus eligible individual/ad-hoc senders.

Measurable service targets are confirmed: NFR targets (availability/response/backup/recovery) by `MSC-DEC-113`, retention by `MSC-DEC-150–153`, and launch-scale/quality targets (vendor count, rider count, parcels/day, delivery rate, reconciliation accuracy, acceptable manual workload) by `MSC-DEC-158`.

# 5. Business model

**Section status:** `APPROVED`

## 5.1 Contracting relationship

The vendor or sender that books the service is the contracting account party. Registered vendors maintain the ongoing account relationship with Melarc. An eligible individual/ad-hoc sender may also act as the contracting sender through operations-assisted intake.

The contracting party and the person who pays are not necessarily the same person.

## 5.2 Delivery-fee payer assignment

Each pickup request stores a **default payer intent**. That intent applies to every parcel/order created from the request unless a selected parcel receives an explicit parcel-level override. Both the request default and an override may use:

1. **Recipient pays — default:** the recipient pays the full Melarc delivery fee at delivery.
2. **Vendor/sender pays in full:** the contracting party covers one parcel or selected parcels/orders in the current pickup request.
3. **Split payment:** the contracting party pays a fixed Ghana-cedi amount or percentage and the recipient pays the remainder.

### 5.2.1 Booking and itemization boundary

- A standard multi-package pickup request does not yet contain parcel destinations or authoritative prices. Request confirmation therefore records payer **intent**, not a final payable amount.
- A standard pickup request may be confirmed, manifested, and physically collected even when the vendor is prepayment-only, overdue, or potentially over the global credit limit.
- Hub itemization creates each parcel/order, resolves origin and destination zones, calculates the authoritative fee, and establishes the actual vendor/sender and recipient portions.
- Selected parcel-level overrides are applied at itemization to the itemized orders linked to the current pickup request; Version 1 creates no reusable customer or recipient group.

### 5.2.2 Vendor-paid amount gate

When itemization calculates a vendor-paid amount:

- if account allowance is enabled, the vendor is not overdue, and sufficient global-limit exposure is available, the amount may use vendor credit and is reserved when the itemized order is confirmed;
- if account allowance is disabled, the account is overdue, or the amount would exceed available global-limit exposure, the itemized order enters `PAYMENT_REQUIRED`;
- the full vendor-paid amount must be paid successfully before that itemized order can be confirmed as dispatch-ready;
- recipient-paid portions remain allowed and are collected under the approved delivery-payment workflow; and
- pickup-request confirmation or physical collection does not itself create a credit reservation or an earned delivery charge.

The same final itemized-order payment gate applies to the one-package exception. A provisional booking estimate, where shown, does not satisfy the gate and does not replace the authoritative itemized price.

### 5.2.3 Changes, credit, and overdue treatment

- The vendor/sender or authorized Ops may change payer intent or parcel allocation until the authoritative price is frozen.
- After price freeze, Ops submits a controlled payer correction and Senior Ops independently approves or rejects it; before/after allocations, reason, actors, timestamps, payment effects, and approval remain auditable.
- Confirmed vendor-credit commitments reserve exposure at **itemized-order confirmation**, not at pickup-request confirmation.
- Earned unpaid charges continue to consume the same exposure without double-counting.
- A later overdue transition does not pause, cancel, reprice, or reallocate itemized orders already confirmed under accepted credit terms. New or increased vendor-paid amounts after the overdue timestamp require payment before the affected order becomes dispatch-ready.
- After all overdue balances are cleared and recorded, normal approved credit terms restore automatically and immediately.

### 5.2.4 Delivery attempts and returns

- A later delivery attempt creates no separate redelivery charge; the original payer allocation remains linked to the parcel.
- After all approved delivery attempts fail, the original delivery fee is cancelled/reversed and the parcel enters return-to-vendor processing.
- One standard configurable flat return fee becomes earned at formal return-workflow start.
- Approved registered vendors receive the return fee on the next statement; an individual/ad-hoc sender must pay before physical return handover unless an approved auditable waiver or exception applies.
- Ops may request a full or partial waiver under an approved reason; Senior Ops independently approves or rejects it, preserving the original charge and linked adjustment.

### 5.2.5 Statements and detailed finance design

Weekly statements issue Monday at 8:00 AM `Africa/Accra` for the previous Monday–Sunday period and are due Thursday at 8:00 AM. A payable balance becomes `OVERDUE` immediately at the cutoff, with no grace period or monetary late penalty. Statements require full payment of the currently payable undisputed balance; disputed lines enter controlled review and approved corrections create linked adjustments rather than rewriting issued history.

Detailed reservation/release events, payment-provider failure/reversal handling, immutable-ledger mechanics, accounting exports, split precision/rounding, and post-payment correction limits remain assigned to finance/domain/OpenAPI/integration design.

## 5.3 Charging and payment timing

- Melarc charges **per delivery**.
- Version 1 has **no subscription plan or subscription pricing model**.
- Recipient portions are collected at the door by cash or mobile money.
- Melarc Rider provides the rider’s mini-POS payment workflow.
- Hubtel is the intended online/mobile-money provider, subject to integration design.
- Approved registered vendors use a credit account: vendor-paid portions accrue to the account and are presented through weekly statements.
- When an approved vendor account is `OVERDUE`, new pickup requests may continue, but every vendor-paid amount calculated at itemization must be paid before the affected order can be confirmed as dispatch-ready; no new vendor credit is extended during the overdue period.
- Itemized orders confirmed before the overdue timestamp continue under their original payer arrangements and accepted terms; any later new or increased vendor-paid amount must be paid before the affected order becomes dispatch-ready.
- Normal approved credit terms restore automatically and immediately after all overdue balances and related amounts are fully cleared and successfully recorded; no manual approval or next-cycle delay is required.
- Version 1 uses one standard configurable company-wide credit limit for every approved registered vendor. Confirmed vendor-paid itemized orders reserve credit at itemized-order confirmation, and earned unpaid charges continue to consume that exposure without double-counting. An itemized order whose vendor-paid amount would exceed available exposure enters `PAYMENT_REQUIRED`; its full vendor-paid amount must be paid before dispatch readiness. The exact limit amount and detailed release mechanics remain open.
- An individual/ad-hoc sender may assign an approved recipient portion for collection at delivery; every sender-paid amount is paid after itemization calculates it and before the affected order becomes dispatch-ready.
- Melarc earns the normal doorstep-delivery fee at successful doorstep delivery.
- Outbound third-party work has two commercial modes. `STATION_DROP` uses the effective company-wide `station_drop_fee`, initially GH₵25, before station dispatch and earns that captured fee at verified waybill/photo handoff; the recipient separately pays the third party's destination/last-mile charge. `MELARC_COVERED_THIRD_PARTY_DELIVERY` collects one combined waybill-plus-Melarc amount before station dispatch, the recipient pays nothing at destination, and Melarc remains responsible through the recorded final external outcome.
- The outbound prepayment gate overrides normal vendor weekly-account allowance for those outbound charges: the captured Station Drop or combined amount must be paid before rider dispatch to the station/agent.
- After ultimate failed delivery, the original delivery fee is cancelled/reversed and the vendor pays only the separate return fee.
- The return fee becomes earned and billable when formal return-to-vendor processing starts.
- Version 1 uses one configurable flat return fee; the captured charge uses the setting value effective when return processing starts. It is a single company-wide value, but hub Senior Ops proposes a new amount and Platform Admin approves or rejects it before the change takes effect for every hub.
- Approved registered vendors receive the earned return fee on the next periodic statement; individual/ad-hoc senders must pay before physical return handover.
- Ops may request a full or partial waiver with a reason; Senior Ops independently approves or rejects it, and the original charge remains auditable. A waiver reason must be one of three confirmed categories — Melarc-caused operational error, unresolved documented dispute at return-start, or a one-time goodwill/service-recovery exception for a vendor in good standing — with no fixed numeric cap on how many a vendor may receive.

Platform Admin activates or disables account allowance with a recorded reason. Statements require full payment of the payable undisputed balance; disputed lines are reviewed without rewriting the issued statement, and Version 1 has no monetary late penalty. Detailed provider failure/reversal, receipts, immutable-ledger, accounting-export, return-fee, refund and later financial-correction mechanics remain downstream design under `OQ-005` and `OQ-042`.

## 5.4 Explicit exclusion: merchandise COD

Melarc does not collect the purchase price or merchandise value owed to a vendor. “COD” in older source documents is a legacy term that must be removed or migrated. Money collected by Melarc at the door is the **Melarc delivery fee only**.

## 5.5 Customer/service eligibility

Registered vendors are the primary recurring customers. Individuals/non-business senders may use Melarc through operations-assisted intake. Minimum capture includes name, phone number, and pickup location; an absent sender must provide a pickup-point reference name. Prohibited, illegal, and restricted items are rejected, against a confirmed five-category starting catalogue (Section 29.7). The phone number is verified by SMS OTP at first use. A provisional ad-hoc sender becomes a reusable saved sender after the first successful pickup. Who may refuse or block an individual sender, and on what grounds, remains open.

Neither customer type may self-book one package. A one-package request is allowed only through Ops creation and Platform Admin approval, and must include recipient name, phone, and delivery address.

Melarc offers no express service in Version 1.

# 6. Objectives and success criteria

**Section status:** `APPROVED`

## 6.1 Confirmed priorities

| Priority | Objective | Required product outcome |
|---:|---|---|
| 1 | Reliable parcel custody | Every material custody transfer, count, exception, evidence item, and terminal outcome is recorded and attributable. |
| 2 | End-to-end operations visibility | Authorized operations staff can identify the current state, owner, blocker, money status, and next action for every parcel. |
| 3 | Transparent vendor self-service and tracking | Vendors can initiate eligible work, control payer responsibility, view their account activity, and track their parcels without exposure to restricted internal operations data. |

## 6.2 Primary Version 1 success criterion

> Every parcel that enters Melarc reaches its mode-specific recorded terminal outcome—doorstep delivered or returned; Station Drop verified handoff; or final external delivery, failure resolution, or return for Melarc-covered third-party delivery—with every associated delivery-fee obligation collected, reconciled, reversed, waived, or otherwise closed and no parcel or payment untraceable.

## 6.3 Supporting objectives

- Standardize pickup, hub, dispatch, delivery, return, finance, fleet, and administrative workflows.
- Make failures, corrections, overrides, and reconciliation exceptions explicit and auditable.
- Give riders a practical mobile-first workflow with safe cash/MoMo capture and selected offline support.
- Support one launch hub while preserving a multi-hub system model.
- Produce operational, financial, vendor, rider, service-level, and fleet reporting required to run the business.

## 6.4 Confirmed quantitative targets

Response times/availability/backup/recovery are confirmed by `MSC-DEC-113`; retention by `MSC-DEC-150–153`; vendor count (~150), rider count (~10), parcels/day (under 50), delivery rate (95%+), reconciliation accuracy (99%+), and acceptable manual workload (low) are confirmed by `MSC-DEC-158` as launch-stage targets, not permanent limits.

# 7. Product principles

**Section status:** `APPROVED`

The following principles are consistently supported by the source baseline.

## 7.1 Purpose-built surfaces

The Ops, Vendor, and Rider applications are separate working environments. The surface determines the category of work available; the user’s role and ownership determine the actions permitted inside that surface.

## 7.2 Operational authority remains with operations

Riders execute assigned physical work and report outcomes. They do not approve pickup requests, decide reschedules, price parcels, itemize orders, adjudicate disputes, or make senior operational corrections.

## 7.3 One fact, one authoritative home

A business fact should have one canonical source and other documents or surfaces should reference it rather than create competing copies. This applies to requirements, API schemas, settings, states, prices, and decisions.

## 7.4 Chain of custody must be explicit

The system should distinguish sender declaration, rider collection, hub receipt, itemization, dispatch, and onward handoff. One party’s declaration should not automatically become another party’s received fact without the required control.

## 7.5 Exceptions are workflows, not informal notes

Failures, count differences, disputes, cancellations, unreachable recipients, price corrections, and privileged overrides must have defined states, roles, reasons, evidence, and audit outcomes.

## 7.6 Human control before premature automation

Manual stop ordering, ops failure decisions, manual lane classification, and manual courier selection are accepted launch simplifications in the current baseline. Automation should be introduced only when the data, rules, and operating maturity justify it.

## 7.7 Price integrity over silent convenience

The intended price is frozen when the order is confirmed. Any later correction should be explicit, justified, permission-controlled, and audited rather than silently recalculated.

## 7.8 Field resilience without hidden failure

Selected Rider Portal actions must tolerate unreliable connectivity, show pending state, retry safely, and surface actionable synchronization errors rather than silently losing work.

## 7.9 Appropriate visibility and privacy

Registered vendors see their own business slice and customer-facing milestones; they do not see internal receiving counts, OS&D internals, operational routing details, or unrelated vendors’ data. Ad-hoc senders and recipients receive direct communications without portal access.

## 7.10 Operational-calendar discipline

The documented scheduler must not assign delivery dates on Sunday. Other service-day and cutoff policies must be configuration-driven once approved.

## 7.11 Honest documentation and implementation status

Target product behaviour, current implementation, future backlog, and unresolved decisions must remain visibly separate. A feature is not “complete” because part of its UI exists or because a target document labels it locked.

# 8. Stakeholders

**Section status:** `APPROVED`

| Stakeholder | Relationship to product | Primary interest in the approved baseline | Specification implication |
|---|---|---|---|
| Product Owner / Melarc founder | Owns product direction, business rules, scope, priorities, and approval | A complete operational platform that reflects Melarc’s intended service model | Must resolve all business decisions and approve the baseline. |
| Platform Admin | Highest internal operational authority | Overrides, maker-checker approval, privileged corrections, full visibility | Requires strong authorization and audit controls. |
| Senior Ops | Senior operational decision-maker | Escalations, OS&D adjudication, price corrections, courier registry | Needs exception queues and controlled approvals. |
| Ops Staff | Primary daily system user | Fast intake, planning, receiving, itemization, confirmation, dispatch, and queue resolution | Ops workflows must be clear, efficient, and resistant to state errors. |
| Registered Vendor | Recurring B2B customer and account holder | Self-booking, own-parcel visibility, notifications, exceptions, predictable service | Requires a simple, comprehensible portal that exposes only the vendor's own booking and tracking records. |
| Ad-hoc Sender | Non-portal customer | Reliable booking through ops and timely SMS communication | Requires accurate sender capture without unnecessary account complexity. |
| Rider | Field employee executing physical runs | Clear ordered tasks, navigation information, minimal safe forms, offline tolerance | Rider UI must be mobile-first and strictly execution-focused. |
| Recipient | Delivery endpoint without account | Timely notification, reachable confirmation process, safe and successful receipt | Communication and delivery requirements must not assume portal use. |
| Registered Courier Partner | Third party receiving outbound custody | Clear handoff identity, waybill, evidence, and status expectations | Requires registry and active-status controls. |
| Informal Carrier / Driver | Non-registered onward carrier in permitted cases | Simple identity and vehicle evidence capture | Requires alternate validation and risk policy. |
| Frontend Engineer | Builds Ops, Vendor, and Rider user experiences | Stable flows, fields, states, permissions, error contracts, and designs | Requires page inventory, UI states, and an authoritative API contract. |
| Backend Engineer | Builds domain, APIs, business rules, jobs, security, and audit | Stable requirements, states, invariants, data ownership, and NFRs | Requires canonical domain model and approved decision baseline. |

## 8.1 Stakeholders not yet sufficiently specified

Finance/reconciliation staff, customer support, warehouse supervisors, fleet managers, auditors, external SMS/payment providers, and executive/report consumers are within or adjacent to the confirmed logistics-operating-ERP scope. Permission-bundle boundaries are now resolved for six of these (Section 11.3): Finance/Reconciliation, Auditor, Executive/Report-consumer, and Fleet Manager are dedicated bundles; Customer Support and Warehouse Supervisor deliberately stay inside existing bundles. Their detailed workflows and information needs, and external SMS/payment provider service-account permissions, remain to be specified. Fleet policy is sufficient for this Master Specification; remaining fleet-role mechanics are technical-design follow-ups.

## 8.2 Legal/compliance accountability

Until Melarc engages dedicated legal/compliance counsel, the Product Owner is the interim accountable stakeholder for legal/compliance/data-protection sign-off, covering data-retention periods (Section 38.7), PII handling design (Section 37.7), and rider cash/mobile-money custody policy. The Ghana Data Protection Act, 2012 (Act 843) and the Payment Systems and Services Act, 2019 (Act 987) are named as the starting regulatory reference point pending confirmation by qualified Ghanaian counsel — this naming is not itself a compliance determination or legal advice.

# 9. Users and personas

**Section status:** `APPROVED`

The approved baseline defines operational roles more strongly than demographic personas. This section records role-based user profiles without inventing organization size, digital literacy, or behavioural research.

## 9.1 Platform Admin

**Primary goal:** Maintain ultimate platform control and approve the highest-risk financial, settings, access, and exception decisions.

**Key responsibilities:**

- All explicitly authorized company-wide capabilities.
- Approve the documented single-package maker-checker exception.
- Approve or reject hub pricing, operational setting, and service-zone proposals.
- Separately enable or disable a registered vendor's use of the global vendor account allowance.
- Resolve selected privileged access and system-wide exceptions.

## 9.2 Senior Ops

**Primary goal:** Keep hub operations moving while protecting policy, custody, vendor approval, fleet availability, and accountability.

**Key responsibilities:**

- Approve or reject Ops-created registered vendor organizations for operational activation.
- Work escalations and exhausted pickup chains.
- Adjudicate defined hub discrepancies and exceptions.
- Approve or reject controlled post-freeze price corrections.
- Manage hub-scoped operational decisions and staff/fleet assignments.

## 9.3 Ops Staff

**Primary goal:** Process daily parcel and customer operations accurately and efficiently.

**Key responsibilities:**

- Create registered vendor organization records for Senior Ops review.
- Capture pickup requests for registered vendors and ad-hoc senders.
- Build, assign, and work operational queues and manifests.
- Receive, itemize, price, confirm, dispatch, reconcile, and process exceptions within granted permissions.

**Design need:** High-volume queues and forms with clear validation, role-gated actions, concurrency feedback, and recovery paths.

## 9.4 Registered Vendor Organization

**Primary goal:** Book eligible pickups, manage saved pickup locations, track parcels, and manage delivery-fee obligations for the vendor's own organization.

**Version 1 access model:**

- Ops creates the organization and shared portal credential.
- Senior Ops approves or rejects operational activation.
- Platform Admin separately enables the global vendor account allowance; until then each vendor-paid amount calculated at itemization must be paid before the affected order can become dispatch-ready.
- The organization uses one shared Melarc Vendor login rather than individual vendor users or roles.
- The organization may maintain multiple saved pickup locations and one default.
- Suspension blocks portal access and stops every undelivered item in a controlled hold.

**Restrictions:** The vendor cannot access another vendor, internal blind counts, OS&D internals, route construction, rider-only evidence, or privileged decisions.

## 9.5 Ad-hoc Sender

**Primary goal:** Send parcels through Melarc without a Melarc Vendor portal account.

**Interaction model:**

- Ops captures the sender's name, phone, pickup location, and any required pickup-point reference.
- The system creates a provisional sender record.
- The sender receives supported milestones through approved non-portal channels.
- After the first successful physical pickup, the sender becomes an active searchable saved sender for future auto-population.
- The sender may later be promoted through the Ops-created registered-vendor process.
- The sender cannot self-book a one-package pickup but may use the approved Ops/Platform-Admin exception path.

## 9.6 Rider

**Primary goal:** Complete assigned physical work safely, accurately, and with minimal administrative burden.

The rider needs a field-optimized application, assignment-scoped visibility, strong custody controls, offline-aware execution, payment collection where applicable, and clear evidence/error recovery. Authentication and registered-device policy are confirmed in Section 11.2.

## 9.7 Recipient

**Primary goal:** Receive the correct parcel and pay any delivery-fee portion due.

Recipients do not receive a full account in the current baseline. Their main interactions are SMS/phone, Hubtel payment where applicable, and valid OTP authorization for parcel handover.

## 9.8 System actors

- Background scheduler/worker
- SMS and notification provider
- Hubtel/payment provider
- Mapping/geocoding provider
- File/object storage
- Registered courier/provider integration where later approved

System actors do not possess human business authority; every automated transition must follow an approved rule and remain auditable.

# 10. System surfaces

**Section status:** `APPROVED`

## 10.1 Surface model

Melarc uses purpose-built applications rather than a single universal interface. Surface and role are separate gates: the application establishes the job context, while role, responsible hub, assignment, and record ownership determine the permitted actions.

| Application/channel | Version 1 form factor | Primary users | Purpose | Explicit boundary |
|---|---|---|---|---|
| Melarc Ops Portal | Desktop-first responsive web application | Internal staff bundles defined in Section 11.3, including Ops Staff, Senior Ops, Platform Admin, Finance/Reconciliation, Auditor, Executive/Report-consumer, and Fleet Manager | Internal logistics command centre, administration, approvals, monitoring, reconciliation, reporting and configuration | Not a rider field-execution application; payroll, general accounting and procurement are excluded from Version 1. |
| Melarc Vendor | Mobile-first responsive Progressive Web App | Registered vendor shared account | Place eligible pickup/order requests; manage saved pickup locations; track own parcels, fees, statements, payments, notifications and returns | Simple own-order portal, not SaaS, vendor ERP or team workspace; no access to unrelated vendors or internal Melarc operations. |
| Melarc Rider | Native Android application | Assigned riders | Execute assigned pickup/delivery work, capture approved evidence, record recipient delivery-fee collection, manage custody handoffs and complete OTP-gated outcomes | Not a web/PWA implementation; no approval, pricing, adjudication, registry or unrelated-record access. |
| Recipient communication/payment | SMS, calls, Hubtel and OTP | Parcel recipients | Confirmation, payment, milestone communication and delivery authorization | No authenticated recipient portal in Version 1. |
| Ad-hoc sender communication | SMS and phone | Individual/ad-hoc senders | Assisted booking, collection/return confirmation and milestone communication | No authenticated Melarc Vendor account. |
| Shared backend/API | Versioned services governed by OpenAPI | All applications indirectly | Enforce business rules, permissions, states, ownership, idempotency, jobs, integrations, evidence and audit | OpenAPI is the authoritative FE–BE contract; application code and feature sketches may not silently redefine it. |

## 10.2 Confirmed launch dashboard boundary

Each responsible hub has a live operational dashboard covering:

- pickup request queues and pickup-run execution;
- hub receiving, reconciliation and itemization;
- dispatch, delivery attempts and returns;
- delivery-fee payment/cash exceptions; and
- fleet availability.

Platform Admin and specifically authorized HQ/company-wide roles receive a consolidated all-hub view. Dashboard counts must link to authorized operational records, identify freshness, preserve responsible-hub context, and avoid double-counting. Exact KPIs and visual layout remain reporting/Figma design.

## 10.3 Application capabilities

### Melarc Ops

- Pickup intake/approval, manifest/run planning, hub receiving, itemization, pricing/financial corrections, recipient-confirmation queues, dispatch, returns, reconciliation, vendor/rider/fleet administration, settings, dashboards and reports.
- Desktop-first workflows must remain usable at narrower responsive widths but may optimize dense operational tables for desktop.

### Melarc Vendor

- Own booking, saved locations, own tracking, fee/payer visibility, statements/payments, notifications and returns.
- As a mobile-first PWA, it requires installability and responsive behaviour; exact caching/offline scope is a frontend technical decision unless later product policy requires it.

### Melarc Rider

- Native Android field execution for assigned pickup and delivery runs, evidence, custody, OTP, and payment-gated handover.
- Exact supported Android versions, offline action set, device capabilities, secure local storage, sync and app distribution remain controlled mobile/security design.

## 10.4 Design work still required

Before frontend implementation is ready, each application requires a controlled page/screen inventory, navigation model, role/permission states, forms/tables/cards, interface states (Section 41.1), responsive rules, accessibility criteria, Figma/component references, and mapping to OpenAPI operation IDs and acceptance criteria.

# 11. Roles and permissions

**Section status:** `APPROVED`

## 11.1 Authorization model

Melarc uses two independent authorization gates:

1. **Surface gate** — determines the category of work exposed by Melarc Ops, Melarc Vendor, or Melarc Rider.
2. **Permission/ownership gate** — determines whether the authenticated actor may perform a specific action on a specific record, based on the permissions the actor holds, responsible hub, vendor ownership, rider assignment, current state, and any approved temporary assignment.

The backend enforces authorization through **permissions**, not role names. A permission is a single named, atomic capability (for example `pricing.correction.approve`) and is the unit every authorization check tests. A **role** is a named, editable bundle of permissions assigned to a user for convenient administration; it carries no authority beyond the permissions it currently contains, and changing what a role contains is a data/configuration change, not a backend code change. Section 11.3 lists the currently confirmed bundles; Section 11.6 defines the permission model itself.

Backend permission checks remain authoritative even when the frontend hides or disables an action. Melarc Vendor is not a SaaS tenant workspace: it is a simple customer portal whose shared vendor account can access only that vendor's booking, tracking, and directly related approved records. Melarc Vendor and Melarc Rider each carry exactly one fixed, non-configurable bundle in Version 1; no Vendor- or Rider-facing screen may expose bundle or permission management.

## 11.2 Confirmed authentication baseline

- Ops, Senior Ops, and Platform Admin use email and password.
- Senior Ops and Platform Admin must complete MFA before privileged access.
- Riders use registered phone number and private PIN on one registered device.
- Each shared Melarc Vendor account permits one active session/device; a new successful login ends the old session.
- Staff recover through verified work email; vendors through registered phone/email; riders through Ops identity verification and device re-registration.
- Platform Admin handles exceptional staff/vendor recovery; Senior Ops handles rider recovery.

Low-level password/PIN, factor, token, lockout, expiry, device-identifier, and session mechanics belong to security architecture and OpenAPI.

## 11.3 Role/bundle summary

Every row below is a **named permission bundle**, confirmed at this baseline exactly as previously approved. Assignment tooling and everyday language may keep calling these "roles" — the backend treats each as a bundle preset that a staff record points to, not as an independent authority.

| Role / actor | Primary surface | Baseline authority | Explicit restrictions |
|---|---|---|---|
| Platform Admin | Melarc Ops | All Senior Ops capabilities; single-package maker-checker approval; global settings/account-allowance approval; selected privileged actions | Does not need to approve normal Senior-Ops force extension unless a later exceptional policy explicitly requires it. |
| Senior Ops | Melarc Ops | Hub operational approval, escalations, discrepancy adjudication, price-correction approval, exhausted pickup-attempt extension, courier registry, fleet and hub decisions | Must provide reasons for privileged direct actions and must not silently bypass audit. |
| Ops Staff | Melarc Ops | Daily intake, manifest/run planning, receiving, itemization, confirmation, dispatch, reconciliation, and supported administration | Cannot perform reserved maker-checker or senior decisions. |
| Registered Vendor account | Melarc Vendor | Place eligible requests, manage approved pickup locations, track own orders, and view directly related approved account/payment/return information | No access to another vendor, vendor-user administration, internal receiving/run details, or privileged Melarc decisions. |
| Rider | Melarc Rider | Execute assigned runs, record outcomes/evidence, collect approved delivery fees, and complete handoffs | Cannot approve, price, adjudicate, or work unassigned records. |
| Ad-hoc Sender | SMS/phone only | Participate in supported assisted flows and notifications | No authenticated portal role. |
| Recipient | SMS/payment/OTP only | Receive transaction-specific communication, pay any recipient portion, and authorize handover with valid OTP | No general portal account. |
| Finance/Reconciliation | Melarc Ops | All-hub read access to vendor accounts, statements, and payment-reconciliation records, plus relevant report export | No write or approve permissions anywhere; waiver and allowance decisions stay with Senior Ops/Platform Admin. |
| Auditor | Melarc Ops | Cross-domain, all-hub read access plus audit-log search, view, and export | No write or approve permissions anywhere; export remains enhanced-audited per Section 38.5. |
| Executive/Report consumer | Melarc Ops | All-hub dashboard, report, and export visibility | No write or approve permissions anywhere. |
| Fleet Manager | Melarc Ops | Hub-scoped fleet/maintenance/fuel authority identical to Senior Ops's confirmed Section 30.7 fleet capabilities | Additive only — does not remove or narrow Senior Ops's existing fleet authority. |

Customer Support and Warehouse Supervisor were evaluated and deliberately did not receive a dedicated bundle in Version 1: support inquiries stay inside Ops Staff, and hub-floor supervision stays inside the existing Ops Staff/Senior Ops split, exactly as already confirmed.

## 11.4 Approved action matrix

| Action | Ops Staff | Senior Ops | Platform Admin | Vendor | Rider |
|---|---:|---:|---:|---:|---:|
| Create pickup request for any sender | Yes | Yes | Yes | Own vendor only | No |
| Confirm normal pickup request (≥2) | Yes | Yes | Yes | No | No |
| Approve single-package exception | No | No | Yes | No | No |
| Build/order/dispatch pickup manifest | Yes | Yes | Yes | No | No |
| Start/execute assigned pickup run | No | No | No | No | Owned run only |
| Confirm/dispute own collection | No | No | No | Own pickup only | Ad-hoc code-entry path only |
| Report pickup failure | No | No | No | No | Owned dispatched stop only |
| Reschedule/cancel/escalate failed pickup | Yes | Yes | Yes | No | No |
| Force-extend exhausted attempt chain | No | Yes, hub-scoped with reason/audit | Yes as inherited emergency authority | No | No |
| Submit hub handover | No | No | No | No | Owned completed run only |
| Blind-count receive/itemize/confirm intake | Yes | Yes | Yes | No | No |
| Adjudicate Damaged/Dispute | No | Yes | Yes | No | No |
| Request price correction | Yes | Yes | Yes | No | No |
| Approve/reject price correction | No | Yes | Yes | No | No |
| Work recipient confirmation queue | Yes | Yes | Yes | No | No |
| Build/dispatch delivery run | Yes | Yes | Yes | No | No |
| Manage courier registry | No | Yes | Yes | No | No |
| Perform courier handoff | No | No | No | No | Owned outbound run only |
| Manage configurable reason pills | No | Yes | Yes | No | No |
| Suspend a vendor | No | Yes, hub-scoped with reason/audit | Yes, direct | No | No |
| Decide suspended-vendor held-parcel disposition (hold/return) | No | Yes, hub-scoped with reason/audit | Yes | No | No |
| Escalate suspended-vendor held parcel to claims/security | No | No | Yes | No | No |
| Suspend an Ops Staff member or Rider | No | Yes, hub-scoped with reason/audit | Yes, required if target is Senior Ops or Platform Admin | No | No |

The Rider-column value on "Confirm/dispute own collection" ("Ad-hoc code-entry path only") is a Rider capability, not an Ad-hoc Sender one: Ad-hoc Sender has no authenticated portal role (Section 11.3) and holds no permission in this system. Per `OQ-009`/`MSC-DEC-115`, the collection code is sent by SMS to the ad-hoc sender, who gives it to the rider; the rider is the one who enters it. Every row above maps to one or more entries in the permission catalog defined in Section 11.6; this matrix is retained as the human-readable policy view, and the catalog is the enforcement-level source of truth.

## 11.5 Remaining permission work

Architecture is closed: permissions, not role names, are the backend enforcement primitive; roles are bundles; maker-checker actions use one uniform create/approve/same-actor-exclusion pattern; and Melarc Vendor/Rider stay on one fixed bundle each in Version 1.

Bundle boundaries for every function named in Section 8.1 are also closed: Finance/Reconciliation, Auditor, Executive/Report-consumer, and Fleet Manager are confirmed dedicated bundles (Section 11.3); Customer Support and Warehouse Supervisor deliberately stay inside Ops Staff/Senior Ops rather than getting one.

Still open:

- Exact permission-key enumeration for the four new bundles, and the remainder of a complete view/read-permission enumeration — the action matrix above, and the catalog derived from it, are write/action-oriented only.
- Service-account and integration permissions.
- Whether a bundle may carry per-user permission overrides in Version 1, or bundles are strictly fixed.
- Exact suspension, held-parcel disposition, credential revocation, and security-event response mechanics.

No implementation may infer missing permissions from UI convenience or framework defaults.

## 11.6 Permission model

Every permission is a globally unique key of the form `<domain>.<action>`, or `<domain>.<subresource>.<action>` where a domain has more than one independently-grantable resource. `domain` is drawn from a closed list mirroring this specification's own sections; introducing a new domain requires a Product Owner decision, not an ad hoc string in application code. A permission is binary — held or not held; there is no partial grant.

A held permission is further constrained by a **scope** attached to the grant rather than encoded in the key: a hub scope (none / own hub / all hubs), an ownership scope (own record / assigned record / any record), a state precondition evaluated jointly with the canonical state machine (Section 36), and an optional time-bounded window reusing the Section 30.5 temporary-assignment pattern. This is the formal model behind the permission/responsible-hub-scope/vendor-record-ownership/rider-assignment/current-state/temporary-authority language already confirmed at Section 11.1 and Section 37.1.

Maker-checker actions are represented as a `*.create` (or `*.request`) permission plus a `*.approve` permission, with one constraint enforced uniformly: the approver may not be the actor who created the same record.

The Section 11.3 bundles nest strictly for hub-operational authority, verified against the Section 11.4 matrix: the Senior Ops bundle is the Ops Staff bundle plus discrepancy adjudication, price-correction approval, hub-scoped force-extension, courier-registry management, and reason-pill management; for that same hub-operational authority, the Platform Admin bundle is the Senior Ops bundle plus single-package-exception approval. This nesting statement is illustrative of the operational-authority ladder, not an exhaustive list of every Platform-Admin-only permission — Platform Admin additionally holds company-wide-only authorities with no Senior Ops equivalent (global settings and account-allowance approval, Section 11.3; retention-settings sole authority, `MSC-DEC-150–152`; direct vendor-suspension override, `MSC-DEC-168`; pricing-structure approval alongside Senior Ops, `MSC-DEC-167`), enumerated in full only by the Section 11.6 permission catalog. This nesting is what makes a new bundle additive rather than a rewrite: a new job family (Section 11.5) is a new bundle definition composed from the existing permission catalog, not a new authorization code path.

The complete permission catalog — every key, its confirmed holders, and its scope — is the technical-design artifact anticipated by Section 11.5, seeded by `DRAFT_PERMISSIONS_CATALOG_V0.1.md` and not yet finalized.

# 12. Product scope

**Section status:** `APPROVED`

Melarc Platform’s first major release is a logistics operating ERP covering the complete parcel transaction and the operational business capabilities necessary to run it.

## 12.1 Applications and channels

- Melarc Ops Portal
- Melarc Vendor
- Melarc Rider
- Recipient/ad-hoc SMS, phone, and payment interactions
- Shared backend APIs, jobs, audit, evidence, reporting, payments, and data stores

## 12.2 Logistics lifecycle scope

- Vendor/sender onboarding and pickup booking
- Pickup scheduling, approval, manifesting, rider execution, failure, and rescheduling
- Hub handover, blind receipt, discrepancy handling, and itemization
- Pricing, payer assignment, recipient confirmation, and dispatch
- Doorstep delivery, proof of delivery, payment collection, failed delivery, reattempt, and returns
- Outbound third-party courier handoff and onward tracking/closure
- Delivery-fee reconciliation, vendor balances, settlement, corrections, and financial reporting

## 12.3 Operating-ERP scope

- Vendor administration
- Rider and staff administration
- Fleet, fuel, and maintenance management, with motorcycles-only Melarc-owned assets and one permanent motorcycle assignment per rider until formal transfer
- System settings and permissions
- Operational, financial, vendor, rider, service-level, and fleet dashboards/reports

## 12.4 Architecture scope

Version 1 launches with one active hub but must model multiple hubs without redesign. Every operational/financial record listed in `HUB-020` belongs to one responsible hub, and company-wide dashboards aggregate across hubs while preserving record-level hub identity. Riders and staff have one primary hub; temporary cross-hub work requires a request from primary-hub Senior Ops and approval by receiving-hub Senior Ops. Authorized Ops may change a responsible hub only before rider pickup begins; after custody starts, movement to another hub requires the future controlled transfer workflow. Each hub owns its service zones and independently maintains its pricing and operational settings. Hub Senior Ops proposes pricing/setting changes and Platform Admin approves or rejects them. Access is hub-scoped except for Platform Admin and explicitly authorized company-wide roles. Hub service-zone changes use hub Senior Ops proposal plus Platform Admin approval. A pickup already on a manifest may still be reassigned before its rider run starts, provided the old stop and incompatible assignments are atomically removed/revoked and the pickup is replanned under the new hub. All-hub dashboards and exports are restricted to Platform Admin and explicitly authorized company-wide/HQ roles; hub Senior Ops remain hub-limited. Detailed zone versioning/overlap, emergency configuration, reassignment side effects, HQ role definitions, exports, and reporting metrics remain open under `OQ-044`.

# 13. Version 1 scope

**Section status:** `APPROVED`

## 13.1 Digital capabilities required in Version 1

### Core platform and administration

- Authentication and authorization for staff, vendors, and riders
- Vendor administration
- Rider and staff administration
- System settings, audit, evidence, notifications, and reports
- One active hub with multi-hub-capable design

### Logistics operations

- Pickup request through hub/itemization and dispatch
- Doorstep delivery and proof of delivery
- Failed delivery and controlled reattempt
- Return to hub and return to sender
- Outbound third-party handoff, with terminal closure determined by commercial mode

### Payments and finance

- Recipient delivery-fee collection by cash or mobile money in Melarc Rider
- Online/prepaid vendor payment through the approved provider
- Rider payment reconciliation
- Vendor account balances and settlement
- Operational finance dashboards and reports
- No merchandise COD

### Fleet operations

- A motorcycle-only operational fleet register
- Melarc-owned motorcycles only
- One permanent motorcycle assignment per active rider until formal transfer
- Active, serviceable unassigned motorcycles may be held as hub spares
- Hub Senior Ops directly performs permanent transfers with a mandatory reason and audit history
- A pre-run motorcycle breakdown is handled by reassigning the run to another available rider with a functioning assigned motorcycle
- A rider-reported breakdown remains pending until hub Senior Ops confirms or rejects it; confirmation makes the motorcycle unavailable for new runs
- An active-run breakdown uses an audited custody handover to a replacement rider, with return to the responsible hub where safe field handover is impossible
- An authorized maintenance user records repair/inspection completion, and hub Senior Ops independently approves return to service
- The motorcycle register requires internal asset ID, registration number/plate, make, model, model year, colour, chassis number, engine number, acquisition date, responsible hub, current rider assignment, odometer, and operational status
- Insurance and roadworthiness are the only recurring motorcycle compliance-document categories tracked in Version 1
- Compliance expiry generates advance warnings and a blocking review alert; hub Senior Ops decides whether the motorcycle becomes unavailable for new runs
- Fuel management
- Maintenance management

Fleet product policy is sufficient for this Master Specification. Exact checklist fields, evidence formats, scheduler timestamps, compliance-record maintenance mechanics, emergency controls, and asset archival are delegated to later technical design; launch fleet metrics remain part of the Reporting sprint.

## 13.2 Version 1 completion rule

A parcel journey is not complete merely because it was dispatched. It must reach a recorded terminal outcome and its delivery-fee obligation must be collected, reconciled, waived, reversed, or otherwise closed by an approved rule.

# 14. Out-of-scope items

**Section status:** `APPROVED`

## 14.1 Confirmed outside Version 1

- Payroll and staff compensation
- General accounting/general ledger
- Procurement
- Subscription pricing or subscription plans
- Collection of vendor merchandise value from recipients (merchandise COD)

## 14.2 Source-deferred logistics automation

- Automated/AI pickup and delivery route optimization
- Live rider GPS and ETA
- Automatic rescheduling optimization
- Automatic inbound/outbound classification
- Automatic courier matching
- Dimensional-weight pricing
- Hub barcode/label scanning
- ML-assisted high-value detection
- OCR/evidence extraction and waybill correction
- Per-zone or per-vendor setting overrides unless later promoted

## 14.3 Confirmed service exclusions and Phase 2 items

- Express service is excluded from Version 1 for every customer type.
- ~~Parcel-size classification definitions and size-based surcharges are deferred to Phase 2.~~ Superseded: pulled into Version 1 as a universal surcharge on the zone-pair/corridor base fee (Section 23.4). Categories are Small, Medium, Large, and Extra Large; Small is a fixed GH₵0 baseline. `[MSC-DEC-021 superseded by MSC-DEC-165]`
- A one-package pickup is not self-service, but it is not out of scope: registered vendors and individual/ad-hoc senders may use the controlled Ops/Platform-Admin exception path.

# 15. Future roadmap

**Section status:** `APPROVED`

Future releases may expand the logistics operating ERP with:

- Payroll and staff compensation
- General accounting, budgeting, and full financial statements
- Procurement and supplier management
- Advanced multi-hub transfer and network optimization
- Route optimization, live GPS, ETA, and richer rider telemetry
- Automated courier matching and partner integrations
- Dimensional pricing and scanning automation
- Advanced claims/liability products
- Per-zone/per-vendor settings and commercial terms
- Expanded CRM, sales, and customer-success capabilities

Features already confirmed for digital Version 1—delivery, returns, delivery-fee reconciliation, settlement, administration, reports, and fleet/fuel/maintenance—must not be left in the future-roadmap backlog merely because their detailed feature documents are still unwritten.

# 16. End-to-end parcel lifecycle

**Section status:** `APPROVED`

The required Version 1 lifecycle is:

```text
Contracting vendor/sender onboarding
→ pickup booking with payer intent
→ request approval and scheduling
→ pickup manifest and rider collection
→ collection confirmation / failure handling
→ hub handover and blind receipt
→ discrepancy resolution and itemization
→ authoritative pricing, payer allocation, and itemized-order payment/credit gate
→ recipient confirmation
→ dispatch
→ doorstep delivery OR third-party courier/station handoff
→ mode-specific proof, payment, and onward-outcome recording
→ rider/payment reconciliation
→ vendor account and statement update
→ final operational and financial closure
```

## 16.1 Mode-specific terminal outcomes

Every parcel must reach one approved terminal outcome:

- **Doorstep service:** successfully delivered through the valid recipient OTP flow, or returned to the vendor/sender through the approved return process.
- **`STATION_DROP`:** verified third-party station/courier handoff with the mandatory waybill and receipt/handoff photo; Melarc's Station Drop service is complete at that handoff.
- **`MELARC_COVERED_THIRD_PARTY_DELIVERY`:** final external delivery, final external failure resolution, or completed external return. Station handoff alone is not terminal because Melarc remains commercially responsible through the recorded final external outcome.
- **Exceptional terminal outcome:** a separately approved loss, damage, cancellation, disposal, claims, or security disposition that preserves custody and financial closure.

The canonical domain model and OpenAPI contract must assign stable machine states and evidence requirements to these outcomes without changing their commercial meaning.

## 16.2 Multi-hub principle

Every custody-bearing and operational/financial entity listed in `HUB-020` has one responsible-hub context. Company-wide views aggregate records; they do not erase hub ownership. Riders and staff have one primary hub and may receive authorized temporary cross-hub assignments. Version 1 does not move parcels between Melarc hubs; that transfer workflow is deferred until another hub opens, and future support must use a controlled custody handoff rather than direct hub reassignment.

## 16.3 Financial closure principle

Operational closure and financial closure are related but distinct. A parcel may reach a physical outcome while payment or reconciliation remains open; the system must expose both statuses and prevent unresolved money from becoming invisible. No terminal parcel may disappear from payment, reversal, waiver, statement, or reconciliation reporting.

# 17. Melarc Ops Portal requirements

**Section status:** `APPROVED`

## 17.1 Purpose

Melarc Ops Portal is Melarc’s desktop-first responsive internal logistics command centre. It must give authorized staff one controlled environment for creating work, monitoring operational state, resolving exceptions, recording custody, applying approvals, and seeing cross-vendor activity appropriate to their role.

## 17.2 Users

- Ops Staff
- Senior Ops
- Platform Admin
- Finance/Reconciliation, Auditor, Executive/Report-consumer, and Fleet Manager bundles — dedicated permission bundles confirmed by `MSC-DEC-136–141` (Section 11.3)

Customer Support and Warehouse Supervisor were evaluated and deliberately kept inside the existing Ops Staff/Senior Ops bundles rather than given a dedicated bundle — not an undefined gap.

## 17.3 Required capability areas

### Pickup intake and approval

- Search registered vendors and reusable ad-hoc senders.
- Create provisional ad-hoc senders when no safe match exists.
- Create pickup requests for either sender category.
- Show booking eligibility and computed scheduled date.
- Approve normal requests, decline with reason, or route one-package requests through maker-checker approval.
- Show request history and attempt-chain context.

### Pickup-run planning

- Display only eligible confirmed, unmanifested requests.
- Create manifests, add one or many requests, manually reorder stops, assign an active rider, and dispatch.
- Show manifest/run progress and stop outcomes.
- Provide reconciliation views for disputed, unconfirmed, or locked collection confirmations.

### Failed-pickup operations

- Maintain a “needs decision” queue containing failure category, reason, evidence, contact attempts, wait time, attempt count, retryability, cap state, and escalation state.
- Allow authorized reschedule, cancel, and escalate actions.
- Route refused-collection and exhausted chains to the appropriate senior queue.
- Record every override and chain-closing action.

### Hub receive and itemization

- Show an awaiting-receive queue without exposing the rider-declared count before blind count.
- Support physical count, reveal, discrepancy/condition capture, evidence, and senior adjudication where required.
- Prevent itemization before receiving/reconciliation conditions are met.
- Support repeated parcel itemization forms with zone resolution, size, high-value, delivery-fee payer allocation, approved service level, lane, and price breakdown.
- Confirm individual or bulk itemization records, enforce immutable charge snapshots, apply the vendor-credit/payment gate, and close intakes through a parity gate.
- Support controlled price-correction requests and approvals after `QUEUED`.

### Recipient readiness and dispatch

- Provide a confirmation-call queue grouped/filterable by operationally useful dimensions.
- Record confirmed, reschedule, address-correction, and unreachable outcomes.
- Hold non-confirmed orders out of the run-ready pool.
- Build lane-compatible delivery runs, reorder stops, assign rider/courier, and dispatch atomically.
- Provide senior queues for unreachable recipients and courier issues.

### Administration and configuration

- Manage registered couriers at the approved role level.
- Manage configurable reason-pill sets.
- Manage approved global settings per the confirmed System Settings feature (Section 33).
- Access audit history and operational reports according to permission.

## 17.4 Common interaction requirements

The Ops Portal should provide:

- Queue counts and filters that make pending work visible.
- Clear record identifiers and linked journey history.
- Status and ownership indicators.
- Permission-aware actions with backend enforcement.
- Bulk actions only where the business operation is safe and atomic.
- Visible validation and recovery guidance.
- Concurrency indication for sensitive work such as receiving.
- Evidence preview/download according to access policy.
- Reason, note, actor, timestamp, and decision history for exceptions.
- Search that does not leak another vendor's or unauthorized hub data.

## 17.5 Internal data visibility

Ops users require cross-vendor operational visibility only within their authorized hub scope. Ordinary Ops and hub staff see their primary hub plus any currently effective temporary-assignment hub; Senior Ops see their own hub; Platform Admin and explicitly authorized company-wide roles may see all hubs. Access must be enforced server-side and audited; “cross-vendor” does not imply unrestricted database access, and temporary hub assignment never grants company-wide visibility. The physical data layout and company-wide role catalogue remain downstream architecture/design work.

## 17.6 Known gaps

- Complete page/route/navigation design.
- Authentication/session design.
- Broader ERP modules.
- Finance and settlement workspaces.
- Dashboard KPI definitions and detailed report layouts (the dashboard/report families themselves are confirmed).
- Vendor, rider, staff, and courier administration details.
- Final permission granularity.
- Complete delivery and returns operations.

# 18. Melarc Vendor requirements

**Section status:** `APPROVED`

## 18.1 Purpose and boundary

Melarc Vendor is a simple mobile-first responsive Progressive Web App—not a SaaS workspace, vendor ERP, or separately managed tenant environment. Its primary purpose is to let an approved registered vendor place pickup/order requests and track the vendor's own orders. It may also show only the directly related saved locations, payer allocation, frozen delivery fee, statements/payments, notifications, and returns already required to complete that service relationship.

It must never expose another vendor's records or internal Melarc operations such as blind receiving counts, route construction, rider-only evidence, privileged reasons, or adjudication details.

## 18.2 Account creation and activation

- A business cannot self-register in Version 1.
- Authorized Ops creates the vendor record and shared portal credential.
- Hub Senior Ops independently approves or rejects operational activation.
- Platform Admin separately enables use of the global vendor account allowance and weekly statement terms.
- Until financial allowance is enabled, pickup requests may proceed; each vendor-paid or split vendor portion calculated at itemization must be paid before the affected order can become dispatch-ready.

Detailed verification evidence, rejection/reapplication, duplicate detection, and promotion from saved ad-hoc sender belong to downstream vendor-domain/security/UI design.

## 18.3 Shared credential and session boundary

- Version 1 provides one shared login per registered vendor.
- There are no individual vendor users, invitations, roles, team management, tenant administration, or organization-owner transfer.
- Only one active session/device is permitted; a new successful login ends the previous session.
- Recovery uses the registered vendor phone number or email, with Platform Admin handling exceptional recovery.
- Activity is attributable to the vendor account, not a named vendor employee.
- Ad-hoc senders have no Melarc Vendor login.

`

## 18.4 Saved pickup locations

- A vendor may create, edit, deactivate, and select multiple saved pickup locations.
- One location may be marked as default.
- Every booking validates the selected location against the responsible hub's service zones, calendar, and cutoff rules.
- A request-specific override must not silently update the saved default.

## 18.5 Required capability areas

### Place pickup/order requests

- Create eligible requests for the authenticated vendor account.
- Select a saved location or approved request-specific override.
- Enforce the normal two-package minimum and exclude the single-package exception from self-service.
- Apply request-level payer default and permitted parcel-level overrides.
- Enforce an itemized-order payment gate when financial allowance is inactive, the account is overdue, or the vendor-paid amount would exceed available global-limit exposure.
- Show confirmation, decline, hold, and actionable reason status.

### Track orders and exceptions

- Show understandable custody and status milestones from booking through the mode-specific terminal outcome: doorstep delivery/return, Station Drop verified handoff, or the final external outcome for Melarc-covered third-party delivery.
- Show approved vendor-safe pickup failure and exception information.
- For standard multi-package requests, show a clear no-estimate/pending-pricing state until itemization; for the one-package exception, show only the approved provisional estimate; always show the authoritative frozen fee after itemization.
- Show the vendor's own payer allocation, commitments, statement/payment status, return fees, approved adjustments, and account-allowance state where needed.
- Do not expose route construction, internal hub discrepancies, other vendors, or privileged notes.

## 18.6 Suspension

Suspension immediately blocks login, new requests, and ordinary work on every non-terminal item through a controlled hold. Records, financial history, and physical custody remain preserved. Disposition of parcels already in Melarc custody is confirmed (Section 29.6): hub Senior Ops decides continued hold or return-to-vendor, hub-scoped with mandatory reason and audit; Platform Admin decides escalation to manual claims/security handling; suspension must never make a parcel or payment untraceable.

## 18.7 Experience requirements

- Use plain customer language rather than internal ERP or tenancy terminology.
- Make placing a request and tracking orders the dominant navigation.
- Prioritize mobile use while remaining responsive on desktop; support installable PWA behaviour consistent with the approved frontend design.
- Explain pending-pricing, `PAYMENT_REQUIRED`, blocked actions, and payment requirements.
- Enforce own-record access on every page, export, notification, file, and API response.

## 18.8 Remaining downstream design

- Exact page inventory and Figma flows.
- Password/session/recovery mechanics consistent with `AUTH-003–004`.
- Business verification fields/evidence.
- Notification preferences and message content.
- Suspension/reactivation/termination/offboarding mechanics.
- Exact API schemas, errors, pagination, files, and accessibility behaviour.

# 19. Melarc Rider requirements

**Section status:** `APPROVED`

## 19.1 Purpose

Melarc Rider is a native Android application that enables riders to execute assigned pickup and delivery work with minimal operational ambiguity. It must remain focused on field execution and work under unreliable connectivity conditions.

## 19.2 Access and ownership

- Only active authenticated riders may use rider actions.
- A rider may access only runs/stops assigned to that rider.
- Unauthorized resource lookup should avoid exposing whether another rider’s record exists.
- Inactive status blocks protected actions and instructs the rider to contact ops.

## 19.3 Today and run views

The primary Today view should:

- Separate inbound and outbound work into distinct blocks.
- Show assigned runs and ordered stops.
- Identify the next recommended non-terminal stop.
- Show operationally approved stop fields, including contact, address, landmark/refined note, zone, delivery-fee payer/amount/payment status, size, and handling flags.
- Make run state, stop state, attempt count, hub-return requirement, and synchronization state immediately visible.

Opening a run must not start it. A deliberate Start Run action changes the run to active and triggers the defined state changes.

## 19.4 Pickup execution

At each pickup stop the rider must be able to:

- View sender and location detail.
- Navigate using available map/address information.
- Complete the stop with collected count and optional vendor note.
- Select a variance reason when collected and declared counts differ.
- Initiate the approved handshake path.
- Fail the stop using one fixed category, required note, and optional contact/evidence data.
- See attempt context without receiving reschedule authority.

## 19.5 Hub handover

After all pickup stops are terminal:

- Show one editable handover row per sender set.
- Pre-fill counts from completion while allowing correction before submit.
- Show a read-only total.
- Reject or redirect a zero-count sender set according to the final zero-count rule.
- Submit idempotently and support offline queue/retry.
- Show pending-sync, successful-sync, or actionable rejected-sync state.

## 19.6 Doorstep delivery and return execution

For a doorstep-delivery stop, Melarc Rider must:

1. Show the authoritative parcel, recorded recipient phone, payer split, recipient amount due, and current attempt number.
2. Where a recipient-paid amount exists, successfully record approved cash or mobile-money payment before parcel handover.
3. Require the rider to enter a valid delivery OTP before the parcel can be marked delivered. The OTP is sent only to the recipient phone recorded by Melarc. The recorded recipient may forward it to another person receiving on their behalf.
4. Treat the valid OTP as the sole Product Owner-mandated proof. Version 1 does not additionally require receiver name, relationship, signature, or delivery photograph.
5. On failure, record the approved failure outcome and return the parcel to its responsible hub after the run. Riders may not retain parcels overnight.
6. Show that a parcel is limited to one initial attempt and two approved reattempts.
7. After attempts are exhausted, execute the assigned return-to-vendor work. Physical return handover closes only when the rider submits a valid return OTP sent to the vendor/sender contact recorded for that return; that contact may forward it to another receiver.

Fully vendor/sender-paid deliveries skip recipient collection but still require the valid delivery OTP. Ad-hoc return handover remains blocked until any required return fee is paid or an approved auditable exception applies.

## 19.7 Courier work

For documented outbound courier work, Melarc Rider must:

- Show the assigned courier-handoff stop.
- Collect registered or informal courier handoff evidence under the approved courier policy.
- Recheck relevant courier state through the backend.
- Mark the stop/order according to the approved handoff state transition.

## 19.8 Offline behaviour

Currently approved source behaviour exists only for hub-handover queuing. The final offline design must define whether delivery failure, payment recording, OTP verification, hub return, or return handover can be initiated offline without weakening server authority. It must also define:

- Local persistence and encryption.
- Client-generated idempotency identifiers.
- Retry order and backoff.
- Conflict/rejection presentation.
- Evidence-upload behaviour when offline.
- Session expiration while queued.
- Device loss and data cleanup.

No additional action should be assumed offline-capable until confirmed.

## 19.9 Usability and safety

- Large touch targets and short forms.
- Clear irreversible-action confirmation.
- Safe defaults and pre-filled context.
- No exposure of irrelevant internal data.
- Visible network/sync state.
- No silent dismissal of rejected work.
- Camera/upload guidance only where evidence is actually required.
- Masked recipient data where full values are not required.

# 20. Recipient communication requirements

**Section status:** `APPROVED`

## 20.1 Recipient model

Recipients are not Melarc account holders in the current product baseline. Recipient interactions are direct-to-phone and must be initiated or recorded by the backend/Ops workflow rather than requiring a portal.

## 20.2 Currently documented interactions

### Heads-up SMS

- Triggered server-side at itemization close if enabled.
- Sent once per parcel.
- Informational; the documented source says it contains no link or code.
- Must not repeat merely because the delivery date is rescheduled.
- Is governed by a global kill switch.

### Delivery-day confirmation call

- Worked by authorized Ops users.
- Is mandatory before a doorstep parcel enters a delivery run, regardless of payer.
- Acts as the dispatch gate; authorized Ops handles unreachable exceptions.
- Records confirmed, reschedule, address correction, or unreachable.
- May capture a refined-location note.
- Each attempt should be logged.
- Orders exceeding the approved call-attempt limit enter a senior decision queue.

### Delivery OTP

- A successful doorstep delivery requires a valid OTP.
- The OTP is sent only to the recipient phone number recorded for that parcel in Melarc Platform.
- A recorded recipient authorizes another person to receive by forwarding the valid OTP to that person.
- The rider submits the OTP for backend validation before delivery closure.
- The Product Owner does not require a receiver name, relationship, signature, or photograph in addition to the valid OTP.

## 20.3 Confirmed milestone communication

Version 1 sends audience-appropriate SMS at the following applicable customer milestones:

- Pickup confirmation.
- Parcel received and itemized.
- Out for delivery.
- Delivered.
- Failed delivery attempt.
- Return started.
- Return completed.

Registered vendors also receive the same applicable milestones in Melarc Vendor. Recipients receive only messages and actions relevant to their delivery, payment, confirmation, OTP, failure, or return context. Exact wording, timing, deduplication, retry, delivery receipts, and provider behaviour remain notification/integration design.

The phrase “exactly two touches” in an earlier source is superseded by this approved milestone policy and the OTP/payment interactions.

## 20.4 Communication-content requirements

Messages and call scripts should:

- Identify Melarc and the parcel context sufficiently to establish trust.
- Avoid exposing vendor/rider/internal notes unnecessarily.
- Use normalized Ghana phone numbers.
- Include only the action, timing, amount, location, or OTP context required by the interaction.
- Never expose OTPs to unauthorized internal views or logs.
- Support approved language and accessibility needs once decided.
- Record delivery status where the provider supports it.
- Use approved retry, deduplication, expiry, masking, and rate limits.

## 20.5 Privacy and consent questions

The specification still needs:

- Legal/privacy basis for sender-provided recipient contact data.
- Opt-out and support handling.
- SMS provider and sender ID.
- Template approval and localization.
- OTP resend, expiry, retry, lockout, support recovery, and fraud controls.
- Delivery receipt and retry policy.
- Retention of call logs and message history.
- Handling of wrong/reassigned phone numbers.

These are tracked by `OQ-028` and the Security sprint.

# 21. Pickup management

**Section status:** `APPROVED`

## 21.1 Pickup-request creation

A pickup request is the front door of the parcel journey.

### Actors

- Ops Staff may create requests for registered vendors or ad-hoc senders.
- An operationally active registered vendor may create requests through its one shared organization login.
- A vendor with financial allowance disabled may still create and confirm pickup requests; every vendor-paid amount calculated at itemization must be paid before the affected order can be confirmed as dispatch-ready.
- A suspended vendor cannot create requests and every non-terminal existing request is placed on controlled hold.
- Riders and recipients have no request-creation role.

### Required request information

- Sender/vendor reference or new ad-hoc sender block.
- For a registered vendor, selected saved pickup location or approved request-specific override.
- Primary pickup phone; optional secondary phone.
- Pickup location and optional landmark.
- Optional request-only map link.
- Item description and optional per-package description override.
- Declared package count.
- Computed/validated scheduled date.
- Defined request metadata such as delivery-fee payer where applicable.

### Business rules

- Standard self-booking requires at least two packages.
- Neither registered vendors nor individual/ad-hoc senders may self-book one package.
- A one-package request may be created by Ops for either customer type and requires Platform Admin approval; recipient name, phone, and delivery address are mandatory.
- One request has one origin.
- Per-request contact/location edits do not rewrite sender defaults or saved vendor locations.
- Registered vendors may maintain multiple saved pickup locations and one default; serviceability is revalidated per request.
- Every zone operates the same Monday–Saturday calendar; no zone-level variation beyond the confirmed Sunday exclusion exists in Version 1.
- Each hub has its own booking cutoff time, proposed by hub Senior Ops and approved by Platform Admin. A request submitted after the responsible hub's cutoff is neither auto-scheduled nor blocked — it queues for Ops review, which may approve a same-day exception or reschedule it to the next operating day.
- Phone collision/matching rules prevent inappropriate duplicate sender/rider identities.

### State direction

`PENDING → CONFIRMED | DECLINED | CANCELLED`. `CANCELLED` is a canonical terminal request state used for authorized cancellation and for the source request when rescheduling creates a replacement. The cancelled record preserves reason, actor, timestamp and attempt-chain/replacement links. Exact post-manifest cancellation eligibility remains domain-design follow-up.

## 21.2 Manifest planning

- Only confirmed, unmanifested requests appear in the pool.
- Ops creates a manifest, adds stops, manually reorders them, assigns an active rider, and dispatches.
- Dispatch sends a run-level rider notification but does not start the run.
- A rider explicitly starts the owned run.
- Starting changes all member pickup work to dispatched/active context atomically.
- Stops may be completed out of planned order, while the system maintains a recommended next stop.
- The manifest completes when all physical stops are `COMPLETED` or `FAILED`.

## 21.3 Pickup completion

The rider records:

- Collected package count.
- Optional vendor note.
- Required variance reason if collected count differs from declared count.

A rider cannot complete a pickup with zero packages. Zero collection must use the pickup-failure flow with an approved category and reason; the system must not create an empty completed stop, sender set, or hub handover.

Physical completion may promote a provisional ad-hoc sender to reusable status without waiting for the handshake response.

## 21.4 Collection confirmation

The confirmation overlay records `pending_vendor`, `confirmed`, `disputed`, or `unconfirmed` independently from physical pickup status.

- Correct code within TTL confirms.
- Wrong code returns remaining attempts.
- Attempt exhaustion invalidates the code and routes to ops.
- TTL expiry routes to ops and blocks late self-confirmation.
- Vendor dispute raises reconciliation without reversing physical completion.
- Manifest completion does not wait for confirmation.

For registered vendors, Melarc Rider displays the one-time code and the vendor enters it in Melarc Vendor. For ad-hoc senders, Melarc sends the code by SMS to the recorded sender; the sender or named pickup reference gives it to the rider for entry in Melarc Rider. Build-status and detailed reconciliation mechanics remain controlled follow-ups.

## 21.5 Pickup failure

A rider may fail a dispatched owned stop by submitting:

- One fixed category: vendor unavailable, access denied, parcel not ready, or refused collection.
- Required reason note.
- Optional contact-attempt method/outcome/wait/note.
- Optional evidence photo.

Physical failure is terminal. The linked request enters an ops decision context.

Version 1 has no dedicated Melarc Vendor self-service dispute form for a pickup failure. The vendor receives the approved notification and contacts Melarc support or Ops for assisted review or correction; contact alone does not reverse the physical failure state.

## 21.6 Ops resolution and attempt chain

Ops may:

- Reschedule by cancelling the source request and creating a new `PENDING` clone.
- Cancel without clone.
- Escalate.

The clone increments attempt number and carries approved metadata. The global default cap is three. Refused collection and cap exhaustion are escalation-only unless hub Senior Ops directly authorizes an extension using a mandatory reason and immutable audit record. Exact extension ceilings and prohibited categories remain domain-design follow-up.

A Celery backstop escalates undecided failures after a configured period.

## 21.7 Notifications and audit

- Request created, confirmed, and declined events.
- Run dispatched and started.
- Pickup completed, completed with variance, failed, confirmed, disputed, or unconfirmed.
- Manifest completed.
- Sender saved/promoted.
- Registered/ad-hoc notifications according to channel rules.
- Audit of reasons, evidence, attempts, decisions, overrides, actor, and timestamp.

## 21.8 Downstream design prerequisites

- Complete transition matrices for requests, manifests, stops, attempts, and collection confirmation.
- Detailed Ops reconciliation and assisted-review workflow.
- Cutoff/service-day policy is confirmed (Section 21.1, `MSC-DEC-147–149`); exact per-hub cutoff time values and the Ops-exception-queue UI/SLA remain operational configuration and technical design.
- Authoritative OpenAPI and UI specifications.

The zero-count route, request cancellation state, pickup-code direction, force-extension authority, and absence of a dedicated vendor self-service pickup-failure dispute are resolved product policy and must not be reopened by technical design.

# 22. Hub and warehouse operations

**Section status:** `APPROVED`

## 22.1 Purpose

Hub receiving is the custody boundary between rider road operations and Melarc’s controlled hub inventory. It must be a distinct act, not an automatic consequence of rider pickup completion.

## 22.2 Rider handover

- Available after all pickup-run stops are terminal.
- Shows one count row per sender set/request/pickup identifier.
- Pre-fills rider completion count but permits correction before submission.
- Shows total rollup.
- Submits idempotently.
- Supports the approved offline queue/retry interaction.
- A zero collected count must use the pickup-failure flow and must not create a completed handover or empty intake.

## 22.3 Awaiting-receive queue

The Ops Portal should show:

- Handover/run/rider identifiers.
- Sender-set/intake references.
- Arrival/submission timing.
- Whether another user is actively receiving.
- Required evidence/status indicators.

It must not expose the rider-declared count before the receiver submits the blind physical count.

## 22.4 Blind receive

1. Authorized receiver opens an intake.
2. Receiver enters physical parcel count without seeing the declaration.
3. Backend retrieves and reveals the server-owned rider declaration.
4. System calculates variance.
5. Required discrepancy/condition workflow is completed.
6. Intake records `received_at`, `received_by`, and `hub_received_count`.
7. Intake becomes eligible for itemization when reconciliation conditions pass.

The client must never submit the hidden declared count as authoritative input.

## 22.5 Discrepancy and condition handling

The approved Version 1 OS&D structure separates:

- Count variance: `MATCH`, `OVER`, or `SHORT`.
- Parcel condition: `OK`, `DAMAGED`, `TAMPERED`, or `OTHER`.
- Dispute status: recorded independently from count and condition.

Damage, tampering, or dispute may be recorded even when the physical count matches. Supporting evidence and controlled review are required for damaged, tampered, or disputed cases.


Damaged/Dispute cases require senior review in the approved product model.

## 22.6 Intake lifecycle

Target direction:

```text
PENDING → RECEIVED → IN_PROGRESS → COMPLETED | CANCELLED
```

- `RECEIVED` means the independent hub receive control is complete.
- `IN_PROGRESS` means itemization has begun.
- `COMPLETED` means the intake passed closure rules and emitted the custody-complete event.

The exact cancellation and reopening rules require later state design. See Section 36.6 for the more detailed non-final state sketch of the same lifecycle.

## 22.7 Count-parity control

The physical parcel count recorded by the hub is the intake-close authority. An intake may close only when its itemized parcel/order records account for that physical received count. The rider-declared count remains immutable discrepancy history and is not used as the close target.

Detailed domain design must still specify how damaged, quarantined, cancelled, removed, or temporarily unitemizable physical parcels are represented; who may reopen or correct a closed intake; and which exception events and evidence are required.

## 22.8 Concurrency

Receiving is sensitive to duplicate users and race conditions. The approved product boundary permits an advisory soft lock showing the active receiver and allowing takeover after an idle TTL. Backend transition and idempotency controls are still required; a visual lock alone is not sufficient.

## 22.9 Vendor visibility

Vendors receive only the approved intake-completed/order summary. Blind counts, rider declaration, discrepancy evidence, and internal adjudication remain ops-only unless a future controlled dispute feature is approved.

# 23. Itemization and pricing

**Section status:** `APPROVED`

## 23.1 Itemization purpose

Itemization converts each physically received parcel into an operational Order with the recipient, routing, handling, payer, and commercial attributes required for downstream delivery. One physical parcel should be represented by one itemized Order unless a later approved model states otherwise.

## 23.2 Required order capture

- Recipient name and phone.
- Delivery address/GhanaPost GPS and resolved responsible-hub service zone.
- Size class: Small, Medium, Large, or Extra Large — a required Version 1 classification input; the associated surcharge applies at pricing composition (Section 23.4).
- Declared value, high-value flag, and required evidence.
- Electronics/serialized-goods flag and serial/IMEI where applicable.
- Delivery-fee payer arrangement: recipient, vendor/sender, or split.
- Vendor/sender portion and recipient portion once the delivery price is known.
- Approved service level and requested date.
- Inbound/outbound lane.
- Source intake, pickup, contracting party, and responsible-hub linkage.

Merchandise COD must not be captured because Melarc does not collect vendor product value.

## 23.3 Address, service zone, and base price

- Each hub owns its service-zone catalogue. The launch hub's catalogue is seven zones: Tema, Accra Central, Lapaz/Sowutuom, Madina/Adenta, Dansoman, Amasaman & Environs, and Kasoa Corridor.
- The Version 1 base delivery fee depends on **both the parcel's origin zone and its destination zone** — a zone-pair matrix — not one flat fee per zone. Same-zone (diagonal) delivery, e.g. Dansoman → Dansoman, is valid and has its own price, typically the lowest tier.
- Two of the seven zones — Amasaman & Environs and Kasoa Corridor — are never priced as an ordinary matrix cell when they are the **destination**. A delivery into either uses that zone's corridor rate card instead (Section 23.11); they remain ordinary matrix zones when they are the origin.
- The base fee is not calculated from live distance in Version 1.
- Save/final pricing is blocked until both the origin and destination resolve to an active zone (or, for a corridor destination, an active corridor) belonging to the responsible hub.
- Ambiguous resolution requires a clear authorized selection; out-of-coverage addresses cannot be priced under the normal flow.
- Zone-pair resolution and pricing are server-validated even when the frontend provides live feedback.
- The system preserves the hub, origin zone, destination zone, price-table version, and effective value used for the parcel.
- **Origin zone** is the zone of the pickup request's one origin (Section 21.1: "one request has one origin") — the vendor's selected saved pickup location, or the ad-hoc sender's pickup location. It is resolved and snapshotted once per request, the same way destination zone is snapshotted per parcel; a mid-request pickup-location correction re-resolves it before price freeze, under the same controlled-correction rule as a destination change.

## 23.4 Size and high value

- Small, Medium, Large, and Extra Large are the Version 1 parcel-size categories. Small is a fixed GH₵0 baseline; Medium, Large, and Extra Large each carry their own configurable flat surcharge.
- The size surcharge is universal: `final price = base fee + size surcharge`, applied on top of whichever base fee is in play — the zone-pair matrix price (Section 23.3) or a corridor rate (Section 23.11). It is never itself a base fee.
- The size surcharge and the high-value surcharge (below) are independent parcel attributes, not alternatives, and stack additively when both apply — a Large, high-value parcel pays the zone-pair/corridor base fee plus the Large surcharge plus the high-value surcharge. The size surcharge does not apply to `STATION_DROP` or `MELARC_COVERED_THIRD_PARTY_DELIVERY` outbound charges (Section 23.9, Section 24), which remain their own separate fixed-fee structures untouched by `MSC-DEC-164–167`.
- Exact surcharge amounts for Medium, Large, and Extra Large remain open, entered later through the admin dashboard; only the category structure and the GH₵0 Small baseline are confirmed.
- Parcel-size classification *mechanics* — how a parcel is measured or assigned a category at itemization — remain a separate operational/technical-design detail, not resolved by `MSC-DEC-165`.
- Dimensional and live-distance pricing remain deferred.
- Declared value may auto-flag high value using the first configured tier.
- Ops may manually flag a lower-value parcel as high value.
- High-value parcels require verified itemization-time evidence.
- Serialized electronics require serial/IMEI.
- The high-value surcharge funds enhanced handling/evidence diligence only; it does not promise a fixed reimbursement, cap, or insurance-style guarantee. A high-value parcel's loss/damage is adjudicated through the existing Damaged/Dispute process (Section 22.5), using declared value and evidence as inputs. Exact tier structure and surcharge amounts remain open.

## 23.5 Delivery-fee payer allocation

The pickup request carries a default payer arrangement and selected parcels/orders may override it. Itemization establishes the authoritative delivery fee and actual GHS allocation for each parcel:

- recipient pays the full fee by default;
- vendor/sender may pay the full fee; or
- vendor/sender and recipient may split the fee.

For Version 1 group coverage, multiple parcels in the current pickup request may be selected for full vendor/sender coverage; no reusable group record is created. A split may use a fixed Ghana-cedi amount or percentage. The arrangement remains editable by the vendor/sender or authorized Ops until the authoritative price is frozen. After freeze, Ops submits a correction and Senior Ops approves or rejects it with complete before/after history. Later attempts do not create a redelivery fee. Ultimate failed-delivery and return charging follow `PAY-021–027`. Split precision/rounding and post-payment/statement correction restrictions remain open.

## 23.6 Booking estimate and authoritative price freeze

- A standard (≥2-package) pickup request shows **no monetary price estimate at booking**: the zone-pair matrix (Section 23.3) needs both origin and destination zone, and destination is not captured until itemization for the standard case.
- The one-package Ops-created exception is different: it mandatorily captures recipient/delivery-address data at booking (Section 21.1), so both zones are known. It may show a provisional **base-fee estimate only** using the effective zone-pair or corridor rate. The UI must state that size and high-value surcharges are excluded until itemization unless those inputs were explicitly captured and validated at booking.
- Hub itemization confirms the origin and destination zone and every approved pricing input, calculates the authoritative zone-pair/corridor fee plus applicable size and high-value surcharges, applies the vendor-credit or payment gate, and freezes the fee at itemized-order confirmation. For the standard case, this is the parcel's **first** price; for a one-package exception, it replaces the provisional base-fee estimate.
- The system must clearly label any shown estimate versus the frozen final price and preserve both the estimate inputs (where an estimate exists) and the frozen pricing snapshot.
- A locked price cannot change silently; post-freeze correction uses the approved reasoned maker-checker workflow.
- Cross-zone post-freeze address corrections use controlled repricing under `MSC-DEC-118`. Vendor-facing UX for the standard case's no-estimate state remains a UI-design follow-up.

## 23.7 Service level and schedule

Melarc offers no express service in Version 1. Legacy express/off-service-day surcharge rules are inactive. Service-day scheduling (uniform Monday–Saturday) and booking cutoff (per-hub, Senior Ops proposes/Platform Admin approves) are confirmed at Section 21.1.

The `AMASAMAN_ENVIRONS` and `KASOA_CORRIDOR` zones additionally carry a day-of-week price variation (Section 23.11): batch day(s) use the lower batch rate and any other operating day uses the higher **non-batch rate**. `NON_BATCH_RATE` is the stable machine term and is not an Express service.

## 23.8 Lane classification

After itemization, authorized Ops assigns or corrects the final delivery lane from confirmed destination and serviceability. The product boundary distinguishes Melarc doorstep delivery from approved third-party handoff; third-party commercial treatment then uses either `STATION_DROP` or `MELARC_COVERED_THIRD_PARTY_DELIVERY`. Exact field names, enum values, UI controls, and post-dispatch restrictions belong to domain/OpenAPI/UI design, and every correction must remain audited.

## 23.9 Pricing values still required

The product-policy calculation model is approved (zone-pair matrix, universal size surcharge, and corridor rates — `MSC-DEC-164–167`), but settings/technical artifacts must still define:

- exact Ghana-cedi price for every zone-pair matrix cell in the launch hub's catalogue;
- exact Ghana-cedi surcharge for Medium, Large, and Extra Large sizes (Small is fixed at GH₵0);
- exact Ghana-cedi batch, non-batch, and intra-corridor rates for Amasaman & Environs and Kasoa Corridor;
- price-table versioning and effective dates;
- high-value and approved outbound/courier charges;
- exact flat return-fee amount (governance and waiver-reason structure confirmed — Section 28.4, `MSC-DEC-162–163`);
- taxes, permitted discounts, rounding, and receipts;
- approved overrides and cross-zone address-correction treatment; and
- historical traceability to the exact pricing snapshot.

Every value above is entered through the admin dashboard, not this specification; none is treated as final by `MSC-DEC-164–167`. Version 1 has no subscription pricing model and no live-distance base-price calculation.

## 23.10 Intake closure

- Closure must account for all hub-received parcels.
- An itemized parcel may be in `PAYMENT_REQUIRED` and still count toward physical intake parity, provided the parcel/order record is valid and custody remains represented.
- `PAYMENT_REQUIRED` blocks dispatch readiness; it does not justify leaving the physical intake unclosed or making the parcel untraceable.
- An override requires a substantive reason and appropriate authority.
- Closure emits `intake.completed` and generates the vendor-facing order summary.
- Exact damaged/quarantined/unitemizable exception mechanics remain downstream design.

## 23.11 Corridor pricing

- The canonical corridor codes are `AMASAMAN_ENVIRONS` and `KASOA_CORRIDOR`; their display names are **Amasaman & Environs** and **Kasoa Corridor**.
- When either corridor is the delivery destination, it is priced independently of the ordinary zone-pair matrix.
- Each corridor has:
  - a lower **batch rate** on its designated batch day(s);
  - a higher **non-batch rate** on any other operating day; and
  - an **intra-corridor rate** for pickup and delivery within the same corridor on a batch day.
- Amasaman & Environs batch days are Tuesday and Friday. Kasoa Corridor's batch day is Friday.
- `NON_BATCH_RATE` is the stable machine/API term. “Express service” remains excluded from Version 1 and must not be used as the machine concept for this price tier.
- Corridor rates are base fees. The Section 23.4 size surcharge applies on top of the applicable corridor rate.
- Corridor rates, batch-day assignments, and intra-corridor rates are independent configuration records from the zone-pair matrix.
- Both corridors remain serviceable Monday–Saturday; a non-batch-day delivery is fulfilled at the non-batch rate.
- Exact GH₵ batch, non-batch, and intra-corridor amounts remain required launch configuration under the approved pricing-governance workflow.

# 24. Dispatch management

**Section status:** `APPROVED`

## 24.1 Purpose

Dispatch management prepares a priced, hub-held order to leave Melarc custody only after the itemized-order credit/payment gate has passed, the parcel has an Ops-confirmed delivery lane, and, for doorstep work, the recipient has passed the required confirmation gate.

## 24.2 Recipient confirmation queue

- Orders enter with `delivery_confirmation_status = pending` at itemization close.
- Ops works call attempts and records a fixed outcome.
- `confirmed` makes the order run-eligible.
- Reschedule, address correction, and unreachable hold the order.
- Attempts are logged.
- Unreachable after the approved cap enters a senior decision queue.
- A refined-location note may be saved and copied onto the delivery stop.

If the corrected address resolves to another zone after price freeze, Ops requests controlled repricing and hub Senior Ops approves or rejects it before the new price takes effect. Both price versions and payer impact remain auditable.

## 24.3 Ready pool and lane guards

- Version 1 supports Melarc doorstep delivery and approved third-party courier/station handoff.
- Authorized Ops selects or corrects the final lane after itemization using confirmed destination and serviceability.
- Only payment-cleared or credit-approved, confirmed, available orders appear in the doorstep ready pool; recipient confirmation is required regardless of payer.
- Pool may be filtered by lane and operational groupings.
- Adding a stop rechecks confirmation, availability, and lane compatibility.
- Lane changes and race conditions must fail visibly or follow a controlled, audited correction path.

A courier run may mix registered and informal handoff-mode stops, and may mix `STATION_DROP` and `MELARC_COVERED_THIRD_PARTY_DELIVERY` commercial-mode stops — Ops is not required to build separate runs for either axis.

## 24.4 Delivery-run build

- Ops creates a draft run.
- Selects active rider.
- Selects active registered courier where required by outbound mode.
- Adds eligible stops.
- Manually orders/reorders stops.
- Copies refined-location notes to stops.
- May safely swap riders, re-homing stop routing data according to the final domain design.

## 24.5 Atomic dispatch

Dispatch must be all-or-nothing:

- Revalidate rider activity.
- Revalidate courier activity where applicable.
- Revalidate every order’s credit/payment gate, readiness, and availability.
- Commit run/order/stop state changes together.
- Roll back all changes if one validation fails.
- Send one run-level rider notification after success.

## 24.6 Rider start and run state

Target run direction:

```text
DRAFT → DISPATCHED → IN_PROGRESS → COMPLETED
```

- Dispatch is an Ops action.
- Start Run is a deliberate Rider action.
- Completion requires all stops to reach approved terminal states.
- Complete stop state machines remain missing for inbound delivery and onward courier outcome. See Section 36.9 for the more detailed non-final state sketch of the same lifecycle.

## 24.7 Outbound third-party service modes

Version 1 uses a Melarc-managed approved courier/station registry and manually records the waybill, custody handoff, and mandatory evidence. No external courier API is required. Outbound commercial treatment is determined by one of two authoritative service modes.

### 24.7.1 Station Drop

- Melarc transports the parcel to an approved third-party station/courier and performs the verified handoff.
- Melarc charges the effective company-wide **Station Drop fee**, whose launch value is **GH₵25**.
- Hub Senior Ops proposes a fee change and Platform Admin independently approves or rejects it. Changes are effective-dated, apply only to newly created Station Drop charges, and every charge snapshots the applied value and setting version.
- The captured Station Drop fee must be fully paid and backend-confirmed before a rider is dispatched to the station.
- The recipient separately pays the third party's onward or last-mile charge at destination.
- Melarc's Station Drop service completes, and its captured Station Drop fee is earned, only when the mandatory waybill and receipt/handoff photo are recorded against a valid handoff.
- A failed or cancelled handoff requires a controlled retry, refund, reversal, or correction path and cannot be closed as successful.

### 24.7.2 Melarc-Covered Third-Party Delivery

- Melarc arranges and covers the approved third-party movement from Accra/the responsible hub to the recipient's destination.
- The customer is quoted and charged one total containing the third-party waybill cost plus Melarc's delivery fee.
- The complete combined amount must be paid and backend-confirmed before rider dispatch to the station/agent.
- The recipient pays nothing at destination.
- The order remains under Melarc's commercial responsibility after station handoff until final delivery, failure, or return is recorded.
- The system retains the waybill-cost and Melarc-fee components separately for audit/reporting while presenting and collecting one customer total.

### 24.7.3 Carrier identity and evidence

The outbound commercial mode is separate from the carrier identity/evidence mode:

- A registered active courier/station requires a waybill number and mandatory receipt or handoff photo before closure.
- Where an approved informal agent mode remains permitted, the record must capture the approved driver/agent identity and evidence defined by technical design.
- Rider, responsible hub, custody time, evidence, carrier, waybill, outbound mode, charge/payment state, and onward outcome remain auditable.

## 24.8 Doorstep dispatch boundary

For doorstep work, dispatch does not equal delivery. The parcel reaches its terminal successful outcome only after OTP and applicable payment validation under Section 25.

## 24.9 Outbound financial boundary

Every outbound third-party charge is prepaid before rider dispatch to the station/agent. Station Drop creates a charge using the effective company-wide fee snapshot (GH₵25 at launch) and reaches its Melarc service-earning event at verified handoff. Melarc-covered third-party delivery creates one customer charge composed of the waybill cost plus Melarc fee and remains open through the final external outcome. Detailed agent payable/settlement, cost variance, cancellation/refund, reversal, and accounting-recognition entries must be defined in finance/domain/OpenAPI/integration design without changing these commercial rules.

# 25. Delivery management

**Section status:** `APPROVED`

Doorstep delivery, proof of delivery, failed-delivery handling, reattempt, hub return, and return-to-vendor are digital Version 1 capabilities. The Product Owner has approved the normal-path delivery and return policy below.

## 25.1 Successful doorstep delivery

A parcel reaches the normal successful-delivery terminal outcome only when:

1. The stop belongs to the executing rider and is eligible for delivery.
2. Any recipient-paid delivery-fee portion has been successfully recorded through an approved cash or mobile-money flow.
3. Melarc Rider submits a valid delivery OTP.
4. The backend validates that OTP against the parcel and recorded recipient contact.
5. The state transition succeeds once and creates the required audit/payment effects.

The OTP is sent only to the recipient phone number recorded in Melarc Platform. If another person will receive the parcel, the recorded recipient forwards the OTP to that person. Possession and successful validation of the OTP is the Product Owner-approved authorization and proof. Version 1 does not additionally require the receiver’s name, relationship, signature, or delivery photograph.

Fully vendor/sender-paid parcels skip recipient payment collection but never skip OTP verification. The rider cannot ordinarily override invalid or missing OTP.

## 25.2 Payment and handover sequence

- Recipient payment, when due, must be recorded before physical parcel handover.
- A parcel with an unpaid recipient portion cannot be marked delivered through the normal workflow.
- Payment and delivery completion must be idempotent and linked to the same parcel/stop.
- Cash/mobile-money collection and reconciliation policy is confirmed in Section 26.3–26.4; failure recovery, offline behaviour, and receipt mechanics remain downstream technical-design follow-ups (Section 26.4, Section 26.6).

## 25.3 Delivery attempts

- Version 1 permits three total doorstep attempts: one initial attempt and up to two approved reattempts.
- A reattempt does not create a separate redelivery charge.
- Attempt number, outcome, reason, rider, run, timestamps, contact attempts, and hub custody effects must remain auditable.
- After the third unsuccessful attempt, the parcel cannot receive another ordinary doorstep attempt and must enter return-to-vendor processing.

## 25.4 Custody after an unsuccessful attempt

After every unsuccessful attempt:

- The rider retains custody only for the remainder of the active run or approved immediate return movement.
- The parcel must be returned to its responsible hub after the run.
- Riders may not retain delivery parcels overnight.
- Hub receipt restores explicit Melarc hub custody and places the parcel into a controlled reattempt or return queue.
- Ops schedules any approved reattempt and the next rider/run assignment.

Exact after-hours handling, hub-receipt UI, storage-location fields, and offline synchronization are downstream design matters, but they may not contradict the mandatory hub-return rule.

## 25.5 Return-to-vendor handover

When all approved attempts are exhausted:

- The parcel enters the digitally tracked return-to-vendor workflow.
- The original delivery fee is cancelled/reversed.
- The flat vendor-paid return fee becomes earned at return-workflow start.
- Physical return handover closes only after Melarc Rider submits a valid return OTP sent to the vendor/sender contact recorded for that return.
- The recorded vendor/sender contact may forward that OTP to another person receiving on their behalf.
- No receiver name, role/relationship, signature, or return photograph is additionally required by Product Owner policy.
- For an ad-hoc sender, any required return-fee payment must be satisfied before handover unless an authorized auditable exception applies.

Vendor/sender refusal or unavailability, loss/damage, invalid-contact recovery, and exceptional OTP administrative recovery remain preserved exception questions; they do not undo the normal-path rule.

## 25.6 Surface responsibilities

**Melarc Rider** executes payment capture, OTP submission, failure recording, hub return, reattempt work, and return OTP handover.

**Melarc Ops Portal** provides live run/attempt visibility, failed-attempt and hub-return queues, reattempt scheduling, return initiation, payment/reconciliation visibility, and authorized exception handling.

**Melarc Vendor** shows authorized tracking, payer allocation, attempt history, return state, return-fee/account effects, and relevant notifications without exposing security secrets.

## 25.7 Remaining design and policy follow-ups

The Master Specification still preserves decisions for payment/reconciliation details, failure-reason catalogue, reattempt timing, vendor refusal/unavailability, claims/loss/damage, OTP security/recovery, notification templates, and canonical machine-state names. These must be resolved in later sprints or assigned technical artifacts without reopening the approved normal delivery policy.

# 26. Delivery-fee payments and reconciliation

**Section status:** `APPROVED`

> **Terminology rule:** Melarc does not provide merchandise COD. This section covers Melarc delivery fees only.

## 26.1 Payer model

- Every pickup request records a default payer arrangement; selected parcels/orders may override it.
- Recipient pays by default; vendor/sender may cover the full fee or define a split using a fixed amount or percentage.
- Before price freeze, the vendor/sender or authorized Ops may change the arrangement. After freeze, Ops submits a controlled correction and Senior Ops approves or rejects it.
- The allocation remains traceable through estimate, final pricing, delivery, payment, reversal, statement, and reconciliation.
- Later delivery attempts create no redelivery fee. After ultimate failure, the original fee reverses and the separate vendor-paid flat return fee applies under the confirmed return policy.

## 26.2 Collection channels

### Recipient cash

A recipient may pay the amount due in cash at the door. The rider records collection in Melarc Rider. Cash remains in rider custody until submitted to the responsible hub after the run or before workday close.

### Recipient mobile money

Melarc Rider initiates or displays the Hubtel payment flow, but the recipient pays Melarc directly. The backend must confirm success before parcel handover or delivery closure. A rider personal mobile-money account is never an approved collection channel.

### Approved registered-vendor amount

Vendor-paid portions accrue under the approved vendor account model, subject to the global vendor account limit, overdue/prepayment rules, and weekly statement cycle. Version 1 weekly statements are paid through Hubtel/mobile money only. Bank transfer and cash-at-hub are excluded statement-payment channels.

### Individual/ad-hoc sender amount

An ad-hoc sender-paid portion is paid after itemization calculates it and before the affected order becomes dispatch-ready; no Version 1 credit facility applies. Return-fee payment is required before physical return handover unless an approved auditable waiver/exception exists.

## 26.3 Rider cash reconciliation

- Reconciliation occurs at the responsible hub after the rider's run or before the rider's workday closes.
- The system compares expected cash by parcel/payment, rider-declared handover, and hub-confirmed receipt.
- The run or workday cannot be financially closed until the amount is reconciled or an explicit shortage/overage exception is opened.
- Cash collection, custody, handover, receipt, variance, correction, and closure are separate auditable events.
- Exact cutoff, shift model, verifier/approver roles, evidence, variance thresholds, and escalation are finance/domain/technical-design follow-up unless they change product policy.

## 26.4 Mobile-money confirmation and reconciliation

- The backend/payment provider—not the rider—is authoritative for payment success.
- Pending, failed, expired, cancelled, or duplicate payment attempts cannot satisfy the delivery payment gate.
- Every successful payment must be attributable to the parcel/order, payer amount, provider transaction, responsible hub, and statement where applicable.
- Hubtel provider product, webhook/callback contract, idempotency, receipts, refunds, reversals, outage recovery, and offline behaviour remain integration/finance design follow-up.

## 26.5 Minimum financial distinctions

Version 1 must digitally distinguish:

- no-estimate/pending-pricing state for standard bookings, any provisional estimate that actually existed, and the frozen delivery fee;
- recipient amount versus vendor/sender amount;
- cash expected, collected, handed over, received, short, or over;
- mobile-money attempt, pending result, success, failure, expiry, or reversal;
- itemized-order credit eligibility, `PAYMENT_REQUIRED`, successful prepayment, vendor-account reservation, earned charge, statement balance, payment, overdue balance, and adjustment;
- money collected or prepaid versus revenue earned; and
- original delivery-fee reversal versus separate return-fee accrual.

## 26.6 Remaining design areas

Product policy now defines the collection channels, cash timing, direct-to-Melarc recipient MoMo, and vendor statement payment channel. Remaining work includes payment allocation across split payers, exact cash roles/forms, variance resolution, receipts, refunds/reversals, provider failure/manual recovery, the itemized-order prepayment lifecycle, account disputes, accounting exports, and post-payment/settlement correction rules. Ordinary partial weekly-statement settlement remains prohibited under `OQ-005`, `OQ-041–042`. These details must be completed in finance/domain design, OpenAPI, integration design, UI specification, and acceptance tests before implementation.

# 27. Vendor settlement

**Section status:** `APPROVED`

Vendor balance and settlement are digital Version 1 capabilities. Settlement does not mean remitting merchandise value. It concerns vendor-paid delivery-fee portions, prepayments, account reservations, earned charges, weekly statements, mobile-money payments, return fees, credits/debits, reversals, corrections, refunds and periodic reconciliation between Melarc and the contracting vendor.

## 27.1 Confirmed account lifecycle

- Hub Senior Ops operationally approves the vendor; Platform Admin separately activates the global vendor account allowance after basic verification and with a recorded reason. No mandatory probation or completed-delivery threshold applies.
- Platform Admin may disable the allowance with a mandatory reason. Vendor-paid amounts calculated after disablement require payment before the affected itemized order becomes dispatch-ready, while existing confirmed itemized orders and outstanding obligations remain valid. Allowance disablement is distinct from vendor suspension.
- One Admin-configured global vendor account limit applies uniformly; there are no per-vendor limits.
- Confirmed vendor-paid itemized orders reserve exposure at itemized-order confirmation, and earned unpaid charges continue to consume the same exposure without double-counting.
- Over-limit, overdue, or allowance-disabled vendor-paid portions calculated at itemization require successful payment before the affected order becomes dispatch-ready; recipient-paid portions remain allowed.
- Existing confirmed/in-flight work continues under accepted terms when the account becomes overdue.
- Weekly statements issue Monday at 8:00 AM `Africa/Accra`, cover the preceding Monday–Sunday period, and are due Thursday at 8:00 AM.
- An unpaid payable balance becomes `OVERDUE` immediately at the cutoff; full clearance restores normal terms automatically.
- Version 1 imposes no monetary late fee or percentage penalty.
- Version 1 statement payment is through Hubtel/mobile money only.

## 27.2 Minimum required records

- Vendor operational approval and account-allowance activation/disablement history
- Global-limit snapshot and exposure evaluation
- Itemized-order credit reservation/release
- Delivery-fee and return-fee charge/accrual
- Split-payer allocation
- Earned-fee posting on successful delivery
- Failed/returned/cancelled reversal or adjustment
- Immutable statement period, lines, issue, due, dispute, payment, overdue and cure events
- Hubtel/mobile-money payment attempts and confirmed transactions
- Credit, refund, waiver, reversal, correction, dispute and audit trail

## 27.3 Statement payment and dispute policy

The vendor must pay the full currently payable statement balance through one successful attributable Hubtel/mobile-money payment. Ordinary partial payment is not supported. A statement is not reduced, satisfied or cleared merely because a vendor or Ops user claims to have paid; backend/provider confirmation is required.

When a vendor disputes a statement line:

- the issued statement and original line remain immutable;
- the disputed line enters controlled Ops review;
- the vendor must pay the full undisputed payable balance;
- the disputed amount is not used as an unpaid payable amount while the review is active; and
- an approved correction creates a linked adjustment rather than rewriting history.

Rejection, reactivation of the disputed amount, notification, and due/overdue recalculation must be defined in finance/domain design. Bank transfer and cash-at-hub are not normal Version 1 statement channels.

## 27.4 Downstream design controls

The remaining work does not require another broad Product Owner policy interview, but it remains mandatory before implementation:

- precise reservation/release event matrix and transaction/concurrency controls;
- provider pending, failed, duplicate, reversal and outage recovery;
- dispute evidence, review service levels, rejection/reopening and notifications;
- payment receipt, immutable ledger, adjustment and accounting-export formats;
- prepayment authorization/capture/failure/refund behaviour; and
- finance permissions, reconciliation controls, monitoring and acceptance tests.

These controls are assigned to `DOMAIN_MODEL.md`, finance technical design, OpenAPI/integration specifications, UI specification and test plans under `OQ-005` and the resolved-for-master-spec `OQ-041`.

# 28. Returns and exceptions

**Section status:** `APPROVED`

## 28.1 Existing exception coverage

The approved baseline defines exception handling for:

- Pickup request decline.
- Pickup collection variance.
- Collection dispute/unconfirmed/lockout.
- Pickup failure and exhausted attempts.
- Hub over/short/damaged/dispute conditions.
- Intake count mismatch.
- Post-QUEUED price correction.
- Unreachable recipient.
- Inactive rider/courier and dispatch races.
- Courier handoff evidence.

## 28.2 Common exception requirements

Every material exception should define:

- Trigger and detecting actor/system.
- Fixed category where behaviour branches.
- Required note/evidence/contact attempts.
- Current custody and physical location.
- Whether normal processing is blocked.
- Responsible decision queue and SLA.
- Available resolutions and permission level.
- Notifications to vendor/sender/recipient/rider.
- Financial consequences.
- Audit events.
- Terminal or resumed state.

## 28.3 Failed delivery and return to hub

Version 1 allows three total doorstep attempts. After each unsuccessful attempt:

- the rider returns the parcel to its responsible hub after the run;
- riders do not retain parcels overnight;
- the hub records receipt and custody;
- Ops either schedules the next approved attempt or, after the third failure, starts return-to-vendor processing; and
- no separate redelivery fee is created.

## 28.4 Return to vendor/sender

After the third unsuccessful delivery attempt:

- The parcel enters the return-to-vendor workflow.
- The original delivery fee is cancelled/reversed.
- A separate flat vendor-paid return fee is earned and billed at return-workflow start.
- Approved vendors receive the charge through the approved account/statement model.
- An ad-hoc sender must satisfy the return-fee payment gate before physical handover unless an authorized auditable exception applies.
- Physical return custody closes through a valid return OTP sent to the recorded vendor/sender contact. The contact may forward the OTP to another receiver. No additional name, relationship, signature, or photograph is required by Product Owner policy.

The flat return-fee amount is a single company-wide setting: hub Senior Ops proposes a new value and Platform Admin independently approves or rejects it before the new amount takes effect for every hub, not only the proposing one — reusing the existing hub-setting maker-checker pattern even though the fee itself is not hub-scoped. A waiver (Section 5.3, `MSC-DEC-031`) is limited to three confirmed reason categories — a Melarc-caused operational error, an unresolved documented dispute still open at return-workflow start, or a one-time goodwill/service-recovery exception for a vendor account in good standing — with no fixed numeric cap; Senior Ops still approves each waiver instance individually with a mandatory audit record. The exact initial GH₵ amount remains open.

This same OTP-based closure mechanism is reused, not replaced, when a return is triggered by vendor suspension rather than exhausted delivery attempts (Section 29.6). The return fee above applies to a suspension-triggered return exactly as it applies to any other return, with no cause-based carve-out.

The return record must preserve the failed-attempt chain, hub custody, return initiation, fee/reversal events, assigned return movement, OTP validation, and final terminal outcome.

## 28.5 Remaining return exceptions

Still requiring policy or downstream design are:

- Vendor/sender unavailable or refusing the returned parcel.
- Invalid, lost, or inaccessible recorded phone number.
- Exceptional administrative OTP recovery without weakening fraud controls.
- Unpaid ad-hoc return storage, escalation, and final disposition.
- Damage or loss during failed-attempt, hub-hold, or return custody.
- Cancellation or correction after return processing starts.

These remain in `OQ-004` and `OQ-042`, to be closed by a future decision sprint or downstream security/operations design as appropriate to each item.

## 28.6 Damage, loss, and claims

The source records high-value evidence and receive-time damage but does not define:

- Liability limits.
- Claim submission and evidence.
- Investigation roles and deadlines.
- Compensation approval.
- Vendor/recipient communication.
- Financial ledger effects.
- Police/incident reporting.

## 28.7 Exception hierarchy

Routine exceptions should be resolved by Ops within policy; high-risk, disputed, exhausted, financial, security, or claim cases should escalate to clearly named Senior Ops, Platform Admin, finance, or other authorized roles. The final hierarchy depends on the role/security and claims decisions.

# 29. Vendor administration

**Section status:** `APPROVED`

## 29.1 Purpose and boundary

Vendor administration is an internal Melarc Ops capability for managing a customer record, shared portal credential, saved pickup locations, operational status, financial allowance, suspension, and history. It is not a SaaS tenant-administration module and is not exposed as organization/user administration inside Melarc Vendor.

## 29.2 Version 1 onboarding

1. Authorized Ops creates the registered vendor record and initial shared portal account.
2. Hub Senior Ops independently approves or rejects operational activation.
3. The creator cannot approve the same record.
4. Platform Admin may enable the global vendor account allowance and weekly statement terms after basic verification and with a recorded reason; no mandatory probation threshold applies.
5. Platform Admin may later disable the allowance with a mandatory reason. Until activation, or after disablement, vendor-paid and split vendor portions calculated at itemization require payment before the affected order becomes dispatch-ready, while existing confirmed itemized orders and outstanding obligations remain valid.

Required business identity/contact/agreement evidence, duplicate/reapplication, and saved-ad-hoc promotion fields remain downstream design.

## 29.3 Portal access model

- One shared vendor credential exists per registered vendor.
- No multiple vendor users, invites, role hierarchy, tenant administration, or vendor-managed permissions exist in Version 1.
- One active session/device is permitted; a new login ends the old session.
- Vendor recovery uses registered phone/email, with Platform Admin for exceptional recovery.
- The vendor account sees only its own booking/tracking and directly related approved records.

## 29.4 Saved pickup locations

A registered vendor may maintain multiple saved pickup locations and one default. Locations belong to that vendor record and remain subject to responsible-hub serviceability checks at booking. Request overrides do not silently mutate saved locations.

## 29.5 Operational and financial states

The vendor record separately represents operational status, financial allowance/prepayment state, and payment state such as current or overdue. Operational approval must not silently enable account allowance, and overdue controls must not be confused with suspension.

## 29.6 Suspension

Suspension blocks the shared login and all non-terminal ordinary work through a controlled hold while preserving custody, money, and history. The system must identify where each held item physically is.

Held-parcel disposition is confirmed: hub Senior Ops decides continued hold or return-to-vendor (reusing the Section 28.4 OTP-based closure), hub-scoped, with mandatory reason and audit; escalation to a manual claims/security hold — for cases neither hold nor return resolves, such as suspected fraud or an abandoned/undeliverable parcel — requires Platform Admin. No fixed maximum hold duration applies; hold persists until reactivation or a disposition decision. The vendor/sender contact is always notified of a return or escalation; the recipient is also notified if a delivery attempt had already started.

Suspension authority and grounds are confirmed: hub Senior Ops may suspend a vendor within their own hub — the same actor who decides that vendor's held-parcel disposition above — with a mandatory reason and audit record; Platform Admin may also suspend a vendor directly. The reason must cite one of four starting grounds categories: non-payment/overdue beyond policy; suspected fraud or abuse; safety or legal violation; repeated service-quality failure.

A suspension-triggered return uses the same flat return fee as any other return, with no cause-based carve-out; a Melarc-caused suspension error is a candidate for the existing "Melarc-caused operational error" waiver category (Section 5.3, `MSC-DEC-163`), evaluated case by case, not a new blanket exemption.

Reactivation, termination, and offboarding retention remain follow-up.

## 29.7 Ad-hoc sender boundary

Ops creates provisional ad-hoc senders. The sender's phone number is verified by a one-time SMS code confirmed at first use — reusing the same OTP mechanism already used for pickup codes, delivery proof, and return handover — before the record is promoted. After the first successful pickup, the verified sender becomes searchable and reusable for future assisted bookings. A saved sender may later pass through the same Ops-created/Senior-Ops-approved registered-vendor process. Ad-hoc senders do not receive portal access.

Prohibited, illegal, and restricted items are rejected; the starting catalogue is illegal drugs/narcotics, weapons/firearms/ammunition, explosives or hazardous/flammable materials, live animals, and cash or negotiable financial instruments. Ops refuses at intake with a mandatory reason, applying judgment within a category.

Individual/ad-hoc senders have no credit or pay-after-delivery facility in Version 1; every sender-paid amount is payable after itemization calculates it and before the affected order becomes dispatch-ready.

Who may refuse or block an individual sender from future bookings, and on what grounds, remains open.

## 29.8 Internal profile and audit

Authorized Melarc staff require a searchable profile showing identity/contact, serving hub, approval/suspension history, financial allowance, global-limit exposure, statements/payments/returns, saved locations, parcel history, and audited privileged changes. Exact pages, schemas, evidence, retention, and exports remain downstream artifacts.

# 30. Rider and staff administration

**Section status:** `APPROVED`

## 30.1 Purpose

Rider and staff administration must govern internal identities, roles, employment/operational status, devices, assignments, and access to Melarc systems.

## 30.2 Known source requirements

- Platform Admin, Senior Ops, Ops Staff, and Rider roles exist conceptually.
- Riders must be active before assignment or action.
- Rider phone identity must not collide with an ad-hoc sender identity under the documented invariant.
- A rider can act only on owned runs.
- Inactive rider status blocks dispatch/action.

## 30.3 Required staff lifecycle

- Staff profile creation and verification (onboarding authority confirmed at 30.8).
- Role (permission-bundle) assignment and changes.
- Location/hub/team/shift assignment if applicable.
- Activation, suspension (authority confirmed at 30.9), leave, termination, and archival (offboarding confirmed at 30.10).
- Credential setup and recovery.
- Device/session management. Device re-registration/loss/replacement authority beyond normal recovery remains open.
- Permission-review history.
- Audit of privileged changes.

## 30.4 Required rider lifecycle

- Rider onboarding and identity/contact capture (authority confirmed at 30.8).
- Employment/contract status.
- Active/inactive/temporarily unavailable state (manually set, confirmed at 30.6).
- Assigned device and phone.
- One permanent Melarc-owned motorcycle assignment, with complete assignment and formal-transfer history.
- Service area and shift availability.
- Training/compliance acknowledgement.
- Run-assignment eligibility.
- Suspension (authority confirmed at 30.9) and offboarding (confirmed at 30.10).

## 30.5 Hub membership and temporary assignment

Every rider and staff member has one primary hub. A temporary assignment to another hub must be requested by Senior Ops at the primary hub and approved by Senior Ops at the receiving hub before it becomes active. The record preserves the purpose, requested/effective period, requester, approver, target hub, status, cancellation, and history. The assignment grants only time-bounded receiving-hub access and eligibility; it does not change primary membership or grant company-wide visibility. Duration, overlap, extension, emergency assignment, and permanent-transfer rules remain open.

## 30.6 Workload and availability

The dispatcher's active/available rider (and staff, where relevant) view is driven by a manually-set status only in Version 1: Ops/Senior Ops directly toggles active/available/unavailable. No shift-derived, run-derived-only, or location/GPS-derived automatic computation exists in V1; this does not foreclose a future shift-derived or hybrid model, only defers it.

## 30.7 Broader ERP dependency

Payroll and staff compensation are deferred. Fleet, fuel, and maintenance are confirmed for Version 1. The fleet foundation is motorcycles only, Melarc-owned only, with one permanent motorcycle assignment per rider until formal transfer. Hubs may hold serviceable unassigned spares; hub Senior Ops directly performs permanent transfers; and a confirmed pre-run breakdown causes run reassignment to another rider rather than an automatic motorcycle transfer. A rider breakdown report first creates a pending incident; hub Senior Ops confirms or rejects it, and confirmation makes the motorcycle unavailable for new runs. An active-run breakdown uses an audited custody handover to a replacement rider, with hub return where field handover is unsafe. An authorized maintenance user records repair/inspection completion, while hub Senior Ops independently approves return to service. The full motorcycle identity register is confirmed; Version 1 tracks insurance and roadworthiness only; and expiry creates a blocking compliance alert requiring a hub Senior Ops availability decision rather than automatic unavailability. For fuel, Melarc bears and pays the expense, while the system stores a simple fuel record containing the motorcycle, rider, date/time, amount, litres, provider, and receipt/evidence for audit and reporting. Version 1 does not require a rider-reimbursement claim, claim limits, reimbursement channels, or multi-stage approval workflow. Preventive maintenance includes rider-completed Sunday routine checks and oil changes due at the earlier hub-configured calendar or mileage trigger. Hub Senior Ops must record the availability decision before a motorcycle with overdue maintenance begins another run. Planned repairs require Senior Ops authorization; emergency work may proceed when prior approval is impractical but must be documented and reviewed afterward. The minimum maintenance record contains motorcycle, date, work completed, cost, repairer/vendor, and evidence. No separate intra-day Sunday cutoff, Product Owner-defined compliance-renewal approval workflow, or dedicated Version 1 motorcycle-retirement workflow is required. Checklist/evidence mechanics, emergency controls and general asset archival move to technical design; fleet report metrics move to the Reporting sprint. Attendance, performance, incident, and broader HR capabilities remain unclassified.

## 30.8 Onboarding authority

Creating and activating a new staff or rider profile uses a maker-checker pattern: an Ops Staff, Senior Ops, or Platform Admin user creates the profile, and a Senior Ops or Platform Admin independently approves it before it becomes active; the creator cannot approve their own profile creation.

## 30.9 Suspension authority and in-progress work

Hub Senior Ops may suspend an Ops Staff member or Rider within their own hub, with mandatory reason and audit record. Suspending a Senior Ops or Platform Admin requires Platform Admin. When a suspended Rider has an active run in progress, the run transfers to a replacement rider using the confirmed breakdown custody-handover mechanism (Section 30.7) rather than a new mechanism. A suspended Ops Staff member's in-progress queue items simply become unavailable to them.

Suspension grounds are confirmed: the reason must cite one of four starting categories — safety violation; policy/conduct violation (including fraud or theft); repeated performance/attendance failure; security breach (credential/device misuse) — same structure as vendor suspension grounds (Section 29.6). Who has authority to initiate or approve offboarding, and device re-registration/loss/replacement authority beyond normal recovery, remain open.

## 30.10 Offboarding

Offboarding a staff member or rider immediately revokes system access and credentials. Any motorcycle assigned to an offboarded rider must go through the existing formal-transfer process (Section 30.7). All historical records — parcel history, audit trail, permission-review history — are preserved and never deleted. Who has authority to initiate or approve an offboarding decision remains open.

# 31. Notifications

**Section status:** `APPROVED`

## 31.1 Notification principles

- Business events, not frontend pages, should trigger authoritative notifications.
- Approved customer-facing major milestones use SMS as a mandatory transactional channel.
- Registered vendors also receive the same applicable milestones in the Melarc Vendor in-app feed.
- Ad-hoc senders and recipients use audience-appropriate direct phone/SMS channels.
- Rider run assignment uses a run-level notification.
- SMS is described as soft-fail and kill-switchable for selected events.
- Sensitive raw operational notes must not be exposed in customer-facing messages.

## 31.2 Source-identified notification events

| Event/milestone | Intended audience/channel |
|---|---|
| Pickup request confirmed/declined | Registered vendor: in-app + preferences; ad-hoc: SMS |
| Pickup run dispatched | Rider push/in-app |
| Collection completion/handshake | Registered vendor in-app or approved flow; ad-hoc SMS path |
| Pickup failure | Ops event; registered vendor in-app/email; ad-hoc PII-safe SMS |
| Failure escalation | Senior Ops internal queue/notification |
| Hub handover submitted | Ops receive queue |
| Intake completed | Registered vendor in-app order summary; ad-hoc tracking SMS |
| Recipient heads-up | Recipient SMS, once per parcel if enabled |
| Delivery run dispatched | Rider run-level notification |
| Courier handoff | Vendor notification with approved courier information |
| Pickup confirmation; received/itemized; out for delivery; delivered; failed attempt; return started/completed | Applicable customer SMS; registered vendor also receives applicable in-app milestone |

## 31.3 In-app notification feed

The final Vendor and Ops notification model should define:

- Notification type and stable event reference.
- Title/body and structured payload.
- Read/unread and timestamp.
- Deep link to owned/authorized record.
- Deduplication.
- Retention and archive.
- Preference/mandatory status.
- Vendor ownership and responsible-hub scoping.

## 31.4 SMS/email/push delivery

The subsystem must define:

- Providers and credentials.
- Sender ID/domain/push service.
- Template versioning and approval.
- Phone/email normalization.
- Retry/backoff and dead-letter handling.
- Provider delivery receipts.
- Idempotency/deduplication.
- Rate limits and abuse controls.
- Kill-switch behaviour and operational alerting.
- Costs and reporting.
- Localization/language.

“Soft-fail” must not mean silent failure for a sole communication channel. If an ad-hoc sender or recipient message fails, the system should expose operational follow-up according to an approved policy.

## 31.5 Mandatory and optional messages

The approved major milestone SMS messages are transactional Version 1 service messages. They must not be silently disabled through ordinary vendor preferences. Registered-vendor in-app copies are also required where applicable.

Notification design must still distinguish:

- Security/OTP messages.
- Mandatory service/transaction milestones.
- Optional supplemental updates.
- Marketing communications, if ever introduced.
- Channel fallback and provider-failure handling.
- Consent, privacy, and legally required opt-out treatment.

## 31.6 Monitoring

Ops/support should be able to identify queued, sent, delivered, failed, retried, suppressed, and dead-letter notifications. Provider outages and abnormal failure rates require alerts.

# 32. Reporting and analytics

**Section status:** `APPROVED`

## 32.1 Reporting principles

Reporting must derive from authoritative operational and financial records rather than independent spreadsheet truth. Every view/export must apply the same responsible-hub, role, vendor ownership, timezone, money, status and audit rules as the underlying application.

## 32.2 Live operations dashboard

Each hub receives a live dashboard covering at least:

- pickup queues, manifests/runs and pickup outcomes;
- hub receiving, blind-count/reconciliation, itemization and blocked work;
- dispatch readiness, active delivery runs, attempts, deliveries and returns;
- delivery-fee payment, cash-reconciliation and exception queues; and
- motorcycle availability, compliance, breakdown and maintenance state.

Platform Admin and explicitly authorized HQ/company-wide roles receive a consolidated all-hub view. Hub users remain restricted to their authorized hub context. Dashboard tiles must identify freshness and link to authorized detail queues.

## 32.3 Standard Version 1 report families

Version 1 includes:

1. **Operational reports** — volumes, ageing, queues, pickup/hub/dispatch throughput and exceptions.
2. **Delivery-outcome reports** — successful doorstep delivery, attempts, failure reasons, returns, Station Drop verified handoffs, and final external outcomes for Melarc-covered third-party delivery.
3. **Payment and reconciliation reports** — expected/received delivery fees, Hubtel outcomes, rider cash reconciliation, shortages/overages and unresolved exceptions.
4. **Vendor-statement reports** — statement issuance, balances, payment, overdue state, adjustments and account-limit exposure.
5. **Fleet/fuel/maintenance reports** — motorcycle register/availability, assignment, compliance, breakdown, weekly checks, oil-change status, repairs, downtime and recorded fuel expenses.

Authorized report data may be exported as CSV.

## 32.4 Access, privacy and audit

- Report access follows role, hub and vendor-record ownership rules.
- Company-wide/HQ export access is explicit, not implied by ordinary Senior Ops status.
- Sensitive contact, payment and evidence fields require masking or exclusion based on report purpose.
- Export generation, requester, filters, scope, timestamp and file access should be auditable.
- A CSV export must not expose data unavailable in the corresponding authorized application view.

## 32.5 Downstream reporting design

A reporting specification/data dictionary must still define:

- exact KPIs and formulas;
- event versus status date basis;
- timezone and reporting-period boundaries;
- ageing buckets, targets and thresholds;
- columns, filters, grouping, sorting and totals;
- freshness/latency expectations;
- large-export handling and retention;
- PII masking; and
- reconciliation to operational and financial ledgers.

These details do not reopen the approved dashboard and report-family scope.

# 33. System settings

**Section status:** `APPROVED`

## 33.1 Settings model

The source baseline originally treated documented settings as global/system-wide, but the approved multi-hub model supersedes that assumption for business pricing and operational settings: those values are maintained independently per hub. Platform-wide identity, security, infrastructure, integration-secret, and governance settings may remain global. The global vendor account limit remains one platform-wide control.

Settings must be stored and changed through a controlled mechanism with:

- Stable key and type.
- Description and unit.
- Current/effective value.
- Default/fallback.
- Validation range/format.
- Editing permission.
- Effective date if changes are versioned.
- Actor, timestamp, old/new value, and reason audit.
- Safe cache/config propagation.
- Behaviour when missing or invalid.

## 33.2 Current setting inventory

| Setting | Source default/status | Required decision |
|---|---|---|
| `transaction_currency` | `GHS` — Ghana cedi, only launch transaction currency | Platform-wide product policy; use ISO 4217 code `GHS` and fixed-decimal money representation. Multi-currency requires a later Product Owner decision. |
| Hub service-zone catalogue | Launch hub: 7 named zones confirmed (Tema, Accra Central, Lapaz/Sowutuom, Madina/Adenta, Dansoman, Amasaman & Environs, Kasoa Corridor) — `MSC-DEC-164` | Hub Senior Ops proposes; Platform Admin approves/rejects further creation, boundary, deactivation, and service-day changes; define zone fields, versioning, effective dating, overlap, rollback, and historical snapshots |
| `zone_pair_matrix` | OPEN — exact GH₵ value per origin/destination cell not yet defined | Model confirmed by `MSC-DEC-164`: price depends on both origin and destination zone; same-zone (diagonal) pricing valid; a corridor-zone destination is priced by `corridor_rates` instead. Editing authority confirmed by `MSC-DEC-167`: hub Senior Ops proposes, Platform Admin approves. Exact cell values remain pricing configuration, entered via the admin dashboard |
| `size_category_surcharges` | Small = GH₵0 fixed baseline — confirmed; Medium/Large/Extra Large amounts OPEN | Universal composition rule (`final price = base fee + size surcharge`) and category structure confirmed by `MSC-DEC-165`. Editing authority confirmed by `MSC-DEC-167`: hub Senior Ops proposes, Platform Admin approves. Exact Medium/Large/Extra Large amounts remain pricing configuration |
| `corridor_rates` | OPEN — exact GH₵ batch/non-batch/intra-corridor value per corridor not yet defined | Structure confirmed by `MSC-DEC-166` and terminology by `MSC-DEC-180`: `AMASAMAN_ENVIRONS` (batch days Tue/Fri) and `KASOA_CORRIDOR` (batch day Fri) each have a batch rate, a `NON_BATCH_RATE`, and an intra-corridor rate. Hub Senior Ops proposes and Platform Admin approves. Exact amounts remain required pricing configuration. |
| Hub pricing configuration | Hub-specific; values not yet defined | Hub Senior Ops proposes; Platform Admin approves/rejects; define price structures, effective dating, emergency handling, and historical snapshots |
| Hub operational settings | Hub-specific; values not yet defined | Hub Senior Ops proposes; Platform Admin approves/rejects; classify settings, bootstrap values, emergency handling, and safe missing-value behaviour |
| `booking_cutoff_time` | Per-hub setting; exact time values not yet defined | Cutoff scope, late-booking handling, service-day uniformity, and editing authority confirmed by `MSC-DEC-147–149`; hub Senior Ops proposes, Platform Admin approves; exact per-hub time values remain operational configuration |
| `MELARC_MAX_PICKUP_ATTEMPTS` | 3 — confirmed default | Preserve the approved three-attempt default and define only technical storage, extension ceilings, and audit mechanics |
| `auto_reschedule` | Off — Version 1 deferred | Version 1 uses controlled Ops rescheduling; any future activation requires a new approved decision and safe migration |
| `stale_failure_backstop_hours` | OPEN — operational/technical design | Define SLA/default, escalation ownership, monitoring, and safe missing-value behaviour |
| `handshake_code_length` | 4 — source default, security review required | Confirm through security architecture without changing the approved actor/channel direction |
| `handshake_code_ttl_minutes` | 15 — source default, security review required | Define expiry, regeneration, and exception controls in security/OpenAPI design |
| `handshake_max_wrong_attempts` | 5 — source default, security review required | Define lockout, recovery, monitoring, and abuse controls in security design |
| `adhoc_failure_sms_enabled` | On — source default | Define kill-switch permission, outage behaviour, and audit in notification/operations design |
| `heads_up_sms_enabled` | On — source default | Define kill-switch permission, operational consequence, and customer fallback |
| `flat_return_fee_amount` | OPEN — exact GH₵ value not yet defined | Editing authority confirmed by `MSC-DEC-162`: hub Senior Ops proposes, Platform Admin approves company-wide — reusing the hub-setting maker-checker pattern even though the fee itself is one company-wide value; exact amount remains pricing configuration |
| `return_fee_waiver_reasons` | CONFIRMED — three standard categories, no hard numeric cap | Reason list (Melarc-caused operational error; unresolved documented dispute at return-start; one-time goodwill/service-recovery exception) and no-cap structure confirmed by `MSC-DEC-163`; Senior Ops approves each waiver instance individually with a mandatory audit record (`MSC-DEC-031` authority unchanged) |
| `MELARC_HIGH_VALUE_TIERS` | OPEN — tier structure/amounts not yet defined | Liability promise (none beyond standard adjudication) and claims relationship (existing Damaged/Dispute process) confirmed by `MSC-DEC-156–157`; tier structure, thresholds, and effective dates remain operational/pricing configuration |
| `high_value_threshold` | Legacy audit snapshot | Retain only for historical compatibility until the approved high-value model replaces it |
| `high_value_surcharge` | Legacy audit snapshot | Retain only for historical compatibility until the approved high-value model replaces it |
| `station_drop_fee` | Company-wide; launch value GH₵25 | Hub Senior Ops proposes and Platform Admin approves/rejects; changes are effective-dated, apply to new Station Drop charges only, and every charge snapshots the applied value/version. |
| `MELARC_EXPRESS_SURCHARGE` | NOT APPLICABLE IN VERSION 1 | Express service is outside Version 1 and must not create a launch charge |
| `cod_ceiling` | SUPERSEDED / NOT APPLICABLE | Merchandise COD is not supported; the legacy setting must not govern target behaviour |
| `intake_parcel_cap` | 100 — source default, technical review required | Validate operational capacity, error handling, and safe change governance |
| `delivery_confirmation_max_attempts` | OPEN — operational/technical design | Define contact/confirmation attempt limits and escalation without changing the separate three doorstep-delivery-attempt rule |
| Motorcycle compliance warning lead times | OPEN — operational/technical design | Define advance-warning intervals, expiry-review SLA/escalation, reminder cadence, and responsible recipients |
| Fuel-record governance | CONFIRMED | Melarc pays fuel; the system records each fuel expense for audit and reporting without a rider-reimbursement claim workflow |
| Fuel-record exception thresholds | OPEN — operational/technical design | Define anomaly thresholds, review routing, correction controls, and reporting without introducing a rider claim/reimbursement workflow |
| Retention periods (per category: photos, audit events, call logs, notifications, sender records, parcel history) | Per-category configurable; exact values not yet defined | Model, legal-hold exemption, and Platform Admin editing authority confirmed by `MSC-DEC-150–152`; exact period per category requires compliance/legal input |

## 33.3 Settings governance

- Security-sensitive values such as secrets are not ordinary business settings and require secret management.
- Changing a setting must not silently mutate historical transactions.
- Price-related settings require versioning/effective dating and snapshot traceability.
- Kill switches require visible operational status and restoration procedure.
- Settings that alter permissions or financial limits may require maker-checker approval.
- Hub-specific pricing, operational-setting, and service-zone changes require a hub Senior Ops proposal and independent Platform Admin approval/rejection; they must preserve hub ownership, old/proposed/approved values or boundaries, reason, effective dating, actors, and historical transaction snapshots.
- Missing required hub configuration must fail visibly and safely; the system must not silently borrow another hub's values or an undocumented global default.
- Invalid settings must fail safely and alert administrators.

## 33.4 Configuration hierarchy

Version 1 has no global-business-default-to-hub-override hierarchy for pricing and operational settings. The responsible hub's approved effective values are authoritative. Hub Senior Ops proposes a change and Platform Admin approves or rejects it before activation. Platform-wide controls remain global only when explicitly classified that way, such as the global vendor account limit or security/integration governance. Any future per-zone or per-vendor override layer must separately define precedence, inheritance, effective dates, conflict display, and audit; no developer may infer it from database nullability or configuration convenience.

# 34. Domain concepts

**Section status:** `APPROVED`
**Approval status:** APPROVED WITH DOWNSTREAM TECHNICAL DESIGN REQUIRED — confirmed concepts below are product-policy authority; a separate detailed domain model remains a downstream artifact

This section establishes a conceptual vocabulary for the product. It is not a substitute for a physical database design, entity-relationship diagram, migration plan, or field-level data dictionary. Those artifacts must later preserve the product meanings defined here.

## 34.1 Ownership layers

The source material implies four overlapping ownership domains:

1. **Platform-owned operational data** — shared operational records used by Melarc staff and riders, such as runs, manifests, hub processing, dispatch queues, operational events, and exception adjudication.
2. **Vendor-owned commercial visibility** — pickup requests, parcels, orders, notifications, and future statements visible to a registered vendor only when they belong to that vendor.
3. **Rider-assigned execution data** — the minimum run, stop, navigation, contact, and evidence data required for the authenticated rider to execute an assignment.
4. **Recipient/ad-hoc communication data** — records associated with people who do not have portal accounts and are contacted directly by phone or SMS.

Melarc does not require a vendor SaaS tenancy model. The eventual architecture must enforce vendor-record ownership so the simple vendor portal sees only its own records, while authorized Melarc roles can work across vendors within their hub/company scope without duplicating or fragmenting operational truth. Physical table/schema/database layout is a technical choice, not a separate product capability.

## 34.2 Core party concepts

| Concept | Working definition | Important distinction |
|---|---|---|
| Registered Vendor | A recurring business customer with an approved Melarc account and Vendor Portal access | Not equivalent to an ad-hoc sender |
| Vendor Account | The one shared Version 1 credential used by a registered vendor to place requests and track its own orders | Not an individual employee identity and not a tenant-admin account |
| Ad-hoc Sender | A sender served through operations without Vendor Portal access | Begins as provisional and becomes searchable only after a completed pickup |
| Recipient | The person expected to receive an order | Does not have a portal account in the documented baseline |
| Ops Staff | Day-to-day Melarc operations user | Executes intake, manifest, hub, confirmation, and dispatch work |
| Senior Ops | Elevated operations user | Handles selected approvals, adjudications, and registries |
| Platform Admin | Highest documented operational authority | Scope of technical/system administration is still incomplete |
| Rider | Authenticated field operator assigned to execute runs | May act only on assigned work and may operate offline within controlled limits |
| Courier Provider | A registered external provider used for outbound handoff | Distinct from an informal driver/contact captured per shipment |

## 34.3 Pickup concepts

| Concept | Working definition |
|---|---|
| Pickup Request | A sender's request for Melarc to collect a declared number of packages from one origin on a scheduled service date |
| Request Override | A phone, location, landmark, map link, description, or schedule value specific to one request that does not silently rewrite the sender's saved defaults |
| Pickup Manifest | An operations-built, ordered collection of eligible pickup stops assigned to one rider |
| Pickup Stop | The run-level execution record linking a pickup request to its route position and collection outcome |
| Pickup / Collection Record | The physical collection result, including declared/collected count, evidence, contacts, and outcome |
| Collection Handshake | Two-party pickup proof: rider-displayed/vendor-entered for registered vendors; sender-SMS/rider-entered for ad-hoc pickups |
| Pickup Attempt Chain | The linked history of failed, rescheduled, replacement, and ultimately completed/cancelled pickup attempts |

## 34.4 Hub and processing concepts

| Concept | Working definition |
|---|---|
| Hub Handover | Rider-to-hub transfer of a completed pickup or manifest, including count and evidence |
| Pickup Intake | The hub-controlled record that begins with blind physical count and governs reconciliation and itemization |
| Blind Count | The physical count entered without exposing the rider-declared count until submission |
| OS&D | Operational discrepancy recording with separate count-variance, parcel-condition, and dispute-status dimensions |
| Processing Batch / Wave | A grouping used to organize intake/itemization work; exact cardinality and lifecycle require a detailed domain model |
| Itemized Parcel / Order | The individually identified delivery unit created from a hub intake, with recipient, destination, size/value, payer allocation, lane, price, and lifecycle state |

## 34.5 Dispatch and delivery concepts

| Concept | Working definition |
|---|---|
| Delivery Lane | The authorized post-itemization routing choice between Melarc doorstep delivery and approved third-party handoff; exact persisted enum names belong to domain/OpenAPI design |
| Recipient Confirmation | The pre-dispatch confirmation process that validates recipient availability/details and makes a doorstep order eligible for dispatch |
| Delivery Run | An ordered group of eligible stops assigned to one rider, subject to lane compatibility rules. A run may freely mix registered-courier/informal-carrier stops and `STATION_DROP`/`MELARC_COVERED_THIRD_PARTY_DELIVERY` commercial-mode stops; each order's own carrier-identity and commercial-mode facts remain independently tracked regardless of which run carries it. |
| Delivery Stop | The execution record for one order within a delivery run |
| Third-Party Handoff | The evidence-backed custody transfer to an approved courier/station, including waybill and mandatory receipt/handoff photo |
| Station Drop | The GH₵25 prepaid mode in which Melarc earns its service fee at verified third-party handoff and the recipient separately pays the onward third-party charge at destination |
| Melarc-Covered Third-Party Delivery | The prepaid combined waybill-plus-Melarc-fee mode in which the recipient pays nothing at destination and Melarc remains responsible through the recorded final external outcome |
| Proof of Delivery | A valid recipient OTP recorded after any required recipient-paid delivery fee is backend-confirmed and before parcel handover; evidence retention remains a downstream policy/design item |
| Failed Delivery | An unsuccessful doorstep attempt recorded with the approved reason/contact/evidence data, followed by return to the responsible hub; three total attempts are permitted before return-to-vendor processing begins |
| Return | The controlled reverse journey to the vendor/sender after exhausted delivery attempts or another approved condition, with original delivery-fee reversal, separate flat return-fee treatment, and valid vendor/sender OTP for normal physical handover |

## 34.6 Commercial concepts

| Concept | Working definition | Status |
|---|---|---|
| Quoted/Calculated Price | A provisional price shown only when approved inputs exist; standard multi-package bookings have no estimate before itemization | Product policy confirmed; detailed calculation service and price-snapshot schema pending |
| Locked Price | Historical transaction price frozen at itemized-order confirmation and changeable only through the approved correction path | Product policy confirmed; detailed domain representation pending |
| Delivery-fee allocation | Vendor/sender and recipient portions of Melarc’s delivery fee, calculated authoritatively at itemization | Product policy confirmed; split rounding/adjustment mechanics remain downstream |
| Payment Requirement | Commercial gate applied when an itemized vendor-paid amount cannot use credit; the order cannot become dispatch-ready until full payment succeeds | Product policy confirmed by `MSC-DEC-176`; detailed payment state schema pending |
| Merchandise COD | Vendor product value collected from the recipient | Not supported by Melarc |
| Payment | A recorded transfer of funds by an actor using an approved method (cash/Hubtel MoMo mini-POS at the door, Hubtel MoMo statement payment) | Product policy confirmed; detailed ledger/domain design pending |
| Vendor Balance | The financial position owed to or by a vendor — confirmed vendor-paid commitments plus earned unpaid charges against the company-wide credit limit | Product policy confirmed; detailed reservation/release ledger mechanics pending |
| Settlement | The controlled calculation, approval, and payment of vendor funds — weekly statement cycle, full-payable-balance payment, disputed-line review | Product policy confirmed; detailed ledger/accounting-export mechanics pending |
| Third-party waybill cost | External courier/station cost retained separately for audit and reporting; customer treatment depends on the approved outbound commercial mode | Detailed payable, variance, reversal, and accounting entries belong to finance/domain design |

All monetary values use ISO 4217 currency code `GHS` and fixed-decimal representation in Version 1. Multi-currency is outside the launch baseline and requires a later Product Owner decision.

## 34.7 Identity, timestamps, and evidence

- Business records should use stable, non-guessable identifiers and may also expose human-readable operational codes.
- All persisted timestamps must be timezone-aware and are stored as UTC instants. The operating timezone is `Africa/Accra` (Ghana time). The display convention is 24-hour local time with no timezone label (`MSC-DEC-203`); exports and anything readable outside Ghana carry an explicit offset (`contracts/domain-model.md` §3.3).
- Photographs, signatures, OTP evidence, and uploaded documents are controlled evidence objects, not unstructured incidental attachments.
- Evidence records require owner, purpose, captured-at time, actor/device context, storage reference, access rules, and retention policy.
- Historical business records must remain interpretable after users, settings, prices, reasons, or providers are changed or deactivated.

## 34.8 Required follow-on artifact

Before database implementation is finalized, create `DOMAIN_MODEL.md` containing:

- An entity-relationship diagram and cardinalities.
- Field-level ownership, nullability, uniqueness, indexes, and deletion/archival rules.
- Vendor ownership and responsible-hub scoping for every entity.
- Canonical enums and state-transition constraints.
- Money, timestamp, phone, location, and evidence conventions.
- Idempotency and concurrency boundaries.
- Migration and historical snapshot rules.
## 34.9 Hub ownership and staffing

`Hub` is mandatory operational context. Records covered by `HUB-020` reference one responsible hub. A rider/staff identity references one primary hub, while temporary hub assignments are separate effective-dated records requested by primary-hub Senior Ops and approved by receiving-hub Senior Ops; they must not overwrite primary membership. Before rider pickup begins, a controlled reassignment may replace the responsible hub and all dependent pre-custody context. After custody begins, direct reassignment is prohibited. Service zones, pricing, and operational settings are owned by a hub and must be resolved within that hub; pricing/setting changes require hub Senior Ops proposal and Platform Admin approval. Inter-hub parcel transfer is not a Version 1 state transition.

## 34.10 Fleet ownership and rider assignment

### Motorcycle identity and assignment

- Version 1 operational fleet assets are Melarc-owned motorcycles only.
- `Motorcycle` is the canonical fleet asset, with internal asset ID, registration plate, make, model, model year, colour, chassis number, engine number, acquisition date, responsible hub, current assignment, odometer, and operational status.
- Each active rider has at most one active permanent motorcycle assignment; each motorcycle has at most one active permanently assigned rider.
- A hub may hold active, serviceable motorcycles as unassigned spares.
- Hub Senior Ops performs a permanent transfer with a mandatory reason, closes incompatible assignments, and preserves complete history.

### Breakdown and active-run custody

- A rider report creates a pending `BreakdownIncident`; only hub Senior Ops confirmation makes the motorcycle unavailable for new runs.
- Before a run begins, a confirmed breakdown causes run reassignment to another available rider with a functioning assigned motorcycle; it does not silently transfer the original motorcycle assignment.
- During an active run, a `RunCustodyHandover` transfers affected parcels and remaining stops to a replacement rider, or routes them to the responsible hub where field handover is unsafe.
- A rider-ID edit is never a substitute for the custody-handover record.

### Maintenance and return to service

- A `MaintenanceScheduleItem` represents a due preventive activity.
- The assigned rider completes the guided weekly routine check every Sunday.
- Oil changes become due at the earlier approved calendar or odometer trigger.
- An overdue item blocks the motorcycle's next run until hub Senior Ops records the availability decision.
- A `MaintenanceRecord` stores at minimum motorcycle, date, work completed, cost, repairer/vendor, and evidence.
- Planned repair work requires prior Senior Ops authorization; emergency work records why prior approval was impractical and requires retrospective review.
- Maintenance completion and Senior Ops return-to-service approval are separate actions.

### Compliance and fuel

- `MotorcycleComplianceRecord` tracks insurance and roadworthiness only; registration plate remains part of motorcycle identity.
- Expiry creates a prominent review alert, and hub Senior Ops records whether the motorcycle becomes unavailable.
- A `FuelRecord` represents a Melarc-paid operating expense, not a rider reimbursement claim, and stores hub, motorcycle, rider, purchase time, amount, litres, provider, evidence, recording actor, timestamps, and auditable corrections.

Dedicated motorcycle retirement remains deferred. Technical design must ensure inactive assets cannot be assigned and historical records remain interpretable. Exact checklist/evidence formats, emergency continued-use controls, document-update mechanics, and fleet-report measures remain downstream design work.

## 34.11 Vendor organization and account allowance

A `VendorOrganization` is the contracting business party. Version 1 gives it one shared `VendorCredential`, multiple `VendorPickupLocation` records, an operational lifecycle, and a separate `VendorAccountAllowance` state. Operational approval by Senior Ops makes the organization eligible for ordinary service. Platform Admin may activate allowance after basic verification and may disable it with a mandatory reason; both actions are audited and remain separate from suspension. `VendorSuspensionHold` must preserve every affected non-terminal work item, its physical custody, reason, actor, timestamps, and eventual disposition. Exact entities, status codes, relationships, credentials, and physical data layout belong to `DOMAIN_MODEL.md` and security architecture.


## 34.12 Identity and portal access

`StaffIdentity`, `RiderIdentity`, and `VendorAccount` are distinct authentication concepts. Staff use email/password and privileged MFA; riders use phone/PIN with one registered device; the shared vendor account permits one active session/device. Vendor record ownership is an access-control attribute, not a SaaS tenant-management feature. Recovery events, device registrations, MFA enrolment, session replacement, and privileged cross-vendor access require audit history.

# 35. Business rules

**Section status:** `APPROVED`
**Approval status:** APPROVED PRODUCT POLICY — the consolidated rule catalogue below reflects confirmed decisions; Stage 4 contradiction resolution is complete

The following rules consolidate the product's strongest behavioural constraints. They are written as product rules rather than implementation instructions. Their current authority comes from the normative rules stated in this specification and the applicable retained specification documents.

## 35.1 General authority rules

1. The backend is authoritative for eligibility, permissions, state transitions, pricing, counts, financial effects, and audit events; frontend validation improves usability but cannot replace server enforcement.
2. Surface access and action permission are separate checks. Being allowed into a portal does not imply permission to perform every action shown in that portal.
3. Vendor users may access only their vendor's data; riders may access only work assigned to them; operations cross-vendor access must be explicit and audited.
4. Business settings affect future decisions unless a documented correction or migration rule explicitly applies them retroactively.
5. Historical transactions must preserve the values, reasons, prices, provider details, and actors applicable when the transaction occurred.
6. Privileged overrides require a reason, actor, timestamp, before/after values, and an audit event.

## 35.2 Pickup-request rules

1. A normal pickup request represents one origin and one scheduled pickup event.
2. Registered vendors may self-book eligible pickups; operations may book for registered vendors or ad-hoc senders.
3. A normal self-booked pickup requires at least two packages.
4. A one-package request requires a controlled maker-checker exception and is unavailable through ordinary vendor self-service.
5. Eligibility depends on operating-day, cutoff, and pickup-zone service-day rules.
6. Per-request contact/location edits are transaction overrides and do not silently update saved sender defaults.
7. A new ad-hoc sender remains provisional until a physical pickup is successfully completed.
8. Confirmed, unmanifested requests are eligible for manifest selection.
9. A declined or cancelled request must preserve its reason and history.
10. The detailed domain state model must include every downstream state used by cancellation/rescheduling and must preserve the approved terminal `CANCELLED` semantics.

## 35.3 Pickup-manifest and rider rules

1. Operations determines stop membership, order, rider assignment, and dispatch.
2. Route optimization is not part of the documented launch baseline; stop ordering is manual.
3. One manifest is assigned to one eligible active rider.
4. Dispatching a manifest makes it available to the rider but does not itself start physical execution.
5. A rider may act only on an assigned run and may not independently add or substitute pickups.
6. Collection completion records the actual collected count rather than assuming the declared count.
7. Pickup collection handshakes must preserve two-party participation: registered-vendor codes flow rider-to-vendor, while ad-hoc codes flow sender-SMS-to-rider.
8. Collection evidence and count rules must be consistent for zero-count and partial-count outcomes.
9. Offline rider actions must preserve original capture time, order, idempotency, and conflict status when synchronized.

## 35.4 Failure and rescheduling rules

1. A failed pickup requires a categorized reason and required supporting detail/evidence for that reason.
2. Contact attempts must be recorded consistently where the business policy requires them.
3. Rescheduling creates a traceable attempt chain rather than overwriting the failed attempt.
4. A replacement request must not remain simultaneously active with the source request unless the state model explicitly supports that condition.
5. Maximum attempts (three, `MELARC_MAX_PICKUP_ATTEMPTS`), force-extension authority (hub Senior Ops, direct, reasoned, and audited — `MSC-DEC-116`), vendor dispute rights (no dedicated self-service dispute portal; assisted Ops/support review only — `MSC-DEC-122`), and terminal outcomes are confirmed; exact extension ceilings and technical state mechanics remain design follow-up.
6. A force-extension or exception override is privileged, reasoned, and audited.

## 35.5 Hub-receiving rules

1. Hub receiving begins only after a valid rider handover or another explicitly authorized intake path.
2. The physical count is blind: the system must not reveal or require the frontend to submit the rider-declared count before the physical count is committed.
3. After submission, the system reveals the comparison and determines whether reconciliation is required.
4. Quantity variance, parcel condition, and dispute/adjudication are distinct OS&D dimensions; damage, tampering, or dispute may be recorded even when count variance is `MATCH`.
5. Itemization cannot close until the authoritative hub-received count is reconciled with the number of itemized parcels, subject only to an approved exception process.
6. Concurrency controls must prevent two users from independently closing or mutating the same intake inconsistently.
7. Vendors may receive appropriate status visibility but must not see internal operational notes or other vendors' data.

## 35.6 Itemization and pricing rules

1. Each physical parcel becomes an individually traceable order/delivery unit.
2. Itemization captures recipient, destination, responsible-hub zone, descriptive size, high-value/handling attributes, payer allocation, service level, lane, and source custody links.
3. Version 1 base pricing depends on both the origin and destination zone within the responsible hub's service-zone catalogue — a zone-pair matrix, not one flat fee per zone; two zones (Amasaman & Environs, Kasoa Corridor) are priced by a corridor rate card instead when they are the destination. It is not calculated from live distance.
4. A standard multi-package booking displays no monetary estimate. The one-package exception may display only the approved provisional base-fee estimate. Hub itemization calculates the authoritative fee and freezes it at itemized-order confirmation.
5. The no-estimate state, any provisional estimate that actually existed, and the frozen price must be visibly distinct and historically preserved with their pricing inputs/version.
6. Destination zone must be server-resolved or explicitly authorized; free-text address alone is not authoritative.
7. A locked price cannot change silently. Corrections require the approved reasoned maker-checker workflow and audit history.
8. A post-freeze address correction that crosses a pricing zone requires Ops-requested, hub-Senior-Ops-approved repricing with full history and affected-party notification.
9. The size surcharge (Small/Medium/Large/Extra Large, Small = GH₵0) applies on top of the zone-pair matrix price or a corridor rate, stacking additively with the separate high-value surcharge where both apply; it does not apply to `STATION_DROP`/`MELARC_COVERED_THIRD_PARTY_DELIVERY` outbound charges. Exact zone-pair/corridor/surcharge values, tax/discount tables, and outbound charges remain controlled settings/policy follow-up.
10. After pricing, each vendor-paid amount must satisfy either credit reservation or successful prepayment before the order becomes dispatch-ready; pickup-request confirmation itself creates neither.
11. The itemized count used to close an intake must compare against the authoritative hub count; a valid `PAYMENT_REQUIRED` parcel still counts toward physical parity.

## 35.7 Recipient-confirmation and dispatch rules

1. Orders requiring recipient confirmation are not dispatch-eligible until confirmation requirements are satisfied or an approved exception applies.
2. Contact attempts and outcomes must be persisted, not kept only in transient UI state.
3. Eligible orders are grouped into the appropriate inbound or outbound flow.
4. Doorstep delivery runs have controlled rider assignment and stop order.
5. Dispatch must be atomic: the same order cannot be dispatched to two destinations or mechanisms through concurrent actions.
6. Every outbound order has one authoritative commercial mode: `STATION_DROP` or `MELARC_COVERED_THIRD_PARTY_DELIVERY`.
7. Station Drop cannot be dispatched until the effective company-wide fee snapshot—GH₵25 at launch—is backend-confirmed as paid; the recipient separately pays the third party's destination charge. Fee changes follow `MSC-DEC-177`.
8. Melarc-covered third-party delivery cannot be dispatched until the complete combined waybill-plus-Melarc charge is backend-confirmed as paid; the recipient owes nothing at destination.
9. Outbound handoff to a provider or informal agent requires identity/evidence appropriate to that handoff type, and registered handoff requires waybill plus photo evidence.
10. Price, recipient data, commercial mode, carrier, payment state, and confirmation status visible at dispatch must come from the authoritative order record.

## 35.8 Delivery, delivery-fee collection, and settlement rules

1. A doorstep parcel may be marked delivered only after backend validation of the valid OTP sent to the recorded recipient phone.
2. Where the recipient owes an amount, approved cash or backend-confirmed Hubtel mobile-money payment must be recorded before handover. Fully vendor/sender-paid parcels still require OTP.
3. Recipient Hubtel/MoMo pays Melarc directly; rider personal accounts are prohibited.
4. Cash collected by a rider is reconciled at the responsible hub after the run or before workday close. Financial closure requires full reconciliation or an explicit variance exception.
5. Approved-vendor statements are paid through Hubtel/mobile money only; bank transfer and cash-at-hub are not Version 1 statement channels.
6. Version 1 allows three total doorstep attempts and creates no redelivery fee.
7. After each failed attempt the parcel returns to its responsible hub; riders may not retain parcels overnight.
8. After the third unsuccessful attempt, return processing starts, the original delivery fee reverses, and the flat vendor-paid return fee accrues.
9. Physical return custody closes only after valid return OTP; ad-hoc return-fee payment gating follows PAY-027.
10. No pricing, OTP, payment, cash-custody, statement, reversal, attempt, or return event may be silently overwritten.

## 35.9 Settings and reasons

1. Runtime-configurable reason options must use stable codes and remain interpretable after deactivation.
2. Reasons may carry metadata controlling whether notes, photos, contact attempts, or approvals are mandatory.
3. Settings require validation, effective dating where appropriate, and audit history.
4. Security secrets must not be stored or administered as ordinary business settings.
5. Kill switches must fail safely and expose their active state to authorized operators.
## 35.10 Multi-hub rules

- Every governed operational/financial record has one responsible hub.
- Company-wide reporting aggregates hub-owned records without making them hubless.
- Every rider/staff member has one primary hub; cross-hub work requires a primary-hub Senior Ops request and receiving-hub Senior Ops approval.
- Authorized Ops may change a pickup's responsible hub only before rider pickup begins, with complete reassignment audit.
- After custody begins, Version 1 must not simulate inter-hub transfer by directly changing a parcel's hub.
- Each hub owns its own service zones.
- Hub access is role-scoped: ordinary hub users and Senior Ops remain within authorized hub scope, while Platform Admin and explicitly authorized company-wide roles may view all hubs.
- Each hub independently maintains its pricing and operational settings through hub Senior Ops proposal and Platform Admin approval; missing values must not silently fall back to another hub or undocumented global business defaults.
- Future transfer support must preserve custody history.

- Hub service-zone creation, boundary, deactivation, and service-day changes require hub Senior Ops proposal plus Platform Admin approval before activation.
- A pickup already placed on a manifest may be reassigned only before the rider run starts; the old stop and incompatible assignments must be atomically removed/revoked and the pickup replanned under the new hub.
- All-hub dashboards and exports require Platform Admin or a specifically authorized company-wide/HQ role. Hub Senior Ops remain hub-limited, and all-hub results retain responsible-hub attribution.

## 35.11 Fleet, fuel, and maintenance rules

1. Only Melarc-owned motorcycles are operational fleet assets in Version 1.
2. Rider/motorcycle assignments, breakdown decisions, custody handovers, maintenance completion, and return-to-service decisions must preserve full history rather than overwrite prior facts.
3. Melarc pays the motorcycle fuel expense; Version 1 does not create a rider reimbursement claim or fuel-allowance workflow.
4. Every fuel record captures the responsible hub, motorcycle, rider, purchase date/time, amount, litres, station/provider, and receipt or approved evidence.
5. Fuel records exist for audit and reporting and must preserve the recording actor, timestamps, original values, and auditable corrections.
6. Claim limits, rider reimbursement channels, and multi-stage fuel approval are outside the required Version 1 workflow.
7. Preventive maintenance is scheduled: the assigned rider performs the guided routine check every Sunday, and oil changes become due at the earlier approved hub-specific calendar or mileage interval.
8. Hub Senior Ops authorizes planned repairs before work begins. Emergency repairs may proceed when prior approval is impractical, but must be documented and retrospectively reviewed.
9. The minimum maintenance record contains motorcycle, date, work completed, cost, repairer/vendor, and evidence.
10. Maintenance completion does not itself return a motorcycle to service; the independent Senior Ops release decision remains required.
11. Hub Senior Ops proposes each hub’s oil-change intervals and Platform Admin approves them. A motorcycle with overdue preventive maintenance may not begin its next run until Senior Ops records the availability decision. Sunday has no separate Product Owner-defined intra-day cutoff; dedicated renewal and retirement workflows are not Version 1 Master Specification requirements. Detailed checklist/evidence, emergency mechanics and fleet metrics move to downstream design and reporting artifacts.

## 35.12 Vendor administration rules

1. A registered vendor organization is created by authorized Ops and operationally approved or rejected by hub Senior Ops; public self-registration is not a Version 1 path.
2. The creator and operational approver must be different actors.
3. Operational activation and financial account allowance are separate decisions.
4. Until Platform Admin enables account allowance, every vendor-paid amount calculated at itemization must be paid before the affected order can be confirmed as dispatch-ready.
5. Version 1 uses one shared Melarc Vendor login per organization and no individual vendor-user roles.
6. A vendor may maintain multiple saved pickup locations and one default; every selected location remains subject to responsible-hub serviceability.
7. Vendor suspension blocks the shared login and stops all non-terminal work in an explicit hold while preserving records and physical custody.
8. Suspension, overdue status, account-allowance disablement, and security/risk holds are distinct conditions and must not be collapsed into one flag.
9. Reactivation or exceptional disposition of held parcels must be privileged, reasoned, and audited.
10. Ad-hoc senders remain ops-assisted and may become reusable only after successful physical pickup; promotion to registered vendor follows the approved onboarding process.

# 36. Canonical state machines

**Section status:** `APPROVED`
**Approval status:** APPROVED WITH DOWNSTREAM TECHNICAL DESIGN REQUIRED — product lifecycles and invariants are confirmed; final machine enums and exhaustive transition tables remain downstream

State machines are business contracts shared by the backend, frontend, tests, reporting, audit, and support procedures. The final canonical enums must live in the domain model and API contract. The catalogue below records approved product lifecycles and identifies only the remaining technical canonicalization work.

## 36.1 State-machine principles

- A transition must name its allowed source state, destination state, actor/permission, preconditions, side effects, emitted event, and failure code.
- A record must not jump states merely because a frontend screen changes.
- Terminal states and reversible states must be declared.
- Failed, cancelled, superseded, and replacement records remain queryable for audit and attempt-chain history.
- Concurrent transition attempts require deterministic rejection or idempotent replay.

## 36.2 Pickup Request

**Canonical Version 1 states:** `PENDING`, `CONFIRMED`, `DECLINED`, and terminal `CANCELLED`.

```text
PENDING ──confirm──> CONFIRMED
PENDING ──decline──> DECLINED
PENDING/CONFIRMED ──authorized cancellation──> CANCELLED
CONFIRMED ──reschedule replacement created──> CANCELLED (source remains linked to replacement)
```

The cancelled request preserves cancellation reason, actor, timestamp, attempt-chain/replacement links, and prior manifest/execution references. Domain/OpenAPI design must still decide whether a pre-submission `DRAFT` state exists, how one-package approval is represented, and exactly when a manifested or executing request becomes ineligible for cancellation.

## 36.3 Pickup Manifest / Run

The sources imply a lifecycle similar to:

```text
DRAFT ──dispatch──> DISPATCHED ──rider starts──> IN_PROGRESS
IN_PROGRESS ──all stops resolved──> COMPLETED
DRAFT/DISPATCHED ──authorized cancellation──> CANCELLED  [exact eligibility in domain design]
```

The exact enum names, partial-completion handling, rider-reassignment transaction mechanics, and offline synchronization states belong to domain/OpenAPI/mobile design; they must preserve the confirmed dispatch/start ownership and audit rules.

## 36.4 Pickup Stop / Collection

A stop must distinguish at minimum:

- Pending/not attempted
- Arrived or in progress where useful
- Collected successfully
- Partially collected, if permitted
- Failed
- Cancelled/skipped through an authorized operation

A zero collected count is a failed pickup and cannot be represented as a completed stop or handover. Partial-collection representation and the exact relationship between physical stop outcome and the separate collection-confirmation overlay belong to domain/OpenAPI design.

## 36.5 Collection handshake

The sources imply separate lifecycle concepts that should not be collapsed:

1. Collection has been recorded.
2. Verification code has been generated/delivered.
3. Verification has succeeded, expired, failed, or been disputed.
4. An authorized manual resolution may occur.

The registered-vendor interaction direction is resolved: Melarc Rider displays the code and the vendor enters it in Melarc Vendor. The ad-hoc direction is also resolved: Melarc sends the code by SMS and the sender/reference provides it to the rider for entry. Domain/OpenAPI design must define the precise generated, delivered, verified, expired, exhausted, disputed, and manually resolved states without changing those directions.

## 36.6 Pickup Intake

A working lifecycle is:

```text
AWAITING_COUNT
  ──submit blind physical count──> COUNTED
COUNTED
  ├──no discrepancy──> READY_FOR_ITEMIZATION
  └──discrepancy/condition──> RECONCILIATION_REQUIRED
RECONCILIATION_REQUIRED
  ──authorized resolution──> READY_FOR_ITEMIZATION
READY_FOR_ITEMIZATION
  ──start/continue itemization──> ITEMIZING
ITEMIZING
  ──parity and validation pass──> CLOSED
```

The final model must separately track quantity comparison, condition findings, and dispute resolution. Reopening a closed intake, if permitted, must be privileged and audited.

## 36.7 Order / Parcel

The sources describe milestones rather than a complete canonical enum. At minimum, the model must represent:

- Itemized and priced but not yet commercially cleared
- `PAYMENT_REQUIRED` where vendor-paid prepayment is required
- Credit-approved or prepaid and awaiting recipient confirmation
- Confirmed/eligible for dispatch
- Queued or price-locked
- Assigned/dispatched for doorstep delivery
- Handed to registered or informal courier
- Delivered
- Delivery failed
- Return in progress
- Returned or otherwise terminal
- Cancelled/voided where business policy permits

The governing delivery, return, payment, statement, and outbound commercial policies are established. Domain/OpenAPI design must now publish the exact enum names and complete transition matrices, including idempotency, correction, failure, reversal, and terminal-closure rules, without introducing new business policy.

## 36.8 Recipient confirmation

The call/confirmation process must distinguish:

- Awaiting attempt
- Attempted/no answer or retry required
- Confirmed
- Details correction required
- Refused/cancelled/escalated
- Maximum attempts reached

The approved product policy references attempt limits but does not approve the complete state model.

## 36.9 Delivery Run and Stop

The canonical delivery state model must support at least the following business progression, with final machine codes deferred to the domain model/OpenAPI contract:

```text
READY_FOR_DISPATCH
  ──dispatch/assign──> ASSIGNED
ASSIGNED
  ──start run──> OUT_FOR_DELIVERY
OUT_FOR_DELIVERY
  ──recipient payment if due + valid recipient OTP──> DELIVERED
OUT_FOR_DELIVERY
  ──record failed attempt──> ATTEMPT_FAILED
ATTEMPT_FAILED
  ──return custody to responsible hub──> AT_HUB_AFTER_FAILURE
AT_HUB_AFTER_FAILURE
  ──attempt count < 3 and approved reattempt──> READY_FOR_REATTEMPT
AT_HUB_AFTER_FAILURE
  ──attempt count = 3──> RETURN_TO_VENDOR_IN_PROGRESS
RETURN_TO_VENDOR_IN_PROGRESS
  ──return-fee gate where applicable + valid vendor OTP──> RETURNED_TO_VENDOR
```

Business invariants:

- Delivery cannot close without valid recipient OTP.
- A recipient-paid amount, when due, must be paid before delivery closure.
- Attempt count cannot exceed three through ordinary workflow.
- Failed-attempt custody must return to the responsible hub; no rider overnight hold state exists.
- Return handover cannot close without valid vendor/sender OTP.
- Replayed payment, OTP, failure, hub-return, or return-handover commands must not duplicate outcomes.

Failure reasons, scheduling sub-states, provider/payment attempts, OTP security states, and exceptional administrative paths remain to be canonicalized.


## 36.10 Provider Shipment / Courier Handoff

Version 1 uses a manual Melarc-managed courier/station record rather than an external courier API. The two commercial modes diverge after handoff (Section 24.7):

```text
CREATED/PENDING_HANDOFF
  ──capture approved courier/station, waybill and evidence──> HANDED_OVER

STATION_DROP: HANDED_OVER is terminal — Melarc's service and fee-earning are
complete at verified handoff. The third party's onward
delivery is outside Melarc's tracked lifecycle.

MELARC_COVERED_THIRD_PARTY_DELIVERY: HANDED_OVER is NOT terminal — Melarc
remains responsible through the recorded final external outcome:
HANDED_OVER
  ──manual Melarc outcome update──> IN_TRANSIT / DELIVERED / FAILED / RETURNED
  (one of DELIVERED / FAILED / RETURNED is the terminal state)
```

The system must not mark a shipment financially settled merely because physical handoff occurred unless the finance policy explicitly defines that event. External automated booking, label, webhook, or tracking states are not required in Version 1.

## 36.11 Payment, cash reconciliation, and vendor account

The detailed machine codes remain for the canonical domain model and OpenAPI contract, but the required product lifecycles are now bounded:

```text
Itemized-order commercial gate:
PRICED
  ├─ allowance enabled + current + sufficient exposure ─> CREDIT_RESERVED ─> DISPATCH_READY
  └─ allowance disabled / overdue / insufficient exposure ─> PAYMENT_REQUIRED
PAYMENT_REQUIRED ──full vendor-paid amount succeeds──> PREPAID ─> DISPATCH_READY

Mobile-money attempt:
CREATED → PENDING → SUCCEEDED | FAILED | EXPIRED | CANCELLED
SUCCEEDED → REVERSED (only through a controlled linked event)

Rider cash custody:
EXPECTED → COLLECTED_BY_RIDER → HANDED_TO_HUB → RECONCILED
                                      └──────────→ EXCEPTION_OPEN
EXCEPTION_OPEN → RESOLVED

Vendor statement:
DRAFT → ISSUED → PAID
             ├→ DISPUTED_LINE_REVIEW → ADJUSTED | DISPUTE_REJECTED
             └→ OVERDUE → PAID/CLEARED
```

Pickup-request confirmation creates neither `CREDIT_RESERVED` nor `PAYMENT_REQUIRED`; the gate begins only after itemization calculates the authoritative vendor-paid amount. Credit reservation and successful prepayment are mutually exclusive satisfaction paths for the same itemized order and must be idempotent.

Ordinary `PART_PAID` is not supported. The vendor pays the full currently payable undisputed balance. A disputed line is temporarily separated for controlled review without rewriting the issued statement; an approved correction posts a linked adjustment, while rejection restores the line under controlled due/overdue rules. A recipient mobile-money payment satisfies the delivery gate only in `SUCCEEDED`, confirmed by the backend/provider. Recipient cash satisfies the gate only after the rider records collection, but the run/workday remains financially open until hub reconciliation or an exception. Duplicate, reversal, refund, adjustment and exception transitions must be idempotent and auditable.


## 36.12 Vendor organization, allowance, and suspension

The final machine codes belong to the domain model, but the product requires separate lifecycles:

```text
Vendor operational status:
DRAFT/CREATED_BY_OPS → PENDING_SENIOR_OPS_REVIEW → ACTIVE | REJECTED
ACTIVE → SUSPENDED → ACTIVE | TERMINATED/ARCHIVED [later policy]

Vendor account allowance:
DISABLED_PREPAYMENT_ONLY → ENABLED_BY_PLATFORM_ADMIN
ENABLED → DISABLED_BY_PLATFORM_ADMIN
DISABLED_BY_PLATFORM_ADMIN → ENABLED_BY_PLATFORM_ADMIN

Vendor work during suspension:
NON_TERMINAL_WORK → SUSPENSION_HOLD → RESUMED | AUTHORIZED_EXCEPTION_DISPOSITION
```

Invariants:

- Operational `ACTIVE` does not imply account allowance `ENABLED`.
- `OVERDUE` is a financial state and does not equal `SUSPENDED`.
- Suspension blocks login and ordinary work but preserves every record and custody link.
- Shared credential/session state is separate from organization operational status.
- Every transition records actor, reason, timestamp, and applicable evidence.

Exact rejection, reapplication, termination, reactivation, verification evidence and safe-held-parcel disposition transitions remain domain/security/runbook follow-up. Financial activation and disablement authority are confirmed by `PAY-044–045`.

## 36.13 Canonicalization gate

No enum should be treated as final until:

- All registered source contradictions affecting it remain resolved, and any newly discovered contradiction is closed through controlled change before implementation.
- The transition table is approved by the Product Owner.
- Frontend display labels are separated from stable machine codes.
- The domain model and OpenAPI schemas reference the same codes.
- Transition tests cover valid, invalid, duplicate, and concurrent actions.

## 36.14 Fleet state-machine notes

The fleet state model must distinguish a pending breakdown incident from a confirmed unavailable motorcycle. A confirmed unavailable motorcycle remains ineligible for new runs through inspection/repair completion and returns to available only after Senior Ops approval. An active-run custody handover has its own pending/completed/failed lifecycle and must not be represented as a silent assignment edit. Compliance expiry must likewise create a distinct pending Senior Ops review/decision record; it must not silently mutate availability. A decision to make the motorcycle unavailable then follows the normal unavailable and return-to-service lifecycle.

# 37. Security and permissions

**Section status:** `APPROVED`

## 37.1 Security principles

- Deny by default and enforce authorization in the backend against held permissions, not role names (Section 11.1, Section 11.6).
- Separate surface, permission, responsible-hub scope, vendor-record ownership, rider assignment, current state, and temporary authority.
- Preserve tamper-evident audit history for privileged, financial, identity, recovery, and device/session actions.
- Never trust frontend totals, prices, OTP assertions, payment success, ownership, hub assignment, or status transitions.
- Apply least privilege to staff, riders, the shared vendor credential, service accounts, and integrations.

## 37.2 Confirmed authentication and session policy

- Staff use email/password; Senior Ops and Platform Admin require MFA.
- Riders use registered phone plus private PIN on one registered device.
- The shared Melarc Vendor credential permits one active session/device; a new successful login ends the earlier session.
- Staff recover through verified work email; vendors through registered phone/email; riders through Ops verification and device re-registration.
- Platform Admin handles exceptional staff/vendor recovery; Senior Ops handles rider recovery.

`

## 37.3 Confirmed access boundaries

- Melarc Vendor is a simple customer portal, not a SaaS tenant workspace.
- A vendor account accesses only its own requests, orders, tracking, and directly related approved records.
- Ordinary Ops/hub staff are restricted to authorized hubs; Platform Admin and approved HQ roles may have audited cross-hub/cross-vendor access.
- Riders access only assigned work and permitted personal/vehicle information.
- Recipients have no general portal account; payment/OTP links reveal only minimum transaction context.
- Suspension blocks the shared vendor credential and controlled non-terminal work.

## 37.4 Maker-checker and privileged actions

Examples include Ops-created/Senior-Ops-approved vendor activation, Platform-Admin financial allowance, Platform-Admin one-package exception approval, Senior-Ops price correction, hub setting/zone proposals approved by Platform Admin, two-hub temporary staff assignment approval, and Senior-Ops return-fee waiver approval. The requester cannot approve the same maker-checker action. Every instance uses the same enforcement shape: a `*.create` permission, a `*.approve` permission, and one constraint that the approver may not be the record's creator.

## 37.5 Shared vendor credential risk

Because Version 1 deliberately uses one shared credential:

- audit identifies the vendor account, not a named employee;
- only one active session/device is allowed;
- credential recovery/change must revoke or control prior sessions;
- the UI must not claim person-level attribution;
- a future multi-user model must preserve the vendor's historical records.

## 37.6 Data ownership—not SaaS tenancy

Product policy requires own-record access for vendors and role/hub-scoped access for Melarc staff. It does not require a separate database, schema, subscription tenant, vendor-admin console, or tenancy-management subsystem per vendor. System architecture may choose an appropriate physical data layout, but every query, export, notification, file, and API operation must enforce vendor ownership and hub/role scope with negative-access tests.

## 37.7 Privacy and sensitive data

Sensitive data includes contacts, addresses, OTP/payment references, verification evidence, parcel evidence, declared values, serial numbers, rider evidence, financial records, device/session details, and audit logs. Detailed purpose, masking, encryption, export, retention, deletion/anonymization, breach response, and legal review remain security/privacy design work. Accountable owner (interim: Product Owner) and starting regulatory reference point (Ghana Data Protection Act 2012, Payment Systems and Services Act 2019 context) are confirmed at Section 8.2; the design work itself remains open.

## 37.8 Security acceptance gate

Login, vendor records, rider access, OTP, payment, suspension, or privileged approval implementation is not ready until security architecture and OpenAPI define factor/token/session/device mechanics, authorization checks, audit events, secrets, rate limits, recovery, and negative tests consistent with these confirmed policies.

# 38. Audit requirements

**Section status:** `APPROVED`
**Approval status:** APPROVED WITH DOWNSTREAM TECHNICAL DESIGN REQUIRED — event baseline and retention model/governance confirmed; exact retention periods per category, immutability/WORM, and tamper-detection mechanics remain

Auditability is central to Melarc because the system coordinates physical custody, customer communications, operational exceptions, price changes, privileged approvals, and future financial movements.

## 38.1 Audit principles

- Audit records describe who did what, to which business object, when, from which authorized context, and with what result.
- Audit history is append-oriented and cannot be silently rewritten by normal users.
- Business-event history and security audit may be stored differently, but both must be queryable for authorized investigations.
- Human-readable timelines must be generated from stable event codes and snapshots, not from mutable current labels alone.
- Failed and denied privileged attempts may also require security logging.

## 38.2 Minimum audit fields

Each material audit entry should record, as applicable:

- Stable event ID and event code.
- Occurred-at and recorded-at timestamps.
- Actor type, actor ID, role, and surface/device context.
- Vendor ownership context and affected object type/ID.
- Correlation/request/idempotency identifier.
- Previous and resulting state.
- Reason code, notes, and approval reference.
- Relevant before/after values or a safe diff.
- Related run, stop, pickup, intake, order, payment, settlement, or file identifiers.
- Outcome: succeeded, rejected, failed, replayed, or reconciled.

Sensitive secrets, full credentials, raw OTPs, and unnecessary personal data must never be copied into audit logs.

## 38.3 Source-identified event domains

The approved baseline requires events for:

- Pickup request creation, confirmation, decline, exception approval, cancellation, and rescheduling.
- Manifest construction, rider assignment, dispatch, start, stop outcome, and completion.
- Collection count, evidence, handshake generation/verification/dispute, and failure adjudication.
- Hub handover, blind count, discrepancy/OS&D creation and resolution, itemization, and intake closure.
- Recipient call attempts, confirmation, correction, and escalation.
- Price calculation, lock, correction request, approval, and application.
- Delivery-run construction and dispatch.
- Registered/informal courier handoff and evidence capture.
- Settings/reason/provider activation and changes.
- Future delivery, delivery-fee payment, settlement, return, account, and export events.
- Fleet breakdown reports, Senior Ops confirmation/rejection, active-run custody handovers or hub-return fallbacks, repair/inspection completion, and return-to-service decisions.

## 38.4 Authentication and access audit coverage

Audit login success/failure as appropriate, MFA enrolment/challenge/recovery, rider device registration/replacement, vendor session replacement, logout/revocation, account recovery, suspension access denial, and privileged cross-vendor/hub access. Vendor activity is attributable to the shared vendor account, not a named vendor employee.

## 38.5 Privileged audit coverage

Enhanced audit is mandatory for:

- Maker-checker approvals.
- Force extensions and manual state overrides.
- Price or financial corrections.
- Cross-vendor access or impersonation.
- Evidence replacement/removal.
- Account role, status, or credential administration.
- Settings, thresholds, reason lists, service zones/days, and provider changes.
- Data exports and destructive retention actions.

## 38.6 Operational timelines

Authorized users should be able to inspect an ordered business timeline for a pickup request, attempt chain, intake, order, delivery, and future payment/settlement. Vendor-visible timelines must expose only approved customer-facing milestones and must not leak internal notes, personnel data, or other vendors' information.

## 38.7 Retention and integrity decisions

Retention policy is confirmed: photos, audit events, call logs, notifications, sender records, and parcel history each carry their own independently configurable retention period rather than one uniform value; a record under active dispute, unresolved discrepancy, or ongoing investigation is exempt from automatic deletion until the matter closes; and only Platform Admin may change a retention-period setting. The Auditor bundle (Section 11.3) may search, view, and export audit data, with every export enhanced-audited per Section 38.5.

Still requiring approval or design:

- Exact retention period per data category (compliance/legal input required — not resolved by product policy alone; accountable owner and starting regulatory reference point now confirmed at Section 8.2, `MSC-DEC-159–160`).
- Whether any records are immutable/WORM-protected.
- Export and legal-hold procedures (the underlying policy — exemption from deletion, Platform Admin authority, Auditor export access — is confirmed; procedural mechanics are not).
- Redaction and privacy handling.
- Tamper-detection and integrity-verification requirements.
- Archival performance and restore expectations.

# 39. Integration requirements

**Section status:** `APPROVED`
**Approval status:** APPROVED WITH DOWNSTREAM TECHNICAL DESIGN REQUIRED — integration boundaries are product-policy authority; provider contracts and resilience mechanics remain downstream

## 39.1 API contract between frontend and backend

The frontend and backend must integrate through an authoritative, version-controlled OpenAPI contract. The endpoint sketches inside feature documents and current implementation are discovery inputs, not contract authority. Neither frontend nor backend may independently change operations, payloads, enums, errors, or contract-visible behaviour.

The contract must define:

- Authentication and authorization expectations.
- Stable operation IDs, methods, paths, and API versioning.
- Request/response schemas, nullability, formats, and examples.
- Shared enums and machine-readable error codes.
- Pagination, filtering, sorting, search, and bulk actions.
- Upload and download procedures.
- Idempotency, optimistic/concurrency conflict behaviour, and retry safety.
- Date/time, timezone, decimal/money, phone, location, and identifier formats.
- Deprecation and backward-compatibility policy.

Contract changes must be reviewed by both frontend and backend owners before implementation or release.

## 39.2 Messaging integrations

The product requires an SMS integration for the approved mandatory customer milestones and an in-app notification subsystem for registered vendors. Provider selection is not yet approved.

Requirements include:

- Template IDs and versioned content.
- Delivery status, retries, failure classification, and cost monitoring.
- Deduplication and event-to-message idempotency.
- Opt-in/preference handling except for mandatory operational/security messages.
- Ghana-compatible phone normalization.
- Safe omission of secrets and unnecessary sensitive data.
- Provider outage fallback and operational visibility.

## 39.3 Maps, zones, and navigation

Product policy requires address, zone, and rider-navigation support. Solution architecture must decide whether launch uses a mapping/geocoding provider, stores user-supplied links, or combines both without changing the approved service-zone rules.

An approved design must define:

- Address/geocode ownership and correction.
- Zone resolution and versioning.
- Navigation-link generation.
- Provider key/security and usage-cost controls.
- Behaviour when geocoding or route services are unavailable.
- Whether location coordinates are collected from riders and under what privacy policy.

Automatic route optimization is explicitly deferred in the source baseline.

## 39.4 File/object storage

Photos, signatures, receipts, proof, and other evidence require an object-storage integration or equivalent secured file service. The contract must define upload initiation, validation, metadata, ownership, access URLs, lifecycle, retention, and deletion/archival behaviour.

## 39.5 Background processing

The current technical hypothesis proposes Celery for asynchronous work. Before implementation, the architecture must define:

- Broker and result-backend choices.
- Task idempotency and retry/backoff policy.
- Dead-letter/failure handling.
- Vendor ownership and responsible-hub context propagation.
- Scheduling and backstop jobs.
- Monitoring and operational replay controls.
- Transaction-to-event consistency, such as an outbox pattern where needed.

## 39.6 External courier integration

Version 1 does not require an external courier API. Melarc maintains its own approved courier/station registry and manually records waybill, custody handoff, evidence, and later outcome in Melarc. The integration/domain design must support both `STATION_DROP` and `MELARC_COVERED_THIRD_PARTY_DELIVERY`, preserve their different payment and closure rules, and retain separate waybill-cost and Melarc-fee components for the covered mode. Registry authority, provider master data, informal-agent rules, external outcome evidence, agent settlement, reconciliation, cost variance and future API adoption remain controlled follow-up.

## 39.7 Multi-hub architecture boundary

APIs, jobs, audit events, permissions, and reports must carry responsible-hub context where applicable. Temporary staff/rider assignment must be modeled separately from primary membership and implement primary-hub request plus receiving-hub approval. Every endpoint and export must enforce the role-scoped cross-hub visibility model server-side. Hub pricing/setting proposal and Platform Admin approval must be represented as auditable workflow operations. Version 1 exposes no operational inter-hub parcel-transfer API or hidden direct hub-rewrite operation.

## 39.8 Payments and disbursement integration

Hubtel is the approved intended Version 1 provider boundary for recipient mobile-money payments and approved-vendor weekly-statement payments. Recipient mobile-money funds go directly to Melarc, and the backend must independently confirm provider success before delivery closure. Weekly vendor statements are paid through Hubtel/mobile money only; bank transfer and cash-at-hub are excluded normal channels.

The integration contract must still define the exact Hubtel product, authentication, request initiation, payer prompts, callbacks/webhooks, signature verification, idempotency, transaction correlation, pending/failed/expired/duplicate states, reversals/refunds, receipts, outage/manual recovery, sandbox testing, reconciliation, and secret rotation. Provider capability must not silently redefine Melarc's payer, delivery, statement, or cash-custody rules.

## 39.9 Integration resilience

Every external integration must specify:

- Timeout and retry policy.
- Idempotency/replay handling.
- Authentication and secret rotation.
- Webhook verification and duplicate-event handling.
- Failure visibility and manual recovery.
- Data minimization and retention.
- Sandbox/testing support.
- Service ownership and cost controls.

# 40. Non-functional requirements

**Section status:** `APPROVED`

## 40.1 Approved launch targets

Version 1 uses the following internal launch targets:

| Area | Target |
|---|---|
| Monthly availability | 99.5% |
| Normal connected user actions | Usually complete within 3 seconds |
| Critical write operations | Complete within 5 seconds |
| Backup frequency | Daily |
| Maximum data-loss exposure (RPO) | 24 hours |
| Restoration target (RTO) | 4 hours |

Technical design must define the measurement boundaries and percentiles, critical-write catalogue, planned-maintenance treatment, dependency handling, monitoring source, and reporting window. These are internal product/engineering targets unless a later customer contract explicitly makes them external service-level commitments.

## 40.2 Reliability and integrity

- Critical writes must be transactional, idempotent where retry is possible, and visibly fail rather than partially succeed.
- Custody, payment, statement, OTP, approval, dispatch and return transitions require durable audit records.
- Background jobs and integrations require retry, deduplication, dead-letter/escalation and reconciliation behaviour.
- Hubtel/payment confirmation must remain backend-authoritative.
- Native Rider offline/sync behaviour must prevent duplicate or out-of-order custody/payment outcomes.

## 40.3 Performance and scale design

Architecture and load-test plans must define representative volumes for vendors, riders, hubs, parcels, dashboard queries, exports, files and concurrent staff. The approved response targets apply to normal connected interactions; long-running exports or asynchronous work must show progress and completion state rather than block an interactive request.

## 40.4 Backup and recovery

- Perform daily backups for authoritative production data and required configuration.
- Design for no more than 24 hours of data loss after a qualifying disaster.
- Design for restoration of service within 4 hours.
- Encrypt backups, restrict access, verify successful completion, and test restoration on a defined cadence.
- File/evidence storage, secrets and integration configuration must be covered by the recovery plan or have an explicit recreation procedure.

## 40.5 Client and device baseline

- Melarc Ops: supported desktop browsers and responsive narrower layouts must be defined/tested.
- Melarc Vendor PWA: supported mobile browsers, installability, update/cache behaviour and responsive desktop use must be defined/tested.
- Melarc Rider: supported Android versions, device registration, local security, camera/location/storage requirements, background work, offline queue and app-update distribution must be defined/tested.

## 40.6 Remaining NFR design

Security/privacy controls, retention periods, observability/alerts, capacity limits, accessibility conformance, provider-specific SLAs, restore-test cadence, exact performance percentiles and data-volume assumptions remain for security/solution architecture, runbooks and the implementation plan. They must preserve the confirmed targets rather than weaken them silently.

# 41. Frontend responsibilities

**Section status:** `APPROVED`

## 41.1 Shared responsibilities

All frontend applications must:

- consume the approved version-controlled OpenAPI contract and generated/shared schemas where adopted;
- never invent enum values, error formats, money/date behaviour or state transitions;
- enforce clear loading, empty, validation error, error, retry, offline, stale or conflict, success and permission-restricted states, each either implemented or recorded as not applicable to that surface;
- display authoritative backend validation and status;
- preserve idempotency/retry identifiers where the contract requires them;
- protect tokens, sessions, local data and evidence according to the security design;
- support accessibility and responsive/device requirements for the approved form factor; and
- map every user action to an OpenAPI operation and acceptance criterion.

## 41.2 Melarc Ops Portal

- Desktop-first responsive web application.
- Optimize dense queues, tables, dashboards, filters, approvals and side-by-side operational context for desktop use.
- Preserve essential usability at narrower responsive widths.
- Provide authorized hub and all-hub dashboard/report views according to role.

## 41.3 Melarc Vendor

- Mobile-first responsive PWA.
- Prioritize request placement, own-order tracking, notifications, fees, statements/payments and returns.
- Support installability and predictable PWA update/caching behaviour.
- Remain a simple own-order portal, not a vendor ERP or team-management surface.

## 41.4 Melarc Rider

- Native Android application.
- Optimize for assigned run execution, large field controls, OTP entry, payment status, navigation/contact, evidence capture, custody handoff and poor connectivity.
- Enforce one registered device and secure local storage.
- Exact offline actions and sync/conflict policy must be defined in mobile technical design and tested against custody/payment idempotency.

## 41.5 Required frontend design artifacts

Before implementation, produce:

- page/screen and route inventory;
- navigation and role-based action matrix;
- Figma/wireframes and reusable component/state definitions;
- responsive and Android device layouts;
- the interface states of Section 41.1, each specified or recorded as not applicable;
- accessibility requirements;
- OpenAPI operation mapping; and
- frontend acceptance-test coverage.

# 42. Backend responsibilities

**Section status:** `APPROVED`
**Approval status:** APPROVED WITH DOWNSTREAM TECHNICAL DESIGN REQUIRED — backend responsibilities are binding; detailed architecture remains a downstream artifact

The backend is the authoritative execution layer for product rules, data ownership, state, pricing, permissions, audit, and integration effects.

## 42.1 OpenAPI contract ownership

The backend implementation must conform to and help maintain the approved version-controlled OpenAPI specification. Contract-visible operations, payloads, enums, errors and behaviours require reviewed contract changes; current code does not silently override the contract. Backend tests and schema generation/validation must detect drift.


## 42.2 Core responsibilities

- Authenticate identities and enforce session/device policy.
- Authorize every action using surface, role, ownership/assignment, record state, and approval conditions.
- Enforce vendor-record ownership and authorized, audited cross-vendor Melarc access.
- Validate commands and execute state transitions atomically.
- Maintain canonical entities, relationships, invariants, and historical snapshots.
- Calculate eligibility, counts, zones, prices, thresholds, and financial effects from approved rules/settings.
- Generate stable events and audit records.
- Provide versioned API contracts and machine-readable errors.
- Coordinate background jobs and external integrations safely.
- Protect and authorize evidence files.
- Support reporting, exports, observability, backup, and recovery.

## 42.3 Workflow integrity

For each workflow, the backend must:

1. Load the authoritative object in the correct vendor-ownership and responsible-hub context.
2. Check permission and current-state preconditions.
3. Validate input and related records.
4. Apply the command once using transaction/concurrency controls.
5. Persist the state/evidence/history.
6. Emit the required event through a transactionally safe mechanism.
7. Return the canonical result or stable error.

The frontend must not be required to repeat hidden server values such as the blind declared count, authoritative price, ownership identifier, or permission decision.

## 42.4 API quality

The backend owns:

- OpenAPI schema generation/maintenance.
- Stable request/response/error contracts.
- Pagination and bounded bulk operations.
- Filtering/search authorization.
- Idempotency keys and duplicate-request semantics.
- Optimistic/pessimistic locking where appropriate.
- API versioning and deprecation.
- Compatibility tests used by the frontend.

## 42.5 Asynchronous processing

Notification dispatch, scheduled backstops, provider interactions, evidence processing, and other asynchronous tasks must be idempotent, observable, retry-safe, and linked to the originating business event. Failed jobs must be visible and recoverable without duplicating business effects.

## 42.6 Data and historical integrity

The backend must preserve:

- Stable machine codes and identifiers.
- State-transition history.
- Price/settings/reason/provider snapshots required to interpret history.
- Attempt chains and replacement links.
- Evidence metadata and access ownership.
- Financial ledger immutability/reversals when finance is designed.

Delete, archive, anonymize, and retention behaviour require explicit policy and must not be left to framework cascade defaults.

## 42.7 Architecture artifacts required

Before implementation is treated as enterprise-ready, create and approve:

- `DOMAIN_MODEL.md`
- `SOLUTION_ARCHITECTURE.md`
- `SECURITY_DESIGN.md`
- `openapi.yaml`
- Background-job/event design
- Deployment and environment design
- Observability and recovery runbooks
- Migration and data-seeding strategy

These technical artifacts implement this Master Specification; they do not silently redefine product behaviour.

## 42.8 Reliability and recovery responsibility

Backend, infrastructure and operations design must support the approved 99.5% monthly availability, 3-second normal-action, 5-second critical-write, daily-backup, 24-hour RPO and 4-hour RTO targets. This includes monitoring, transaction/idempotency controls, job/integration recovery, backup verification, restore testing, and performance/load tests.

# 43. Acceptance criteria

**Section status:** `APPROVED`
**Approval status:** APPROVED WITH DOWNSTREAM TECHNICAL DESIGN REQUIRED — acceptance framework and representative criteria are confirmed; exhaustive technical and edge-case criteria remain a downstream artifact

Acceptance criteria are the testable bridge between product requirements, frontend behaviour, backend enforcement, and launch approval. Every implementation slice must include normal, alternate, invalid, unauthorized, duplicate, concurrent, offline, and recovery cases relevant to that slice.

## 43.1 Required criterion format

Use stable requirement IDs and preferably Given/When/Then form:

```text
Given <authoritative preconditions and actor>,
When <one observable action occurs>,
Then <observable state, response, event, and side effect> result,
And <prohibited or invariant outcome> does not occur.
```

Each criterion should identify:

- Requirement ID(s).
- Surface and actor.
- API operation or system command.
- Initial state and required records.
- Expected response/state/event/notification.
- Expected error code for rejection cases.
- Test level: unit, service, API, integration, end-to-end, security, performance, or UAT.

## 43.2 Representative source-derived criteria

### Standard vendor pickup minimum

```text
Given an authenticated registered-vendor user with booking permission,
When the user submits a normal pickup request with one declared package,
Then the backend rejects the request with the canonical minimum-package error,
And no pickup request is confirmed or manifested.
```

### Authorized single-package exception

```text
Given an operations user has drafted a one-package request,
When an authorized approver accepts the exception with a reason,
Then the request becomes eligible for the approved confirmation path,
And the drafting user cannot approve their own exception where maker-checker applies,
And the approval is audited.
```

### Standard booking no-estimate and itemized-order payment gate

```text
Given a standard multi-package pickup request has no parcel destinations,
When the request is created or confirmed,
Then the system shows no monetary delivery-price estimate,
And no vendor credit is reserved and no vendor-paid delivery amount is collected at pickup-request confirmation.

Given hub itemization calculates a vendor-paid amount,
And account allowance is disabled, the vendor is overdue, or available global-limit exposure is insufficient,
When the user attempts to confirm that itemized order as dispatch-ready,
Then the system places the order in PAYMENT_REQUIRED,
And confirmation/dispatch readiness remains blocked until the full vendor-paid amount succeeds.

Given account allowance is enabled, the vendor is current, and sufficient exposure exists,
When the itemized order is confirmed,
Then the vendor-paid amount reserves credit exactly once at that milestone.
```

### One-package provisional estimate

```text
Given an approved one-package exception contains origin and destination data,
When the system shows a booking estimate,
Then it uses the effective base zone-pair or corridor rate,
And clearly states that size and high-value surcharges are excluded unless those inputs were captured and validated,
And itemization still calculates and freezes the authoritative final fee.
```

### Blind hub count

```text
Given a hub intake with a rider-declared count,
When an operations user opens the blind-count form,
Then the declared count is not returned in the editable/view model used before submission.

When the user submits only the physical count,
Then the backend persists that count, reveals the comparison in the response,
And requires reconciliation when the approved discrepancy rules are met.
```

### Intake-close parity

```text
Given an intake whose authoritative hub-received count is eight,
When an operations user attempts to close itemization with seven valid itemized parcels,
Then closure is rejected with a stable parity error,
And the intake remains open without losing the seven saved parcel records.
```

### Price lock

```text
Given an order whose price has reached the approved lock milestone,
When a normal user changes an address or another price input,
Then the locked price does not change silently,
And the system follows the approved correction or cross-zone policy,
And every authorized correction is audited.
```

### Atomic dispatch

```text
Given an eligible order that has not been dispatched,
When two users concurrently attempt incompatible dispatch actions,
Then at most one action succeeds,
And the other receives a stable conflict response,
And only one authoritative dispatch/handoff state and audit event exist.
```

### Rider offline synchronization

```text
Given an assigned rider records an approved stop outcome while offline,
When connectivity returns and the action is synchronized more than once,
Then the business outcome is applied once,
And the original capture time is preserved,
And any stale-state conflict is shown for authorized resolution rather than silently overwritten.
```

### No duplicate redelivery charge

```text
Given a parcel has an original delivery-fee allocation and its first delivery attempt has failed,
When an authorized user schedules or starts a later delivery attempt in Version 1,
Then the system creates no additional redelivery-fee charge or vendor-account accrual,
And the original payer allocation remains linked to the parcel pending its final outcome.
```


### OTP-only doorstep delivery closure

```text
Given a parcel is assigned for doorstep delivery,
And any recipient-paid delivery-fee portion has been successfully recorded,
When the rider submits the valid OTP sent to the recipient phone recorded for that parcel,
Then the backend marks the parcel delivered exactly once,
And no receiver name, relationship, signature, or delivery photograph is required by Product Owner policy.

Given the recorded recipient forwards that OTP to another person,
When that person presents the valid OTP and the rider submits it,
Then the same delivery may close without changing the recorded recipient.
```

### Payment-before-handover gate

```text
Given the recipient owes any delivery-fee amount,
When payment has not been successfully recorded,
Then the parcel cannot be marked delivered or normally handed over.

Given the parcel is fully vendor/sender-paid,
Then recipient payment is not required,
But valid delivery OTP remains mandatory.
```

### Three-attempt and hub-custody rule

```text
Given a doorstep attempt fails,
When the rider completes the active run,
Then the parcel must be returned to its responsible hub,
And the rider cannot retain it overnight.

Given two earlier attempts have failed,
When the third attempt also fails,
Then the system blocks another ordinary reattempt,
And starts the return-to-vendor workflow without creating a redelivery charge.
```

### OTP-only return handover

```text
Given a parcel is in return-to-vendor processing,
And any ad-hoc return-fee payment prerequisite is satisfied,
When the rider submits the valid OTP sent to the recorded vendor/sender contact,
Then physical return custody closes exactly once,
And no receiver name, role, relationship, signature, or return photograph is required by Product Owner policy.
```

### Privileged staff MFA

```text
Given a Senior Ops or Platform Admin account has supplied valid email/password credentials,
When the required MFA step has not been completed,
Then privileged access is denied,
And the attempt is audited.
```

### Registered rider device restriction

```text
Given a rider account is registered to one device,
When the same account attempts ordinary use on another unapproved device,
Then access is rejected until controlled device re-registration succeeds.
```

### Shared vendor session replacement and own-record access

```text
Given the shared vendor account has one active session,
When a new successful login occurs,
Then the earlier session is ended.

Given that vendor account requests another vendor's order or file,
Then the backend rejects the request without revealing whether the record exists.
```

### Delivery-lane selection and confirmation gate

```text
Given hub itemization is complete,
When authorized Ops selects Melarc doorstep delivery or approved courier/station handoff,
Then the lane, actor, reason/context and timestamp are recorded,
And the vendor can see the resulting lane through owned tracking data.

Given a parcel is assigned to Melarc doorstep delivery,
When recipient confirmation has not succeeded and no authorized exception exists,
Then the parcel cannot enter a dispatched delivery run, regardless of payer.
```

### Mandatory milestone notifications

```text
Given a parcel reaches an approved major customer milestone,
When the business event commits,
Then an audience-appropriate SMS is queued idempotently,
And a registered vendor also receives the applicable in-app milestone.
A retry or replay must not create duplicate customer messages for the same event version.
```

### Mode-specific manual third-party handoff

```text
Given a STATION_DROP order,
When the rider records a valid handoff with the approved courier/station, waybill, mandatory evidence, custody timestamp, rider and hub,
Then Melarc closes the Station Drop service exactly once,
And no external courier API response is required.

Given a MELARC_COVERED_THIRD_PARTY_DELIVERY order,
When the same station handoff is recorded,
Then the order remains commercially open,
And Melarc must later record final external delivery, final failure resolution, or completed external return before terminal closure.
```

## 43.3 Feature-completeness criteria

A feature is not accepted merely because its main screen and happy-path endpoint exist. It requires, as applicable:

- Approved business rules, commercial gates, and permissions.
- Canonical states and errors.
- Frontend interface states (Section 41.1).
- Backend validation, authorization, idempotency, and concurrency behaviour.
- Audit and notification effects.
- Evidence/file behaviour.
- Automated tests and Product Owner/UAT review.
- Updated specification, API contract, and implementation notes.

## 43.4 End-to-end launch acceptance

Version 1 cannot be accepted until the approved launch transaction can be demonstrated from booking through a terminal delivery/return and financial outcome, including exception recovery. The normal delivery and return path is now policy-defined. End-to-end launch acceptance still depends on completing payment/reconciliation detail, technical security/OTP contracts, exceptional returns/claims, reporting targets, and measurable NFRs. The high-level notification channels and manual courier integration boundary are now confirmed. High-level identity, session, recovery, and vendor own-record access policy is now confirmed.


### Dashboard access and drill-down

```text
Given a hub user opens the operations dashboard,
Then every metric is scoped to an authorized hub and identifies its freshness,
And selecting a metric opens only the authorized underlying records.

Given an authorized HQ role opens the all-hub dashboard,
Then aggregates preserve hub attribution and do not double-count the same operational record.
```

### Standard report CSV export

```text
Given a user is authorized for a report and data scope,
When the user exports CSV,
Then the export uses the same filters, timezone, money values and authorization as the on-screen report,
And the export event and scope are auditable.
```

### Application form factors

```text
Given Version 1 clients are built,
Then Melarc Ops is delivered as desktop-first responsive web,
Melarc Vendor as a mobile-first installable PWA,
And Melarc Rider as a native Android application rather than a Rider PWA.
```

### OpenAPI contract governance

```text
Given a frontend or backend change alters an operation, payload, enum, error or contract-visible behaviour,
Then the version-controlled OpenAPI contract is reviewed and updated intentionally,
And automated validation detects implementation drift before release.
```

### Reliability and recovery targets

```text
Given the production release candidate,
Then monitoring and tests demonstrate the approved availability/response targets using documented measurement rules,
And a verified backup/restore exercise demonstrates daily backup coverage, no more than 24-hour data-loss exposure, and a 4-hour restoration target.
```

## 43.5 Acceptance traceability

A future traceability matrix should map:

```text
Business objective
→ Master requirement ID
→ Feature/decision
→ UI flow
→ OpenAPI operation
→ Domain/service implementation
→ Test case
→ Release status
```
### Fleet acceptance

Fleet acceptance must prove that a rider report remains pending until Senior Ops decision; confirmation blocks new-run assignment; active-run transfer preserves parcel custody and completed-stop attribution; unsafe field handover routes work through the hub; and maintenance completion alone cannot restore availability without Senior Ops approval.

### Hub-zone estimate and frozen price

```text
Given a one-package request captures both origin and destination at booking,
When the booking is created,
Then the system displays a clearly labelled delivery-fee estimate.

Given a standard (≥2-package) request has no destination data yet,
When the booking is created,
Then the system displays no monetary price estimate.

Given hub itemization confirms the origin and destination zone,
When the order is confirmed,
Then the backend calculates and freezes the authoritative zone-pair (or corridor) fee plus size surcharge — the parcel's first price if the standard case showed no estimate,
And preserves the hub, origin zone, destination zone, price-table version, estimate (where one existed), final fee, and timestamp.
```

### Rider cash reconciliation

```text
Given a rider collected recipient delivery-fee cash during a run,
When the rider returns to the responsible hub,
Then the expected and handed-over cash are reconciled before the run/workday is financially closed,
Or a visible shortage/overage exception is opened.
```

### Direct Hubtel recipient payment

```text
Given a recipient owes a mobile-money amount,
When Melarc Rider starts the Hubtel flow,
Then the recipient pays Melarc rather than the rider,
And delivery cannot close until the backend confirms a successful attributable payment.
```

### Vendor statement payment channel

```text
Given an approved vendor has an issued weekly statement,
When payment is made in Version 1,
Then the payment uses Hubtel/mobile money,
And the statement balance changes only after backend confirmation.
Bank-transfer or cash-at-hub claims do not clear the statement through the normal workflow.
```

### Registered vendor onboarding and operational approval

```text
Given authorized Ops creates a new registered vendor organization,
When the creator submits it for review,
Then the organization cannot use normal Melarc Vendor features until a different hub Senior Ops actor approves it.

Given Senior Ops rejects the organization,
Then activation is blocked and the reason/history remain auditable.
```

### Separate account-allowance activation

```text
Given a vendor is operationally active but Platform Admin has not enabled account allowance,
When itemization calculates a vendor-paid amount,
Then the affected order enters PAYMENT_REQUIRED,
And it cannot be confirmed as dispatch-ready until the full vendor-paid amount succeeds.
Recipient-paid portions remain eligible subject to all other rules.
```

### Account-allowance activation and disablement

```text
Given a vendor is operationally active and Platform Admin completes basic verification,
When Platform Admin enables account allowance with a reason,
Then the global vendor account limit and weekly statement terms become available,
And no probation-delivery threshold is required.

Given Platform Admin disables account allowance with a reason,
Then each later vendor-paid amount calculated at itemization requires payment before the affected order becomes dispatch-ready,
And existing confirmed itemized orders, statements and outstanding obligations remain valid.
```

### Full statement payment and disputed line

```text
Given a weekly statement has a payable undisputed balance,
When the vendor attempts to pay less than that payable balance,
Then the payment must not partially settle the statement.

Given the vendor disputes one statement line,
Then that line enters controlled review without rewriting the issued statement,
And the vendor must pay the full undisputed payable amount.
When the dispute is approved,
Then a linked adjustment is posted.
```

### No monetary late penalty

```text
Given a payable statement balance remains unpaid at Thursday 8:00 AM Ghana time,
Then the statement becomes OVERDUE immediately,
And no flat or percentage late-payment penalty is added.
```

### Shared vendor login

```text
Given a registered vendor organization is active,
Then Version 1 exposes one organization login and no individual vendor-user invitation or role-management flow.
Every action is attributed to the organization credential, not a named vendor employee.
```

### Multiple saved pickup locations

```text
Given a vendor has multiple saved pickup locations and one default,
When the vendor selects another saved location for a request,
Then serviceability is validated for that request,
And the default location is not changed unless the vendor explicitly edits the saved-location setting.
```

### Vendor suspension hold

```text
Given a vendor is suspended,
Then the shared portal credential is blocked immediately,
And every non-terminal pickup/parcel/order enters a controlled hold.
No record or physical-custody link is deleted, and ordinary work cannot continue until authorized reactivation or exceptional disposition.
```

# 44. Definition of ready

**Section status:** `APPROVED`
**Approval status:** APPROVED PROCESS STANDARD

A feature or implementation slice is **Ready for Development** only when the team can build it without inventing product behaviour. Readiness is assessed for the complete vertical slice, not for frontend and backend in isolation.

## 44.1 Product readiness

- The objective, users, scope, and business value are stated.
- Relevant requirements have stable IDs and an approved or explicitly provisional classification.
- The normal, alternate, failure, cancellation, retry, and terminal paths are documented to the degree relevant to the feature.
- Material Product Owner decisions that affect implementation are incorporated into the appropriate retained specification before code relies on them.
- Blocking questions and contradictions are resolved; any accepted temporary/manual policy is written explicitly.
- In-scope and out-of-scope behaviour is clear for the target release.

## 44.2 Domain and rule readiness

- Actors, ownership, permissions, entities, fields, relationships, and invariants are known.
- Canonical states and allowed transitions are defined.
- Reasons, settings, thresholds, calculations, and historical snapshot rules are defined.
- Idempotency and concurrency-sensitive commands are identified.
- Audit, notification, evidence/file, privacy, and retention consequences are identified.
- Migration/backfill implications are known where existing data/code is affected.

## 44.3 Frontend readiness

- The page/route and user-flow location is known.
- Approved wireframes/Figma references or an explicitly accepted low-fidelity interaction specification exist.
- Forms, fields, tables/cards, filters, actions, and role visibility are defined.
- Loading, empty, validation error, error, retry, offline, stale or conflict, success, and permission-restricted states are specified, or recorded as not applicable to the surface.
- Responsive/device and accessibility expectations are stated.

## 44.4 Backend and contract readiness

- The relevant domain/service boundary is known.
- OpenAPI operations and schemas are drafted or approved.
- Stable enums, error codes, formats, pagination, upload, and authentication behaviour are known.
- External integration and background-job behaviour is defined where applicable.
- Security and ownership tests can be identified.

## 44.5 Acceptance and delivery readiness

- Testable acceptance criteria exist and map to requirement IDs.
- FE and BE responsibilities and dependencies are assigned.
- Test levels, seed/fixture needs, and required environments are known.
- Observability and operational recovery are defined for material failure modes.
- The implementation-plan task is small enough to complete, integrate, review, and demonstrate as one coherent slice.

## 44.6 Readiness result

Use one of:

- `READY` — all blocking criteria satisfied.
- `READY_WITH_APPROVED_ASSUMPTION` — a named, time-bounded assumption is approved and logged.
- `NOT_READY` — implementation would require invention or unresolved cross-team assumptions.

No scheduling pressure should silently convert `NOT_READY` into `READY`.
# 45. Definition of done

**Section status:** `APPROVED`
**Approval status:** APPROVED PROCESS STANDARD — project-specific quality gates must be added by engineering without weakening this baseline

A feature is **Done** only when it delivers the approved user/business outcome across the necessary surfaces and backend, not merely when code exists on separate branches.

## 45.1 Product completion

- Approved acceptance criteria pass.
- The Product Owner can demonstrate the normal and material exception paths.
- No in-scope requirement is silently omitted or replaced by developer preference.
- Any scope change, assumption, or follow-up is recorded in the control system.

## 45.2 Frontend completion

- Approved screens and interactions are implemented for authorized roles.
- Loading, empty, validation error, error, retry, offline, stale or conflict, success, and permission-restricted states work, or are recorded as not applicable to the surface.
- Responsive and accessibility requirements are verified.
- The frontend uses the canonical contract/enums and does not duplicate authoritative calculations.
- Sensitive data is not exposed in UI, storage, analytics, or logs beyond approved need.

## 45.3 Backend completion

- Business rules, state guards, ownership, and permissions are enforced server-side.
- Commands are atomic and retry/idempotency/concurrency behaviour is tested where applicable.
- Audit events, notifications, files, integrations, and background effects behave as specified.
- Migrations, indexes, constraints, data backfills, and rollback/recovery are reviewed.
- OpenAPI and domain documentation match the implementation.

## 45.4 Test completion

As applicable, the change includes:

- Unit tests for calculations and rule branches.
- Service/domain tests for state transitions and invariants.
- API tests for schemas, errors, permissions, ownership, duplicates, and concurrency.
- Frontend component/flow tests.
- FE–BE contract and end-to-end tests.
- Offline synchronization tests.
- Security/isolation tests.
- Performance/reliability tests for high-risk paths.
- Product Owner/UAT evidence.

All mandatory CI/quality gates pass without hidden skips.

## 45.5 Operational completion

- Logs, metrics, alerts, and dashboards cover the new failure modes.
- Support/operations users have appropriate status visibility and recovery procedures.
- Configuration, secrets, provider setup, migrations, deployment, and rollback are documented.
- Required runbooks and release notes are updated.
- Backup/restore or reconciliation consequences are addressed.

## 45.6 Documentation completion

Update, where applicable:

- Master Specification and decision/requirements registers.
- Domain model and state machines.
- OpenAPI contract.
- UI design references.
- Implementation plan/status.
- Operational runbooks and user guidance.
- Changelog/deprecation notes.

## 45.7 Completion result

A feature is not Done when:

- Only the happy path works.
- FE and BE are not integrated.
- Permissions are enforced only by hidden buttons.
- A manual database edit is required for normal operation.
- Known blocking defects are relabelled as future work without Product Owner approval.
- Documentation and tests describe different behaviour from production code.
# 46. Risks and dependencies

**Section status:** `APPROVED`
**Approval status:** APPROVED WITH DOWNSTREAM TECHNICAL DESIGN REQUIRED — owners and probability/impact ratings are confirmed; implementation controls, trigger indicators, contingency plans, and review dates must be completed in the implementation programme

## 46.1 Principal product and delivery risks

| Risk | Current evidence | Impact if uncontrolled | Required response | Owner | Probability | Impact |
|---|---|---|---|---|---|---|
| Scope-regression risk | The Version 1 logistics-operating-ERP boundary is approved, but later requests may reintroduce full-ERP or deferred capabilities | Unbounded work, delayed launch, and diluted core quality | Enforce change control and keep deferred work outside implementation slices unless formally promoted | Product Owner | Medium | High |
| Canonical lifecycle-contract risk | Product lifecycle policy is approved, but final domain enums, transition matrices, and API commands remain downstream | FE/BE divergence, invalid states, and incomplete exception closure | Approve the canonical domain/state model and transition tests before feature implementation | Backend Engineer | Low | High |
| Finance implementation risk | Payer, credit, statement, prepayment, reversal, and return-fee policy are approved; ledger/provider/reconciliation mechanics remain | Revenue leakage, duplicate charges, weak reconciliation, and disputes | Complete finance/domain/OpenAPI/integration design and immutable event controls before financial writes | Backend Engineer | Medium | High |
| Authorization implementation risk | Vendor ownership, hub scope, fixed Vendor/Rider bundles, and permission primitives are approved; the complete permission catalogue and negative tests remain | Cross-vendor or cross-hub data leakage | Finalize the permission catalogue, query-scoping rules, and denial tests before protected endpoints | Backend Engineer | Medium | High |
| Security-design completion risk | Authentication, MFA, device, session, and recovery policy are approved; cryptographic, token, rate-limit, lockout, and incident mechanics remain | Unauthorized access and unsafe recovery | Approve `SECURITY_DESIGN.md` and security acceptance tests before production identity flows | Backend Engineer | Medium | High |
| Source-policy regression | Historical documents contain superseded terms and rules | Reintroduced contradictions, invalid tests, and policy drift | Trace every downstream contract to the decision/requirements registers and reject superseded rules | Product Owner | Low | Medium |
| Missing authoritative API contract | Feature prose exists but `openapi.yaml` is not yet the approved FE–BE contract | Integration churn and incompatible implementations | Approve versioned OpenAPI before parallel frontend/backend feature work | Backend Engineer | Medium | High |
| Pricing/configuration readiness risk | Pricing models and governance are approved, but exact matrix, corridor, surcharge, return-fee, credit-limit, and high-value values remain launch configuration | Unpriceable orders, incorrect billing, and launch blockage | Load, approve, effective-date, snapshot, and test every required monetary setting before launch | Product Owner | High | High |
| Rider offline complexity | Native Android execution must tolerate unreliable connectivity while protecting custody, OTP, payment, and evidence | Duplicate/stale actions, local-data exposure, and evidence loss | Bound the offline action set and test encrypted storage, idempotent sync, conflict handling, and device loss | Frontend Engineer | Medium | Medium |
| Notification operational risk | Mandatory events/channels are approved; provider, templates, retries, delivery receipts, and fallback remain downstream | Missed customer actions and support burden | Approve notification/integration design, templates, monitoring, and operational fallback | Backend Engineer | Medium | Medium |
| Existing-code divergence | Existing implementation may not match the amended specification | False completion claims, migration defects, and hidden policy violations | Audit code before each slice, document gaps, and use controlled migrations | Backend Engineer | Low | Medium |
| Small-team delivery risk | One frontend and one backend owner must cover three applications and shared services | Bottlenecks, skipped review, and broad unfinished layers | Deliver vertical slices, automate quality gates, and enforce Definition of Ready/Done | Product Owner | High | High |

`

## 46.2 External dependencies

- SMS, email, and push providers with approved sender identities.
- Mapping, geocoding, or navigation services where selected by architecture.
- Secure object/file storage.
- Background-job broker and scheduling infrastructure.
- Hubtel/mobile-money services and reconciliation support.
- Registered courier/station relationships and any future APIs.
- Hosting, domain, certificates, monitoring, backups, and incident communication.
- Qualified Ghanaian legal/accounting review for privacy, rider cash/mobile-money custody, liability, invoices, taxes, retention, and settlement. The interim accountable owner and starting regulatory reference point are confirmed in Section 8.2.

No provider capability may silently redefine product policy.

## 46.3 Internal dependencies

- Current retained contracts, feature specifications, architecture, surfaces, standards, delivery specifications, and unresolved implementation dependencies stated in their owning documents.
- Canonical domain/state model, OpenAPI contract, UI designs, security design, finance design, and implementation plan.
- Complete permission catalogue.
- Approved pricing/settings values and operational owners.
- Representative test data, Android devices, and network conditions.
- Migration strategy from existing code and data.
- Operational validation by staff, riders, vendors, and finance/reconciliation users.

## 46.4 Risk-management process

Before an implementation slice enters planning, every material risk must have an owner, probability and impact rating, prevention/mitigation, trigger indicator, contingency/manual fallback, review date, related requirements, and release milestone. Accepted risks require an explicit Product Owner decision and may not arise from omission.

# 47. Assumptions

**Section status:** `APPROVED`
**Approval status:** APPROVED WITH DOWNSTREAM TECHNICAL DESIGN REQUIRED — confirmed operating and launch assumptions are binding; technical hypotheses remain non-authoritative until architecture approval

## 47.1 Confirmed operating assumptions

| Assumption | Authority | Consequence if invalidated |
|---|---|---|
| Version 1 serves Greater Accra, Ghana | `GEO-001`, `MSC-DEC-008` | Geography, zone catalogue, pricing data, and operations plan require controlled amendment |
| One active hub is sufficient at launch, while the model supports multiple hubs | `HUB-019`, `MSC-DEC-008`, `MSC-DEC-046–057` | Architecture and operating records require controlled migration if launch topology changes |
| The exact physical identity/address of the launch hub is operational configuration, not fixed by this Master Specification | Section 12.4 and hub-setting governance | The configured launch hub may change without altering the multi-hub product model, provided zones/settings are approved and snapshotted |
| The product is a logistics operating ERP, not a full general-purpose ERP | `SCOPE-001`, `MSC-DEC-007` | Any broader ERP module requires controlled scope promotion |
| Registered vendors are created by Ops and approved by Senior Ops; public self-registration is unavailable | `MSC-DEC-094` | Onboarding, security, and support flows would require amendment |
| Recipients and ad-hoc senders have no general portal account in Version 1 | `MSC-DEC-099–102`, `ACCESS-001` | Identity, consent, UX, and authorization scope would expand |
| Melarc Ops Portal, Melarc Vendor, and Melarc Rider are separate purpose-built surfaces | `MSC-DEC-005`, `ACCESS-001` | Navigation, authorization, deployment, and device assumptions would change |
| `GHS` (Ghana cedi) is the only launch transaction currency | `MSC-DEC-179` | Money schema, pricing, statements, provider integration, reporting, and migration require controlled multi-currency design |
| `Africa/Accra` is the canonical business timezone | `MSC-DEC-035–037` | Statement, scheduling, reporting, and audit boundaries require amendment |
| Manual stop ordering, lane assignment, and courier/station selection are acceptable at launch | `MSC-DEC-108`, `OQ-024` | Route/dispatch automation must be promoted and designed |
| Rider connectivity is unreliable enough that controlled offline capability is material | `MSC-DEC-111`, `OQ-027` | Mobile design and operational fallback would be simplified if later disproved |
| Custody, money, approvals, evidence, and privileged access require strong audit trails | Sections 7, 35, 37, and 38 | Compliance, dispute, and operational accountability would be weakened |

## 47.2 Approved launch-scale assumptions

The initial engineering and operations plan should test approximately:

- 150 registered vendors;
- 10 riders;
- fewer than 50 parcels per day;
- at least 95% delivery success;
- at least 99% reconciliation accuracy; and
- low acceptable manual workload.

These are internal launch assumptions and quality targets, not contractual service-level commitments or permanent capacity limits.

## 47.3 Technical hypotheses requiring architecture validation

The following are not product-policy authority:

- Django/Python as the backend implementation stack;
- PostgreSQL as the primary relational database;
- Celery or another asynchronous task framework;
- a particular cloud, storage, mapping, SMS, monitoring, or deployment provider.

`SOLUTION_ARCHITECTURE.md`, `DOMAIN_MODEL.md`, `SECURITY_DESIGN.md`, and the deployment design must approve or replace them. A technology hypothesis may not be presented as a customer promise or used to change product behaviour.

## 47.4 Assumption-control rule

Every implementation-affecting assumption must identify its authority or owner, review milestone, impact if invalidated, and temporary behaviour. Confirmed assumptions may change only through controlled amendment; technical hypotheses remain non-authoritative until their named architecture artifact is approved.

# 48. Approved decisions

**Section status:** `APPROVED`
**Status:** ACTIVE PRODUCT POLICY

## 48.1 Process decisions

`MSC-DEC-001–004` establish the six-stage specification process, the 52-section structure, the persistent continuity system, and the prohibition against inventing unresolved business policy.

## 48.2 Approved baseline decisions

`MSC-DEC-005–132` establish the version 1.0 product baseline, including:

- official product/application names and the logistics-operating-ERP boundary;
- Greater Accra launch, one active hub, and multi-hub-capable ownership/access rules;
- registered-vendor, ad-hoc sender, rider, recipient, Ops, Senior Ops, and Platform Admin responsibilities;
- pickup booking, manifesting, collection proof, failed-pickup handling, blind hub receipt, OS&D, itemization, pricing, dispatch, delivery, return, and courier/station handoff;
- recipient/vendor/split delivery-fee payer policy, no merchandise COD, no subscription pricing, three delivery attempts, no redelivery fee, return-fee treatment, vendor credit accounts, weekly statements, and Hubtel/mobile-money boundaries;
- one shared Vendor account, registered rider device, privileged MFA, vendor ownership isolation, and hub-scoped access;
- fleet, fuel, maintenance, notification, dashboard/report, application form-factor, OpenAPI, and non-functional targets; and
- all registered source-contradiction resolutions through Stage 6.

## 48.3 Post-baseline decisions through Sprint 022

`MSC-DEC-133–175` confirm:

- permission primitives and editable role bundles, including dedicated Finance/Reconciliation, Auditor, Executive/Report-consumer, and Fleet Manager bundles;
- suspended-vendor held-parcel disposition;
- staff/rider availability, onboarding, suspension, offboarding consequences, and suspension grounds;
- per-hub booking cutoff, late-booking Ops review, and Monday–Saturday operations;
- configurable retention by category, legal-hold exemption, Platform Admin retention authority, and Auditor export access;
- mixed carrier/commercial-mode delivery runs;
- high-value handling/claims policy and launch-scale targets;
- interim legal/compliance accountability and the starting Ghana regulatory reference point;
- risk owners and ratings;
- return-fee governance and waiver reasons;
- the zone-pair matrix, universal size surcharge, and corridor pricing model;
- vendor and staff/rider suspension grounds and suspension-triggered return-fee applicability;
- ad-hoc sender phone verification, prohibited-item catalogue, and no individual credit; and
- no monetary estimate for standard multi-package pickup requests before itemization.

## 48.4 Sprint 023 decisions

The Product Owner instruction to “Fix all” approves the following remediation decisions for the v1.15 candidate. Their approved outcomes are incorporated directly into the retained specification set; no separate decision-register or requirements-ledger synchronization is required.

### `MSC-DEC-176` — Itemized-order prepayment and credit gate

A standard pickup request may be confirmed and physically collected before a vendor-paid amount exists. Vendor credit eligibility and prepayment are evaluated after itemization calculates the authoritative fee. Credit reserves at itemized-order confirmation. Where allowance is disabled, the vendor is overdue, or exposure is insufficient, the order enters `PAYMENT_REQUIRED` and cannot become dispatch-ready until the full vendor-paid amount succeeds. This decision supersedes only the earlier **timing** phrase “before booking confirmation”; it preserves the approved requirement for prepayment rather than additional credit.

### `MSC-DEC-177` — Station Drop fee governance

`station_drop_fee` is one company-wide, effective-dated setting with a launch value of GH₵25. Hub Senior Ops proposes a change and Platform Admin independently approves or rejects it. New Station Drop charges snapshot the approved effective value/version; existing charges do not reprice.

### `MSC-DEC-178` — One-package estimate composition

The one-package exception may show a provisional base-fee estimate using the known origin and destination. It excludes size and high-value surcharges unless those inputs were captured and validated at booking, must disclose those exclusions, and never replaces the authoritative itemized price.

### `MSC-DEC-179` — Launch currency

`GHS` (Ghana cedi) is the only Version 1 transaction currency. Money uses ISO code `GHS` and fixed-decimal representation. Multi-currency requires a later controlled Product Owner decision.

### `MSC-DEC-180` — Corridor codes and non-batch terminology

The corridor machine codes are `AMASAMAN_ENVIRONS` and `KASOA_CORRIDOR`, displayed as “Amasaman & Environs” and “Kasoa Corridor.” `NON_BATCH_RATE` is the stable machine/API term for the higher corridor rate outside batch days. It is not an Express service.

### `MSC-DEC-181` — Mode-specific terminal outcomes

Doorstep service terminates at successful delivery or completed return. Station Drop terminates at verified station/courier handoff. Melarc-covered third-party delivery remains open after handoff and terminates only at recorded final external delivery, final failure resolution, or completed external return. Approved exceptional dispositions must preserve custody and financial closure.

Decisions marked `CONFIRMED_WITH_FOLLOW_UP` establish product direction while leaving named technical mechanics to controlled downstream artifacts.

# 49. Deferred items

**Section status:** `APPROVED`
**Approval status:** APPROVED DEFERRAL CATALOGUE — release assignment and reprioritization remain controlled changes

A deferred item remains visible with its rationale, dependencies, impact, temporary/manual process, and promotion trigger.

## 49.1 Confirmed deferrals

### Pickup, routing, and network automation

- Multi-origin pickup errands/consolidation.
- Automated pickup and delivery route optimization.
- Automatic failed-pickup rescheduling.
- Live rider GPS and predictive ETA.
- Automatic lane classification or courier matching.
- Operational inter-hub parcel transfer until another hub opens.

### Hub, parcel, and evidence automation

- Dimensional/weight-based pricing.
- Hub barcode/label scanning.
- OCR/evidence extraction and automated waybill correction.
- ML-assisted high-value detection.
- Named reusable recipient/customer coverage groups across future bookings.
- Full insurance/claims product beyond the approved Damaged/Dispute workflow.

### Commercial and configuration expansion

- Express/priority service.
- Subscription pricing.
- Merchandise COD.
- Per-zone or per-vendor pricing/setting overrides unless later promoted.
- Individual/ad-hoc credit.
- Multi-currency.
- Advanced claims/liability products.

### Broader ERP and customer platform

- Payroll and staff compensation.
- General accounting/general ledger and budgeting.
- Procurement and supplier management.
- Expanded CRM, sales, and customer-success capabilities.
- Multiple individual users/roles inside a vendor organization.
- Recipient or ad-hoc sender portals.

### External integration expansion

- Automated external courier booking, labels, webhooks, and tracking APIs.
- Advanced mapping/route-optimization integration beyond the approved launch design.
- Rich rider telemetry beyond approved device/run requirements.

Core Version 1 delivery, failed-delivery/return, payment/reconciliation, vendor settlement, identity/access, notifications, reporting, administration, fleet/fuel/maintenance, and manual courier/station handoff are **not deferred**.

## 49.2 Deferral record requirements

Every deferred capability must state its stable ID, reason, target review milestone, dependencies, user/business impact, temporary process, data/model seams, and promotion conditions.

## 49.3 Prohibited use of deferral

Deferral must not hide a step required to complete the Version 1 transaction, remove a security/isolation/audit/data-integrity control, declare a partial feature complete, resolve a contradiction without authority, or move a failed acceptance criterion out of scope.

# 50. Open questions

**Section status:** `APPROVED`
**Status:** RETAINED FOLLOW-UP CATALOGUE — unresolved items in this section remain implementation dependencies until resolved in the owning retained specification

This section lists only the remaining implementation-gating residue. It deliberately does not restate registry totals because totals must be generated from the current controlled register, not maintained independently in narrative prose.

`OQ-045` is resolved by `MSC-DEC-142` and `MSC-DEC-171`; no suspended-vendor return-fee-applicability residue remains. `OQ-046` is resolved by `MSC-DEC-175`. Sprint 023 decisions `MSC-DEC-176–181` close the audit findings concerning prepayment timing, Station Drop fee governance, one-package estimate composition, launch currency, corridor terminology, and mode-specific terminal outcomes.

## 50.1 Remaining Product Owner/legal/operational follow-ups

- `OQ-003`, `OQ-004` — exceptional OTP recovery, vendor/sender refusal or unavailability, loss/damage, claims, unpaid-return custody/escalation, and exceptional final disposition.
- `OQ-020` — exact launch monetary values: zone-pair cells, size surcharges, corridor rates, high-value tiers/surcharge, global vendor credit limit, and the initial configurable return-fee amount. The pricing models and editing authorities are approved.
- `OQ-033` — vendor reactivation, termination, offboarding retention details, rejection/reapplication, and business-verification evidence.
- `OQ-038` — who may refuse or block an individual/ad-hoc sender from future bookings and the permitted grounds.
- `OQ-042` — return-workflow cancellation/failed-return adjustments, immediate-payment methods, unpaid-return storage/escalation, post-payment/reconciliation corrections, and split validation/rounding. Return-fee setting governance, waiver reasons, and suspension applicability are resolved.
- `OQ-044` — detailed multi-hub/HQ configuration, zone-boundary/versioning, temporary-assignment duration/overlap, reassignment side effects, and future transfer mechanics.
- Exact retention periods per category require qualified legal/compliance input under Section 8.2 and Section 38.7.

## 50.2 Approved downstream-design follow-ups

- `OQ-005` — finance/domain/OpenAPI/integration design for provider states, payment allocation, reconciliation, receipts, refunds/reversals, immutable ledger, and accounting export.
- `OQ-018` — canonical entity/state catalogue and exhaustive transition matrices.
- `OQ-027` — native Android offline action set, encryption, retry, conflict, evidence, device loss, and idempotency.
- `OQ-030` — complete Figma/UI page, route, navigation, responsive, and interface-state (Section 41.1) inventory.
- Complete permission-key enumeration, service-account permissions, and whether per-user overrides are permitted.
- Exact SMS/payment provider contracts, OTP security parameters, notification templates, mapping/geocoding choice, and file-storage mechanics.
- Dashboard/report formulas, data dictionary, masking, export scale, and retention.
- Exact staff/rider offboarding authority and exceptional device re-registration/loss/replacement authority.

## 50.3 Terminology and configuration follow-ups

- `OQ-037` remains assigned to UI/content design for final customer-facing labels. Stable machine terms in Section 51—especially `NON_BATCH_RATE`, official application names, and no merchandise COD—must not be changed by display-copy choices.
- Exact per-hub booking cutoff times, maintenance intervals, compliance warning lead times, failure backstop hours, recipient-confirmation attempt limits, and other approved operational settings must be configured before their affected slice launches.

## 50.4 Change-control rule

No follow-up may be silently deleted or treated as solved merely because implementation prose exists. It must close through an explicit Product Owner decision, an explicit not-applicable disposition, an approved deferral, or completion of the named artifact with appropriate acceptance evidence. Any resolution that changes product behaviour must be incorporated into the affected retained specification sections and acceptance criteria before implementation relies on it.

# 51. Glossary

**Section status:** `APPROVED`
**Approval status:** APPROVED PRODUCT TERMINOLOGY

| Term | Canonical meaning |
|---|---|
| Ad-hoc Sender | An individual or non-portal sender served through Ops-assisted intake. The phone is verified by SMS OTP at first use; no Version 1 credit facility exists. |
| Amasaman & Environs | Display name for corridor code `AMASAMAN_ENVIRONS`. Batch days are Tuesday and Friday. |
| Batch day | A corridor's configured operating day on which the lower batch rate applies. |
| Credit account | The approved registered vendor commercial account. Vendor-paid itemized orders reserve exposure at itemized-order confirmation when allowance and available limit permit; earned unpaid charges consume the same exposure without double-counting. |
| Delivery fee | The amount Melarc charges for its logistics service, distinct from merchandise value. |
| Delivery Lane | The authorized post-itemization choice between Melarc doorstep delivery and approved third-party handoff. |
| Delivery Run | An ordered group of stops assigned to one rider. A run may mix registered/informal carriers and Station Drop/Melarc-covered commercial modes while each order retains its own facts. |
| Express service | A legacy priority/same-day service concept explicitly excluded from Version 1. It is not the corridor non-batch rate. |
| Group coverage | Selection of multiple parcels/orders in one current pickup request whose full delivery fees are assigned to the vendor/sender; not a reusable customer group. |
| Hub | A Melarc operating location where custody is received, reconciled, itemized, and dispatched. One is active at launch; the model supports multiple hubs. |
| Intra-corridor rate | The configured base rate for pickup and delivery within the same corridor on that corridor's batch day. |
| Kasoa Corridor | Display name for corridor code `KASOA_CORRIDOR`. Its batch day is Friday. |
| Locked Price | The authoritative historical price frozen at itemized-order confirmation and changeable only through the approved correction workflow. |
| Melarc-Covered Third-Party Delivery | Prepaid combined waybill-plus-Melarc service in which the recipient pays nothing at destination and Melarc remains responsible until the recorded final external outcome. |
| Melarc Ops Portal | Internal staff application for operations, administration, finance, reporting, fleet, and oversight. |
| Melarc Platform | The complete product suite. |
| Melarc Rider | Native Android rider application for assigned pickup/delivery work, evidence, custody, OTP, and delivery-fee collection. |
| Melarc Vendor | Mobile-first PWA for a registered vendor's eligible booking, own-order tracking, payer/account activity, notifications, and returns. |
| Merchandise COD | Collection of the vendor's product value from the recipient. **Not supported by Melarc.** |
| Mini POS | Melarc Rider workflow for approved cash or mobile-money delivery-fee collection at the door. |
| Non-batch rate | Stable machine/API term `NON_BATCH_RATE`: the higher corridor base rate outside configured batch days. It is not an Express service. |
| Origin zone | The active service zone containing the pickup request's one origin: the selected vendor pickup location or ad-hoc sender pickup location. It is snapshotted for pricing. |
| Parcel size category | Small, Medium, Large, or Extra Large. Small has GH₵0 surcharge; the other categories use configurable flat surcharges. |
| Payer intent | The request-level recipient/vendor/split choice recorded before parcel prices exist. Itemization converts it into authoritative per-order monetary allocations. |
| Payer split | The authoritative allocation of a delivery fee between vendor/sender and recipient, expressed as a fixed GHS amount or percentage. |
| Payment-required state | `PAYMENT_REQUIRED`: an itemized order whose vendor-paid amount cannot use credit and must be fully paid before dispatch readiness. It does not block physical intake closure. |
| Permission | A named atomic backend authorization capability such as `pricing.correction.approve`. |
| Recipient | The person expected to receive the parcel and the default delivery-fee payer; no general Version 1 portal account. |
| Return fee | A separate company-wide configurable charge earned when formal return-to-vendor processing starts. Hub Senior Ops proposes changes and Platform Admin approves them; the applied value is snapshotted. |
| Role | A named editable bundle of permissions. It carries no authority beyond its current permissions and is not the backend enforcement primitive. |
| Sender | The contracting or presenting party for pickup; may be a registered vendor or eligible ad-hoc sender. |
| Standard multi-package booking | A pickup request with at least two packages. It has no monetary price estimate because parcel destinations are captured at itemization. |
| Station Drop | Prepaid service in which Melarc transports a parcel to an approved station/courier and completes its service at verified handoff; the recipient pays the third party's onward charge. |
| Station Drop fee | Company-wide effective-dated setting `station_drop_fee`, GH₵25 at launch. New charges snapshot the applied value/version. |
| Terminal outcome | Mode-specific final parcel state: doorstep delivered or returned; Station Drop verified handoff; Melarc-covered final external delivery/failure resolution/return; or another approved exceptional disposition with custody and financial closure. |
| Vendor | The registered contracting organization/customer. |
| Vendor account | The shared Version 1 vendor credential and related commercial record. It is not a SaaS tenant-admin account or a named employee identity. |
| Zone-pair price | The Version 1 base delivery fee for an origin-zone/destination-zone combination, except where a corridor destination uses its corridor rate card. |

# 52. Review and approval history

**Section status:** `APPROVED`
**Approval status:** APPROVED PRODUCT AND SYSTEM BASELINE

Section 1.3 retains the historical amendment summary. Git history records future changes to the development baseline.

| Version | Date | Approval state | Summary |
|---|---|---|---|
| 0.1–0.9 | 14–19 July 2026 | Controlled drafting and review | Control system established; sources consolidated; 52 sections drafted; interviews and contradiction resolution completed; review edition normalized. |
| 1.0 | 19 July 2026 | Product Owner approved | Stage 6 final audit passed and the 52-section baseline was approved. |
| 1.1–1.8 | 21 July 2026 | Approved amendments, Sprints 009–016 | Permission architecture/bundles, suspended-vendor parcel disposition, staff/rider lifecycle, booking calendar/cutoff, retention, mixed delivery runs, high-value policy, and launch targets added. |
| 1.9–1.14 | 23 July 2026 | Approved amendments, Sprints 017–022 | Legal/risk governance, return-fee governance, zone/size/corridor pricing, suspension grounds, ad-hoc sender policy, and standard-booking no-estimate policy added. |
| 1.15 | 23 July 2026 | Product Owner–approved amendment, Sprint 023 | Itemized-order prepayment timing, Station Drop fee governance, one-package estimate composition, GHS currency, corridor terminology, and mode-specific terminal outcomes approved; audit normalization completed. |

## 52.1 Current approval status

This document is the **Product Owner–approved controlling Master Product and System Specification v1.15**, consisting of the approved v1.0 baseline plus amendments through Sprint 023. It controls product behaviour, scope, roles, journeys, commercial rules, acceptance expectations, and downstream design constraints.

Approval does not make every implementation slice automatically ready. Each slice must satisfy the applicable Section 50 follow-ups, approved downstream artifacts, Definition of Ready, and Definition of Done.

## 52.2 Development baseline

The retained Melarc specification set is the implementation baseline. This Master Specification defines overall product and system behaviour, while detailed contracts, features, surfaces, architecture, standards and delivery slices provide the implementation-level requirements.

Historical package-sealing, register-synchronization and audit-package workflows are no longer part of the active development process. Git history records changes to the development baseline.

## 52.3 Next development action

Follow `delivery/DEVELOPMENT_EXECUTION_PLAN.md`, `delivery/planning/BOOTSTRAP_B0_RUNBOOK.md`, `delivery/IMPLEMENTATION_PLAN.md` and the applicable slice specification. Complete the engineering bootstrap before product-slice implementation, then develop Melarc incrementally against the retained contracts and acceptance criteria.
