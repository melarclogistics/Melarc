# `SLICE-002` — Recipient confirmation and dispatch

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.16 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** the scope, readiness verdict and demonstration script for the dispatch slice
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §24, §20.2, §35.7, §44, §45

## 1. Scope

**From a priced order to a dispatched run.** The `PRE_DISPATCH` recipient-contact checkpoint — made by **the assigned Rider or by Ops on one canonical record**, with the Vendor's assistance where contact fails — the ready pool, run assembly, the dispatch gate and the atomic commit.

| Feature| Criteria|
|---|---|
| [recipient-confirmation](../../features/dispatch/recipient-confirmation.md)| 6|
| [delivery-run-build](../../features/dispatch/delivery-run-build.md)| 6|
| [atomic-dispatch](../../features/dispatch/atomic-dispatch.md)| 8|
| **Total**| **20**|

**Surfaces:** [Ops Portal](../../surfaces/ops-portal.md) throughout; [Rider Android](../../surfaces/rider-android.md) for the rider's own `PRE_DISPATCH` calls on assigned parcels (family L), the dispatch notification and run start; the [recipient channel](../../surfaces/recipient-channel.md) for the confirmation call; and the [Vendor PWA](../../surfaces/vendor-pwa.md) **for the recipient-contact exception** — a Vendor sees why their parcel is held, with the recipient's name, and may supply a corrected or alternative contact, **which Ops applies**. A run itself spans vendors and is never vendor-visible.

**Out of scope:** everything past the rider starting the run. §24.8 draws the line: *"for doorstep work, dispatch does not equal delivery."* The `NEXT_STOP` and `DOORSTEP` checkpoints, OTP, payment at the door and proof belong to `SLICE-003`.

## 2. Where this sits

`SLICE-001` ends with a priced order at a hub. `SLICE-002` gets it onto a rider's run. `SLICE-003` delivers it.

**The slice has one hard dependency on `SLICE-001` and one on `SLICE-000`:** an order must be priced and payment-gated before it can enter the ready pool, and nothing runs unauthenticated.

## 3. Definition of Ready — **current, re-run 4 September 2026 at Gate C C1-10**

Apply [definition-of-ready.md](../../standards/definition-of-ready.md) to the bounded task. Scope, contracts, demonstrations and dependencies are retained below. Resolve an actual product or technical gap before implementing the affected path. Historical approval labels and previous readiness assessments are not additional workflow requirements.

## 4. Verdict

Specification scope is retained; implementation and verification remain to be performed. Do not infer a passing build, integration or release from this document. Report readiness and results for the specific task being executed.

## 5. What bears on this slice without blocking readiness

| Question| Effect|
|---|---|
| ~~`OQ-051`~~| **Closed for this slice, and the figure it once set is retired.** `delivery_confirmation_max_attempts` was set at **3** by `MSC-DEC-237` and retired by `MSC-DEC-351` — **no call ceiling exists**, and the key must not be repurposed as a throttle|
| `OQ-048`| Telephony and notification provider. Blocks launch|
| `OQ-030`| The complete page inventory this slice's surfaces still owe, which is why the slice has no visual design (§4, *What `READY` would still not mean here*)|

## 6. Demonstration script

§45.1 requires the Product Owner to **demonstrate the normal and material exception paths**.

**Normal path**

1. A priced, payment-cleared doorstep order enters the confirmation queue at itemization close.
2. **The assigned rider, working their own assigned-parcel queue, calls; no answer.** The attempt is a `RecipientContactAttempt` row — `checkpoint = PRE_DISPATCH`, actor type `RIDER` — **not a counter increment.** The parcel is `HOLD_AT_HUB`, and **the Vendor is notified with the recipient's name and order reference.**
3. **The Vendor submits a corrected number; Ops applies it.** Ops calls on the corrected number; the recipient confirms and gives a landmark. **The refined-location note is captured**, and the rider's queue now shows *confirmed by Ops* — **the rider does not call again.**
4. The order is `CLEARED_FOR_DISPATCH` and joins the doorstep ready pool.
5. Ops opens a draft run and adds it, **alongside a `STATION_DROP` stop and an informal-carrier stop.** All three are accepted on one run.
6. Ops orders the stops manually and assigns an active rider. **The run stays `DRAFT` and the rider sees nothing of it.**
7. Ops dispatches. Everything revalidates and commits together. **One run-level notification reaches the rider.**
8. The rider starts the run. **The rider — not Ops.**
9. The rider opens the first stop and sees the landmark note from step 3.

**Exception paths, each of which must be demonstrated**

| Path| What must be seen|
|---|---|
| Fully vendor-paid doorstep order, no call made| **Not run-eligible.** Regardless of payer|
| Outcome recorded as `unreachable`| Order held. **Not an error, not terminal**|
| Fourth, fifth call on a corrected number| **Accepted and recorded.** No force-extension, no approval, no ceiling|
| No new avenue after Vendor help| **Ops escalates by judgement** with a reason — `escalateRecipientConfirmation`. `escalated_at` set, senior queue, **held, not lost**. No count did it, and **a rider holding the shared key is refused**|
| Recipient asks to move the date or the address on the call| The rider records the request; **Ops decides** — a `CUSTOMER`-attributed commitment revision, the original destination preserved|
| A held parcel is loaded anyway| **Refused, `DISPATCH_NOT_CLEARED`**. Assigned to a run is not permitted to leave the hub|
| A recipient-pays order with a zero vendor portion| **Dispatches.** `NO_VENDOR_CHARGE` satisfies the commercial gate|
| Address corrected within the same service area| Corrected, **no repricing workflow fires**|
| Address corrected into a different service area| Controlled repricing; **both price versions preserved**|
| Stop added after its confirmation lapsed| **Refused on re-check.** Earlier eligibility does not carry|
| Same order added to a second run| Refused. One parcel, one path|
| **One order's credit gate closed at dispatch**| **The whole run rolls back.** Twenty stops untouched, run stays `DRAFT`, nothing silently dropped|
| That rollback| `dispatch.run.rollback` emitted. **Ops can tell an attempted dispatch from an unattempted one**|
| `STATION_DROP` with ample vendor credit but unpaid fee| Refused. **Credit does not satisfy the outbound gate**|
| Ops attempts to start the run| Refused. Only the rider starts|
| Dispatch commits, rider notification fails| **Dispatch stands.** Surfaced for retry, custody not reversed|
| Rider works stop three before stop one| Accepted. **The sequence is a plan**|

**The rollback row is the demonstration that matters.** Every other row can be reasoned to from the specification. That one requires seeing nineteen good parcels *not* dispatch because of one bad one — which is the behaviour every instinct argues against, and the one §35.7.5 depends on.

## 7. Readiness path — **one item: approval of its inputs**

Check the predecessor capability, the feature criteria and the contract paths exercised by the demonstration. Resolve real missing product inputs or integrations before the affected implementation or production use. Use the current readiness checklist; document-signing history is not a prerequisite.

## 8. Related

- **Features:** [recipient-confirmation](../../features/dispatch/recipient-confirmation.md) · [delivery-run-build](../../features/dispatch/delivery-run-build.md) · [atomic-dispatch](../../features/dispatch/atomic-dispatch.md)
- **Depends on:** [SLICE-001](SLICE-001.md) for a priced order · [SLICE-000](SLICE-000.md) for authentication
- **Gates:** [definition-of-ready.md](../../standards/definition-of-ready.md) · [definition-of-done.md](../../standards/definition-of-done.md)

## 9. Normative dependencies


> The following paths identify the retained inputs for this slice. Read the portions relevant to the bounded task; these entries do not require historical approval processing.

| Kind| Document| Role|
|---|---|---|
| `standard`| `standards/definition-of-ready.md`| readiness and completion authority|
| `standard`| `standards/definition-of-done.md`| readiness and completion authority|
| `feature`| `features/dispatch/recipient-confirmation.md`| implementation input|
| `feature`| `features/dispatch/delivery-run-build.md`| implementation input|
| `feature`| `features/dispatch/atomic-dispatch.md`| implementation input|
| `surface`| `surfaces/ops-portal.md`| interaction contract|
| `surface`| `surfaces/rider-android.md`| interaction contract|
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
| `slice_predecessor`| `delivery/slices/SLICE-001.md`| real predecessor — for a priced order|
| `slice_predecessor`| `delivery/slices/SLICE-000.md`| real predecessor — for authentication|

