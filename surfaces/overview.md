# Surfaces — Overview

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.9 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** the surface model, the two-gate authorisation picture, and what-lives-where
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../PROJECT_MASTER_SPECIFICATION.md) §10, §11.1, §35.1.2, **§41 (frontend responsibilities), §40.5 (client and device baseline)**

## 1. The surface model

Melarc uses **purpose-built applications, not one system behind several logins** (§10.1). The surface establishes the *category* of work; role, hub, assignment and record ownership then determine the permitted actions.

> The surface picks the menu; the permission picks what you may order off it.

| Surface| Form factor| Primary users| Purpose| Explicit boundary|
|---|---|---|---|---|
| [Melarc Ops Portal](ops-portal.md)| Desktop-first responsive web| Internal staff bundles (§11.3)| Logistics command centre — create work, monitor state, resolve exceptions, approve, configure| **Not** a rider field tool. Payroll, general accounting and procurement are outside Version 1|
| [Melarc Vendor](vendor-pwa.md)| Mobile-first responsive PWA| Registered vendor shared account| Book, track own parcels, see fees and statements| **Not** a SaaS workspace, vendor ERP or tenant environment|
| [Melarc Rider](rider-android.md)| **Native Android**| Assigned riders| Field execution, evidence, custody, fee collection| **Not** a web app or PWA. No approval, pricing or adjudication|
| [Recipient channel](recipient-channel.md)| SMS, calls, Hubtel, OTP| Recipients and ad-hoc senders| Confirmation, payment, milestones, delivery authorisation| **No authenticated portal in Version 1**|

**Why the recipient and ad-hoc sender share one document.** §2 counts "four primary interaction channels" and groups them; §10.1 tables them as two rows. `CONFLICT-020` resolved this to one document: they share every mechanism — SMS and phone, no portal, OTP-gated, Hubtel prompts — and differ only in which end of the transaction the person stands at. That is a role distinction the document handles internally, not a surface boundary.

**The shared backend is not a surface.** §10.1's sixth row is the [`contracts/`](../contracts/) layer.

## 2. The two gates

§11.1 and §35.1.2. Two independent checks, and passing one never implies the other.

1. **Surface gate** — which category of work this application exposes at all.
2. **Permission and ownership gate** — whether this actor may perform this action on this record, given held permissions, responsible hub, vendor ownership, rider assignment, current state, and any approved temporary assignment.

§35.1.2 states the failure mode plainly: *"being allowed into a portal does not imply permission to perform every action shown in that portal."*

**Every surface enforces this server-side.** §45.7: permissions enforced only by hidden buttons is not enforcement. A surface may hide an action for clarity; it may never rely on hiding for control.

## 3. What lives where

The rule of thumb: **do-the-work goes to the field surface; configure, approve and analyse go to the back office.**

| Capability| System of record| Mirrored elsewhere?|
|---|---|---|
| Pickup request creation| Ops Portal| Vendor may create for itself|
| Request confirmation| **Ops Portal only** in V1| Vendor self-confirm deferred|
| Manifest planning, rider assignment, dispatch| Ops Portal| Rider sees the run, never the plan|
| Run execution, collection, evidence| **Rider**| Ops sees outcomes|
| Handshake| Rider **and** Vendor — two-party by design| Direction fixed by §21.4, `MSC-DEC-114–115`|
| Hub receiving, blind count, OS&D| **Ops Portal only**| Vendor sees the summary only (§22.9)|
| Itemization and pricing| **Ops Portal only**| Vendor sees an indicative estimate at booking, then the frozen fee|
| Booking intake| **Ops Portal and Vendor PWA**| WhatsApp bookings are transcribed by Ops; both channels enforce identical rules|
| Recipient confirmation call| **Ops Portal only**| —|
| Delivery execution, OTP, fee collection| **Rider**| —|
| Milestone communication| Recipient channel| Vendors also receive in-app (§20.3)|
| Settings, reasons, courier registry, approvals| **Ops Portal only**| Never vendor- or rider-visible|

## 4. The nine interface states

**Nine, not eight.** §44.3 lists eight; **§41.1 adds `retry`**, and the union is what every surface owes:

`loading` · `empty` · `validation error` · `error` · **`retry`** · `offline` · `stale or conflict` · `success` · `permission-restricted`

A screen specified only in its success state is not ready. `retry` was missed until the Phase 1–2 audit because §44.3 was treated as the complete list and §41 had not been read.

Each surface document carries these for its own screens. Two apply differently by surface: **offline** is substantive only on Rider, and even there §19.8 approves offline behaviour for hub-handover queuing alone. **Permission-restricted** applies everywhere, and must degrade to a clear refusal rather than a blank screen.

## 4a. What §41 requires of every frontend

§41.1, and two of these are not otherwise recorded anywhere:

- Consume the approved OpenAPI contract and shared schemas.
- **Never invent enum values, error formats, money or date behaviour, or state transitions.**
- Enforce all nine states above.
- Display authoritative backend validation and status.
- Preserve idempotency and retry identifiers where the contract requires them.
- Protect tokens, sessions, local data and evidence per the security design.
- Support accessibility and responsive or device requirements for the form factor.
- **Map every user action to an OpenAPI operation and an acceptance criterion.**

**The last one is not yet done anywhere.** It is the mechanism connecting this layer to the contract and to the acceptance criteria in [`features/`](../features/README.md), and it is part of what `OQ-030` owes.

§41.5 defines that debt precisely — the eight artifacts required before implementation: page and route inventory; navigation and role-based action matrix; wireframes and reusable component and state definitions; responsive and Android device layouts; the nine states; accessibility requirements; **OpenAPI operation mapping**; and frontend acceptance-test coverage.

§40.5 adds the client baseline each surface must define and test: supported desktop browsers and narrower layouts for Ops; supported mobile browsers, installability and update or cache behaviour for Vendor; supported Android versions, device registration, local security, camera, location, storage, background work and app-update distribution for Rider.

## 4b. What every `SLICE-000` screen set shares

Gate PD-3R1. **The three surfaces each specify their own authentication screens, and each left the same four things unsaid.** They are summarised once here so that no surface can drift from the others; **each surface states them in its own inventory, which is where they bind.**

- **A sign-out control on every signed-in screen**, calling `signOut`. A `SESSION_INVALID` answer to the sign-out itself means the session had already ended and reads as done.
- **A signed-in landing for a build holding `SLICE-000` alone** — the Ops Portal's `/`, the Vendor PWA's `/account`, the Rider app's *Signed-in home*. Later slices fill the landing; none replaces it.
- **Lockout and rate-limit states, decided per screen**. A staff **password** screen never announces a lock — nothing has been proved, and the announcement would reveal which addresses exist. A staff **second-factor** screen, a **vendor** sign-in from a registered browser and a **rider** sign-in that carries a valid signature each say *locked for fifteen minutes*, because the person has already reached the factor. `RATE_LIMITED` is a plain *wait a minute* everywhere. **No screen says which factor failed.**
- **Credential entry** shows the rule and never the value: a staff password or a vendor shared secret is **12 to 128 characters, spaces allowed, no other requirement**; a rider PIN is **six digits**. The value is never echoed, never logged and never kept after the request.

**The interim browser, layout and accessibility baselines are not here.** Each surface states its own for the `SLICE-000` screens — [ops-portal.md](ops-portal.md) §11, [vendor-pwa.md](vendor-pwa.md) §9 and [rider-android.md](rider-android.md) §9 — because the three surfaces are inputs to `SLICE-000` and this overview is not, and a baseline a slice rests on belongs in a document the slice names. Each is the **interim baseline the Product Owner accepted for Version 1**, which the Frontend Engineer confirms by approving the surface, narrower than §40.5 asks, and **closes neither `OQ-073` nor `OQ-030`**.

## 5. Cross-surface rules

- **Never trust the frontend** for totals, prices, OTP assertions, payment success, ownership, hub assignment or status transitions (§37.1).
- **Never require a hidden server value to be echoed back** — the blind declared count, the authoritative price, an ownership identifier, a permission decision (§42.3).
- **Never duplicate an authoritative calculation** (§45.2). A surface displays the server's price; it does not compute one.
- **Machine codes and display labels are separate** (§36.13). Customer-facing wording is `OQ-037`; a surface maps an error code to copy and never shows the diagnostic `message`.
- **Times display 24-hour local, no timezone label** — Ghana is UTC+0 year-round and V1 serves Greater Accra only. Exports carry an explicit offset.
- **Operational codes are `HUB-TT-XXXXXX`** with a confusion-free alphabet, because they are read aloud on phone calls.
- **Own-record access is enforced on every page, export, notification, file and API response** — five surfaces, each needing its own negative-access test (§37.6, §18.7).

## 6. Open questions

| ID| Effect on this layer| Type|
|---|---|---|
| `OQ-030`| The complete page, route, navigation, responsive, loading, empty, error, offline and permission-state inventory. **These five documents are what closes it**| `ARTIFACT_REQUIRED`|
| `OQ-037`| Final customer-facing labels. Machine terms in §51 — `CORRIDOR_OFF_DAY` (replacing the withdrawn `NON_BATCH_RATE`), the application names, no merchandise COD — must not be changed by copy choices| `ARTIFACT_REQUIRED`|
| ~~`OQ-027`~~| **Closed 28 September 2026, `MSC-DEC-419`** — Version 1's offline scope is hub-handover queuing alone, every other rider act is online-only, and the design of that one queued act is written at [rider-android.md](rider-android.md) §4.1. The concrete encrypted-storage API follows `OQ-073`'s Android floor.| ~~`ARTIFACT_REQUIRED`~~|
| `OQ-052`, `OQ-053`| *Closed* — code format and time display fixed by `MSC-DEC-202–203`| —|

## 7. What this layer still owes the slices

*A surface carries no readiness verdict (`MSC-DEC-423`, extending `MSC-DEC-239`): the slice's Definition of Ready, area D, judges whether a surface is specified well enough for that slice. This section lists what is still owed.*

| Owed| Blocks which DoR area| Owner|
|---|---|---|
| The controlled page and screen inventory for each surface that §10.4 requires; these documents carry the model and the boundaries| D (frontend)| `OQ-030`|
| Final customer-facing labels| D| `OQ-037`|


§10.4 requires each surface to carry a controlled page and screen inventory, navigation model, role and permission states, forms, tables and cards, the nine states, responsive rules, accessibility criteria, component references, and a mapping to OpenAPI operation IDs and acceptance criteria. These documents establish the **model and the boundaries**; the page-level inventory is `OQ-030` and arrives with design.

What they do deliver now: every feature can name which surface renders it, what that surface may never show, and which permission gates each action.

## 8. Related

- **Down:** [ops-portal.md](ops-portal.md) · [vendor-pwa.md](vendor-pwa.md) · [rider-android.md](rider-android.md) · [recipient-channel.md](recipient-channel.md)
- **Across:** [features/README.md](../features/README.md) — surfaces link down to features; features link back up
- **Authority:** [contracts/permissions.md](../contracts/permissions.md) for every gate named here
