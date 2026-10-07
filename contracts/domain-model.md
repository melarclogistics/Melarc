# Domain Model

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 1.83 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** entities, fields, relationships, invariants, and the conventions every record obeys
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../PROJECT_MASTER_SPECIFICATION.md) §34 (domain concepts), §35 (business rules), §34.9–§34.12
> **Satisfies:** the content contract in §34.8

## 1. Scope

**This document covers**, for the whole product: naming and identity conventions, money, time, phone, location and evidence representation, the ownership and scoping model, and the complete entity catalogue with relationships and cardinalities.

**Field-level detail is complete** for the pickup-to-itemization spine — the Phase 2 proving slice — comprising `PickupRequest`, `PickupManifest`, `PickupStop`, `CollectionRecord`, `PickupIntake` and `Order`.

**Field-level detail is deliberately deferred** for the fleet, settlement, notification and reporting domains. Those entities appear in the catalogue with their identity, scoping and relationships fixed, and receive field detail when their features are written in Phase 4. This is scoped, not skipped: specification §44.4 gates readiness per slice, so an entity needs field detail before *its* slice is `READY`, not before any slice is.

**This document does not cover** state transitions, which belong to [state-machines.md](state-machines.md); request and response shapes, which belong to [openapi.yaml](openapi.yaml); or physical database layout, which §34.1 confirms is "a technical choice, not a separate product capability."

## 2. How to read this

Specification §34 establishes a *conceptual vocabulary* and says explicitly that it "is not a substitute for a physical database design." This document is the layer below it: where §34 says a concept exists, this says what it is made of.

Where §34 and this document appear to disagree, §34 wins on meaning and this wins on structure. Where this document names something §34 left unnamed, §36.7 authorises it — "domain/OpenAPI design must now publish the exact enum names and complete transition matrices, **without introducing new business policy**." That last clause is the constraint every name below was chosen under.

---

## 3. Conventions

These bind every entity. An entity that departs from one must say so and why.

### 3.1 Identity

Per §34.7, records carry a stable non-guessable identifier and may additionally expose a human-readable operational code.

| Concern| Rule|
|---|---|
| Primary identifier| UUID v7. Non-guessable per §34.7, and time-ordered so it indexes well as a primary key. Never displayed to a user.|
| Operational code| A short human-readable code for records staff and customers refer to aloud — pickup requests, orders, manifests, runs. Displayed everywhere a human must quote a record.|
| Exposure| The API exposes the UUID. The operational code is an attribute, never a path parameter, because it is human-facing and therefore mutable in ways an identifier must not be.|

**Format fixed by `MSC-DEC-202`:** `HUB-TT-XXXXXX` — three-letter hub code, two-letter record type (`PR` `MF` `IN` `OR` `DR`), six characters from the confusion-free alphabet `23456789ABCDEFGHJKMNPQRSTUVWXYZ`, which excludes `0 O 1 I L`. Example `ACC-PR-7K3M9Q`.

The alphabet is the point: these codes are **said aloud on phone calls** between Ops, riders and vendors, and every excluded character is one that is misheard or mistyped. The hub prefix is present because §13.1 requires multi-hub-capable design — a code that does not name its hub becomes ambiguous the moment a second hub opens.

### 3.2 Money

Governed by §34.6 and `MSC-DEC-179`.

- Every monetary amount is a **minor-unit integer** (Ghana pesewas). Never a float, never a decimal string. `2550` is GH₵25.50.
- Every monetary amount is accompanied by its currency code. Version 1 permits only `GHS`. The field exists so that multi-currency, deferred by §49.1, is a data change rather than a schema change.
- A money field is named for what it is: `locked_price_minor`, `return_fee_minor`. The `_minor` suffix is mandatory and exists to make a unit error visible at the call site.
- **A split allocation is computed one way only** (`MSC-DEC-249`, §5.2). The **sender's** portion is calculated; the **recipient's is the remainder**:

  ```
  sender_minor    = round(fee_minor × split_sender_percentage ÷ 100)
  recipient_minor = fee_minor − sender_minor
  ```

  §5.2 item 3 states it in terms — *"the contracting party pays a fixed Ghana-cedi amount or percentage and **the recipient pays the remainder**."* The two portions therefore sum to the fee **by construction**. **Computing both sides independently is forbidden**: it is the obvious implementation and it sums to 99 or 101 pesewas for most percentages, producing a fee that does not equal its own parts — a defect that surfaces weeks later in a vendor statement rather than at itemization.

- **The rounding mode is half-up**. `round_half_up(fee_minor × pct ÷ 100)`, applied to the **sender's** portion only — the recipient's is the remainder and is never rounded.

- **A sender portion that rounds to zero is zero**, and the order takes `NO_VENDOR_CHARGE`. **No floor is applied.** A 1-pesewa minimum was considered and rejected: the commercial gate records what is **collectable**, and four-tenths of a pesewa is not. A vendor who sets a 0.4% split on a GH₵1.00 fee gets the same treatment as recipient-pays, which is what they asked for.

### 3.3 Time

Per §34.7, all persisted timestamps are timezone-aware.

- Stored as UTC instants. The operating timezone is `Africa/Accra`.
- Business rules stated in local time — the Monday 08:00 statement issue, the Thursday 08:00 cutoff, the Sunday no-delivery rule, per-hub booking cutoffs — evaluate against `Africa/Accra`, not against UTC. A rule that evaluates in UTC will be wrong for part of the year in any jurisdiction that observes daylight saving, and depending on Ghana's offset for none of it — which is exactly why it must be explicit rather than incidentally correct.
- A **service date** is a calendar date, not an instant. Scheduled pickup and delivery dates are `date`, not `timestamp`.
- **Display convention fixed by `MSC-DEC-203`:** 24-hour local time, no timezone label — `18 Aug, 14:30`. Ghana is UTC+0 year-round and Version 1 serves Greater Accra only, so exactly one timezone exists and a label carries no information. **This holds only while that is true** — it reopens the moment Melarc operates outside UTC+0. Exports and anything readable outside Ghana carry an explicit offset.

### 3.4 Phone

- Stored in E.164. Ghana numbers normalise to `+233…`.
- The **as-entered** form is retained alongside the normalised form. Operations staff read numbers back to callers as the sender gave them, and a normalisation that silently discards the original makes that impossible.
- Recipient and ad-hoc sender numbers are the delivery mechanism for OTP and milestone SMS, so a phone field on those parties is operationally load-bearing, not contact metadata.

### 3.5 Location

- A location carries a free-text address, an optional landmark, an optional map link, optional coordinates, and an optional **GhanaPost GPS** code. §34.3 confirms the first four as request-level values; §23.2 adds GhanaPost GPS as a delivery-address component.
- Coordinates are optional and must never be required for a record to be valid. The operation runs on landmarks and phone calls; a model that assumes geocoding will block real bookings.
- A **service zone** is resolved from a location, not stored on it. Zones are hub-owned and versioned (§34.9), so a stored zone would silently go stale. Where a zone must be preserved — a locked price depends on it — it is snapshotted per §3.7.

### 3.6 Evidence

§34.7 is emphatic that photographs, signatures, OTP evidence and uploaded documents are "controlled evidence objects, not unstructured incidental attachments," and lists seven required attributes.

`Evidence` is therefore **one entity**, not an attachment column on each record that needs one:

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `owner_type` / `owner_id`| enum + uuid| no| The record this evidences|
| `purpose`| enum| no| `COLLECTION_PROOF`, `CONDITION`, `OSD`, `HANDOFF_RECEIPT`, `DELIVERY_PROOF`, `RETURN_PROOF`, `MAINTENANCE`, `FUEL`, `COMPLIANCE_DOCUMENT`|
| `captured_at`| timestamptz| no| When captured in the field, **not** when uploaded|
| `captured_by_actor`| uuid| no||
| `device_context`| jsonb| yes| The registered rider device (its `RegisteredDevice.id`) where applicable|
| `storage_ref`| text| no| Opaque storage reference. **Contains no personal data** — `MSC-DEC-282`|
| `responsible_hub_id`| uuid| **yes**| **Derived from the owner at creation, immutable**. The field the Hub policy reads. **Null exactly when `owner_type = VENDOR_ORGANIZATION`** — that owner has no hub, and inventing one would grant the chosen hub's staff a record they have no relationship to|
| `vendor_organization_id`| uuid| **yes**| **Derived from the owner at creation, immutable.** Null where the owner is vendor-neutral — `MOTORCYCLE`, `FUEL_RECORD` and `APPROVED_AGENT` evidence belongs to no vendor|
| `access_rule`| enum| no| Who may retrieve it|
| `retention_policy`| enum| no| Category key; **periods are `OQ-028`**|
| `state`| enum| no| `PENDING_UPLOAD` · `STORED` · `EXPIRED`. Lifecycle at [state-machines.md](state-machines.md) §17|
| `content_type` / `byte_size`| text / int| no| Declared at creation, **re-validated against what actually arrived**|
| `checksum_sha256`| text| no| Declared at creation; the record reaches `STORED` only if the stored object matches|
| `uploaded_at`| timestamptz| yes| Distinct from `captured_at`. Non-null from `STORED`|

`captured_at` being distinct from an upload timestamp matters because the rider app works under unreliable connectivity (specification §7.8) and evidence routinely arrives hours after capture.

**Invariants** *(added 24 August, `MSC-DEC-251`)*.

- **A record in `PENDING_UPLOAD` may not be named in any `evidence_ids` array** — `EVIDENCE_NOT_STORED`. A declared record is not a stored one, and `EVIDENCE_REQUIRED` cannot tell them apart: it asks whether evidence was attached, and a declaration answers yes. **Without this invariant, every "evidence required" rule in the product is satisfiable by creating a record and uploading nothing.**
- **`storage_ref` is never client-supplied and never returned.** §34.7 calls it opaque; a settable reference lets a caller point a record at another vendor's object, and a returned one lets every client construct its own retrieval URL and bypass `access_rule`.
- **`owner_type` and `owner_id` are immutable after creation.** Re-pointing evidence at another record changes what it proves, which §35.1.5 forbids.
- **`access_rule` and `retention_policy` are derived server-side** from `owner_type` and `purpose`. A caller choosing its own retention would be setting data-protection policy per upload.
- **`responsible_hub_id` and `vendor_organization_id` are derived server-side at creation and are immutable**. They are **not** on the creation schema for the same reason `storage_ref` is not: a client that could set them would point an evidence record into another hub's or another vendor's scope, **and the record would look entirely legitimate**.
- **They duplicate a fact the owner already holds, and that duplication is deliberate.** §5.6 accepted a polymorphic owner reference *"which the database cannot constrain by foreign key"* as a modelling cost. **Under row-level security it is a security property**: a policy cannot follow `owner_type`/`owner_id` into nine different parent tables — eight until `APPROVED_AGENT` joined at `MSC-DEC-417` — so without direct columns the only enforceable answer is an application-level filter — which [SOLUTION_ARCHITECTURE.md](../architecture/SOLUTION_ARCHITECTURE.md) §6 rejects by name, because *"a forgotten `WHERE hub_id = ?` is a cross-hub data leak."* **Immutability plus a creation-time derivation is what keeps the copy from becoming a second, editable truth**.
- **Evidence scope is owner-aware, and the two fields are not independently settable**. Where `owner_type = VENDOR_ORGANIZATION`: `vendor_organization_id` is **required** and equals the authoritative owner, and `responsible_hub_id` is **NULL**. Where the owner is a Hub-scoped operational record: `responsible_hub_id` is **required** and derived from that owner. **A vendor-organization owner carrying a hub, or a hub-scoped owner carrying none, is invalid** — not a default to be filled in.
- **Vendor ownership is the whole boundary for a vendor-owned object.** A Staff hub set never converts a globally vendor-owned record into a hub-global one, and another vendor is denied regardless of hub.
- **The storage key carries no personal data**. A key built from a recipient's phone number or a vendor's name leaks that data into every log line, error message and bucket inventory that prints it — **without ever granting access to the object**. §38.2's *never unnecessary personal data* governs identifiers as much as payloads.

### 3.7 Historical interpretability

This is a **general rule of the specification**, not an inference. §35.1.5: "Historical transactions must preserve the values, reasons, prices, provider details, and actors applicable when the transaction occurred." §35.1.4 adds the forward-only default: "business settings affect future decisions unless a documented correction or migration rule explicitly applies them retroactively." §34.7 requires the same interpretability after users, settings, prices, reasons or providers are deactivated.

The rule: **where a business record depends on a mutable configuration value, the record snapshots the value and the version it came from — it does not hold a reference alone.**

A snapshot carries the value, the setting key, the **owning hub**, and the effective version.

**The hub is part of the snapshot since `MSC-DEC-218`, and omitting it would break this rule silently.** While every fee was company-wide, *setting key + version* identified exactly one value in the business. With fees hub-scoped, **version counters are per hub and collide**: `service_area_base_fee` v3 is GH₵35 in Accra and may be GH₵45 in Kumasi. A snapshot naming only key and version no longer identifies anything.

The charged amount is never at risk — the value is snapshotted, and `Order.responsible_hub_id` is non-reassignable, so the schedule is recoverable by joining the two. **But recovering provenance by joining to another field is holding a reference**, which is what this rule forbids. Three things degrade without the hub in the snapshot: an auditor cannot answer *“was this the approved rate?”* from the record alone; revenue grouped by rate version silently merges two hubs' unrelated v3s; and the §35.6.8 repricing path recomputes against a schedule it has to infer. A reason code carries its label at time of selection, so renaming a reason does not rewrite history.

This applies to the service-area base fee, corridor off-day fee, size-class surcharge, station-drop fee, single-package pickup fee, return fee, cancellation charge and outside-Accra margin — **every one of which is hub-scoped**, which is why the hub belongs in the snapshot rather than being assumed. It applies equally to the company-wide policy limits (`liability_cap_amount`, `value_declaration_threshold`, `claim_report_window_hours`), where the hub component is recorded as company-wide rather than omitted, so that every snapshot has the same shape.

`MSC-DEC-177` states the pattern concretely for one — "new Station Drop charges snapshot the approved effective value/version; existing charges do not reprice" — as an instance of §35.1.5, not as its origin.

§35.9.1 extends the same requirement to reason options: they "must use stable codes and remain interpretable after deactivation."

### 3.8 Privileged overrides

§35.1.6 fixes the minimum record for every privileged override: **reason, actor, timestamp, before-and-after values, and an audit event.** Before-and-after is the part most often dropped — an override that records only the new value cannot be reviewed, because nobody can see what it displaced.

Every override path in this model carries all five. Where a document below describes an override without them, that document is wrong.

---

### 3.9 Reason codes

§35.9.1–2 make reason codes more than labels. They "must use stable codes and remain interpretable after deactivation," and — the structural part — **"reasons may carry metadata controlling whether notes, photos, contact attempts, or approvals are mandatory."**

A reason therefore drives validation. Selecting *damaged in transit* may make a photo mandatory where *recipient unavailable* makes a contact attempt mandatory, and those requirements are configuration, not code.

| Field| Type| Null| Notes|
|---|---|---|---|
| `code`| text| no| Stable; never reused after deactivation|
| `domain`| enum| no| Which workflow offers it. **`DELIVERY_FAILURE` · `RECIPIENT_CONTACT` · `PICKUP_STOP_SKIP` · `HANDOFF_FAILURE`** — the third added at `MSC-DEC-412`, closing `OQ-141`, and the fourth at `MSC-DEC-417`, for an outbound stop that fails at the counter. **Six identity domains follow, one per operation family** (below)|
| `valid_checkpoints`| enum set| **yes**| **The recipient-contact checkpoints this reason may be selected at** — any of `PRE_DISPATCH` · `NEXT_STOP` · `DOORSTEP`. **Mandatory and non-empty where `domain = RECIPIENT_CONTACT`; null for every other domain**, which has no checkpoints. Added at `MSC-DEC-407`, closing `OQ-138`'s engineering half: §6.12's `RecipientContactAttempt` invariant already said *"the catalogue carries the mapping"* and [errors-and-enums.md](errors-and-enums.md) §6 that *"a reason declares the checkpoints it is valid for"* — **and this table carried no such field**, so `REASON_NOT_VALID_FOR_CHECKPOINT` had nothing to read|
| `label`| text| no| Snapshotted onto records at selection (§3.7)|
| `requires_note`| bool| no||
| `requires_photo`| bool| no||
| `requires_contact_attempt`| bool| no||
| `requires_approval`| bool| no| Drives a maker-checker step|
| `attribution`| enum| no| **`CUSTOMER` · `MELARC` · `EXTERNAL`**|
| `consumes_delivery_attempt`| bool| no| **Whether this DOORSTEP outcome qualifies as a failed PHYSICAL delivery attempt** — feeding physical-attempt history, **redelivery eligibility** and service attribution. **Recipient absent after a valid doorstep wait qualifies; a rider breakdown before a genuine attempt does not.** It is **never** used for `PRE_DISPATCH` or `NEXT_STOP` contact counts, and **never** caps anything. |
| `requires_ops_review`| bool| no| Routes to the Ops decision queue rather than closing|
| `requires_escalation`| bool| no| Routes to the senior queue|
| `active`| bool| no| Deactivation never deletes; history stays interpretable|

Any workflow that hardcodes "this reason needs a photo" contradicts §35.9.2. The requirement is read from the reason. **The same holds for checkpoint validity**: a workflow that hardcodes *this reason belongs at the door* contradicts §6.12's invariant, which puts the mapping in the catalogue.

**The `RECIPIENT_CONTACT` contents are seeded** by `MSC-DEC-409`, 25 September 2026, closing `OQ-142`. Each was admitted on `MSC-DEC-252`'s routing test — **a category that does not change what Ops does next is a note, not a reason** — and they are **seeded defaults in a controlled catalogue, not a closed enum**.

| `code`| `valid_checkpoints`| `attribution`| Routes to| Vendor notified|
|---|---|---|---|---|
| `NO_ANSWER`| `PRE_DISPATCH` · `NEXT_STOP` · `DOORSTEP`| `CUSTOMER`| Retry; no Ops action| Not independently — §11's own transition effect still governs where it notifies|
| `NUMBER_INCORRECT`| `PRE_DISPATCH` · `NEXT_STOP` · `DOORSTEP`| `EXTERNAL`| Vendor, for a correction| **`REQUIRED`**|
| `RECIPIENT_DECLINED`| `PRE_DISPATCH` · `NEXT_STOP` · `DOORSTEP`| `CUSTOMER`| **Ops decision queue** — §11's `REFUSED` path. `requires_ops_review`, `requires_note`| **`REQUIRED`**|
| `RECIPIENT_NOT_AT_LOCATION`| **`DOORSTEP` only**| `CUSTOMER`| The server-timed wait, then a physical attempt failure| `NOT_REQUIRED` — **the delivery-failure path notifies**, and a second notice for one event is not raised|
| `CONTACT_NOT_POSSIBLE_MELARC`| `PRE_DISPATCH` · `NEXT_STOP` · `DOORSTEP`| `MELARC`| Rider-support follow-up; **no customer consequence**. `requires_note`| `NOT_REQUIRED` — the failure is Melarc-side|

**`consumes_delivery_attempt` is `false` on all five, and the field is inert for this domain.** `Order.delivery_attempts` is incremented by a **`DeliveryStop` outcome**, which reads a `DeliveryFailureReason` — so a `true` on a contact reason would be read by no path. **A `DOORSTEP` contact failure is not a physical delivery attempt**, including `RECIPIENT_NOT_AT_LOCATION`: the wait expiring and `failDeliveryStop` is what consumes one, exactly as `MSC-DEC-346` separated the two counts.

**`requires_escalation` is `false` on all five.** `MSC-DEC-351` reserves escalation for **Ops judging the contact avenues exhausted**; a reason that escalated by being selected would move that judgement into a rider's picker.

**Reschedule and location change are not reasons** — reaching the person and being asked to move the slot or the destination is a **`SUCCESSFUL`** contact carrying a `delivery_commitment_id` or a `location_change_request_id` (§6.12). Seeding a reason for either would record one act twice.

**The `PICKUP_STOP_SKIP` contents are seeded** by `MSC-DEC-412`, 25 September 2026, closing `OQ-141`. §5's `PENDING/ARRIVED → SKIPPED` row has named **Ops** with a mandatory reason since 17 August 2026 and **no operation performed it**, so a run with one unresolvable stop could not reach `COMPLETED`. Admitted on `MSC-DEC-252`'s routing test:

| `code`| The next action that differs| `attribution`| `requires_note`|
|---|---|---|---|
| `RUN_CUT_SHORT`| **Reschedule** — the run ended before the stop: breakdown, curfew, or a custody handover with no time left| `MELARC`| no|
| `VENDOR_REQUESTED_SKIP`| **Reschedule at the vendor's own request** — the notification confirms rather than informs| `CUSTOMER`| no|
| `LOCATION_INACCESSIBLE`| **Reschedule, often with a location correction**| `EXTERNAL`| **yes**|
| `STOP_RAISED_IN_ERROR`| **Cancel without replacement** — the only one that does not reschedule| `MELARC`| **yes**|

**`valid_checkpoints` is null for this domain** — checkpoints are a recipient-contact concept — and **`consumes_delivery_attempt` is `false` and inert here**, as it is for `RECIPIENT_CONTACT`. **A skip consumes no `PickupRequest` attempt either**: it is Melarc's operational decision, not a failed collection, and §5's Effects column has always read **—**.

**Every authorised skip notifies the Vendor**, including `VENDOR_REQUESTED_SKIP`, where the notice records that the request was honoured. **The skip moves the stop and nothing else**: the `PickupRequest` keeps its state, and Ops use §3's `CONFIRMED → CANCELLED (replacement)` or plain cancellation.

**The `HANDOFF_FAILURE` contents are seeded** by `MSC-DEC-417`, 26 September 2026 — the fourth domain, for an outbound stop that fails at the counter ([state-machines.md](state-machines.md) §12.1). Each was admitted on `MSC-DEC-252`'s routing test, and **the last two are the Product Owner's own**, named as the commonest reasons an informal Station Drop driver is refused:

| `code`| The next action that differs| `attribution`| `requires_note`|
|---|---|---|---|
| `STATION_CLOSED`| **Re-dispatch when the counter is open**| `EXTERNAL`| no|
| `CARRIER_REFUSED_PARCEL`| **Ops inspects the parcel** — size, contents or packaging — before a re-dispatch or a Return| `EXTERNAL`| **yes**|
| `AGENT_NOT_PRESENT`| **Re-dispatch once the agent is re-arranged**| `EXTERNAL`| no|
| `RECIPIENT_REJECTED_WAYBILL_PRICE`| **Re-dispatch to a different driver** — the recipient refused the onward charge this one quoted| `CUSTOMER`| no|
| `VEHICLE_NOT_TERMINATING_AT_DESTINATION`| **Re-dispatch to a vehicle whose last stop is the recipient's town** — this one only transits it| `CUSTOMER`| no|

**`consumes_delivery_attempt` is `false` for all five** — an outbound counter is not a doorstep, and no attempt is recorded. `valid_checkpoints` is null. **The Vendor is not notified at the counter**; it hears through the Return flow if Ops decides one.

**The identity operations take a `reason_code` from this catalogue** (Product decision, 6 October 2026). Every identity operation that records why — `revokeSession`, the rejection call of `approveStaffIdentity`, `resetStaffMfa`, `reissueStaffCredentialSetup`, `reissueVendorCredentialSetup`, `recoverStaffCredential`, `recoverVendorCredential`, `reregisterRiderDevice` and `revokeRiderDevice` — validates it exactly as any other reason is validated: **an empty one is `REASON_REQUIRED`, and one that is unknown, retired or from another domain is `REASON_NOT_ACTIVE`**. `DeviceRevocation.reason`, a free-text string until now, becomes a `reason_code` like the others. `valid_checkpoints` is null for these domains, and `consumes_delivery_attempt` is `false` and inert, as for the other non-delivery domains.

**Six domains, one per operation family, named after the act as the four above are. The names are proposed here and are not yet approved:**

| `domain`| Taken by|
|---|---|
| `SESSION_REVOCATION`| `revokeSession`|
| `STAFF_PROFILE_REJECTION`| `approveStaffIdentity` with `approved: false`|
| `STAFF_MFA_RESET`| `resetStaffMfa`|
| `CREDENTIAL_ADMINISTRATION`| `reissueStaffCredentialSetup`, `reissueVendorCredentialSetup`, `recoverStaffCredential`, `recoverVendorCredential`|
| `RIDER_DEVICE_REPLACEMENT`| `reregisterRiderDevice`|
| `RIDER_DEVICE_REVOCATION`| `revokeRiderDevice`|

**Unresolved Product Owner input: the seeded reasons of these six domains, and their wording, have not been supplied, and none is invented here** — nor the other fields a catalogue row needs (`label`, the `requires_*` flags, `attribution`). Until they exist, each of these operations refuses every `reason_code` it is given with `REASON_NOT_ACTIVE`, so none can succeed in an environment seeded without them ([MIGRATION_AND_SEEDING.md](../architecture/MIGRATION_AND_SEEDING.md) §4).

**Two reason models coexist, and conflating them is `CONFLICT-025`.** §35.9.1 makes reason *options* runtime-configurable, but §21.5 fixes the pickup-failure **category** at exactly four values — `VENDOR_UNAVAILABLE`, `ACCESS_DENIED`, `PARCEL_NOT_READY`, `REFUSED_COLLECTION` — which are product policy, closed to configuration. §21.6 attaches a hard rule to one of them: refused collection is escalation-only, never reschedulable. A configurable category could be renamed or deleted, and that rule would point at nothing.

The rule: **a category carrying downstream policy is a fixed enum; the note, contact attempts and evidence attached to it remain configurable metadata.**

## 4. Ownership and scoping

§34.1 names four ownership layers. Structurally they reduce to **two independent scoping axes**, and every entity must declare its position on both.

**Vendor ownership** — does this record belong to one vendor? If yes, the vendor portal may show it to that vendor and to nobody else. §34.1: the portal "sees only its own records."

**Responsible hub** — which hub is accountable? §34.9 makes `Hub` "mandatory operational context" and confirms that records covered by `HUB-020` reference exactly one responsible hub. Hub scope bounds which staff may act, and reassignment is permitted only before custody begins.

**That last clause is a permission, and R1 makes it executable**. `PickupRequest.responsible_hub_id` is therefore **controlled-mutable before custody** — through one named command, by an actor authorised for **both** hubs, revoking stale planning atomically — and immutable afterwards. **Gate B R0 read it as universally immutable**, which forbade a rule this section has carried since the baseline; the reliable consequence of forbidding approved behaviour is a workaround, and the workarounds available here were cancel-and-recreate, which breaks the §5.7 attempt chain, or a direct database edit that no policy or audit event sees.

These are independent. An order is both vendor-owned and hub-scoped. A manifest is hub-scoped and vendor-neutral — it carries stops for many vendors. A motorcycle is hub-scoped and never vendor-owned.

| Entity| Vendor-owned| Hub-scoped|
|---|---|---|
| `VendorOrganization`| self| no — a vendor may transact with any hub|
| `VendorAccount`| self — one account per organisation| **no — a global master record**; the two staff reads (`listVendorAccounts`, `getVendorAccount`) narrow by the linked `VendorOrganization`'s responsible hub (`MSC-DEC-442`, [data-scope-registry.md](data-scope-registry.md) §8.5)|
| `VendorPickupLocation`| yes| no|
| `PickupRequest`| yes| yes|
| `PickupManifest`| **no**| yes|
| `PickupStop`| via request| yes|
| `CollectionRecord`| via stop| yes|
| `PickupIntake`| via request| yes|
| `Order`| yes| yes|
| `DeliveryRun`| **no**| yes|
| `DeliveryStop`| via order| yes|
| `CourierProvider`| no| **no** — one platform-wide register (§24.7, `MSC-DEC-417`)|
| `ApprovedAgent`| no| yes — the approving hub|
| `Payment`| where vendor-paid| yes|
| `VendorStatement`| yes| **no** — company-wide, per §5.2.5|
| `Motorcycle`, fleet records| no| yes|
| `StaffIdentity`, `RiderIdentity`| no| primary hub + temporary assignments|
| `Evidence`| via owner| **via owner, and conditional** — required for a Hub-operational owner, **null for a `VENDOR_ORGANIZATION` owner**|
| `AuditEvent`| via subject| via subject|

**This table answers *whether* a boundary exists. It does not say which field carries it**, which parent the scope is derived from where a table has none of its own, whether that field may change, or which database role may write it — and a row-level-security policy needs all four. [data-scope-registry.md](data-scope-registry.md) carries them for all sixty-two persistent tables. **This section remains the product-level statement of the two axes and wins wherever the two documents describe the same fact.**

**`Evidence` is the row where *via owner* is not the whole answer.** Both axes derive from the owner, but the Hub axis is **conditional on which owner it is**: a `VENDOR_ORGANIZATION`-owned record is bounded by vendor ownership alone and carries **no hub**, while a Hub-operational owner supplies one. **No hub is ever invented to fill the gap** — whichever hub were chosen, its staff could read the object and the vendor's other hubs could not. Field-level rules are at §3.6; the per-principal predicates are [data-scope-registry.md](data-scope-registry.md), which remains the detailed authority.

Two rows carry a trap worth naming. `PickupManifest` and `DeliveryRun` are **not vendor-owned** — each carries stops for many vendors, so exposing one to the vendor portal would leak other vendors' records. The vendor sees its own stop, never the run. `VendorStatement` is **not hub-scoped**: §5.2.5 issues one weekly statement per vendor across all hubs, so a hub filter applied to statements would silently under-bill.

---

## 5. Boundary decisions

Eight structural calls the specification left to this document. Each records what was decided and what it costs.

**5.1 `Order` is one entity.** Per `MSC-DEC-187`. Physical and commercial facts on one record; "parcel" is display language only.

**5.2 `Processing Batch / Wave` is not an entity in Version 1.** §34.4 defines it as "a grouping used to organize intake/itemization work" and admits "exact cardinality and lifecycle require a detailed domain model." No approved requirement depends on it; `PickupIntake` already provides the unit of work that itemization operates over. Introducing it now would be speculative structure. *Cost:* if hub throughput later needs wave planning, it arrives as a new entity referencing intakes — additive, not a migration of existing records.

**5.3 `PickupStop` and `CollectionRecord` are two entities.** §34.3 defines them separately and both appear to carry an outcome, which is what makes this look like duplication. They are not the same thing: the stop is the *run-level* record — route position, sequence, assignment — and exists from the moment the manifest is built. The collection record is the *physical result* and exists only once the rider is at the door. §36.4 forces the split by requiring that "a zero collected count is a failed pickup and cannot be represented as a completed stop," which means stop outcome and collection outcome must be independently representable. *Cost:* a join for the common case of reading a stop with its result.

**5.4 Lane, carrier identity and commercial mode are three independent fields on `Order`.** §24.3, `MSC-DEC-154–155`, quoted in §34.5, settles this: one run "may freely mix registered-courier/informal-carrier stops and `STATION_DROP`/`MELARC_COVERED_THIRD_PARTY_DELIVERY` commercial-mode stops," with each order's facts "independently tracked regardless of which run carries it." Three orthogonal axes, none derivable from another, none belonging to the run.

**5.5 There are two payment ledgers, one of them exists, and only one was ever in scope.** §34.6 marks reservation and release mechanics, immutable-ledger structure and accounting export as pending, and `OQ-005` owns them. **"Ledger" names two different things in this corpus and they have different answers**, which is why this entry was read as one gap for a month.

**The vendor-balance ledger does not exist, and is `SLICE-007`'s.** `Payment`, `VendorBalance`, `VendorStatement`, `StatementLine` and `Adjustment` are **named in §6's Commercial group and nowhere given a field table** — the entries that would move a vendor's balance are exactly what this document stops before. §27's statement schedule, payment policy and dispute rules are approved, but `VendorStatement` is one of the eight **deferred** state machines at [state-machines.md](state-machines.md) — state sets only, no table — and §27.4 assigns the rest downstream. *Cost:* **the payments slice cannot reach `READY` until `OQ-005` closes.** That was already true and is not created by this entry.

**The immutable payment ledger does exist, and Gate C built it under other names.** §50.2 assigns `OQ-005` an *immutable ledger* in a list beside receipts, allocation, provider states and refunds — a ledger of **payment facts**, not of accounts, which is what §14.1 leaves room for by placing general accounting outside Version 1. These records are it, and they are already append-only in substance:

| Class| Records| What holds them|
|---|---|---|
| **Facts never rewritten or deleted**| `OperationalPaymentDemand` · `PaymentDemandLine` · `PaymentAttempt` · `PaymentReceipt` · `PaymentAllocation` · `RiderCashCustody` · `CashHandover` · `HubCashReconciliation` · `CashDisposition`| Frozen lines, snapshotted principals, *"a confirmed receipt is never deleted"*, *never rewritten* cash figures|
| **A lifecycle that advances once and never reverses**| `PaymentFallbackAuthorization` (`ACTIVE → CONSUMED`/`SUPERSEDED`, consumption a system effect) · `FinancialAdjustmentRequired` (`OPEN → RESOLVED`) · `FinancialAdjustmentResolution` (`PROPOSED → APPROVED`/`REJECTED`)| Single use; status reached only through the act that earns it|

**Immutability here does not mean no field ever changes** — three records carry a status, and saying otherwise would be false about all three. It means **a financial fact is never rewritten, and a correction is a new record**: `MSC-DEC-357` raises a `FinancialAdjustmentRequired` rather than reversing a receipt, §5.2.5 and §27.3 make an approved correction a *linked adjustment rather than rewriting issued history*, `locked_price_minor` corrections create one, and `MSC-DEC-395` makes a split resolution **two adjustments** rather than one resolved twice.

**The export is specified; the feed behind it is not yet complete.** §50.2's *accounting export* — the format in which these facts leave for someone else's accounting system, coherent precisely because Melarc runs none — is built at `MSC-DEC-401` as `AccountingExport` (§6.12) and [accounting-export.md](../features/payments/accounting-export.md). **What remains is derivability, not format**: the two classes above answer *"is this record rewritten or deleted?"*, which is not the question an export asks. **Ten of the twelve records carry a status**, and **eight cannot yet emit a truthful lifecycle event feed** — seven for want of an authoritative transition timestamp, and one, `FinancialAdjustmentResolution`, on a field its complete timestamps would have passed — while **four cannot truthfully emit even their creating event**. `PaymentReceipt` is the sharpest case: it has no `reversed_at`, and `CONFIRMED → REVERSED_BY_PROVIDER` is money that arrived and then left. The per-field test behind those figures is `delivery/planning/ACCOUNTING-PASS-3-DERIVABILITY.md`, cited as evidence by **`OQ-131`**, which owns the remedy through `SLICE-004` Pass 4; canonical generation is gated on it.

**5.6 `Evidence` is one polymorphic entity.** Per §3.6 above. §34.7 lists one attribute set for all evidence, and every capture point needs the same seven facts. *Cost:* a polymorphic owner reference, which the database cannot constrain by foreign key. Mitigated by `owner_type` being a closed enum.

**5.7 The pickup attempt chain is a self-reference, not an entity.** §34.3 defines it as "the linked history of failed, rescheduled, replacement and ultimately completed/cancelled pickup attempts." §36.2 already requires a cancelled request to preserve "attempt-chain/replacement links." A `replaces_request_id` self-reference on `PickupRequest` yields the chain by traversal. A separate entity would hold nothing the link does not.

**5.8 Temporary hub assignment is a separate effective-dated entity.** §34.9 requires this explicitly — temporary assignments "must not overwrite primary membership." So `RiderIdentity.primary_hub_id` is stable, and `HubAssignment` records carry effective dates, the requesting and approving Senior Ops actors, and the receiving hub.

**5.9 `Order` carries two state fields, not one.** The specification defines two lifecycles over the same record. §36.11 gives a commercial gate — `PRICED` through credit reservation or prepayment — and §36.9 gives a fulfilment progression from dispatch readiness through delivery, reattempt and return. They are orthogonal: an order that is commercially `PREPAID` may be physically `OUT_FOR_DELIVERY`, `ATTEMPT_FAILED`, or `AT_HUB_AFTER_FAILURE`, and its commercial standing does not change as it moves.

**§16.3 is the strongest source for this and was found only in the Phase 1–2 audit:** *"Operational closure and financial closure are related but **distinct**. A parcel may reach a physical outcome while payment or reconciliation remains open; the system must expose **both statuses** and prevent unresolved money from becoming invisible."* Two statuses, required to be separately visible — which is what two state fields deliver and one flattened enum cannot.

Flattening them into one enum would require a member for every reachable combination, and would make `MSC-DEC-176`'s guard — no dispatch readiness while a sender-paid amount is outstanding — a rule about enum ordering rather than an explicit precondition. `Order` therefore carries `commercial_state` and `fulfilment_state`, and the gate between them is a guard, stated once in [state-machines.md](state-machines.md). *Cost:* two fields to reason about, and any query for "where is this order" must say which sense of *where* it means. That ambiguity exists in the business already; the model surfaces it rather than hiding it.

---

## 6. Entity catalogue

### 6.1 The spine

```text
VendorOrganization
   │ 1
   │ *
PickupRequest ──────────────┐ replaces_request_id (self, §5.7)
   │ 1                      │
   │ 1                      └──> PickupRequest
PickupStop ──* ── 1 PickupManifest ── 1 ── RiderIdentity
   │ 1                              │
   │ 0..1                           └─ 1 Hub
CollectionRecord
   │
   ▼  (hub handover)
PickupIntake  ── 1 ── Hub
   │ 1
   │ *
Order ── 1 ── VendorOrganization
   │ 1        1 ── Recipient (embedded)
   │ 0..1
DeliveryStop ──* ── 1 DeliveryRun ── 1 ── RiderIdentity
```

One `PickupRequest` yields one `PickupStop` per attempt. A failed attempt closes its request and links a replacement (§5.7). Collection produces one `PickupIntake` at the hub, and itemization explodes that intake into many `Order` records — this is the point where the vendor's declared package count becomes individually addressed delivery units, and where price first becomes authoritative (§5.2.1).

### 6.2 `PickupRequest`

Governed by §21, §34.3, §36.2. States: `PENDING`, `CONFIRMED`, `DECLINED`, `CANCELLED`.

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `code`| text| no| Operational code — `OQ-052`|
| `vendor_organization_id`| uuid| yes| Null for ad-hoc senders|
| `ad_hoc_sender_id`| uuid| yes| Exactly one of this and the above is set|
| `responsible_hub_id`| uuid| no| Reassignable **only** pre-collection (§34.9)|
| `state`| enum| no||
| `declared_package_count`| int| no| ≥ 2, except by approved exception below (§21)|
| `one_package_exception_id`| uuid| yes| Set when a one-package request was approved|
| `pickup_location`| embedded| yes| **The sender's own address**, per §3.5. **Null for `COLLECT_FOR_VENDOR`**, where the parcel is at a third party and the collection point carries the address.|
| `resolved_pickup_location`| embedded| no| **The one authoritative place the rider is sent** (Gate C R1.2). **Server-derived from `pickup_intent`**, never client-supplied, and **non-null on every persisted request**. Dispatch and the rider read this field and no other|
| `primary_phone` / `secondary_phone`| text| no / yes| §21.1 requires a primary and permits an optional secondary. E.164 plus as-entered, per §3.4|
| `item_description`| text| no| §21.1's required request information. Per-package description override is optional. **Its source differs by intent** (Gate C R1.2): captured per request for `ADHOC_SENDER`, satisfied by the Vendor's business goods profile for `OWN_PACKAGES`, and carried by `collection_item` for `COLLECT_FOR_VENDOR` — see the intent table below|
| `cutoff_exception_state`| enum| yes| `PENDING_OPS_REVIEW`, `SAME_DAY_APPROVED`, `RESCHEDULED`. Set when a request is confirmed past the hub cutoff — **not a rejection** (§21.1, `CONFLICT-024`)|
| `location_overrides`| embedded| yes| Request-level values that must not rewrite saved defaults (§34.3)|
| `scheduled_service_date`| date| no| Monday–Saturday only. §21.1 and §21.1, `MSC-DEC-149`: "every zone operates the same Monday–Saturday calendar"|
| `default_payer_intent`| enum| no| `RECIPIENT_PAYS`, `SENDER_PAYS_FULL`, `SPLIT`|
| `split_basis`| enum| yes| `FIXED_AMOUNT` or `PERCENTAGE`; set only when `SPLIT`|
| `split_sender_amount_minor`| int| yes| Set when `FIXED_AMOUNT`|
| `split_sender_percentage`| numeric| yes| Set when `PERCENTAGE`|
| `replaces_request_id`| uuid| yes| Attempt chain (§5.7)|
| `attempt_number`| int| no| Position in the chain. Capped by `MELARC_MAX_PICKUP_ATTEMPTS` = 3 (§35.4.5)|
| `attempt_extension_id`| uuid| yes| A hub Senior Ops force-extension past the cap (§21.6, `MSC-DEC-116`)|
| `cancellation_reason_snapshot`| embedded| yes| Reason label at time of selection (§3.7)|
| `cancelled_by_actor_type`| enum| yes| `VENDOR` or `OPS`. In V1 `VENDOR` occurs only from `PENDING`|
| `cancellation_charge_outcome`| enum| yes| `APPLIED`, `WAIVED`, `NOT_APPLIED`, `UNAVAILABLE`, `EXEMPT`. **All five are recorded outcomes** — the charge is discretionary, so its absence is a decision, never a null. **`EXEMPT` is not a discretionary outcome**: it records that the selected reason's `attribution` is `MELARC`, so no charge was permitted. Distinguishing it from `NOT_APPLIED` is the same argument that separates `UNAVAILABLE` from it — *Ops chose not to charge* and *the rule forbade charging* are different facts, and only one of them measures how often Melarc cancels on its own failure|
| `cancellation_charge_snapshot`| embedded| yes| Value, setting key and effective version, per §3.7. Set only when outcome is `APPLIED`|
| `cancellation_charge_reason_snapshot`| embedded| yes| **Mandatory whenever a post-assignment cancellation occurs**, whichever way the charge decision went|
| `cancellation_charge_waived_by`| uuid| yes| Senior Ops actor. Set only when outcome is `WAIVED`|
| `declared_value_minor`| int| yes| **Declared at booking** when the sender's item exceeds `value_declaration_threshold` (§23.4, `MSC-DEC-212`). Distinct from `Order.declared_value_minor`, which is §23.2's required capture at **itemization** — the two record the same fact at two moments, and the booking one is the moment the customer is told about the cap|
| `liability_cap_acknowledged_at`| timestamptz| yes| When the sender acknowledged that liability is capped **regardless of declared value** (§23.4, `MSC-DEC-220`). Mandatory whenever `declared_value_minor` exceeds the threshold|
| `liability_cap_snapshot`| embedded| yes| The cap **as it stood at acknowledgement** — value, setting key and effective version, per §3.7. **Not a pointer to the live setting.** A customer who acknowledged a GH₵300 cap acknowledged GH₵300; if the company later raises or lowers it, what they agreed to must not silently change underneath them|
| `created_at` / `confirmed_at` / `cancelled_at`| timestamptz| mixed||

**Invariants.**

- Exactly one sender reference is set.
- One request means **one origin and one scheduled pickup event** (§35.2.1).
- `declared_package_count ≥ 2` unless `one_package_exception_id` is present. That exception requires **maker-checker** and is **unavailable through ordinary vendor self-service** (§35.2.4) — a rule about who may take the path, not only about approval.
- Payer intent is *intent only*. It carries no monetary amount, because §5.2.1 confirms a standard request "does not yet contain parcel destinations or authoritative prices." Any model that **stores** a price here contradicts §5.2.1. `MSC-DEC-211` added an indicative estimate to the booking *response*; it is computed, not persisted, so this invariant survives the supersession of §23.6, `MSC-DEC-175` intact.
- `attempt_number` may not exceed 3 without an `attempt_extension_id`. Force-extension is hub Senior Ops, direct, reasoned and audited (§35.4.5, `MSC-DEC-116`).
- **A replacement request may not be simultaneously active with its source** (§35.4.3–4). Rescheduling creates a traceable chain rather than overwriting the failed attempt.
- Per-request contact and location edits are **transaction overrides** and never update saved sender defaults (§35.2.6, §21.1).
- **A one-package exception makes recipient name, phone and delivery address mandatory** (§21.1). **This no longer explains anything about pricing** — `MSC-DEC-211` says the distinction `MSC-DEC-178` drew *"disappears"* because **every** booking now shows an indicative estimate. The mandatory capture stands on §21.1 alone.
- **A declaration above `value_declaration_threshold` requires an acknowledgement, and the acknowledgement snapshots the cap** (§23.4, `MSC-DEC-212`, `MSC-DEC-220`). Storing only a flag would leave the customer agreeing to whatever the cap becomes later, which is the outcome `MSC-DEC-220` exists to prevent — it names the acknowledgement as mattering *more than evidence would*, precisely because the cap's weakness was a customer discovering the limit **after** a loss.
- **A suspended vendor's non-terminal requests go on controlled hold**, not to `CANCELLED` (§21.1). The hold preserves the record and its custody links.
- **Past the hub booking cutoff is not a rejection.** The request confirms and `cutoff_exception_state` queues it for Ops review (§21.1, `CONFLICT-024`).
- **In V1 a vendor may cancel only its own `PENDING` request**. Self-confirm and self-cancel-when-confirmed are deferred, not deleted — `MSC-DEC-195`'s assignment cutoff is dormant and governs the path when self-service returns.
- The request is **never terminally uncancellable.** Office cancellation remains available at every point.
- **A `MELARC`-attributed cancellation reason permits no charge**. The outcome is `EXEMPT`, set by the server from the reason's own `attribution` (§3.9) whatever the caller submitted, and the cancellation proceeds — the same principle as the missing-amount rule below: an operational decision is never blocked, and the commercial consequence is recorded rather than negotiated. `CUSTOMER` and `EXTERNAL` attribution leave Ops discretion exactly as `MSC-DEC-197` set it.
- **`cancellation_charge_outcome` is non-null for every post-assignment cancellation.** `UNAVAILABLE` covers a missing amount — **Accra is set at GH₵20, so this now covers a new hub rather than every hub**: the cancellation still proceeds and the absence is recorded. A null here would be indistinguishable from an unrecorded decision, which is the failure mode `MSC-DEC-197` exists to prevent.

### 6.3 `PickupManifest`

Governed by §34.3, §36.3. States: `DRAFT`, `DISPATCHED`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`.

| Field| Type| Null| Notes|
|---|---|---|---|
| `id` / `code`| uuid / text| no||
| `hub_id`| uuid| no| Hub-scoped, **never** vendor-owned (§4)|
| `assigned_rider_id`| uuid| **yes**| Null while `DRAFT`. **Setting it closes vendor self-cancellation on every request this manifest carries**|
| `assigned_at`| timestamptz| yes| The cutoff moment. Recorded, never inferred from manifest creation|
| `state`| enum| no||
| `service_date`| date| no||
| `dispatched_at` / `started_at` / `completed_at`| timestamptz| mixed| Dispatch and rider-start are distinct actors and distinct events (§36.3). **`completed_at` is set by the hub handover, or by System when nothing was collected**|

### 6.4 `PickupStop`

Governed by §34.3, §36.4. States: `PENDING`, `ARRIVED`, `COLLECTED`, `PARTIALLY_COLLECTED`, `FAILED`, `SKIPPED`.

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `pickup_manifest_id`| uuid| no||
| `pickup_request_id`| uuid| no||
| `sequence`| int| no| Manual stop ordering (§7.6 — no route optimisation)|
| `state`| enum| no||
| `arrived_at` / `resolved_at`| timestamptz| yes||
| `failure_reason_snapshot`| embedded| yes||

### 6.5 `CollectionRecord`

Governed by §34.3, §36.4, §36.5. One per stop that reached the door.

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `pickup_stop_id`| uuid| no| Unique — at most one per stop|
| `declared_count`| int| no| As stated by the sender at the door|
| `collected_count`| int| no| **Zero is a failed pickup** (§36.4) and may not accompany a `COLLECTED` stop|
| `variance`| enum| no| `MATCH` or `SHORT`. Present on every collection, not only partials — a clean count is a recorded outcome|
| `variance_reason_snapshot`| embedded| yes| Mandatory when `variance = SHORT`. Label snapshotted per §3.7|
| `office_notified_at`| timestamptz| yes| Set when the shortfall flag is raised (`MSC-DEC-194` part 2)|
| `handshake_type`| enum| no| `VENDOR_ENTERED_RIDER_DISPLAYED` or `SENDER_SMS_RIDER_ENTERED` (§34.3)|
| `handshake_channel`| enum| no| `PORTAL`, `SMS_FALLBACK`, `OPS_OVERRIDE`. **Recorded on every handshake, not only fallbacks** — persistent fallback use is only visible as data if the primary path is logged too|
| `handshake_override_by`| uuid| yes| Ops actor. Set only for `OPS_OVERRIDE`|
| `handshake_confirmed_at`| timestamptz| yes||
| `contact_captured`| embedded| yes| Per §3.4|

**Partial collection is permitted**. Variance lives here rather than on `PickupStop` because boundary decision §5.3 already assigns physical results to this record and run-level facts to the stop; declared and collected counts were here already.

**This variance does not substitute for the hub blind count.** `MSC-DEC-194` part 3 makes them two independent checks. `PickupIntake.rider_declared_count` is what the rider hands over — it is **not** seeded from, reconciled against, or short-circuited by `collected_count`, and a partially-collected consignment is counted blind at intake exactly like any other. A package lost between the door and the hub is visible only in the second check. Collapsing them destroys the guarantee §35.5 exists to provide.

### 6.6 `PickupIntake`

Governed by §22, §34.4, §36.6. States: `AWAITING_COUNT`, `COUNTED`, `RECONCILIATION_REQUIRED`, `READY_FOR_ITEMIZATION`, `ITEMIZING`, `CLOSED`.

| Field| Type| Null| Notes|
|---|---|---|---|
| `id` / `code`| uuid / text| no||
| `hub_id`| uuid| no||
| `pickup_request_id`| uuid| no||
| `pickup_manifest_id`| uuid| no| The run whose hub handover opened this intake — §22.3's handover and run identifiers|
| `handed_over_by`| uuid| no| The custody holder who submitted the handover — the assigned rider, or whoever accepted a `RunCustodyHandover`|
| `handed_over_at`| timestamptz| no| Server receipt of the handover — §22.3's submission timing|
| `declaration_captured_at`| timestamptz| no| When the rider made the declaration on the device — the field time, **distinct from `handed_over_at`** (§35.3.9). Client-supplied, as `Evidence.captured_at` is, because the handover is Version 1's one queued offline command|
| `state`| enum| no||
| `rider_declared_count`| int| no| **Must not be readable** before blind count submission (§36.6, §43.2). Captured at handover — **never seeded from `CollectionRecord.collected_count`** (`MSC-DEC-194` part 3). **Zero is legal** for a collected request the rider could not hand over, and routes the intake to reconciliation after the blind count|
| `physical_count`| int| yes| The blind count|
| `counted_at` / `counted_by`| timestamptz / uuid| yes||
| `count_variance`| enum| yes| `MATCH`, `SHORT`, `OVER`. **An enum, not a number** — §35.5.4 requires condition and dispute findings to be recordable "even when count variance is `MATCH`", which needs a comparison outcome distinct from the numeric difference|
| `count_difference`| int| yes| The signed numeric difference, carried alongside the outcome|
| `condition`| enum| no| `OK`, `DAMAGED`, `TAMPERED`, `OTHER` — a **fixed** four-value enum (§22.5), not configurable. `DAMAGED` and `TAMPERED` require supporting evidence and senior review|
| `condition_findings`| embedded[]| yes| Detail behind a non-`OK` condition. Independent of `count_variance` (§35.5.4)|
| `dispute_state`| enum| yes| Independent of both. Three OS&D dimensions never collapse (§34.4, §35.5.4)|
| `closed_at`| timestamptz| yes| Parity and validation must pass (§36.6, §35.5.5)|
| `parity_exception_id`| uuid| yes| The "approved exception process" §35.5.5 permits as the only way to close without parity. §23.10: an override requires a substantive reason and appropriate authority|
| `active_receiver_id` / `lock_acquired_at`| uuid / timestamptz| yes| The **advisory soft lock** §22.8 approves — shows who is receiving and permits takeover after an idle TTL. §22.8 is explicit that a visual lock alone is insufficient; backend transition and idempotency controls are still required|

**One intake per collected pickup request, and the handover is recorded on them**. The hub handover is not an entity of its own: `submitHubHandover` opens one intake per collected request on the run and stamps each with the run, the custody holder who submitted, the server's receipt time and the device's capture time. **No intake for a request with nothing collected** (§22.2), and **every collected request on a completed run has exactly one**.

**The blind-count invariant is a data-exposure rule, not a UI rule.** §35.5.2 is explicit that "the system must not reveal **or require the frontend to submit** the rider-declared count before the physical count is committed," and §43.2 states the criterion: the declared count "is not returned in the editable/view model used before submission." A frontend that merely hides it fails, because the value is in the payload — and a design that asks the frontend to echo it back fails for a second, independent reason.

**A `PAYMENT_REQUIRED` order still counts toward physical parity.** §35.6.11 says so directly, and it is the easiest rule here to get wrong: parity counts *physical parcels itemized*, not orders cleared for dispatch. An implementation that counts only dispatch-ready orders will refuse to close intakes that are correct.

**Two users must not be able to close or mutate the same intake inconsistently** (§35.5.6). See §7.

### 6.7 `Order`

Governed by §23–§28, §34.4, §34.6, §36.7. Per `MSC-DEC-187`, the single itemized delivery unit.

`MSC-DEC-187` fixes the noun; §36.7 authorises this document to publish the enum. Per §5.9 an order carries **two** state fields:

**`commercial_state`** — from §36.11, extended by `MSC-DEC-244`. `PRICED` · `PAYMENT_REQUIRED` · `CREDIT_RESERVED` · **`NO_VENDOR_CHARGE`** · `PREPAID` · `CLOSED` · `REVERSED`

**`fulfilment_state`** — from §36.9, plus the §36.7 milestones the delivery progression does not cover. `AWAITING_RECIPIENT_CONFIRMATION` · `READY_FOR_DISPATCH` · `ASSIGNED` · `OUT_FOR_DELIVERY` · `DELIVERED` · `ATTEMPT_FAILED` · `AT_HUB_AFTER_FAILURE` · `READY_FOR_REATTEMPT` · `HANDED_TO_CARRIER` · `RETURN_TO_VENDOR_IN_PROGRESS` · `RETURNED_TO_VENDOR`. **`CANCELLED` withdrawn 14 September 2026** — produced by no transition and no operation, required by §36.9 nowhere, cited by no feature, surface or slice. Termination of a real order disposes of a physical parcel and is Return-to-vendor

`READY_FOR_DISPATCH` rather than `DISPATCH_READY`, per `CONFLICT-021`.

Transitions, guards and terminal rules are in [state-machines.md](state-machines.md). Terminal states are mode-specific per `MSC-DEC-181`, which is why `HANDED_TO_CARRIER` is terminal for `STATION_DROP` and is not for `MELARC_COVERED_THIRD_PARTY_DELIVERY`.

| Field| Type| Null| Notes|
|---|---|---|---|
| `id` / `code`| uuid / text| no||
| `pickup_intake_id`| uuid| no||
| `vendor_organization_id` / `ad_hoc_sender_id`| uuid| yes| Inherited from the request; exactly one set|
| `responsible_hub_id`| uuid| no| Not reassignable — custody has begun (§34.9)|
| `commercial_state`| enum| no| §36.11. Orthogonal to fulfilment (§5.9)|
| `fulfilment_state`| enum| no| §36.9|
| `recipient`| embedded| no| Name, phone per §3.4, location per §3.5|
| `origin_zone_snapshot`| embedded| no| **Inherited from the request, not resolved per order.** §23.3: resolved and snapshotted **once per request**. **No longer a pricing input** — the base fee is independent of origin. Retained because reporting and dispute adjudication need to know where a parcel was collected|
| `destination_zone_snapshot`| embedded| no| Resolved and snapshotted **per parcel** at itemization (§23.3). Still resolved, but now answers **serviceability and service area** — is this address served, on which days — rather than supplying half a matrix lookup|
| `declared_value_minor`| int| yes| §23.2 required capture. **The input that auto-flags high value** against the first configured tier (§23.4)|
| `is_serialized_goods`| bool| no| Electronics or serialized goods (§23.2)|
| `serial_imei`| text| yes| **Mandatory when `is_serialized_goods`** (§23.2, §23.4)|
| `service_level`| enum| no| §23.2. Version 1 has **no express service** — one level only (§23.7)|
| `requested_delivery_date`| date| yes| §23.2|
| `size_class`| enum| no| `SMALL`, `MEDIUM`, `LARGE` — renamed from `size_band`; `EXTRA_LARGE` withdrawn. `SMALL` = GH₵0. **Applies only to `MELARC_COVERED_THIRD_PARTY_DELIVERY`** — doorstep within the service area and `STATION_DROP` are flat regardless of size. This **inverts** §35.6.9, which exempted the third-party mode and charged everything else|
| `size_class_selected_by`| uuid| yes| The receiving officer who **selected** the class at itemization. Not derived — `MSC-DEC-209` establishes no weight or dimension thresholds, so this is a recorded human judgement. Null until itemization. Its presence is what makes a GH₵20 disagreement between two officers adjudicable rather than merely arguable|
| `carrier_cost_minor`| int| yes| The third-party carrier's **actual** charge, entered at itemization from the carrier's own waybill. Non-null exactly when `commercial_mode = MELARC_COVERED_THIRD_PARTY_DELIVERY`. **An observed fact with a receipt behind it, not a quoted price** — which is why the client may submit it without breaching the server-calculates-price guard|
| `derived_delivery_date`| date| yes| Next working day after pickup, skipping Sunday, so a Saturday pickup delivers Monday. Corridor batch days override the derivation|
| `delivery_date_override`| embedded| yes| Ops-moved date with actor, reason and timestamp. Its absence means the derived date stands — the two fields together are what make the next-day promise checkable rather than remembered|
| `is_high_value`| bool| no| Auto-flagged from `declared_value_minor`, **or manually flagged by Ops on a lower-value parcel** (§23.4). Requires verified itemization-time evidence. **The "no liability promise" clause of `MSC-DEC-156–157` is superseded by `MSC-DEC-212`**, which caps liability at `liability_cap_amount` and requires declaration above `value_declaration_threshold`. Whether the high-value *surcharge* still has a purpose under a cap is `OQ-062` — **do not implement a surcharge against this flag until that closes**|
| `destination_zone_resolution`| enum| no| `SERVER_RESOLVED` or `EXPLICITLY_AUTHORIZED`. §35.6.6: "free-text address alone is not authoritative"|
| `reprice_history`| embedded[]| yes| Post-freeze zone-crossing corrections (§35.6.8) — see invariants|
| `lane`| enum| no| `DOORSTEP` or `THIRD_PARTY_HANDOFF` (§5.4)|
| `commercial_mode`| enum| yes| `STATION_DROP` or `MELARC_COVERED_THIRD_PARTY_DELIVERY`; null when `DOORSTEP` (§5.4)|
| `carrier_identity`| embedded| yes| Registered courier or informal carrier (§5.4)|
| `locked_price_minor`| int| yes| Frozen at confirmation (§34.6); null until itemization prices it|
| `price_components_snapshot`| embedded| yes| Each component carries **hub, setting key, version and value** (§3.7). Components: service-area base fee **or** corridor off-day fee **or** station-drop fee; size-class surcharge (third-party mode only); carrier cost and applied margin (third-party mode only). The zone-pair rate and corridor batch/non-batch/intra structure are **withdrawn**|
| `payer_allocation`| embedded| no| Resolved sender and recipient portions (§5.2.1). **`sender_minor == 0` drives `commercial_state` to `NO_VENDOR_CHARGE`** — the guard reads this resolved amount, never `PickupRequest.default_payer_intent`, because a 0% split and a parcel-level override reach the same place as `RECIPIENT_PAYS`|
| `payer_override_applied`| bool| no| Parcel-level override of request intent (§5.2)|
| `delivery_attempt_count`| int| no| **Physical doorstep attempts only, incremented where the failure reason consumes one**. **History and audit, never a gate** — no fixed maximum exists, and each further trip is a scheduled `Redelivery`.|
| `return_fee_minor`| int| yes| Earned at formal return-workflow start (§5.2.4)|
| `confirmed_at` / `delivered_at` / `terminal_at`| timestamptz| mixed||

**Invariants.**

- `locked_price_minor` is immutable once set. Corrections require the "approved reasoned maker-checker workflow and audit history" of §35.6.7 and create a linked adjustment, never a rewrite.
- **A post-freeze address correction that crosses a pricing zone triggers repricing** — Ops-requested, hub-Senior-Ops-approved, with full history *and affected-party notification* (§35.6.8). The notification is part of the rule, not a courtesy. Recorded in `reprice_history`.
- `commercial_mode` is non-null exactly when `lane = THIRD_PARTY_HANDOFF`. Every outbound order has exactly one authoritative mode (§35.7.6).
- An order may not enter `READY_FOR_DISPATCH` unless `commercial_state ∈ {CREDIT_RESERVED, PREPAID, NO_VENDOR_CHARGE}` (`MSC-DEC-176`, §35.6.10, `MSC-DEC-244`).
- **Outbound orders carry a second, separate prepayment gate.** §35.7.7 and §35.7.8 forbid dispatching `STATION_DROP` until the effective fee snapshot is backend-confirmed **paid**, and `MELARC_COVERED_THIRD_PARTY_DELIVERY` until the combined waybill-plus-Melarc charge is confirmed paid. This is distinct from the vendor credit gate and is not satisfied by it.
- `delivery_attempt_count` carries **no ceiling and starts nothing**: a further trip is a scheduled `Redelivery`, and formal Return begins only when authorised Ops commits a `ReturnRecord`.
- **The three pricing states are now two.** §35.6.5's no-estimate, provisional-estimate and frozen-price states lose the first: `MSC-DEC-211` withdrew the no-estimate rule, so every booking shows an indicative estimate. The surviving two must remain **visibly distinct and historically preserved with their pricing inputs and version**.
- `size_class_selected_by` is non-null whenever `size_class` is set. A class with no recorded selector is invalid — a discretionary judgement that changes revenue must name the person who made it.
- `carrier_cost_minor` is non-null **exactly when** `commercial_mode = MELARC_COVERED_THIRD_PARTY_DELIVERY`, and null otherwise. A carrier cost on a doorstep order is a data error, not an unusual case.
- **An order cannot be priced while `outside_accra_margin` is unset** for its hub. §33.4 forbids borrowing a value, and pricing at cost would ship the order at zero margin silently. The order is refused, not priced. **Accra is set at GH₵30 flat**; the invariant governs every hub after it.
- Every entry in `price_components_snapshot` names its **hub**. A component without one cannot be reconciled once two hubs' version counters diverge (§3.7, `MSC-DEC-218`).

### 6.8 Identity and access

Governed by §11.2, §37.2, §37.3, §37.5, §30.3, §30.4, §34.12. §6.9 named these entities and deferred field detail to Phase 4; `SLICE-000` is that phase for the identity set.

**`StaffIdentity` was missing a state until 24 August, and the citation line above records why.** This section originally cited §30.3, §30.9 and §30.10 — lifecycle, suspension, offboarding — and **not §30.8**, which is the section naming who brings a staff record into existence. The enum that resulted could not hold a created-but-unapproved profile, so §30.8's maker-checker was inexpressible in the contract. [engineering-standards.md](../standards/engineering-standards.md) §8.1 names this failure and was written after `CONFLICT-028`, which was the same mistake against §41.

**`Session` is new here.** It was named nowhere in §6.9, yet §37.2 makes session behaviour a confirmed product rule — one active vendor session, a new login ending the earlier one, elevation bounded in time. **A rule about sessions with no session entity cannot be enforced**, so the omission was load-bearing rather than cosmetic.

#### `Session`

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `principal_type`| enum| no| `STAFF` · `RIDER` · `VENDOR`. **Three authentication models that never mix** (§37.3)|
| `principal_id`| uuid| no| `StaffIdentity`, `RiderIdentity` or `VendorAccount`|
| `bundle_snapshot`| embedded| no| The `RoleBundle` held **at issue**, not a reference. Resolving live would show today's authority against yesterday's action — the same rule [audit.md](audit.md) §4 applies to `actor_bundle`|
| `authorized_hub_ids`| uuid[]| no| Resolved at issue from primary membership plus any effective `HubAssignment` (§5.8). Ordinary staff are hub-restricted (§37.3)|
| `registered_device_id`| uuid| yes| Non-null for `RIDER` and `VENDOR`; null for `STAFF`|
| `client_root_signal`| enum| yes| `NOT_DETECTED` · `DETECTED` · `UNKNOWN`. **Rider only; null for staff and vendor.** The app's own root-detection result, recorded at issue for Ops follow-up. **A risk signal and never an authentication control:** `DETECTED` does not by itself block sign-in, `NOT_DETECTED` is not evidence the device is trustworthy, and `UNKNOWN` means the client could not establish a result|
| `token_hash`| text| no| **A cryptographic hash of the opaque session secret**. The raw secret is **never persisted**|
| `issued_at`| timestamptz| no||
| `expires_at`| timestamptz| no| Absolute expiry from `session_lifetime_minutes` — per-tier|
| `last_activity_at`| timestamptz| **no**| **Non-null for every session, initialised at issue** (R1). `session_idle_timeout_minutes` previously had nothing to evaluate against. **Rider sessions record it and are never terminated by it** — the rider tier has no idle rule, which is a rule about *evaluation*, not about the field|
| `csrf_token_hash`| text| yes| Hash of the synchronizer token issued alongside a **browser** session. Null for rider sessions, which use Bearer transport and are not CSRF-exposed|
| `terminated_at`| timestamptz| yes||
| `termination_reason`| enum| yes| `SIGNED_OUT` · `SUPERSEDED_BY_NEW_LOGIN` · **`REPLACED_BY_NEW_SESSION`** · `EXPIRED` · `CREDENTIAL_CHANGED` · `SUSPENDED` · `OFFBOARDED` · `ADMIN_REVOKED` · `AUTHORITY_CHANGED` · `HUB_SCOPE_CHANGED` · `DEVICE_REVOKED` · **`DEVICE_REPLACED`** · `MFA_RESET`|

**Invariants.**

- **A `VendorAccount` has at most one live session.** A successful login **terminates the earlier session** with `SUPERSEDED_BY_NEW_LOGIN` (§11.2, §37.2). This is not a race to resolve — it is the specified behaviour, and the earlier device must learn it was displaced rather than fail silently on its next call.
- **A `RiderIdentity` has at most one live session, bound to its one registered device** (§37.2).
- **A Senior Ops or Platform Admin session cannot exist without a completed second factor**. **The factor that must exist is an `ACTIVE` `MfaFactor` proven during this sign-in** — not a boolean, and not a factor merely enrolled. MFA gates sign-in for those roles, so there is no unprivileged privileged session and no elevation state.
- **A privileged session is privileged for its whole lifetime**, and two controls now bound that exposure (`MSC-DEC-234`, closing `OQ-071`). Both are **per-tier**: `session_lifetime_minutes` is 480 for Senior Ops and Platform Admin, and `session_idle_timeout_minutes` is **15**. The idle control is the operative one — the exposure is an unattended browser, which an absolute lifetime cannot distinguish from a user who is working.
- A credential change **terminates every session** for that principal with `CREDENTIAL_CHANGED`. §37.5 requires recovery to "revoke or control prior sessions" — for the shared vendor credential this is the whole point of recovery.
- Suspension terminates sessions with `SUSPENDED` (§37.3, §30.9).
- **The session credential is opaque and only its hash is stored**. The raw secret exists at generation, in transit, and on the client — never in the database, application logs, audit payloads, diagnostics, analytics or exception telemetry.
- **Transport is fixed per surface**. Ops Portal and Vendor PWA receive the secret in an **`HttpOnly`, `Secure`, `SameSite=Lax`** cookie that browser JavaScript never reads; Melarc Rider receives the same class of secret as a **Bearer** credential held only in Android OS-backed secure storage.
- **A browser session expires on idle as well as absolutely.** `now − last_activity_at > session_idle_timeout_minutes` ends it with `EXPIRED`. **Rider sessions maintain the field and are never terminated by it** — the exemption is from *evaluation*, not from recording, which is why the column is non-null for every principal type. Implementations may coalesce activity writes; the observable rule must stay exact.
- **A rider holds one session, and replacing it is not the vendor's displacement**. A successful rider re-authentication terminates the prior session with **`REPLACED_BY_NEW_SESSION`**, and the displaced handset receives an ordinary `401 SESSION_INVALID` on its next call. **`SESSION_SUPERSEDED` is never shown to a rider**: it exists so a vendor colleague can tell displacement from expiry on a shared credential, and a rider replacing their own session on their own registered handset has nobody to distinguish from.
- **A vendor sign-in proves three factors, not two**. Account identifier, shared secret **and** a valid `melarc_vendor_device` cookie. **The credential was issued at setup and required by nothing until R1.2**, so a stolen shared secret alone signed in from any browser — the exact outcome the device credential was introduced to prevent. Ordinary sign-in **proves** it and never re-issues it; only setup and recovery register a browser.
- **A cookie-authenticated unsafe request carries a synchronizer token**. The raw CSRF token is issued in a **readable** `melarc_csrf` cookie, echoed in `X-CSRF-Token`, and compared against `csrf_token_hash`; the `Origin` is validated as well. **Only the hash is stored** — the same rule the session credential follows. Rider Bearer requests are not CSRF-exposed and carry no token.
- **The contract requires the token structurally, not by mention**. `csrfToken` is an OpenAPI **security scheme** composed with `browserSession`, so an unsafe browser operation that omits it fails a mechanical check. Listing `CSRF_VALIDATION_FAILED` among an operation's error codes while leaving the token optional documents a control without imposing one.
- **A raw Session credential never appears in an ordinary `Session` resource representation**. Browser credentials travel only as `Set-Cookie`. **Rider issuance returns the opaque Bearer credential exactly once**, in `RiderSessionIssued`, because a native client has no `Set-Cookie` equivalent. The earlier phrasing — *never in a response body* — read as an absolute and was contradicted by the one response that must return it; the distinction is between a **resource** representation and an **issuance** response.
- **Revocation is a state change on this record and nothing else** (Gate PD-3R1). An administrative revocation, a device revocation, a suspension, a credential change and an authority change each set the session `TERMINATED` with their reason **in the same transaction as the act that caused them**, and every request looks the session up by `token_hash`, so the next request is refused. There is no blocklist, no cache and no second store between the decision and its effect (`SECURITY_DESIGN.md` §15.3).
- **A security-relevant authority change terminates the session immediately**. Bundle change, hub-scope change, suspension, offboarding, credential change, MFA reset, device revocation or replacement, and administrative revocation each end live sessions with the matching reason. **The snapshot is what makes this necessary**: `bundle_snapshot` is correct history and would otherwise carry withdrawn authority for the rest of the session's life.
- **The session token is never stored, logged, or written to an audit event.** §20.4's OTP rule applies identically; audit records that a session was issued, never its material.

#### `StaffIdentity`

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `work_email`| text| no| **Unique and verified**, unique in the canonical form below, and **released when the profile is `REJECTED`**. Also the recovery channel (§37.2)|
| `full_name`| text| no||
| `phone`| text| yes| E.164 per §3.4|
| `status`| enum| no| `PENDING_APPROVAL` · `ACTIVE` · `REJECTED` · `SUSPENDED` · `OFFBOARDED` (**§30.8**, §30.3, §30.9, §30.10). Machine at [state-machines.md](state-machines.md) §13.3|
| `role_bundle_id`| uuid| no| One bundle. §11.1, `MSC-DEC-133`: authorization tests the **permission**, never this id|
| `primary_hub_id`| uuid| yes| Null for HQ roles with cross-hub authority (§37.3)|
| `mfa_enrolled`| bool| no| **Derived and read-only**: true exactly when an `ACTIVE` `MfaFactor` exists. **Never caller-settable or seed-settable**, and never accepted as proof of MFA in place of the factor.|
| `credential`| embedded| **yes**| Hashed with Argon2id. **Null until the employee establishes it** through a `SetupGrant` — the maker who creates the identity does not choose, know or supply it. **Never retrievable, never logged.** **It also carries the lockout state — `failed_attempt_count` (integer, default 0) and `locked_until` (timestamp, null) — described under *Failed attempts and lockout* below. Neither is ever returned and neither is part of the record's version**.|
| `permission_review_history`| embedded[]| no| §30.3 requires it — bundle changes with actor, reason and timestamp|
| `created_by`| uuid| no| The §30.8 **maker**. Retained after approval — the same-actor exclusion is unverifiable without it|
| `approved_by`| uuid| yes| The §30.8 **checker**. Non-null exactly when `status` has left `PENDING_APPROVAL`|

**Invariants.**

- **A privileged bundle may be assigned before MFA is enrolled; a privileged *session* may not be issued before it is**. The former requirement was circular — a new employee could not enrol a factor without authenticating and could not authenticate without the factor — and its only exit was an administrator setting a boolean by hand.
- **Authentication readiness is derived, not stored.** An identity is authentication-ready when `status = ACTIVE`, `credential` is established, and — for a privileged bundle — an `ACTIVE` `MfaFactor` exists. **No mutable readiness flag exists**: a flag is a second source of truth that can disagree with the records it summarises, which is the failure `mfa_enrolled` itself demonstrated.
- **Being approved and being able to authenticate are different conditions.** An `ACTIVE` identity that has not completed setup grants **zero authenticated access**.
- **`approved_by` is non-null exactly when `status` is not `PENDING_APPROVAL`, and never equals `created_by` — except on the two seeded bootstrap records, where both hold the reserved system actor** (`MIGRATION_AND_SEEDING.md` §3.2, `MSC-DEC-440`). §30.8: "the creator cannot approve their own profile creation." Holding both actors on the record is what makes that exclusion **checkable after the fact** rather than only at the moment of the call — an approval that bypassed it is otherwise indistinguishable from one that did not.
- **A `PENDING_APPROVAL` identity grants nothing.** No session may be issued against it ([state-machines.md](state-machines.md) §13), and its `role_bundle_id` confers no permission until approval. The field is populated at creation because §30.8 has the checker approve the person **and** their authority in one act.
- `OFFBOARDED` is terminal. §30.10 offboarding does not delete — history must survive (§35.1.5).
- **A work email has one canonical form** (Product decision, 6 October 2026): the address is **trimmed, normalised to Unicode NFKC and lower-cased as a whole**. It is **stored and displayed as entered**, and **no dot or plus-tag folding is applied**. The canonical form decides uniqueness (`WORK_EMAIL_IN_USE`) and is the key of the staff sign-in rate limit ([settings.md](settings.md) §7.7). **The address is canonicalised first and only then checked to be an email address** (`VALIDATION_FAILED` when it is not), so the contract's schema carries no `format: email` for it.
- **A `REJECTED` profile releases its work email.** Uniqueness holds among identities that are not `REJECTED`, so a new profile may use the address ([state-machines.md](state-machines.md) §13.3).
- Cross-hub access requires an explicit grant and **is audited** (§37.3).

#### `MfaFactor`

Added 26 August by `MSC-DEC-262`. **This record, not a boolean, is the authority on whether a privileged identity has a second factor.**

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `staff_identity_id`| uuid| no| Owner. Privileged staff only in Version 1|
| `factor_type`| enum| no| `TOTP`. **SMS is deliberately not a privileged factor**|
| `status`| enum| no| `PENDING` · `ACTIVE` · `REVOKED`. Machine at [state-machines.md](state-machines.md) §18|
| `secret`| embedded| no| **Encrypted, not hashed.** Verification requires recomputing codes from it|
| `enrolled_at`| timestamptz| yes| Non-null from `ACTIVE`|
| `revoked_at`| timestamptz| yes||
| `last_verified_counter`| text| yes| Replay protection — the time step most recently accepted|

**Invariants.**

- **At most one `ACTIVE` factor per identity.** Enrolling a replacement revokes the previous one.
- **`PENDING` grants nothing.** A factor becomes `ACTIVE` only when a generated code has been **successfully proven**, so an abandoned enrolment never counts as MFA.
- **The secret is encrypted and never persisted or logged in plaintext**. It is the one credential here that cannot be hashed, because the server must recompute from it. Key custody belongs to the secret-management layer; **Gate B** hardens that architecture and this prohibition binds regardless of its outcome.
- **A code may not be accepted twice within its window.** A TOTP code is valid for a period, and replaying it inside that period defeats the factor for the length of the window.
- **Revocation terminates every session for the owner** with `MFA_RESET`.

**Why TOTP and not SMS.** It works when SMS providers are unavailable, costs nothing per challenge, does not depend on SIM security, and works offline. SMS remains right for operational OTPs to recipients outside Melarc — where the alternative is nothing — and is the weaker choice for the credential protecting the most powerful accounts. **It also means `OQ-048`'s unresolved SMS provider does not block privileged authentication.**

#### `MfaChallenge` and `RiderSignInChallenge`

Added 27 August by `MSC-DEC-268`. Gate A wrote both challenges with **no lifetime and no consumption rule**.

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `principal_type` / `principal_id`| enum / uuid| `principal_id` **yes, for a rider challenge**| **A rider challenge issued to a number that matched no rider has a null `principal_id`** (§37.7): it is created and behaves like any other, and its sign-in fails at the same step as a wrong signature. An MFA challenge always has both|
| `issued_at`| timestamptz| no||
| `expires_at`| timestamptz| no| `authentication_challenge_ttl_minutes` — **5**|
| `state`| enum| no| `PENDING` · `CONSUMED` · `EXPIRED` · `UNUSABLE`|
| `attempt_count`| int| no| **MFA only.** Against `mfa_max_attempts` = 3|
| `nonce_hash`| text| yes| **Rider only.** The nonce to be signed, stored hashed|
| `phone_hash`| text| yes| **Rider only.** A hash of the normalised number the challenge was requested for, **a number that matches no rider included**. `riderSignIn` must present the same number, or the challenge is `CHALLENGE_UNUSABLE` for every number alike. Never the number itself|

**Invariants.**

- **An MFA challenge survives up to three wrong codes and then becomes `UNUSABLE`** (`mfa_max_attempts`, `MSC-DEC-236`). A correct code consumes it. **Each wrong code also adds one to the identity's `failed_attempt_count`**, shared with the password, so a thief who knows the password cannot guess codes across fresh challenges.
- **A rider challenge is consumed by a *failed* signature as well as a successful one**. A nonce that survives a bad signature is an oracle to hammer; requiring a fresh challenge per attempt routes every attempt through the rate limiter.
- **`EXPIRED` and `UNUSABLE` are different terminal states** because they tell the client different things — start again, versus this one is finished.
- **Issuance discloses nothing.** A rider challenge is issued identically whether or not the number belongs to a registered rider (§37.7). **It is bound to the number it was issued for** (`phone_hash`), so it cannot be presented with another.

#### `SetupGrant`

Added 26 August by `MSC-DEC-259`, `MSC-DEC-260` and `MSC-DEC-265`. **The record that makes initial credential establishment executable** — without it, every first credential had to be written by an administrator.

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `principal_type` / `principal_id`| enum / uuid| no| `STAFF` · `RIDER` · `VENDOR`|
| `purpose`| enum| no| `STAFF_CREDENTIAL_SETUP` · `MFA_ENROLMENT` · `MFA_REENROLMENT` · `BOOTSTRAP_SETUP` · `RIDER_DEVICE_ENROLMENT` · `RIDER_DEVICE_REREGISTRATION` · `VENDOR_CREDENTIAL_SETUP` · **`VENDOR_DEVICE_ENROLMENT`** — **eight**. The eighth registers an **additional browser** on an account that already has one, and it is the purpose [vendor-authentication.md](../features/identity/vendor-authentication.md) §5.5 has named since 13 September against an enum that did not hold it|
| `token`| embedded| no| **Cryptographically random, stored hashed, never returned after issue and never logged**|
| `issued_at`| timestamptz| no||
| `expires_at`| timestamptz| **yes**| From `recovery_link_ttl_minutes` — **30 minutes**. **Null only for `BOOTSTRAP_SETUP`**|
| `state`| enum| no| `PENDING` · `CONSUMED` · `EXPIRED` · `SUPERSEDED`. Machine at [state-machines.md](state-machines.md) §19|
| `issued_by`| uuid| yes| Null for system-issued; the authorising actor for an administrative reset|
| `attestation_challenge_hash`| text| yes| **Set only for `RIDER_DEVICE_ENROLMENT` and `RIDER_DEVICE_REREGISTRATION`**. A hash of the single-use attestation challenge issued with the grant and delivered in the same QR; **the raw challenge is never stored and never logged**, exactly as for `token`. It lives and dies with the grant: the same lifetime, the same single use, and superseded with it|
| `consumed_at`| timestamptz| yes||

**Invariants.**

- **Single use.** Consuming sets `CONSUMED`; a second attempt fails. A reused grant is a signal, not a retry — the rule `RecoveryRequest` already carries.
- **Purpose-bound and principal-bound.** A grant issued for MFA enrolment cannot set a password, and a grant for one identity cannot act on another. **A grant is not a session** and confers no business authority whatever.
- **Issuing a new grant supersedes any `PENDING` grant of the same purpose** for that principal.
- **The existing 30-minute window is reused rather than a new figure invented**. Do not invent a configured interval; a second security-link lifetime would be a value nobody set.
- **`BOOTSTRAP_SETUP` has no expiry, and that is deliberate**. A clock that can strand provisioning leaves an environment nobody can sign into.
- **A bootstrap administrator cannot be stranded by an expired continuation** (`MSC-DEC-272`; there are two bootstrap identities, `MSC-DEC-440`, and each is covered separately). If the `MFA_ENROLMENT` grant lapses before a code is proven, a **provisioning-only** mechanism outside the business API issues a fresh `MFA_REENROLMENT` authorisation to the affected seeded bootstrap identity. It **does not resurrect `BOOTSTRAP_SETUP`** — a single-use credential that can be revived is not single-use — and grants no session, no factor and no password.
- **`BOOTSTRAP_SETUP` is consumed at password establishment and never presented twice**. A **separate short-lived `MFA_ENROLMENT` continuation grant** carries the enrolment step. The previous sequencing required a *single-use* grant at both steps, which is the one thing a single-use grant cannot do.
- **The continuation grant may expire where the bootstrap secret may not.** If it lapses, the identity still holds an established password and a `PENDING` factor and a fresh grant re-enters the flow — **the unrecoverable state the no-expiry rule protects against is not reachable from there.**
- **`MFA_ENROLMENT` is the only purpose that activates a factor**. Three purposes *create* a `PENDING` factor — `STAFF_CREDENTIAL_SETUP`, `BOOTSTRAP_SETUP` and `MFA_REENROLMENT` — and each issues an `MFA_ENROLMENT` continuation grant. **`BOOTSTRAP_SETUP` must never activate one**: it is the single grant with **no expiry**, and letting it activate would leave a deployment-channel secret able to install a second factor at any later date.
- **`MFA_REENROLMENT` never activates a factor.** It authorises *beginning* re-enrolment, which returns provisioning material and issues an `MFA_ENROLMENT` continuation grant; only that second grant plus a **proven** code activates the factor. Two grants because the two acts have different consequences, and one grant that did both could activate a factor on evidence that was only ever a reset authorisation.
- **`STAFF_CREDENTIAL_SETUP` and `BOOTSTRAP_SETUP` also create a `PENDING` factor**, at password establishment. **`MFA_ENROLMENT` is the only purpose that activates one.** Three purposes create, one activates — see [state-machines.md](state-machines.md) §18.
- **`SetupGrant` establishes authentication capability; `RecoveryRequest` repairs an existing credential.** That is the whole boundary, and it decides every case (R1.3). A first password, a first shared secret, an MFA factor, a device binding — `SetupGrant`. Replacing a password or shared secret somebody already has — `RecoveryRequest`, whether the principal asked or a Platform Admin initiated it.
- **`VENDOR_CREDENTIAL_RECOVERY` was withdrawn from the purpose enum by R1.3.** The exceptional vendor path claimed to issue it, returned a `RecoveryRequest`, and directed the vendor to a consumer that reads recovery tokens and reports `RECOVERY_TOKEN_INVALID`. **Three names for one act**, and two parallel token machines governing the same credential is a guarantee they will drift apart.
- **Delivery is fixed by purpose, not by a universal rule**. Verified work email for staff setup; the registered channel for vendor setup; the **controlled provisioning channel** for `BOOTSTRAP_SETUP`; **returned in-transaction** for the `MFA_ENROLMENT` continuation grant; and a **scanned QR** on the Ops Portal screen for the two rider device purposes. The machine's §19.1 carries the table.
- **`BOOTSTRAP_SETUP` uses the provisioning channel for a reason, and it is not that the principal is absent.** The seed has already created the two bootstrap `StaffIdentity` records. **First-administrator setup must not depend on ordinary user-controlled or verified application delivery** — there is no verified work email yet, and trusting one would let whoever provisioned the environment nominate the destination of the highest-authority credential in the system.
- **`MFA_REENROLMENT` has one purpose and two authorised transports.** Verified work email for an ordinary administrative reset; the **controlled provisioning channel** for the bootstrap-resume mechanism under `MSC-DEC-272`. **Purpose describes what a credential may authorise; transport describes how the authorised principal receives it** — a second purpose invented for a second delivery route would fragment the enum without adding a rule.
- **The rider enrolment grant reaches the handset by QR scan**. It is rider-bound, purpose-bound, single-use, carries the ordinary 30-minute lifetime, is served with `Cache-Control: no-store`, and is **excluded from logs, analytics and audit payloads**. Senior Ops displays it and never learns the rider's PIN, private key or session credential.

#### `RiderIdentity`

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `phone`| text| no| **Unique, E.164.** §30: rider phone **must not collide with an ad-hoc sender identity**|
| `full_name`| text| no||
| `status`| enum| no| `ACTIVE` · `INACTIVE` · `TEMPORARILY_UNAVAILABLE` · `SUSPENDED` · `OFFBOARDED`. Manually set (§30.6)|
| `pin`| embedded| **yes**| Hashed with Argon2id. **Null until the rider establishes it privately** at device enrolment — **the registering officer never sees or chooses it** (§11.2, `MSC-DEC-264`). **It also carries `failed_attempt_count` and `locked_until`**, as for the staff credential, and setting the PIN at enrolment or replacement resets them.|
| `registered_device_id`| uuid| yes| **Exactly one device** when active (§11.2, §37.2)|
| `primary_hub_id`| uuid| no| Stable. Temporary assignment is a separate entity and **must not overwrite it** (§34.9, §5.8)|

**Invariants.**

- **Registration after a revocation is replacement, not first registration.** `registerRiderDevice` refuses a rider who has had a device revoked (`STATE_CONFLICT`), and **only `reregisterRiderDevice` — with its verification note and the rider's `ETag` — re-binds** ([rider-authentication.md](../features/identity/rider-authentication.md) §4.2).
- **One registered device.** A second registration replaces the first and is an authorised act, not a self-service one — recovery is Senior Ops (§37.2). **Loss and theft are settled by `MSC-DEC-235`**: reporting revokes the binding immediately, **before any identity verification** (`staff.device.revoke`, Ops Staff), and re-registration requires the rider to attend a hub in person (`staff.device.reregister`, Senior Ops). Verifying before revoking would leave a stolen handset live for as long as the check took.
- **Authentication proves possession of the device, not knowledge of its name**. Sign-in is a challenge-response against the registered **public key**; **the record is identified by `RegisteredDevice.id`, and nothing a client sends selects it** — a rider has at most one `ACTIVE` device, so the server resolves it.
- **A rider is authentication-ready when `status = ACTIVE`, a `pin` is established, and an `ACTIVE` `RegisteredDevice` carries a public key.** All three — and the PIN is established by the rider, never supplied by the registering officer. **Every `ACTIVE` rider device was accepted through Android Key Attestation at enrolment or replacement**: the only way a rider device becomes `ACTIVE` is `completeRiderDeviceEnrolment`, which verifies the evidence before it writes anything, so **sign-in does not re-check it and no flag records it**.
- **`INACTIVE` blocks dispatch and action** (§30). A rider may not be assigned a manifest or act on one.
- **Rider phone must not collide with an ad-hoc sender.** §30 states this as an invariant, and it is enforceable only because both are normalised E.164 (§3.4).

#### `VendorAccount` and `VendorCredential`

| Field| Type| Null| Notes|
|---|---|---|---|
| `VendorAccount.id`| uuid| no||
| `VendorAccount.vendor_organization_id`| uuid| no| One account per organisation in Version 1|
| `VendorAccount.account_identifier`| text| no| **Unique, immutable, never reused, case-insensitive, server-generated and human-typeable; not a secret.** What the vendor types at sign-in beside the shared secret (`vendorSignIn`). Generated when the account is created, shown to Ops by `getVendorAccount` and told to the vendor in the setup message. **Before this row existed the sign-in operation required an identifier that no document defined and no operation returned** (Gate PD-3R1). Its form is engineering's (`SECURITY_DESIGN.md` §13.7a)|
| `VendorAccount.status`| enum| no| `ACTIVE` · `SUSPENDED` (§37.3, §29.6)|
| `VendorCredential.recovery_phone` / `recovery_email`| text| yes| **At least one required.** The recovery channel (§37.2)|
| `VendorCredential.delivery_channel`| enum| yes| `PHONE` · `EMAIL`. **Chosen at approval by the approver** (`decideVendorOrganization`) and stored here, **null until then**. It is the channel a credential setup grant and a recovery link are delivered by ([state-machines.md](state-machines.md) §19.1). **Open:** whether the additional-browser grant (`VENDOR_DEVICE_ENROLMENT`), which names *the registered recovery channel*, uses it too when both addresses are registered|
| `VendorCredential.secret`| embedded| **yes**| Hashed with Argon2id. **Null until the vendor establishes it** through a `SetupGrant` — **the administrator never learns it**. Shared among the vendor's staff by design. **It also carries `failed_attempt_count` and `locked_until`**, shared by everyone using the credential. The secret is held to 12 to 128 characters with no composition rule.|

**Invariants, and the risk §37.5 makes explicit.**

- **Audit identifies the account, never a named employee** (§37.5). Version 1 deliberately uses one shared credential, so person-level attribution is **not available** — and the surface **must not claim it**. A screen reading "approved by Ama" when the system knows only "vendor account 41" is a false record, not a friendly one.
- **One active session** (§11.2). See `Session`.
- **Suspension blocks the credential** and controlled non-terminal work (§37.3).
- **A future multi-user model must preserve historical records** (§37.5). Records attributed to the account must not be retrospectively reattributed to individuals who were never identified at the time.

#### Failed attempts and lockout

`MSC-DEC-431`; the mechanism is [SECURITY_DESIGN.md](../architecture/SECURITY_DESIGN.md) §13.4b. **Written here because a lockout is state, and the model had settings and an audit event but nowhere to keep the count** (Gate PD-3R1, `PDA-48`).

| Identity| Kept on| A failure counts only when| A locked credential answers|
|---|---|---|---|
| Staff| `StaffIdentity.credential`| The identity exists, is `ACTIVE` and has a credential, **and** the password is wrong — or a code on a live MFA challenge is wrong| Password sign-in: `INVALID_CREDENTIALS`, deliberately silent. The MFA step: `CREDENTIAL_LOCKED`|
| Rider| `RiderIdentity.pin`| The device signature verified, the status is `ACTIVE`, **and** the PIN is wrong| `CREDENTIAL_LOCKED`|
| Vendor| `VendorCredential.secret`| The request carried a device credential registered to this account, the account is `ACTIVE`, **and** the secret is wrong| `CREDENTIAL_LOCKED`|

**`failed_attempt_count` (integer, default 0) and `locked_until` (timestamp, null) live on the embedded credential record**, so an identifier that does not exist has no counter and behaves exactly as one that is locked. **Neither is ever returned by any operation, and neither is part of the record's version**: a failed sign-in must not change the ETag an approver is holding.

- **A failure counts only once the request has reached the credential's factor**. A request from a browser that is not registered to the vendor account, a signature that does not verify, an unknown identifier and an ineligible status are never counted, so nobody can lock out an organisation or a rider through a factor they have not reached.
- **An ineligible status ends the request first.** A rider whose status is not `ACTIVE` and a vendor account that is not `ACTIVE` are `INVALID_CREDENTIALS` **even while a lock is in force**, because a lock is announced only after the factor is reached and the status check comes before it (`SECURITY_DESIGN.md` §13.4b).
- **The threshold is `signin_max_attempts` (5) and the lock lasts `signin_lockout_minutes` (15)**, set by `MSC-DEC-236` and unchanged. The fifth consecutive failure sets `locked_until`; **a locked attempt is not counted and does not extend the lock**, and it still costs one dummy hash whose result is not used.
- **The count resets** on a complete sign-in, at the first attempt after `locked_until`, and whenever the credential is established or changed — setup, recovery completion, rider enrolment or replacement.
- **A lock is not a session state and not an identity state.** It ends no live session, changes no `status` and does not block recovery.
- **Counting is atomic** at the credential record: one conditional statement adds one *unless the credential is already locked* and returns whether this update set the lock, so concurrent failures each add one, none can step over the threshold without setting the lock, a failure that completes after the lock neither counts nor moves `locked_until`, and `auth.lockout.applied` is written once, by the update that tipped it. `locked_until` and the comparison use the **database clock**. A correct attempt that races a lock is serialised on the same record — either order is a correct outcome.
- **Rate limiting comes first** and is separate: a request refused with `RATE_LIMITED` is neither verified nor counted, and its bucket is keyed on **what the request carries**, never on whether the server could resolve it.

#### Reads, versions and the `If-Match` source

Gate PD-3R1, `PDA-47`. §7 makes every mutation optimistically concurrent; **a version is useful only if the caller can read it first.** Nine identity operations required `If-Match` and no read returned it. Each is now tied to the read that does. **The rule underneath is one sentence: a record's version changes when anything its read returns changes, and for nothing else** — and never for a failed attempt, which no read returns. The rows list what that comes to, and where a row and the rule differ the rule wins. **This section covers the identity domain only**: other operations that require `If-Match` have no read that returns one yet, and the slice that builds each owes it (`IMPLEMENTATION_PLAN.md` §4c).

| Record| Its version changes when| The read that returns the ETag| Mutations that take it as `If-Match`|
|---|---|---|---|
| `StaffIdentity`| Status, bundle, name, email, phone, hub, the credential is established or changed, a factor is enrolled or revoked — **not** a failed attempt| `getStaffIdentity` (discovery: `listStaffIdentities`)| `approveStaffIdentity`, `resetStaffMfa`, `reissueStaffCredentialSetup`, `recoverStaffCredential`, `proposeBundleChange`|
| `RiderIdentity`, with its devices| Status, name, phone or hub changes, the PIN is established or reset, or the device set changes — **not** a failed attempt| `getRider` (discovery: `listRiders`)| `reregisterRiderDevice`|
| `VendorAccount`, with its credential and devices| Status, the organisation's name or responsible hub, the recovery channel, the secret being established or changed, or the device set changes — **not** a failed attempt| `getVendorAccount` (discovery: `listVendorAccounts`)| `recoverVendorCredential`, `reissueVendorCredentialSetup`|
| A vendor account's device set| A browser is registered or revoked| `listVendorDevices`, in the `ETag` header| `revokeVendorDevice`|

**The reads show only what the caller may see.** `getStaffIdentity` and `listStaffIdentities` need `staff.read`, which Ops Staff do not hold — the maker of an identity gets its id from the creation response and a *different* person finds it in the queue. `getRider` and `listRiders` need `dispatch.read`, `getVendorAccount` and `listVendorAccounts` need `vendor.read`, read within the caller's grant, and `listSessions` needs `staff.read` at the same tier `revokeSession` applies. None returns a credential, a key, a hash, a failed-attempt count or a recovery address.

**Two identity mutations take no `If-Match`, deliberately.** `registerRiderDevice` is guarded by the one-`ACTIVE`-device invariant (`STATE_CONFLICT`), and `revokeRiderDevice` is immediate and unverified by design; making either wait for a version would make reporting a stolen handset slower. `approveBundleChange` acts on the proposal, whose own state guards it.

#### `RecoveryRequest`

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `principal_type` / `principal_id`| enum / uuid| no| `STAFF` · `RIDER` · `VENDOR`|
| `channel`| enum| no| `EMAIL` · `SMS` · `OPS_VERIFIED`. **`OPS_VERIFIED` is the rider path** — a human verification step, not a delivered token (§37.2)|
| `token`| embedded| yes| Hashed, **single-use**, never returned and never logged. Null when `channel = OPS_VERIFIED`, because no token exists|
| `issued_at`| timestamptz| no||
| `expires_at`| timestamptz| no| From `recovery_link_ttl_minutes`|
| `state`| enum| no| `PENDING` · `CONSUMED` · `EXPIRED` · `SUPERSEDED`|
| `initiated_by`| uuid| yes| **Null for self-service**; the authorising staff actor when performed on another's behalf (§37.4)|
| `consumed_at`| timestamptz| yes||

**Invariants.**

- **The channel is resolved from the principal's registered contact, never from the request.** A recovery request carries no destination. This is the single most exploitable mistake available in this area — accepting a supplied address lets anyone redirect a colleague's recovery.
- **Single use.** Consuming a request sets `CONSUMED`; a second attempt fails. A reused token is a signal, not a retry.
- **Issuing a new request supersedes any `PENDING` one** for that principal, with `SUPERSEDED` — **except that a self-service request made less than `recovery_request_supersede_guard_seconds` after the pending one was issued neither supersedes it nor issues another** ([credential-recovery.md](../features/identity/credential-recovery.md) §5.5).
- **`initiated_by` is what makes one entity serve both self-service and administrative recovery** (R1.3). Null when the principal asked; the acting Platform Admin when `recoverStaffCredential` or `recoverVendorCredential` created it. The token still goes to the **registered channel** either way — an administrator initiates recovery and never receives its credential.

**`principal_type` discriminates the target, and no new field was needed for it.** `STAFF` replaces a password; `VENDOR` replaces a shared secret **and** rotates the browser device credential. The model already carried the discriminator R1.3 needed.

**`channel = OPS_VERIFIED` carries no token** and requires `initiated_by`. The rider path is a person verifying another person; there is nothing to deliver.
- **Consuming a request terminates every session** for that principal with `CREDENTIAL_CHANGED` — §37.5's *"revoke or control prior sessions"*, and for the shared vendor credential the entire purpose of recovery.
- **Consuming a request also clears the credential's `failed_attempt_count` and `locked_until`**, so a locked staff member or vendor recovers by recovering, and **the credential it sets is held to 12 to 128 characters with spaces permitted and no composition rule**.
- **Recovery never changes an operational state.** A suspended principal who completes recovery is still suspended; suspension and credentials have different authorities (§29.6, §30.9).

#### `RegisteredDevice`

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `principal_type` / `principal_id`| enum / uuid| no| `RIDER` or `VENDOR`|
| `device_kind`| enum| no| `RIDER_ANDROID_KEYPAIR` · `VENDOR_BROWSER_CREDENTIAL`. **Two different mechanisms, deliberately** — the surfaces are not alike|
| `public_key`| text| yes| **Rider only.** The public half of a non-exportable keypair generated in Android secure hardware. The private key never leaves the handset and is never copied to a replacement|
| `device_credential_hash`| text| yes| **Vendor only.** Hash of a server-generated high-entropy device credential delivered in a long-lived `HttpOnly` cookie. **Nobody types it**|
| `registered_at`| timestamptz| no||
| `registered_by`| uuid| yes| The authorising actor where registration was not self-service|
| `status`| enum| no| `ACTIVE` · `REPLACED` · `REVOKED`|

**`REPLACED` is retained, never deleted.** A device that once held a rider's session is part of the custody record for every collection made from it.

**Statuses and transitions**. There are three states and **both non-active ones are terminal**:

| From → to| By| Effect|
|---|---|---|
| (none) → `ACTIVE`| `completeRiderDeviceEnrolment`, after the attestation evidence is verified| The device is registered, the grant consumed and the PIN set together or not at all|
| `ACTIVE` → `REPLACED`| The same operation completing a `RIDER_DEVICE_REREGISTRATION` grant| The device was **superseded through the approved replacement workflow**. A live session on it ends with `DEVICE_REPLACED`. Audited by `auth.device.replaced`, which names the old and the new device|
| `ACTIVE` → `REVOKED`| `revokeRiderDevice` (and, for a vendor browser, `revokeVendorDevice`)| Melarc **explicitly invalidated** the device — loss, theft or a security workflow. A live session on it ends with `DEVICE_REVOKED`. Audited by `auth.device.revoked`. **A rider device's revocation takes a `reason_code` of the rider-device-revocation domain (§3.9).**|
| `REVOKED` → `REPLACED`| **never**| A device already revoked when its replacement completes **stays `REVOKED`**: it was revoked and not replaced, and rewriting it would erase the reason|

**Neither `REPLACED` nor `REVOKED` can authenticate, and neither returns to `ACTIVE`.** A device is never restored; **a new device is a new enrolment.** Both keep their reason distinguishable, which is the point of two states.

### 6.8.1 `RunCustodyHandover`

Written by `MSC-DEC-246` for `CONFLICT-034`. §36.14, §43.4.

| Field| Type| Null| Note|
|---|---|---|---|
| `id`| uuid| no||
| `manifest_id`| uuid| no| The `IN_PROGRESS` run whose custody moves|
| `from_rider_id`| uuid| no| The original assigned rider. **Never overwritten** — completed-stop attribution depends on it (§43.4)|
| `to_rider_id`| uuid| yes| Set for a field transfer. Exactly one of this and `to_hub_id` is set|
| `to_hub_id`| uuid| yes| Set where the destination is the hub — §43.4's *“unsafe field handover routes work through the hub”*|
| `state`| enum| no| `PENDING`, `COMPLETED`, `FAILED` — [state-machines.md](state-machines.md) §4.1|
| `parcel_count_taken`| int| yes| Recorded by the receiver at acceptance. **A custody record, not an authoritative count** — the hub blind count still runs independently at intake|
| `reason_snapshot`| embedded| no| Why custody moved, per §3.7|
| `initiated_by` / `accepted_by`| uuid| no / yes||
| `initiated_at` / `resolved_at`| timestamptz| no / yes||

**Invariants.**

- **Exactly one destination.** `to_rider_id` and `to_hub_id` are mutually exclusive and one is always set.
- **`from_rider_id` is never rewritten**, and `PickupManifest.assigned_rider_id` is never rewritten to effect a transfer. §36.14: *“a rider-ID edit is never a substitute for a `RunCustodyHandover` record.”* Rewriting either destroys the completed-stop attribution §43.4 requires.
- **Custody is continuous.** Opening a handover moves nothing; custody transfers **only** on `COMPLETED`, and a `FAILED` handover leaves it with the original rider. There is no window in which nobody holds the parcels.
- **Completion authority follows custody.** Only the current holder may complete the run or submit the hub handover, which makes closing a run whose parcels nobody accepted **structurally impossible** rather than merely forbidden.
- **`parcel_count_taken` never seeds the hub count.** Giving the receiving hub a figure to match is the failure `HubIntakePreCount` omits a field to prevent.

### 6.9 Remaining entities

Identity, scoping and relationships are fixed. Field detail follows in Phase 4 per §1 — **except the identity and access set, which §6.8 now carries in full** because `SLICE-000` needs it.

| Domain| Entities| Source|
|---|---|---|
| Identity & access| **Now detailed at §6.8** — `Session`, `StaffIdentity`, `RiderIdentity`, `VendorAccount`, `VendorCredential`, `RegisteredDevice`. `HubAssignment` (§5.8) remains summary-level| §34.12, §34.9|
| Vendor| `VendorOrganization`, `VendorPickupLocation`, `VendorAccountAllowance`, `VendorSuspensionHold`, `SecurityRiskHold`, `AdHocSender`, **`AdHocSenderBlock`** *(below — `MSC-DEC-296`)*| §34.11, §34.2, §35.12|
| Hub| `Hub`, `ServiceZone`, `ZonePairRate`, `HubSetting`| §34.9|
| Dispatch & delivery| **`RecipientConfirmation`, `DeliveryRun`, `DeliveryStop` and `ThirdPartyHandoff` are now detailed at §6.10; `ReturnRecord` is now detailed at §6.14.** Still summary-level: `DeliveryAttempt`. **`CourierProvider` is detailed at §6.10 from `MSC-DEC-417`**, with `ApprovedAgent` beside it.| §34.5|
| Commercial| `Payment`, `VendorBalance`, `VendorStatement`, `StatementLine`, `Adjustment`, `CashReconciliation`| §34.6, bounded by §5.5|
| Fleet| `Motorcycle`, `MotorcycleAssignment`, `BreakdownIncident`, **`RunCustodyHandover`** *(detailed below — `MSC-DEC-246`)*, `MaintenanceScheduleItem`, `MaintenanceRecord`, `MotorcycleComplianceRecord`, `FuelRecord`| §34.10|
| Cross-cutting| `Evidence` (§3.6), `ReasonCode` (§3.9), `AuditEvent`, `Notification`, `Setting`, `Permission`, `RoleBundle` *(four fields, below — `MSC-DEC-439`)*| §34.7, §35.9, §37, §38|
| Reporting| **`DailyOperationsCashReport`** *(detailed below — §6.13, `DERIVED-PROJECTION`)*| §32|

Three rules from §35.12 constrain the vendor entities above and are easy to collapse by accident:

- **Four vendor conditions are distinct and may not become one flag** (§35.12.8): operational suspension, `OVERDUE` financial status, account-allowance disablement, and security/risk holds. The fourth was missing from this model until the §35 reconciliation; `SecurityRiskHold` now carries it.
- **The creator and the operational approver must be different actors** (§35.12.2). Maker-checker on vendor creation, not only on exceptions.
- **An ad-hoc sender is provisional until a physical pickup completes successfully** (§35.2.7, §35.12.10). `AdHocSender` therefore carries a lifecycle — `PROVISIONAL` then `REUSABLE` — and is not searchable for reuse while provisional. Promotion to a registered vendor follows the approved onboarding process and is a separate act.

**`RoleBundle`**. Named above with its field detail deferred. **The four fields below are the ones the contract now reads from it** — enough that `createStaffIdentity`'s `role_bundle_id` has a producer — and nothing else about a bundle is promised here:

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no| What `StaffIdentity.role_bundle_id` references and `createStaffIdentity` takes. §11.1: authorization tests the **permission**, never this id|
| `name`| string| no| The display name the maker of a staff profile sees|
| `audience`| enum| no| `STAFF` · `RIDER` · `VENDOR`. **Vendor and Rider each carry one fixed, non-configurable bundle** (`permissions.md` §8), and neither is ever assignable to a human staff identity|
| `privileged`| boolean| no| True for the Senior Ops and Platform Admin bundles **and for no other**: their holders sign in with a second factor, and a profile that holds one needs a Platform Admin approver. **Fleet Manager and Finance/Reconciliation are `false`** — standard session tier (720 minutes absolute, 30 idle, [settings.md](settings.md) §7.5) and no mandatory second factor|

**Which bundles are offered for assignment is derived, not stored**: a bundle whose `audience` is `STAFF`. Only confirmed bundles are ever seeded — a `PROPOSED` bundle governs nothing (`permissions.md` §8) and is not in the table — so `audience` is the whole predicate, and a technical identity's capability set is not a `RoleBundle` at all. `listAssignableStaffRoleBundles` returns `id`, `name` and `requires_platform_admin_approval` — the last is `privileged` read through the approval policy, and grants nothing — and **never a bundle's permissions or its holders**.

**`AdHocSenderBlock`**. `MSC-DEC-258` gave hub Senior Ops the authority to block an ad-hoc sender on §29.6's four grounds and **did not state the reach of that block** — the gap `OQ-104` carried. R1 records it as its own entity, summary-level like its siblings:

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `ad_hoc_sender_id`| uuid| no| Attaches to the **verified phone identity** (§29.7, `MSC-DEC-172`), never to a name — a block against a name blocks nobody|
| `scope`| enum| no| **`HUB_LOCAL`** · **`PLATFORM_WIDE`**. Exactly two values|
| `hub_id`| uuid| yes| **Required when `scope = HUB_LOCAL`, null when `PLATFORM_WIDE`**|
| `grounds`| enum| no| §29.6's four grounds. **No new grounds are created**|
| `reason`| text| no| Mandatory, per `MSC-DEC-258`|
| `created_by`| uuid| no| Hub Senior Ops for `HUB_LOCAL`; Platform Admin for `PLATFORM_WIDE`|

**Reach is a discriminator, never an inference.** The tempting representation is a single nullable `hub_id` where null means *everywhere* — and it fails on the property that matters: **a defect that fails to populate the hub silently escalates a hub-local block into a platform-wide ban.** That is the widest available outcome produced by the most ordinary available bug, on a record that stops a customer transacting. An explicit `scope` inverts it: a missing value is **invalid** rather than maximal.

**A `HUB_LOCAL` block does not bind another hub**, and **reversal and reactivation stay deferred** — `OQ-033`, unchanged by R1.

### 6.10 Dispatch and delivery

Governed by §24, §20.2, §36.8, §36.9. §6.9 names these entities and defers field detail; `SLICE-002` is that phase for the dispatch set.

**Placed after §6.9 rather than before it** to avoid renumbering a section six documents already cite. Ordering here is chronological, not hierarchical.

#### `RecipientConfirmation`

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `order_id`| uuid| no| One per order|
| `state`| enum| no| Seven states at [state-machines.md](state-machines.md) §11. §36.8 warns the complete model is **not approved**|
| `confirmation_attempts`| embedded[]| no| **Every contact attempt, persisted — and uncapped**. A call count is **audit history, never a gate**; clearance is decided by outcome.|
| `outcome`| enum| yes| `confirmed` · `reschedule` · `address_correction` · `unreachable` — the four §20.2 fixes|
| `refined_location_note`| text| yes| May be captured on the call and **copied onto the delivery stop** (§24.2, §24.4)|
| `escalated_at`| timestamptz| yes| Set when **Ops judges the contact avenues exhausted** — not when a counter reaches a number. The escalation queue survives; what puts an order into it changed|

**Invariants.**

- **Confirmation is mandatory before a doorstep parcel enters a run, regardless of payer** (§20.2, §24.3). Not "where the recipient pays" — **regardless of payer**. A fully vendor-paid parcel still requires the call, and this is the rule most likely to be optimised away by someone reasoning that a prepaid parcel needs no recipient contact.
- **Each attempt is a row, not a counter.** §24.2 requires attempts logged; a bare count cannot answer *when* or *what happened*.
- `confirmed` alone makes an order run-eligible. **Reschedule, address correction and unreachable all hold it** (§24.2) — three different outcomes, one effect, and none of them is a failure.
- **Ops judging the contact avenues exhausted** enters a **senior decision queue**, not a terminal state. The order is held, not lost — and **no call count triggers it**.
- An address correction that resolves to a different **service area** after price freeze triggers the §35.6.8 repricing path — Ops requests, hub Senior Ops approves, **both price versions preserved** (§24.2, `MSC-DEC-207`).

#### `DeliveryRun`

| Field| Type| Null| Notes|
|---|---|---|---|
| `id` / `code`| uuid / text| no| Code format per `MSC-DEC-202`|
| `state`| enum| no| Five states at [state-machines.md](state-machines.md) §12|
| `responsible_hub_id`| uuid| no| **Hub-scoped, never vendor-scoped** — a run spans vendors|
| `assigned_rider_id`| uuid| yes| Set by `dispatch.run.assign`|
| `courier_provider_id`| uuid| yes| Required where an outbound mode needs one (§24.4). **An `ACTIVE` `CourierProvider` when set** — checked at creation and revalidated at dispatch (§24.5) now the register is fielded. **The plan, not the fact**: the handoff captures the courier actually handed to (§36.10), and nothing requires the two to match|
| `assigned_at` / `dispatched_at` / `started_at`| timestamptz| mixed| **Three distinct moments**, stored separately — each governs a different rule|
| `stops`| embedded[]| no| Ordered manually (§24.4). No route optimisation in Version 1|

**Invariants.**

- **A run may freely mix carrier identities and commercial modes** (§24.3, §24.7, `MSC-DEC-154–155`). Registered-courier and informal stops, `STATION_DROP` and `MELARC_COVERED_THIRD_PARTY_DELIVERY`, may share one run. **Ops is not required to build separate runs per mode** — and an implementation that enforces separation invents a constraint the specification explicitly removes.
- **Dispatch is atomic** (§24.5). Rider activity, courier activity, and every order's payment gate and readiness are revalidated at commit; **one failure rolls back all of it**. One run-level rider notification follows success — not one per stop.
- Completion requires **every stop to reach a terminal state** (§24.6).

#### `DeliveryStop`

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `delivery_run_id`| uuid| no||
| `order_id`| uuid| no||
| `sequence`| int| no| Manual. A **plan, not a constraint** — a rider may work stops out of order|
| `state`| enum| no| **Seven states** at [state-machines.md](state-machines.md) §12.1 — `PENDING` · `ARRIVED` · `AWAITING_RECIPIENT` · `DELIVERED` · `FAILED` · `SKIPPED` · `HANDED_OVER` (`MSC-DEC-229`; `AWAITING_RECIPIENT` added by `MSC-DEC-349`; `HANDED_OVER` by `MSC-DEC-417`, the outbound stop's end).|
| `refined_location_note`| text| yes| Copied from the confirmation call (§24.4)|
| `arrived_at` / `closed_at`| timestamptz| yes||
| `failure_reason_code`| text| yes| **Mandatory on `FAILED`**|
| `payment_taken`| bool| no| **The field the state machine cannot express** — see below|

**Invariants.**

- **`payment_taken` may be true on a `FAILED` stop, and that is the whole reason the field exists**. A rider takes payment, the OTP will not validate, §36.9 forbids handover, and the stop fails carrying cash. The money is **held for hub reconciliation, not refunded at the door**.
- **Nothing may read stop state to decide what a rider is holding.** A `FAILED` delivery stop and a `FAILED` pickup stop are identical in their machines and are not identical in fact. Consult the payment record.
- Payment settles **before** OTP validation, in that order (§36.9). Validating identity first and then asking for money creates the worse failure: a recipient who has proved who they are, seen the parcel, and cannot pay.
- `failure_reason_code` is mandatory on `FAILED` — an attempt with no reason cannot be adjudicated. It is an **active Delivery Failure Reason Catalog code**, and whether it consumed a physical attempt is snapshotted with it; **no attempt ceiling applies**.

#### `ThirdPartyHandoff`

`MSC-DEC-402`. **The evidence-backed custody transfer to an approved courier or station** (§34.5, §24.7). Named at §6.9 with field detail deferred; **this is that detail**. The machine is at [state-machines.md](state-machines.md) §10 and has been **SIGNED since 26 August 2026** — its `PENDING_HANDOFF → HANDED_OVER` row names the **Rider** as actor, and until this pass no operation existed to perform it and no field table existed to write to.

**Corrected and completed at `MSC-DEC-417`.** The two identity modes `MSC-DEC-413` permitted never reached this table — it still demanded a waybill in every mode and a registered courier behind every handoff — and the record had no creator, no cancellation and no covered-mode outcome path. All of that is here now.

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `order_id`| uuid| no| The outbound order whose custody transfers. **One `PENDING_HANDOFF` record per order at a time** (`MSC-DEC-417`, closing `OQ-134`): a failed counter keeps the record for the re-dispatch, and a covered `RETURNED` closes it, so an order re-dispatched after one carries a second.|
| `delivery_stop_id`| uuid| yes| The outbound stop on the run carrying the order — **set when the order joins a run and cleared on re-dispatch**, so it names the current attempt's stop|
| `commercial_mode`| enum| no| **Snapshotted from `Order.commercial_mode` at creation** — `STATION_DROP` or `MELARC_COVERED_THIRD_PARTY_DELIVERY`. It decides whether `HANDED_OVER` is terminal, so reading it live would let a later edit change a closed record's meaning (§3.7)|
| `identity_mode`| enum| yes| `REGISTERED` · `APPROVED_AGENT` — **which approved identity took custody**. Non-null from `HANDED_OVER`; it decides whether `courier_provider_id` or `approved_agent_id` is set, and whether a waybill is required|
| `courier_provider_id`| uuid| yes| An **`ACTIVE` `CourierProvider`** — **`REGISTERED` mode only**, null in agent mode.|
| `approved_agent_id`| uuid| yes| An **`ACTIVE` `ApprovedAgent`** at the rider's hub with its identity photo stored — **`APPROVED_AGENT` mode only**. The rider names the agent by phone number and the server resolves it, so the rider never reads the agent register|
| `handed_to`| embedded| yes| **What was actually captured at the handoff** — the station or carrier name and its reference. Distinct from `Order.carrier_identity`, which records what was *planned*; §36.10 requires the courier or station to be **captured** at the act. Non-null from `HANDED_OVER`|
| `waybill_reference`| text| yes| **Mandatory at `HANDED_OVER` in the `REGISTERED` mode only** (§24.7.3, `MSC-DEC-413`); `WAYBILL_REQUIRED` refuses a registered handoff without it. An agent issues none, and the handoff photo stands in for it.|
| `evidence_id`| uuid| yes| The **mandatory receipt/handoff photo** (§34.5, §24.7.1). Mandatory at `HANDED_OVER`; `EVIDENCE_REQUIRED` refuses without it. **Must be `STORED`** — a `PENDING_UPLOAD` record may not be referenced ([state-machines.md](state-machines.md) §17)|
| `state`| enum| no| **Seven states** at [state-machines.md](state-machines.md) §10 — `PENDING_HANDOFF` · `HANDED_OVER` · `IN_TRANSIT` · `DELIVERED` · `FAILED` · `RETURNED` · `CANCELLED` (`CANCELLED` added by `MSC-DEC-417`).|
| `handed_over_by_rider_id`| uuid| yes| Holder of `delivery.handoff.perform`. Non-null from `HANDED_OVER`|
| `handed_over_at`| timestamptz| yes| Non-null from `HANDED_OVER`. **For `STATION_DROP` this is the instant Melarc's fee is earned** (§24.7.1)|
| `final_outcome_recorded_by_staff_id`| uuid| yes| Ops holding `delivery.handoff.outcome`, **covered mode only**. Null throughout a Station Drop|
| `final_outcome_at`| timestamptz| yes| As above|
| `reason_snapshot`| embedded| yes| Why the handoff reached `FAILED`, the parcel `RETURNED`, or the record `CANCELLED` — a `DELIVERY_FAILURE` catalogue reason for a third party's failure (§3.9), the Return's reason for a cancellation. **Mandatory on all three**|

**Invariants.**

- **One `PENDING_HANDOFF` record per order at a time, and a counter failure does not close it**. A failed counter fails the **stop** and leaves the record `PENDING_HANDOFF`, so a re-dispatch reuses it with its stop link cleared. A covered `RETURNED` closes the record, and a re-dispatch opens a new one — **the canonical handoff is the order's latest record**, and earlier ones are history.
- **`commercial_mode` is snapshotted and never read live.** `HANDED_OVER` is terminal for a Station Drop and not for the covered mode ([state-machines.md](state-machines.md) §10, `MSC-DEC-181`), so the mode decides what a closed record *means*. Reading it from the order would let an edit reopen a completed service months later.
- **`HANDED_OVER` requires every capture its mode demands, together**: an approved identity and a `STORED` photo in both modes, and the waybill in the `REGISTERED` mode. §24.7.1's *"mandatory waybill and receipt/handoff photo"* is a registered-mode sentence — an agent's handoff is valid, and a Station Drop's fee earned, on identity and photo.
- **A failed handoff is never closed as successful** (§24.7.1), **and it now has its controlled path** (`MSC-DEC-417`, closing `OQ-134`): a counter failure fails the stop and brings the parcel back for Ops to re-dispatch at no new charge or return; a covered `FAILED` is followed by `RETURNED` and the same choice; and an abandoned outbound order `CANCELLED`s the record while the Return reverses the unearned charge.
- **System creates this record when Ops clears the order for dispatch** (`MSC-DEC-417`, closing `OQ-139`) — at §9's third-party `→ READY_FOR_DISPATCH`, which already requires the outbound charge confirmed paid, so the mode snapshot follows payment. **Every order a rider can be sent with has its record.**
- **The rider captures; the rider never adjudicates.** The one rider transition is the handoff itself. Every post-handoff outcome in the covered mode is Ops', through `recordHandoffOutcome` and `delivery.handoff.outcome`, and `TERMINAL_FOR_STATION_DROP` refuses an outcome update on a Station Drop.
- **This record earns a fee and moves no money.** For a Station Drop the fee was already collected before dispatch — §24.7.1 requires it *"fully paid and backend-confirmed before a rider is dispatched"* — so this record marks the earning, never a collection. **The covered charge is earned at `DELIVERED`, never at handoff** (§36.10, `MSC-DEC-417`).

#### `CourierProvider`

`MSC-DEC-417`, closing `OQ-133`'s first half. **§24.7's *"Melarc-managed approved courier/station registry"***: one platform-wide register — [data-scope-registry.md](data-scope-registry.md) classifies it global — kept by holders of `courier.registry.manage`, **Senior Ops and Platform Admin, all hubs**.

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `name`| text| no| The station or courier as it trades|
| `kind`| enum| no| `COURIER` · `STATION`|
| `contact_phone`| text| yes||
| `location_note`| text| yes| Where a rider finds the counter. Free text; Version 1 geocodes nothing|
| `status`| enum| no| `ACTIVE` · `INACTIVE`. **An entry is approved while `ACTIVE`**|
| `registered_by` / `registered_at`| uuid / timestamptz| no||
| `status_changed_by` / `status_changed_at`| uuid / timestamptz| yes| The last deactivation or reactivation|
| `status_reason`| text| yes| **Mandatory on deactivation and reactivation**|

**Invariants.**

- **Approval is being `ACTIVE`, and nothing else.** A handoff in the `REGISTERED` mode must name an `ACTIVE` entry, or it is refused with `CARRIER_NOT_APPROVED`.
- **Deactivation never deletes** — the rule of every catalogue here (§3.9). History stays interpretable, and past handoffs keep the entry they used.
- **Configuration, not a lifecycle machine.** Like the reason catalogue, it carries a status and no transition table.
- **A rider reads the `ACTIVE` entries and nothing else** — a registered-mode capture names a `courier_provider_id`, and without the read a rider had no way to learn one. Inactive entries stay with Ops.
- **`DeliveryRun.courier_provider_id` points here too**, and is checked the same way: `ACTIVE` when the run is created and when it is dispatched (§24.4, §24.5).

#### `ApprovedAgent`

`MSC-DEC-417`, closing `OQ-133`'s second half. **The approved informal driver or agent `MSC-DEC-413` permits**, approved by **hub Senior Ops** (`courier.agent.approve`) in advance, or on the spot while the rider waits — agents *"cannot all be pre-registered"*. **Hub-scoped**: an agent is approved for the approving hub's handoffs.

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `approving_hub_id`| uuid| no||
| `full_name`| text| no||
| `phone`| text| no| **Unique among the hub's `ACTIVE` agents** — the rider names the agent by it at the counter|
| `identity_evidence_id`| uuid| yes| **A `STORED` photo of an ID document** (`COMPLIANCE_DOCUMENT`). **An agent without one cannot take custody.** Supplied at approval from the rider's counter photo, or attached afterwards as Evidence owned by the agent (`APPROVED_AGENT`)|
| `status`| enum| no| `ACTIVE` · `WITHDRAWN`|
| `approved_by` / `approved_at`| uuid / timestamptz| no| Senior Ops|
| `withdrawn_by` / `withdrawn_at`| uuid / timestamptz| yes||
| `withdrawal_reason`| text| yes| **Mandatory on withdrawal**|

**Invariants.**

- **No unapproved party takes custody, in either mode**. A handoff in the `APPROVED_AGENT` mode must resolve to an `ACTIVE` agent at the rider's hub with its identity photo stored, or it is refused with `CARRIER_NOT_APPROVED`.
- **The handoff photo stands in for the waybill** — an agent issues none (§24.7.3).
- **Withdrawal never deletes**; past handoffs keep their agent.
- **Riders never read the register.** The rider supplies the agent's phone number and the server resolves it, so the approved list — names, phones and identity documents — stays with Ops.
- **The identity document is Ops-only, whichever record owns it.** A photo taken at the counter is owned by that handoff, and a handoff inherits its order's vendor; its access rule still admits no vendor, recipient or rider. The vendor may see that a handoff happened, never the agent's ID (§38.2).

#### `ParcelCustodyReturn`

`MSC-DEC-408`. **`OQ-129` is narrowed, not closed** — that closure claim was withdrawn at `OQ-129` R1, which found four contract defects inside this artifact. **The record of undelivered parcels coming back
from a delivery run to the responsible hub.** Machine at
[state-machines.md](state-machines.md) 12.2 — **SIGNED — Product Owner — 25 September 2026 — `MSC-DEC-410`**, which also amended and re-signed §9's `ATTEMPT_FAILED → AT_HUB_AFTER_FAILURE` row so that **the hub's confirmation moves the order and the rider's declaration does not**.

**Why it exists.** §9's `ATTEMPT_FAILED → AT_HUB_AFTER_FAILURE` row is **SIGNED**, names the
**Rider**, and guards on *"custody returned to the responsible hub"* with `CUSTODY_NOT_RETURNED`.
**Nothing recorded that arrival.** `RunCustodyHandover` §4.1 is `PickupManifest`-scoped and answers
a different question — rider-to-rider transfer mid-run — so a guard the specification calls
mandatory had no artifact behind it.

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `delivery_run_id`| uuid| no| The run being closed out. **One open return per run**|
| `rider_id`| uuid| no| **The rider who actually handed over**, recorded rather than derived. **Today that is necessarily the run's assigned rider**, because no delivery-run custody transfer exists — `RunCustodyHandover` §4.1 is `PickupManifest`-scoped and cannot move a delivery run's parcels. The field and the permission scope are written on **custody** anyway, so creating a delivery-run transfer later changes no rule here.|
| `responsible_hub_id`| uuid| no| The hub answering for the parcels (§34.9)|
| `state`| enum| no| `DECLARED` · `RECEIVED` · `VARIANCE_OPEN` · `CLOSED` — [state-machines.md](state-machines.md) 12.2|
| `declared_at`| timestamptz| no| When the rider submitted|
| `received_by_staff_id`| uuid| yes| **Hub Ops, never the rider.** Non-null from `RECEIVED` or `VARIANCE_OPEN`|
| `confirmed_at`| timestamptz| yes| **When Hub Ops recorded the physical comparison.** Non-null from `RECEIVED` or `VARIANCE_OPEN`. **Not a custody instant for the record** — see the custody-timing invariant. *Renamed from `received_at` at `OQ-129` R1.1, which found the old name asserting a transfer even on a confirmation that received nothing*|
| `variance_reason_code`| text| yes| **Mandatory at `VARIANCE_OPEN`** (§3.9)|
| `resolved_by_staff_id`| uuid| yes| Hub Senior Ops. Non-null from `CLOSED` where a variance was opened|
| `resolved_at`| timestamptz| yes| As above|

**Lines — one per order, because each order transitions on its own.**

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `parcel_custody_return_id`| uuid| no||
| `order_id`| uuid| no| **One line per order per return**|
| `declared_by_rider`| bool| no| Whether the rider named it|
| `received_by_hub`| bool| yes| Whether the hub found it. Null until the hub acts|
| `line_state`| enum| no| `DECLARED` · `RECEIVED` · `MISSING` · `UNDECLARED` · `RESOLVED`|
| `disposition`| enum| yes| **What was decided about an open line**, mandatory at `RESOLVED` and null before it: `RECEIVED_LATE` · `CONFIRMED_NOT_RECEIVED` · `DECLARATION_CORRECTED`. **A reason says why the line is open; this says what was decided** (`OQ-129` R1)|
| `reason_code`| text| yes| §3.9's reason, mandatory with a `disposition`|
| `note`| text| yes||

**Invariants.**

- **Every line must be eligible, and this was missing.** An `order_id` is eligible only where the order carries a `DeliveryStop` on this `delivery_run_id` whose stop is not `DELIVERED`, and the run's `responsible_hub_id` is the return's. `ORDER_NOT_ON_RUN` refuses the rest: **a rider hands back what they carried, not what they can name** (`OQ-129` R1). **The rule binds at both doors** (`OQ-129` R1.1): the rider's declaration and **the hub's confirmation, which may add an id the rider never named**. Checking only the declaration would leave the `UNDECLARED` path — the one nobody planned — as the unguarded way into the line set.
- **The hub receives; the rider never confirms their own return.** `received_by_staff_id` is Hub
  Ops and may not be the `rider_id`, the same separation `AC-SLICE-003-16` makes for cash.
- **Custody transfers per line, not per record — and so does its timing** (`OQ-129` R1.1). A
  `VARIANCE_OPEN` return still transfers custody of every line the hub actually received; the rest
  stay against the rider. A variance that moved all or nothing would either lose parcels the hub is
  holding or credit the rider with parcels nobody found. **The instants: a `RECEIVED` line transfers
  at `confirmed_at`; a `MISSING` line transfers nothing, ever; a line dispositioned `RECEIVED_LATE`
  transfers at `resolved_at`; `CONFIRMED_NOT_RECEIVED` and `DECLARATION_CORRECTED` transfer
  nothing.** One timestamp on the record cannot carry this, which is why `received_at` was renamed
  rather than redescribed.
- **`MISSING` and `UNDECLARED` are different failures and are kept apart.** A named parcel the hub
  cannot find is a loss; an unnamed parcel the hub is holding is a declaration error. Collapsing
  them would hide the first inside the second.
- **A variance is dispositioned, not erased** (`MSC-DEC-321`'s rule for cash). `CLOSED` records
  what was decided about each line and rewrites none of them — and **`disposition` is what carries
  that**, because a terminal state claiming the decision is recorded must be able to tell the
  decisions apart. **`RECEIVED_LATE` moves an `ATTEMPT_FAILED` order to `AT_HUB_AFTER_FAILURE`**
  exactly as a confirmed line does; **`CONFIRMED_NOT_RECEIVED` moves no order state** and records a
  non-arrival, whose claims consequences are `OQ-004`'s and not this record's;
  **`DECLARATION_CORRECTED` moves nothing at all**, because no parcel moved.
- **Which orders move is §9's to say, and two do** (`MSC-DEC-411`, closing `OQ-143`). An `ATTEMPT_FAILED` order moves to `AT_HUB_AFTER_FAILURE`; so does an **`OUT_FOR_DELIVERY`** order whose `DeliveryStop` is **terminal and not `DELIVERED`** — in practice `SKIPPED` — **provided no live `VendorSuspensionHold` covers it**, and **no attempt is consumed** either way. **A line for any other order is recorded and its order state does not change**, because §9 declares no transition for it.
- **A held parcel's fulfilment intent is the hold's to decide, not a custody event's**. Where a live `VendorSuspensionHold` covers the order, §6.17's row carries its `state` and `custody_location` — *the only field that says where the item actually is* — and this record **moves physical custody only**. **An order already at `RETURN_TO_VENDOR_IN_PROGRESS` stays there**: hub receipt changed where the parcel is, not what is to be done with it, and routing it through `AT_HUB_AFTER_FAILURE` would pull it out of a decided Return. **The two cases are disjoint by the hold, not by the skip** — an Ops-skipped stop on a held parcel is structurally both, and the guard resolves it.
- **This record moves no money.** Cash returning from the same run is `CashHandover` §16.4's, and
  the two are deliberately separate records of one conversation.

### 6.11 Cash custody and reconciliation

Governed by §26.2, **§26.3**, §26.5, §36.11. Machines at [state-machines.md](state-machines.md) §16. Added 24 August by `MSC-DEC-250`.

**`payment_taken` on `DeliveryStop` above is a boolean and was the only record that money had moved.** It says *that* a rider is holding cash and never *how much*, *for which order*, or *whether the hub ever received it*. §26.3 requires all three, so the boolean is a flag on the stop and these are the records.

#### `RiderCashCustody`

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `order_id`| uuid| no| **One per order with a recipient cash amount due**|
| `rider_id`| uuid| no| The rider who holds it. **Not read from the run** — a `RunCustodyHandover` can move the parcels, and the cash follows the person, not the manifest|
| `expected_minor`| int| no| Snapshotted **at dispatch** (§3.7) from the recipient amount then due for the trip — the order's `payer_allocation.recipient_minor` on a first delivery, the `RedeliveryRecord.total_due_minor` on a redelivery trip — **less any principal already confirmed** against the demand before dispatch. **A comparison figure, never a gate on custody**|
| `collected_minor`| int| yes| Non-null from `COLLECTED_BY_RIDER` onward. **The sum of the confirmed `CASH` `PaymentReceipt`s linked to this record** — GH₵50 then GH₵5 reads 5500. May be **less** than `expected_minor` where the remainder is still due or was paid digitally, and **more** where the recipient over-tendered|
| `cash_receipt_ids`| uuid[]| no| **Every `CASH` `PaymentReceipt` that increased this custody**, in `confirmed_at` order. Empty in `EXPECTED`; at least one from `COLLECTED_BY_RIDER`. The provenance that lets GH₵55 in a pannier be traced to two receipt facts|
| `state`| enum| no| Six states at [state-machines.md](state-machines.md) §16.3|
| `cash_handover_id`| uuid| yes| Non-null from `HANDED_TO_HUB` onward|
| `collected_at`| timestamptz| yes||
| `resolution_reason_code`| text| yes| **Mandatory on `RESOLVED`**|

**Invariants.**

- **`expected_minor` is snapshotted at dispatch and never recomputed.** §35.1.5 requires a historical transaction to preserve the values applicable when it occurred. Resolving it live would compare today's price against yesterday's collection and make every post-hoc repricing look like a rider shortage.
- **A record exists whenever cash is due, whether or not the stop succeeded.** §12.1.1: a `FAILED` stop may be carrying money. Creating custody only on `DELIVERED` loses precisely the cash that is hardest to account for.
- **`collected_minor` equals the sum of its linked confirmed `CASH` receipts, and nothing else writes it**. **A short tender is preserved, not refused**: GH₵50 against GH₵55 is GH₵50 of custody and GH₵5 still due on the demand. **It may be greater than `expected_minor`**: §26.5 requires "short, **or over**" to be distinguishable, so an over-tender is reconciled as a variance rather than refused, and the excess against the demand total becomes a `FinancialAdjustmentRequired`.
- **Custody is not settlement.** A `CASH` receipt funds the `OperationalPaymentDemand` through the same atomic engine as Hubtel and Merchant MoMo; **the delivery gate is the demand reaching `SETTLED`**, never this record's state. A record can be `COLLECTED_BY_RIDER` at GH₵50 with the door still shut, and a digital remainder settles the demand without touching this record.
- `rider_id` **survives a `RunCustodyHandover`**. `MSC-DEC-246` moves parcels between riders; it says nothing about cash, and cash in a stranded rider's pocket does not move because their parcels did. Anything reading the run to find who holds the money will be wrong on exactly the day it matters.

#### `CashHandover` — amended at Gate C R1

`MSC-DEC-320`, `MSC-DEC-321`, and the R1 audit finding. **The reconciliation is three-way.**

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `rider_id`| uuid| no||
| `hub_id`| uuid| no| **The responsible hub** (§26.3)|
| `system_expected_minor`| int| no| **Server-derived and never caller-supplied**: `gross_cash_minor` **minus the approved `COLLECTION_CASH` expenses actually applied to THIS handover** — not every approved expense, and not every expense of the rider's. **Added at R1**|
| `declared_total_minor`| int| no| **Rider-declared** — the first of §26.3's three figures|
| `confirmed_total_minor`| int| yes| **Hub-counted.** Non-null from `RECEIVED` or `VARIANCE_OPEN`|
| `variance_minor`| int| yes| **`confirmed_total_minor − system_expected_minor`.** Signed. **Derived against the system figure, not against the declaration**|
| `gross_cash_minor`| int| no| Gross recipient cash in this handover's custody records. **Never rewritten by an expense**|
| `applied_expense_minor`| int| no| Sum of the approved `COLLECTION_CASH` road expenses **bound to this handover at opening**. **0 where none**; **many expenses may contribute**|
| `custody_transferred_at`| timestamptz| yes| **When the hub physically accepted the counted cash.** Set on `CONFIRMED` **and on `VARIANCE_OPEN`** — a variance is a financial state, not a reason to leave money attributed to the rider|
| `state`| enum| no| Four states at [state-machines.md](state-machines.md) §16.4|
| `variance_reason_code`| text| yes| **Mandatory on `VARIANCE_OPEN`**|
| `opened_at` / `decided_at`| timestamptz| no / yes||

**Invariants.**

- **`system_expected_minor` is derived and is not writable by any caller**. The rider supplies one figure and the hub supplies one; **the third belongs to neither party**.
- **A clean handover requires all three to agree.** `system_expected_minor = declared_total_minor = confirmed_total_minor`. **Rider and hub agreeing with each other is not reconciliation** — that is the R1 audit finding: expected **125**, declared **100**, counted **100** reached `CONFIRMED` cleanly, and a GH₵25 shortage disappeared because the two parties who could both be wrong were the only two figures compared.
- **`variance_minor` is measured against the system figure.** The declaration stays separately auditable — a rider who declares 100 against an expected 125 and hands over 100 has produced **one** variance and **one** disclosure, and both are worth keeping.
- **`gross_cash_minor` and `applied_expense_minor` are recorded separately** so the expected figure is reproducible from the record rather than asserted by it.
- **`confirmed_total_minor` is written by a hub actor and never by the rider** (§26.3, unchanged).
- **The hub's physical position increases by `confirmed_total_minor`, never by `system_expected_minor`**. A variance changes what the rider owes; it does not change what the hub is holding.

**Physical custody and financial accountability are separate, and R1.1 separated them**.

Expected **GH₵125**, rider declares **GH₵100**, hub counts and accepts **GH₵100**:

|||
|---|---|
| **Physical custody**| The hub holds **GH₵100**. **The rider does not still hold it**|
| **Financial accountability**| Rider variance **−GH₵25**, open|
| **Hub daily cash position**| **+GH₵100** — the amount actually received|

**A handover may transfer physical custody while remaining financially unresolved.** Requiring a clean reconciliation before recognising possession would leave money physically in a hub and attributed to a rider who no longer has it — and it is exactly the money most worth tracking, because a variance is open against it.

**Hub cash is never derived from the expected figure.** Not GH₵125, not GH₵0. **`hub_counted_amount` is what entered the hub**, and end-of-day reconciliation counts it whether the handover was clean or not.

- **Whether the declared total is withheld from the confirming officer is settled** — it is not.

### 6.12 Operational truth

Governed by §21.1, §24.2, §25.3, §26.2–§26.5, §34.10, §35.9, §35.12. Machines at [state-machines.md](state-machines.md) §20 — **all three unsigned**. Added 29 August by `MSC-DEC-301`–`MSC-DEC-339`.

**Four persistent entities, and one projection that is deliberately not persisted.** Each exists because an approved Gate C rule cannot be expressed without it — not because the subject felt incomplete.

#### `DeliveryCommitment`

`MSC-DEC-305`, `MSC-DEC-306`, `MSC-DEC-307`, `MSC-DEC-308`. **Append-only.** One row per commitment state; the current commitment is the row with `superseded_at IS NULL`.

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `order_id`| uuid| no||
| `sequence`| int| no| 1 for the original commitment, incrementing per revision|
| `default_date`| date| no| The **calculated** service date. Preserved on every row, never recomputed|
| `requested_date`| date| yes| What the sender or recipient asked for|
| `committed_date`| date| no| **What Melarc promised**|
| `committed_window_start`| time| yes| From the hub's `delivery_service_window_start` at commitment time (§3.7)|
| `committed_window_end`| time| yes||
| `change_reason_code`| text| yes| **Mandatory from `sequence` 2 onward.** A `CommitmentChangeReason`|
| `requested_by_party`| enum| yes| `SENDER` · `RECIPIENT` · `MELARC` · `SYSTEM`|
| `approved_by_staff_id`| uuid| yes| The authorised actor who made the change (`delivery.commitment.revise`)|
| `sla_start_at`| timestamptz| no| **Pickup custody**, not hub arrival|
| `created_at`| timestamptz| no||
| `superseded_at`| timestamptz| yes| Null on the current row|

**Invariants.**

- **No row is ever updated except to set `superseded_at`.** A commitment that can be edited cannot record a missed promise, and the failure is silent and always favours Melarc.
- **`default_date` is carried forward unchanged on every revision.** It is the answer to *what would ordinary service have produced*, and recomputing it against a later date destroys that.
- **`sla_start_at` is set once, at custody**. Internal delay after pickup does not move it; a failed pickup means no commitment row exists yet.
- **A missed commitment is not repaired by a revision.** Superseding Tuesday with Wednesday leaves Tuesday's row intact with its own `committed_date`, which is what makes the miss provable.

#### `RoadExpense`

`MSC-DEC-314`, `MSC-DEC-315`, `MSC-DEC-319`.

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `rider_id`| uuid| no||
| `delivery_run_id`| uuid| yes| Null where the expense is not attributable to a single run|
| `motorcycle_id`| uuid| yes| Where the expense relates to a vehicle|
| `responsible_hub_id`| uuid| no| Derived scope, set at creation and immutable|
| `category_code`| text| no| From the configurable catalogue — `FUEL`, `PUNCTURE_REPAIR`, `MINOR_MAINTENANCE`, `TOLL_OR_PARKING`, `EMERGENCY_OPERATIONAL_EXPENSE` seeded|
| `amount_minor`| int| no||
| `funding_source`| enum| no| **`COLLECTION_CASH` · `RIDER_PERSONAL` · `COMPANY_FLOAT`**. Never mixed|
| `description`| text| no||
| `evidence_id`| uuid| yes| Receipt or photo where the category requires it (§3.6)|
| `status`| enum| no| `CLAIMED` · `APPROVED` · `REJECTED` ([state-machines.md](state-machines.md) §20.1)|
| `decided_by_staff_id`| uuid| yes| Non-null from `APPROVED` or `REJECTED`|
| `decision_reason_code`| text| yes| **Mandatory on `REJECTED`**|
| `applied_to_cash_handover_id`| uuid| yes| **The one handover this expense reduced.** Set exactly once, at application; **immutable thereafter**. **Nullable and not column-unique** — many expenses may name one handover. Null while unapplied|
| `applied_at`| timestamptz| yes| Non-null with `applied_to_cash_handover_id`|
| `incurred_at` / `created_at` / `decided_at`| timestamptz| no / no / yes||

**Invariants.**

- **`APPROVED` means eligible, not deducted**. An approved `COLLECTION_CASH` expense reduces the expected handover **only when it is applied** to one specific handover through `applied_to_cash_handover_id`. **Approval and application are different events, and only the second moves money** — which is what makes the one-time rule enforceable at all: a deduction that happened at approval would have **no handover to be bound to**.
- **`CLAIMED` and `REJECTED` leave the cash owed**, and **unresolved is treated as not-approved** — otherwise the control is bypassed by not deciding.
- **`RIDER_PERSONAL` never changes the handover**; it records a reimbursement obligation the Accounting domain consumes.
- **`COMPANY_FLOAT` reconciles against the float and never against recipient cash**.
- **This is not `FuelRecord`.** `FuelRecord` answers a **fleet** question — what this motorcycle consumed, and is the pattern anomalous. `RoadExpense` answers a **cash** question. A fuel purchase is both, and the records relate rather than duplicate.
**One-time application, enforced structurally** (`MSC-DEC-341`, Gate C R1). An approved `COLLECTION_CASH` expense may reduce **exactly one** cash handover.

- **`applied_to_cash_handover_id` is write-once per row and immutable once set**. **It is not unique across the column**: `CashHandover 1 ← 0..N RoadExpense`, so fuel and a puncture repair on the same run both bind to the same handover.
- **An expense that already names a handover can never name another** — that is what prevents double deduction, and it is a property of the row, not of the column.
- **Eligibility for deduction is four conditions, all of them:** `status = APPROVED` · `funding_source = COLLECTION_CASH` · relevant to the rider and operational period being reconciled · **`applied_to_cash_handover_id IS NULL`**.
- **The relationship is the control, not a convention in application code.** R1's audit found nothing preventing the same GH₵20 fuel expense from reducing Monday's handover and Tuesday's — twice the deduction, once the money, and no record disagreeing with itself at any point.
- **An immutable application reference is preferred to a lifecycle state.** `APPLIED` as a fourth `RoadExpense` state would answer *has it been used* and not *by which handover*, and the second question is the one a reconciliation has to answer.

- **A major repair is not an ordinary road expense because it happened on the road.** Approval policy separates minor operational expense from maintenance; **no monetary threshold is modelled**, because none is approved.

#### Applying a Road Expense — the executable mechanism, Gate C R1.2

`MSC-DEC-341`, `MSC-DEC-344`, `MSC-DEC-345`. **Approval makes an expense eligible. Application is what moves money, and it happens at one named point.**

**When a `CashHandover` is opened**, the server:

| #| Step|
|---|---|
| 1| Resolves the rider, run and cash-custody records this handover covers|
| 2| Selects **eligible** expenses — `status = APPROVED` · `funding_source = COLLECTION_CASH` · this rider · this run or operational period · **`applied_to_cash_handover_id IS NULL`**|
| 3| **Binds each** to this handover: sets `applied_to_cash_handover_id` and `applied_at`, **once**|
| 4| Snapshots `applied_expense_minor` as the sum of what it just bound|
| 5| Derives `system_expected_minor` = `gross_cash_minor` − `applied_expense_minor`|

**The rider never types or chooses the expected amount**. Selection is **server-authoritative**: the eligibility rule decides, not the person being reconciled.

**There is no hidden step.** Before R1.2 the reference existed and nothing set it — a field with an invariant and no writer is a rule that cannot be broken because it cannot be exercised.

**Cardinality: `CashHandover 1 ← 0..N RoadExpense`**. Fuel **GH₵20** and a puncture repair **GH₵10** on the same run both bind to the same handover and deduct **GH₵30**. Each expense holds `0..1` handover; the reference is **write-once per row**, not unique per column.

**A second application is refused** — `ROAD_EXPENSE_ALREADY_APPLIED`. That, not column uniqueness, is what stops the same money being deducted twice.

**HIGH-03 audit remediation.** Steps 2 and 3 are one atomic conditional write per expense, not a select followed by a separate update — `applied_to_cash_handover_id` is set only where it is still `NULL`, in the same statement that reads it (`UPDATE ... WHERE applied_to_cash_handover_id IS NULL`, or the equivalent row-locking read). **This is what makes concurrency safe without a version field on `CashHandover`.** `CashHandover` does not exist yet when eligibility is evaluated — there is no prior record to version-check against, which is why the guard lives on `RoadExpense` instead. If a rider's client opens two handovers concurrently (a duplicate submission under a different `Idempotency-Key`, not a retry of the same one), each expense's write-once condition admits exactly one winner: the second transaction's conditional write matches zero rows for any expense the first already bound, and its own `applied_expense_minor` snapshot reflects only what it actually won — never a double-count, and never a silent loss of the guard under load. A naive read-then-write implementation of steps 2–3 would not have this property; the requirement is that the bind is conditional at the database layer, not merely checked in application code first.

#### `HubCashReconciliation`

`MSC-DEC-322`. One row per hub per operating day.

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `hub_id`| uuid| no||
| `business_date`| date| no| Unique with `hub_id`|
| `opening_position_minor`| int| no| Cash carried in from the previous day's disposition|
| `expected_minor`| int| no| Opening plus **`confirmed_total_minor` of every handover whose cash the hub physically accepted** — **including handovers in `VARIANCE_OPEN`**. The hub holds what it counted, whatever the rider owes|
| `counted_minor`| int| yes| **Physical count.** Non-null from `COUNTED` onward|
| `variance_minor`| int| yes| `counted − expected`. **Signed, and never zeroed by editing `expected_minor`**|
| `state`| enum| no| Four states at [state-machines.md](state-machines.md) §20.2|
| `variance_reason_code`| text| yes| Mandatory on `VARIANCE_OPEN`|
| `reconciled_by_staff_id`| uuid| yes| Holder of `payment.cash.reconcile_hub`|
| `opened_at` / `closed_at`| timestamptz| no / yes||

**Invariants.**

- **Hub variance is not rider variance**. Netting the two would assign a loss to whichever record was reconciled second.
- **A handover in variance still contributes its counted cash**. Counting only clean handovers would make the hub's expected position understate what is physically in the safe — and a hub short against its own count is the one discrepancy nobody could explain.
- **`expected_minor` is derived from accepted handovers and is never edited to match the count**.
- **Open cash past `cash_reconciliation_cutoff_time` is an exception requiring visibility, not a shortage**. A legitimately active run may still be out.

#### `CashDisposition`

`MSC-DEC-323`. Where the money actually went.

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `hub_cash_reconciliation_id`| uuid| no||
| `hub_id`| uuid| no| Derived scope, immutable|
| `amount_minor`| int| no||
| `method`| enum| no| `BANK_DEPOSIT` · `MERCHANT_MOMO_TRANSFER` · `FINANCE_HANDOVER` · `SAFE_CUSTODY`|
| `destination`| text| no| Account, recipient or location as the method requires|
| `reference`| text| yes| Deposit slip, transfer reference. **Mandatory for `BANK_DEPOSIT` and `MERCHANT_MOMO_TRANSFER`**|
| `evidence_id`| uuid| yes| Where the method requires proof|
| `recorded_by_staff_id`| uuid| no| Holder of `payment.cash.disposition`|
| `recorded_at`| timestamptz| no||

**Invariants.**

- **Cash is not settled because a rider handed it to a hub**. This row is the last custody transfer, and it is the one nobody naturally records.
- **This creates no accounting entry.** It is the operational source event the future Accounting domain consumes (§58 of the Gate C instruction).

#### `AccountingExport`

`MSC-DEC-401`. **A canonical extract of payment facts for a closed period. Creates no accounting entry and moves no money.**

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `scope`| enum| no| `SINGLE_HUB` · `ALL_HUBS`|
| `hub_id`| uuid| yes| **Mandatory for `SINGLE_HUB`, null for `ALL_HUBS`**|
| `period_from` · `period_to`| date| no| The closed hub-day range, both inclusive. **Every day in the range must have a closed `HubCashReconciliation`** (§5.1 of the pass plan; `MSC-DEC-322`)|
| `schema_version`| text| no| The **export-format** version, versioned independently of `openapi.yaml`|
| `status`| enum| no| `AccountingExportStatus` — `REQUESTED` · `GENERATED` · `FAILED`. **No machine**, and [state-machines.md](state-machines.md) §20.7 records why|
| `requested_by_staff_id`| uuid| no| Holder of `payment.ledger.export`|
| `requested_at`| timestamptz| no||
| `generated_at`| timestamptz| yes| Non-null from `GENERATED`|
| `failure_reason_code`| text| yes| **Mandatory on `FAILED`**|
| `manifest_digest`| text| yes| SHA-256 of the package manifest. Non-null from `GENERATED`. **Survives file expiry**|
| `row_counts`| embedded| yes| Per-record-type row counts, mirroring the manifest. **Survives file expiry**|
| `storage_ref`| text| yes| Opaque. **Never returned to a client** — retrieval is a short-lived authorization, never a stored URL|
| `file_available_until`| timestamptz| yes| Computed at generation from `accounting_export_file_retention_days`. Null before generation|

**Invariants.**

- **A package is never regenerated in place.** A re-run is a **new record**, which is §5.5's own rule that a fact is never rewritten and a correction is a new record.
- **The record is permanent; the file is not.** `manifest_digest` and `row_counts` outlive `file_available_until`, so the fact that an export happened — and what it contained — is answerable after the package is gone.
- **Generation has two readiness gates**, each with its own error code: the retention figure must be set, and every canonical record type must be `EVENT_COMPLETE`. **A package that cannot carry a `PaymentReceipt` reversal is not a canonical accounting export**, however clearly its manifest declares the gap.
- **It creates no accounting entry**, the same boundary `CashDisposition` and `FinancialAdjustmentResolution` already hold. §14.1 places general accounting outside Version 1; this exports source facts to a system that runs one.

#### Pickup intent — `PickupRequest`, Gate C R1

`MSC-DEC-335`. Gate C named three intents and left them an enum nothing carried. **`PickupRequest` now carries the discriminator and the data each intent needs.**

| Field| Type| Null| Notes|
|---|---|---|---|
| `pickup_intent`| enum| no| **`OWN_PACKAGES` · `COLLECT_FOR_VENDOR` · `ADHOC_SENDER`**|
| `vendor_organization_id`| uuid| yes| **Required** for `OWN_PACKAGES` and `COLLECT_FOR_VENDOR`; null for `ADHOC_SENDER`|
| `ad_hoc_sender_id`| uuid| yes| **Required** for `ADHOC_SENDER`; null otherwise. Reused on a return visit|
| `vendor_pickup_location_id`| uuid| yes| The saved location for `OWN_PACKAGES`. Not used by `COLLECT_FOR_VENDOR`|
| `collection_point`| embedded| yes| **Required** for `COLLECT_FOR_VENDOR`, forbidden otherwise — pickup person or business, phone, address, coordinates or landmark where supported|
| `collection_reference`| embedded| yes| **Required** for `COLLECT_FOR_VENDOR` — reference name, and the seller order or reference number where provided|
| `collection_item`| embedded| yes| **Required** for `COLLECT_FOR_VENDOR` — description, evidence reference for the picture, quantity, handling note|
| `destination_location_id`| uuid| yes| For `COLLECT_FOR_VENDOR`: the Vendor's saved location or another approved destination|
| `resolved_pickup_location`| embedded| no| **Derived from the intent** — the Vendor's saved location, the AdHocSender's, or **the external collection point**. Never the Vendor's address on a `COLLECT_FOR_VENDOR` request|
| `current_item_description`| text| yes| **Today's goods, on the request.** Mandatory for `ADHOC_SENDER`; optional for `OWN_PACKAGES`, where the Vendor's business goods profile already satisfies §21.1; unused by `COLLECT_FOR_VENDOR`, whose `collection_item` carries it|

**Invariants.**

- **The intent decides which fields are required, and the invalid combinations are refused rather than tolerated.** `COLLECT_FOR_VENDOR` without a `collection_point` fails validation; `OWN_PACKAGES` carrying one is not a pickup from the Vendor's own address and is refused as mis-declared.
- **An established Vendor is not re-onboarded.** `OWN_PACKAGES` captures only what changes today — package count, requested service date, the saved location where several exist, current notes, and the one-package exception where it applies.
- **`COLLECT_FOR_VENDOR` is not merchandise COD**. **A Rider is not authorised to pay the seller** from rider, company or customer funds; no approved decision creates that service.
- **`ADHOC_SENDER` creates or reuses the canonical `AdHocSender`**, found by verified phone. **It is never auto-promoted to a registered Vendor** — §35.12.1 forbids self-registration and §35.12.2 requires a separate approver, and promotion by volume routes around both.
- **All three intents are creatable by Ops from WhatsApp intake**. The channel supplies the message; **the canonical record is the same one the PWA produces**, under the same cutoff, minimum, approval, handling, serviceability, pricing, payer and acknowledgement rules.

#### Creating the initial commitment — Gate C R1

`MSC-DEC-305`, `MSC-DEC-308`. Gate C defined the commitment record and **never said where the first one comes from**. It comes from itemization, and it carries a timestamp from before the Order existed.

**The lifecycle fact that forces this:** a pickup is a batch of packages, and **the individual `Order` does not exist at pickup**. It is created at itemization (§23), hours after the custody that started its promise.

| #| Step|
|---|---|
| 1| Itemization creates the `Order`|
| 2| Read the **successful pickup-custody timestamp** from the authoritative lineage — `CollectionRecord` → `PickupStop` → `PickupManifest`|
| 3| Set `sla_start_at` to **that earlier timestamp**|
| 4| Derive `default_date` from the **custody date**, not from today|
| 5| Apply the published corridor schedule where the destination has one|
| 6| Apply an accepted sender or recipient requested date|
| 7| Write the initial `DeliveryCommitment` at `sequence = 1`|

**The commitment is created at itemization and the clock starts at pickup.** Hub arrival, intake completion and itemization completion **never reset it** — internal delay after custody would otherwise buy Melarc time against its own promise, measured from an event the sender cannot observe.

**Where custody never happened there is no commitment.** A failed pickup leaves no `sequence = 1` row; a later successful pickup establishes the real start.

**Idempotency.** `(order_id, sequence)` is unique, so an itemization retry cannot produce a second initial commitment. **Exactly one `sequence = 1` row exists per Order**, and every later change appends `sequence = 2, 3, …` rather than overwriting it — which is what makes the original promise, and any miss against it, permanently provable.

#### `DeliveryRun` closure — three dimensions, derived — Gate C R1

`MSC-DEC-325`. Gate C stated the three dimensions and left `DeliveryRun.state = COMPLETED` as the only structural signal, which means *route execution finished* and is routinely read as *everything is settled*.

| Derived field| True when| Source|
|---|---|---|
| `route_closure_status`| Every scheduled stop is terminal — `DELIVERED`, `FAILED` or `SKIPPED`| `DeliveryStop` states|
| `custody_closure_status`| Every parcel is in an approved final or current custody location — delivered, returned to hub, or transferred by `RunCustodyHandover`| `Order` fulfilment state and custody records|
| `financial_closure_status`| Every run-linked payment and cash obligation is reconciled or formally resolved| `RiderCashCustody`, `CashHandover` — including **`system_expected_minor` agreement** — and unresolved variances|
| `fully_closed`| **All three** are complete| The three above|

**Every one of these is derived, never a manually editable flag.** A truth flag an operator can set is a claim, and the whole point of the three dimensions is that a run finishing its route says nothing about the GH₵145 in a rider's pocket or the two undelivered parcels in their box.

**`state = COMPLETED` keeps its meaning and loses its overload.** It reports route execution. It no longer stands in for custody or money.

**If a persistent snapshot is ever taken for performance or audit, it must record its source and refresh invariant** — a cached closure status that can silently disagree with the records beneath it is the same defect in a faster form.

#### The resolved pickup location — Gate C R1.2

`MSC-DEC-335`. **A `PickupRequest` carries one authoritative pickup location, whatever intent created it**, because dispatch and the rider read one field.

| Intent| `resolved_pickup_location` derives from|
|---|---|
| `OWN_PACKAGES`| The Vendor's selected or default saved pickup location|
| `ADHOC_SENDER`| The AdHocSender's pickup location — the stored one on a return visit, the supplied one on a first|
| `COLLECT_FOR_VENDOR`| **The external collection point.** The parcel is not at the Vendor's address; that is the whole intent|

**The request expresses it differently by intent; the record does not.** A rider given a `COLLECT_FOR_VENDOR` stop needs an address, and *the Vendor's saved location* is the wrong one — it is where the parcel is going, not where it is.

**`resolved_pickup_location` is non-null on every persisted request.** The create contract's `pickup_location` is the sender's own address and is omitted for `COLLECT_FOR_VENDOR`; the server resolves the authoritative field from the intent.

#### Current-transaction goods — Gate C R1.2

**What is being sent today is transaction data, not profile data.**

| Intent| Goods description|
|---|---|
| `ADHOC_SENDER`| **Captured on the request, every time.** A returning sender's identity, contact and locations are reused; **today's goods are not.** Last month's *women's shoes* is not evidence about this box|
| `OWN_PACKAGES`| The Vendor's established business goods profile satisfies the intake requirement. A transaction note is available where the shipment differs from it — **an established Vendor is not re-onboarded daily**|
| `COLLECT_FOR_VENDOR`| `collection_item` already carries description, quantity and picture — it is a third-party collection and nothing about it is profile data|

#### The two attempt counters, named

`MSC-DEC-310`, refined by `MSC-DEC-346`, `MSC-DEC-350` and `MSC-DEC-351`. **Three counts measuring different things — and no current fixed ceiling on physical trips or on contact calls.**

| Field| Owner| Counts|
|---|---|---|
| `confirmation_attempts`| `RecipientConfirmation` (§6.10)| Contact attempts **before dispatch**. **Uncapped** — audit history, not a gate.|
| `delivery_attempts`| `Order` (§6.7), incremented by a `DeliveryStop` outcome| **Physical doorstep attempts only** — a stop the rider actually reached. **Never incremented by a `PRE_DISPATCH` or `NEXT_STOP` contact failure**|
| `RecipientContactAttempt` rows| Per checkpoint, per order| **Contact checkpoints** — `PRE_DISPATCH`, `NEXT_STOP`, `DOORSTEP`. **Not a count and not capped at three trips**: three chances to reach a person|

**No contract or surface may present one ambiguous `attempts` count.** A recipient may exhaust every confirmation attempt and still have **zero** delivery attempts.

**`delivery_attempts` increments only where the failure reason says so.** `ReasonCode.consumes_delivery_attempt` decides it, so a Melarc outage costs the customer nothing.

**The three checkpoints are not a ceiling of three trips.** Contact checkpoints are distinct from physical doorstep attempts. A physical attempt is counted only when the rider reached the door; there is no fixed journey ceiling.

**Three counts, three meanings, and none is the others** *(Gate C C1.3)*: **contact attempts** (how many calls — uncapped, audit only), **contact checkpoints** (three), and **physical delivery attempts** (trips where a rider reached a door — **one per trip**, each further trip a redelivery). *Superseded reading follows.*


#### `RecipientContactAttempt` — the canonical checkpoint record, Gate C C1.2

`MSC-DEC-346`. **One record type for all three checkpoints.** `RecipientConfirmation`'s embedded attempt rows are **generalised** into this entity rather than duplicated: a second contact log covering the same act is a second truth, and the two would disagree within a week.

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `order_id`| uuid| no| The parcel this concerns|
| `recipient_confirmation_id`| uuid| yes| Set for `PRE_DISPATCH` — the confirmation this attempt belongs to|
| `delivery_run_id`| uuid| yes| Set for `NEXT_STOP` and `DOORSTEP`|
| `delivery_stop_id`| uuid| yes| Set for `NEXT_STOP` and `DOORSTEP`|
| `checkpoint`| enum| no| **`PRE_DISPATCH` · `NEXT_STOP` · `DOORSTEP`**|
| `performed_by_staff_id`| uuid| no| The principal who made contact|
| `performed_by_actor_type`| enum| no| **`RIDER` · `OPS`** — who acted, kept beside the principal because the workflow differs|
| `performed_at`| timestamptz| no||
| `contact_number_used`| text| yes| E.164 plus as-entered, per §3.4. **The number actually dialled**, which may be a Vendor-supplied correction rather than the saved one|
| `outcome`| enum| no| **`SUCCESSFUL` · `UNSUCCESSFUL`**|
| `reason_code`| text| yes| **Required when `UNSUCCESSFUL`** — an `active` `RecipientContactReason` valid for this checkpoint|
| `vendor_notification_state`| enum| yes| `NOT_REQUIRED` · `REQUIRED` · `QUEUED` · `SENT` · `FAILED` · `ACKNOWLEDGED`|
| `ops_followup_state`| enum| yes| `NOT_REQUIRED` · `REQUIRED` · `IN_PROGRESS` · `RESOLVED`|
| `delivery_commitment_id`| uuid| yes| The revision a `RESCHEDULE_REQUESTED` outcome produced, once Ops made it|
| `location_change_request_id`| uuid| yes| The request a `LOCATION_CHANGE_REQUESTED` outcome produced|
| `wait_started_at`| timestamptz| yes| **`DOORSTEP` only.** Server-set when the controlled wait begins|
| `wait_expires_at`| timestamptz| yes| **`DOORSTEP` only.** Server-derived: `wait_started_at` + `doorstep_wait_minutes`|
| `note`| text| yes||

**Invariants.**

- **`checkpoint` decides which parent is set.** `PRE_DISPATCH` carries a `recipient_confirmation_id` and no stop; `NEXT_STOP` and `DOORSTEP` carry a stop.
- **`reason_code` must be valid for this `checkpoint`.** A reason seeded for `PRE_DISPATCH` is not selectable at a doorstep, and the catalogue carries the mapping — seeded at `MSC-DEC-409` (§3.9). **Only `RECIPIENT_NOT_AT_LOCATION` is checkpoint-restricted**, to `DOORSTEP`, because it is the one code that asserts physical presence at the authorised location.
- **`PRE_DISPATCH`'s four outcomes map onto this record's two**. `confirmed`, `reschedule` and `address_correction` are **`SUCCESSFUL`** — the person was reached, and a held order is not a failed call — and carry no `reason_code`; **`unreachable` is `UNSUCCESSFUL`** and carries one.
- **`vendor_notification_state` is derived from the reason, not configured**. `NUMBER_INCORRECT` and `RECIPIENT_DECLINED` are `REQUIRED`; `CONTACT_NOT_POSSIBLE_MELARC` and `RECIPIENT_NOT_AT_LOCATION` are `NOT_REQUIRED`; `NO_ANSWER` raises none independently, and where an approved rule already notifies — §11's `AWAITING_ATTEMPT → ATTEMPTED_NO_ANSWER` effect — that rule still governs. **§3.9 carries no flag for this and gains none**: a configurable switch could turn off a notice the Vendor relationship requires.
- **`wait_started_at` and `wait_expires_at` are server-written and never client-supplied**. A rider cannot post an expiry.
- **Every attempt is a row.** §24.2 requires attempts logged and *"not kept only in transient UI state"* — a count cannot answer *when*, *who called*, or *what happened*.
- **A failed Vendor notification never erases the contact event.** `vendor_notification_state = FAILED` is a visible operational state, not a deletion.

#### Contact checkpoints versus physical delivery attempts

`MSC-DEC-346`. **Two different things, counted in two different places, and the reason a single `attempts` integer is forbidden.**

| Concept| Where it lives| What increments it|
|---|---|---|
| **Contact checkpoint**| `RecipientContactAttempt` rows, per `checkpoint`| Any contact act — a call before dispatch, a call from the previous stop, a call at the door|
| **Physical delivery attempt**| `Order.delivery_attempts`| **Only** a `DOORSTEP` checkpoint that the rider actually reached|
| **Redelivery**| A later physical trip after a failed physical attempt| Ops authorising a new trip|

**A recipient may exhaust all three contact checkpoints with zero physical delivery attempts against them.** That is the ordinary unreachable-number case, and it is exactly what the old single counter reported wrongly — as three failed deliveries the customer had used up.

**`consumes_delivery_attempt` survives and narrows** (`MSC-DEC-309`, refined by `MSC-DEC-346`). It still decides whether a **physical** attempt is counted, and it **no longer has anything to do with the three checkpoints**. A `NEXT_STOP` failure consumes no physical attempt, whatever any reason's metadata says, because the rider never reached the door.

#### The doorstep wait

`MSC-DEC-349`. **10 minutes, server-timed.**

| Step||
|---|---|
| 1| Rider arrives; arrival is recorded against the stop|
| 2| Contact fails; rider records the reason and **Ops is alerted**|
| 3| Server sets `wait_started_at` and derives `wait_expires_at` from `doorstep_wait_minutes`|
| 4| Retries by rider, Ops or Vendor happen **inside** this checkpoint|
| 5| Recipient appears → the delivery continues. **No failure, no redelivery**|
| 6| Expiry passes and nothing has recovered → the **physical attempt** may be marked failed|

**The guard reads server time, never a client claim.** `MSC-DEC-349` states the reason plainly: the one party with an interest in leaving is the wrong clock. A qualifying reason such as an in-person refusal may terminate earlier on its own authority.

#### Location change — the original destination survives

`MSC-DEC-348`. A recipient may ask for a different delivery location; **a rider records the request and Ops decides it.**

| Field| Notes|
|---|---|
| `original_location`| **Never overwritten.** The destination the order was accepted against|
| `requested_location`| What the recipient asked for|
| `authorised_location`| What Ops approved, where it approved anything|
| `decided_by_staff_id` · `decided_at` · `reason`| The decision record|
| `serviceability_outcome`| Hub ownership, corridor and service-day rules, pricing and route feasibility — assessed **before** acceptance|

**The parcel does not travel to an unapproved destination.** A rider who could redirect a parcel could move it outside its hub's service area, past a corridor day, and off the price it was sold at.

#### `RedeliveryRecord` — Gate C C1.3

`MSC-DEC-350`. **A redelivery is a new trip with its own commercial record, and the original keeps its own.**

**Reuse first, and it nearly worked.** `DeliveryCommitment` carries the new date, `DeliveryRun` and `DeliveryStop` carry the new trip, and `Order` carries charges. What none of them holds is **the link from a failed physical attempt to the trip that answers it, with two fees snapshotted at the moment Ops decided** — so that link becomes one small record rather than four inferred joins.

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `order_id`| uuid| no||
| `originating_delivery_stop_id`| uuid| no| **The failed physical `DeliveryStop` this answers.** Never a `PRE_DISPATCH` or `NEXT_STOP` failure — those are not physical attempts|
| `sequence`| int| no| 1 for the first redelivery, 2 for the next. **No maximum** — each trip needs its own Ops approval|
| `scheduled_by_staff_id`| uuid| no| **Authorised Ops.** The act that creates the obligation|
| `scheduled_at`| timestamptz| no| **The snapshot moment**|
| `delivery_commitment_id`| uuid| no| The new commitment. **The original is preserved, never overwritten**|
| `destination_location`| embedded| no| Resolved at scheduling, including any approved location change|
| `applicable_delivery_fee_minor`| int| no| **Snapshotted.** Derived from destination, service type, corridor rules and pricing configuration — **the ordinary rules on a new trip**|
| `redelivery_fee_minor`| int| no| **Snapshotted** from the hub's `redelivery_fee_minor`. A later setting change never rewrites this|
| `total_due_minor`| int| no| The two above. **GH₵35 + GH₵20 = GH₵55** in the Accra example|
| `payer`| enum| no| **`RECIPIENT`, always**. Not settable by ordinary Ops|
| `chargeable`| bool| no| **False where the originating reason attributes the failure to Melarc** — a rider breakdown or a provider outage bills nobody. Both fee fields are then `0`|
| `payment_state`| enum| no| Follows the ordinary recipient-payment workflow|
| `delivery_run_id` · `delivery_stop_id`| uuid| yes| Set when the new trip is built|
| `status`| enum| no| `SCHEDULED` · `IN_PROGRESS` · `COMPLETED` · `CANCELLED`|

**Invariants.**

- **The obligation is created by scheduling and by nothing earlier**. A parcel may sit at the hub **eligible and unscheduled**, owing nothing.
- **`chargeable` is derived from the originating reason's metadata**, never chosen by the scheduling officer. **Recipient is the payer when a chargeable obligation exists** — that is two rules, and collapsing them bills a customer for Melarc's outage.
- **Both fees are snapshots.** Re-reading the hub setting later would silently reprice a scheduled trip.
- **The original trip's fee is untouched** — not refunded, reversed or relabelled (§30). Two events, two records.
- **Scheduling is idempotent.** A retried approval creates no second record, no second commitment, no duplicate fee and no duplicate notification.
- **A redelivery runs the same three checkpoints.** It is a delivery cycle, not attempts four, five and six.

**A redelivery is not a Return.** Return-to-vendor is a separate Ops decision with its own fee, and **`redelivery_fee_minor` and `flat_return_fee_amount` are separate settings**. They share a launch figure in Accra and nothing else.

#### `OperationalPaymentDemand` — Gate C C1.5

`MSC-DEC-356`. **The exact amount being asked of one payer in one interaction, and the obligations it covers.**

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `hub_id`| uuid| no| Scope|
| `payer_type`| enum| no| `RECIPIENT` · `VENDOR` — who is being asked|
| `payer_ref`| uuid| yes| The payer's record where one exists|
| `order_id`| uuid| yes| Where the demand belongs to an order|
| `currency`| text| no| **`GHS`**|
| `total_due_minor`| int| no| **The sum of its lines.** Server-computed, never supplied|
| `confirmed_receipts_minor`| int| no| **Cumulative confirmed eligible principal across every receipt** against this demand. The figure atomic settlement watches|
| `allocated_minor`| int| no| Principal actually applied to lines. **Zero until settlement fires** — a short payment allocates nothing|
| `remaining_due_minor`| int| no| `total_due_minor` − `confirmed_receipts_minor`, floored at zero. **What the next collection asks for**|
| `excess_minor`| int| no| Confirmed principal above the total. **Never allocated anywhere**; it raises an adjustment|
| `status`| enum| no| `OPEN` · `PARTIALLY_SETTLED` · `SETTLED` · `VOID` — defined below|
| `created_at` · `frozen_at` · `fully_settled_at` · `voided_at`| timestamptz| no/yes/yes/yes||
| `business_key`| text| no| Idempotent identity — one demand per payer per obligation set|

#### `PaymentDemandLine` — Gate C C1.5

| Field| Type| Null| Notes|
|---|---|---|---|
| `id` · `demand_id`| uuid| no||
| `obligation_type`| enum| no| `DELIVERY_FEE` · `REDELIVERY_DELIVERY_FEE` · `REDELIVERY_FEE` · `SINGLE_PACKAGE_PICKUP_FEE` · another modelled operational fee|
| `obligation_ref`| text| no| The obligation this line settles|
| `description_code`| text| no| What the payer is being charged for|
| `principal_due_minor`| int| no| **Snapshotted from the authorising commercial record**|
| `principal_settled_minor`| int| no| `0` until allocated|
| `status`| enum| no| `OPEN` · `SETTLED` · `VOID`|
| `pricing_snapshot_ref`| text| no| The immutable pricing record this amount came from|

**A redelivery, worked through.**

| Line| Amount|
|---|---|
| `REDELIVERY_DELIVERY_FEE`| **GH₵35**|
| `REDELIVERY_FEE`| **GH₵20**|
| **Demand total**| **GH₵55**|

**One prompt of GH₵55.** One `PaymentAttempt`, one provider request, one receipt, **two allocations** — GH₵35 to the first line, GH₵20 to the second, both `SETTLED`. **The payer is never asked to approve twice for one delivery.**

**Invariants.**

- **Frozen once an attempt exists**. Amount and line composition cannot move while a customer is being asked to pay them, and **no Rider or Ops screen can edit either**. A genuine change goes through the commercial workflow and produces a new demand.
- **`total_due_minor` is the sum of the lines.** It is computed, never entered.
- **`PARTIALLY_SETTLED` means partially *funded*, not partially settled**: `confirmed_receipts_minor` is above zero and below `total_due_minor`, and **no line allocation has been finalised**. It does not permit handover. It is an exception state, not a payment plan.
- **Status is not derived from line states alone.** `OPEN` and `PARTIALLY_SETTLED` have **identical** line states — every line `OPEN`, nothing allocated — and **only the receipt total distinguishes them**. A status computed from lines could not tell a demand nobody has paid from one a customer has part-funded.
- **Settlement is atomic.** When cumulative confirmed principal reaches the frozen total, **every line is allocated its exact `principal_due_minor` in one act**. Below that, **nothing is allocated at all** — and **no allocation priority exists**, because there is never a part-settled line for one to apply to.
- **It is not a ledger.** It answers *what are we asking this payer for now* and stops; **Accounting & Reporting** owns the general ledger, receivables, statements and settlement.

**Where a demand comes from**. **The backend creates and resolves it from authoritative commercial obligations. A client never constructs lines and never names an amount.**

| Obligation| Materialised|
|---|---|
| Delivery fee| As the order becomes payable|
| Redelivery — both lines| **At Ops scheduling**, the act that creates the obligation|
| Single-package pickup fee| When the approved exception prices it|
| Return fee — **ad-hoc sender only**| **At `ReturnRecord` commitment** (§6.14, `MSC-DEC-332`), reading `effective_return_fee_minor`. **Not materialised for a registered vendor's return** — that fee is earned on the same record and settled through the future `VendorStatement` mechanism instead, never through this demand|

**"Delivery fee" already covers Station Drop, and no second obligation type exists for it**
(Accounting, Finance & Reporting Pass 2, `OQ-123`). `Order.price_components_snapshot` (§6.7)
prices a `STATION_DROP` order from its station-drop-fee component exactly as it prices a
doorstep order from its service-area-base-fee component — one order, one `locked_price_minor`,
one `payer_allocation`, gated through this same demand mechanism (§24.7.1, `MSC-DEC-177`;
`commercial_state`'s `PAYMENT_REQUIRED → PREPAID` guard is unqualified by lane or mode). The
**outbound charge gate** (`OUTBOUND_CHARGE_UNPAID`, state-machines.md §9) is a stricter
*readiness* test on this identical obligation — actual payment where the ordinary gate would
accept a credit reservation — never a second obligation to model. Distinguishing Station Drop
revenue from ordinary doorstep revenue is therefore a report-layer join on `Order.commercial_mode`
via `OperationalPaymentDemand.order_id`, both already modelled, not a contract change.

**Reading resolves; it does not invent.** Where a payable obligation has no demand yet, the read materialises the one its obligations already determine, under the same `business_key`. **Opening the rider's payment screen five times produces one GH₵55 demand, not five.**

**One current open demand per payer per obligation set**, enforced by `business_key` and not by convention. Two equivalent open demands mean two prompts for one delivery.

**Both surfaces reach it through a documented read** — the stop's payment view for the assigned Rider, the same view and a hub-scoped list for Ops. **A required id with no producer is not an executable contract**: `initiatePaymentCollection` demanded a `payment_demand_id` that **no operation produced**, leaving a database lookup, an undocumented call or a typed UUID as the only routes, and all three mean the path does not exist.

**Status is derived, never set by an operator** — and it derives from **three inputs, not from line states alone**:

| Status| Derived when|
|---|---|
| `OPEN`| **No eligible confirmed principal has been received**|
| `PARTIALLY_SETTLED`| Confirmed eligible principal is **above zero and below `total_due_minor`**, and **atomic line allocation has not completed**|
| `SETTLED`| The **full total has been atomically allocated** to every frozen line|
| `VOID`| The underlying obligations are **no longer payable** under the approved workflow|

The three inputs are **confirmed eligible receipts**, **allocations**, and **obligation validity**. **`OPEN` and `PARTIALLY_SETTLED` have identical line states**, so a rule reading lines alone cannot tell a demand nobody has paid from one a customer has part-funded. **No Rider or Ops screen writes it.**

#### `FinancialAdjustmentRequired` — Gate C C1.5

`MSC-DEC-357`. **The fact that money is owed back. Not the remedy.**

| Field| Type| Null| Notes|
|---|---|---|---|
| `id` · `hub_id`| uuid| no||
| `payment_demand_id`| uuid| no| The demand the money was taken against|
| `payment_attempt_id` · `payment_receipt_ref`| uuid/text| yes| The source receipt|
| `order_id`| uuid| yes| Payer context|
| `reason`| enum| no| **`DUPLICATE_PAYMENT` · `OVERPAYMENT` · `PAID_OBLIGATION_VOIDED` · `LATE_PROVIDER_SUCCESS_AFTER_FALLBACK`**|
| `amount_minor` · `currency`| int/text| no| What is owed back|
| `raised_at`| timestamptz| no||
| `status`| enum| no| **`OPEN` · `RESOLVED`.** `OPEN` was the only status **Gate C** could write; `RESOLVED` is written by the Accounting domain when a `FinancialAdjustmentResolution` is `APPROVED` (§6.15, `MSC-DEC-395`) — never by any Gate C operation|
| `source_key`| text| no| **Idempotent.** One source condition raises one record|

**Invariants.**

- **`OPEN` is the only status Gate C writes**. Refund, credit and allocation are **Accounting & Reporting's**, and deciding them here would put a refund policy in a delivery specification. **That domain has now decided them** (`MSC-DEC-395`, §6.15): the remedy is a separate record, and `RESOLVED` is reached only by an approved one. **No Gate C operation writes it**, which is why this invariant still holds as written.
- **One source condition, one record.** A late-success callback delivered three times produces **one** receipt effect and **one** adjustment — the receipt's idempotency, applied to its consequence.
- **No payment is reversed or deleted to raise one.** Both receipts stand; the record is what points at the difference.

**Without it, money that arrived twice has nowhere to be**: the obligation reads settled, both payments are real, and a customer's money sits in Melarc's account with nothing naming it.

**HIGH-04 / HIGH-12 audit remediation.** The resolution this record is waiting for — refund, credit, or allocation, and the permission keys and workflow to carry it out — is **`OQ-005`**, narrowed at Gate C R1 to *"deeper payment allocation, reversal and refund design"* inside the future Accounting, Finance & Reporting domain. Named here so a reader who finds `OPEN` with nowhere to go next finds the tracked question, not a silent gap.

**`MSC-DEC-394`, 17 September 2026 (CRIT-07 audit widening, closed).** `initiateReturn` (§6.14) raises one with reason `PAID_OBLIGATION_VOIDED` when the order's delivery-fee demand already carries a confirmed `PaymentReceipt` — a split-payment recipient portion collected before all attempts failed — at the same moment the fee's underlying obligation is reversed. **No new reason value**: a paid obligation that is later reversed is exactly what `PAID_OBLIGATION_VOIDED` already names. The Product Owner decided the resolution class is **refund**, not credit or vendor liability — the money's actual movement stays `OQ-005`'s, unchanged by that decision.


#### `PaymentReceipt` — Gate C C1.6

`MSC-DEC-358`. **Money Melarc has confirmed receiving, through one method. Not a ledger entry.**

| Field| Type| Null| Notes|
|---|---|---|---|
| `id` · `hub_id`| uuid| no| Scope|
| `payment_demand_id`| uuid| no| What the money was received against|
| `method`| enum| no| **`HUBTEL` · `MERCHANT_MOMO` · `CASH`** — the already-authorised methods, and no other|
| `payment_attempt_id`| uuid| yes| The provider attempt, where one exists|
| `manual_source_ref`| text| yes| The Merchant MoMo verification or the doorstep cash record, where there is no attempt|
| `rider_cash_custody_id`| uuid| yes| **`CASH` only, and then mandatory**: the `RiderCashCustody` this receipt increased. Null for `HUBTEL` and `MERCHANT_MOMO`, which create no custody|
| `fallback_authorization_id`| uuid| yes| Set where the receipt was taken under an Ops duplicate-risk grant|
| `received_principal_minor`| int| no| **What actually arrived.** Never the amount requested, and never net of a provider fee|
| `currency`| text| no| **`GHS`**|
| `provider_transaction_id` · `provider_reference`| text| yes| As returned|
| `payer_msisdn_masked` · `payer_context`| text| yes| Who paid, at the disclosure level the reader is entitled to|
| `confirmed_at`| timestamptz| no| When the method's confirmation was accepted|
| `received_by_principal_type` · `received_by_principal_id`| enum/uuid| yes| **`RIDER` · `STAFF` · `SYSTEM`** — the actor for cash and manual confirmation; the trusted service for provider truth|
| `source_key`| text| no| **Idempotent identity** — provider and transaction reference, or the canonical equivalent for a manual or cash source|
| `status`| enum| no| `CONFIRMED` · `REVERSED_BY_PROVIDER`|

**Invariants.**

- **One source condition, one receipt**. The same provider success delivered three times produces **one** record, keyed by `source_key`.
- **A confirmed receipt is never deleted because the obligation was later voided.** The money arrived. Deleting it is how a customer's payment silently becomes Melarc's — the condition `FinancialAdjustmentRequired` exists to make visible.
- **A receipt short of the demand total is still a receipt**. A provider that authoritatively transferred GH₵50 against GH₵55 **transferred GH₵50**, and recording that as a failure models money that arrived as money that did not. **What a short receipt does not do is settle a line.**
- **Two real payment events are two receipts.** A Merchant MoMo fallback of GH₵55 and a late Hubtel success of GH₵55 are **both true**, and collapsing them destroys the evidence that a refund is owed. **The demand still settles once.**
- **`received_principal_minor` is the confirmed principal**, never the amount charged and never net of `provider_fee_minor`. **Processing cost is not deducted from what a customer owes.**
- **A cash receipt does not replace `RiderCashCustody`.** This record answers *what payment did Melarc accept*; custody answers *who physically holds the notes*. **Both are written, and they are not one entity.**
- **A `CASH` receipt names exactly one `RiderCashCustody`, and that custody's `collected_minor` is the sum of its receipts**. Two cash tenders on one order are **two receipts and one custody record**; a GH₵50 tender is a GH₵50 receipt whatever the demand total, because a short tender is money received.
- **A `HUBTEL` or `MERCHANT_MOMO` receipt creates no rider cash**: confirmed digital, rider physical cash **zero**.
- **No operator creates one directly.** A receipt is the recorded consequence of a method confirming.

#### `PaymentAllocation` — Gate C C1.6

`MSC-DEC-358`. **What a receipt settled. Immutable once written.**

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `payment_receipt_id` · `payment_demand_line_id`| uuid| no| The pair. One receipt may allocate across **several** lines|
| `amount_minor`| int| no| The part of the receipt applied to this line|
| `allocated_at`| timestamptz| no||
| `source_key`| text| no| **Idempotent.** A replayed settlement re-applies nothing|

**Invariants.**

- **The sum of a receipt's allocations never exceeds `received_principal_minor`.** A receipt cannot settle more than it contained.
- **A line's `principal_settled_minor` never exceeds its `principal_due_minor`.** An overpayment must not hide inside a line that reads correctly.
- **Excess is not allocated.** It is never spread onto unrelated orders or lines; it stays as received money against a settled demand, and the difference becomes a **`FinancialAdjustmentRequired`**.
- **Allocation is server-authoritative.** No screen allocates, re-allocates or un-allocates, and no permission represents the act.
- **Where the receipt equals the demand total, allocation is arithmetic**: each line receives its own `principal_due_minor`. **GH₵55 → GH₵35 and GH₵20, both lines `SETTLED`, one receipt.**
- **Where the cumulative confirmed principal is short of the total, nothing is allocated**. The demand records `PARTIALLY_SETTLED`, each receipt stands at its confirmed amount, **no line is settled**, and handover stays blocked. **`OQ-111` is closed**: the Product Owner ruled **atomic settlement with no partial line allocation**, so no ordering is needed and none is invented.
- **Settlement may draw on several receipts, and provenance survives it**. GH₵50 then GH₵5 against GH₵35 and GH₵20 writes **three** allocations — R1→L1 GH₵35, R1→L2 GH₵15, R2→L2 GH₵5 — both lines settled, no receipt over-drawn, no money invented. Receipts are drawn in `confirmed_at` order and lines in frozen order, so a replay reproduces the records. **A single anonymous GH₵55 allocation would erase the fact that two payments were involved**, which is the fact a refund argument turns on.

#### `PaymentFallbackAuthorization` — Gate C C1.6

`MSC-DEC-360`. **A grant that is consumed exactly once, not a line in an audit log.**

| Field| Type| Null| Notes|
|---|---|---|---|
| `id` · `hub_id`| uuid| no| Scope|
| `payment_demand_id`| uuid| no| **This** obligation|
| `unresolved_payment_attempt_id`| uuid| no| **That** attempt — `CREATED`, `PENDING` or `STATUS_UNKNOWN`|
| `fallback_method`| enum| no| **`MERCHANT_MOMO` · `CASH`.** The fallback taken must be the fallback authorised|
| `authorized_by_staff_id`| uuid| no| **Authorised Ops.** Never a Rider|
| `reason_code` · `note`| text| no/yes| Mandatory reason|
| `duplicate_risk_acknowledged`| bool| no| **Must be true.** The officer states that the customer may already have been debited|
| `created_at`| timestamptz| no| **No `expires_at`.** Validity is event-bound|
| `status`| enum| no| **`ACTIVE` · `CONSUMED` · `SUPERSEDED`**|
| `consumed_at` · `consumed_by_receipt_id`| timestamptz/uuid| yes| **The receipt that spent it**|
| `superseded_at` · `superseded_reason`| timestamptz/enum| yes| `ATTEMPT_RESOLVED_SUCCEEDED` · `ATTEMPT_RESOLVED_SAFE` · `DEMAND_SETTLED` · `DEMAND_VOID`|
| `business_key`| text| no| One active grant per demand, attempt and method|

**Invariants.**

- **Single use.** A consumed grant is refused — `FALLBACK_AUTHORIZATION_ALREADY_CONSUMED`.
- **Method-bound and demand-bound.** A `CASH` grant cannot settle a Merchant MoMo payment, and a grant for one demand cannot settle another — `FALLBACK_AUTHORIZATION_METHOD_MISMATCH`, `FALLBACK_AUTHORIZATION_DEMAND_MISMATCH`.
- **Consumption is a system effect**, recorded when the fallback receipt is written. Nobody marks it consumed by hand.
- **Repetition does not accumulate grants.** A repeat request for the same demand, attempt and method returns the existing active one.
- **A Rider holds no part of it** — they may report the provider problem and request help, and may never authorise, consume out of band, or declare the provider safe to ignore.
- **Valid by event, not by clock**. It is `ACTIVE` until it is consumed or **the condition it was granted for stops existing** — the attempt reaches `SUCCEEDED`, `FAILED`, `EXPIRED` or `CANCELLED`, or the demand becomes `SETTLED` or `VOID`. **There is no TTL**: the previous `EXPIRED` state carried no duration, so nothing could enter or test it, and inventing a window would have been a Product-policy time limit nobody asked for.
- **Validity is evaluated at the moment of use**, never assumed from the stored status. **A grant issued against *we cannot tell* must not still authorise a full payment once the provider has told us.**
- **A provider resolving safely does not promote the grant into ordinary authority.** Once the attempt is definitively `FAILED`, `EXPIRED` or `CANCELLED`, the duplicate risk the officer accepted is gone and **ordinary fallback rules apply** — the grant is `SUPERSEDED`, not reused as a general permission.
- **An audit log is not an authorisation database.** Audit records that a decision was taken; it cannot be asked *is this grant still available*, and a settlement path must never query it for permission.

#### `PaymentAttempt` — the canonical provider collection, Gate C C1.4

`MSC-DEC-354`. **One record for a provider collection, and no second one.** `CollectionHandshake` was inspected and rejected: it is a **signed parcel-identity** machine carrying no money, no amount and no provider, and §36.5 warns these lifecycles must not be collapsed.

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `hub_id`| uuid| no| Scope|
| `payment_demand_id`| uuid| no| **The `OperationalPaymentDemand` this attempt collects**. The attempt requests the demand's **`remaining_due_minor`** at creation, and a success funds the demand — **lines settle atomically only when the cumulative principal reaches the total**.|
| ~~`obligation_ref`~~| embedded| yes| **Deprecated at C1.5.** Retained for single-line compatibility only; **it is not canonical truth for a multi-line demand** and nothing may settle from it alone|
| `order_id` · `delivery_stop_id`| uuid| yes| Where applicable|
| `initiator_principal_type`| enum| no| **`RIDER` · `STAFF`**. **A Rider is not a Staff member** — Gate A keeps the identities apart, and collapsing them to fit one foreign key would place a rider inside the staff authorisation model|
| `initiator_principal_id`| uuid| no| The principal who asked. **Exactly one initiator, immutable after creation**, and **coherent with `initiating_surface`** — a `RIDER` surface may not carry a `STAFF` initiator.|
| `initiating_surface`| enum| no| **`RIDER` · `OPS`** — **one engine, two surfaces**|
| `provider`| enum| no| **`HUBTEL`**|
| `provider_mode`| text| yes| The provider capability used. **Unverified against the live merchant account** — `OQ-109`|
| `payer_msisdn`| text| no| Canonically normalised. **Not necessarily the recipient's contact number**, and using it **never rewrites the recipient record**|
| `principal_amount_minor`| int| no| **The demand's remaining due at the moment this attempt was created** — snapshotted and **immutable thereafter**. Server-derived, never caller-supplied.|
| `currency`| text| no| **`GHS`**|
| `client_reference`| text| no| **Server-generated, unique, immutable.** One logical attempt. Transport retries reuse it|
| `provider_request_id` · `provider_transaction_id`| text| yes| As returned|
| `state`| enum| no| §20.6|
| `created_at` · `provider_initiated_at` · `expires_at`| timestamptz| no/yes/yes||
| `provider_confirmed_at` · `last_provider_status_at`| timestamptz| yes||
| `failure_code` · `failure_detail` · `terminal_reason`| text| yes||
| `reconciliation_status`| enum| no| `NOT_REQUIRED` · `REQUIRED` · `IN_PROGRESS` · `RESOLVED`|
| `confirmed_principal_minor`| int| yes| What the provider confirmed|
| `provider_amount_charged_minor` · `provider_fee_minor` · `net_settlement_minor`| int| yes| **External provider facts** where returned|

**Invariants.**

- **No PIN field exists here or anywhere else**. The payer's PIN belongs to the provider's own prompt and Melarc never requests, receives, transmits, logs or stores it.
- **No provider credential is stored on this record.**
- **`principal_amount_minor` is the demand's `remaining_due_minor` at attempt creation, never supplied**. A caller who could set it could collect GH₵1 against a GH₵55 obligation — and a server that used the **total** would ask for GH₵55 again after GH₵50 had arrived, **taking GH₵105 for a GH₵55 delivery**.
- **The demand's total is preserved separately** and is never overwritten by a remaining figure. One record answers *what was owed*, the other *what this attempt asked for*, and a reader who cannot see both cannot audit a partial payment.
- **The demand is the collision boundary for every payment method**. Provider collection, Merchant MoMo and cash all consult it, so no method can decide independently that the obligation looks unpaid.
- **An unresolved attempt blocks an ordinary fallback** — `CREATED`, `PENDING` or `STATUS_UNKNOWN`. The only way through is the **Ops-authorised duplicate-risk exception**, which records the attempt, a mandatory reason and an explicit risk acknowledgement.
- **At most one unresolved attempt per `OperationalPaymentDemand`**. `STATUS_UNKNOWN` is **not** resolved.
- **A success creates exactly one `PaymentReceipt` and hands it to the atomic settlement engine**: the demand's cumulative principal is recomputed and **every frozen line is allocated in one act only when that total is reached** — a short success allocates nothing. The attempt is the request; the **receipt** is the money.
- **A new attempt is eligible while the demand is `OPEN` or `PARTIALLY_SETTLED` with `remaining_due_minor > 0`** — never once it is `SETTLED` or `VOID`, and never while another attempt is unresolved. A `SUCCEEDED` attempt that left the demand short is resolved provider truth; the remainder is collected by a fresh attempt **for the remaining due**, which is the ordinary next collection and not a retry.
- **The demand's lines are satisfied by `confirmed_principal_minor`**, not by the amount charged and not net of the provider fee. **Processing cost is not deducted from what a customer owes.**
- **A confirmed digital collection never becomes rider cash**: it reaches Melarc's provider account, so it counts as confirmed digital and creates **no** `RiderCashCustody`, no collection-cash pool and no handover cash.


#### `VendorOperationalEligibility` — derived, and deliberately not a table

`MSC-DEC-339`. **A projection, computed on read. It has no row, no primary key and no scope-registry classification, because it is not a source of truth.**

| Exposed| Meaning|
|---|---|
| `may_create_pickup`| Whether a pickup may be booked for this vendor today|
| `may_confirm_vendor_paid_order`| Whether vendor-paid orders may be confirmed|
| `requires_prepayment`| Whether the outbound prepayment gate applies|
| `recipient_paid_orders_allowed`| Whether recipient-paid orders may proceed|
| `restriction_category`| An approved **high-level** category, only where disclosure is allowed|
| `effective_at`| When the projection was computed|

**The four underlying conditions are read separately and never collapsed** (§35.12.8): operational suspension · `OVERDUE` financial status · allowance status · security/risk hold. **What an open security/risk hold does is now defined**: while any `SecurityRiskHold` on the vendor is `OPEN`, `may_create_pickup` and `may_confirm_vendor_paid_order` are **false**, and `restriction_category` stays null for that cause — no approved category may name it. `requires_prepayment` and `recipient_paid_orders_allowed` are not moved by the hold.

**A projection is safe precisely because it is lossy.** It answers *may this vendor book today* without disclosing that a security hold exists, who raised it or why — which is what lets Hub Ops act while Gate B's restriction on `VendorAccountAllowance`, `VendorSuspensionHold` and `SecurityRiskHold` holds (`MSC-DEC-295`, C1 §10). **`OQ-105` was raised for exactly this artifact and closes with it.**

**Persisting it would defeat it.** A stored copy is a second source of truth that can disagree with the four records it summarises, and the disagreement would be invisible.

**`VendorOperationalEligibility` is declared non-persistent at its definition point**, in the machine-readable form `MSC-DEC-294` established for technical tables — a validator's private exclusion list is not an inventory, and contract-consistency validation reads this marker rather than carrying a name of its own:

```
DERIVED-PROJECTION: VendorOperationalEligibility
```

### 6.13 Reporting — the domain's first named entity

Governed by §32. Added 16 September 2026, Accounting, Finance & Reporting Pass 1. **§1 has
deferred field detail for this domain since the document was written; nothing in §6 had ever
named an entity to defer it for.** This is that entity.

#### `DailyOperationsCashReport` — derived, and deliberately not a table

A projection, computed on read, over one hub's operating day. **It has no row, no primary
key and no data-scope classification**, for the same reason `VendorOperationalEligibility`
does not: a stored copy is a second source of truth that can disagree with
the records it summarises, and the disagreement would be invisible. **It creates no
accounting entry** — Gate C's cash events are the source events the Accounting, Finance &
Reporting domain consumes (§6.15, and `AccountingExport` in §6.12), and this projection reads
the same events without pre-empting that domain.

| Exposed| Derived from|
|---|---|
| `hub_id`, `business_date`| The two keys every figure below is filtered by|
| `packages_received_count`| `PickupIntake` (§6.6) reaching `COUNTED` or later for this hub-day|
| `delivery_attempts_count`, `successful_deliveries_count`| `DeliveryStop.state` (§6.10) for stops on this hub-day's runs — attempted is any terminal outcome, successful is `DELIVERED`|
| `station_drops_count`, `third_party_dispatches_count`| `Order.commercial_mode` (§6.7) `STATION_DROP` and `MELARC_COVERED_THIRD_PARTY_DELIVERY` respectively, reaching their mode-specific terminal outcome (§16.1) today|
| `failed_deliveries_awaiting_review_count`| `Order.fulfilment_state = AT_HUB_AFTER_FAILURE` (state-machines.md §9)|
| `returns_awaiting_review_count`| Orders in `AT_HUB_AFTER_FAILURE` with no `ReturnRecord` (§6.14) yet committed — eligible for Return but not yet formally initiated|
| `held_at_hub_count`| Custody with no scheduled onward movement — the same population `hub-daily-operating-cycle.md` §5.1 reviews as "parcels held at the hub"|
| `missed_commitments_count`| `delivery.commitment.breached` events (`audit.md` §5.3) emitted by `sweep_missed_commitments` for this hub-day|
| `rider_cash_positions[]`| One row per `CashHandover` (§6.11) opened against this hub-day: `rider_id`, `system_expected_minor`, `declared_total_minor`, `confirmed_total_minor`, `state` — the same three-figure comparison §6.11 defines, never recomputed here|
| `road_expenses_applied_minor`| Sum of `RoadExpense.amount_minor` (§6.12) where `applied_to_cash_handover_id` names a handover opened on this hub-day|
| `hub_cash_reconciliation`| The `HubCashReconciliation` (§6.12) row for this `(hub_id, business_date)`, where one has been opened|
| `cash_dispositions[]`| `CashDisposition` (§6.12) rows against this hub-day's reconciliation|
| `revenue_by_type[]`| Confirmed principal (`PaymentAllocation.amount_minor`, §6.12) grouped by `PaymentDemandLine.obligation_type`, for demands scoped to this hub and settled or partially settled on this business day. **`DELIVERY_FEE` entries additionally carry the order's `commercial_mode`** (`Order`, §6.7, joined via `OperationalPaymentDemand.order_id`), so Station Drop revenue is visible as its own breakout rather than merged into ordinary doorstep revenue (Pass 2, `OQ-123`)|
| `unreconciled_exceptions_open`| `true` where any `RiderCashCustody.state = EXCEPTION_OPEN` or the day's `HubCashReconciliation.state = VARIANCE_OPEN` (§16.3)|
| `generated_at`| When this projection was computed — never a stored fact|

**Invariants.**

- **Never a gate, never a write path.** Every figure above is read from an entity §6.11 or
  §6.12 already defines; this projection adds no state, no transition and no permission to
  write any of them. A report that could also correct a total would collapse the operational
  and financial closure §16.3 requires to stay separately visible.
- **`revenue_by_type` is bounded by `PaymentDemandLine.obligation_type` as it exists today —
  five values now, and `OQ-123` closes here.** **Station Drop revenue is `DELIVERY_FEE`**
  (§24.7.1, `Order.price_components_snapshot`, §6.7), exposed as a `commercial_mode`-tagged
  breakout of it, not a fifth category — see the "Where a demand comes from" table above.
  **The flat return fee is now `RETURN_FEE`** (§6.14, `SLICE-006` Pass 1) — but **only for the
  ad-hoc-sender, immediate-demand settlement path** (§5.2.4, §28.4). A registered vendor's
  return fee is earned on the identical `ReturnRecord` and settled through the future
  `VendorStatement` mechanism instead (`OQ-005`, Phase 4), so it creates no demand line and does
  not appear in this array — the same shape `single_package_pickup_fee`'s own statement-posted
  case already has. **Partial waiver is modelled** (`waiver_amount_minor`,
  `MSC-DEC-394`), and it reaches this array only through the demand: the `RETURN_FEE`
  `PaymentDemandLine` is materialised at `effective_return_fee_minor`, so the pre-waiver
  `return_fee_minor` never reaches the report. **Revenue stays what was confirmed against that
  line**, never the line's own face value — this array reads receipts, not `ReturnRecord` fields,
  and a partially settled demand reports less than either figure.
  `MELARC_COVERED_THIRD_PARTY_DELIVERY`'s combined waybill-plus-Melarc charge is a distinct
  question Pass 2 did not open and remains absent from this array for that reason, not for
  `OQ-123`'s.
- **A hub-day with an open exception is never presented as clean.** `unreconciled_exceptions_open`
  exists because §16.3 forbids unresolved money becoming invisible — a day is not read as
  closed merely because every route finished (`MSC-DEC-325`, domain-model.md §6.12).
- **Scope is on the grant, not on a field this projection carries.** Who may request which
  `hub_id` is `report.read`'s existing scope axis (`permissions.md` §7) — this entity exposes
  no company-wide rollup of its own; a caller with all-hub scope requests one hub at a time.

```
DERIVED-PROJECTION: DailyOperationsCashReport
```

### 6.14 Returns — the return-to-vendor workflow

Governed by §28.1–§28.4. Added 17 September 2026, `SLICE-006` Pass 1. **`ReturnRecord` was named
at §6.9 with field detail deferred; this is that detail**, for the part of §28 that traces to
`APPROVED` authority. §28.5's remaining exceptions (invalid phone, exceptional OTP recovery,
damage/loss in custody) and §28.6 (damage, loss and claims — liability limits, claim process,
compensation approval, financial ledger effects) are **not** modelled here; the Master
Specification's own words place them with *"a future decision sprint or downstream
security/operations design"* (`OQ-004`, `OQ-042`, `OQ-084`, all narrowed rather than closed by
this section).

**`MSC-DEC-394`, 17 September 2026, decided three §28.5 items this section now reflects**:
cancellation after return starts — **there is none, once committed** (`status` below); the
partial waiver §5.2.4 already permitted — **Senior Ops discretion, no formula**
(`waiver_amount_minor` below); and a vendor refusing the returned parcel — **escalates to Senior
Ops as a disputed case under §28.7**, with no schema representation yet, deliberately, pending its
two undecided siblings above. CRIT-07's partial-cash-payment question is also decided (refund) and
built into `initiateReturn`, not into this record — see `FinancialAdjustmentRequired` below.

#### `ReturnRecord`

`MSC-DEC-332`. **Return-to-vendor is a separate Ops decision with its own fee — the sibling
record to `RedeliveryRecord` (§6.12) at the identical decision point**, `AT_HUB_AFTER_FAILURE`.

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `order_id`| uuid| no||
| `originating_delivery_stop_id`| uuid| yes| The most recent failed physical `DeliveryStop`, where one exists. **Null when the order reached `AT_HUB_AFTER_FAILURE` via a cancelled `Redelivery`** rather than a fresh failed attempt — the failed stop of record is already linked from that `RedeliveryRecord`|
| `committed_by_staff_id`| uuid| no| **Authorised Ops. The act that creates the obligation** — never a rider, never a counter reaching three|
| `committed_at`| timestamptz| no| **The snapshot moment**|
| `settlement_path`| enum| no| **`STATEMENT` · `IMMEDIATE_DEMAND`** — derived from which of `Order.vendor_organization_id` / `ad_hoc_sender_id` is set (§5.2.4, §28.4). **Never chosen by Ops**|
| `return_fee_minor`| int| no| **Snapshotted from `flat_return_fee_amount`** (`settings.md` §7.2) at commit. Always populated — the fee is **charged by default**, never conditionally zeroed the way `RedeliveryRecord.chargeable` is|
| `waiver_status`| enum| no| `NOT_REQUESTED` · `REQUESTED` · `APPROVED` · `REJECTED`|
| `waiver_reason_code`| text| yes| A `ReturnFeeWaiverReason` value (`errors-and-enums.md`). **Mandatory from `REQUESTED` onward**|
| `waiver_amount_minor`| int| yes| **Proposed by Ops at `REQUESTED`.** Senior Ops approves or rejects it as a whole at `APPROVED`/`REJECTED` — never edits it; a different figure is a new request, not a correction to this one. `0 < waiver_amount_minor <= return_fee_minor`. **Mandatory from `REQUESTED` onward**|
| `waiver_requested_by_staff_id`| uuid| yes| Holder of `returns.waiver.request`|
| `waiver_approved_by_staff_id`| uuid| yes| Holder of `returns.waiver.approve`. **Never equal to the requester** (§28.4, `MSC-DEC-163`)|
| `waiver_decided_at`| timestamptz| yes||
| `effective_return_fee_minor`| int| no| **Derived**: `return_fee_minor − waiver_amount_minor` where `waiver_status = APPROVED` — a full waiver is simply `waiver_amount_minor = return_fee_minor`, giving zero — else `return_fee_minor`. Never independently set|
| `delivery_run_id` · `delivery_stop_id`| uuid| yes| **Set when the return trip is built** — the existing transport machinery, not a new one (§28.4's "assigned return movement")|
| `otp_validated_at`| timestamptz| yes| When the closing OTP succeeded|
| `status`| enum| no| `COMMITTED` · `IN_TRANSIT` · `COMPLETED`. **No `CANCELLED` value, by decision**: a committed `ReturnRecord` always runs to completion. A mistaken commit is corrected by completing it and reconciling afterward, not by unwinding it|

**Invariants.**

- **The obligation is created by commitment and by nothing earlier**. A third
  failed attempt is a rider's report, never an adjudication — the parcel returns to the hub
  eligible for either a further `Redelivery` or a `ReturnRecord`, owing nothing until Ops decides.
- **`settlement_path` is read from the order, never chosen.** A registered vendor's return fee is
  earned here and settled through the future `VendorStatement` mechanism (`OQ-005`, Phase 4) —
  this record produces no `PaymentDemandLine` for that path, exactly as `single_package_pickup_fee`'s
  own "posted to statement" case produces none (`MSC-DEC-340`, §6.12). An ad-hoc sender's return
  fee settles immediately, through `OperationalPaymentDemand`, before physical handover (§28.4).
- **Waiver may be full or partial, and the amount is Senior Ops discretion — never a formula.**
  §5.2.4 permits "Ops may request a full or partial waiver under an approved reason; Senior Ops
  independently approves or rejects it" — `MSC-DEC-394` settled that the amount is whatever Ops
  proposes, approved or rejected as a whole, the same shape the discretionary cancellation charge
  and late-claim acceptance already use. No fraction, percentage
  or bound is computed anywhere in this contract.
- **The approver is never the requester** — the same maker-checker discipline this codebase
  already enforces elsewhere (`payment.road_expense.approve`'s `SELF_APPROVAL_FORBIDDEN`),
  here on the existing `returns.waiver.approve` key.
- **Physical custody closes only on a valid return OTP** to the recorded vendor/sender contact
  (§28.4) — never on payment alone and never on Ops discretion; the mechanism is the doorstep OTP
  requirement, redirected to a different contact.
- **The original delivery fee's reversal is the commercial state machine's own effect**
  (`state-machines.md` §8, `CREDIT_RESERVED/PREPAID/NO_VENDOR_CHARGE → REVERSED`), not a field
  here — this record does not duplicate it.
- **A committed `ReturnRecord` cannot be cancelled, by decision, not omission**.
  Unlike `RedeliveryRecord` (cancellable before a trip departs, §20.5), a return commit has already
  reversed the original delivery fee and snapshotted a new one — unwinding that is not built, and
  the Product Owner ruled it should not be: the record always runs to `COMPLETED`.
- **Confirmed `PaymentReceipt`s already held against the reversed delivery-fee demand raise a
  `FinancialAdjustmentRequired`, not a field on this record.** `initiateReturn` reuses the existing
  `PAID_OBLIGATION_VOIDED` reason when a split-payment recipient portion was
  collected before the final failed attempt — the refund itself stays `OQ-005`'s to execute
  (`MSC-DEC-394`, closing CRIT-07's audit widening). **One record, for the sum of the `CONFIRMED`
  receipts against that demand**: a demand may carry several, a
  `REVERSED_BY_PROVIDER` receipt is not money Melarc holds, and the adjustment's `source_key` is
  the commitment itself, so the retry this record's own idempotency permits raises no second one.

### 6.15 Accounting — resolving an adjustment

Governed by §26.5, §26.6, §16.3. Added 20 September 2026, `MSC-DEC-395` — **the Accounting,
Finance & Reporting domain's first entity.** §26.5 requires Version 1 to distinguish an
**adjustment** digitally; §26.6 assigns *refunds/reversals* to finance/domain design; §16.3
requires the system to *"prevent unresolved money from becoming invisible."* `MSC-DEC-357` built
the fact and stopped; this is the remedy.

**Scope, stated because the question that owns it was wider than the baseline until this week.**
`OQ-005` covers §50.2's seven payment-design items. **No general ledger, chart of accounts,
journal or financial period is modelled here** — §14.1 places general accounting outside Version 1
— and this entity creates no accounting entry, exactly as `CashDisposition` does not.

#### `FinancialAdjustmentResolution`

`MSC-DEC-395`. **What was done about money owed back. One per adjustment, resolved whole.**

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `financial_adjustment_required_id`| uuid| no| **Unique** — one adjustment carries at most one resolution|
| `hub_id`| uuid| no| Derived from the adjustment, immutable|
| `resolution_class`| enum| no| **`REFUND` · `CREDIT` · `ALLOCATION` · `UNCLAIMED_DISPOSITION`**|
| `amount_minor` · `currency`| int/text| no| **Equals the adjustment's own amount.** Partial resolution is not permitted|
| `method`| enum| yes| **`MERCHANT_MOMO_TRANSFER` · `BANK_TRANSFER` · `CASH_AT_HUB` · `VENDOR_BALANCE_CREDIT` · `NONE`.** Mandatory for `REFUND` and `CREDIT`; `NONE` where nothing moves|
| `destination`| text| yes| Account, wallet or party as the method requires. **Mandatory for `REFUND`**|
| `reference`| text| yes| Transfer or deposit reference. **Mandatory for `MERCHANT_MOMO_TRANSFER` and `BANK_TRANSFER`**|
| `evidence_id`| uuid| yes| Where the method requires proof|
| `reason_code`| text| yes| **Mandatory for `UNCLAIMED_DISPOSITION`**, and for `REFUND` where the payer is a registered vendor — the vendor's request is what displaces the `CREDIT` default|
| `status`| enum| no| **`PROPOSED` · `APPROVED` · `REJECTED`**|
| `proposed_by_staff_id`| uuid| no| Holder of `payment.adjustment.resolve`|
| `proposed_at`| timestamptz| no||
| `decided_by_staff_id`| uuid| yes| Holder of `payment.adjustment.approve`. **Never equal to the proposer**|
| `decided_at`| timestamptz| yes||

**Invariants.**

- **This creates no accounting entry**, the same boundary `CashDisposition`
  already holds. It records an operational act; the accounting treatment of that act is not
  Version 1's, because §14.1 places general accounting outside it.
- **Melarc records this money; it does not move it.** §39.8's provider boundary is **inbound
  only** — recipient payments and vendor statement payments — and names *reversals/refunds* among
  what the integration contract must still define, behind `OQ-109`. So a `REFUND` is executed out
  of band and evidenced here, exactly as a `BANK_DEPOSIT` is under `CashDisposition`.
- **`CREDIT` requires a `VendorBalance`, so only a registered vendor may take it.** §49 places
  **individual/ad-hoc credit** outside Version 1 and no recipient or `AdHocSender` holds a
  balance — for those payers the class is `REFUND` or `ALLOCATION`.
- **`CREDIT` is the default where the payer is a registered vendor**, and `REFUND` displaces it
  only on the vendor's request, recorded in `reason_code`. The weekly statement (§27.1) already
  nets the balance a credit lands on, so the ordinary case moves no money.
- **A `CREDIT` is evidenced here and posted elsewhere, because `VendorBalance` has no structure
  yet.** §5.5 bounds it to a named entity with no field table, and nothing in this contract
  increments it — so `VENDOR_BALANCE_CREDIT` records **that** the money became a vendor credit and
  who approved it, not the posting itself. **This is the same out-of-band shape `REFUND` has**, for
  a different reason: a refund waits on a provider rail, a credit waits on the
  vendor-balance ledger that stays with `SLICE-007` and the rest of `OQ-005`. When `VendorBalance`
  gains structure the posting becomes systematic and this record becomes its source.
- **The decider is never the proposer**, refused with `SELF_APPROVAL_FORBIDDEN` — the maker-checker
  discipline `payment.road_expense.approve` already carries, for the reason `audit.md` gives it:
  *approval moves money out*.
- **The adjustment reaches `RESOLVED` only on an `APPROVED` resolution** (§6.12's
  `FinancialAdjustmentRequired`). A `REJECTED` one leaves it `OPEN` and a fresh proposal may follow;
  the rejected record is kept, because how often a proposed resolution is refused is the control.
- **`UNCLAIMED_DISPOSITION` is available only after `unclaimed_adjustment_grace_days`** has
  elapsed since `raised_at` — **90 days** (`settings.md` §7.1, `MSC-DEC-396`). Writing money off is
  still money moving, so it is approved like any other class.
- **One adjustment, one resolution, resolved whole.** A genuinely split case is **two
  adjustments** — an adjustment is a fact about one source condition (`MSC-DEC-357`'s `source_key`),
  not a balance to draw down, which is why `PaymentAllocation`'s many-to-one shape is not copied
  here.

### 6.16 Vendor — the record and its two standings

Governed by §18.2, §29.1–§29.2, §29.5, §35.12.1–§35.12.4, §36.12. Both entities were named at
§6.9 and carried no field detail; `SLICE-008` Pass 1 is the phase that needed them.

**The two are separate entities because they are separate decisions.** §35.12.3 and §36.12
both state that operational activation and financial allowance are decided by different
authorities, and §36.12's first invariant is that operational `ACTIVE` does **not** imply
allowance `ENABLED`. Modelling the allowance as a column on the organisation would make the
invariant a convention rather than a structure, and the two records carry different
`created_by` authorities and different audit obligations.

#### `VendorOrganization`

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `responsible_hub_id`| uuid| no| The hub whose Senior Ops decides activation. **Fixes the own-hub scope** both `vendor.organization.create` and `.approve` resolve against|
| `legal_name` / `trading_name`| text| no / yes||
| `contact_phone` / `contact_email`| text| yes| **At least one required.** Distinct from `VendorCredential`'s recovery channel — a business contact is not an authentication channel|
| `operational_status`| enum| no| `CREATED_BY_OPS` · `PENDING_SENIOR_OPS_REVIEW` · `ACTIVE` · `REJECTED` · `SUSPENDED` · `TERMINATED` (§36.12). **Exits from `SUSPENDED` and entries to `TERMINATED` were decided at `MSC-DEC-397`** (`OQ-033` closed 21 September 2026) and are reached by `suspendVendor`, `reactivateVendor` and `terminateVendor`; **the machine is still untabled** at [state-machines.md](state-machines.md) §14 — `OQ-132`.|
| `created_by`| uuid| no| The authorised Ops actor. **Load-bearing, not provenance**: §35.12.2's exclusion is enforced against it and is auditable afterwards from the two actor fields together|
| `created_at`| timestamptz| no||
| `decided_by`| uuid| yes| The hub Senior Ops actor who approved or rejected. **Must differ from `created_by`**|
| `decided_at`| timestamptz| yes||
| `decision_reason`| text| yes| **Required on rejection** (§29.2.5's reason rule, §36.12's *"every transition records actor, reason, timestamp"*). Optional on approval|

**Invariants.**

- **`created_by ≠ decided_by`, always** (§29.2.3, §35.12.2). Enforced at
  `decideVendorOrganization`, returning `SELF_APPROVAL_FORBIDDEN` — **the same code**
  `approveStaffIdentity` and `approveOnePackageException` return, because it is one uniform
  rule (§37.4, `MSC-DEC-135`).
- **No public self-registration path exists** (§18.2, §35.12.1). Every record has a
  `created_by` that is a staff principal; there is no anonymous creation operation.
- **`PENDING_SENIOR_OPS_REVIEW` grants nothing.** The enum holds a created-but-unapproved
  record deliberately — this is the state `StaffIdentity` was missing at `CONFLICT-036`, and
  the reason §35.12.2's maker-checker is expressible here.
- **A `VendorAccount` may be `ACTIVE` while its organisation is `PENDING_SENIOR_OPS_REVIEW`,
  and that is correct.** §6.8's `VendorAccount.status` describes **credential and session
  standing**; this field describes **operational approval**. §36.12 states the separation
  itself — *"shared credential/session state is separate from organization operational
  status."* The account grants nothing regardless, because `VendorCredential.secret` is null
  until approval issues the one `VENDOR_CREDENTIAL_SETUP` grant.
- **`REJECTED` is terminal and the record stays queryable** (§36.1). Reapplication is **a new
  record** (`MSC-DEC-397`, `OQ-033` closed 21 September 2026): the rejection history stays on
  the rejected record, and linking a fresh application to it is duplicate detection's job.

  `OQ-033`'s to decide.
- **The scope class is `PLATFORM`, `global (master)`**, per
  [data-scope-registry.md](data-scope-registry.md) §4.2 and `MSC-DEC-295` — globally
  identifiable so an authorised Ops user can look a vendor up, which **is not** a grant to the
  three control records below it.

#### `VendorAccountAllowance`

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `vendor_organization_id`| uuid| no| **Exactly one per organisation.** Created with the organisation, never absent|
| `state`| enum| no| `DISABLED_PREPAYMENT_ONLY` · `ENABLED` (§36.12). **Both directions are Platform Admin** and both require a reason|
| `decided_by`| uuid| yes| Platform Admin. Null only before the first decision|
| `decided_at`| timestamptz| yes||
| `reason`| text| yes| **Mandatory on every transition in both directions** (§29.2.4–5). Null only before the first decision|

**Invariants.**

- **There is no amount field, and its absence is the rule.** The limit is **one
  platform-wide figure** — `global_vendor_account_limit_amount`, **GH₵200** — *"one figure for
  every vendor, largest and smallest, with no Version 1 override"* (`MSC-DEC-238`,
  §34.6, `MSC-DEC-045`). A per-vendor column would make an override representable, and the first
  defect that wrote to it would create a credit line nobody approved.
- **A new organisation's allowance is `DISABLED_PREPAYMENT_ONLY`**, and approval does not
  change it (§35.12.3, §36.12). The record exists from creation so that "no decision yet" and
  "deliberately disabled" are the same safe state rather than a null nobody interprets.
- **This entity records the decision; it does not enforce the consequence.** The signed
  commercial machine at [state-machines.md](state-machines.md) §8 branches
  `PRICED → CREDIT_RESERVED` on *allowance enabled, not `OVERDUE`, sufficient global exposure*
  and `PRICED → PAYMENT_REQUIRED` otherwise. Restating the consequence here would create a
  second place for it to be wrong.
- **Disablement is not retroactive** (§29.2.5). Existing confirmed itemized orders keep their
  `commercial_state` and outstanding obligations stay valid and payable; only orders priced
  after the transition meet the prepayment gate.
- **It is one of §35.12.8's four conditions and never merges with the others.** Operational
  suspension (`VendorSuspensionHold`), `OVERDUE` financial status, this record, and
  `SecurityRiskHold` are four distinct facts. `VendorOperationalEligibility`
  is the derived, deliberately lossy projection that answers the operational question without
  disclosing which of them applies.
- **Restricted to all-Hub `vendor.read`, not ordinary hub staff** (C1, `MSC-DEC-295`,
  `MSC-DEC-299`) — a global commercial control, per `data-scope-registry.md` §4.3.

#### `SecurityRiskHold`

`MSC-DEC-414`, closing `OQ-128`. **§35.12.8's fourth vendor condition**, beside suspension, `OVERDUE` status and allowance disablement — the four that *"must not be collapsed into one flag"*. Machine at [state-machines.md](state-machines.md) §21 — **SIGNED**. Scope class at [data-scope-registry.md](data-scope-registry.md) §4.3: all-Hub `vendor.read`, and **denied to the vendor itself**.

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `vendor_organization_id`| uuid| no| The vendor under review. **More than one hold may exist** — see the invariants|
| `state`| enum| no| `OPEN` · `CLEARED` — [state-machines.md](state-machines.md) §21|
| `opened_by`| uuid| no| **Platform Admin** (`vendor.security_hold.manage`)|
| `opened_at`| timestamptz| no||
| `open_reason`| text| no| **Mandatory**|
| `cleared_by`| uuid| yes| Platform Admin. Non-null from `CLEARED`|
| `cleared_at`| timestamptz| yes| Non-null from `CLEARED`|
| `clear_reason`| text| yes| **Mandatory on clearing**|

**Invariants.**

- **An open hold stops new business and keeps work in flight**. While any hold on the vendor is `OPEN`, `VendorOperationalEligibility.may_create_pickup` and `may_confirm_vendor_paid_order` read **false**. Parcels already moving continue to delivery and **the vendor login is not blocked**.
- **Distinct from suspension in effect, not only in record.** Suspension blocks the login and holds every non-terminal work item (§35.12.7); this does neither. A hold that behaved like a suspension would satisfy §35.12.8 on paper and defeat it in practice.
- **Holds may coexist, and the effect applies while any is `OPEN`.** Two separate concerns are two records with two reasons; clearing one does not lift a restriction another still justifies.
- **The vendor never sees it, and the projection never names it.** `restriction_category` may not disclose that a hold exists, who opened it or why — which is what lets Hub Ops act on the outcome.
- **Clearing records; it never deletes.** A cleared hold stays, with who cleared it and why.

### 6.17 Vendor — the suspension hold

Governed by §29.6, §35.12.7–§35.12.9, §36.12. Named at §6.9 and carried no field detail;
`SLICE-008` Pass 2 is the phase that needed it.

**A suspension hold has one row per held work item.** The responsible hub and custody location describe that item; the scope registry governs who may read or disposition it.

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `vendor_organization_id`| uuid| no||
| `order_id`| uuid| no| **The held non-terminal work item.** One row per item|
| `responsible_hub_id`| uuid| no| **The hub accountable for this item**, derived from the order and immutable — the same meaning the term already carries on `Evidence`, `DeliveryCommitment` and `RoadExpense`. **This fixes the scope of the disposition** and is why it is non-null. **It does not say where the parcel is.**|
| `custody_location`| text| yes| **Where the item actually is, and the only field that says so** — shelf, bay, or *“with rider on run R”*. Null means the responsible hub holds it with no finer location recorded|
| `state`| enum| no| `HELD` · `RESUMED` · `AUTHORIZED_EXCEPTION_DISPOSITION` (§36.12)|
| `grounds`| enum| no| §29.6's four categories, snapshotted from the suspension. **Denormalised deliberately** — the row must answer *why is this parcel held* without a join to a record the reader may not be able to see|
| `reason`| text| no| The suspension's mandatory reason, snapshotted|
| `created_by` / `created_at`| uuid / timestamptz| no| The suspending actor|
| `decided_by` / `decided_at`| uuid / timestamptz| yes| The disposition or escalation actor. **Never required to differ from `created_by`** — §29.6 names the suspending Senior Ops as *“the same actor who decides that vendor's held-parcel disposition”*|
| `decision_reason`| text| yes| Mandatory from the first disposition (§35.12.9)|

**Invariants.**

- **One row per non-terminal work item at the moment of suspension, and none for a terminal
  order.** A delivered parcel is history; §29.6 preserves history rather than holding it.
- **`HELD` has no expiry.** §29.6: *“no fixed maximum hold duration applies; hold persists until
  reactivation or a disposition decision.”* An indefinite hold is a legitimate steady state, and
  there is no setting to add.
- **`RESUMED` is reached only by reactivation, and by all rows at once**.
  `reactivateVendor` moves every remaining `HELD` row in one act, because §29.6 already makes
  reactivation the resolution of a hold — a per-item resume decision would contradict it.
- **`AUTHORIZED_EXCEPTION_DISPOSITION` is reached only by Platform Admin escalation**
  (§29.6, `MSC-DEC-142`), for cases neither hold nor return resolves.
- **`RETURN_TO_VENDOR` reaches no state here, and the absence is structural.** It is confirmed
  policy with its fee fixed (§29.6, `MSC-DEC-142`, §29.6, `MSC-DEC-171`), and `RETURNED_TO_VENDOR` is a
  terminal fulfilment outcome (§16.1) whose **signed** machine ([state-machines.md](state-machines.md)
  §9) has one entry into `RETURN_TO_VENDOR_IN_PROGRESS`, from `AT_HUB_AFTER_FAILURE`. Most held
  parcels are elsewhere. Amending §9 is a Product Owner act.
- **Accountability and custody are two fields because they are two facts, and conflating them was a real defect here.** This table previously called `hub_id` *"where the item physically is"* while the row beneath it permitted `custody_location = "with rider on run R"` — **both cannot be true**. `responsible_hub_id` says **who answers for the item**; `custody_location` says **where it is**. §29.6's *"the system must identify where each held item physically is"* is satisfied by the **pair**, and by `custody_location` in particular.
- **The disposition is scoped to `responsible_hub_id`** (§29.6, `MSC-DEC-142`).
  The actor who can see and move the parcel is the one who decides it.
- **Restricted to all-Hub `vendor.read`, not ordinary hub staff** (C1, `MSC-DEC-295`,
  `MSC-DEC-299`), per `data-scope-registry.md` §4.3.

### 6.18 Vendor — saved pickup locations

Governed by §29.4, §29.1, §35.12.6, §11.3. Named at §6.9 and carried no field detail.

**The consumption side was built at Gate C R1.2 and the management side was not.** §6.2's
`PickupRequest` already carries `vendor_pickup_location_id`, `use_vendor_default_destination`
and a derived `resolved_pickup_location`. Meanwhile **`is_default` existed in no contract**,
though §29.4, §35.12.6, §11.3 and §18.1 all state *"multiple saved pickup locations and one
default"*. A rule stated four times and modelled nowhere is not a rule a build can honour.

| Field| Type| Null| Notes|
|---|---|---|---|
| `id`| uuid| no||
| `vendor_organization_id`| uuid| no| **Locations belong to that vendor record** (§29.4). The scope predicate, not a convenience|
| `label`| text| no| What the vendor calls it — *"Shop"*, *"Warehouse"*. Chosen by the vendor and never matched on|
| `location`| embedded| no| §3.5's shape. **No second address format is introduced**|
| `is_default`| bool| no| **Exactly one `true` per vendor with at least one active location.** Never null — a tri-state would make *"no default"* and *"not the default"* the same value|
| `active`| bool| no| **Deactivation, not deletion** (§8). A retired location is retained so a past request's origin stays interpretable (§34.7)|
| `created_by` / `created_at`| uuid / timestamptz| no| The vendor account **or** the Ops actor — §29.1 makes this an Ops capability too|
| `updated_by` / `updated_at`| uuid / timestamptz| yes||

**Invariants.**

- **Exactly one default among a vendor's active locations, or none when it has none.** The
  first location a vendor saves becomes the default, because a list whose default is
  unreachable by any available act is a state nobody can leave.
- **The default moves in one act.** `setDefaultVendorPickupLocation` clears the previous
  default and sets the new one together; two writes would leave a window with none or two.
- **Deactivating the default is refused while another active location exists**, and permitted
  when it is the last one — a vendor may legitimately save none.
- **This record is an input at booking and never the authoritative origin.** That is
  `PickupRequest.resolved_pickup_location`, snapshotted at booking (§3.7). Editing or
  retiring a location changes nothing already booked, which is §11.3's *"per-request
  contact/location edits do not rewrite… saved vendor locations"* seen from the other side.
- **Serviceability is not evaluated here.** §29.4 and §11.3 both place it **at booking**, and
  §11.3 says *"revalidated per request"* — a check at save would let a location stored while
  a zone was served look permanently valid.
- **No state machine, deliberately.** `active` is a reversible boolean condition, not a
  lifecycle; §36 gives this entity none, and inventing one would create a signature
  obligation for a flag.
- **Scope class `VENDOR`, `global (master)`** — [data-scope-registry.md](data-scope-registry.md)
  §4.3: a pickup address is what an Ops user needs to associate a booking.

---

## 7. Idempotency and concurrency

§36.1 requires that "concurrent transition attempts require deterministic rejection or idempotent replay," and §34.7 asks this document to name the boundaries.

**Idempotent commands** — **every rider command**, whether or not it can be composed offline. A command issued over a flaky mobile connection needs replay safety regardless. Each carries a client-generated idempotency key; a replay returns the original result rather than creating a second record.

**Offline capability is narrower than idempotency, and asserting otherwise was `CONFLICT-027`.** §19.8 approves offline behaviour for **hub-handover queuing only**:

| Command| Offline-capable?|
|---|---|
| Hub handover submission| **Approved** (§19.5, §22.2) — **the one offline command in Version 1**. Its queue's design is `OQ-027`'s|
| Delivery failure, payment recording, OTP verification, hub return, return handover| **Online-only in Version 1**; the wider offline design is formally deferred under §50.4.|
| Collection submission| **Online-only in Version 1** (`MSC-DEC-415` — the ruling is *hub handover only*).|
| Every other rider command — pickup arrival and pickup failure included| **Online-only in Version 1**, and idempotent all the same, as every rider command is|

Specification §7.8 requires **selected** rider actions to tolerate unreliable connectivity. Reading that as "everything works offline" is the error this table exists to prevent. OTP verification is the sharpest case: it is the single mandated proof of delivery, and making it offline-capable without a decision would weaken server authority over it.

**Offline sync preserves four things, not one.** §35.3.9 requires synchronized rider actions to preserve "original capture time, **order**, idempotency, and **conflict status**." Idempotency alone is insufficient:

- *Capture time* — the field time, distinct from the upload time (§3.6).
- *Order* — actions replay in the sequence the rider performed them. A delivery outcome that syncs before its payment capture would evaluate the gate against the wrong state.
- *Conflict status* — a rejected or superseded action is surfaced to the rider as an actionable state, never silently dropped. §7.8 requires the app to "surface actionable synchronization errors rather than silently losing work."

**Optimistic concurrency** — every mutation, not only every state transition. A client submits the **record version** it believes current, and a mismatch is rejected deterministically rather than resolved last-write-wins. §35.5.6 requires this specifically for intake: two users must not "independently close or mutate the same intake inconsistently."

Version-based rather than state-based, refined while writing [openapi.yaml](openapi.yaml) v0.1. §36.1 frames the check as submitting "the state it believes the record to be in," which is the weaker form: it catches a concurrent *transition* but not a concurrent field edit that leaves the state unchanged — a price correction landing between another user's read and write, for instance. A version check subsumes the state check, so this satisfies §36.1 rather than departing from it. The contract carries it as an `ETag` and `If-Match` pair, and state preconditions are enforced server-side in addition.

**Atomic dispatch** — §35.7.5: "the same order cannot be dispatched to two destinations or mechanisms through concurrent actions." Assignment to a run and to a handoff mechanism is one atomic commitment, not two writes.

**Exactly-once by construction** — credit reservation. §5.2.3 requires that exposure reserve "exactly once at that milestone" and that earned unpaid charges "continue to consume the same exposure without double-counting." This cannot be enforced by retry semantics alone and needs a uniqueness constraint on the reservation, keyed by order.

---

## 8. Deletion, archival, retention

Nothing in the operational domain is hard-deleted. §36.1 requires failed, cancelled and superseded records to remain queryable for audit and attempt-chain history, and §7.7 forbids silent recalculation.

- **Correction is forward-only.** An adjustment links to the original; issued history is never rewritten (§5.2.5).
- **Deactivation, not deletion,** for users, settings, reasons and providers — §34.7 requires historical records to stay interpretable afterwards, which §3.7's snapshot rule delivers.
- **The database refuses an implicit delete.** The migration lint refuses `ON DELETE CASCADE`, `TRUNCATE` and a `DELETE` grant unless a comment on that statement records the reason (`-- allow-delete: <reason>`) — [MIGRATION_AND_SEEDING.md](../architecture/MIGRATION_AND_SEEDING.md) §5.1.
- **Retention is per category**, configurable, with legal-hold exemption from automatic deletion (§38.7, `MSC-DEC-150–153`). Periods are `OQ-028` and this document does not supply them.

---

## 9. Questions this document raised

| ID| Question| Type|
|---|---|---|
| `OQ-052`| Operational code formats for pickup requests, orders, manifests and runs — length, alphabet, hub prefixing, and whether they must be readable over a phone call. §34.7 permits the codes but specifies no format.| `DECISION_NEEDED`|
| `OQ-053`| Timestamp display convention across surfaces. §34.7 states that "storage/display conventions require approval"; storage is settled at §3.3, display is not.| `DECISION_NEEDED`|

Neither blocks this document. Both block the surfaces that render the values.
