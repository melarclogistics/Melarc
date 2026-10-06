# Melarc Ops Portal

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.34 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** navigation, screen inventory and interface states for the internal command centre
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../PROJECT_MASTER_SPECIFICATION.md) §17, §10.1, §10.3, **§41.1–41.2, §40.5**

## 1. What this surface is

Melarc's **desktop-first responsive internal logistics command centre** (§17.1). One controlled environment for creating work, monitoring operational state, resolving exceptions, recording custody, applying approvals, and seeing cross-vendor activity appropriate to the user's role.

**Boundary.** Not a rider field tool. Payroll, general accounting and procurement are outside Version 1. Desktop-first workflows must stay usable at narrower widths but may optimise dense operational tables for desktop (§10.3).

## 2. Users

The seven bundles at §11.3 that use this surface: **Ops Staff**, **Senior Ops**, **Platform Admin**, **Finance/Reconciliation**, **Auditor**, **Executive/Report-consumer**, **Fleet Manager**.

**Customer Support and Warehouse Supervisor deliberately have no dedicated bundle** — support sits inside Ops Staff, hub-floor supervision inside the Ops Staff / Senior Ops split (§11.3, `MSC-DEC-137`, §11.3, `MSC-DEC-140`). §17.2 is explicit that this is a decision, **not an undefined gap**.

## 3. Hub visibility

§17.5, and this is finer-grained than it first appears:

| Bundle| Sees|
|---|---|
| Ops Staff and hub staff| Primary hub **plus any currently effective temporary-assignment hub**|
| Senior Ops| Own hub|
| Platform Admin and authorised company-wide roles| All hubs|

**A temporary hub assignment never grants company-wide visibility**, and "cross-vendor" never implies unrestricted database access. Enforced server-side and audited.

## 4. Navigation model

Seven areas, each a queue-led workspace: the six capability areas of §17.3 and **Doorstep and money**, which §17.3 does not list and which the delivery features below place on this surface. **Queue counts and filters that make pending work visible** are the organising principle (§17.4) — this is a surface where the primary job is knowing what needs attention.

| Area| Screens| Features rendered|
|---|---|---|
| **Pickup intake and approval**| Sender search · ad-hoc sender creation · request form · request detail with attempt-chain history · one-package maker-checker| [pickup-request](../features/pickup/pickup-request.md)|
| **Pickup-run planning**| Unmanifested pool · manifest builder with manual stop reordering · rider assignment · run progress · confirmation reconciliation| [pickup-manifest](../features/pickup/pickup-manifest.md), [pickup-collection](../features/pickup/pickup-collection.md)|
| **Failed-pickup operations**| **Needs-decision queue** · failure detail · reschedule, cancel, escalate · senior queue| [pickup-failure](../features/pickup/pickup-failure.md)|
| **Hub receive and itemization**| Awaiting-receive queue · blind count · reveal and OS&D · itemization forms · intake closure| [hub-intake](../features/hub/hub-intake.md), [itemization](../features/hub/itemization.md)|
| **Recipient readiness and dispatch**| Pre-dispatch confirmation queue · recipient-contact exception queue · escalation queue · run-ready pool · delivery-run builder| [recipient-confirmation](../features/dispatch/recipient-confirmation.md), [delivery-run-build](../features/dispatch/delivery-run-build.md), [atomic-dispatch](../features/dispatch/atomic-dispatch.md) — routes at §7.|
| **Doorstep and money**| Receive Money · fallback authorisation · OTP fallback · failure review and redelivery · cash handover · hub reconciliation and disposition| [doorstep-delivery](../features/delivery/doorstep-delivery.md), [delivery-failure](../features/delivery/delivery-failure.md), [cash-collection](../features/delivery/cash-collection.md) — routes at §7|
| **Administration**| **Staff identities · vendor accounts · rider roster and devices · live sessions** (`SLICE-000`, routes at §7) · courier registry · approved agents · reason catalogue · global settings · audit history · reports| **The courier/station and approved-agent registers have their operations** (`SLICE-005`, `MSC-DEC-417`; routes at §7), and the reason catalogue has `upsertReasonDefinition` (`settings.reason.manage`); global settings, audit history and reports await `SLICE-013`|

**The needs-decision queue is specified in unusual detail** by §17.3 and the fields are mandatory: failure category, reason, evidence, contact attempts, wait time, attempt count, retryability, cap state, escalation state.

**Signed-in navigation depends on caller-capability discovery, which is not specified yet.** Which entries a session may use cannot be derived from the `Session` resource: it carries `authorized_hub_ids` but no permissions or bundle contents, and no operation returns what the caller may do ([staff-authentication](../features/identity/staff-authentication.md) §12: *a client asks the server what it may do*). The shell's navigation component therefore takes a plain list and shows none until a later slice specifies the source; no permission model is invented client-side.

## 5. Two booking channels, one set of rules

`MSC-DEC-215` confirms vendors book **by WhatsApp, entered by Ops**, or **through the Vendor PWA** directly. Both run concurrently; neither is a migration stage.

**The binding requirement is that they are indistinguishable downstream.** Both paths must apply identical validation and produce identical records — the minimum-package rule, the 10am cutoff queue, the corridor batch-day fee and the indicative estimate all behave the same way whether a vendor typed the booking or an Ops officer transcribed it from a chat. **A rule enforced on one channel and not the other is a defect, not a channel difference.**

This also explains `MSC-DEC-196`. Vendor self-service was deferred not as a scheduling choice but because WhatsApp is how vendors actually book today, which is why Ops-created bookings are the primary path in Version 1.

**WhatsApp has no surface document.** It carries no screens Melarc controls, so §41's interface states do not apply to it in the ordinary way — the same situation as the recipient channel. Whether it belongs here as an intake path or needs its own entry is `OQ-063`.

## 6. Itemization puts two revenue decisions in this surface

Both are new with the pricing refactor and both are Ops-only:

| Decision| Why it sits here|
|---|---|
| **Size class**| Selected by judgement, not derived — `MSC-DEC-209` establishes no thresholds. Worth up to GH₵30. The screen must record who chose it, and must not offer a default that quietly becomes the answer|
| **Carrier cost**| Transcribed from a third-party waybill for outside-Accra parcels. The only monetary figure any client submits, so the field needs evidence capture beside it|

Neither may appear on the Rider app: a doorstep workflow governed by blind-count discipline is the least controlled place to put a pricing judgement.

## 7. Page inventory

**Scope: five slices** — `SLICE-001` pickup through itemization, `SLICE-000` authentication, `SLICE-002` dispatch, `SLICE-003` the doorstep and its returns, and `SLICE-005` the outbound handoff. **This line read *"three slices"*** while the doorstep and parcel-return tables sat below it, and `MSC-DEC-417` then added the outbound routes. `OQ-030` remains open for every surface's full inventory; this closes it for the proving slice and now covers the outbound one, which is what §44.3 requires before a slice can be `READY`.

Each row names the route, the permission that gates it, and the states that are **non-obvious for that page** — the nine interface states all apply everywhere and repeating them per row would be noise. What is recorded here is where a state carries a rule.

| Route| Purpose| Permission| States carrying a rule|
|---|---|---|---|
| `/pickup-requests`| Queue of requests; filter by state and service date| `pickup.read`| **`empty`** distinguishes *no requests* from *filtered to nothing* — conflating them sends Ops hunting for a bug|
| `/pickup-requests/new`| Create for a vendor or ad-hoc sender| `pickup.request.create`| **`retry`** on submit; **`stale`** if the vendor was suspended mid-form|
| `/pickup-requests/{id}`| Detail; confirm, decline, cancel, reschedule| `pickup.read`| **`stale/conflict`** on concurrent edit — `If-Match`, never silent overwrite|
| `/pickup-requests/{id}/exception`| Request the one-package exception| `pickup.exception.request`| **`forbidden`** must read as *an approver holding `pickup.exception.approve` decides this*, not *you lack access*. **Not a role name**|
| `/approvals`| Pending one-package exceptions| `pickup.exception.approve`| **`forbidden`** only where the actor does not hold the key. **Senior Ops holds it, and Ops Staff may be granted it** — the page names the **permission** required, never a role|
| `/manifests`| Manifests for the acting hub| `pickup.read`| **Never vendor-filtered.** A manifest spans vendors|
| `/manifests/new`| Build from the unmanifested pool| `pickup.manifest.create`| **`stale`** when a request is manifested by another officer mid-build|
| `/manifests/{id}`| Stops, sequence, rider, dispatch| `pickup.read` · actions: `pickup.manifest.create`, `.assign`, `.dispatch`| **`stale/conflict`** on sequence edit; assign and dispatch are **separate actions**, never one button|
| `/manifests/{id}/stops/{stopId}/skip`| **Authorise a skip**, with a reason from the `PICKUP_STOP_SKIP` catalogue| `pickup.stop.skip`| **The run cannot close without this** — §4 needs every stop terminal, so a stop nobody can resolve strands the whole run. **The reason picker offers four codes and no free text**; a note is mandatory on `LOCATION_INACCESSIBLE` and `STOP_RAISED_IN_ERROR`. **The screen must say the Vendor will be notified**, because it always is, and **must not offer it as a way to clear a failed stop** — that is `pickup.failure.resolve`'s page|
| `/intakes`| The awaiting-receive queue — open intakes at this hub, from **`listHubIntakes`** filtered to `AWAITING_COUNT`: run, the rider who handed over, submission timing, and who is actively receiving (§22.3)| `hub.read`| **`empty`** is normal early in the day. **No declared count appears — not even a zero one** — before the blind count commits|
| `/intakes/{id}/count`| Enter the physical count| `hub.intake.count`| **The rider's declared count must not appear on this page in any form** — not greyed, not in a tooltip, not in a network response the page discards. Opening the page takes the advisory lock (**`acquireIntakeLock`**); if another receiver holds it, the page says who, and takeover waits for the idle TTL (§22.8)|
| `/intakes/{id}`| Comparison, itemization, closure| `hub.read`| **`loading`** must not flash a zero price; comparison is revealed **only after** the count commits|
| `/intakes/{id}/items/new`| Itemize a parcel into an Order| `hub.intake.itemize`| **Size class offers no default** — a pre-selected `SMALL` becomes the answer by inertia and quietly costs revenue|
| `/intakes/{id}/discrepancy`| Adjudicate over, short or damaged| `hub.osd.adjudicate`| Reachable on a **`MATCH`** variance too — damage is independent of count|

**Thirteen routes for `SLICE-001`, and all thirteen express their authorisation.** Nineteen for `SLICE-000` follow below.

**This inventory is what closed `OQ-047`'s read half.** Writing it forced a permission to be named for every route, and four list and detail pages turned out to need read keys that did not exist — §11.5 made the catalogue *“write/action-oriented only”*. `MSC-DEC-221` supplied sixteen, one per domain, and those four routes now carry `pickup.read` and `hub.read`.

The last gap closed the same day. `/manifests/{id}` needed a rider-assignment key, which `MSC-DEC-222` supplied as `pickup.manifest.assign` — held by the same actors, so no authority moved. It exists because assignment is the moment vendor self-cancellation closes, not because anyone new needed the right.

**Sequencing was never missing.** `pickup.manifest.create`'s own note already read *“build and order stops”*. `OQ-065` was raised by searching for a key name rather than reading what the existing keys claim — the cheaper check, and the one to run first.

Use only defined permission keys. An unresolved authorization rule must be resolved before implementing its operation.

Two routes carry rules that a competent implementation will otherwise get wrong:

**`/intakes/{id}/count` must not receive the declared count at all.** `HubIntakePreCount` has no such property by schema, so the guard is structural rather than a matter of frontend discipline — but a page that fetches a richer endpoint “for convenience” would defeat it. The blind count is only blind if the number never arrives.

**`/intakes/{id}/items/new` must not default the size class.** `MSC-DEC-209` made it a human judgement precisely because no rule can derive it. A default is a derivation by another name, and it would be accepted unchanged on most parcels.

### Authentication and identity administration routes — `SLICE-000`

**Nineteen routes, and each names the operations behind it** (`OQ-074`, narrowed to this slice at Gate PD-3R1). **Seven are pre-authentication**, which makes them the only screens in the product that render without a session — and therefore the only ones where a careless error message leaks something. **Twelve are signed-in**, from the landing to the identity-administration pages.


**Pre-authentication**

| Route| Purpose| Operations| Permission| States carrying a rule|
|---|---|---|---|---|
| `/sign-in`| Email and password| `staffSignIn`| **None — pre-auth**| **`error` must not distinguish** an unknown email from a wrong password, a suspended, pending or offboarded identity, or a locked one, in text *or* timing (§37.7). **There is no lockout state on this page**: a lock is never announced at the password step, so adding *locked* copy here would turn the screen into the account-existence oracle it exists not to be. `RATE_LIMITED` says *too many attempts — wait a minute* and nothing more. **A privileged sign-in returns `202` and a challenge, never a session** — the page must not render a signed-in shell on a `202`|
| `/sign-in/mfa`| Second factor for Senior Ops and Platform Admin. **The challenge expires in 5 minutes and dies after 3 wrong codes**| `completeStaffMfaSignIn`| **None — holds a challenge, not a session**| **The page must not render a signed-in shell.** No navigation, no user menu, no data. **Four refusals, four states, not merged:** `MFA_PROOF_INVALID` *that code was not accepted* (the attempts left are not shown); `CHALLENGE_UNUSABLE` *this attempt is finished — sign in again*; `CHALLENGE_EXPIRED` *that took too long — sign in again*; **`CREDENTIAL_LOCKED` *this account is locked for fifteen minutes; recovering the password clears it*** — told here and nowhere earlier, because the person holds a challenge and so has proved the password|
| `/recovery`| Request recovery to the verified work email| `requestCredentialRecovery`| **None — pre-auth**| **`success` is shown identically** whether or not the account exists. There is no error state for *unknown account* and **no field offering a destination** — the channel comes from the record. `RATE_LIMITED` shows the same plain wait as sign-in|
| `/recovery/complete`| Set a new credential from a link| `completeCredentialRecovery`| **None — token only**| **One `error` for a malformed, expired, reused or superseded link** (`RECOVERY_TOKEN_INVALID`), which must not say which and must not re-open the form. **`validation error` states the rule — at least 12 and at most 128 characters, spaces allowed, no other requirement** — and never echoes the value. `success` says every session has ended and the next step is sign-in|
| `/setup/credential`| Employee sets their **own** first password from a setup grant| `completeStaffCredentialSetup`| **None — grant only, pre-auth**| **No application shell.** A grant is not a session. **One `error` for an unknown, expired, consumed or superseded grant** (`SETUP_GRANT_INVALID`); it must not re-open the form. The same 12-to-128 rule as recovery|
| `/setup/mfa`| Privileged employee enrols TOTP and proves a code. **Also the re-enrolment entry after a reset**: an `MFA_REENROLMENT` grant is exchanged through `beginMfaReenrolment` for provisioning material and a continuation grant (R1)| `completeMfaEnrolment` · `beginMfaReenrolment`| **None — grant only, pre-auth**| **The QR/secret is displayed once.** `success` requires a **proven** code; **a wrong code leaves the factor `PENDING`** (`MFA_PROOF_INVALID`) and says so; a provisioned factor that was never proven is not MFA and must not be presented as done|
| `/setup/mfa/complete`| Confirmation and hand-off to normal sign-in| — *(no operation; it renders the result of the one before)*| **None — pre-auth**| Must state plainly that **the next step is ordinary sign-in**. No session is issued here|

**Signed in**

| Route| Purpose| Operations| Permission| States carrying a rule|
|---|---|---|---|---|
| `/`| **The signed-in landing for a build holding `SLICE-000` alone**: who is signed in, their hubs, and the entries their session may use. **Carries the sign-out control that every authenticated screen carries.** Later slices fill the landing; they do not replace it| `getCurrentSession` · `signOut`| any signed-in staff session| **`empty`** — *nothing is waiting* is a success message, never a blank. **Sign-out** calls `signOut`, clears the local view and **reads as done even if the session had already ended** (`SESSION_INVALID` on sign-out is not a failure). **Any `SESSION_INVALID` elsewhere returns here and then to `/sign-in`** with copy that does not say why|
| `/admin/staff`| Staff identities, with the **approver's queue** — identities in `PENDING_APPROVAL` — filtered and counted| `listStaffIdentities`| `staff.read`| **`empty`** distinguishes *none waiting* from *filtered to nothing*. **`forbidden` names the permission, never a role**. Ops Staff do not hold it and see no menu entry — hidden is not enforcement (§45.7)|
| `/admin/staff/new`| Create a staff identity — the maker's half of §30.8| `listAssignableStaffRoleBundles` · `createStaffIdentity`| `staff.identity.create` (the creation) · `permission.assignable_bundle.read` (the bundle read)| **The form has no password and no `mfa_enrolled` field**, and the schema would reject one. A hub outside the maker's hubs is `HUB_SCOPE_VIOLATION` and reads *you cannot place a profile in that hub*; a duplicate address is `WORK_EMAIL_IN_USE`. `success` says **a different person must approve it** — the maker cannot. **The bundle field is filled from `listAssignableStaffRoleBundles`** (`MSC-DEC-439`; its key is `permission.assignable_bundle.read`, `MSC-DEC-443`): the screen calls it on load and offers exactly the bundles it returns, **by name**, with a note on those that need a Platform Admin's approval, and **it carries no bundle list of its own**. The read returns no permission and no holder, so the screen shows none. Choosing a privileged bundle grants nothing — the record is created `PENDING_APPROVAL` all the same. An empty or failed read — including `PERMISSION_DENIED` for a user whose bundle lacks the read key — leaves the field empty, and the form cannot be submitted|
| `/admin/staff/{id}`| One identity: its status and version; **approve or reject** (the checker's half), **re-issue a lapsed setup grant**, **start exceptional recovery**| `getStaffIdentity` · `approveStaffIdentity` · `reissueStaffCredentialSetup` · `recoverStaffCredential`| `staff.read` · `staff.identity.approve` · `staff.credential.recover`| **`stale/conflict`** — every action sends the `ETag` the page read, and `STATE_CONFLICT` reloads and explains what changed. **Three different refusals, three different sentences:** `SELF_APPROVAL_FORBIDDEN` *a different approver is required*, `INSUFFICIENT_AUTHORITY` *this bundle needs a higher authority to approve*, `PERMISSION_DENIED` *you do not hold the permission*. **`CREDENTIAL_DELIVERY_FAILED` says nothing was changed and offers retry.** **A reason is mandatory** on rejection, re-issue and recovery. **The new credential and every link are never displayed** to the acting person. A record outside the actor's hubs and a record that does not exist are **two full-page states** (`HUB_SCOPE_VIOLATION`, `NOT_FOUND`)|
| `/admin/staff/{id}/mfa/reset`| Platform Admin resets another identity's MFA| `resetStaffMfa`| `staff.mfa.reset`| **Reason is mandatory.** The re-enrolment grant is **never displayed** to the acting admin — the screen has no field that could show it. `forbidden` names the permission|
| `/admin/vendors`| Vendor accounts: identifier, organisation, status, **whether a secret exists** and how many browsers are `ACTIVE`| `listVendorAccounts`| `vendor.read`| **Never a credential or a recovery address** — the screen has nowhere to show either. **Only the accounts within the signed-in actor's grant are listed**: a hub's staff see the accounts whose organisation's responsible hub is one of theirs, and a Platform Admin or Finance user sees every hub only where their grant reaches every hub. `empty` as above|
| `/admin/vendors/{id}`| One account and its version; **re-issue a lapsed setup grant**, **start exceptional recovery**| `getVendorAccount` · `reissueVendorCredentialSetup` · `recoverVendorCredential`| `vendor.read` · `vendor.organization.approve` · `vendor.credential.recover`| **`stale/conflict`** as above. **Recovery is Platform Admin's, at all hubs, and re-issue acts at the vendor's own hub**: each action names its own permission when refused, and a re-issue for an account outside the actor's own hub is `HUB_SCOPE_VIOLATION`, shown beside the action. **An account that already holds a secret offers recovery, not re-issue** (`STATE_CONFLICT` on re-issue is explained, not just shown). The same *never displayed* rule for the secret and every link. **An account outside the actor's hubs and one that does not exist are two full-page states** (`HUB_SCOPE_VIOLATION`, `NOT_FOUND`), as on the staff page|
| `/admin/riders`| The rider roster: name, phone, status, hub, **whether a PIN and an `ACTIVE` device exist**| `listRiders`| `dispatch.read`| **Never a PIN, a hash or a key.** Hub-scoped; `empty` as above|
| `/admin/riders/{id}`| One rider and the version the device actions take| `getRider`| `dispatch.read`| **`stale/conflict`.** The two device pages below are entered from here|
| `/admin/riders/{id}/device/register`| **First** device binding for a rider, in person. Displays the enrolment **QR** for the rider to scan| `registerRiderDevice`| `staff.device.register`| **The QR is the credential.** It must not be copyable as text, must not be screenshotted into a ticket, and the page must **clear it on navigation and on expiry**. A `expired` state offering *issue a new code* — never a stale code left on screen. **A rider who already has an `ACTIVE` device is `STATE_CONFLICT`, explained** and pointed at re-registration|
| `/admin/riders/{id}/device`| **Revoke** a lost or stolen device, and **re-register** a rider's device. Re-registration shows the **same QR handoff** as first registration| `revokeRiderDevice` · `reregisterRiderDevice`| `staff.device.revoke` · `staff.device.reregister`| **Two actions, two keys, and the page names the permission each needs** — never a role: Ops Staff hold the first and not the second. **Revoke needs a reason and no identity verification and carries no `If-Match`**; it ends the rider's live session. **Re-registration takes a reason and a mandatory note on how the rider's identity was verified in person**, and sends the `ETag` the roster read|
| `/admin/sessions`| A principal's live sessions, and ending one| `listSessions` · `revokeSession`| `staff.read` · `staff.session.revoke`| **Reason is mandatory.** **A Senior Ops user reads and ends rider sessions only**; naming a staff or vendor principal is `INSUFFICIENT_AUTHORITY`, which the page says plainly. **`stale`** — a session may end while being viewed; ending an already-ended session reads as already done, not as a failure.|

**The sessions page was gated by `permission.read` and viewed sessions with no list operation.** `permission.read` is who-holds-what and belongs to a different page; `revokeSession` needs `staff.session.revoke` and the read that feeds the page is `listSessions`.

**Thirty-two routes so far** — 13 for `SLICE-001` and 19 for `SLICE-000`. **A running subtotal, not a total**: the dispatch routes follow, and the phrase *"in total"* here is what let the figure below drift unnoticed.

**Gate A added four, and three of them are pre-authentication** — which is the point of them. Before Gate A the product had **no screen on which an employee could establish their own first credential**, so onboarding ended at an administrator typing someone else's password.

**Three rules here would be broken by an ordinary, well-intentioned implementation.**

**`/sign-in/mfa` must look like a sign-in page, not the application.** The natural build renders the app shell once the password is accepted and overlays a code prompt. That shell implies a session exists. It does not — `MSC-DEC-228` withholds the session entirely until the factor lands, and a shell that suggests otherwise trains users to expect access they have not yet earned.

**`/recovery` has no *account not found* state, and `/sign-in` has no *locked* state.** Every framework offers both and each is exactly the disclosure §37.7 forbids: it confirms which addresses belong to real staff, and Melarc staff emails follow a predictable pattern. The lock is announced at the second factor, where the person has already proved the password.

**No page that acts on another principal's credential may have a field capable of displaying one.** Not masked, not reveal-on-click. Recovery and re-issue re-establish a path for someone to set their own credential; a screen that could show one turns an administrator into a person who knows a colleague's password. This is the rule `/admin/recovery` carried, and it now binds `/admin/staff/{id}` and `/admin/vendors/{id}`.

**`/setup/*` must not render the authenticated shell either, and for a sharper reason than `/sign-in/mfa`.** These pages are reached by a **grant**, and a grant authorises exactly one act on one principal. A shell around it invites the natural next build — treating the grant as a session and letting the user navigate — which would be an unaudited authentication path around every control above it.

**`/admin/staff/{id}/mfa/reset` must never show the re-enrolment grant.** The acting Platform Admin resets the factor; **the target completes the enrolment.** A screen that displayed the grant would let one administrator enrol a factor on another person's account, which is exactly the concentration of authority the Platform-Admin-only rule exists to bound.

**The bundle-change screens are not here.** `proposeBundleChange` and `approveBundleChange` belong to `SLICE-009`; they were named in the `SLICE-000` script and in one of its criteria without being part of the slice, and `/admin/staff/{id}` will gain them when that slice builds them.

### Dispatch routes — `SLICE-002`

Six rows, **four live** — two were superseded at C1.9 by the pre-dispatch queue below, which is where the `PRE_DISPATCH` call is worked and where the assigned Rider's own calls appear on the same record. **All are Ops-side; the rider sees nothing of the run here until dispatch.**

| Route| Purpose| Permission| States carrying a rule|
|---|---|---|---|
| ~~`/confirmation-queue`~~|| —| —|
| ~~`/confirmation-queue/{orderId}`~~|| —| —|
| `/escalations`| **Orders Ops has escalated as contact-exhausted** — the avenues are used up, not a number. Entered through `escalateRecipientConfirmation`, reason mandatory, **Ops judgement only** — a rider holding the shared key is refused| `dispatch.recipient_confirmation.work`| **Exactly two exits**, both requiring a reason: **return the order to the working queue** by recording a new attempt on a new avenue, or start the Return. A screen offering only one is a queue with a leak.|
| `/ready-pool`| Confirmed, payment-cleared orders| `dispatch.read`| **Never vendor-filtered.** Eligibility shown here is re-checked on add — the pool is a view, not a promise|
| `/delivery-runs/new`| Build a run from the pool| `dispatch.run.create`| **`stale`** when an order is taken by another officer mid-build. Must not silently drop it from the selection|
| `/delivery-runs/{id}`| Stops, sequence, rider, dispatch| `dispatch.read` · `.sequence` · `.assign` · `.dispatch`| **Three separate actions, never one button.** And see the rollback rule below|

**Thirty live routes across the first three slices** — **14** `SLICE-001`, **12** `SLICE-000`, **4** `SLICE-002` — **a running subtotal, not a total.** The sections below add **23** — Receive Money 3, redelivery 2, doorstep counterparts 6, the pre-dispatch and recipient-contact queues 7, and parcel custody return 5 — and **`MSC-DEC-417` adds seven outbound-handoff routes for `SLICE-005`**, so **the Ops Portal carries 60 live routes in all**, with two `SLICE-002` rows superseded.

**Two rules here that an ordinary implementation will break.**

**`/delivery-runs/{id}` must show a rollback as a rollback.** §24.5 dispatch is atomic: one order's failed revalidation rolls back all twenty stops and the run stays `DRAFT`. The natural rendering is a generic error toast — which leaves Ops staring at a `DRAFT` run unable to tell whether the dispatch was attempted and refused, or never submitted. **The screen must name the failing order and the failing check**, because `dispatch.run.rollback` records exactly that and the screen is where it is acted on.

**`/pre-dispatch-confirmation/{orderId}` must not rank the four outcomes.** A form that puts `confirmed` first and styles it as success trains Ops to treat the other three as failures to avoid. `reschedule`, `address_correction` and `unreachable` are **routine outcomes of a routine call** — and one of them, address correction, is how a wrong delivery gets prevented.

**Only `unreachable` takes a reason, and the picker offers four** (`MSC-DEC-409`, 25 September 2026): `NO_ANSWER`, `NUMBER_INCORRECT`, `RECIPIENT_DECLINED` and `CONTACT_NOT_POSSIBLE_MELARC`. **`RECIPIENT_NOT_AT_LOCATION` is not offered here** — it is `DOORSTEP`-only and the server refuses it with `REASON_NOT_VALID_FOR_CHECKPOINT`, so a screen that listed it would make a refusal discoverable only on submit. **`reschedule` and `address_correction` must not ask for a reason**: the person was reached, and the record they produce is a commitment revision or a location-change request. **`RECIPIENT_DECLINED` routes to the Ops decision queue and requires a note**; `NUMBER_INCORRECT` and `RECIPIENT_DECLINED` notify the Vendor and `CONTACT_NOT_POSSIBLE_MELARC` does not, because that failure is Melarc's own.

### Receive Money — the same engine, `SLICE-003`

`MSC-DEC-352`. **Ops uses the operation the rider uses.** What differs is scope, not code.

| Route| Purpose| Permission| States carrying a rule|
|---|---|---|---|
| `/payment-collections/new`| Select an eligible **operational obligation within hub scope** — delivery fee, redelivery delivery fee, redelivery fee, single-package pickup fee — then payer, amount **read-only**, number, **Receive Money**| `listOperationalPaymentDemands` · `payment.collection.read`, then `payment.momo.collect`| **No arbitrary-amount box exists**. Gate C collects modelled operational obligations; general receipts and account allocation are **Accounting & Reporting's**, not a free-text field here|
| `/payment-collections/{id}`| Requesting · pending · **checking, do not request again** · succeeded · failed · expired, with the demand's **total due, confirmed receipts, allocated, remaining due and excess**| `payment.collection.read`| **The same state vocabulary the rider sees, on the same key**, because it is the same record on the same engine.|
| `/payment-demands/{id}/fallback-authorization`| **Authorise a fallback while a provider attempt is unresolved** — the attempt, a mandatory reason, the chosen method, an explicit duplicate-risk acknowledgement| `payment.momo.confirm_manual`| **Returns the grant, because a grant nothing can spend is not a grant**. **Single use**, method-bound, demand-bound. **A Rider may request and never authorise**|

**Hub scope is the whole difference.** An officer at Hub B cannot collect against Hub A's obligation, and **no Ops screen can declare a payment succeeded** — provider truth is applied by the trusted service identity, and no human key exists for it.

**A partially funded demand is shown as partially funded, never as a failure**. GH₵50 confirmed against GH₵55 is money received: **no fee line is settled**, the screen shows **GH₵5 remaining**, and the next collection requests that figure. **Handover is released by the demand reaching `SETTLED`** — not by an attempt succeeding, and not by a receipt existing.

### Redelivery scheduling — `SLICE-003`

| Route| Purpose| Permission| States carrying a rule|
|---|---|---|---|
| `/orders/{id}/redeliveries`| **Schedule a redelivery** after a qualifying failed physical attempt| `dispatch.run.create`| **This screen creates the charge**. It shows the **applicable delivery fee**, the **hub redelivery fee**, the **total**, and **whether the trip is chargeable at all** — a Melarc-caused failure bills nobody, and an officer must see that before committing. **Payer is recipient and is not editable**|
| `/orders/{id}/redeliveries` *(history)*| Prior trips and their outcomes| `delivery.read`| **Trip number, not attempt number.** No maximum exists|

**Terminology across these queues** *(Gate C C1.3)*: **checkpoint**, **contact outcome**, **physical delivery trip**, **redelivery number**. **`Attempt 1 / 2 / 3` appears nowhere** — it meant all four at once, and an officer deciding whether to send a rider out again needs them separated.

### Doorstep counterpart routes — `SLICE-003`

**Every real-time Ops intervention the Rider doorstep flow depends on.** Gate C R1.2 verified these against [rider-android.md](rider-android.md) §5: **a rider-side request with no Ops-side screen is a rider waiting for nobody.**

| Route| Purpose| Permission| States carrying a rule|
|---|---|---|---|
| `/delivery-stops/{id}/verification-fallback`| **Approve or deny** an OTP fallback a rider requested| `delivery.otp.override`| **A rider is waiting at a door.** The queue is time-critical, and a **denial is an answer** that must reach the rider as promptly as an approval|
| `/orders/{id}/manual-payment-confirmation`| Independently confirm a Merchant MoMo payment| `payment.momo.confirm_manual`| **A screenshot is not proof**. The screen must require the independent check, not merely record an assertion|
| `/delivery-stops/{id}/failure-review`| Review a failed stop, decide reattempt or Return| `dispatch.read` · `delivery.read`, then `dispatch.run.create` to schedule a redelivery|  **Return is committed here and nowhere else**. Never triggered by an attempt counter|
| `/cash-handovers/{id}`| **Receive a rider's handover**: record the physical count, accept the cash| `payment.cash.confirm`| **Accepting the count transfers custody** — `CONFIRMED` and `VARIANCE_OPEN` alike. The declared total **is visible**|
| `/cash-handovers/{id}/resolve`| Review and resolve a rider variance| `payment.variance.resolve`| **Never the rider.** And a reason is mandatory — the variance is measured against the **system** figure|
| `/road-expenses/{id}/decision`| Approve or reject a road expense| `payment.road_expense.approve`| **Approval is not application.** The screen must not imply money moved; application happens at handover opening|

**Six routes, and five of them exist because the rider cannot act alone.** That is the design: the doorstep surface requests, and the command centre decides.

### Pre-dispatch and recipient-contact queues — `SLICE-002` and `SLICE-003`

`MSC-DEC-346`, `MSC-DEC-347`, `MSC-DEC-348`. **Ops is a first-class actor at checkpoint one, not an escalation path.** **This is the `PRE_DISPATCH` queue [recipient-confirmation.md](../features/dispatch/recipient-confirmation.md) describes** — `SLICE-002`'s first feature — and the `SLICE-002` rows above that named it `/confirmation-queue` are superseded by these two. The exception queue and the decisions beneath it serve all three checkpoints and so both slices.

| Route| Purpose| Permission| States carrying a rule|
|---|---|---|---|
| `/pre-dispatch-confirmation`| **The confirmation queue worked before every run departs.** Recipient name · order reference · contact · draft run and rider · confirmation state · last outcome · Vendor notification state · available action| `dispatch.recipient_confirmation.work`| **`empty` is the goal state.** A queue worked to empty is a run that can depart. **The same canonical record the rider writes** — Ops confirming here means the rider does not call again|
| `/pre-dispatch-confirmation/{orderId}`| Call · record confirmed · record a failure reason · request Vendor assistance · apply a corrected contact · open reschedule · open location change · retry · **clear for dispatch**| `dispatch.recipient_confirmation.work`| **Clearing is a separate act from assigning**. A held parcel must be visibly held, never merely absent from a list|
| `/recipient-contact-exceptions`| **One queue across all three checkpoints**: wrong number · no answer · reschedule requested · location change requested · next-stop skipped · **doorstep waiting** · doorstep failed · Vendor response received · Ops action required| `dispatch.recipient_confirmation.work`| Shows recipient name · order · checkpoint · problem · **current parcel custody** · run and rider · action owner · Vendor notification state · **live countdown where a doorstep wait is running**|
| `/recipient-contact-exceptions/{id}/vendor-response`| Capture a Vendor's corrected number or clarification, **from the PWA or from WhatsApp**| `dispatch.recipient_confirmation.work`| **The channel does not decide authority**. A WhatsApp reply captured here is worth exactly what a PWA submission is worth: an input Ops applies|
| `/orders/{id}/delivery-location-change`| Decide a location change — serviceability, hub ownership, corridor and service day, pricing, route feasibility| `dispatch.recipient_confirmation.work`| **The original destination is preserved.** A screen that overwrites it loses what the order was sold against|
| `/orders/{id}/delivery-commitment`| Revise a committed date on a recipient's request| `delivery.commitment.revise`| **Attribution `CUSTOMER`** — a customer-requested deferment is **not a Melarc SLA miss**|
| `/delivery-runs/{id}/next-stop-recovery`| Reinsert a skipped stop, or leave it for controlled later handling| `dispatch.run.sequence`| Ops weighs rider position, remaining route, service window and feasibility. **The rider does not reorder their own run**|

**The doorstep countdown is visible to Ops, live.** A rider standing at a door for ten minutes is the moment Ops assistance is worth most, and a queue that only shows the failure afterwards has missed it.

### Parcel custody return — `SLICE-003`

*Added 24 September 2026 at `OQ-129` R1. `MSC-DEC-408` gave Hub Ops and Senior Ops two operations
and **no route to reach them**.*

**The counterpart of the cash-handover routes**, and deliberately built the same way: the rider
declares, **this surface confirms**, and a mismatch becomes a variance a senior officer dispositions.

| Route| Purpose| Gated by| Operation| States carrying a rule|
|---|---|---|---|---|
| Parcel returns queue| The hub's returns, **filterable to `DECLARED`**| `fleet.custody.read`| `listParcelCustodyReturns?state=DECLARED`| **`DECLARED` is the unconfirmed set and it ages.** §36.9 allows no rider overnight hold, so a `DECLARED` return from a previous business date is an exception, not a backlog item|
| Return detail| **Every line on the record** — what the rider declared **and what the hub found that the rider did not name**| `fleet.custody.read`| `getParcelCustodyReturn`| **`empty` is impossible** — a return names at least one order. **The declaration is not the whole record**: an `UNDECLARED` line appears only after confirmation, and a screen built around the rider's list would hide the parcels nobody expected|
| Confirm receipt| **Record what the hub physically has**, and transfer custody| `fleet.custody.receive`| `confirmParcelCustodyReturn`| **The received set is entered, not accepted.** A one-tap *confirm all* would make the count the rider's, which is the failure this split exists to prevent. **A rider may not reach this route**|
| Confirm with a mismatch| Record a `MISSING` or `UNDECLARED` line with a mandatory reason| `fleet.custody.receive`| `confirmParcelCustodyReturn`| **Custody still transfers for the lines received.** The screen must not present a variance as a refusal of the whole return|
| Resolve a variance| **Disposition each open line**| `fleet.custody.variance_resolve`| `resolveParcelCustodyVariance`| **Senior floor.** Each line takes `RECEIVED_LATE`, `CONFIRMED_NOT_RECEIVED` or `DECLARATION_CORRECTED` with a reason — **a reason alone is not a disposition**|

**`CONFIRMED_NOT_RECEIVED` is the one to design carefully.** It records that custody did not reach
the hub and **opens no claim**: the damage, loss and claims apparatus is `OQ-004`'s, and a screen
that implies a claim has started would promise a workflow that does not exist.

### Outbound handoff routes — `SLICE-005`

*Added 26 September 2026 at `MSC-DEC-417`, which made the outbound path executable end to end. These
are the Ops half of it — the rider's is family **N** at [rider-android.md](rider-android.md) §5. The
[carrier-handoff](../features/delivery/carrier-handoff.md) feature owns the behaviour.*

**Clearance and the covered-mode outcome are the two acts Ops performs on a live outbound order; the
two registers are administration.**

| Route| Purpose| Gated by| Operation| States carrying a rule|
|---|---|---|---|---|
| `/outbound-clearance`| Third-party-lane orders awaiting clearance, and the act that clears one for dispatch or **re-dispatches** a returned one| `dispatch.outbound.clear`| `clearOutboundForDispatch`| **Refuses until the outbound charge is backend-confirmed paid** — `unpaid` is not an error to hide but the reason the button is disabled. A re-dispatch after a failed counter or a covered `RETURNED` raises **no new charge**|
| `/carrier-handoffs`| The covered-mode outcome worklist — every parcel still in a third party's hands| `delivery.read`| `listCarrierHandoffs`| **`empty` is the goal**, not a failure: it means nothing is outstanding. Filter to `HANDED_OVER`, `IN_TRANSIT` and `FAILED` — the states Melarc is still responsible for (§24.7.2)|
| `/carrier-handoffs/{id}/outcome`| Record `IN_TRANSIT`, `DELIVERED`, `FAILED` or `RETURNED`| `delivery.handoff.outcome`| `recordHandoffOutcome`| **A Station Drop reaches none of these** — the screen must not offer an outcome on one (`TERMINAL_FOR_STATION_DROP`). `DELIVERED` earns the covered charge; `FAILED` requires a reason; `RETURNED` brings the parcel back to `AT_HUB_AFTER_FAILURE`|
| `/admin/couriers`| The platform-wide courier/station register, and registering a new entry| `courier.read` · `courier.registry.manage`| `listCourierProviders` · `registerCourierProvider`| **Platform-wide, not hub-scoped** — the register carries no hub. **Senior Ops and Platform Admin only**; an Ops Staff member sees the list and cannot register|
| `/admin/couriers/{id}`| Deactivate or reactivate an entry, with a mandatory reason| `courier.registry.manage`| `deactivateCourierProvider` · `reactivateCourierProvider`| **Deactivation never deletes** — past handoffs keep the entry, and a new registered handoff naming an `INACTIVE` one is refused. The reason is mandatory both directions|
| `/admin/agents`| The acting hub's approved-agent register, and approving one — a name, a phone and **an ID-document photo**| `courier.read` · `courier.agent.approve`| `listApprovedAgents` · `approveAgent`| **Hub-scoped**, and **the ID photo is required before the agent can take custody**. Approval may be done in advance or on the spot while the rider waits. **The register is never exposed to a rider**|
| `/admin/agents/{id}/withdraw`| Withdraw an agent's approval, with a mandatory reason| `courier.agent.approve`| `withdrawAgentApproval`| **Withdrawal never deletes** — past handoffs keep their agent, and a new handoff resolving to a withdrawn one is refused|

**`/carrier-handoffs/{id}/outcome` must not offer an outcome on a Station Drop.** The handoff is
terminal for that mode; the worklist above already excludes it, and the detail screen
must too, or an operator meets `TERMINAL_FOR_STATION_DROP` only on submit.

**Seven routes for `SLICE-005`**, all Ops or senior-Ops, none rider-facing. The rider never clears an
order, records an outcome, or reads either register — a rider names an agent by phone at the counter
and the server resolves it.

## 8. The nine interface states

| State| Requirement here|
|---|---|
| `loading`| Queue counts may load progressively; a count must never render as `0` while still loading|
| `empty`| An empty queue is a **success** message, not an error — "no intakes awaiting receive"|
| `validation error`| Field-level, with recovery guidance (§17.4)|
| `error`| Maps the machine code to copy. **Never shows the diagnostic `message`**|
| `retry`| §41.1. A failed queue load or rejected write offers an explicit retry, distinct from the error itself|
| `offline`| **N/A** — desktop web, no offline mode. Connection loss surfaces as an error, not a queue|
| `stale / conflict`| Substantive here. `STATE_CONFLICT` on a concurrent action must explain what changed, not just refuse. See §6|
| `success`| Confirms the state reached, not merely that the request succeeded|
| `permission-restricted`| Degrades to a clear refusal. §45.7: hidden buttons are not enforcement|

## 9. Concurrency is a first-class interface concern

§17.4 requires **concurrency indication for sensitive work such as receiving**, and §22.8 approves an advisory soft lock showing the active receiver with takeover after an idle TTL.

**The lock is advisory and the interface must not imply otherwise.** §22.8: a visual lock alone is not sufficient. Two receivers may still submit; exactly one wins and the other gets `STATE_CONFLICT`. The screen must make that outcome comprehensible — showing who took the intake and what to do — rather than presenting a bare failure.

## 10. What this surface must never do

- **Never expose the rider-declared count before the blind count commits** (§17.3, §22.3). The awaiting-receive queue is the specific screen at risk, and the contract enforces it structurally: `HubIntakePreCount` has no such property.
- **Never leak another vendor's or an unauthorised hub's data through search** (§17.4). Search is the most common leak path because it crosses record boundaries by design.
- **Never offer bulk actions where the operation is not safe and atomic** (§17.4).
- **Never show an action a user cannot perform without explaining why**, and never rely on hiding it for control.
- **Never present a temporary hub assignment as company-wide access.**
- **Never call the API on a separate origin**. This surface is served from **`ops.<melarc-domain>`** and its browser requests go to a same-origin **`/api/...`** path. Cross-origin, the `SameSite=Lax` session cookie is not attached at all — and **the change that presents itself as the fix is a parent-domain cookie**, which would let this surface's session authenticate the Vendor PWA and back. **Cookies stay host-only.** Topology at [DEPLOYMENT_AND_ENVIRONMENTS.md](../architecture/DEPLOYMENT_AND_ENVIRONMENTS.md) §12.1.
- **Never allow itemization before receiving and reconciliation conditions are met** (§17.3).

## 11. Responsive, device baseline and accessibility

Desktop-first. Dense operational tables may optimise for desktop, but every workflow stays usable at narrower widths (§10.3, §41.2). §41.2 adds that authorised hub and all-hub dashboard and report views are role-driven.

**§40.5 client baseline, to be defined and tested:** supported desktop browsers and the narrower responsive layouts. Accessibility conformance is `OQ-030` and §40.6. **Interim baseline for the `SLICE-000` screens — accepted by the Product Owner for Version 1, the Frontend Engineer confirming it by approving this document; narrower than §40.5 asks, and it closes neither question:** the current and previous major release of Chrome, Edge, Firefox and Safari on desktop; layouts verified at **1280 px** and **768 px**, with narrower widths usable and not optimised. **Accessibility, for every `SLICE-000` screen:** keyboard-operable with a visible focus; every input has a programmatic label and its error is associated with it; status and error messages are announced to assistive technology; nothing is conveyed by colour alone. **WCAG 2.1 level AA is the working target; it is not a conformance claim.** The bootstrap browser smoke test runs Chromium only: acceptance on the other browsers named here is future work, and that test makes no claim about it.

**§41.1 requires every user action mapped to an OpenAPI operation and an acceptance criterion.** **The operation half is done for the `SLICE-000` routes** — each names its operations in §7 — and **not for the others**; the acceptance-criterion half is part of what `OQ-030` owes.

## 12. Open questions

| ID| Effect here| Type|
|---|---|---|
| `OQ-030`| The complete page, route and navigation inventory. §17.6 lists it as a known gap| `ARTIFACT_REQUIRED`|
| `OQ-037`| Customer-facing and operator-facing copy| `ARTIFACT_REQUIRED`|
| `OQ-044`| The company-wide role catalogue behind §17.5's visibility model| `DECISION_NEEDED`|
| `OQ-049`| Dashboard KPI definitions and report layouts. The **families** are confirmed; the definitions are not| `ARTIFACT_REQUIRED`|

§17.6's other known gaps — authentication and session design, finance and settlement workspaces, vendor/rider/staff/courier administration detail, complete delivery and returns operations — are Phase 4 scope rather than blockers on the proving slice.

## 13. What this surface still owes its slices

*A surface carries no readiness verdict (`MSC-DEC-423`, extending `MSC-DEC-239`): the slice's Definition of Ready, area D, judges whether this surface is specified well enough for that slice. This section lists what is still owed.*

| Owed| Blocks which DoR area| Owner|
|---|---|---|
| The page-level inventory for the remaining later slices — it is written for `SLICE-000` to `SLICE-003` and now `SLICE-005`, **sixty-seven live routes**, and §44.3 will require the rest| D (frontend)| `OQ-030`|
| The operation-to-screen map §41.1 requires — **the nineteen `SLICE-000` routes name every operation they call** (Gate PD-3R1); the other slices' routes name some, which is not a map derived from the permission catalogue and the contract| D| `OQ-074`|
| The supported desktop browsers and responsive layouts §40.5 requires| D| `OQ-073`|

The model, the visibility rules, the state obligations and the never-do list are complete and citable.

## 14. Related

- **Up:** [overview.md](overview.md)
- **Down:** the six proving-slice features listed at §4
- **Authority:** [contracts/permissions.md](../contracts/permissions.md) §7–§8 for every bundle and gate named here
