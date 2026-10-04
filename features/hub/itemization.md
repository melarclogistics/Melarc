# Itemization and Pricing

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.10 (cleaned edition)
> **Date:** 4 October 2026
> **Domain:** `hub`
> **Owns:** the behaviour and acceptance criteria for converting received parcels into priced Orders, and for closing the intake
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §23, §35.6, §22.7, §36.11
> **Slice:** `SLICE-001`

## 1. What this is, and why

Itemization converts each **physically received parcel** into an operational `Order` carrying recipient, routing, handling, payer and commercial attributes (§23.1). It is where **price first becomes authoritative** — for a standard booking, the parcel's first price ever.

One physical parcel becomes one `Order` (§23.1, `MSC-DEC-187`).

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

- The intake is `READY_FOR_ITEMIZATION` — the blind count is committed and reconciliation has passed.
- The responsible hub has an **active zone catalogue** and an approved **service-area base fee**. Where the parcel is outside-Accra, the hub's `outside_accra_margin` must also be set — §33.4 forbids borrowing another hub's value, and pricing at cost would ship the order at zero margin silently. **Set at GH₵30 for Accra**; a new hub starts with none.

---

## 5. Behaviour

### 5.1 Normal path

1. **Ops itemizes a parcel into an Order**, capturing §23.2 in full: recipient name and phone; delivery address, GhanaPost GPS and resolved zone; size class; declared value, high-value flag and required evidence; electronics flag with serial or IMEI; payer arrangement; service level and requested date; lane; and source linkage.
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
8. **The intake closes** when every hub-received parcel is accounted for. Closure emits `intake.completed` and generates the vendor-facing order summary (§23.10).

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
- **Never conflate the high-value surcharge with the liability cap.** They answer different questions: the **cap limits what Melarc pays out** on a loss and is company-wide; the **surcharge funds the handling** that makes a loss less likely and is hub-scoped. A parcel can carry the surcharge and still be capped at GH₵300 — that is the design, not a contradiction to be reconciled away.

---

## 6. Entities — *pointer*

| Entity| Home|
|---|---|
| `Order`| [domain-model.md](../../contracts/domain-model.md) §6.7|
| `PickupIntake`| [domain-model.md](../../contracts/domain-model.md) §6.6|
| `ServiceZone`, `ZonePairRate`| [domain-model.md](../../contracts/domain-model.md) §6.8|

Non-obvious: `origin_zone_snapshot` is **inherited from the request**, not resolved per order; `price_components_snapshot` carries each component with its setting key and effective version; `declared_value_minor` drives auto-flagging.

## 7. States — *pointer*

| Machine| Home| Transitions this feature drives|
|---|---|---|
| `PickupIntake.state`| [state-machines.md](../../contracts/state-machines.md) §7| `READY_FOR_ITEMIZATION → ITEMIZING → CLOSED`; the exception close|
| `Order.commercial_state`| [state-machines.md](../../contracts/state-machines.md) §8| `→ PRICED`; `→ CREDIT_RESERVED` or `PAYMENT_REQUIRED`; reprice; correction|

## 8. Permissions — *pointer*

| Key| Holders| Scope| Home|
|---|---|---|---|
| `hub.intake.itemize`| Ops, Senior Ops, Platform Admin| own hub| [permissions.md](../../contracts/permissions.md) §7|
| `hub.intake.close`| Ops, Senior Ops, Platform Admin| own hub||
| `hub.intake.close_exception`| **Senior Ops, Platform Admin**| own hub||
| `pricing.correction.create`| Ops| own hub||
| `pricing.correction.approve`| **Senior Ops**| own hub, approver ≠ creator||
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

`itemizeOrder` and `closeHubIntake` — [openapi.yaml](../../contracts/openapi.yaml). `OrderItemize` is `additionalProperties: false`. It carries `carrier_cost` — an observed cost, not a price — and **no price and no destination zone**: a client that could send either could set its own price.

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
And when it is delivered on any other operating day the fee is corridor_off_day_fee,
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
Given an order whose price is not yet frozen,
When the vendor or authorized Ops edits the payer arrangement,
Then the edit succeeds,
And after freeze the same edit requires an Ops correction approved by Senior Ops,
And the approver may not be the requester,
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

**All six pricing settings now carry values**, so every criterion touching a figure is exercisable. That was the larger of this feature's two obstacles and it closed on 23 August.

**Readiness is not assessed here.** [definition-of-ready.md](../../standards/definition-of-ready.md) assesses it **for the complete vertical slice** and records the verdict in the slice document; a feature cannot answer §44.3 or §44.4 alone. This section feeds that assessment instead of duplicating it (`MSC-DEC-239`, closing `CONFLICT-029`).

**Evidence became creatable on 24 August**. `createEvidence` and `completeEvidenceUpload` are written, and **`AC-SLICE-001-54` is executable**. `Evidence` was fully modelled at [domain-model.md](../../contracts/domain-model.md) §3.6 and **no operation produced one**, so every criterion here requiring attached evidence was unexecutable — a fact recorded against `OQ-048` and **never against this feature**. The guard worth knowing: a `PENDING_UPLOAD` record **may not be referenced**, so "evidence attached" now means bytes actually arrived.

## 16. Build status — *honest, per surface*

| Surface| Status| Gap|
|---|---|---|
| Melarc Ops| ⚪ not built| Everything|
| Melarc Vendor| ⚪ not built| Order summary, payer edit before freeze|
| Melarc Rider| N/A| —|
| Recipient channel| N/A| Recipient is captured here but not yet contacted|

## 17. Related

- **Upstream:** [hub-intake.md](hub-intake.md) — supplies the authoritative received count
- **Downstream:** dispatch and delivery features — Phase 4
- **Slice:** `SLICE-001` — this feature closes the proving slice
