# Melarc Vendor

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.22 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** navigation, screen inventory and interface states for the vendor PWA
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../PROJECT_MASTER_SPECIFICATION.md) §18, §10.1, §10.3, **§41.1, §41.3, §40.5**

## 1. What this surface is

A **simple mobile-first responsive Progressive Web App** whose primary purpose is to let an approved registered vendor place requests and track its own orders (§18.1).

**The boundary is stated as a negative, and that is deliberate.** §18.1: it is *"not a SaaS workspace, vendor ERP, or separately managed tenant environment."* It may additionally show only what the service relationship requires — saved locations, payer allocation, the frozen fee, statements and payments, notifications, returns.

**It must never expose** another vendor's records, or internal Melarc operations: blind receiving counts, route construction, rider-only evidence, privileged reasons, adjudication detail.

## 2. Users and the shared credential

**One shared login per registered vendor** (§18.3). There are no individual vendor users, invitations, roles, team management, tenant administration, or owner transfer. One active session per credential; a new successful login ends the previous one.

**Activity is attributable to the vendor account, not a named employee** — and §37.5 makes this an interface constraint: *"the UI must not claim person-level attribution."* A screen reading "approved by Ama" would assert something the data cannot support.

Ad-hoc senders have **no login** and never reach this surface.

## 3. What the vendor can do in Version 1

| Capability| Available?|
|---|---|
| Create a pickup request for itself| **Yes**|
| Cancel its own **`PENDING`** request| **Yes**|
| Confirm a request| **No — Ops only in V1**|
| Cancel its own **`CONFIRMED`** request| **No — deferred, not deleted**|
| Use the one-package exception| **No — excluded from self-service** (§18.5, §35.2.4)|
| Enter the collection handshake code| **Yes** — this is the vendor half of the two-party proof|
| Manage saved pickup locations| **Yes** — create, edit, deactivate, select; one default (§18.4)|
| Edit payer arrangement| **Yes, until price freeze** (§23.5)|
| Track own orders through terminal outcome| **Yes**|
| See a recipient-contact exception on its own order and supply a corrected or alternative contact| **Yes** — an input Ops applies, never a change the Vendor makes|
| See a scheduled redelivery, its fees and that **the recipient pays**| **Yes**|
| Self-service dispute of a pickup failure| **No form exists in V1** (§21.5, `MSC-DEC-122`) — contact support|

**The deferred rows must read as deferred, not absent.** `MSC-DEC-196` is explicit that self-service is reversible; the interface should not be built in a way that makes re-enabling a redesign.

## 4. Navigation model

§18.7: **placing a request and tracking orders are the dominant navigation.** Everything else is secondary.

| Area| Screens| Features rendered|
|---|---|---|
| **Book**| New request · saved-location picker with override · declared count and item description · payer intent| [pickup-request](../features/pickup/pickup-request.md)|
| **Track**| Order list · order detail with milestones · indicative estimate · frozen fee · exception status| [pickup-request](../features/pickup/pickup-request.md), [itemization](../features/hub/itemization.md)|
| **Confirm**| Handshake code entry| [pickup-collection](../features/pickup/pickup-collection.md)|
| **Locations**| Saved pickup locations, default selection| [pickup-request](../features/pickup/pickup-request.md)|
| **Account**| Payer allocation, commitments, statements, returns, allowance state| Phase 4|

## 5. The pricing states are the hard part of this surface

§18.5 and §23.6 required **three** visually distinct price states. `MSC-DEC-211` reduced them to **two**, and this is now the simplest it has been — but the remaining distinction is the one that matters:

| State| When| What the vendor sees|
|---|---|---|
| **Indicative estimate**| Any booking with no known destination, before itemization| Base fee × package count, **labelled provisional**. Assumes `SMALL` and in-area doorstep|
| **Destination-resolved estimate**| A **one-package exception**, whose delivery address is mandatory (§21.1)| Priced from the **resolved service area** — in-area, corridor batch day, or corridor off-day. Still provisional: the size class is chosen at itemization|
| **No estimate**| A one-package exception to a destination **outside Accra**| Nothing shown. The carrier's charge is unknown until itemization|
| **Frozen fee**| After itemization| The authoritative price. Clearly distinguished from the estimate that preceded it, and **both are preserved**|

**`No estimate` was withdrawn on 20 August and returns on 23 August for one case only.** `MSC-DEC-175` showed nothing at all, because the zone-pair matrix needed a destination zone nobody had at booking. Flat pricing removed that obstacle for the ordinary booking, and it stays removed.

**What `MSC-DEC-211` got half-right, and `MSC-DEC-245` corrects.** It retired `MSC-DEC-178`'s one-package special case on the ground that *“every booking now can”* show a number. True — and it discarded the extra information that case uniquely carries. **Being able to show a number everywhere is not a reason to show the same kind of number everywhere.** A single package to Kasoa on a Tuesday showed GH₵35 and was charged **GH₵90**, on a booking whose address the system already held. `No estimate` therefore returns **only** where the destination is known **and** outside Accra — never for the multi-package case that originally justified it.

**Why the estimate can still be wrong, and must say so.** The size class is selected by a receiving officer at itemization, and outside-Accra pricing depends on a carrier's charge nobody knows at booking. §23.6 still binds: **clearly label the estimate against the frozen price and preserve both.** A vendor who sees GH₵105 and later GH₵195 must be able to tell which was which and why.

## 6. Page inventory

**Scope: three slices** — `SLICE-001` pickup through hub itemization in this table, `SLICE-000` authentication, and `SLICE-003`'s recipient-contact exceptions and redelivery notice below. `OQ-030` remains open on its four-surface scope.

Each row names the route, the permission that gates it, and the states that are **non-obvious for that page** — the nine interface states all apply everywhere and repeating them per row would be noise. What is recorded here is where a state carries a rule.

| Route| Purpose| Permission| States carrying a rule|
|---|---|---|---|
| `/`| Order and request list| vendor account| **`empty`** for a new vendor must invite a first booking, not read as an error|
| `/requests/new`| Book a pickup| vendor account| **`retry`** on submit. Must enforce **the same rules as the WhatsApp path**|
| `/requests/{id}`| Request detail, indicative estimate, cancel| vendor account, **own** only| **`not found`** — another vendor's id looks exactly like an id that does not exist: the same page, the same words (`NOT_FOUND`, `MSC-DEC-432`). **There is no *forbidden* page for a record that belongs to someone else**|
| `/orders/{id}`| Order detail, frozen fee, milestones| vendor account, **own** only| **`stale`** when the price freezes mid-view — explain, do not silently swap the number|
| `/handshake`| Enter the rider's collection code| vendor account| **`retry`** and **`offline`** are the whole point — this page failing is what the SMS fallback exists for|

**Vendor pages are gated by account ownership, not by a permission key**, so the `OQ-047` read gap does not bite here — the rule is *own records only*, a scoping rule the domain model already carries. It bites hard on the Ops Portal, where four list pages need keys that do not exist.

**Five routes for `SLICE-001`, and the vendor surface is deliberately small.** Seven `SLICE-000` routes follow below. Version 1 defers vendor self-service on requests, and `MSC-DEC-215` explains why: WhatsApp is how vendors actually book today. `/requests/new` exists because both channels run in parallel, not because the PWA is the primary path.

**`/handshake` is the one page whose failure has a designed consequence.** When it cannot load — no data, portal down — the rider triggers the SMS fallback. Its `offline` and `retry` states are therefore not polish: they are the signal that tells a vendor to expect an SMS rather than keep tapping.

### Authentication routes — `SLICE-000`

**Seven routes, and each names the operations behind it** (`OQ-074`, narrowed to this slice at Gate PD-3R1). Six are pre-authentication or token-only; `/account` is the signed-in landing and `/account/devices` the only other signed-in page.

| Route| Purpose| Operations| Permission| States carrying a rule|
|---|---|---|---|---|
| `/sign-in`| Account identifier and shared secret. **The browser proves itself with `melarc_vendor_device`, and sign-in fails without it**. An unregistered browser cannot sign in whatever the secret; the vendor must use recovery to register it| `vendorSignIn`| **None — pre-auth**| **`error` must not distinguish** a wrong secret from a suspended account from an unregistered browser from a wrong identifier. **No device field is rendered** — nobody types a device identifier. **`CREDENTIAL_LOCKED` is shown only when the server returns it, which is only to a browser registered to the account**: *this account is locked for fifteen minutes; if the secret is lost, use recovery* — the lock covers everyone at the organisation, and the copy says so. From an unregistered browser the page can never show it. `RATE_LIMITED` says *wait a minute*. **A displaced session returns here** with *someone at your organisation signed in on another device* (`SESSION_SUPERSEDED`), never *your session expired*|
| `/setup/credential`| Vendor sets its **own** first shared secret and registers this browser| `completeVendorCredentialSetup`| **None — grant only, pre-auth**| **No application shell.** One `error` for an unknown, expired, consumed or superseded grant (`SETUP_GRANT_INVALID`) that must not re-open the form. **`validation error` states the rule — at least 12 and at most 128 characters, spaces allowed, no other requirement — and never echoes the value.** `success` reminds the vendor that sign-in needs the **account identifier** from the setup message|
| `/recovery`| Request recovery to the registered phone or email| `requestCredentialRecovery`| **None — pre-auth**| **No *account not found* state**, and **no field offering a destination** — the channel comes from the registered contact. `RATE_LIMITED` says *wait a minute* and nothing more|
| `/recovery/complete`| Set a new shared secret. **This browser is registered as the account's device and receives a fresh `melarc_vendor_device` cookie**; obsolete device credentials are revoked| `completeCredentialRecovery`| **None — token only**| **One `error` for a malformed, expired, reused or superseded link** (`RECOVERY_TOKEN_INVALID`). **`success` must warn that every session ends**, including this one, **and that a lock is cleared**. The vendor is usually removing someone else's access, and the sign-out that follows is the feature working. The same 12-to-128 rule as setup|
| `/setup/device`| Register **this** browser as an additional one, from the grant sent to the account's registered channel. The grant token is the only input — **no account identifier, no secret and no device field** — and this browser receives a fresh `melarc_vendor_device` cookie **beside** the existing ones (`vendor-authentication.md` §5.5)| `completeAdditionalDeviceEnrolment`| **None — grant only, pre-auth**| **No application shell.** **`success` must say that no session was issued** and send the vendor to `/sign-in`, where signing in on this browser **ends the session on the browser that asked for the grant**. `error` on a consumed or expired grant must not re-open the form|
| `/account`| **The signed-in landing for a build holding `SLICE-000` alone**: the organisation, the account, and the way to `/account/devices`. **Carries the sign-out control that every signed-in page carries.** `SLICE-001` fills it with the request and order list at `/` and keeps this page| `getCurrentSession` · `signOut`| vendor account| **`empty`** — *nothing booked yet* is a first-run message, never an error. **Sign-out** calls `signOut`, clears the local view and **reads as done even if the session had already ended**. A `401` anywhere else returns to `/sign-in` without saying why|
| `/account/devices`| The browsers registered to this account — **identity and status only, never a credential** — with **add another** and **revoke one**, neither of which changes the shared secret| `listVendorDevices` · `requestAdditionalDeviceGrant` · `revokeVendorDevice`| vendor account, **own** only (`self`)| **`success` on add must say the grant went to the registered channel**, and the screen offers **no field for a destination** — the channel comes from the account record. **The row for the browser in use cannot be revoked** (`STATE_CONFLICT`): say so rather than offer a button that fails. **Revoked and replaced browsers stay listed** — a holder checking for one they did not authorise must see it. **Revoking ends that browser's session** (`DEVICE_REVOKED`), sends the `ETag` the list read, and leaves the secret and every other browser untouched. **Another vendor's device id is the same *not found* as an id that does not exist**|

**Twelve routes across `SLICE-001` and `SLICE-000` — a running subtotal.** The `SLICE-003` section below adds three; **fifteen in all**, derived 2 October 2026.

**`/setup/device` and `/account/devices` are new in v0.19, and they were owed since 13 September.** `AC-SLICE-000-45` exercises two of the four device operations — the grant request and the enrolment — and `AC-SLICE-000-100` the other two, the list and the revocation; this paragraph said one criterion *exercises all four*, which it never did. `MSC-DEC-398` withheld the signature of `SetupGrant` §19 until **a vendor could see and revoke its own registered browsers**; `MSC-DEC-399` gave it once the operations existed. The contract carried them from 20 and 21 September; this surface inventoried no screen that called them, so the condition was met in the API and at no page a vendor could open. The Pre-development audit register records it as `PDA-15`.

**`/setup/credential` is new in Gate A.** Vendor sign-in previously required an account identifier, a shared secret and a device identifier, and **no screen or process established any of them** — the account could be approved and still had no way to become usable.

**Recovery does not sign the vendor in.** `success` must send them to `/sign-in`, and say so. The browser is now registered and the secret is new; the session is a separate act.

**Every unsafe request echoes the CSRF token.** The session cookie is `HttpOnly`; the `melarc_csrf` cookie beside it deliberately is **not**, because the page must read it to send it in `X-CSRF-Token`. A missing or wrong token fails with `CSRF_VALIDATION_FAILED`. **The readable cookie gives an attacker nothing** — they still cannot send the session cookie from their own origin.

**This surface is served from `vendor.<melarc-domain>` and calls the API on a same-origin `/api/...` path**. **The paragraph above depends on it.** Built against a separate API host, the `SameSite=Lax` session cookie is not attached to the surface's own requests at all, and the change that presents itself as the fix — widening the cookie to the parent domain — would let a session issued here authenticate the Ops Portal and back. **Cookies stay host-only.** Deployment topology at [DEPLOYMENT_AND_ENVIRONMENTS.md](../architecture/DEPLOYMENT_AND_ENVIRONMENTS.md) §12.1.

**`/sign-in` loses its device field.** The registered browser proves itself with a device credential held in a cookie it cannot read; a typed identifier proved nothing and asked the user for a value they had no way to know.

**`/recovery/complete` carries the one message this surface must get right.** Completing recovery terminates **every** session for the account, including the one performing it (§37.5). A vendor who changes the secret and is immediately signed out will read that as a bug unless the screen said so first — and the person they were trying to lock out is signed out too, which is the entire point.

**`/sign-in` must handle displacement gracefully on return.** A vendor signing in here ends a colleague's session elsewhere. That is routine (§11.2) and the surface should not dramatise it.

### Recipient-contact exceptions — `SLICE-003`

`MSC-DEC-348`. **A Vendor with forty parcels out cannot act on *a delivery failed*.** These pages exist so they can act on the one that matters.

| Route| Purpose| Permission| States carrying a rule|
|---|---|---|---|
| `/orders/{id}/contact-exceptions`| What went wrong with **this** parcel: **recipient name** · order reference · checkpoint · reason · **where the parcel is now** · what is being asked of the Vendor| `delivery.read`| **The recipient's name is the point.** Without it a Vendor cannot tell which of their customers is affected, and the notification is noise|
| `/orders/{id}/contact-assistance`| Supply a **corrected number**, an alternative contact, or a clarification| `vendor.contact_assistance.submit`| **A submission is an input, not a change**. The page must not imply the number has been updated — **Ops applies the correction**|
| `/orders/{id}/redeliveries`| **A redelivery has been scheduled**: recipient name · order reference · new date or window · applicable delivery fee · hub redelivery fee · **payer: recipient** · status| `delivery.read`| **The payer line is not optional.** A Vendor seeing two fees against their parcel and no payer will assume they are being billed. **They are not**, and no Product decision makes them so|

**Nothing beyond the Vendor's own order relationship is shown.** Gate B scope is unchanged: a Vendor sees recipient details for parcels they sent, and no others.

**A Vendor who replies on official WhatsApp is not second-class.** Ops captures that reply into this same workflow with identical weight — **the channel must not decide who has authority.**

**HIGH-17 audit remediation (13 September 2026) — how a Vendor learns a new exception exists.** Today, only by opening `/orders/{id}/contact-exceptions` (or its listing) themselves: `vendor.contact_exception.notified` is emitted when Ops's own contact attempts are exhausted (§3.2 of [recipient-channel.md](recipient-channel.md), `MSC-DEC-348`), but nothing in this contract **actively** reaches the Vendor when it fires — this surface has no established push, email or SMS alert of its own, and none is invented here. **A `contactException` is real only once this pull-based page is opened**, and a Vendor who does not open it can hold an unresolved exception indefinitely with no signal beyond the general expectation that they check their orders. Whether Melarc should build an active alert for this event — and through what channel, since a web-push mechanism for a PWA is not itself an established or approved capability anywhere in this corpus — is `OQ-117`, raised from [recipient-channel.md](recipient-channel.md) §6.2 and equally this surface's question, not resolved here.

## 7. The nine interface states

| State| Requirement here|
|---|---|
| `loading`| Order lists load progressively; a pending-pricing order must not flash a zero|
| `empty`| "No orders yet" is a first-run state, not an error|
| `validation error`| Field-level, plain customer language (§18.7)|
| `error`| Maps the code to customer copy. Never the diagnostic `message`|
| `retry`| §41.1. A failed booking submission must be retryable without re-entering the form|
| `offline`| PWA installable behaviour; a lost connection must not lose a part-completed booking|
| `stale / conflict`| An order whose price froze while the vendor was editing payer allocation must explain that, not just refuse|
| `success`| Confirms what happened in customer terms — "pickup booked for Tuesday", not "state: CONFIRMED"|
| `permission-restricted`| Deferred self-service actions **explain**, rather than silently disappearing|

## 8. What this surface must never do

- **Never expose internal operations.** Blind counts, the rider declaration, discrepancy evidence, route construction, internal adjudication, privileged notes — all Ops-only (§18.1, §22.9).
- **Never show another vendor's data**, on any page, export, notification, file or API response (§18.7). Five surfaces, five negative-access tests.
- **Never claim person-level attribution** (§37.5).
- **Never use internal ERP or tenancy terminology** (§18.7). Plain customer language.
- **Never present the indicative estimate as a quote.** `MSC-DEC-211` permits the number; it does not make it binding. An unlabelled estimate that later changes is the specific failure §23.6 exists to prevent.
- **Never hide the estimate once a fee has frozen.** Both are preserved and both stay visible — a vendor disputing a price needs to see what they were originally shown.
- **Never offer the one-package exception** (§18.5).
- **Never present a suspension as a data loss.** Suspension blocks login and ordinary work through a controlled hold; records, financial history and physical custody are preserved (§18.6).

## 9. Responsive, device baseline and accessibility

Mobile-first, responsive to desktop, **installable PWA behaviour** (§10.3, §18.7, §41.3). §41.3 adds **predictable PWA update and caching behaviour** — not merely installability.

**§40.5 client baseline, to be defined and tested:** supported mobile browsers, installability, update and cache behaviour, responsive desktop use. Accessibility is `OQ-030`. **Interim baseline for the `SLICE-000` screens — accepted by the Product Owner for Version 1, the Frontend Engineer confirming it by approving this document; narrower than §40.5 asks, and it closes neither question:** the current and previous major release of Chrome on Android and Safari on iOS, and the desktop browsers the Ops Portal lists; layouts verified at **360 px** and **768 px**; the PWA's update and cache behaviour is not part of this baseline. **Accessibility, for every `SLICE-000` screen:** keyboard-operable with a visible focus; every input has a programmatic label and its error is associated with it; status and error messages are announced to assistive technology; nothing is conveyed by colour alone. **WCAG 2.2 level AA is the working target; it is not a conformance claim.**

**§41.1 requires every user action mapped to an OpenAPI operation and an acceptance criterion.** **The operation half is done for the seven `SLICE-000` routes**, which name theirs in §6, and not for the others; the acceptance-criterion half is part of what `OQ-030` owes.

## 10. Open questions

| ID| Effect here| Type|
|---|---|---|
| `OQ-030`| Page inventory and Figma flows — §18.8's first listed gap| `ARTIFACT_REQUIRED`|
| `OQ-037`| Customer-facing copy, which matters more here than anywhere: this is the only surface a paying customer sees| `ARTIFACT_REQUIRED`|
| ~~`OQ-033`~~| **Closed 21 September 2026, `MSC-DEC-397`** — verification evidence, rejection and reapplication, suspension and reactivation mechanics are decided| ~~`DECISION_NEEDED`~~|
| `OQ-048`| Notification preferences and message content| `EXTERNAL_INPUT`|

## 11. What this surface still owes its slices

*A surface carries no readiness verdict (`MSC-DEC-423`, extending `MSC-DEC-239`): the slice's Definition of Ready, area D, judges whether this surface is specified well enough for that slice. This section lists what is still owed.*

| Owed| Blocks which DoR area| Owner|
|---|---|---|
| The page inventory, which §44.3 requires| D (frontend)| `OQ-030`|
| The operation-to-screen map §41.1 requires — **the seven `SLICE-000` routes name every operation they call** (Gate PD-3R1); the other slices' routes do not| D| `OQ-074`|
| The supported mobile browsers, installability, update and cache behaviour §40.5 requires| D| `OQ-073`|
| Customer-facing copy| D| `OQ-037`|

The boundary, the V1 capability set, the **two** pricing states and the never-do list are complete.

## 12. Related

- **Up:** [overview.md](overview.md)
- **Down:** [pickup-request](../features/pickup/pickup-request.md) · [pickup-collection](../features/pickup/pickup-collection.md) · [itemization](../features/hub/itemization.md)
- **Authority:** [contracts/permissions.md](../contracts/permissions.md) §10 for the shared-credential consequences
