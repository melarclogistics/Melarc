# Service Guidelines — controlled source

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 1.2 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** the **authoritative wording** of the customer-facing Service Guidelines. The published PDF is generated from this document and never edited independently — **and since 4 September 2026 it actually is**
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../PROJECT_MASTER_SPECIFICATION.md) §21.1, §23, §25, §28, §29.6, §35.2, and `MSC-DEC-301`–`MSC-DEC-342`, `MSC-DEC-350`, `MSC-DEC-367`

## 1. What this is

**The published `Our Service Guidelines.pdf` is a rendering of this document.** This is the source; the PDF is the artifact.

**Nothing here is new policy.** Every clause traces to an approved decision or a Master Specification section, and the trace is stated beside it in §3 so a reader can check rather than trust.

**Wording is customer-facing and deliberately plain.** Where a contract states a rule precisely and a customer needs it simply, the simplification is a presentation choice — it may never change the rule.

## 2. Publication status

|||
|---|---|
| Controlled source| **This document** — `APPROVED`, Product Owner, 4 September 2026|
| Published artifact| `Our Service Guidelines.pdf` — **regenerated from §3 on 4 September 2026** and now agrees with it|
| Regeneration| **Done.** §6 records the tool and process; §6a's criteria were run against the artifact, not against this source|

**The live PDF and this source agreed for the first time on 4 September 2026.** **Seven** material areas of the previously published guide contradicted or omitted approved rules; §4 names them exactly, and every one is now corrected in the artifact a customer actually reads.

**What was wrong was the publication, not the policy.** Every clause in §3 traced to an approved decision throughout; the customer-facing document simply had not been rebuilt since before Gate C. **A correct rule nobody publishes is a rule the customer does not have** — and one of the seven, the redelivery charge, was a bill a customer could incur without the guide mentioning it at all.

## 3. The guidelines

**Melarc Logistics operates reliable next-working-day delivery within our approved service areas for standard Metro service. Packages picked up on a working day are delivered the following working day, except where a published corridor schedule applies to your destination.** *(`MSC-DEC-304`, §21.1)*

1. **We operate Monday to Saturday.** Saturday pickups are delivered on Monday. We do not offer instant or express "rush" delivery. *(§21.1, `MSC-DEC-149`)*

2. **Book pickups through the Melarc Vendor app or our official WhatsApp line, before 10:00 AM, to be scheduled for the day.** Both channels follow the same rules. **Please do not contact riders directly to arrange, change or reschedule anything** — a rider cannot change your booking, and a request made to them is not recorded until our team enters it.

3. **You must have a minimum of two packages ready** before we assign a rider for a pickup. A single-package pickup may be approved as an exception by an authorised member of our team and **carries a GH₵20 fee**. *(§35.2.3, `MSC-DEC-216`, `MSC-DEC-333`, `MSC-DEC-334`)*

4. **Pickup window: 11:00 – 16:00. Delivery window: 10:00 – 16:00** (next working day).

5. **Packages should be securely packed, sealed and labelled, and manageable for normal Melarc motorcycle transport.** A parcel whose size, shape, weight distribution or packaging makes it unsafe or impractical to carry may require review or alternative handling before we accept it. **No food, fragile items, or other banned goods.** *(`MSC-DEC-302`, `MSC-DEC-303`, §35.2, `MSC-DEC-214`)*

6. **We do not collect payment for the goods themselves.** We operate a strict **no merchandise Cash on Delivery (no COD)** policy: vendors arrange payment for their products directly with their buyers, and our riders are not authorised to collect or pay for merchandise. **Delivery fees may still be paid through Melarc's approved payment methods, including cash where available.** *(§35.2, `MSC-DEC-335`)*

7. **If a delivery fails completely and we return the package to you, a return fee of GH₵20 per package applies.** *(§28, §5.2.4)*

7a. **If our rider reaches the delivery address but the delivery cannot be completed for a chargeable recipient-side reason, and another delivery trip is arranged, the recipient pays the applicable delivery fee for the new trip plus the hub's redelivery fee. In Accra, the current redelivery fee is GH₵20. No redelivery charge applies where the failed delivery was caused by Melarc.**


8. **Deliveries to Amasaman, Kasoa and surrounding areas cost GH₵35 on their published service day.** Delivery on another permitted day costs more.

9. **We charge GH₵20 upfront to drop your package at the station**, and this fee does not include the bus driver's waybill charge. *(§35.7.7)*

10. **Our liability for any lost or damaged package is capped at GH₵300.** Items worth over GH₵500 must be declared before pickup.

11. **Report any lost, damaged or missing package within 72 hours.**

## 4. What Gate C R1 corrected, and why

| Clause| Published wording| Corrected to| Because|
|---|---|---|---|
| 5| *"Packages should be **3kg or less** … **Heavier packages may attract extra charges**."*| Securely packed and manageable for normal transport; unsafe or impractical parcels may require review| **`MSC-DEC-302` withdrew weight as a pricing input entirely.** The published sentence promised a charge the product does not levy — a customer-facing statement of a rule that no longer exists. **`MSC-DEC-303`** replaces the implied 3 kg limit with a handling assessment, and deliberately sets **no kilogram or dimension threshold**|
| 2| *"Book all pickups on our **official WhatsApp line**"*| The Vendor app **or** the official WhatsApp line| **`MSC-DEC-215` and `MSC-DEC-337` confirm two channels** running in parallel under identical validation. Naming one sends Vendor-app users to the wrong place|
| Opening| *"reliable next-day delivery … delivered the following working day"*| The same promise, **subject to published corridor schedules**| **`MSC-DEC-304`.** The unqualified promise contradicted clause 8, which already said corridor destinations run on a published day. The guide disagreed with itself|
| **7a**| *(absent from the published guide)*| **The redelivery charge** — the applicable delivery fee for the new trip plus the hub's redelivery fee, GH₵20 in Accra, and **none where Melarc caused the failure**| **Approved 31 August by `MSC-DEC-350`.** A charge a customer can incur and cannot read about is the worst of the seven: the others misstate a rule or omit one, this one hides a bill. **Wording sharpened at C1.6**: *where the failure was not Melarc's fault* implied every non-Melarc cause charges the recipient, which is not the approved rule — the charge follows a **chargeable recipient-side** reason, and an **external** cause follows the Reason Catalog's own attribution. **No catalogue mechanics are exposed to the customer**|
| 3| *"a minimum of two packages"*| Unchanged, **plus** the approved single-package exception and its GH₵20 fee| The exception and fee are approved and were **absent from the customer-facing text**, so a customer with one package read only a refusal|
| **8**| *"Deliveries to Amasaman, Kasoa, and surrounding areas cost GHS 35 **only on Fridays**."*| GH₵35 **on their published service day**; another permitted day costs more| **`MSC-DEC-304` and `MSC-DEC-207` make the service day a published, per-corridor schedule.** *Only on Fridays* is a single fixed day, and it is **wrong for every corridor whose published day is not Friday** — a customer is told their delivery is unavailable, or overpriced, on the day it actually runs. **Found at C1.6 by reading the published artifact rather than the previous reconciliation**|
| **6**| *"We operate a strict No Cash on Delivery (No COD) policy."* — and nothing further| The same policy, **plus** that delivery fees may still be paid through approved methods, **including cash where available**| **`MSC-DEC-335`.** The published sentence is true about **merchandise** and reads as a rule about **all** cash. A recipient told Melarc is strictly no-cash will refuse a rider who asks for the delivery fee at the door — **the exact doorstep path Gate C specifies**. The omission does not misstate a rule; it makes an approved one unusable|

**What was already correct is left alone.** The published windows — pickup 11:00–16:00, delivery 10:00–16:00 — match `MSC-DEC-301` exactly, and *do not contact riders directly to arrange, change, or reschedule* is `MSC-DEC-338` in the customer's own words. **Both were right in the publication while the repository was silent**, which is the reverse of the drift this programme usually finds.

## 5. Values verified against the contracts

Every customer-facing figure, checked against the document that owns it *(Gate C R1 §36)*:

| Value| Published| Canonical source| Agrees|
|---|---|---|---|
| Pickup window| 11:00–16:00| `settings.md` §7.3 `pickup_service_window_*`| **Yes**|
| Delivery window| 10:00–16:00| `settings.md` §7.3 `delivery_service_window_*`| **Yes**|
| Booking cutoff| 10:00| `settings.md` §7.3 `booking_cutoff_time`| **Yes**|
| Single-package settlement| Due on acceptance| `MSC-DEC-340`| **Yes — internal settlement mechanics are deliberately not published**|
| Operating calendar| Mon–Sat| `settings.md` §7.3| **Yes**|
| Metro promise| Next working day| `MSC-DEC-304`| **Yes**|
| Corridor caveat| GH₵35 on the published day| `MSC-DEC-304`, `MSC-DEC-207`| **Yes — corrected in the opening line**|
| Station drop| GH₵20 upfront, waybill excluded| §35.7.7| **Yes**|
| Return fee| GH₵20 per package| §28, §5.2.4| **Yes**|
| Single-package fee| GH₵20| `settings.md` `single_package_pickup_fee`| **Yes — added**|
| Liability cap| GH₵300| `MSC-DEC-212`| **Yes**|
| Declaration threshold| GH₵500| `MSC-DEC-220`| **Yes**|
| Claim window| 72 hours| `MSC-DEC-220`| **Yes**|
| Booking channels| Vendor app + WhatsApp| `MSC-DEC-215`, `MSC-DEC-337`| **Yes — corrected**|
| Parcel handling| Packed, manageable, review where unsafe| `MSC-DEC-302`, `MSC-DEC-303`| **Yes — corrected**|
| Rider contact| Do not reschedule through riders| `MSC-DEC-338`| **Yes**|
| No merchandise COD| Strict — **goods only; the delivery fee is still payable, including in cash**| §35.2, `MSC-DEC-335`| **Yes**|

**Gate-C-owned live policy disagreements: 0** — against this source, across all sixteen values above.

**MED-15 audit remediation — the GH₵301–500 band, checked and closed rather than reopened.** The audit read clauses 10's two sentences side by side — *"capped at GH₵300"* beside *"items worth over GH₵500 must be declared"* — and found no stated treatment for a package worth, say, GH₵400. **`MSC-DEC-255` already settles this**: *"the GH₵300 damage cap is flat on the assessed amount"* — flat meaning **every package, at every value, with no upper or lower band** — and `MSC-DEC-220`'s declaration is a **separate, additional** obligation for items above the threshold, never a qualifier narrowing the cap's own reach. Clause 10's first sentence is unconditional as written — *"any lost or damaged package"* — and a GH₵400 item is already inside it. **No coverage gap exists in the approved policy, and none is invented here to fill one that does not exist.**

**What remains a legitimate, smaller observation is customer-facing clarity, not policy.** Placing a GH₵500 figure directly after a GH₵300 figure invites a reader to infer a boundary the sentence does not state, and a liability-limiting clause is exactly the wording a reader scrutinises for exceptions. **Recorded for the Product Owner's discretion at the next wording revision** — an explicit *"regardless of declared or assessed value"* after the cap sentence would remove the inference without changing the rule it already states — **and not made unilaterally here**: this document's approver is the Product Owner for customer-facing wording, and a clause already reconciled against approved decisions is not amended on a clarity preference alone.

**Against the published PDF: seven**, as it stood before the regeneration of 4 September 2026 — and the figure is **the number of rows in §4's table** rather than a number typed here — the corridor caveat, the booking channels, the missing single-package exception and fee, the over-3kg wording, the absent redelivery charge, the *only on Fridays* corridor day, and the No-COD clause that omits that delivery fees are payable in cash. **`OQ-107` carried them until the artifact was regenerated and verified against §6a on 4 September 2026, and closed on that artifact.**

*This line has now been wrong three times, and each correction was smaller than the last error.* It read **2** while §4 tabulated four; R1.1 corrected it to **4**; and it stayed at **4** through C1.5 and C1.6 while the table grew to seven — **C1.6 corrected §2's count and walked past this one**, because the two figures sit sixty lines apart and nothing compared them. **The count is now derived from the table in both places.** A document that counts its own findings wrong is the drift it exists to catch.

## 6. Regeneration

**The PDF was regenerated from §3 of this document on 4 September 2026**, under `MSC-DEC-367`.

|||
|---|---|
| Source| **§3 of this document.** The generator **parses the clauses out of the Markdown**; no policy sentence is retyped into it|
| Tool| **`reportlab` 5.0.1** on Python 3.14, with Arial and Arial Bold embedded from the platform font directory|
| Determinism| The document is built with reportlab's `invariant` flag, so **the same source renders the same bytes**. A publication artifact nobody can reproduce is one nobody can verify later|
| Preserved from the previous edition| The contact block (`info@melarclogistics.com`, `054 672 5720 / 055 062 5037`), the title, the thank-you opening and the `melarclogistics` footer|
| Extent| **One page.** Every clause is present and nothing is abridged to fit|

### The rendering profile, and why it is written down

**Three transforms happen between the Markdown and the artifact, and all three are notation rather than wording:**

| In this source| In the PDF| Why|
|---|---|---|
| `GH₵20`| `GHS 20`| **The notation the published edition already used**, and the only one that survives text extraction. The cedi sign has a glyph in the embedded font but **no reverse Unicode mapping**, so a reader would see it and an extractor would not — which fails §6a's own requirement that the text be readable by machine as well as by eye|
| Em dashes, curly quotes| ` - `, straight quotes| Same reason|
| `**bold**`, `*(`MSC-DEC-...`)*`| dropped| Emphasis is Markdown; the traces are **internal citations** and have never been customer-facing|

**A transform that changes notation is not a transform that changes policy**, and the distinction is recorded here so that nobody has to take it on trust. **No amount, threshold, service day, channel or fee was introduced, removed or altered by the rendering.**

**The direction of truth is one-way.** Approved decisions and contracts → this source → the artifact. A correction made in the PDF alone would be a policy change nobody approved, and the generator makes that impossible by construction: it reads §3 and cannot read anything else.

## 6a. Verification criteria for the regenerated PDF

**Nothing here may be claimed before a rendered PDF is actually inspected.** These are the checks run against the artifact, not against this source. **They were run on 4 September 2026 against the regenerated PDF** — by extracting its text and reading it, not by inspecting the generator's intentions — and all fifteen pass.

| #| Criterion|
|---|---|
| 1| **All text visible** — nothing clipped at a margin or lost past a page break|
| 2| **No overflow** — no line running off the page, no overlapping blocks|
| 3| **Pickup window reads 11:00 AM – 4:00 PM**|
| 4| **Delivery window reads 10:00 AM – 4:00 PM**|
| 5| **Both booking channels named** — Vendor app **and** official WhatsApp|
| 6| **Corridor caveat visible** in the opening promise, not only in the corridor clause|
| 7| **Single-package exception and its GH₵20 fee visible**|
| 8| **No automatic over-3kg surcharge wording anywhere**|
| 9| **Liability values correct** — GH₵300 cap, GH₵500 declaration, 72-hour claim window|
| 10| **Rider-contact rule present**|
| 11| **Readable at normal size** without zooming|
| 12| **No stale duplicate policy** — no clause contradicting another, and no leftover paragraph from the previous edition|
| 13| **The redelivery charge is visible** — clause 7a: the applicable delivery fee for the new trip **plus** the hub's redelivery fee, GH₵20 in Accra, and **none where Melarc caused the failure**|
| 14| **Corridor delivery reads *on their published service day*** — **not *only on Fridays***, which is wrong for every corridor whose day is not Friday|
| 15| **The No-COD clause says delivery fees remain payable, including in cash** — the published wording reads as a refusal of the doorstep collection the product actually performs|

**Every row of §4 must have a criterion here, and until Gate C C1.8 three did not.** Criteria 13, 14 and 15 close that: the redelivery charge, the corridor service day and the cash-payable delivery fee were **corrected in §3 and unverifiable in §6a**, so a regenerated PDF could have passed all twelve checks while **still hiding a bill a customer can incur**. **A verification list shorter than the correction list verifies the wrong artifact.**

**Criterion 12 exists because clause 8 and the opening line contradicted each other in the published edition** — one promised next-day unconditionally, the other said corridor destinations run on a published day. A regeneration that fixes one and leaves the other reintroduces the same defect.

## 7. Related

- [settings.md](../contracts/settings.md) §7.3 — every window and cutoff above
- [pickup-request.md](../features/pickup/pickup-request.md) — the booking rules clause 3 summarises
- [exception-ownership-matrix.md](../features/operations/exception-ownership-matrix.md) — who approves the single-package exception
- `Our Service Guidelines.pdf` — the artifact this document is rendered into, and the only place customers read any of it
