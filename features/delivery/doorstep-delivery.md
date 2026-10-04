# Doorstep delivery

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.10 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** the successful doorstep outcome — the payment-then-verification sequence, what the OTP proves and its one Ops-authorised exception, and what Version 1 deliberately does not capture
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §25.1, §25.2, §19.6, §20.4, §36.9, and cross-cutting §35.8, §16, §40
> **Slice:** `SLICE-003`

## 1. What this is, and why

A rider stands at a door with a parcel. This feature is the successful outcome and nothing else: the amount due is settled, the OTP validates, custody passes to the recipient, and the order reaches its terminal delivered state.

**A valid recipient OTP is the ordinary proof of delivery**, and §25.1 is unusually direct about it: *"Possession and successful validation of the OTP is the Product Owner-approved authorization and proof."* There is no signature, no photograph, no receiver name — a decision, not an omission, and §5.5 below records it as one so nobody adds them back as an obvious improvement. **One exception exists and it is not the rider's**: where the recipient is present and verification genuinely cannot complete, the rider requests an Ops-assisted fallback and hub Senior Ops authorises the handover (`MSC-DEC-326`, `MSC-DEC-252`, §5.4).

**Version 1 boundary.** Failure at the door is [delivery-failure](delivery-failure.md). Collecting and holding the money is [cash-collection](cash-collection.md). Getting the rider to the door is `SLICE-002`.

## 2. Governing sections

| Section| What it governs here|
|---|---|
| §25.1| The five conditions of a successful delivery, and what the OTP proves|
| §25.2| Payment **before** handover; idempotency linked to the same parcel and stop|
| §19.6| The rider surface at the door|
| §20.4| OTP as a recipient-channel mechanism — never logged, never displayed to the rider|
| §36.9| The `DeliveryStop` and order fulfilment transitions|
| §35.8| Cross-cutting delivery rules|
| §26.2| The approved collection channels the payment condition may be satisfied through|
| **§25.6**| **Surface responsibilities for delivery** — what Rider, Ops and Vendor each do. Added 26 August: this feature's §3 was written against §19.6 alone, and §25.6 is the section that actually apportions delivery work across the three surfaces|


## 3. Surfaces and actors

| Surface| Actor| Can do| Gated by|
|---|---|---|---|
| Melarc Rider| Rider| Mark arrival; make the `DOORSTEP` contact; read the stop's payment demand; **Receive Money** through the shared engine; record cash actually taken; request the OTP; submit the OTP; request the verification fallback; close the stop as delivered| `delivery.stop.execute`, `payment.collection.read`, `payment.momo.collect`, `payment.cash.collect`, `delivery.stop.close` — assigned stop only|
| Recipient channel| Recipient| Approve the provider prompt **on their own handset**; receive the OTP by SMS on the **recorded** number| —|
| Melarc Ops| Ops Staff| Initiate Receive Money on the **same engine** within hub scope; read the stop's payment position. **Cannot close a stop as delivered**| `payment.momo.collect`, `payment.collection.read`, `delivery.read`|
| Melarc Ops| Senior Ops| **Authorise a handover without OTP** on the rider's request; **authorise a duplicate-risk payment fallback** while a provider attempt is unresolved; confirm a Merchant MoMo receipt out of band| `delivery.otp.override`, `payment.momo.confirm_manual` — **never a rider**|
| Melarc Vendor| Vendor| **Authorized tracking, payer allocation, attempt history and account effects** on its own order — **never security secrets** (§25.6)| `delivery.read`, own record|

**§25.6 gives the vendor more than an outcome, and this feature said less until 26 August.** It requires *"authorized tracking, payer allocation, attempt history, return state, return-fee/account effects, and relevant notifications **without exposing security secrets**"* — a read surface with a named exclusion, not a status field. The exclusion is the operative half: the OTP is a security secret and no vendor view may carry it.

**Ops cannot close a stop as delivered, and that is deliberate.** `closeDeliveryStopDelivered` is rider-only: §25.1 says *"the rider cannot ordinarily override invalid or missing OTP"*, and an Ops actor closing a stop would be that override wearing a different actor. What Ops holds is the **exception authority** — hub Senior Ops authorises a handover without OTP when the rider requests it (`MSC-DEC-326`, §5.4), authorised Ops grants the duplicate-risk payment fallback, and Ops may initiate Receive Money on the same engine. **The rider asks; Ops decides; the rider executes.**

## 4. Preconditions

- The stop is `ARRIVED` and belongs to the executing rider (§25.1 condition 1).
- The run is `IN_PROGRESS`.
- The recipient obligation is known and frozen — `SLICE-001` itemization for a first delivery, the scheduled `Redelivery` snapshot for a redelivery trip — and, where money is due, its **`OperationalPaymentDemand`** is read through `getStopPaymentDemand`, which materialises it.
- The recipient phone number of record exists and is verified.

## 5. Behaviour

### 5.1 Normal path

1. **The rider marks arrival.** `PENDING → ARRIVED`.
2. **If an amount is due, the recipient pays against the stop's `OperationalPaymentDemand`** — through the shared Receive Money engine (Hubtel, `MSC-DEC-352`), the Merchant MoMo fallback confirmed by Ops, or cash where the hub enables it (§26.2). **Every method writes a `PaymentReceipt` for what actually arrived and hands it to one atomic settlement engine**: the demand is `SETTLED` only when cumulative confirmed principal reaches its frozen total. A short payment is preserved and the next collection asks for the remainder; cash additionally creates rider custody at the amount taken. See [cash-collection](cash-collection.md).
3. **Only once the demand is `SETTLED` is the OTP requested and sent to the recorded recipient number.** Not to the person standing there, if those differ.
4. **The rider submits the OTP the recipient gives them.**
5. **The backend validates it against the parcel and the recorded recipient contact** (§25.1 condition 4).
6. **The stop closes `DELIVERED`**, the order reaches its delivered terminal state, and the audit and payment effects are created exactly once (§25.1 condition 5).

### 5.2 The ordering is a rule, not a convention

§25.2: *"Recipient payment, when due, must be recorded **before** physical parcel handover."* §36.9 lists the same two conditions in the same order.

**An implementation that validates the OTP first and then asks for money has reordered an approved sequence**, and it produces the worse failure of the two: a recipient who has proved their identity, watched the parcel come out of the box, and then cannot pay. The rider is now holding a parcel the recipient believes is theirs.

**The reverse order fails harmlessly.** A recipient who cannot pay never sees the OTP step; the stop fails with the parcel still in the rider's custody, which is exactly where §25.4 wants it.

### 5.3 Exception paths

| Condition| Behaviour| Code|
|---|---|---|
| Demand not `SETTLED` — nothing received, **or only part**| Refused. The stop stays `ARRIVED`; a GH₵50 receipt against GH₵55 is real money and **does not open the door**| `RECIPIENT_PAYMENT_OUTSTANDING`|
| Less than the full amount paid, by any method| **Preserved as a `PaymentReceipt` at the amount received; no demand line settles; the remainder stays due** and the next collection asks for exactly that.| `PAYMENT_AMOUNT_MISMATCH` — a settlement outcome, never a refusal of the money|
| Provider attempt unresolved — `CREATED`, `PENDING` or `STATUS_UNKNOWN`| **No retry and no ordinary fallback**. The **backend**, not the rider, is authoritative (§26.4); authorised Ops may grant a duplicate-risk fallback the rider then quotes| `PAYMENT_STATUS_UNKNOWN`, `PAYMENT_ALREADY_PENDING`, `FALLBACK_REQUIRES_AUTHORIZATION`|
| OTP wrong, expired, or absent| Refused. **Money already taken is held, not refunded**. Where the recipient is present, the rider **requests** the Ops fallback (§5.4)| `OTP_INVALID`|
| Stop not assigned to this rider| Refused| `NOT_ASSIGNED_RIDER`|
| Run not started| Refused| `MANIFEST_NOT_STARTED`|
| Duplicate submission of the same valid OTP| **Returns the original result.** §25.2 requires idempotency linked to the same parcel and stop| —|

**The `OTP_INVALID` row is where the money is, and it is why [cash-collection](cash-collection.md) exists.** Payment succeeds, OTP fails, the stop fails carrying cash. `DeliveryStop.payment_taken` records it and `RiderCashCustody` carries it home.

### 5.4 The one extraordinary path, and why it is Senior Ops

§25.1 says the rider *"cannot **ordinarily** override invalid or missing OTP."* `MSC-DEC-252` describes the extraordinary case the adverb implies: **hub Senior Ops may authorise a handover without OTP verification**, with a mandatory reason and an enhanced audit event.

**It inherits `MSC-DEC-198`'s ladder rather than inventing a mechanism.** Pickup already has this exact shape — Ops authorises a handshake when portal and SMS both fail, recorded as an exception. One product, one fallback pattern.

**Senior Ops, not Platform Admin.** The fact needing verification — that this recipient is who they say and the handset genuinely failed — is **local knowledge**. Routing it upward produces approval without inspection.

**The demand is still `SETTLED` first.** The override relaxes proof of *identity*, never the payment gate (§25.2, `MSC-DEC-362`) — `RECIPIENT_PAYMENT_OUTSTANDING` applies to the override exactly as to the ordinary close.

**The control is frequency.** `delivery.otp.overridden` sits beside the handshake fallback ratio: an override used routinely is a fraud control that has stopped existing, and only the rate will say so.

### 5.5 What this feature must never do

- **Never display, log, or audit the OTP value** (§20.4). The audit records that an OTP was validated, never what it was — the same rule the collection handshake carries.
- **Never send the OTP to a number other than the one on record** (§25.1). If someone else is receiving the parcel, *the recorded recipient forwards it*. A rider-supplied destination number would make the OTP prove nothing.
- **Never require a name, relationship, signature, or photograph.** §25.1 rules all four out for Version 1. Adding one is not a small improvement — it is a second authorization model competing with the approved one.
- **Never let the *rider* override a failed OTP.** §25.1, and `MSC-DEC-252` places the extraordinary path with **hub Senior Ops** — a different actor, authorising deliberately, on the record. The rider never self-authorises.
- **Never skip the OTP because the parcel is fully vendor-paid.** §25.1 is explicit: such parcels *"skip recipient payment collection but never skip OTP verification."* The OTP proves **who received it**, which has nothing to do with who paid.
- **Never mark delivered before the demand is `SETTLED`** (§25.2, `MSC-DEC-362`) — not on an attempt succeeding, not on a receipt existing, not on cash in a pannier, not on a Merchant MoMo screenshot.
- **Never let a rider or an Ops screen declare a payment received.** Provider truth is verified server-to-server; Merchant MoMo is confirmed by a Senior Ops or Finance actor who is not the rider.
- **Never refuse or discard a short payment.** It is money received that settles nothing yet.

## 6. Entities — *pointer*

[domain-model.md](../../contracts/domain-model.md) §6.10 `DeliveryStop`, §6.7 `Order`, §6.11 `RiderCashCustody`.

## 7. States — *pointer*

| Field| Home| Transitions this feature drives|
|---|---|---|
| `DeliveryStop.state`| [state-machines.md](../../contracts/state-machines.md) §12.1| `PENDING → ARRIVED`, `ARRIVED → DELIVERED`|
| `Order.fulfilment_state`| [state-machines.md](../../contracts/state-machines.md) §9| `→ DELIVERED`|
| `RiderCashCustody.state`| [state-machines.md](../../contracts/state-machines.md) §16.3| `EXPECTED → COLLECTED_BY_RIDER`, where cash is taken|
| `OperationalPaymentDemand.status`| [domain-model.md](../../contracts/domain-model.md) §6.12| `OPEN → PARTIALLY_SETTLED → SETTLED` — derived, never set|
| `PaymentAttempt.state`| [state-machines.md](../../contracts/state-machines.md) §20.6| `→ CREATED → PENDING → SUCCEEDED` on the shared engine|

## 8. Permissions — *pointer*

[permissions.md](../../contracts/permissions.md) §7. `delivery.stop.execute` and `delivery.stop.close` — **rider, assigned stop only**; `payment.collection.read` and `payment.momo.collect` — the rider on the assigned stop, Ops in hub scope, **one engine**; `payment.cash.collect` where cash is due; `delivery.otp.override` and `payment.momo.confirm_manual` — **S P, never a rider**.

## 9. Settings — *pointer*

[settings.md](../../contracts/settings.md). `doorstep_wait_minutes` (10) times the wait after a failed doorstep contact; `recipient_cash_enabled` and `merchant_momo_fallback_enabled` are per-hub capabilities that decide which fallbacks the door may offer. OTP length, TTL and attempt limits **now have keys and still have no values** — `handover_otp_length`, `handover_otp_ttl_minutes` and `handover_otp_max_wrong_attempts`, all three `OPEN` and all three **`OQ-048`**'s; one set governs this OTP and §28.4's return OTP alike. See §14.

## 10. Errors — *pointer*

[errors-and-enums.md](../../contracts/errors-and-enums.md) §4, §5.5. All codes in §5.3 above exist; this feature adds none.

## 11. Audit events — *pointer*

[audit.md](../../contracts/audit.md) §5.3 `delivery`, §5.7 `payment`. **The OTP value never appears in any of them** (§20.4, §9).

## 12. API operations — *pointer*

[openapi.yaml](../../contracts/openapi.yaml). **The doorstep operations exist**, re-derived at Gate C C1.9:

| Act| Operation| Permission|
|---|---|---|
| Mark arrival| `arriveAtDeliveryStop`| `delivery.stop.execute`|
| The `DOORSTEP` contact and its wait| `recordDoorstepContact`| `delivery.stop.execute`|
| Read what is owed, and the demand id| `getStopPaymentDemand`| `payment.collection.read`|
| Receive Money — the shared engine| `initiatePaymentCollection` · `getPaymentCollection`| `payment.momo.collect` · `payment.collection.read`|
| Merchant MoMo, confirmed out of band| `confirmManualPayment`| `payment.momo.confirm_manual` — **S P**|
| Cash actually taken| `recordRecipientCashPayment`| `payment.cash.collect`|
| Duplicate-risk fallback grant| `authorizePaymentFallbackWhileUnresolved`| `payment.momo.confirm_manual` — **S P**|
| Send the OTP| `requestDeliveryOtp`| `delivery.stop.execute`|
| Close delivered| `closeDeliveryStopDelivered`| `delivery.stop.close`|
| Request the verification fallback| `requestVerificationFallback`| `delivery.stop.execute`|
| Grant it| `authoriseDeliveryWithoutOtp`| `delivery.otp.override` — **S P**|


## 13. Acceptance criteria

### `AC-SLICE-003-01` — Payment is recorded before the OTP is even offered

```text
Given an ARRIVED stop whose OperationalPaymentDemand is not SETTLED — nothing received, or GH¢50 of GH¢55,
When the rider requests the delivery OTP,
Then the request is refused with RECIPIENT_PAYMENT_OUTSTANDING,
And no OTP is generated,
And no OTP is sent to the recipient,
And the stop remains ARRIVED.
```

**Governs:** §25.2, §36.9 · **Surface:** Melarc Rider · **Test level:** integration

### `AC-SLICE-003-02` — A fully vendor-paid parcel still requires the OTP

```text
Given an ARRIVED stop whose order is fully vendor-paid with nothing due at the door,
When the rider attempts to close the stop as DELIVERED without submitting an OTP,
Then the transition is refused with OTP_INVALID,
And the parcel remains in rider custody.
```

**Governs:** §25.1 · **Surface:** Melarc Rider · **Test level:** integration

### `AC-SLICE-003-03` — The OTP goes to the number on record, not the number offered

```text
Given an ARRIVED stop whose recipient of record is +233XXXXXXXX1,
When the rider requests the OTP and supplies +233XXXXXXXX2 as the destination,
Then the request schema rejects the supplied number,
And the OTP is sent to +233XXXXXXXX1,
And the operation exposes no destination-number field at all.
```

**Governs:** §25.1, §20.4 · **Surface:** Melarc Rider · **Test level:** contract

### `AC-SLICE-003-04` — The OTP value is never returned, logged or audited

```text
Given a successful OTP validation closing a stop as DELIVERED,
When the API response, the application logs and the audit event are inspected,
Then none contains the OTP value,
And the audit event records that validation occurred with its timestamp and actor.
```

**Governs:** §20.4 · **Surface:** backend · **Test level:** integration

### `AC-SLICE-003-05` — A failed OTP after payment leaves the money tracked

```text
Given an ARRIVED stop where the recipient has paid GH¢30 in cash,
When OTP validation fails three times and the rider fails the stop,
Then the stop is FAILED with payment_taken true,
And a RiderCashCustody record for that order is COLLECTED_BY_RIDER for GH¢30,
And no refund is issued at the door.
```

**Governs:** §25.1, `MSC-DEC-229`, §26.3 · **Surface:** Melarc Rider · **Test level:** integration

### `AC-SLICE-003-06` — Delivery is idempotent on the same stop

```text
Given a stop already closed DELIVERED with a valid OTP,
When the identical request is replayed with the same Idempotency-Key,
Then the original result is returned,
And no second audit event is emitted,
And no second payment effect is created.
```

**Governs:** §25.2 · **Surface:** backend · **Test level:** integration

### `AC-SLICE-003-07` — Ops cannot deliver a parcel

```text
Given an ARRIVED stop on an in-progress run,
When an Ops Staff or Platform Admin actor attempts to close it DELIVERED,
Then the attempt is refused with PERMISSION_DENIED,
And the refusal is identical for both actors.
```

**Governs:** §25.1, §11.4 · **Surface:** Melarc Ops · **Test level:** integration

## 14. Open questions blocking this feature

| ID| What it blocks here| Type|
|---|---|---|
| `OQ-048`| **The SMS vendor contract.** §25.1 requires validation and fixes no parameters, and **all three keys now carry values** — `handover_otp_length` (6), `handover_otp_max_wrong_attempts` (3) at `MSC-DEC-418` and `handover_otp_ttl_minutes` (10) at `MSC-DEC-421` — so the OTP is fully specified; `AC-SLICE-003-05`'s three failures are the approved figure. What remains is external: which SMS provider and its delivery terms.| `EXTERNAL_INPUT`|
| ~~`OQ-003`~~| **Closed 26 August by `MSC-DEC-252`** — hub Senior Ops may authorise handover without OTP, reason mandatory, enhanced-audited| —|
| ~~`OQ-027`~~| **No longer bears on this feature — `MSC-DEC-415`, 26 September 2026.** Delivery closure — OTP verification and payment recording — is **online-only in Version 1**; hub-handover queuing is the whole offline scope.| —|
| `OQ-109`| The live Hubtel merchant contract. **Blocks the provider adapter's implementation, not this feature's specification** — the engine is provider-neutral and the demand, receipt and settlement gate are Melarc's own records| `EXTERNAL_INPUT`|

## 15. What this feature still owes its slice

- ~~The `delivery` domain has no write key~~ — **this was wrong and is corrected.** `delivery.handoff.perform` has been in the catalogue since it was written; `delivery` was never a read-only domain and never a fourth instance of that shape. The claim was asserted from the pattern rather than derived from the table.
- **`delivery.stop.execute`, `delivery.stop.close` and `delivery.otp.override` are written**, with their operations.
- **The doorstep operations exist** — arrival, the doorstep checkpoint, the payment demand and every collection path, OTP request, delivery, the fallback request and grant, failure (§12).
- **`OQ-048` is now the SMS vendor contract alone** — the three figures this feature's criteria depend on are set — and it remains the launch blocker; **`OQ-109` blocks the live Hubtel adapter** and nothing else.

## 16. Build status — *honest, per surface*

| Surface| Status|
|---|---|
| Melarc Rider| **Specified and buildable.** Every row of the doorstep inventory names an operation and a permission a rider holds ([rider-android.md](../../surfaces/rider-android.md) §5, `MSC-DEC-361`). **Screens are not built**; the machines behind the stop — `DeliveryStop` §12.1, `Order` fulfilment §9, `RiderCashCustody` §16.3 and `PaymentAttempt` §20.6 — are **signed by `MSC-DEC-366`** and owe nothing further; **the live Hubtel adapter is blocked by `OQ-109`** while the engine around it is provider-neutral.|
| Melarc Ops| **Specified and buildable.** Receive Money, the fallback grant, the OTP override and manual confirmation all have operations, keys and routes ([ops-portal.md](../../surfaces/ops-portal.md)). **No signature is outstanding** — the same machines are signed by `MSC-DEC-366`.|
| Melarc Vendor| **Specified** — outcome display only|
| Recipient channel| **Specified.** The OTP and the payment prompt are defined; **the SMS provider is `OQ-048`** and the payment provider contract is `OQ-109` — launch dependencies, not specification gaps.|

## 17. Related

[delivery-failure](delivery-failure.md) · [cash-collection](cash-collection.md) · [atomic-dispatch](../dispatch/atomic-dispatch.md) · [SLICE-003](../../delivery/slices/SLICE-003.md)
