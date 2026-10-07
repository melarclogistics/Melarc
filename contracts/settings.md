# Settings

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 1.43 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** the settings governance model, scope classes, required metadata, and the canonical key inventory
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../PROJECT_MASTER_SPECIFICATION.md) §33, §35.9, §35.10

## 1. Scope

This contract owns current setting keys, scope, change authority, configured values and missing-value behavior. The inventory in §7 is the source of truth. Retired keys in §7.6 must not govern current behavior. An unset value is explicitly unresolved; seed values are never implicit fallbacks.

## 2. The governance rule that overturns the usual instinct

**§33.4: "Version 1 has no global-business-default-to-hub-override hierarchy for pricing and operational settings."**

There is no inheritance chain. Not hub → global → built-in default. Not anything. The responsible hub's approved effective value is authoritative, full stop.

§33.3 states the consequence: "Missing required hub configuration must **fail visibly and safely**; the system must not silently borrow another hub's values or an undocumented global default."

And §33.4 closes the obvious loophole: "no developer may infer it from database nullability or configuration convenience."

This matters because a fallback chain is the reflexive way to build settings resolution, and here it is forbidden. A hub with no **service-area base fee** does not quietly price at another hub's rates — it fails, visibly, and an administrator is alerted. `MSC-DEC-218` made this sharper rather than milder: **every** fee is hub-scoped now, so a new hub cannot trade until **all nine** of its fee keys exist. (`MSC-DEC-218` scoped eight; `MSC-DEC-219` restored `MELARC_HIGH_VALUE_TIERS` to hub scope, making nine.) Any future per-zone or per-vendor override layer must "separately define precedence, inheritance, effective dates, conflict display, and audit" (§33.4) before it exists.

### 2.1 Default is a seed, not a fallback

*Resolves `CONFLICT-023`.*

§33.1 requires every setting to declare a "default/fallback" value, which reads as contradicting §33.4's no-hierarchy rule. The reconciliation: for a hub-scoped setting, the declared default is a **bootstrap value applied when a hub is created** — an explicit, audited act — and never a runtime substitute for an absent value. At runtime, absence is an error.

For platform-wide settings there is no hub dimension, so the declared value simply is the value.

## 3. Scope classes

§33.1 supersedes the source baseline's global-by-default assumption. Three classes, and a setting belongs to exactly one:

| Class| What lives here| Who changes it|
|---|---|---|
| **Hub**| **Every fee Melarc charges**, operational settings, service zones| Hub Senior Ops proposes → Platform Admin approves (§33.3)|
| **Company-wide**| Values deliberately uniform across hubs: `transaction_currency`, `liability_cap_amount`, `value_declaration_threshold`, `claim_report_window_hours`, `unpaid_return_storage_grace_days`, `return_fee_waiver_reasons`, the global vendor account limit, retention periods. **No fee belongs here**| Hub Senior Ops proposes → Platform Admin approves, **reusing the hub maker-checker pattern even though the value is not hub-scoped** (§28.4, `MSC-DEC-162`, `MSC-DEC-177`)|
| **Platform**| Identity, security, infrastructure, integration governance| Platform Admin; secrets are excluded entirely — see §5|

**Fees are hub-scoped, and this was got wrong once.** The pricing refactor first placed base fees in the company-wide class, reasoning from `MSC-DEC-162` that a value printed on a rate card cannot vary by hub. `MSC-DEC-218` overturned that: **each hub publishes its own rate card**, so a Kumasi figure contradicts nothing in Accra's. The earlier reasoning was sound only while one hub existed. What remains company-wide is **policy** — the liability cap, the declaration threshold, the claim window — because those state what the company owes, not what a city costs.

**The company-wide class is easy to miss and easy to mis-model**, and what it contains is now narrow: currency, the three liability policy limits, the waiver-reason catalogue, the global vendor limit and retention periods. Nothing else. Modelling any of them as hub-scoped would permit a **payout promise** or a **retention period** to differ by city, which is not a pricing decision to delegate but a company commitment; modelling them as platform settings would bypass the Senior Ops proposal step.

`station_drop_fee` and `flat_return_fee_amount` are hub-scoped. Do not model them as company-wide values.

## 4. Required metadata

§33.1 requires eleven attributes on every setting. All eleven, not a convenient subset:

| Attribute| Note|
|---|---|
| Stable key and type| §33.1. **Stable implies never reused** — a key rebound to a different meaning is not stable, and every historical record referencing it would silently change sense|
| Description and **unit**| Unit is mandatory — `minutes`, `pesewas`, `attempts`, `hours`|
| Current/effective value||
| Default/fallback| A bootstrap seed, per §2.1|
| Validation range or format||
| Editing permission| A key from [permissions.md](permissions.md) §7|
| Effective date, where versioned| Mandatory for every price-related setting (§33.3)|
| Audit: actor, timestamp, **old and new value**, reason| Old *and* new — §35.1.6's before/after rule|
| Safe cache and config propagation||
| Behaviour when missing| Per §2, this is "fail visibly", not "use a default"|
| Behaviour when invalid| "Fail safely and alert administrators" (§33.3)|

## 5. Change governance

From §33.3, and these are rules rather than guidance:

- **Secrets are not settings.** Security-sensitive values require secret management and are not administered through this mechanism (§33.3, §35.9.4). A settings screen that can display an API key is a defect.
- **Changing a setting must not silently mutate historical transactions.** This is the read side of [domain-model.md](domain-model.md) §3.7's snapshot rule: records carry the value and version applied at the time.
- **Price-related settings require versioning, effective dating and snapshot traceability.** `MSC-DEC-177` states the shape: changes are effective-dated, apply to new charges only, and every charge snapshots the applied value and version. Existing charges do not reprice.
- **Kill switches require visible operational status and a restoration procedure** (§33.3, §35.9.5). An operator must be able to see that a switch is active without inspecting a database.
- **Settings that alter permissions or financial limits may require maker-checker approval** — the uniform `*.create`/`*.approve` shape from [permissions.md](permissions.md) §6.
- **Hub changes preserve old, proposed and approved values, reason, effective dating, actors, and historical transaction snapshots** — the full set, not the final value alone.

## 6. Status taxonomy

The specification distinguishes four conditions that a single "value" column would blur. Naming them prevents a provisional number being read as approved:

| Status| Meaning|
|---|---|
| `CONFIRMED`| Value approved and citable now|
| `PROVISIONAL`| A source default exists but a named review must confirm it before it is authoritative. **Not citable as product policy**|
| `OPEN`| Value required, not yet decided. Blocks the slice's launch, not its documentation|
| `RETIRED`| Present in legacy configuration and **must not govern Version 1 behaviour**|

**`PROVISIONAL` is defined here and used by no key in §7, while four keys meet its definition exactly.** `handshake_code_length`, `handshake_code_ttl_minutes`, `handshake_max_wrong_attempts` and `intake_parcel_cap` are each a **source default with a named review still pending**, and each is marked `CONFIRMED` — three of them with a *(source default)* annotation that carries no defined meaning in this taxonomy. **The distinction is not cosmetic**: `PROVISIONAL` says *not citable as product policy*, and `CONFIRMED` says the opposite, so features currently cite four figures as approved policy that a review has not yet approved. Restatusing them would touch readiness verdicts in several features, so it is raised as **`OQ-078`** rather than changed here. **Closed by `MSC-DEC-256`, 26 August 2026**: the four keys were reviewed and confirmed, so they hold `CONFIRMED` **by decision rather than by inheritance**, the *(source default)* annotation records where each figure came from rather than a status, and `PROVISIONAL` stays defined and unused. *The sentences before this one are kept as the question was raised.*

## 7. Inventory

**§7 transcribes §33.2's setting inventory**, preserving its own wording for each key's status and required decision, and adds the scope class and status taxonomy from §3 and §6. Where a row states a prohibition — "must not create a launch charge," "must not govern target behaviour" — that language is §33.2's, not this document's.

### 7.1 Company-wide

| Key| Status| Value| Notes|
|---|---|---|---|
| `service_window_days`| `CONFIRMED`| **Monday–Saturday**| The denominator for §42.8's availability target. Sunday falls outside entirely, matching §7.10's no-Sunday-delivery rule|
| `service_window_hours`| `CONFIRMED`| **07:00–18:00** `Africa/Accra`| With the days above, about **286 hours a month** — so 99.5% permits roughly **86 minutes** of downtime, against 219 under the calendar reading. **Company-wide, not per-hub**: one availability figure is reported for the platform, and per-hub windows would make the denominator ambiguous the moment a second hub opens with different hours. **Planned maintenance is not excluded** — the window leaves the hours free for it instead|
| `transaction_currency`| `CONFIRMED`| `GHS`| Only launch currency. ISO 4217, fixed-decimal (§23.9, `MSC-DEC-179`)|
| `liability_cap_amount`| `CONFIRMED`| **GH₵300**| Maximum payable per parcel for loss or damage. **Reverses §23.4, `MSC-DEC-156–157`**, which promised no cap. Already published to customers. Mechanics are `OQ-061`|
| `value_declaration_threshold`| `CONFIRMED`| **GH₵500**| Above this, the sender declares value **and acknowledges the cap** at booking|
| `claim_report_window_hours`| `CONFIRMED`| **72**| Loss or damage reported within this window. **A late claim may still be accepted at hub Senior Ops discretion with a recorded reason** — the window is a standard, not a wall|
| `unclaimed_adjustment_grace_days`| `CONFIRMED`| **90**| **`MSC-DEC-395`.** How long a `FinancialAdjustmentRequired` stays `OPEN` before Senior Ops may propose `UNCLAIMED_DISPOSITION` for a payer who cannot be reached. **Indefinite `OPEN` was rejected on §16.3** — a record that can never close is how unresolved money becomes invisible. Set by `MSC-DEC-396` — **longer than the parcel, deliberately**: holding money Melarc owes is not the same as holding someone’s parcel, and a write-off after a quarter is defensible where one after a month is not. `OQ-126` closed|
| `unpaid_return_storage_grace_days`| `CONFIRMED`| **14**| **`MSC-DEC-394`.** An unpaid ad-hoc sender's returned parcel does not sit in hub custody indefinitely — after this many days, Senior Ops may escalate it toward final disposition, the same discretionary shape `MSC-DEC-197`/`MSC-DEC-220` already use. Set by `MSC-DEC-396` — two weeks is proportionate to a physical parcel held against a GH₵20 fee. **Discretionary at the ceiling**, not automatic: Senior Ops *may* then propose escalation. `OQ-125` closed|
| `return_fee_waiver_reasons`| `CONFIRMED`| Three categories| Melarc-caused operational error; unresolved documented dispute at return-start; one-time goodwill or service-recovery exception. **No hard numeric cap** (§28.4, `MSC-DEC-163`). Senior Ops approves each instance with mandatory audit|
| `global_vendor_account_limit_amount`| `CONFIRMED`| **GH₵200**| **Keyed 20 September 2026 at `SLICE-008` Pass 1 — the value and its authority were always approved; only the identifier was missing, and this was the one `CONFIRMED` row in this table without one.** No value, status, scope or authority changes. One platform-wide control for every approved vendor (§34.6, `MSC-DEC-045`). Set by `MSC-DEC-238`. **A near-prepay posture, not a credit line** — about five outstanding orders at average fee. **One figure for every vendor**, largest and smallest, with no Version 1 override. **Interacts with `booking_cutoff_time`**: a vendor reaching the limit before 10:00 was shut out of that day even after settling. `MSC-DEC-254` closed `OQ-076` — **settling reopens the day within `vendor_credit_grace_window_minutes`**|
| `accounting_export_file_retention_days`| `OPEN`| —| How long a generated accounting-export package stays retrievable. **Value undecided — `OQ-130`.** Generation refuses with `EXPORT_RETENTION_NOT_CONFIGURED` while unset: `file_available_until` cannot be computed, and a file with no stated lifetime should not exist. **The `AccountingExport` record is permanent regardless** — only the package expires|
| Retention periods, per category| `OPEN`| —| Photos, audit events, call logs, notifications, sender records, parcel history. Model and Platform Admin sole authority confirmed (§38.7, `MSC-DEC-150–152`); periods are `OQ-028`, needing legal input|

### 7.2 Hub — pricing

**Every key in this section is hub-scoped**. A hub sets its own fees; Accra's configuration does not govern Kumasi or Takoradi. Four of them — `station_drop_fee`, `flat_return_fee_amount`, `single_package_pickup_fee` and `cancellation_charge_amount` — moved here from §7.1, where they had been company-wide. **That section is now titled simply “Company-wide”**: it held no platform key after the move, and platform settings live in §7.5.

**§33.4 makes this consequential.** Settings never inherit, so a hub missing any fee below **fails visibly** rather than borrowing Accra's. A new hub therefore takes no bookings until all nine are entered — intended behaviour, since a hub silently charging another city's prices is the worse failure. See §2.1 on bootstrap seeds.

| Key| Status| Value| Notes|
|---|---|---|---|
| Hub service-zone catalogue| `CONFIRMED` *(launch hub)*| 7 zones| Tema, Accra Central, Lapaz/Sowutuom, Madina/Adenta, Dansoman, Amasaman & Environs, Kasoa Corridor (§35.10, `MSC-DEC-050`). **Answers serviceability only — is this address served, which service area, which days. It is no longer a price input**. Zone fields, versioning, effective dating, overlap, rollback and snapshots remain design work|
| `service_area_base_fee`| `CONFIRMED`| **GH₵35** *(Accra hub)*| **Hub-scoped**, per service area, **independent of origin**. Accra & Tema GH₵35 Mon–Sat; Amasaman & Environs GH₵35 **Friday only**; Kasoa Corridor GH₵35 **Friday only**. All three are the same figure today and are still **three separate values**, because they are expected to diverge and a single key would make divergence a schema change|
| `corridor_off_day_fee`| `CONFIRMED`| **GH₵70** *(Accra hub)*| **Hub-scoped**. Charged when a corridor delivery is requested **off its batch day**. Not an express service and **not** a same-day promise — it prices a dedicated trip outside the batch, which is why it is double the batch fee rather than a percentage of it|
| `station_drop_fee`| `CONFIRMED`| **GH₵20**| **Hub-scoped** since `MSC-DEC-218`; was company-wide under §24.7, `MSC-DEC-177`. Effective-dated. New charges snapshot the applied value/version; existing charges do not reprice. **Was GH₵25; reduced by `MSC-DEC-207`.** The published Service Guidelines say GH₵20 and agree. **No size surcharge applies**|
| `redelivery_fee_minor`| `CONFIRMED`| **GH₵20** *(Accra)*| **Hub-scoped.** Charged **in addition to the applicable delivery fee for the new trip** when authorised Ops schedules a redelivery. **Payer: recipient.** **Snapshotted at scheduling** — a later change to this value never rewrites a redelivery already scheduled. **Distinct from `flat_return_fee_amount`**, which happens to share the launch figure and governs a different act|
| `flat_return_fee_amount`| `CONFIRMED`| **GH₵20**| Per package. **Hub-scoped** since `MSC-DEC-218`; was company-wide under §28.4, `MSC-DEC-162`. **Always charged, waivable by Ops with a recorded reason, Senior Ops approving** — the `MSC-DEC-197` discretionary pattern, not a conditional rate. A return riding along with a scheduled pickup is a **waiver**, not a different price. **Applies equally to an unreachable-recipient return**: the vendor supplied the contact details, so charging by default puts the cost where the cause is, and the waiver is what keeps it fair|
| `single_package_pickup_fee`| `CONFIRMED`| **GH₵20**| **Hub-scoped.** Charged on the one-package exception **in addition to** its approval — which is now **permission-based, not Platform-Admin-only** (`MSC-DEC-333` widened `pickup.exception.approve`). **Settlement follows the Vendor's eligibility**: due on acceptance in every case; **posted to statement** for an allowance-enabled, unrestricted Vendor with normal SLA proceeding; **settled before pickup proceeds** where `VendorOperationalEligibility.requires_prepayment`. An AdHocSender gains no allowance by analogy. Originally. Approval decides whether Melarc goes; the fee prices the dedicated trip. Deliberately equal to `flat_return_fee_amount` — both price a trip Melarc would not otherwise make|
| `cancellation_charge_amount`| `CONFIRMED`| **GH₵20** *(Accra hub)*| **Hub-scoped** since `MSC-DEC-218`. Hub Senior Ops proposes, Platform Admin approves. Effective-dated, snapshotted per §5. Set by `MSC-DEC-238` — **deliberately equal to `flat_return_fee_amount` and `single_package_pickup_fee`**, all three pricing a trip Melarc would not otherwise make. **Discretionary**: applied by Ops with a mandatory reason, waived by Senior Ops|
| `size_class_surcharges`| `CONFIRMED`| `SMALL` GH₵0 · `MEDIUM` GH₵20 · `LARGE` GH₵30 *(Accra hub)*| **Hub-scoped**. **Applies to outside-Accra deliveries only** — doorstep within the service area and Station Drop are flat regardless of size. Renamed from `size_category_surcharges`; `EXTRA_LARGE` withdrawn. **There is deliberately no boundary or threshold key**: the receiving officer selects the class by judgement at itemization, and no weight or dimension rule exists to configure. Do not add one|
| `outside_accra_margin`| `CONFIRMED`| **GH₵30 flat** *(Accra hub)*| **Hub-scoped.** The margin on a third-party carrier's actual charge for door-to-pickup-point delivery outside the service area. **The unit is a flat amount, not a percentage** — Melarc's work does not scale with the carrier's price, and a percentage would double-count size, which `size_class_surcharges` already charges for. **Derived**: `station_drop_fee` GH₵20 is the same physical trip, so GH₵20 is the floor and GH₵30 prices fronting the carrier charge and owning the final outcome|
| `MELARC_HIGH_VALUE_TIERS`| `CONFIRMED`| **GH₵500–2,000 → GH₵10 · above GH₵2,000 → GH₵20** *(Accra hub)*| **Hub-scoped.** Retained by `MSC-DEC-219`: the cap limits what Melarc pays out, this funds the handling that makes a payout less likely. Tiers set by `MSC-DEC-238`. Bands begin at `value_declaration_threshold`; below GH₵500 there is no declaration and no surcharge. **Two tiers, not three, on purpose** — `liability_cap_amount` is flat, so each further tier charges more for cover that does not increase. **Note the deliberate asymmetry** — hub-scoped while `liability_cap_amount` is company-wide, so two hubs may charge differently for high-value handling while owing the same GH₵300 on a loss|

### 7.3 Hub — operational

| Key| Status| Value| Notes|
|---|---|---|---|
| `vendor_credit_grace_window_minutes`| `CONFIRMED`| **60**| Per-hub, like the cutoff it extends. Set by `MSC-DEC-255` — a settled vendor may book until **11:00**. Minutes past `booking_cutoff_time` within which a vendor who has **settled** may still book for that day's service (`MSC-DEC-254`, closing `OQ-076`). **The trade-off runs both ways**: too short and the ruling changes nothing, because payment clearing already consumes minutes; too long and the 10:00 cutoff becomes advisory for anyone willing to pay late — the thing `MSC-DEC-238` set it to prevent. **Sixty was chosen against both failure modes**: thirty risked the rule never firing while mobile-money clearing consumed the window, and a hundred and twenty hands Ops a midday run-building problem the mid-morning cutoff exists to prevent. `OQ-100` closed|
| `booking_cutoff_time`| `CONFIRMED`| **10:00** *(Accra hub)*| Per-hub. Scope, late-booking handling, service-day uniformity and editing authority confirmed (§21.1, `MSC-DEC-147–149`); hub Senior Ops proposes, Platform Admin approves. Time set by `MSC-DEC-238`. **Mid-morning by design** — Ops holds the balance of the day to build runs, which the Friday-only corridors require. **A late booking is neither auto-scheduled nor blocked** — it confirms and queues for Ops review|
| Operating calendar| `CONFIRMED`| Monday–Saturday| Uniform across every zone; **no zone-level variation** (§21.1, `MSC-DEC-149`)|
| `MELARC_MAX_PICKUP_ATTEMPTS`| `CONFIRMED`| 3| Force-extension by hub Senior Ops with a mandatory reason (§21.6, `MSC-DEC-116`). Only technical storage, extension ceilings and audit mechanics remain design work|
| `auto_reschedule`| `CONFIRMED`| Off| Version 1 uses controlled Ops rescheduling. Any future activation requires a new approved decision and safe migration|
| `stale_failure_backstop_hours`| `CONFIRMED`| **24** *(Accra hub)*| Hours a pickup failure may sit undecided in the Ops decision context before a scheduled backstop escalates it (§21.6). Set by `MSC-DEC-237` — one full service day. Escalation ownership, monitoring and safe missing-value behaviour remain operational design|
| `intake_lock_idle_ttl_minutes`| `OPEN`| —| Idle minutes before another receiver may take over an intake's **advisory soft lock** (§22.8). **Added 23 August after being found in a feature rather than in this inventory** — `features/hub/hub-intake.md` had named it as a launch blocker since it was written, and no key existed for it here, so the settings register could not see the blocker. `OQ-051`. §22.8 is explicit that the lock is **advisory**: backend transition and idempotency controls are required regardless, so an unset TTL degrades takeover, not correctness|
| `intake_parcel_cap`| `CONFIRMED`| 100| Source default, technical review required for capacity, error handling and change governance|
| `doorstep_wait_minutes`| `CONFIRMED`| **10**| **The controlled wait after a failed doorstep contact**. **Server-derived**: `wait_expires_at` = `wait_started_at` + this. A client-supplied elapsed claim is never accepted, and the failure guard reads authoritative time|
| `pickup_service_window_start`| `CONFIRMED`| **11:00** *(Accra hub)*| Per-hub. The **customer-facing** pickup window opens. **Not the operating hours** — 07:00–18:00 is when Melarc works, and the hours before this are booking, planning and dispatch preparation|
| `pickup_service_window_end`| `CONFIRMED`| **16:00** *(Accra hub)*| Per-hub|
| `delivery_service_window_start`| `CONFIRMED`| **10:00** *(Accra hub)*| Per-hub. The **customer-facing** delivery window|
| `delivery_service_window_end`| `CONFIRMED`| **16:00** *(Accra hub)*| Per-hub. The two hours to operating close are return, reconciliation and cash|
| `cash_reconciliation_cutoff_time`| `CONFIRMED`| **18:00** *(Accra hub)*| Per-hub. Operating close for same-day cash obligations. **Open cash past this time is an exception requiring visibility, not an accusation** — a legitimately active run may still be out|
| `recipient_cash_enabled`| `CONFIRMED`| **Off** *(Accra hub, until the reconciliation workflow is operational)*| Per-hub **capability**, not a policy toggle. A hub that cannot reconcile cash must not accept it — enabling this before Rider handover, Hub reconciliation and disposition are operational creates the disappearance Gate C exists to prevent|
| `merchant_momo_fallback_enabled`| `CONFIRMED`| **On** *(Accra hub)*| Per-hub **capability** for the Merchant MoMo payment fallback. **Receipt still requires independent confirmation** under `payment.momo.confirm_manual` — the capability enables the path, never the proof|
| `rider_door_wait_minutes`| `CONFIRMED`| 10| Per-hub configurable (`MSC-DEC-201`, closing `OQ-059`). **The pickup-side door wait** — how long a rider waits at a sender's door before the §6 handshake failure path may open; *busy* is never a trigger. **Not the delivery doorstep wait**, which is `doorstep_wait_minutes` (`MSC-DEC-349`, above): two acts, two keys, one launch value, and changing one must not change the other|
| Motorcycle compliance warning lead times| `CONFIRMED`| **30 / 14 / 7 days** *(Accra hub)*| Advance warnings before roadworthy, insurance or licence expiry. Set by `MSC-DEC-237` — three notices, spaced so each still reads as new information. §34.10 makes an expired document block rider assignment, so a missed warning grounds a rider. Expiry-review SLA, escalation and recipients remain operational design|
| Fuel-record governance| `CONFIRMED`| Melarc pays| The system records each fuel expense for audit and reporting. **The no-rider-reimbursement clause is withdrawn by `MSC-DEC-317`** — a road expense funded `RIDER_PERSONAL` records a reimbursement **obligation**, because a rider buying fuel with their own money and never being reimbursed is funding operations personally. **The claim *workflow* — routing, payment run, timing — belongs to the future Accounting domain and is still not designed here**, which is the part of the original clause that survives|
| Fuel-record exception thresholds| `OPEN`| —| Anomaly thresholds, review routing, correction controls and reporting, **without introducing a rider claim workflow**. **Deliberately unset**: an anomaly threshold is a claim about what normal looks like, and no internal precedent exists to derive one from. **Set from the first month of live fuel records.** `OQ-051`, owned by `SLICE-009`|

### 7.4 Handshake and notification

| Key| Status| Value| Notes|
|---|---|---|---|
| `handshake_code_length`| `CONFIRMED` *(source default)*| 4| Security review required; the approved actor and channel direction may not change (§21.4, `MSC-DEC-114–115`)|
| `handshake_code_ttl_minutes`| `CONFIRMED` *(source default)*| 15| Expiry, regeneration and exception controls belong to security and OpenAPI design. `OQ-048`|
| `handshake_max_wrong_attempts`| `CONFIRMED` *(source default)*| 5| Lockout, recovery, monitoring and abuse controls belong to security design. `OQ-048`|
| `handover_otp_length`| `CONFIRMED`| **6**| Digits in the handover OTP. **One parameter set governs both handovers**: `requestReturnOtp` *"mirrors `requestDeliveryOtp` exactly, redirected to a different contact"*, so §25.1's delivery OTP and §28.4's return OTP are one mechanism with two destinations. **Not `handshake_code_length`**: [errors-and-enums.md](errors-and-enums.md) binds §5.2's codes by definition to the handshake's own settings and forbids one figure governing two mechanisms|
| `handover_otp_ttl_minutes`| `CONFIRMED`| **10**| How long a dispatched handover OTP stays valid before it must be re-sent. A Melarc security/UX policy — long enough to clear normal SMS delivery latency and a doorstep read-back, short enough to bound a captured code; only a pathologically slow vendor would need more. **One parameter set governs both handovers** (§25.1, §28.4). **No expiry code accompanies this key**: [doorstep-delivery.md](../features/delivery/doorstep-delivery.md) already maps *wrong, expired or absent* onto `OTP_INVALID`, and splitting an approved mapping is a Product change rather than a settings one|
| `handover_otp_max_wrong_attempts`| `CONFIRMED`| **3**| Wrong submissions before the code is dead. `AC-SLICE-003-05` exercises three failures, and **three is now the approved figure** — the criterion named the count this key now sets|
| `sms_fallback_max_per_pickup`| `CONFIRMED`| 3| **CRIT-08 audit remediation.** Maximum `requestSmsHandshakeFallback` sends per `PickupStop` handshake session. A rider who exhausts it has a genuinely unusable portal path, not an SMS problem to keep retrying — the existing ladder's next rung, Fallback 2 (`authoriseHandshakeOverride`), is exactly the route built for that|
| `sms_fallback_cooldown_seconds`| `CONFIRMED`| 60| **CRIT-08 audit remediation.** Minimum spacing between consecutive `requestSmsHandshakeFallback` sends for the same stop, independent of the cap above — a burst of retries within one cooldown window does not each consume a separate attempt-worth of vendor SMS before the rider (or a script) could plausibly have read the first one|
| `adhoc_failure_sms_enabled`| `CONFIRMED`| On| Kill switch. §33.3 requires the active state be **visible to authorised operators** with a documented restoration procedure|
| `heads_up_sms_enabled`| `CONFIRMED`| On| Kill switch. Governs the once-per-parcel heads-up SMS at itemization close|

### 7.5 Platform — authentication

**Platform-scoped** (§3): identity and security settings, changed by Platform Admin. **Secrets are not here and never will be** — §33.3 and §35.9.4 keep provider keys and signing material in a secret store, and `SECURITY_DESIGN.md` §9 states that a settings screen able to display an API key is a defect.

| Key| Status| Value| Notes|
|---|---|---|---|
| `session_lifetime_minutes`| `CONFIRMED`| **Rider 1440 · Standard 720 · Privileged 480**| **Per-tier** (`MSC-DEC-234`, closing `OQ-071`). Standard is Vendor, Ops Staff, Fleet Manager and Finance/Reconciliation; **Privileged is Senior Ops and Platform Admin and no other bundle** (Product decision, 6 October 2026) — a Fleet Manager or Finance/Reconciliation holder has the standard 720-minute absolute lifetime and 30-minute idle timeout and signs in with no mandatory second factor. The **absolute** ceiling on a session, working or idle. Since `MSC-DEC-228` withdrew elevation, a privileged session is privileged for its whole life — `session_idle_timeout_minutes` now carries that exposure, which is why these may be generous|
| `session_idle_timeout_minutes`| `CONFIRMED`| **Standard 30 · Privileged 15** · **Rider: none, by rule**| Added by `MSC-DEC-234`. Minutes of inactivity before a **browser** session ends. This is the control that matches the actual risk — an unattended browser is an idle condition, which an absolute lifetime cannot distinguish from a user who is working. **The rider app is excluded by rule, not by omission**: a rider taps nothing between stops and cannot sign in without signal, so an idle logout would strand them at a door, unable to complete the §19.6 OTP — a failure that would be Melarc's own, which `MSC-DEC-309` says must never cost the customer a physical attempt.|
| `signin_max_attempts`| `CONFIRMED`| **5**| Before lockout. Set by `MSC-DEC-236`, matching `handshake_max_wrong_attempts` — the product already judged five wrong entries tolerable on a phone keyboard. **What counts, and where the count lives**: a failure counts only once the request has reached the credential's factor, and the count and the lock sit on the credential record, not in a setting — `SECURITY_DESIGN.md` §13.4b|
| `signin_lockout_minutes`| `CONFIRMED`| **15**| Set by `MSC-DEC-236`, matching `handshake_code_ttl_minutes`. Long enough to defeat automation, short enough not to cost an officer a shift|
| `recovery_link_ttl_minutes`| `CONFIRMED`| **30**| Lifetime of a recovery token. **Single-use regardless of lifetime** — expiry and reuse are separate controls, and a short window does not substitute for invalidating a consumed token|
| `recovery_request_supersede_guard_seconds`| `CONFIRMED` *(starting value)*| **60**| **A starting value, set by the Product Owner on 6 October 2026.** A self-service recovery request made **less than this many seconds after the pending link was issued** neither supersedes that link nor issues another, and is answered with the same `202` as any other, so nothing is revealed ([credential-recovery.md](../features/identity/credential-recovery.md) §5.5). It keeps a repeated request from replacing a link that has only just been sent. Platform Admin launch configuration under `MSC-DEC-217`, so a figure that proves wrong is a settings change|
| `mfa_max_attempts`| `CONFIRMED`| **3**| **Deliberately lower than `signin_max_attempts`**. Counted **per challenge**, and each wrong code also adds one to the identity's lockout count shared with the password; set tighter: a user at this step has already proved the password, so a wrong code is **more** suspicious than a wrong password, not less|
| `authentication_challenge_ttl_minutes`| `CONFIRMED`| **5**| Lifetime of a **privileged MFA sign-in challenge** and a **rider cryptographic sign-in challenge**. **Not a security link**: the nearest approved figure was `recovery_link_ttl_minutes` at 30, which is wrong by an order of magnitude for a challenge answered by someone already mid-sign-in with an authenticator in hand. Applies to those two challenges and **nothing else** — recovery links, setup grants, the bootstrap secret and sessions keep their own lifetimes|

**All six now carry values**. §11.2 deferred *“low-level password/PIN, factor, token, lockout, expiry, device-identifier, and session mechanics”* to security architecture, and that deferral is now discharged: the **structure** was fixed here and the **figures** arrived on 23 August. Every one is Platform Admin launch configuration under `MSC-DEC-217`, so a figure that proves wrong in practice is a settings change rather than a release — which is what made setting them before operating data reasonable.

**Credential length is not a setting, deliberately.** The 12 to 128 character bounds on staff passwords, the bootstrap password and Vendor shared secrets and the six-digit rider PIN are constants of the contract, enforced by the request schemas, so no administrator can weaken them at runtime and no key exists to be left unset.

### 7.7 Platform — security operations

**Platform-scoped** (§3). Created by Gate B — `MSC-DEC-285` for the rate-limit buckets, `MSC-DEC-282` and `MSC-DEC-283` for the two mechanism lifetimes. **Secrets remain absent from this document entirely** (§33.3, §35.9.4): these are operating parameters, not keys.

**Every key below now carries a value, and the six rate-limit buckets were the last to get one** (`MSC-DEC-371`, closing `OQ-067`). `MSC-DEC-285` separated two statements that had been read as one — *the bucket architecture exists* and *the launch values have been supplied* — and held the second visibly false for nine days by leaving every key `OPEN`. **Both are now true, and the separation is what makes that sentence checkable.**

**Six buckets, and six is the number.** The two sub-ceiling rows are safeguards **inside** `rate_limit_authenticated_api`; they are deliberately not named `rate_limit_*`, because a key that looks like a bucket becomes one in someone's implementation, and Gate B's bucket architecture is closed.

| Key| Status| Value| Notes|
|---|---|---|---|
| `rate_limit_staff_signin`| `CONFIRMED`| **10 / minute**| Bucket keyed on the **normalized Staff identity**. Launch value set by `MSC-DEC-371`, closing `OQ-067`. **Ten a minute is far above a person signing in and far below automation** — `signin_max_attempts` locks the credential at 5 wrong tries regardless, so this bucket exists to stop the request volume, not to replace that lockout|
| `rate_limit_privileged_mfa`| `CONFIRMED`| **10 / minute**| Bucket keyed on the **MFA challenge and principal**. Launch value set by `MSC-DEC-371`. **Deliberately separate from staff sign-in**: `mfa_max_attempts` is 3 against `signin_max_attempts` of 5 because a wrong code from someone who already proved a password is *more* suspicious, and one shared bucket makes that reasoning unexpressible. **The equal launch figure does not merge the buckets** — it is the rate ceiling that matches, while the attempt ceilings stay 3 and 5|
| `rate_limit_vendor_signin`| `CONFIRMED`| **10 / minute**| Bucket keyed on the **Vendor account and its registered device**. Launch value set by `MSC-DEC-371`. `MSC-DEC-224` names this the tightest posture — one credential, many people, the highest-volume abuse path. **The device is half the key, and that is what makes 10 safe here**: a shared vendor credential used by several staff on several registered devices gets a bucket each, so the tight ceiling throttles an attacker rather than a busy shop|
| `rate_limit_rider_challenge`| `CONFIRMED`| **20 / minute**| Bucket keyed on the **submitted phone number** (decided 6 October 2026: a challenge request carries no device, and the same key serves the sign-in that follows it, a number that matches no rider included). Launch value set by `MSC-DEC-371` — **the loosest of the five authentication buckets, deliberately**. A **failed** signature consumes the nonce, so every attempt reaches this limiter rather than hammering one challenge, and a rider on an intermittent link legitimately retries a challenge several times at one door. **A limit that strands a rider mid-delivery is a Melarc failure the customer pays for**, which `MSC-DEC-309` says must not happen|
| `rate_limit_recovery`| `CONFIRMED`| **10 / minute**| Bucket keyed on the **recovery principal** — the **credential setup and recovery bucket**, which also holds the setup operations listed below the table. Launch value set by `MSC-DEC-371`. The channel is resolved from the registered contact and never from the request, so the principal is the only stable key — and because recovery messages go to a real person's registered contact, the ceiling also bounds how often that contact can be used to harass them|
| `rate_limit_authenticated_api`| `CONFIRMED`| **120 / minute**| Bucket keyed on the **active Session**. Launch value set by `MSC-DEC-371`. §37.8's general API limiting, the gap `OQ-060` raised. **Two operation classes carry a tighter sub-ceiling inside this one** — see the two rows below, which are safeguards within this bucket and **not** further buckets|
| `report_export_initiation_ceiling_per_minute`| `CONFIRMED`| **10 / minute**| **A sub-ceiling inside `rate_limit_authenticated_api`, not a seventh bucket**. Per active principal or session. Report and export creation is the cheapest request a caller can make and the most expensive one Melarc can serve — §40.3 already requires it to run asynchronously, and this bounds how fast a caller can fill that queue|
| `provider_initiating_operation_ceiling_per_minute`| `CONFIRMED`| **20 / minute**| **A sub-ceiling inside `rate_limit_authenticated_api`, not an eighth bucket**. Per active principal or session. Bounds operations that cause an outbound SMS or payment call, so one caller cannot spend Melarc's provider credit or trip a provider's own limit for everyone else|
| `evidence_upload_max_bytes`| `OPEN`| —| **MED-12 audit remediation.** Maximum accepted size for a single Evidence upload, checked at `completeEvidenceUpload` against what `createEvidence` declared. `EvidenceCreate.byte_size` today carries only `minimum: 1` — no ceiling to reject against exists anywhere. Tracked at `OQ-121`, no internal precedent to derive a figure from|
| `evidence_upload_allowed_mime_types`| `OPEN`| —| **MED-12 audit remediation.** The closed set of MIME types `completeEvidenceUpload`'s file-signature check validates against. `EvidenceCreate.content_type` is today an unconstrained string, so "supported types" names a set the contract does not carry. Tracked at `OQ-121`|
| `evidence_upload_authorization_ttl_minutes`| `CONFIRMED`| **15**| Lifetime of a **single-object** Evidence **upload** authorization (`MSC-DEC-297`, closing `OQ-102`). **Longer than retrieval on purpose**: the redeeming client may be a rider on an unreliable link, and §7.8 makes intermittent connectivity ordinary — fifteen minutes buys the retry a capture taken at a door often needs|
| `evidence_retrieval_authorization_ttl_minutes`| `CONFIRMED`| **5**| Lifetime of a **single-object** Evidence **retrieval** authorization. **Shorter, because the exposure is different**: it is redeemed immediately by a viewer who has just been authorised, and it is a bearer capability over evidence that may show a recipient, an address or a signature. Five minutes bounds the window if the URL escapes into a proxy log or a screenshot|
| `accounting_export_retrieval_authorization_ttl_minutes`| `CONFIRMED`| **5**| Lifetime of a retrieval authorization over a generated package. **Mirrors `evidence_retrieval_authorization_ttl_minutes`**: the capability is **regenerable**, so a short window costs a caller one extra request, and a payment-ledger package is **at least as sensitive as a single `Evidence` object** — it earns no longer bearer-token lifetime|
| `audit_integrity_checkpoint_interval_minutes`| `CONFIRMED`| **15**| How often the audit integrity checkpoint is cut and signed (`MSC-DEC-297`, closing `OQ-103`). **The interval is two things at once** — the detection window for tampering, and the amount of history a lost checkpoint costs. Fifteen minutes bounds both without the synchronous serial hash lock `MSC-DEC-283` rejected|
| `idempotency_record_ttl_hours`| `CONFIRMED`| **24**| **CRIT-05 audit remediation.** How long an `IdempotencyRecord` row — keyed `principal_type + principal_id + operation_id + idempotency_key` — is kept before it may be reclaimed. **A day, not a session**: rule 4's replay safety exists for a command sent over a flaky connection, and §7.8 makes an hours-long reconnection gap ordinary rather than exceptional, so the record must outlive the retry it protects, not merely the request that created it. **Matched to the failure backstop sweep's grain** (§3.5, `architecture/BACKGROUND_JOBS_AND_EVENTS.md`) rather than a fresh figure — a record purged sooner turns a legitimate late retry into a second, unprotected execution of the same command|

**The last three arrived on 27 August with `MSC-DEC-297`, and the R0 refusal to invent them was the right call.** R0 declined to choose, recording that *"an hourly checkpoint and a fifteen-minute URL lifetime would each look entirely reasonable."* **The approved answer is not the one a default would have produced**: upload and retrieval are **15 and 5**, two values where R0's single key could only ever have held one, and the checkpoint is 15 rather than the hour that reads as natural. **A guess would have been wrong in shape, not merely in number.**

**These eight keys closed `OQ-077` on 27 August, and `OQ-067` stayed open for another nine days.** `OQ-077` recorded that the rate-limit figures had **no keys at all** and stated why the keys were not simply invented: *"how many buckets the limits need is a design choice rather than a value."* `MSC-DEC-285` made that choice; **`MSC-DEC-371` supplied the figures on 5 September and closed `OQ-067`.**

**The credential setup and recovery bucket, and who is in it** (Product decision, 6 October 2026). Seven operations declare `RATE_LIMITED` and belonged to none of the six buckets: `completeStaffCredentialSetup`, `completeMfaEnrolment`, `beginMfaReenrolment`, `completeVendorCredentialSetup`, `completeAdditionalDeviceEnrolment`, `completeRiderDeviceEnrolment` and `requestAdditionalDeviceGrant`. **They join `rate_limit_recovery`: no seventh bucket is created and no figure changes.** Each is counted under the key its request carries — **the setup grant** it presents, or the recovery token — taken from the request whether or not the server can resolve it ([SECURITY_DESIGN.md](../architecture/SECURITY_DESIGN.md) §13.4b).

| Operation| Counted under|
|---|---|
| `requestCredentialRecovery`| The recovery principal the identifier names|
| `completeCredentialRecovery`| The recovery token presented|
| `completeStaffCredentialSetup`| The `STAFF_CREDENTIAL_SETUP` or `BOOTSTRAP_SETUP` grant presented|
| `completeMfaEnrolment`| The `MFA_ENROLMENT` grant presented|
| `beginMfaReenrolment`| The `MFA_REENROLMENT` grant presented|
| `completeVendorCredentialSetup`| The `VENDOR_CREDENTIAL_SETUP` grant presented|
| `completeAdditionalDeviceEnrolment`| The `VENDOR_DEVICE_ENROLMENT` grant presented|
| `completeRiderDeviceEnrolment`| The `RIDER_DEVICE_ENROLMENT` or `RIDER_DEVICE_REREGISTRATION` grant presented|
| `requestAdditionalDeviceGrant`| **Open** — it presents no grant, being the act that creates one (§9)|

**A caller chooses the grant or token it presents, so every made-up value is a fresh key.** A **per-address ceiling at the edge** bounds the cost of attacker-chosen keys. It is a deployment control and not a bucket, a key or a setting ([DEPLOYMENT_AND_ENVIRONMENTS.md](../architecture/DEPLOYMENT_AND_ENVIRONMENTS.md) §12.2), and its value has not been supplied (§9). **The rider challenge and sign-in bucket is keyed on the submitted phone number** (decided 6 October 2026), whether or not it matches a rider.

### 7.6 Retired — must not govern

| Key| Why|
|---|---|
| `delivery_confirmation_max_attempts`| **Retired by `MSC-DEC-351`, 31 August 2026.** It set a **three-call ceiling on `PRE_DISPATCH`**, and the checkpoint has no fixed ceiling: clearance is decided by outcome, and a call count is audit history rather than a gate. **It must not be repurposed as a retry throttle** — a throttle is a different concept and would inherit this key's retired meaning. *Original entry, preserved:*  ·  `delivery_confirmation_max_attempts`  ·  `CONFIRMED`  ·  **3** *(Accra hub)*  ·  Recipient-confirmation contact attempts before escalation to the senior queue. Set by `MSC-DEC-237`, matching `MELARC_MAX_PICKUP_ATTEMPTS`. **§33.2's warning binds harder now that the figures coincide**: this is a **different counter** from the three doorstep-delivery attempts at §34.5. Neither may be implemented as the other, and changing one must not follow the other  ·|
| `MELARC_EXPRESS_SURCHARGE`| Express service is outside Version 1 and **must not create a launch charge**|
| `cod_ceiling`| Merchandise COD is not supported. The legacy setting must not govern target behaviour|
| `high_value_threshold`| Legacy audit snapshot. Historical compatibility only, until the approved high-value model replaces it|
| `high_value_surcharge`| Legacy audit snapshot. Same|
| `zone_pair_matrix`| **Withdrawn by `MSC-DEC-207`.** The N×N origin×destination grid is replaced by a flat `service_area_base_fee`. Wiring it up would reintroduce the boundary disputes and N-per-addition maintenance the refactor removed|
| `corridor_rates`| **Withdrawn by `MSC-DEC-207`.** Its three parts — batch, `NON_BATCH_RATE`, intra-corridor — are replaced by `service_area_base_fee` plus `corridor_off_day_fee`. Intra-corridor pricing no longer exists at all|
| `evidence_signed_url_ttl_minutes`| **Retired 27 August by `MSC-DEC-297`, having never carried a value.** It assumed one lifetime governed both Evidence upload and retrieval, and R1 sets them **deliberately different** — 15 and 5. **Left live it would have been an active alias able to override either**, which is the failure mode this section exists to name: a key that looks harmless because it is empty|
| `size_category_surcharges`| **Renamed** to `size_class_surcharges` by `MSC-DEC-209`, which also withdrew `EXTRA_LARGE` and inverted the scope to outside-Accra only. The old key encodes a four-class universal surcharge that is now wrong in three separate ways|

**`evidence_signed_url_ttl_minutes` is the first key retired for being *ambiguous* rather than superseded**, and it never governed anything — it was created `OPEN` at R0 and retired before a value was ever entered. It is here because the danger is identical: a key that survives in configuration and silently answers a question two other keys now answer better.

These nine exist in legacy or superseded configuration and would each produce plausible-looking, wrong behaviour if wired up — a surcharge for a service that does not exist, a ceiling on a collection type that is not supported, two pricing inputs superseded by `MELARC_HIGH_VALUE_TIERS`, three withdrawn by the pricing refactor, an ambiguous evidence lifetime, and **a three-call ceiling `MSC-DEC-351` retired**. They are listed so that finding one in a config file is not mistaken for finding a requirement.

Retired pricing keys describe an older model. Use only the current keys and mode-specific compositions in §7 and the itemization feature.

## 8. Missing and invalid behaviour

Restating §2 as the implementable rule, because it is where the reflex is strongest:

| Condition| Behaviour|
|---|---|
| Required hub setting absent| **Fail visibly and safely.** Do not borrow another hub's value. Do not use a global default. Alert an administrator|
| Setting present but invalid| Fail safely and alert administrators (§33.3)|
| New hub created| Apply declared bootstrap seeds as an explicit, audited act (§2.1)|
| Kill switch active| Expose the active state to authorized operators, with a documented restoration procedure|

## 9. Questions this document raised

Current unresolved inputs are listed below. Their historical question identifiers are optional provenance; no external register is required.

| Setting/input | Needed input | Consequence |
|---|---|---|
| Retention periods by category | Qualified legal/compliance guidance | No invented retention duration or automatic deletion policy |
| Fuel-record exception thresholds | Operational data and the stated tuning decision | Do not invent anomaly thresholds |
| `intake_lock_idle_ttl_minutes` | Operational value | Advisory-lock behavior must preserve correctness while unset |
| `evidence_upload_max_bytes` | Upload size ceiling | Complete the evidence-upload validation configuration before production use |
| `evidence_upload_allowed_mime_types` | Allowed MIME set | Complete file-signature/type validation before production use |
| `accounting_export_file_retention_days` | Export-package retention duration | Generation refuses with `EXPORT_RETENTION_NOT_CONFIGURED` while unset |
| `requestAdditionalDeviceGrant` rate-limit key | The decision keys the credential setup and recovery bucket by the setup grant or recovery token a request presents, and this operation presents neither: it is the authenticated act that creates a grant | Name its key; the operation is counted in the bucket but its key is unset |
| Per-address ceiling at the edge | The value, and whether it covers every operation that takes a grant or token or only some. A deployment input (`DEPLOYMENT_AND_ENVIRONMENTS.md` §12.2) | Do not invent a figure; the ceiling is not configured |

`unpaid_return_storage_grace_days` is 14 and `unclaimed_adjustment_grace_days` is 90. These are resolved values in §7.1, not outstanding questions. Production configuration and maker-checker rules still apply.

