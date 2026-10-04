# `SLICE-003` — Doorstep delivery and OTP

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.44 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** the sequence, dependencies and readiness verdict for the doorstep thread
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §25, §19.6, §26.2–26.3, §44, §45
> **Verdict:** **`NOT_READY`**

## 1. Scope

The rider is at the door. This slice covers arrival, payment where due, OTP validation, the successful handover, the failed attempt, and the cash that comes home either way.

**Surfaces:** [Rider Android](../../surfaces/rider-android.md) throughout — this is the first slice whose **primary** surface is the rider app. [Ops Portal](../../surfaces/ops-portal.md) for the reattempt queue and cash confirmation. The [recipient channel](../../surfaces/recipient-channel.md) carries the OTP. The [Vendor PWA](../../surfaces/vendor-pwa.md) shows outcomes only.

**Out of scope:** the **formal Ops-controlled Return** after a failed delivery where that disposition is chosen (`SLICE-006`, `MSC-DEC-332`) — never triggered by a count — and the **implementation of the live Hubtel adapter** against the real merchant contract. Hub cash reconciliation is **in** scope as specified since C1.1: `recordHubCashCount`, `resolveHubCashVariance` and `recordCashDisposition` are in the dependency set below.

## 2. Where this sits

`SLICE-002` ends with a rider starting a run. `SLICE-003` is what happens at each stop. §24.8 draws the line the other way round: *"for doorstep work, dispatch does not equal delivery."*

**Two hard dependencies:** `SLICE-002` for a dispatched run, and `SLICE-001` for a priced order — the recipient portion must be frozen before anyone can collect it.

## 3. Definition of Ready — *current, re-derived 4 September 2026 at Gate C C1.9*

Apply [definition-of-ready.md](../../standards/definition-of-ready.md) to the bounded task. Scope, contracts, demonstrations and dependencies are retained below. Resolve an actual product or technical gap before implementing the affected path. Historical approval labels and previous readiness assessments are not additional workflow requirements.

## 4. Verdict — *current, re-derived 4 September 2026 at Gate C C1-10*

Specification scope is retained; implementation and verification remain to be performed. Do not infer a passing build, integration or release from this document. Report readiness and results for the specific task being executed.

## 5. What bears on this slice without blocking readiness

| Question| Effect|
|---|---|
| ~~`OQ-092`~~| **Closed 26 August by `MSC-DEC-254`** — the hub's count is not blind.|
| `OQ-048`| The SMS provider contract alone — the OTP parameters are set. Blocks launch, not readiness.|
| `OQ-109`| The live Hubtel merchant contract. Blocks the provider adapter — blocker 2 in §4 — and nothing about the Product architecture|
| `OQ-030`| Visual design, as for every slice|

## 6. Demonstration script

§45.1 requires the Product Owner to demonstrate the normal and material exception paths.

**Normal path**

1. A dispatched run is started by its rider. The first stop shows the landmark note captured at confirmation.
2. The rider marks arrival.
3. The order is a redelivery carrying **GH₵55 due — GH₵35 + GH₵20, one `OperationalPaymentDemand`, one prompt.** The recipient approves a Hubtel prompt for **GH₵50** on their own handset; the provider confirms. **A GH₵50 receipt exists, no fee line settles, GH₵5 remains due, and the OTP is refused.** The rider takes **GH₵5 in cash**: a GH₵5 receipt, GH₵5 of custody, and **the demand settles atomically on GH₵55** — GH₵35 and GH₵20, provenance across both receipts.
4. **The rider requests the OTP. It goes to the number on record** — not to the person at the door, if those differ.
5. The recipient reads out the OTP; the rider submits it; the backend validates.
6. The stop closes `DELIVERED`. **The audit event records that an OTP validated and never what it was.**
7. At the hub, the rider opens a `CashHandover` declaring GH₵300.
8. **A hub actor — not the rider — records the hub's confirmed total.** Equal: every custody record reconciles.

**Exception paths, each of which must be demonstrated**

| Path| What must be seen|
|---|---|
| Recipient refuses| **Attempt consumed**, Ops decision queue. **Not terminal**, and no return fee earned yet|
| A reason outside the five seeded defaults| **Accepted where active in the catalogue**; an inactive or wrong-checkpoint code is refused.|
| Senior Ops authorises handover without OTP| Stop `DELIVERED`, `delivery.otp.overridden` **enhanced-audited**. **Payment still settled first**|
| Amount due, OTP requested first| **Refused.** No OTP generated, none sent|
| Fully vendor-paid parcel| **OTP still required.** Payment is skipped; proof is not|
| Rider supplies a different destination number| **The schema has no field for it.** Structural, not validated|
| OTP fails after cash was taken| Stop `FAILED`, `payment_taken` true, **cash still tracked, no refund at the door**|
| Failed stop's parcel not returned at run end| Handover refused, `CUSTODY_NOT_RETURNED`. **No overnight custody**|
| A further trip after a failed physical attempt| **Ops schedules a `Redelivery`** — no ceiling, no automatic Return.|
| Redelivery scheduled for a chargeable recipient-side failure| **GH₵35 + GH₵20 snapshotted, payer recipient**; a Melarc-caused failure bills nobody.|
| Short tender — GH₵50 against GH₵55| **Recorded**: a GH₵50 `CASH` receipt, GH₵50 of custody, **no line settled**, GH₵5 due, handover blocked, the next collection for GH₵5.|
| Hubtel `STATUS_UNKNOWN` on the GH₵55 prompt| **No retry button.** Cash is refused without the Ops duplicate-risk grant and accepted with it, the grant consumed once; a late Hubtel success raises a `FinancialAdjustmentRequired` and settles nothing twice|
| Over-tender| **Accepted**, reconciled as a variance|
| Rider tries to confirm their own handover| Refused|
| Hub confirms a different total| `VARIANCE_OPEN`, **run financially held**, Ops cannot resolve it|
| A `RunCustodyHandover` moves the parcels| **The cash does not move.** The original rider still owes it|
| Ops attempts to close a stop as delivered| Refused. **Ops cannot close a stop**; hub Senior Ops may only **authorise** the OTP fallback the rider requested, and the rider executes|

**The Ops-cannot-close row is the one to watch during the demonstration.** The instinct to add an Ops close — for the rider with no signal, the recipient with a dead phone — is exactly what `MSC-DEC-326` answered deliberately: the rider **requests**, hub Senior Ops **authorises**, the rider executes, and the demand is `SETTLED` first.

**And the cash-survives-handover row is the one nobody would think to test.** `MSC-DEC-246` moves parcels between riders; `MSC-DEC-250` leaves the money with the person. Two decisions a day apart, and the interaction between them appears in neither.

## 7. Readiness path — **one item: approval of its inputs**

Check the predecessor capability, the feature criteria and the contract paths exercised by the demonstration. Resolve real missing product inputs or integrations before the affected implementation or production use. Use the current readiness checklist; document-signing history is not a prerequisite.

## 8. Related

- **Features:** [doorstep-delivery](../../features/delivery/doorstep-delivery.md) · [delivery-failure](../../features/delivery/delivery-failure.md) · [cash-collection](../../features/delivery/cash-collection.md)
- **Depends on:** [SLICE-002](SLICE-002.md) for a started run · [SLICE-001](SLICE-001.md) for a priced order
- **Feeds:** `SLICE-004` cash reconciliation · `SLICE-006` return-to-vendor
- **Gates:** [definition-of-ready.md](../../standards/definition-of-ready.md) · [definition-of-done.md](../../standards/definition-of-done.md)

## 9. Normative dependencies


> The following paths identify the retained inputs for this slice. Read the portions relevant to the bounded task; these entries do not require historical approval processing.

| Kind| Document| Role|
|---|---|---|
| `standard`| `standards/definition-of-ready.md`| readiness and completion authority|
| `standard`| `standards/definition-of-done.md`| readiness and completion authority|
| `feature`| `features/delivery/doorstep-delivery.md`| implementation input|
| `feature`| `features/delivery/delivery-failure.md`| implementation input|
| `feature`| `features/delivery/cash-collection.md`| implementation input|
| `surface`| `surfaces/rider-android.md`| interaction contract|
| `surface`| `surfaces/ops-portal.md`| interaction contract|
| `surface`| `surfaces/recipient-channel.md`| interaction contract|
| `surface`| `surfaces/vendor-pwa.md`| interaction contract|
| `contract`| `contracts/openapi.yaml`| interface and state authority|
| `contract`| `contracts/domain-model.md`| interface and state authority|
| `contract`| `contracts/state-machines.md`| interface and state authority|
| `contract`| `contracts/permissions.md`| interface and state authority|
| `contract`| `contracts/settings.md`| interface and state authority|
| `contract`| `contracts/audit.md`| interface and state authority|
| `contract`| `contracts/errors-and-enums.md`| interface and state authority|
| `contract`| `contracts/data-scope-registry.md`| interface and state authority|
| `slice_predecessor`| `delivery/slices/SLICE-002.md`| real predecessor — for a started run|
| `slice_predecessor`| `delivery/slices/SLICE-001.md`| real predecessor — for a priced order|


<!-- NORMATIVE-EXCLUSIONS:BEGIN -->

**Deliberately excluded, and why.** A dependency graph is defined as much by what it refuses as by what it lists:

- `SLICE-004`, `SLICE-006` — this slice **feeds** them. They come after and depend on it, not the reverse

<!-- NORMATIVE-EXCLUSIONS:END -->
