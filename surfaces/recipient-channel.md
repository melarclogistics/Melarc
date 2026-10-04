# Recipient and Ad-hoc Sender Channel

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.10 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** the direct-to-phone channel — SMS, calls, OTP and payment prompts — for people with no Melarc account
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../PROJECT_MASTER_SPECIFICATION.md) §20, §10.1, **§41.1**

## 1. What this surface is

**A surface with no screens.** Recipients are not account holders (§20.1); interactions are direct-to-phone and are **initiated or recorded by the backend and Ops workflow** rather than by anything the recipient opens.

Ad-hoc senders share it. `CONFLICT-020` resolved them into one document because they share every mechanism — SMS and phone, no portal, OTP-gated, Hubtel payment prompts — and differ only in which end of the transaction they stand at.

**Boundary.** No authenticated portal in Version 1 (§10.1). Recipient and ad-hoc sender portals are explicitly deferred (§49.1).

## 2. Why this is a surface at all

It has no UI, so it is tempting to treat it as notification plumbing. It is not. It carries **two hard gates in the delivery path**:

- **The delivery-day confirmation call is mandatory before a doorstep parcel enters a delivery run, regardless of payer** (§20.2). It *is* the dispatch gate.
- **A valid OTP is the ordinary mandated proof of delivery** (§20.2, §19.6). No name, no relationship, no signature, no photograph. **One exception exists and it is not the recipient's to invoke**: where verification genuinely fails and the recipient is present, the Rider may request an **Ops-assisted fallback**, which **authorised Ops** grants.

A channel that gates dispatch and closes custody is a surface.

## 3. The three interactions

### 3.1 Heads-up SMS

| Property| Rule|
|---|---|
| Trigger| Server-side **at itemization close**, if enabled|
| Frequency| **Once per parcel**|
| Content| Informational. **No link and no code** (§20.2)|
| On reschedule| **Must not repeat** merely because the delivery date moved|
| Control| Global kill switch — `heads_up_sms_enabled`|

### 3.2 Delivery-day confirmation call

Worked by **the assigned Rider or authorised Ops on one canonical record** — the pre-dispatch confirmation queue in the Ops Portal, or the rider's own assigned-parcel queue; where Ops has confirmed, the rider does not call again. The recipient's side is a phone call. **It is checkpoint one of three**: `NEXT_STOP` and `DOORSTEP` follow, each a call to the same recorded number.

- **Mandatory before a doorstep parcel enters a delivery run, regardless of payer.**
- Records one of: **confirmed**, **reschedule**, **address correction**, **unreachable**.
- May capture a **refined-location note** — which reaches the rider's stop detail (§19.3).
- **Each attempt is logged.**
- **There is no fixed call limit**. Where Ops judges the contact avenues exhausted the order enters a **senior decision queue**; where a Vendor can help — a corrected number, an alternative contact — the Vendor is notified with the recipient's name and asked.

### 3.3 Delivery and return OTP

- Sent **only to the recipient phone number recorded for that parcel** in Melarc.
- **A recorded recipient may authorise another person by forwarding the OTP** — this is the approved delegation mechanism, not a workaround.
- The rider submits it for **backend validation** before delivery closure — and it is **requested only once any amount due is `SETTLED`** on the stop's payment demand: no OTP is sent while money is outstanding, however much has already arrived.
- Return handover closes only on a valid return OTP sent to the recorded vendor or sender contact, which may likewise be forwarded.
- **Fully vendor-paid deliveries skip payment collection but still require the OTP** (§19.6).

### 3.4 Payment prompt and redelivery notice — *Gate C*

- **Where a delivery fee is due, the recipient approves a mobile-money prompt on their own handset**. The amount is server-derived and read-only to the rider or officer who raised it; **Melarc never asks for a PIN** — the prompt belongs to the provider. Where the amount approved is short of what is owed, the money is kept and a further prompt asks for the remainder; the delivery fee may also be paid in cash where the hub enables it, or to the Melarc Merchant MoMo account with Ops confirmation.
- **A scheduled redelivery notifies the recipient of the new date and the amount due** — the applicable delivery fee for the new trip plus the hub's redelivery fee, **only where the failed trip was chargeable to the recipient**; a Melarc-caused failure notifies with no amount.
- Both are provider-dependent: the SMS side is `OQ-048`, the payment prompt the live Hubtel contract `OQ-109`.

## 4. Milestone communication

§20.3 confirms seven customer milestones for Version 1 SMS:

`Pickup confirmation` · `Parcel received and itemized` · `Out for delivery` · `Delivered` · `Failed delivery attempt` · `Return started` · `Return completed`

**Registered vendors receive the same applicable milestones in Melarc Vendor** as well as by the channel rules for their category. **Recipients receive only what is relevant to their own delivery** — payment, confirmation, OTP, failure or return context.

§20.3 notes that an earlier source's *"exactly two touches"* is **superseded** by this milestone policy (`CONFLICT-017`, resolved at the baseline).

## 5. Content rules

§20.4, and several are security requirements rather than tone guidance:

- **Identify Melarc and the parcel context sufficiently to establish trust** — a message a recipient cannot place is a message they will ignore or distrust.
- **Avoid exposing vendor, rider or internal notes unnecessarily.**
- Normalised Ghana phone numbers (E.164, per domain model §3.4).
- Include **only** the action, timing, amount, location or OTP context the interaction requires.
- **Never expose OTPs to unauthorised internal views or logs** — this binds the audit layer too, where the event records that a code was generated and never its value.
- Approved retry, deduplication, expiry, masking and rate limits.
- Record delivery status where the provider supports it.

## 6. Interface states, adapted

The nine states apply oddly to a channel with no screen, and forcing them would be theatre. What matters:

| Concern| Requirement|
|---|---|
| Delivery failure| The provider may fail. `DELIVERY_CHANNEL_FAILED` surfaces to Ops, not to the recipient|
| Deduplication| Heads-up SMS once per parcel; milestones must not repeat on reschedule|
| Kill switch active| §33.3 requires the active state be **visible to authorised operators** with a documented restoration procedure|
| Wrong or reassigned number| **Three mandatory live contacts on the recorded number before any OTP is sent**, then the exhausted-contact path — see §6.1 below. **No door-side identity check**: §25.1 rules one out for Version 1|
| Masking| Recipient data masked wherever full values are not required (§19.9)|

### 6.1 Phone reassignment — the risk, and the control that already answers it

*Withdrawn and rewritten 14 September 2026 by `MSC-DEC-384`, resolving `CONFLICT-039`.*

**The OTP is the proof of delivery, and Version 1 asks for nothing beside it.** Specification §25.1 is explicit: *"Possession and successful validation of the OTP is the Product Owner-approved authorization and proof. Version 1 does not additionally require the receiver's name, relationship, signature, or delivery photograph."* [doorstep-delivery.md](../features/delivery/doorstep-delivery.md) §5.5 owns that prohibition and this surface does not qualify it.

**The reassignment risk is real and is accepted, not ignored.** A Ghana number that has been reassigned could in principle put an OTP in a stranger's hands. What answers it in Version 1 is **contact frequency on the recorded number, not identity checking at the door** — and that control is already approved and already in the dispatch path:

| Control| What it does| Authority|
|---|---|---|
| **Pre-dispatch confirmation call**| **Mandatory before a doorstep parcel enters a delivery run, regardless of payer.** A live voice on the recorded number, recording confirmed / reschedule / address correction / unreachable| §3.2, `MSC-DEC-346`|
| **`NEXT_STOP` checkpoint**| Second live call to the same recorded number| `MSC-DEC-346`|
| **`DOORSTEP` checkpoint**| Third live call to the same recorded number| `MSC-DEC-346`|
| **Exhausted-contact path**| Order enters a **senior decision queue**; where a Vendor can help, the Vendor is notified with the recipient's name and asked| §3.2, `MSC-DEC-348`, `MSC-DEC-351`|

**A reassigned number must survive three live phone calls before an OTP is ever sent to it.** That is the Version 1 answer, and it costs the doorstep nothing.

**Residual risk is accepted at `MSC-DEC-384`** — recorded in a decision so it is owned, rather than carried in an interim policy nobody approved. A future version may revisit door-side verification through a deliberate update to this feature and its contracts, with its contract, capability and customer-facing policy costs stated.


### 6.2 SMS delivery failure has nowhere for a "push" to fall back to, and did not need one

*HIGH-17 audit remediation, corrected 13 September 2026.*

**The 13 September draft of this section described a push-notification retry cascade to the recipient — three push attempts, an SMS fallback, an in-app banner on next open.** None of it fits this channel. §1 above is explicit: recipients hold **no Melarc account**, **no UI**, **no authenticated portal** — there is no app to push to and no "Melarc-linked channel" for them to next open. The section also cited `vendor.contact_exception.notified` as its own audit event while describing the recipient as the notified party, when that event's own definition (`contracts/audit.md` §5.3) names the **Vendor**. **Superseded in full**, not narrowed — the mismatch was in the premise, not the numbers.

**What this channel already does, correctly, is §6's own row above:** an SMS provider failure is `DELIVERY_CHANNEL_FAILED`, and it **surfaces to Ops, not to the recipient** — there is no recipient-side retry to perform, because there is no recipient-side surface to retry on. Where Ops's own contact attempts are exhausted and a Vendor can help — a corrected number, an alternative contact — **the Vendor is notified** with the recipient's name (§3.2, `MSC-DEC-348`), and that notification is `vendor.contact_exception.notified`. **This is the whole mechanism, and it was already fully specified before 13 September.**

**Whether the Vendor's own notification of that event should be actively pushed (through Melarc Vendor) rather than left to the existing pull-based `/orders/{id}/contact-exceptions` page is a real, separate, undecided question — registered as `OQ-117`, not resolved here or invented as a retry table with no settings key or decision behind it.**

## 7. What this channel must never do

- **Never send an OTP anywhere but the recorded number** for that parcel.
- **Never log or display an OTP value** in an internal view, an audit event, or a provider log.
- **Never repeat the heads-up SMS** because a date changed.
- **Never let a doorstep parcel enter a run without confirmation**, regardless of payer.
- **Never require more than the OTP as proof.** §19.6 rules out name, relationship, signature and photograph — adding them is not extra safety, it is a departure from an approved decision.
- **Never expose another party's context** — a recipient sees their own delivery, nothing about the vendor's other parcels.

## 8. Open questions

This surface carries the **highest proportion of unresolved questions** in the product, and §20.5 lists most of them.

> [!CAUTION]
> **ESCALATION REQUIRED — PRIORITY-1 BLOCKING GATES.** The three questions below are not backlog items. They are go/no-go gates for this surface. **No `READY` status may be granted to any slice touching the recipient channel until all three are resolved.** Elevated to Priority-1 and assigned as of 13 September 2026.

| ID| Effect here| Type| Assignee| Escalated|
|---|---|---|---|---|
| **`OQ-048`**| **PRIORITY-1.** SMS provider and sender ID, template approval, OTP resend, expiry, retry, lockout and fraud controls. **The channel cannot operate without a provider**| `EXTERNAL_INPUT`| Product Owner| 13 Sep 2026|
| **`OQ-028`**| **PRIORITY-1.** Legal and privacy basis for sender-provided recipient contact data; opt-out and support handling; retention of call logs and message history. §20.5 routes these here explicitly| `EXTERNAL_INPUT`| Legal Counsel| 13 Sep 2026|
| ~~`OQ-003`~~| **Closed 26 August by `MSC-DEC-252`** — refusal consumes a physical attempt and routes to Ops; exceptional OTP recovery is the Ops-authorised fallback| —| —| —|
| **`OQ-109`**| **PRIORITY-1.** The live Hubtel merchant contract — the payment prompt cannot be implemented against the real provider until it arrives| `EXTERNAL_INPUT`| Product Owner| 13 Sep 2026|
| —| **There is no confirmation-call limit**.| —| —| —|
| `OQ-037`| Message wording and localisation| `ARTIFACT_REQUIRED`| —| —|
| ~~`OQ-114`~~| **Closed 14 September 2026 by `MSC-DEC-384`.** §6.1's interim secondary verification policy is **withdrawn in full** — it contradicted §25.1. The reassignment risk is accepted against `MSC-DEC-346`'s three mandatory live contacts. `CONFLICT-039`| —| —| —|

**One risk named, answered by an existing control, and the residual accepted.** §20.5 lists *"handling of wrong or reassigned phone numbers"* as unresolved. **`MSC-DEC-384` resolves it for Version 1**: three mandatory live contacts on the recorded number before any OTP is sent, the exhausted-contact senior decision queue, and the vendor-assist path — with the residual risk accepted in the decision rather than mitigated at the door.

## 9. What this surface still owes its slices

*A surface carries no readiness verdict (`MSC-DEC-423`, extending `MSC-DEC-239`): the slice's Definition of Ready, area D, judges whether this surface is specified well enough for that slice. This section lists what is still owed. §8's go/no-go bar on `READY` for a slice touching this channel is a rule about slices and is not changed by this section.*

| Owed| Blocks which DoR area| Owner|
|---|---|---|
| The SMS provider, sender ID and templates| D (frontend) and launch| `OQ-048`|
| The verified Hubtel merchant contract the payment prompt is implemented against| D and launch| `OQ-109`|
| The legal and privacy basis for the contact data this channel uses| launch| `OQ-028`|

The interaction set, the gates, the content rules and the never-do list are complete and citable. But this surface is **further from buildable than any other**: it has no SMS provider, no verified payment provider contract, and no legal basis for the contact data it uses. The exception policy for refusal, unavailability and OTP recovery **is settled**.

All three of those need people outside this team. That is worth planning around rather than discovering late.

## 10. Related

- **Up:** [overview.md](overview.md)
- **Worked from:** [ops-portal.md](ops-portal.md) — the confirmation-call queue lives there
- **Down:** [pickup-collection](../features/pickup/pickup-collection.md) — ad-hoc handshake codes travel by this channel
- **Authority:** [contracts/audit.md](../contracts/audit.md) §9 for the never-log rule this channel depends on
