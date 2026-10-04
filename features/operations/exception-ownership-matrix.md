# Exception ownership matrix

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.4 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** who owns each operational exception, which permission authorises the response, where it escalates, and what the customer is told
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §11.4, §11.6, §37.4, and `MSC-DEC-301`–`MSC-DEC-339`
> **Slice:** cross-slice

## 1. What this is, and why

**Nothing here is new authority.** The permission catalogue owns who may do what; this document answers a different question — *when this goes wrong at 14:30, who picks it up, and what may they actually do?*

**It is a composition, not a copy.** Every `Key` cell is a pointer into [permissions.md](../../contracts/permissions.md) §7. Where this document and the catalogue disagree, **the catalogue wins and this document is the defect.**

## 2. How to read it

- **First owner** — the role that picks the exception up. Not necessarily the role that resolves it.
- **Key** — the permission that authorises the response. **Scope is on the grant, not the key**.
- **Escalation** — where it goes if the first owner cannot resolve it.
- **Notify** — whether the customer or vendor is told as part of the response.

## 3. The matrix

| Exception| First owner| Key| Permitted action| Escalation| Notify| Audit|
|---|---|---|---|---|---|---|
| **Late booking**| Ops Staff| `pickup.request.create` + review| Accept into review, or refuse| Senior Ops| Vendor| `pickup.request.created`|
| **Service-window override**| Ops Staff| `pickup.request.override_window`| Schedule outside the customer window with a mandatory reason| Senior Ops| **Yes — notification state recorded**| `pickup.service_window.overridden` **enhanced**|
| **Pickup failure**| Ops Staff| `pickup.failure.report` → `pickup.failure.resolve`| Report, then disposition against §21.5's four categories| Senior Ops via `pickup.attempt.extend`| Vendor| `pickup.stop.failed`|
| **Intake mismatch**| Ops Staff| `hub.osd.adjudicate`| Adjudicate OS&D| Senior Ops| Vendor| `hub.osd.resolved` **enhanced**|
| **Price correction**| Senior Ops| `pricing.correction.approve`| Correct with reason| Platform Admin| Vendor| `pricing.correction.approved` **enhanced**|
| **Recipient confirmation problem**| Ops Staff| `dispatch.recipient_confirmation.work`| Work the ladder; force-extend or start return| Senior queue| Recipient| `dispatch.confirmation.*`|
| **Ordinary delivery failure**| Rider records → **Ops owns**| `delivery.stop.close` → Ops review| Rider records the reason **and stops there**| Senior Ops| Recipient, vendor| `delivery.stop.failed`|
| **Rider breakdown**| Ops Staff| `fleet.custody.initiate`| Open a custody handover; **the attempt is not consumed**| Senior Ops| Recipient| `fleet.custody.*`|
| **OTP fallback**| Rider requests → **Senior Ops decides**| request: `delivery.stop.execute` · grant: **`delivery.otp.override`**| Ops verifies by approved alternative, then authorises handover| Senior Ops **is** the authority| Recipient| `delivery.verification.fallback_requested`, `delivery.otp.overridden` **enhanced**|
| **Payment-provider fallback**| Rider reports → Ops resolves| `payment.cash.collect` (cash) · `payment.momo.confirm_manual` (MoMo)| Merchant MoMo, cash where the hub capability is enabled, or Ops-assisted resolution| Senior Ops| Recipient| `payment.fallback.used`|
| **Manual Merchant MoMo verification**| **Senior Ops or Finance**| `payment.momo.confirm_manual`| Confirm receipt out of band. **A rider may never self-confirm**| Finance| —| `payment.momo.manually_confirmed` **enhanced**|
| **Cash handover**| **Hub cash receiver**| `payment.cash.confirm`| Accept the rider's handover against the **system-calculated** expected total| Senior Ops| —| `payment.cash.received`|
| **Cash variance**| Senior Ops| `payment.variance.resolve`| Disposition with a mandatory reason. **The expected total is never edited**| Finance| —| `payment.cash.variance_opened` / `_resolved` **enhanced**|
| **Hub cash variance**| Senior Ops or Finance| `payment.cash.reconcile_hub` → `payment.variance.resolve`| Count, then disposition. **Distinct from rider variance**| Finance| —| `payment.cash.hub_variance_opened` **enhanced**|
| **Final cash disposition**| Senior Ops or Finance| `payment.cash.disposition`| Record amount, method, destination, reference, evidence| Finance| —| `payment.cash.disposition_recorded` **enhanced**|
| **Road expense**| Rider records → **Senior Ops decides**| record: `payment.road_expense.record` · decide: `payment.road_expense.approve`| Approve or reject. **Only approval reduces the rider's expected cash**| Senior Ops **is** the authority| —| `payment.road_expense.created` / `.decided` **enhanced**|
| **Ultimate delivery failure**| Ops Staff| `delivery.stop.close`| Record the third failure. **This does not start the return**| Senior Ops| Recipient, vendor| `delivery.stop.failed`|
| **Return initiation**| Senior Ops| `returns.*`| Review, then commit the `ReturnRecord`| Platform Admin| Vendor| `returns.*`|
| **Return Fee waiver**| Ops requests → **Senior Ops approves**| `returns.waiver.request` → `returns.waiver.approve`| Waive against a seeded category; **free text supplements, never replaces**| Platform Admin| Vendor| **owed** — no return-fee waiver event exists in `audit.md`; `SLICE-006` owes one, enhanced on `pickup.cancellation_charge.waived`'s precedent|
| **Single-package approval**| Ops requests → **Senior Ops approves**| `pickup.exception.request` → **`pickup.exception.approve`**| Approve the exception. **The fee becomes due on acceptance**| Platform Admin| Vendor| `pickup.request.single_package_approved` **enhanced**|
| **Reason-catalogue administration**| Senior Ops| `settings.reason.manage`| Create, edit, activate, deactivate and configure behaviour| Platform Admin| —| `settings.reason.catalog_changed` **enhanced**|
| **Hub-local sender block**| Senior Ops| `vendor.sender_block.create`| `HUB_LOCAL`, own authorised hub only| Platform Admin| —| `vendor.sender_block.created`|
| **Platform-wide sender block**| **Platform Admin**| `vendor.sender_block.create`| `PLATFORM_WIDE`, all hubs, **enhanced audit**| —| —| `vendor.sender_block.created` **enhanced**|

**Recipient-contact events** *(Gate C C1.2, `MSC-DEC-346`–`MSC-DEC-349`)*. **Authority is a permission, never a role name.**

| Event| Primary owner| Key|
|---|---|---|
| `PRE_DISPATCH` routine confirmation| **Assigned Rider or Ops** — either, same record| `dispatch.recipient_confirmation.work`|
| Wrong recipient number| **Ops**, with Vendor assistance as an input. **The Vendor notification carries the recipient name and order reference** — a Vendor cannot act on *a delivery failed*| `dispatch.recipient_confirmation.work` · `vendor.contact_assistance.submit`|
| Recipient unavailable| **Ops**| `dispatch.recipient_confirmation.work`|
| Reschedule request| **Ops** — the rider records it| `delivery.commitment.revise`|
| Location change request| **Ops** — the rider records it| `dispatch.recipient_confirmation.work`|
| `NEXT_STOP` routine contact| **Rider**| `delivery.stop.execute`|
| `NEXT_STOP` recovery or reinsert| **Ops**| `dispatch.run.sequence`|
| `DOORSTEP` routine contact| **Rider**| `delivery.stop.execute`|
| Doorstep wait| **Rider acts, Ops watches the same clock**| `delivery.stop.execute` · `dispatch.read`|
| OTP fallback| **Authorised Ops** — the rider requests and never grants| `delivery.otp.override`|
| Failed physical delivery| **Rider records, Ops owns the disposition**| `delivery.stop.close`|
| Redelivery scheduling| **Ops**| `dispatch.run.create`|

**Four things a rider cannot do, and each has cost someone money somewhere:** grant their own OTP fallback, change a delivery date, change a destination, or begin a formal Return.

## 4. The three cash authorities, stated explicitly

Gate C §52 asked for these by name, and **all three already existed**:

| Authority| Key| Why it is not the rider|
|---|---|---|
| **Rider cash handover receiver**| `payment.cash.confirm`| A S P, own hub. Already **never held by a rider**: one actor supplying both compared figures is not a comparison|
| **Hub cash reconciliation**| `payment.cash.reconcile_hub`| **New at Gate C.** `payment.cash.confirm` accepts *one rider's* handover; this closes the *hub's* position|
| **Cash variance resolution**| `payment.variance.resolve`| S P with a mandatory reason. **A rider may never resolve their own shortage**, and ordinary Ops Staff may not close a financial discrepancy|

## 5. What this matrix does not answer

**Single-package fee settlement timing for account and allowance Vendors.** `MSC-DEC-334` fixes that the fee becomes **due on acceptance**. Whether a registered Vendor on an active allowance settles it immediately, on statement, or under the existing prepayment gate **cannot be derived** from the approved sources — §35.12.3 governs the allowance and §5.2 governs payer allocation, and neither addresses an exception fee raised at booking against an account.

**This is recorded rather than guessed.** See the open question raised by Gate C.

## 6. Template sections, and where each one went

This is a cross-feature authority map, not a separate workflow. Its rows point to the acts, permission checks and audit requirements defined in the owning features and contracts. Test each exception through its owning feature; do not invent independent business behavior solely to fill a template section. A missing operation, error path or criterion remains an implementation dependency of that owning feature.

## 7. Related

- [permissions.md](../../contracts/permissions.md) §7 — the catalogue that owns every key above
- [hub-daily-operating-cycle.md](hub-daily-operating-cycle.md) — the cycle that surfaces these exceptions
- [audit.md](../../contracts/audit.md) §6 — the enhanced-audit categories
