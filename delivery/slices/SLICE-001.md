# `SLICE-001` — Pickup request through hub itemization

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.33 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** the scope, readiness verdict and demonstration script for the proving slice
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §21, §22, §23, §44, §45

## 1. Scope

A parcel from **the sender's booking to a priced, itemized Order** — the spine of the product, and the thread every other slice depends on.

| Feature| Criteria|
|---|---|
| [pickup-request](../../features/pickup/pickup-request.md)| 20|
| [pickup-manifest](../../features/pickup/pickup-manifest.md)| 14|
| [pickup-collection](../../features/pickup/pickup-collection.md)| 11|
| [pickup-failure](../../features/pickup/pickup-failure.md)| 7|
| [hub-intake](../../features/hub/hub-intake.md)| 13|
| [itemization](../../features/hub/itemization.md)| 15|
| **Total**| **80**|

**Surfaces:** [Ops Portal](../../surfaces/ops-portal.md), [Vendor PWA](../../surfaces/vendor-pwa.md), [Rider Android](../../surfaces/rider-android.md). The [recipient channel](../../surfaces/recipient-channel.md) is touched only for the ad-hoc handshake SMS.

**Out of scope:** recipient confirmation, dispatch, delivery, payment collection, settlement, returns. The slice ends when the intake closes.

## 2. Why this thread was chosen

Three reasons, all of which held:

1. **It touches every surface**, so it exercises the whole document set rather than one corner.
2. **It has no `DECISION_NEEDED` blocker** — the only product question in its path, `OQ-054`, was closed by `MSC-DEC-194` on 16 August.
3. **It is the spine.** Every later slice depends on an Order existing and being priced.

## 3. Definition of Ready — assessed 17 August 2026

Apply [definition-of-ready.md](../../standards/definition-of-ready.md) to the bounded task. Scope, contracts, demonstrations and dependencies are retained below. Resolve an actual product or technical gap before implementing the affected path. Historical approval labels and previous readiness assessments are not additional workflow requirements.

## 4. Verdict

Specification scope is retained; implementation and verification remain to be performed. Do not infer a passing build, integration or release from this document. Report readiness and results for the specific task being executed.

## 5. What would make it `READY`

Before implementing the priced pickup flow, establish the identity foundation and the hub pricing-configuration path described in [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md) §4a. Preserve outstanding evidence-storage and provider requirements in their owning documents. Apply the readiness checklist to the actual task.

## 6. Demonstration script

§45.1 requires the Product Owner to **demonstrate the normal and material exception paths**. This is what that demonstration must cover — and each line is a rule that would otherwise be plausible to get wrong.

**Normal path**

1. Ops creates a pickup request for a registered vendor: 3 packages, Tuesday, recipient pays. **An indicative estimate appears — base fee × 3, labelled provisional**. It is not a quote. **A declared value above GH₵500 requires the cap acknowledgement here, at booking** — not at itemization, which is after custody.
2. Ops confirms it. It joins the unmanifested pool.
3. Ops builds a manifest, orders the stops manually, assigns a rider. **Vendor self-cancellation closes at this moment.**
4. Ops dispatches. The rider is notified; **the run has not started.**
5. The rider starts the run and works the stops out of order.
6. At a stop the rider records 3 collected; the vendor enters the code in the portal. **The channel records `PORTAL`, not nothing.**
7. The rider submits the hub handover with the pre-filled count, **corrected before submission**.
8. A receiver opens the intake. **The rider-declared count is nowhere in the response.**
9. The receiver submits the physical count. **The comparison is revealed for the first time.**
10. Ops itemizes 3 parcels into 3 Orders, **selecting a size class for each**. The server calculates the price; the client sends neither a price nor a zone. **The chosen class and the officer who chose it are recorded.**
11. One parcel is bound for Kumasi. Ops transcribes the carrier's waybill charge. **The server applies the hub margin and the size surcharge — the client cannot touch either.**
12. Ops closes the intake against the **hub** count.

**Exception paths, each of which must be demonstrated**

| Path| What must be seen|
|---|---|
| Single-package self-booking| Refused, `PICKUP_MINIMUM_NOT_MET`|
| Corridor delivery off its batch day| **Priced at GH₵70, not refused.** The off-day trip is a real service|
| Large parcel delivered in Accra| **GH₵35 flat — no size surcharge.** The inverse of what §35.6.9 says|
| Large parcel to Kumasi| Carrier cost + margin **+ GH₵30**. The only mode the surcharge touches|
| Outside-Accra order, hub margin unset| **Refused, not priced at cost** (`MARGIN_NOT_CONFIGURED`)|
| Itemization with no size class chosen| Refused (`SIZE_CLASS_REQUIRED`). There is no default|
| Address corrected within the same service area| **No repricing workflow fires.** Nothing changed|
| One-package exception| **Any holder of `pickup.exception.approve`** approves — Senior Ops, Platform Admin, or Ops Staff explicitly granted it. Recipient details become mandatory. **The GH₵20 pickup fee applies anyway** — approval does not waive it|
| Booking past the hub cutoff| **Confirms** and queues for Ops review. **No error**|
| Short collection| `PARTIALLY_COLLECTED` with a reason, and **office flagged at that moment**|
| Zero collection| Routed to failure. **No completed stop, no handover**|
| Portal down at the door| SMS fallback to the **registered number only**, logged|
| Vendor merely busy| **No fallback.** 10-minute wait, then the ordinary failure flow|
| Declaration 10, physical 9| Closure requires **9** orders. The 10 survives as discrepancy history|
| Damage on a matching count| Recordable. `MATCH` variance, `DAMAGED` condition, senior review|
| An order in `PAYMENT_REQUIRED`| **Counts toward parity.** The intake still closes|
| Two receivers on one intake| One wins; the other sees `STATE_CONFLICT`, not silent overwrite|
| Vendor views the closed intake| Summary only. **No blind count, no declaration, no evidence, no adjudication**|

## 7. Test obligations

Per [engineering-standards.md](../../standards/engineering-standards.md) §3. Two carry unusual weight here:

- **Negative-access tests at all five §37.6 surfaces** — query, export, notification, file, API. The vendor-visibility boundary at §22.9 is the sharpest case: an export that leaks a blind count fails even if the API does not.
- **Invalid transitions**, not only valid ones. A transition table with no negative tests is untested.

## 8. Related

- **Plan:** [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md)
- **Features:** the six at §1
- **Surfaces:** the three at §1
- **Gates:** [definition-of-ready.md](../../standards/definition-of-ready.md) · [definition-of-done.md](../../standards/definition-of-done.md)

## 9. Normative dependencies


> The following paths identify the retained inputs for this slice. Read the portions relevant to the bounded task; these entries do not require historical approval processing.

| Kind| Document| Role|
|---|---|---|
| `standard`| `standards/definition-of-ready.md`| readiness and completion authority|
| `standard`| `standards/definition-of-done.md`| readiness and completion authority|
| `feature`| `features/pickup/pickup-request.md`| implementation input|
| `feature`| `features/pickup/pickup-manifest.md`| implementation input|
| `feature`| `features/pickup/pickup-collection.md`| implementation input|
| `feature`| `features/pickup/pickup-failure.md`| implementation input|
| `feature`| `features/hub/hub-intake.md`| implementation input|
| `feature`| `features/hub/itemization.md`| implementation input|
| `surface`| `surfaces/ops-portal.md`| interaction contract|
| `surface`| `surfaces/vendor-pwa.md`| interaction contract|
| `surface`| `surfaces/rider-android.md`| interaction contract|
| `surface`| `surfaces/recipient-channel.md`| interaction contract — touched only for the ad-hoc handshake SMS|
| `contract`| `contracts/openapi.yaml`| interface and state authority|
| `contract`| `contracts/domain-model.md`| interface and state authority|
| `contract`| `contracts/state-machines.md`| interface and state authority|
| `contract`| `contracts/permissions.md`| interface and state authority|
| `contract`| `contracts/settings.md`| interface and state authority|
| `contract`| `contracts/audit.md`| interface and state authority|
| `contract`| `contracts/errors-and-enums.md`| interface and state authority|
| `slice_predecessor`| `delivery/slices/SLICE-000.md`| real predecessor — build dependency: this slice cannot run against an unauthenticated system. §44 assesses specification rather than buildability, so it is not a readiness criterion|


<!-- NORMATIVE-EXCLUSIONS:BEGIN -->

**Deliberately excluded, and why.** A dependency graph is defined as much by what it refuses as by what it lists:

- `delivery/IMPLEMENTATION_PLAN.md` — sequencing and priority authority, **not an implementation input**. Nothing in it must be true for this slice to be built correctly
- `contracts/data-scope-registry.md` — precondition A says **all seven**, and this slice was assessed on 17 August, before `MSC-DEC-298` made the registry the eighth contract. It is not named anywhere in this slice's current sections
- **SLICE-014 is an integration dependency with no slice document yet.** Resolve the hub fee-configuration path described in the Implementation Plan §4a before demonstrating the priced pickup flow.

<!-- NORMATIVE-EXCLUSIONS:END -->
