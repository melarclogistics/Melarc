# Itemization and Pricing

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.11 (Run D revision: itemizing from the door photos, D-D6)
> **Date:** 4 October 2026; revised 16 November 2026
> **Domain:** `hub`
> **Owns:** the behaviour and acceptance criteria for converting received parcels into priced Orders, and for closing the intake
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §23, §35.6, §22.7, §36.11
> **Slice:** `SLICE-001`

## 1. What this is, and why

Itemization converts each **physically received parcel** into an operational `Order` carrying recipient, routing, handling, payer and commercial attributes (§23.1). It is where **price first becomes authoritative** — for a standard booking, the parcel's first price ever.

One physical parcel becomes one `Order` (§23.1, `MSC-DEC-187`).

**The order is made for a parcel, and the parcel's photo is the order's photo (D-D2, D-D6, the Product Owner's decisions of 15 and 16 November 2026).** Receiving checks a run in parcel by parcel against the rider's door photos ([hub-intake.md](hub-intake.md)), so each physical parcel has a record before it has an order: the **intake's parcel** ([domain-model.md §6.6a](../../contracts/domain-model.md#66a-intakeparcel)), one for each door photo and one for each extra recorded at the hub. An order refers to its parcel, **one order for a parcel and one parcel for an order, by the database**, and its photo is the parcel's. **Officers may therefore itemize from the photos while the parcels are still being checked in, which is how the hub works on a busy day**: an order made for a parcel that has not been checked in yet is *awaiting arrival*, and checking the parcel in confirms it ([§5.4](#54-early-itemizing-from-the-door-photos-d-d6)). This is **specified here and built by Stage 7** (S1.36 to S1.40); Run D builds no itemizing screen.

**Version 1 boundary.** Itemization prices and allocates. It does not dispatch, does not confirm the recipient, and does not collect. It ends when the intake closes with every received parcel accounted for.

## 2. Governing sections

| Section| What it governs here|
|---|---|
| §23.1–23.2| Purpose and the eleven required capture items|
| §23.3| Address and zone resolution — now **serviceability and service area**, not a matrix lookup — and origin-zone snapshotting|
| §23.4| Size classes, high-value flagging, evidence, serialized goods|
| §23.5| Payer allocation and the freeze boundary|
| §23.6| Booking estimate versus authoritative freeze|
| §23.8| Lane classification|
| §23.10| Intake closure and parity|
| §23.11| Corridor pricing — **batch day or off-day fee**; intra-corridor withdrawn|
| §22.7| The hub count as close authority|
| §36.11| The commercial gate|


## 3. Surfaces and actors

| Surface| Actor| Can do| Gated by|
|---|---|---|---|
| Melarc Ops| Ops Staff| Itemize a parcel into an Order; capture all §23.2 attributes; manually flag high value; close the intake| `hub.intake.itemize`, `hub.intake.close`|
| Melarc Ops| Ops Staff| **Select the size class** and, in third-party mode, **transcribe the carrier cost**| `hub.intake.itemize`|
| Melarc Ops| Ops Staff| Request a price correction or a service-area repricing| `pricing.correction.create`, `pricing.reprice.request`|
| Melarc Ops| Senior Ops| Approve a price correction or repricing; close without parity by the approved exception| `pricing.correction.approve`, `hub.intake.close_exception`|
| Melarc Vendor| Vendor account| **Receives the order summary on closure.** May edit payer arrangement **until freeze** (§23.5)| —|
| Melarc Rider| Rider| **N/A**| —|

## 4. Preconditions

- The intake is `READY_FOR_ITEMIZATION` — the check-in is finished (or the blind count committed) and reconciliation has passed. **Early itemizing is the one exception (D-D6, [§5.4](#54-early-itemizing-from-the-door-photos-d-d6)):** for a photo-mode intake an order may be made for a parcel that has not been checked in yet, and it waits for its parcel.
- The responsible hub has an **active zone catalogue** and an approved **service-area base fee**. Where the parcel is outside-Accra, the hub's `outside_accra_margin` must also be set — §33.4 forbids borrowing another hub's value, and pricing at cost would ship the order at zero margin silently. **Set at GH₵30 for Accra**; a new hub starts with none.

---

## 5. Behaviour

### 5.1 Normal path

1. **Ops itemizes a parcel into an Order** (the parcel is the intake's parcel the order is made for, with its photo beside the form), capturing §23.2 in full: recipient name and phone; delivery address, GhanaPost GPS and resolved zone; size class; declared value, high-value flag and required evidence; electronics flag with serial or IMEI; payer arrangement; service level and requested date; lane; and source linkage.
2. **The server resolves the destination zone.** §23.3: a free-text address is never authoritative, resolution is server-validated, and pricing is **blocked** until both origin and destination resolve to an active zone or corridor belonging to the responsible hub.
3. **Ops selects the size class** — `SMALL`, `MEDIUM` or `LARGE`. This is a **judgement, not a calculation**: `MSC-DEC-209` establishes no weight or dimension thresholds, so no server rule can derive it. The selecting officer is recorded on the order and emitted as an enhanced audit event.
4. **Where the parcel goes outside the service area**, Ops transcribes the third-party carrier's actual charge from their waybill into `carrier_cost`. This is the **only monetary figure a client submits** — an observation with a receipt behind it, not a price.
5. **The system calculates the authoritative fee** from the hub's own schedule:

| Destination| Fee|
|---|---|
| In service area, doorstep| `service_area_base_fee` — **flat, regardless of size**|
| Corridor, on its batch day| `service_area_base_fee`|
| Corridor, any other day| `corridor_off_day_fee`|
| Station drop| `station_drop_fee` — **flat, regardless of size**|
| Outside the service area| `carrier_cost` + `outside_accra_margin` + **size-class surcharge**|

   **The size surcharge applies to the last row only.** This inverts §35.6.9, which exempted third-party and charged everything else.
6. **Payer allocation resolves** into vendor/sender and recipient portions (§23.5).
7. **The commercial gate has three outcomes, not two**. Test the **resolved vendor portion** first: if `payer_allocation.sender_minor` is zero the order enters **`NO_VENDOR_CHARGE`** and the gate is satisfied — no reservation, no payment, and **the account's overdue status is not consulted**, because there is no vendor amount to gate. Only a non-zero portion reaches the credit conditions.
8. **The price freezes at itemized-order confirmation** and the commercial gate runs: credit reservation where allowance permits, otherwise `PAYMENT_REQUIRED` (§36.11, `MSC-DEC-176`). **HIGH-10 audit remediation (13 September 2026):** the reservation this step creates is guarded twice against exactly the retry this feature's own §22.8 concurrency rule warns about — *"backend transition and idempotency controls are still required; a visual lock alone is not sufficient."* `itemizeOrder` requires both `Idempotency-Key` and `If-Match`, added because a receiving officer retrying over a flaky hub connection would otherwise have produced two priced `Order`s, and a duplicate credit reservation, for one physical parcel ([openapi.yaml](../../contracts/openapi.yaml)). Underneath that, `Order.commercial_state`'s own machine reserves exposure **exactly once, keyed by a uniqueness constraint on the order** — not by retry semantics — and releases it through a defined `→ REVERSED` transition on formal Return initiation ([state-machines.md](../../contracts/state-machines.md) §8). **What is not yet settled is narrower than "idempotency or rollback"**: the ledger mechanics behind *adjusting* a reservation when a correction changes the amount owed — `OQ-005`, §14 below.
9. **The intake closes** when every hub-received parcel is accounted for. Closure emits `intake.completed` and generates the vendor-facing order summary (§23.10).

**The order's photo (D-A10, 12 November 2026; restated on parcels by D-D2 and D-D6, 16 November 2026; Stage 7, `OB-S1-82`).** The photo of an order is **the photo of its parcel**: the rider's door photo ([pickup-collection.md §5.5](../pickup/pickup-collection.md#55-the-photo-of-every-parcel)) for a parcel that has one, the photo taken at the hub for an extra. The officer no longer chooses a photo from a pool: **the order is made for a parcel, and the parcels no order has taken are shown as unmatched** until each has an order or is accounted for (missing, or accepted by the senior officer). The order holds **a reference to the parcel**, and through it to the evidence; the evidence's owner stays the pickup stop (or the intake, for an extra) and is never re-pointed (domain-model.md §3.6), and the database allows one order for a parcel and one parcel for an order, for every writer. **The photo follows the order**: the order list, the order page and the delivery rider's stop show it (`OB-S1-85`). *The Stage 6 rule that kept the photos out of the receiving side before the count is reversed by D-D1 ([hub-intake.md §5.3](hub-intake.md#53-what-this-feature-must-never-do)); the photos are in front of the officer from the handover on.*

### 5.2 Exception paths

| Path| Behaviour| Error code|
|---|---|---|
| Zone unresolvable or out of coverage| **Pricing blocked.** §23.3: out-of-coverage addresses cannot be priced under the normal flow| `SETTING_MISSING`, `VALIDATION_FAILED`|
| Ambiguous zone resolution| Requires a clear authorized selection (§23.3)| `VALIDATION_FAILED`|
| Hub has no approved base fee| Fails visibly. §33.4 forbids borrowing another hub's rates or a global default| `SETTING_MISSING`|
| Outside-Accra parcel, hub margin unset| **Refused, not priced at cost.** Shipping at zero margin silently is worse than declining. **Still reachable with Accra set** — §33.4 forbids inheritance, so this is the path a second hub takes on day one| `MARGIN_NOT_CONFIGURED`|
| Size class not selected| Pricing refused. There is no default and no derivation| `SIZE_CLASS_REQUIRED`|
| Third-party mode, no carrier cost captured| Pricing refused| `CARRIER_COST_REQUIRED`|
| Declared value above `value_declaration_threshold`, undeclared at booking| Refused| `VALUE_DECLARATION_REQUIRED`|
| Corridor destination off its batch day| Priced at `corridor_off_day_fee`, **not refused** — the off-day trip is a real service at a premium. Intra-corridor pricing no longer exists| —|
| Serialized electronics without serial or IMEI| Refused (§23.2, §23.4)| `VALIDATION_FAILED`|
| High value without evidence| Refused. §23.4 requires verified itemization-time evidence| `REASON_REQUIRED`|
| Declared value crosses the first tier| **Auto-flags** high value; Ops may also flag a lower-value parcel manually (§23.4)| —|
| Merchandise COD attempted| Refused. Melarc does not collect vendor product value (§23.2)| `VALIDATION_FAILED`|
| Payer edit after freeze| Ops submits a correction, **Senior Ops approves** with complete before/after history (§23.5)| `SELF_APPROVAL_FORBIDDEN`|
| Post-freeze address correction **changing service area or commercial mode**| Controlled repricing — Ops requests, Senior Ops approves, **with affected-party notification** (§23.6). A correction *within* a service area moves no money and must **not** trigger this workflow| `NO_PRICING_CHANGE`, `NOTIFICATION_FAILED`|
| **`PAYMENT_REQUIRED` order at closure**| **Counts toward parity.** §23.10: it blocks dispatch readiness, it does not justify leaving the intake unclosed| —|
| Closure without parity| Only by the approved exception, with a substantive reason and appropriate authority (§23.10)| `PARITY_NOT_MET`, `INSUFFICIENT_AUTHORITY`|
| Unpriced order at closure| Refused| `ORDER_UNPRICED`|
| **More orders than parcels received** (a blind count; the review of 21 November 2026)| Refused when the order is made, for every writer, and refused at the close **with the exception or without it**: the exception is for parcels that are missing an order, never for orders that have no parcel. A photo intake cannot have the surplus (one order for a parcel)| `STATE_CONFLICT`, rule `orders_exceed_received`|
| **An order for a parcel that is void or already has an order** (D-D6)| Refused: one order for a parcel, held by the database; a `VOID` extra has none. *Provisional: Stage 7 names the rules of the refusal*| `STATE_CONFLICT`|
| **An awaiting-arrival order frozen, cleared or dispatched before its parcel is checked in** (D-D6)| Refused until the parcel arrives ([§5.4](#54-early-itemizing-from-the-door-photos-d-d6))| `STATE_CONFLICT`|

### 5.3 What this feature must never do

- **Never count only dispatch-ready orders toward parity.** §23.10 is explicit that a `PAYMENT_REQUIRED` parcel still counts. Counting cleared orders will refuse to close intakes that are entirely correct, and the failure will look like a data problem rather than a logic one.
- **Never price from a free-text address.** §23.3 requires server-side resolution; the client never sends a zone or a price.
- **Never charge a size surcharge on an in-area or station-drop parcel.** Size surcharges apply only in the specified third-party mode.
- **Never derive the size class.** There are no thresholds to derive from — `MSC-DEC-209` deliberately establishes none. A server that guesses a class from weight is inventing a rule the Product Owner declined to make.
- **Never let the client send anything but the carrier cost.** `carrier_cost` is an observed figure with a waybill behind it. A margin, a surcharge or a total arriving from a client is a breach of §42.3, not a convenience.
- **Never borrow another hub's fee.** Fees are hub-scoped since `MSC-DEC-218`, and §33.4 forbids inheritance. A Kumasi order priced at Accra's rate is the specific failure hub-scoping exists to prevent.
- **Never re-resolve origin zone per parcel.** §23.3 snapshots it **once per request** — one request has one origin.
- **Never present the booking estimate as authoritative.** `MSC-DEC-211` reversed §23.6, `MSC-DEC-175` — every booking now shows an indicative estimate. But it assumes `SMALL` and in-area doorstep, and the class is selected *here*. The estimate and the frozen price must both be preserved and visibly distinct.
- **Never let a locked price change silently.** Post-freeze correction is reasoned maker-checker with full history.
- **Never let a retried `itemizeOrder` call mint a second reservation for one physical parcel.** `Idempotency-Key` and `If-Match` are both required on the operation, and the commercial machine additionally reserves exposure exactly once per order by uniqueness constraint — belt and braces, because a receiving officer on a flaky hub connection retries by instinct, not by malice (§22.8, HIGH-10 audit remediation).
- **Never re-point a parcel photo to the order, give an order two parcels, or give a parcel two orders.** The order references the parcel; the photo stays the stop's (the intake's, for an extra), and the one-to-one rule is the database's, not the screen's (D-A10, D-D6).
- **Never freeze, gate or dispatch an order whose parcel has not been checked in.** An early order waits for its parcel; a missing parcel's order stays visible as missing (D-D6).
- **Never conflate the high-value surcharge with the liability cap.** They answer different questions: the **cap limits what Melarc pays out** on a loss and is company-wide; the **surcharge funds the handling** that makes a loss less likely and is hub-scoped. A parcel can carry the surcharge and still be capped at GH₵300 — that is the design, not a contradiction to be reconciled away.

### 5.4 Early itemizing from the door photos (D-D6)

*Specified by Run D (the Product Owner's decision of 15 and 16 November 2026); built by Stage 7 (S1.36 to S1.40). A reading of mine is marked provisional and listed in [the plan's §11](../../delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md#11-decisions-recorded).*

- **A package may be made from a door photo before its parcel reaches the hub.** Officers see the rider's photos from the handover on (and on the stop's page before it), and may begin an order for a photographed parcel; for a parcel of a photo-mode intake that has **not been checked in** the order is **awaiting arrival**.
- **What waits.** An awaiting order exists and can be filled in (§23.2), and its estimate may be shown; **it is not frozen, not cleared by the commercial gate and not dispatch-eligible** until its parcel is checked in. *Provisional:* the freeze that §5.1 step 8 places at itemized-order confirmation is placed, for an early order, at the check-in of its parcel: **checking the parcel in confirms the order** (the freeze, the gate and the order's entry to its commercial machine run then).
- **Before the intake exists.** A parcel is identified by its id and by its door photo's evidence record. If Stage 7 lets an order begin before the handover has opened the intake, the order refers to the door photo's record, and the parcel rows the handover makes take that order over by it. *Provisional: Stage 7 decides whether this earlier start is built; the parcel table keeps the photo's record unique so that either is possible.*
- **A parcel that is missing stays visible as such.** An order whose parcel is `MISSING` is shown as missing, with its photo, is never priced, frozen or dispatched, and stays in the list until the case is decided; **what becomes of such an order after a write-off or an accepted count is for Stage 7 to propose to the Product Owner** (`OB-S1-120`).
- **An extra** recorded at the hub (a parcel with no door photo) is itemized like any other, with the photo taken at the hub; a `VOID` extra has no order.
- **The intake's `ITEMIZING` begins with the first order for a parcel that has arrived**, not with an awaiting order, and **a senior officer's correction of a count or a check-in ([hub-intake.md §5.8](hub-intake.md#58-a-seniors-correction)) is allowed only before that**.
- **Parity at close counts the parcels that arrived plus the accepted extras** (§22.7, §23.10): an intake closes when every `ARRIVED` parcel, door or extra, has its order (`PAYMENT_REQUIRED` orders count). Missing parcels are not in the count; an accepted extra is.

### 5.5 What Stage 7 must build

1. **`itemizeOrder` takes the parcel** the order is made for (S1.36, **built 19 November 2026**), judges its state (an `ARRIVED` parcel, or an `EXPECTED` one of a photo intake as an awaiting order) and gives the order the parcel's photo; one order for a parcel, held by the database.
2. **The confirmation at check-in** (S1.36 and S1.37): the freeze and the commercial gate run for an early order when its parcel arrives. *Built (S1.36): the freeze, when the arrival is committed, not at a tap the officer may still take back (the vendor finished, a missing parcel found, a senior's correction); the gate follows it in the same change (S1.37, built 19 November 2026: a resolved vendor portion of zero is `NO_VENDOR_CHARGE`, above zero is `PAYMENT_REQUIRED`, D-12).*
3. **The close counts parcels** (S1.38): the parcels that arrived plus the accepted extras; the vendor's summary stays free of the check-in's internals (AC-46).
4. **The screens** (S1.40) draw the parcel's photo beside the order form, tag an order *Awaiting arrival* or *Missing*, and show the unmatched parcels. *Built (S1.40, 23 November 2026): the form beside the door photo with the price checked before the order is saved, each parcel's work state on the orders list (needs an order, not here yet, order made and not confirmed, confirmed, missing), the order and its change, the close, the vendor's summary, who pays and the closes that left work; their routes are in [the Ops surface](../../surfaces/ops-portal.md).*

**Run D builds none of this**, and no itemizing screen, route or placeholder.

### 5.6 What the review of 19 November 2026 added, as built (Stage 7)

An external review found that the API was not yet a workflow an officer could resume after an interruption. The Product Owner approved every finding; each was traced in the code first, and all of it is built before the screens ([plan S1.39b](../../delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md#s139b--the-reads-and-the-controlled-changes-the-review-of-19-november-2026-asked-for)):

1. **Open the intake and find the work** (`listIntakeOrders`): the parcel worklist with **the counts of the whole intake** (received, still expected, needing an order, prepared, itemized, payment required, missing), each row the parcel and its order's state (`NEEDS_ORDER`, `AWAITING_ARRIVAL`, `PREPARED`, `ITEMIZED`, `MISSING`), filterable, paginated; **no price, portion or phone**: `hub.read` does not open the money. Physical and commercial state stay separate (a parcel's state beside the order's `commercial_state` and whether payment is required).
2. **Prepare and review before the irreversible act** (`previewOrder`): the price and its components, the high-value surcharge, the promise, **who pays each amount** and the state the gate would take the order to, and when the order is confirmed; written nowhere, judged exactly as `itemizeOrder` judges (the evidence it cites too), and it answers **`terms_token`, the digest of the terms the officer was shown**: the save is made on it (`reviewed_terms`), and a rate, a payer arrangement, a promise or a piece of evidence that changed since is `terms_changed`, with the terms as they are now, for the officer to read and confirm again. **A price calculated for an order that waits for its parcel is a protected quote** (OB-S1-148): kept as calculated at the confirmation; `amendOrder` is the explicit refresh. Four prices are four things on a screen: the booking's estimate, **the current preview** (`status: CURRENT_PREVIEW`), **the early quote** the order holds (`price_status: EARLY_QUOTE`) and **the frozen price** (`FROZEN`).
3. **Correct before the price freezes** (`amendOrder`): the recipient, the size, the declaration, the date, the destination, the evidence and **the payer arrangement of one order**, on the version that was read, with a reason, recalculated by the server and recorded; **a confirmed order is never edited** (a payer change is then a correction, a mistaken arrival a reversal). The freeze and the edit take the same row lock. The payer edit of the request is no longer stopped by the run having started (it moves no rider), and **it and the first freeze take one lock on the request**, so that one waits for the other: an edit that comes first is the arrangement the order freezes with, and one that comes after a freeze is refused (`price_frozen`) and is then a correction. **`previewOrderAmendment` previews an amendment as `previewOrder` previews an order** (the quote the order holds beside what it would become), and the amendment is saved on its token. **The high-value status a declaration gives is recomputed when the declaration changes, and the officer's own flag is kept apart from it; the choice of a zone is kept for the address it was made for** (a new address is resolved afresh and the officer is asked again only where the server cannot place it).
4. **Review the close** (`getIntakeClosure`): received, ordered, not priced, awaiting payment, missing, **the received parcels that still have no order, named** (the first hundred: a display limit, the rest through the worklist's `needs_order` view, a page at a time), whether the close needs the exception, and that **closing is not payment clearance and not a dispatch authorization**. A blind count that is not committed has received nothing that is known (null, not zero: "awaiting count"). **The approved exception is closed against what the senior read** (`assessment_token`, given back as `reviewed_assessment`): an order added, a parcel found or a count corrected since is `assessment_changed`, with the assessment as it is, and the senior reads it and confirms the reason again: **the senior's typed reason is kept, never written afresh** (D-S7-15, 24 November 2026).
5. **Resolve corrections** (`listPayerCorrections`, `getPayerCorrection`): a checker opens a pending correction after a reload or on another device, sees the order's unchanged total, the allocation it has and **the proposal in actual amounts**, who asked and why, and, once decided, what was approved.
6. **Find the closes that left work** (`listClosedIntakeExceptions`, Senior Ops, hub-scoped; OB-S1-151): the intakes closed with the approved exception that still have received parcels without an order, newest close first, each with what the hub received, how many orders stand, what is left, the reason and who closed it, so that the work is found again after a reload or on the next shift. **Nothing here resolves it**: the reopen of a closed intake (Platform Admin only, with a reason, the original close kept), the report of a parcel found after the close and the linked adjustment of an order that payment or dispatch made irreversible are not built.
6. **Take back a mistaken arrival** (`reverseOrderArrival`): a senior, with a reason, while nothing has been paid for, reserved or dispatched: the order is `REVERSED` and keeps its price and trail, the parcel is missing, the count is recomputed, the intake returns to reconciliation. **The intake begins `ITEMIZING` at its first confirmed order.**
7. **Close and communicate** (`closeHubIntake`): the close writes the envelope `intake.completed` in its own transaction; the messages (an individual sender's text, a registered vendor's feed entry) are the lane's, in words the Product Owner approved on 22 November 2026 (OB-S1-153: the hub "has finished checking in pickup {code}", true of a close with every order and of a close with the approved exception; an unapproved wording is still held back by the lane).

**Not built, and stated:** reopening a closed intake and a parcel found missing after the close (OB-S1-151: decided on 22 November 2026, scheduled and not built: a routine close stays final; staff report a late discovery to a named owner with a recorded outcome; a reopen is the Platform Admin's, with a reason and the original close kept; a linked adjustment where payment, a reservation or a dispatch must stand); who asked for a delivery date (OB-S1-149); the reversal of an order that has been paid for, reserved or dispatched (no payment or dispatch exists yet).

### 5.7 What the review of 21 November 2026 added, as built (Stage 7; [plan S1.39d](../../delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md))

A third external review traced the second round's work and found six more cases; each was traced in the code first and all are built before the screens:

1. **A blind intake takes no more orders than the parcels it received.** The places are the count: `previewOrder` and `itemizeOrder` refuse the order with no place left (`orders_exceed_received`), the table's own guard holds it for every writer under the intake's lock, and `closeHubIntake` refuses to close over a surplus that already stands, with the exception or without it. `getIntakeClosure` says so beforehand (`excess_count`, the blocker). **The screen offers "Create order" against the remaining quantity** (received less ordered): a blind count has no parcel rows to list, so there is no worklist entry to tap. The scale is the count: all of two hundred parcels received can have their order.
2. **What the officer confirms names the records it cites.** The terms the `terms_token` is of carry the identity of every record the order cites (`cited_evidence`: the evidence of a high-value parcel, sorted, and the carrier's waybill); the preview of an amendment shows the records the order holds now beside them. Another record, though as valid as the first, is `terms_changed`, and the officer sees which attachment changed.
3. **An amendment confirms nothing.** Its preview says `WHEN_ARRIVAL_IS_COMMITTED` whatever the parcel's state (expected, tapped, untapped, tapped again): the saved amendment leaves the quote an early quote (`price_status: EARLY_QUOTE`), and the act that commits the arrival (`finishCheckIn`, a found parcel, a count correction) makes it final.
4. **The request types say what the API requires.** The save of an order requires `reviewed_terms`, the save of an amendment `note` and `reviewed_terms`, and the previews carry neither; the close is a close that has parity (no token needed) or the exception **with** its assessment token. The tokens a screen receives (`terms_token`, `assessment_token`) are submitted under other names (`reviewed_terms`, `reviewed_assessment`).
5. **A save is judged on the configuration in force when it holds both its locks** (the review of 22 November 2026, OB-S1-163: [plan S1.39e](../../delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md)). The save holds the intake, then the request's payer (an amendment too, before it reads the order), and only then compares the digest of **the configuration in force at that moment** with the one it read (`melarc.hub_configuration_fingerprint`: the version in force of each hub setting, so a rate version that took effect while the save waited counts; the zones; the aliases; and the company-wide rules, the declaration threshold among them); a configuration that moved is read again, up to three times. A rate that moved is `terms_changed` with the new terms, a rule that now refuses the order refuses it with its own code, and a configuration that will not hold still is `STATE_CONFLICT`, rule `configuration_changing` (nothing made, nothing recorded: **the screen keeps the form and offers a new preview**). An early order keeps its protected quote until it is amended.
6. **A close that is out of date says so.** The intake's own version is judged before the assessment, so a senior who read both before they changed in both is told `stale` and is given no replacement assessment: the screen reads the intake and the closure again, keeps the typed reason as a draft and asks the senior to confirm the revised figures; an intake another officer closed reads as `CLOSED` with `closed_at` and the exception's note in the closure. `assessment_changed` (with the assessment as it is) is the answer when the version is current and the assessment is not.

### 5.8 What the Product Owner's decisions of 24 November 2026 added, as built (Stage 7, Run G1; [plan S1.39h](../../delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md))

1. **A senior officer is for what the business or money decides** (D-S7-11). A parcel an officer cannot order yet (a label that cannot be read, a missing phone, an address that makes no sense) **is the officer's**: the officer calls or messages the vendor, gets the details and makes the order. *Needs a senior* therefore lists only the vendors an arrival that a senior took back sent to review (`ARRIVAL_TAKEN_BACK`); a vendor with parcels still to order is never listed there, and `CLOSE_EXCEPTION` is no longer a reason (migration `0125`). The close with an exception stays a senior's act on the close page, unchanged.
2. **A parcel the officer is waiting on is marked** (D-S7-12; `setParcelWaitingForVendor`, `hub.intake.itemize`, migration `0126`): *Waiting for the vendor's details*, with an optional note of one short line (what was asked and how, for example "Called the vendor, waiting on WhatsApp"; no phone number in it). **The server holds the mark, so every officer and every tablet sees it.** The parcel's row in the worklist says it, a view and a count of its own say how many wait, *Make the next order* passes over a marked parcel, and the mark is cleared by the server when the parcel's order is made, or by an officer. A parcel that waits still needs its order: it stays in the close's outstanding count. No senior, no money, no new key; the mark moves nothing the save compares.
3. **The parcel's photo is on the order and on the change** (D-S7-14, `AC-SLICE-001-90`): the staff view of an order carries the identifier of its parcel's picture (`intake_parcel_photo_evidence_id`), opened through the retrieval authorization; a vendor's view never carries it.
4. **A vendor counted without photos is named by its vendor** (`vendor_name` on every read of an intake and on the closes that left work), from the stop's dispatch snapshot, never by its code alone; the name is no part of the intake's `ETag`.
5. **A telephone number never enters a note** (the audit's screening, asked first by every act that takes a note): `VALIDATION_FAILED` on the note with the rule `phone_number`, in any form a person in Ghana writes one.
6. **The correction of a recipient is bound to its record by the database** (migration `0127`): the order takes the recipient the record says it became, and the place (map link, coordinates) does not move in a correction.
7. **The senior's reason is kept after a stale assessment** (D-S7-15): the senior reads the assessment as it now is and confirms the reason again; the reason is never written afresh.
8. **How the officer goes from one parcel to the next** (Run G1): *Make the next order* moves **forward** from the parcel just saved or marked, passes over a parcel that is waited on, and goes back to the lowest parcel only when none is left after it; when every parcel that is left is waited on it says so and leads to them; a parcel that already has an order says so with its order's code and a link, and draws no form. **For an address no zone matches** the officer is offered the hub's own zones (`listDestinationZones`) and chooses the one the address is in with a reason (`destination_zone_authorization`); the server still judges the choice. A price check that fails for a reason that is no field's keeps the entries and is checked again on one press (after a 429, once, by itself, when the server's wait is over).

---

## 6. Entities — *pointer*

| Entity| Home|
|---|---|
| `Order`| [domain-model.md](../../contracts/domain-model.md) §6.7|
| `PickupIntake`| [domain-model.md](../../contracts/domain-model.md) §6.6|
| `IntakeParcel` *(designed, Run D: the parcel an order is made for)*| [domain-model.md](../../contracts/domain-model.md) §6.6a|
| `ServiceZone`, `ZonePairRate`| [domain-model.md](../../contracts/domain-model.md) §6.8|

Non-obvious: `origin_zone_snapshot` is **inherited from the request**, not resolved per order; `price_components_snapshot` carries each component with its setting key and effective version; `declared_value_minor` drives auto-flagging.

## 7. States — *pointer*

| Machine| Home| Transitions this feature drives|
|---|---|---|
| `PickupIntake.state`| [state-machines.md](../../contracts/state-machines.md) §7| `READY_FOR_ITEMIZATION → ITEMIZING → CLOSED`; the exception close|
| `IntakeParcel.state` *(designed)*| [state-machines.md](../../contracts/state-machines.md) §7| Read only: `EXPECTED` ("awaiting arrival"), `ARRIVED`, `MISSING`, `VOID` decide what an order may do ([§5.4](#54-early-itemizing-from-the-door-photos-d-d6))|
| `Order.commercial_state`| [state-machines.md](../../contracts/state-machines.md) §8| `→ PRICED`; `→ CREDIT_RESERVED` or `PAYMENT_REQUIRED`; reprice; correction|

## 8. Permissions — *pointer*

| Key| Holders| Scope| Home|
|---|---|---|---|
| `hub.intake.itemize`| Ops, Senior Ops, Platform Admin| own hub (Platform Admin: all hubs)| [permissions.md](../../contracts/permissions.md) §7|
| `hub.intake.close`| Ops, Senior Ops, Platform Admin| own hub (Platform Admin: all hubs)||
| `hub.intake.close_exception`| **Senior Ops, Platform Admin**| own hub (Platform Admin: all hubs)||
| `pricing.correction.create`| Ops| own hub||
| `pricing.correction.approve`| **Senior Ops**| own hub (Platform Admin: all hubs), approver ≠ creator, a Platform Admin excepted||
| `pricing.reprice.request`| Ops| own hub||
| `pricing.reprice.approve`| **Senior Ops**| own hub||

## 9. Settings — *pointer*

| Key| Why this feature reads it| Home|
|---|---|---|
| `service_area_base_fee`| `CONFIRMED` — GH₵35 at the Accra hub. **Hub-scoped**| [settings.md](../../contracts/settings.md) §7.2|
| `corridor_off_day_fee`| `CONFIRMED` — GH₵70 at the Accra hub||
| `size_class_surcharges`| `CONFIRMED` — `SMALL` 0, `MEDIUM` 20, `LARGE` 30. **Outside-Accra only.** No boundary key exists and none may be added||
| `station_drop_fee`| `CONFIRMED` — GH₵20||
| `outside_accra_margin`| **GH₵30, flat**. The **unit** was the open half — flat, because Melarc's work does not scale with the carrier's price and a percentage would double-count size||
| `MELARC_HIGH_VALUE_TIERS`| **GH₵500–2,000 → GH₵10 · above GH₵2,000 → GH₵20**. Two tiers, not three: `liability_cap_amount` is flat, so each further tier charges more for cover that does not increase||
| Hub service-zone catalogue| `CONFIRMED` — seven zones for the launch hub. **Serviceability only, no longer a price input**||

**Every one is now set.** `MSC-DEC-238` entered the last two on 23 August, and this feature's pricing inputs carry no unvalued key. It was the largest single launch dependency in the product; it is now none.

**§33.4 still bites, and will again.** Settings never inherit, so a **second hub** takes no bookings until all nine of its own fee keys are entered. What closed here is Accra's configuration, not the class of problem.

## 10. Errors — *pointer*

`PARITY_NOT_MET`, `ORDER_UNPRICED`, `SETTING_MISSING`, `VALIDATION_FAILED`, `REASON_REQUIRED`, `SELF_APPROVAL_FORBIDDEN`, `NO_PRICING_CHANGE`, `SIZE_CLASS_REQUIRED`, `CARRIER_COST_REQUIRED`, `MARGIN_NOT_CONFIGURED`, `VALUE_DECLARATION_REQUIRED`, `NOTIFICATION_FAILED`, `ALLOWANCE_DISABLED`, `ACCOUNT_OVERDUE`, `CREDIT_LIMIT_EXCEEDED`, `INSUFFICIENT_AUTHORITY` — [errors-and-enums.md](../../contracts/errors-and-enums.md).

## 11. Audit events — *pointer*

`hub.intake.itemized`, `hub.intake.closed`, `hub.intake.closed_exception` *(enhanced)*, `pricing.price.calculated`, `pricing.price.locked`, `pricing.size_class.selected` *(enhanced)*, `pricing.carrier_cost.captured` *(enhanced)*, `pricing.correction.requested`, `pricing.correction.approved` *(enhanced)*, `pricing.correction.applied`, `pricing.reprice.approved` *(enhanced)*, `order.credit.reserved`, `order.payment.required`, `order.delivery_date.overridden` — [audit.md](../../contracts/audit.md) §5.2–5.3.

**Every identifier is spelled in full.** The suffix form — `` `.dispatched` `` after `` `pickup.manifest.created` `` — is not a resolvable identifier: no check can verify it, and it still reads correctly after the code it points at is renamed.

**`order.delivery_date.overridden` was missing from this pointer until 23 August**, though this feature owns the `MSC-DEC-213` derivation and the Ops override that `delivery_date_override` records.

## 12. API operations — *pointer*

`itemizeOrder`, `closeHubIntake` (its optional body is the approved parity exception), `getOrder`, `requestPayerCorrection` and `approvePayerCorrection` — [openapi.yaml](../../contracts/openapi.yaml). **Stage 7 adds** `listIntakeOrders`, `previewOrder`, `amendOrder`, `getIntakeClosure`, `listPayerCorrections`, `getPayerCorrection` and `reverseOrderArrival` (contract 5.114.0 and 5.115.0), and **Run F adds** `listDestinationZones` and `correctOrderRecipient` (contract 5.119.0). The payer arrangement before the freeze is edited with `amendPickupRequest` ([pickup-request.md](../pickup/pickup-request.md)). `OrderItemize` is `additionalProperties: false`. It carries `carrier_cost` — an observed cost, not a price — and **no price and no destination zone**: a client that could send either could set its own price. **Stage 7 adds the parcel the order is made for (D-D6)**, a field the build names; the parcel is an identifier and carries no price either.

---

## 13. Acceptance criteria

### `AC-SLICE-001-47` — Price is server-derived, never client-supplied

```text
Given an Ops user itemizing a parcel,
When the itemization payload includes a price, a total, a margin or a destination zone,
Then the request is rejected by schema,
And carrier_cost is the only monetary field the payload may carry,
And it is accepted only when commercial_mode is MELARC_COVERED_THIRD_PARTY_DELIVERY,
And the server applies the hub margin and size surcharge to it,
And the client never influences the resulting price.
```

**Governs:** §23.3, §35.6.6, §42.3, `MSC-DEC-210` · **Surface:** Melarc Ops · **Test level:** API · **Code:** `VALIDATION_FAILED`

### `AC-SLICE-001-48` — Corridors price on batch day, and cost more off it

```text
Given a parcel whose destination is KASOA_CORRIDOR,
When it is delivered on Friday, its batch day,
Then the fee is service_area_base_fee, the same as any in-area doorstep parcel,
And when it is delivered on any other operating day the fee is that corridor's corridor_off_day_fee (one value per corridor),
And the off-day request is accepted and priced rather than refused,
And origin has no effect on either fee.
```

**Governs:** §23.11, `MSC-DEC-207` · **Surface:** Melarc Ops · **Test level:** unit

**Why origin is called out.** Under the matrix, a corridor was an ordinary zone as *origin* and a rate-card zone as *destination* — an asymmetry that was easy to implement backwards. Flat pricing removes it: origin never affects the fee.

### `AC-SLICE-001-49` — The size surcharge applies outside Accra and nowhere else

```text
Given a LARGE parcel delivered doorstep within the service area,
When the fee is calculated,
Then the fee is service_area_base_fee with no surcharge added,
And a LARGE parcel sent as STATION_DROP is station_drop_fee with no surcharge added,
And a LARGE parcel sent as MELARC_COVERED_THIRD_PARTY_DELIVERY adds the LARGE surcharge,
And a SMALL parcel adds GH0 in every mode rather than being exempt from the calculation.
```

**Governs:** §23.4, `MSC-DEC-209` · **Surface:** Melarc Ops · **Test level:** unit

### `AC-SLICE-001-50` — Pricing is blocked when a zone will not resolve

```text
Given a delivery address that resolves to no active zone of the responsible hub,
When Ops attempts to save or price the order,
Then pricing is blocked,
And the order cannot be priced under the normal flow,
And the system does not fall back to another hub rate or a global default,
And a hub whose outside_accra_margin is unset refuses the order rather than pricing it at cost.
```

**Governs:** §23.3, §33.4, `MSC-DEC-218` · **Surface:** Melarc Ops · **Test level:** API · **Code:** `SETTING_MISSING`, `MARGIN_NOT_CONFIGURED`

### `AC-SLICE-001-65` — A recipient-pays order clears the gate with no vendor charge

```text
Given an itemized order whose resolved vendor portion is zero,
And the vendor account is OVERDUE,
When the commercial gate runs,
Then the order enters NO_VENDOR_CHARGE and is dispatch-eligible,
And no credit is reserved and no payment is required,
And order.commercial.cleared_no_charge is recorded.
```

**Governs:** §5.2.2, §5.2.3, `MSC-DEC-244` · **Surface:** Melarc Ops · **Test level:** service

### `AC-SLICE-001-66` — The zero test reads the amount, not the intent

```text
Given an itemized order created from a request whose intent was SPLIT,
And the split resolved the sender portion to zero,
When the commercial gate runs,
Then the order enters NO_VENDOR_CHARGE,
And the same holds for a parcel-level override that moves the whole fee to the recipient.
```

**Governs:** §5.2, `MSC-DEC-244` · **Surface:** Melarc Ops · **Test level:** service

### `AC-SLICE-001-51` — PAYMENT_REQUIRED counts toward parity

```text
Given an intake of 5 received parcels itemized into 5 orders, one of which is PAYMENT_REQUIRED,
When Ops closes the intake,
Then closure succeeds,
And the PAYMENT_REQUIRED order is blocked from dispatch readiness but the intake is closed,
And no parity exception is required.
```

**Governs:** §23.10, §35.6.11 · **Surface:** Melarc Ops · **Test level:** API

### `AC-SLICE-001-52` — Closure accounts for the hub count, not the declaration

```text
Given an intake where the rider declared 10 and the hub received 9,
When 9 orders exist and Ops closes the intake,
Then closure succeeds against the hub received count,
And an attempt to close against 10 orders is refused.
```

**Governs:** §22.7, §23.10 · **Surface:** Melarc Ops · **Test level:** service · **Code:** `PARITY_NOT_MET`

### `AC-SLICE-001-53` — Serialized goods require a serial or IMEI

```text
Given a parcel flagged as electronics or serialized goods,
When Ops itemizes it without a serial or IMEI,
Then the itemization is rejected,
And with the identifier supplied the order is created.
```

**Governs:** §23.2, §23.4 · **Surface:** Melarc Ops · **Test level:** API · **Code:** `VALIDATION_FAILED`

### `AC-SLICE-001-54` — High value auto-flags and demands evidence

```text
Given a declared value above the first configured high-value tier,
When Ops itemizes the parcel,
Then is_high_value is set automatically,
And itemization is refused until verified evidence is attached,
And Ops may also flag a lower-value parcel as high value manually.
```

**Governs:** §23.4, `MSC-DEC-212`, `MSC-DEC-219`, `MSC-DEC-220` · **Surface:** Melarc Ops · **Test level:** API · **Code:** `REASON_REQUIRED`, `VALUE_DECLARATION_REQUIRED`

**The surcharge applies and the cap still binds.** `MSC-DEC-219` retained the tiered surcharge; `MSC-DEC-212` caps payout at GH₵300 regardless. A parcel may pay a high-value surcharge and still be capped — the criterion must not treat that as inconsistent. Declaration above the threshold requires the sender's **acknowledgement of the cap**.

### `AC-SLICE-001-55` — The freeze is the boundary for payer edits

```text
Given a request none of whose parcels is itemized, so that no price is frozen,
When the vendor or authorized Ops edits the payer arrangement (amendPickupRequest),
Then the edit succeeds,
And after freeze the same edit is an Ops correction (requestPayerCorrection) approved by Senior Ops (approvePayerCorrection),
And the approver may not be the requester, unless the approver is a Platform Admin,
And complete before and after history is retained.
```

**Governs:** §23.5, §35.6.7 · **Surface:** Melarc Ops, Melarc Vendor · **Test level:** API · **Code:** `SELF_APPROVAL_FORBIDDEN`

### `AC-SLICE-001-56` — The booking estimate is indicative; this is the authoritative price

```text
Given a standard multi-package pickup request,
When it is booked,
Then an indicative estimate of base fee times package count is shown,
And it is presented as provisional and not as a quote,
And when the parcel is itemized as MEDIUM or LARGE outside the service area the frozen price exceeds it,
And both the estimate and the frozen price are preserved and visibly distinct.
```

**Governs:** §23.6, `MSC-DEC-211` · **Surface:** Melarc Ops, Melarc Vendor · **Test level:** e2e

**Reversed on 19 August.** §23.6, `MSC-DEC-175` showed no estimate at all, because the zone-pair matrix needed a destination zone nobody had at booking. A flat fee removed that obstacle. The estimate stays *provisional* for a different reason — the size class is selected at itemization, not booked.

### `AC-SLICE-001-57` — Origin zone comes from the request, once

```text
Given a request with one origin producing several parcels,
When each parcel is itemized,
Then every order carries the same origin zone snapshot resolved once for the request,
And a mid-request pickup-location correction re-resolves it before price freeze under the controlled-correction rule,
And changing the origin zone does not change the fee, because the base fee is independent of origin.
```

**Governs:** §23.3, `MSC-DEC-208` · **Surface:** Melarc Ops · **Test level:** service

### `AC-SLICE-001-58` — The size class is a recorded human judgement

```text
Given a parcel physically present at itemization,
When Ops selects its size class,
Then the selecting officer is recorded on the order,
And an enhanced audit event names who selected it and when,
And no server rule derives a class from weight or dimensions,
And pricing is refused when no class has been selected.
```

**Governs:** `MSC-DEC-209`, §38 · **Surface:** Melarc Ops · **Test level:** API · **Code:** `SIZE_CLASS_REQUIRED`

The itemization request does not mark `size_class` as required in its schema, so that an omitted class reaches this rule and is refused with `SIZE_CLASS_REQUIRED` instead of a schema `400`.

**This is the whole mitigation for a deliberate decision.** The Product Owner ruled that Ops classifies by judgement with no thresholds. That means two officers can grade the same parcel differently and change the fee by up to GH₵30. The audit record is what makes such a disagreement adjudicable instead of merely arguable — so an implementation that prices correctly but records no selector has failed this criterion.

### `AC-SLICE-001-59` — Carrier cost is transcribed; the price is computed

```text
Given an outside-Accra parcel handed to a third-party carrier,
When Ops transcribes the carrier's actual charge from their waybill,
Then the order stores that cost as an observed value with its evidence,
And the server computes the price as carrier cost plus the hub margin plus the size surcharge,
And the client cannot submit the margin, the surcharge or the total,
And an enhanced audit event records the captured cost for reconciliation against the waybill.
```

**Governs:** `MSC-DEC-210`, §42.3 · **Surface:** Melarc Ops · **Test level:** API · **Code:** `CARRIER_COST_REQUIRED`

### `AC-SLICE-001-90` — An order's photo is its parcel's photo, one order for a parcel

*Restated on parcels by D-D2 and D-D6 (16 November 2026); it read "chosen from the collection's photos, one photo per order".*

```text
Given an intake of three parcels, one for each door photo, whose vendor has been checked in,
When the officer itemizes the first parcel,
Then the order references that parcel and shows its door photo, and the evidence still belongs to the pickup stop,
And the other two parcels are shown as unmatched until they have orders,
And a parcel of another intake cannot be ordered, a second order cannot be made for the same parcel, and the order cannot take a second parcel, by any writer,
And the photo is shown with the order in the order list, on the order page and on the delivery rider's stop.
```

**Governs:** D-A10, D-D2, D-D6, [pickup-collection.md §5.5](../pickup/pickup-collection.md#55-the-photo-of-every-parcel) · **Surface:** Melarc Ops · **Test level:** API, database · **Status:** built by Stage 7 (`OB-S1-82`: the order is made for a parcel and takes its photo) with the order screens (`OB-S1-85`, S1.40; the screens were reworked by Run F, 23 November 2026; the photo whole and on the order's page is owed, OB-S1-168).

### `AC-SLICE-001-104` — A package can be made from a door photo before its parcel is checked in

```text
Given a photo-mode intake of 12 expected parcels, whose vendor is being checked in,
When the officer itemizes one parcel from its door photo before it has been checked in,
Then the order exists as awaiting arrival, with its photo, and is not frozen, not cleared by the commercial gate and not dispatch-eligible,
And when the parcel is checked in the order is confirmed: its price freezes and the gate runs,
And if the vendor is finished without that parcel the order stays visible as missing and is never priced or dispatched,
And parity at close counts the parcels that arrived plus the accepted extras.
```

**Governs:** D-D6, §22.7, §23.10 · **Surface:** Melarc Ops · **Test level:** API, database · **Status:** specified (Run D); built by Stage 7 (S1.36 to S1.40), whose screens are S1.40's.

---

## 14. Open questions blocking this feature

| ID| What it blocks here| Type|
|---|---|---|
| `OQ-005`| Credit-reservation ledger mechanics behind the commercial gate| `ARTIFACT_REQUIRED`|

**No question of any type now blocks this feature's pricing.** `OQ-064` and `OQ-020` both closed on 23 August; `OQ-062` closed on 20 August. Only `OQ-005`, the credit-reservation ledger behind the commercial gate, still bears on it.

**`OQ-020` is worth a closing note.** It once held every cell of a 7×7 matrix plus four surcharges plus six corridor rates. **Most of it was never answered — it was withdrawn**, when `MSC-DEC-207` replaced the matrix with a flat service-area fee. The two figures that survived to be decided were decided in an hour. **A long-open `VALUE_REQUIRED` question is often evidence about the structure demanding the values**, not about anyone's diligence.

## 15. What this feature still owes its slice

| Owed| Blocks which DoR area| Owner|
|---|---|---|
| Credit-reservation ledger mechanics behind the commercial gate| C, E| `OQ-005`|
| **Early itemizing from the door photos (D-D6)** — the order made for a parcel, awaiting arrival and confirmed by the check-in; the close counting parcels; what becomes of a missing parcel's order (`OB-S1-120`)| E| Stage 7 (S1.36 to S1.40)|

**All six pricing settings now carry values**, so every criterion touching a figure is exercisable. That was the larger of this feature's two obstacles and it closed on 23 August.

**Readiness is not assessed here.** [definition-of-ready.md](../../standards/definition-of-ready.md) assesses it **for the complete vertical slice** and records the verdict in the slice document; a feature cannot answer §44.3 or §44.4 alone. This section feeds that assessment instead of duplicating it (`MSC-DEC-239`, closing `CONFLICT-029`).

**Evidence became creatable on 24 August**. `createEvidence` and `completeEvidenceUpload` are written, and **`AC-SLICE-001-54` is executable**. `Evidence` was fully modelled at [domain-model.md](../../contracts/domain-model.md) §3.6 and **no operation produced one**, so every criterion here requiring attached evidence was unexecutable — a fact recorded against `OQ-048` and **never against this feature**. The guard worth knowing: a `PENDING_UPLOAD` record **may not be referenced**, so "evidence attached" now means bytes actually arrived.

## 16. Build status — *honest, per surface*

| Surface| Status| Gap|
|---|---|---|
| Melarc Ops| 🟡 API complete for its screens (S1.36 to S1.39e and Run F), the screens built (S1.40 and Run F, 23 November 2026; what Run F left is the plan's S1.40a)| **Built:** the order made for a parcel, priced, promised and, for a parcel that has arrived, frozen (`itemizeOrder`), with its first commitment; the order that waits for its parcel and its confirmation at the check-in; the high-value surcharge; the evidence of an itemization. **Also built (S1.37):** the commercial gate, `NO_VENDOR_CHARGE` or `PAYMENT_REQUIRED` at the freeze, with its event (no credit reservation, D-12). **Also built (S1.38):** `closeHubIntake` (parity against the hub-received count, the approved exception), `getIntakeSummary` (the vendor-facing summary of a closed intake, field-filtered by construction) and `getOrder` (staff in full, a vendor without the recipient, the serial, the officer who judged the size and the carrier's cost); `intake.completed` is the business name of the close and its record is `hub.intake.closed` (OB-S1-143). **Also built (S1.39):** the payer edit before the freeze (`amendPickupRequest`, the payer arrangement only) and the payer correction after it (`requestPayerCorrection`, `approvePayerCorrection`: maker-checker, complete before and after, the gate re-run). **Run F (23 November 2026, contract 5.119.0), the Product Owner's decisions D-S7-1 to D-S7-10:** `itemizeOrder` answers the vendor's new version in `Intake-ETag`; a vendor is told the state of its own order's parcel (a parcel written off is told as not received: no price, nothing to pay) and sees who pays what on its own orders (`getOrder` and the summary: D-S7-4, D-S7-10); `listDestinationZones` (D-S7-5); the rows of Orders to make carry the orders made and the parcels still to order, and `view=needs_senior` lists the vendors that wait for a senior officer (D-S7-6, D-S7-7); the recipient's name, phone and, where the zone and price come out as they are, address of a confirmed order are corrected with a reason, the old and the new kept (`correctOrderRecipient`: D-S7-1); the destination zone an order keeps is declared (`DestinationZoneSnapshot`), and the counts of an intake counted blind say that `needs_order` is a number with no rows. **Owed:** the checker's request for an address that moves the zone or the price (S1.39g), the correction of a pickup address of a request that holds a run (S1.57, D-S7-9) and the reopen of a closed intake (OB-S1-151). **Screens built by Run F:** the price is beside the order form by itself and the order is saved at that price, with what was typed above the save (D-S7-2); the recipient of a confirmed order is corrected from the order's page with a reason (D-S7-1); a vendor counted without photos is told the code to write on the parcel, where it stands by the count and its last five orders (D-S7-3); Orders to make says how many orders each vendor has and has a view of the vendors that wait for a senior officer (D-S7-6, D-S7-7); the statuses are *Waiting for its parcel* and *Confirmed — price fixed* (D-S7-8). **Screens owed:** the zone offer for an address that matches none (D-S7-5's screen half), the early orders as a loop, *Skip this parcel*, the photo whole and on the order's page (OB-S1-168, OB-S1-169)|
| Melarc Vendor| ⚪ not built| Order summary, payer edit before freeze|
| Melarc Rider| N/A| —|
| Recipient channel| N/A| Recipient is captured here but not yet contacted|

## 17. Related

- **Upstream:** [hub-intake.md](hub-intake.md) — supplies the authoritative received count and the parcels an order is made for
- **Downstream:** dispatch and delivery features — Phase 4
- **Slice:** `SLICE-001` — this feature closes the proving slice
