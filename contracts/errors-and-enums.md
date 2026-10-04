# Errors and Enums

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 1.52 (cleaned edition)
> **Date:** 4 October 2026
> **Owns:** the machine-readable error-code catalogue and the error-response shape
> **Indexes:** every shared enum, pointing to its canonical home — it does not redefine them
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../PROJECT_MASTER_SPECIFICATION.md) §39.1, §36.1, §36.13, §37.1

## 1. Scope

§39.1 requires the OpenAPI contract to define "shared enums and machine-readable error codes." This document is where both are settled before that contract is written.

**It owns the error catalogue outright.** Every code below is defined here and nowhere else.

**It only indexes enums.** State enums belong to [state-machines.md](state-machines.md); domain enums belong to [domain-model.md](domain-model.md). Keep each enum in its owning contract to prevent competing definitions. §6 is a directory, not a definition.

## 2. Error-response shape

Every rejection returns the same envelope. §39.1 requires machine-readable codes; §37.1 requires the backend to be the authority for every rejection.

| Field| Purpose|
|---|---|
| `code`| The stable machine code from §4 or §5. **The only field a client may branch on.**|
| `message`| Human-readable English. Diagnostic, not user-facing copy|
| `details`| Optional structured context — offending field, expected state, permission required|
| `request_id`| Correlation for support and audit|

Three rules make the envelope worth having:

- **Codes are stable API surface.** Renaming one is a breaking contract change under §39.1's deprecation policy, not a refactor.
- **`message` is never parsed.** It is free to change; `code` is not. §39.1 requires the contract to define "machine-readable error codes" — `code` is that machine-readable surface, which makes `message` human-readable by elimination.
- **Display copy is not here.** §36.13 requires "frontend display labels are separated from stable machine codes," and customer-facing wording is `OQ-037`. A surface maps `code` to copy; it does not show `message` to a vendor or rider.

## 3. Naming rules

- `SCREAMING_SNAKE_CASE`, no prefix, no numeric code.
- Name the **reason for refusal**, not the failed operation. `PICKUP_MINIMUM_NOT_MET` tells the caller what to fix; `CREATE_FAILED` does not.
- **Qualify a code whenever an unqualified name could span two rules.** `PICKUP_ATTEMPT_LIMIT_REACHED` names the pickup cap (§35.4.5) and nothing else; its former sibling `DELIVERY_ATTEMPT_LIMIT_REACHED` was **withdrawn at Gate C C1.9** when `MSC-DEC-350` retired the delivery ceiling it named (§5.9). The unqualified `ATTEMPT_LIMIT_REACHED` existed in `state-machines.md` v0.3 and was renamed on exactly this ground — it is the conflation the specification warns against, expressed as an identifier, **and the rule it named has since been retired on one side only**, which is the case qualification exists for.
- One code, one cause. Reusing a code for two distinct rejections makes the client unable to act on either.
- **`_NOT_PERMITTED` and `_FORBIDDEN` are not interchangeable, though both read as "refused."** *MED-03 audit remediation: every existing code already followed this distinction; it had never been written down, so nothing stopped the next code from breaking it.* `_NOT_PERMITTED` names a **business-rule, scheduling or workflow-state constraint that holds regardless of which actor is asking** — `SERVICE_DATE_NOT_PERMITTED` (the calendar), `CORRIDOR_DAY_NOT_PERMITTED` (no batch run or off-day fee configured), `SELF_CANCEL_NOT_PERMITTED_AFTER_ASSIGNMENT` (the workflow has passed the point self-cancellation exists for). `_FORBIDDEN` names an **actor-identity exclusion** — a relational rule between two acts by the same principal. Today it has exactly one occupant, `SELF_APPROVAL_FORBIDDEN` (§37.4, §11.6's maker-checker same-actor exclusion), and stays that way deliberately: a second `_FORBIDDEN` code would need its own identity rule to name, not a synonym for an existing one. **Neither is `PERMISSION_DENIED`** (§4): that code means the actor holds no grant at all, where `_FORBIDDEN` means the actor holds the grant and is excluded from this one instance of it.

## 4. Cross-cutting codes

Applicable to any operation. Each derives from an approved rule rather than from convention.

| Code| Meaning| Source|
|---|---|---|
| `PERMISSION_DENIED`| The actor's bundle **does not carry the operation's permission key at all** — including a session of a principal type the operation does not serve (a vendor session calling an Ops-only operation). **Returned by default** when no permission matches. *Key held but a higher tier needed* is `INSUFFICIENT_AUTHORITY`, never this| §37.1 deny by default; §11.5 forbids inferring permissions from framework defaults|
| `NOT_FOUND`| **The canonical not-found response, `404`**. Returned for a resource that does not exist and, **identically** — same status, code, body shape and timing class — for a record a **Vendor** or a **Rider** may not know exists: another vendor's order, request or file, or — **when the Rider looks it up** — a record not assigned to them (a Rider who *acts* on unassigned work is told `NOT_ASSIGNED_RIDER` or `NOT_CUSTODY_HOLDER`). **Never returned to staff for an existing record outside their hubs**, which is `HUB_SCOPE_VIOLATION`| §43.2, §19.2, §37.6|
| `HUB_SCOPE_VIOLATION`| The actor holds the permission and the record **exists**, but it belongs to a hub outside the actor's authorised hubs. **Informative by Product decision for authenticated staff**; a record that does not exist is `NOT_FOUND`| §35.10, §37.3|
| `STATE_CONFLICT`| The record is not in the state the command expected. **Deterministic rejection, never last-write-wins**| §36.1|
| `IDEMPOTENCY_KEY_CONFLICT`| The key was seen before with a different payload. A replay of the *same* payload returns the original result and is not an error| §36.1, §35.3.9|
| `VALIDATION_FAILED`| Request violates a documented format or range. `details` names the field. **A field whose documented range is a set the API itself returns — `role_bundle_id`, the assignable staff bundles — violates it by naming a member outside that set**| §39.1|
| `SETTING_MISSING`| A required hub setting has no approved value. **Fails visibly — the system never borrows another hub's value or a global default.** Applies to *pricing and configuration* paths only; it may **never** block an operational or custody decision| §33.3, §33.4|
| `SETTING_INVALID`| A setting exists but fails validation. Fails safely and alerts administrators| §33.3|

**One rule per authorization axis** (`MSC-DEC-432`; [SECURITY_DESIGN.md](../architecture/SECURITY_DESIGN.md) §4 is the architecture view of the same table). Every acceptance criterion states the code this table gives, and no operation declares a code that is not in its row:

| Axis| Condition| Status and code|
|---|---|---|
| Authentication| No usable session| `401` `SESSION_INVALID` — `SESSION_SUPERSEDED` for a displaced vendor session only|
| Surface and permission| The principal type is not served by the operation, or the bundle lacks the key| `403` `PERMISSION_DENIED`|
| Tier| The key is held and the target or state needs a higher tier| `403` `INSUFFICIENT_AUTHORITY`|
| Hub scope| Staff, key held, **existing** record outside the authorised hubs| `403` `HUB_SCOPE_VIOLATION`|
| Temporary authority| An effective-dated hub assignment that has expired or not yet begun| `403` `HUB_SCOPE_VIOLATION` — the hub axis with a time bound|
| Nonexistent| No such record, for any principal| `404` `NOT_FOUND`|
| Vendor ownership| A Vendor reads or acts on another vendor's record| `404` `NOT_FOUND`, indistinguishable from a nonexistent record|
| Rider assignment, lookup| A Rider looks up a record that is not theirs| `404` `NOT_FOUND`, indistinguishable from a nonexistent record|
| Rider assignment, act| A Rider acts on work they hold a reference to and are not assigned, or no longer hold custody of| `NOT_ASSIGNED_RIDER` or `NOT_CUSTODY_HOLDER`|
| State| The record is in scope and its state forbids the act| The transition's own code (`STATE_CONFLICT` or a domain code)|
| Maker-checker| The approver is the creator| `SELF_APPROVAL_FORBIDDEN`|

**The table governs every operation addressed by an identifier, whether or not its `x-error-codes` yet lists the code.** `MSC-DEC-432` declared `NOT_FOUND`, and its `404`, on the operations it touched; the rest are owed the declaration by the slice that builds each, and until then **this table is the rule and the operation's list is not**: an implementation answers `404` `NOT_FOUND` for a nonexistent record — and, to a Vendor or a Rider looking up another party's record, for that record too — on every one of them.

**Why three of these are one code outward.** A Vendor or Rider who could tell *someone else's* from *nonexistent* could enumerate another party's records by trying identifiers, and the specification forbids it for exactly those two principals (§43.2, §19.2). Ordinary authenticated staff are not told less than they need: a Senior Ops member who is refused a record outside their hub is told so, which is what lets them route it. `PERMISSION_DENIED`, `INSUFFICIENT_AUTHORITY` and `HUB_SCOPE_VIOLATION` stay distinct because they are different bugs with different fixes, and `OWNERSHIP_VIOLATION` is withdrawn (§5.9) because under this table nothing is ever told *this record is someone else's*.

## 5. Domain failure codes

Harvested from every transition table in [state-machines.md](state-machines.md) and extended since by the operations that raise them; derive any total from the current catalogue.

### 5.1 `pickup`

| Code| Raised when|
|---|---|
| `PICKUP_MINIMUM_NOT_MET`| Fewer than two packages without an approved one-package exception (§35.2.3)|
| `EXCEPTION_NOT_AVAILABLE_TO_SELF_SERVICE`| A vendor account attempts the one-package path, which is Ops-only (§35.2.4)|
| `SERVICE_DATE_NOT_PERMITTED`| Service date falls outside the Monday–Saturday calendar (§21.1, `MSC-DEC-149`)|
| `ZONE_NOT_SERVICED_ON_DATE`| The pickup zone does not operate on the requested date (§35.2.5)|

| `SENDER_SUSPENDED`| The vendor or sender is suspended|
| `PICKUP_ATTEMPT_LIMIT_REACHED`| `MELARC_MAX_PICKUP_ATTEMPTS` reached without a force-extension (§35.4.5)|
| `SELF_CANCEL_NOT_PERMITTED_AFTER_ASSIGNMENT`| **DORMANT IN V1.** A vendor attempting to self-cancel after rider assignment. `MSC-DEC-196` defers vendor self-cancellation of confirmed requests entirely, so in V1 the refusal is `PERMISSION_DENIED` — the vendor holds no such permission. Retained, not withdrawn: this code governs the path when self-service is re-enabled|
| `NO_REGISTERED_NUMBER`| SMS handshake fallback attempted for a vendor with no registered number|
| `SMS_FALLBACK_LIMIT_REACHED`| **CRIT-08 audit remediation.** `sms_fallback_max_per_pickup` reached, or `sms_fallback_cooldown_seconds` not yet elapsed since the last send, for this `PickupStop`'s handshake. A rider hitting this needs Fallback 2 (`authoriseHandshakeOverride`), not another SMS|
| `REPLACEMENT_REQUIRED`| A reschedule was attempted without creating the replacement in the same command (§35.4.3)|
| `SOURCE_STILL_ACTIVE`| A replacement would run concurrently with its source (§35.4.4)|
| `MANIFEST_EMPTY`| Dispatch attempted with no stops|
| `RIDER_UNAVAILABLE`| Assigned rider is not eligible or active|
| `NO_SERVICEABLE_MOTORCYCLE`| Rider has no functioning assigned motorcycle (§34.10)|
| `MANIFEST_NOT_STARTED`| A stop action was attempted before the run started. **Serves both `PickupStop` and `DeliveryStop`** — the name is pickup-flavoured, the condition is not|
| `RUN_ALREADY_STARTED`| Manifest cancellation attempted after execution began|
| `NOT_CUSTODY_HOLDER`| Run completion or hub handover attempted by someone who does not hold the run's parcels (§36.14, `MSC-DEC-246`). **Distinct from `NOT_ASSIGNED_RIDER`** — after a `RunCustodyHandover` the assigned rider is precisely the person who may **no longer** act, so the two can be true of opposite actors on the same run|
| `NOT_ASSIGNED_RIDER`| A rider acted on work assigned to someone else (§35.3.5)|
| `STOPS_UNRESOLVED`| Run completion attempted with stops not in a terminal state|
| `ZERO_COLLECTION_IS_FAILURE`| A stop was marked collected with a zero count (§36.4)|
| `HANDSHAKE_NOT_VERIFIED`| Collection closed before the two-party handshake verified (§35.3.7)|
| `NO_CHARGE_APPLIED`| Added by `MSC-DEC-240` for `waiveCancellationCharge`. A cancellation-charge waiver was attempted where no charge was applied — the outcome was `UNAVAILABLE` or `NOT_APPLIED` (§21.6, `MSC-DEC-197`). **There is nothing to waive, and a waiver recorded against no charge would corrupt the waiver-frequency data that makes the discretionary charge auditable**|
| `SERVICE_WINDOW_OVERRIDE_REASON_REQUIRED`| Service was scheduled outside the customer service window without the mandatory override reason|
| `PARCEL_NOT_ACCEPTABLE`| The parcel's size, shape, weight distribution, packaging or physical form makes it unsafe or impractical for motorcycle handling. **A transport-safety refusal, never a pricing outcome**|
| `SINGLE_PACKAGE_APPROVAL_REQUIRED`| A one-package pickup was submitted without an approval from a holder of `pickup.exception.approve` (`MSC-DEC-333`, which widens that key off `P only`). **The approved single-package fee becomes due on acceptance**|

### 5.2 `handshake`

| Code| Raised when|
|---|---|
| `COLLECTION_NOT_RECORDED`| Code generation attempted before collection was recorded|
| `DELIVERY_CHANNEL_FAILED`| The SMS or in-app channel could not deliver the code|
| `CODE_INVALID`| Submitted code does not match|
| `CODE_EXPIRED`| Past `handshake_code_ttl_minutes`|
| `ATTEMPTS_EXHAUSTED`| Past `handshake_max_wrong_attempts`|

### 5.3 `hub`

| Code| Raised when|
|---|---|
| `BLIND_COUNT_VIOLATED`| The declared count was served on read, or accepted on write, before the physical count committed (§35.5.2)|
| `PARITY_NOT_MET`| Itemized count does not reconcile to the authoritative hub count. **`PAYMENT_REQUIRED` orders count toward parity** (§35.6.11)|
| `ORDER_UNPRICED`| Intake close attempted with an unpriced order|

### 5.4 `pricing` and commercial

| Code| Raised when|
|---|---|
| `ALLOWANCE_DISABLED`| Credit reservation attempted with account allowance disabled|
| `ACCOUNT_OVERDUE`| Credit reservation attempted on an overdue account|
| `CREDIT_LIMIT_EXCEEDED`| Amount exceeds available global-limit exposure|
| ~~`PARTIAL_PAYMENT_NOT_SUPPORTED`~~| **Withdrawn 4 September 2026 at Gate C C1.9** — see §5.9. It refused a short tender; **no current workflow refuses one**. A confirmed short payment is preserved as a `PaymentReceipt` that settles no line, on every method and for every payer, and the gate it fails to open reports `PAYMENT_AMOUNT_MISMATCH` or `RECIPIENT_PAYMENT_OUTSTANDING`. *Original entry:* less than the full amount was tendered; ordinary `PART_PAID` does not exist (§36.11)|
| `COMMITMENT_SOURCE_UNRESOLVED`| Itemization could not resolve a successful pickup-custody timestamp from the `CollectionRecord` → `PickupStop` → `PickupManifest` lineage, so the order's initial `DeliveryCommitment` cannot be written. **The Order is not created either** — an Order without its initial commitment is not a state itemization may leave behind|
| `DESTINATION_UNRESOLVED`| A `COLLECT_FOR_VENDOR` pickup supplied no destination and the Vendor has no default saved location. *Collect this from X* with nowhere to take it is not an executable instruction|
| `SENDER_IDENTITY_AMBIGUOUS`| An `ADHOC_SENDER` request supplied **both** an existing `ad_hoc_sender_id` and `new_ad_hoc_sender`, or **neither**|
| `REASON_NOT_ACTIVE`| The selected reason code is unknown, **inactive**, or belongs to another reason domain. **Distinct from `REASON_REQUIRED`**, which means none was supplied|
| `ROAD_EXPENSE_ALREADY_APPLIED`| The expense already names a cash handover and cannot reduce a second. **Distinct from `ROAD_EXPENSE_NOT_APPROVED`**: this one is approved and already spent|
| `ROAD_EXPENSE_NOT_APPROVED`| A road expense was relied on to reduce a rider's expected cash handover while **claimed, rejected or unresolved**. Unresolved is treated as not-approved: otherwise the control could be bypassed by not deciding|
| `CASH_HANDOVER_VARIANCE`| The Hub-counted amount differs from the system-calculated expected handover. **The expected total is never edited to match the count** — the variance is the record|
| `PAYMENT_NOT_CONFIRMED`| The provider has not returned `SUCCEEDED`. Backend confirmation is required (§35.8.2)|
| `FINANCIAL_CLOSURE_INCOMPLETE`| Terminal closure attempted with money uncollected, unreconciled, unwaived and unreversed (§13.2)|
| `PERIOD_NOT_RECONCILED`| A requested hub-day has no closed `HubCashReconciliation`. **Canonical exports are final-period only** — an open day's figures are still moving|
| `EXPORT_RETENTION_NOT_CONFIGURED`| `accounting_export_file_retention_days` holds no value, so `file_available_until` cannot be computed. **Generation refuses rather than putting a file into the world with no stated lifetime.** `OQ-130`|
| `EXPORT_SOURCE_NOT_EVENT_COMPLETE`| At least one canonical record type is `CREATION_ONLY`, so the package could not carry that type's post-creation transitions. **Distinct from the retention code on purpose**: a caller must be able to tell whether it waits on `OQ-130`'s figure or `OQ-131`'s remediation|
| `EXPORT_FILE_EXPIRED`| The package passed `file_available_until`. **The export record remains readable** — `getAccountingExport` still returns scope, period, row counts and manifest digest, because the fact that the export happened is permanent|
| `INVALID_CREDENTIALS`| Sign-in failed. **Returned identically for an unknown account, a wrong password and a suspended account** — distinguishing them confirms which addresses are real staff (§37.1, §37.7). It is **also** the answer to a **staff** sign-in during a lockout, to a **vendor** sign-in from a browser that is not registered to the account, and to a **rider** whose phone and device proof were accepted but whose PIN is wrong or whose status is not `ACTIVE` — none of which may reveal which factor failed|
| ~~`WRONG_HUB`~~| **Withdrawn 21 August — it duplicated `HUB_SCOPE_VIOLATION`**, which has existed since v0.1 and says the same thing. Added on 20 August by an author who did not check whether the concept already had a code. Use `HUB_SCOPE_VIOLATION`|
| `MFA_REQUIRED`| **A sign-in challenge**, not an action refusal. Returned mid-sign-in to a Senior Ops or Platform Admin who must present a second factor (§37.2, `MSC-DEC-228`). **Never returned from a business operation** — a session that exists is already privileged to whatever its bundle allows|
| `SESSION_SUPERSEDED`| The session was ended by a newer login on another device. Expected behaviour for the shared vendor credential, not an error state (§11.2, §37.2)|
| `RATE_LIMITED`| Per-credential ceiling exceeded|
| `RECOVERY_TOKEN_INVALID`| A recovery token was rejected. **Returned identically for a malformed token, an expired one and one already consumed** — the same non-disclosure posture as `INVALID_CREDENTIALS`, for the same reason. The contract calls a reused token *“a signal, not a retry”*; **that signal belongs in the audit trail, not in the response**, where it would tell an attacker their stolen link had already been used|
| `NO_PRICING_CHANGE`| Repricing requested for a correction that changes neither service area nor commercial mode (§35.6.8, `MSC-DEC-207`). **Renamed from `NO_ZONE_CHANGE`**, which named a condition that no longer determines price|
| `CORRIDOR_DAY_NOT_PERMITTED`| A corridor delivery was requested for a day with no batch run and no off-day fee configured for that hub|
| `SIZE_CLASS_REQUIRED`| Pricing attempted before the receiving officer selected a size class|
| `CARRIER_COST_REQUIRED`| Pricing attempted on a `MELARC_COVERED_THIRD_PARTY_DELIVERY` order with no captured carrier cost|
| `MARGIN_NOT_CONFIGURED`| Outside-Accra pricing attempted while the hub's `outside_accra_margin` is unset. **The order is refused, not priced at cost** (§33.4). Accra is set at GH₵30; **this code stays live because §33.4 forbids inheritance**, so every new hub reaches it until its own margin is entered|
| `VALUE_DECLARATION_REQUIRED`| Declared value exceeds `value_declaration_threshold` and no declaration was captured at booking|
| `NOTIFICATION_FAILED`| Repricing could not notify affected parties — the notification is part of the rule|
| `SELF_APPROVAL_FORBIDDEN`| The approver is the record's creator (§37.4, `MSC-DEC-135`)|
| `INSUFFICIENT_AUTHORITY`| **The actor holds the operation's key, but this target or state needs a higher tier than the actor's bundle holds** — a privileged bundle submitted to a Senior Ops approver, or a Senior Ops session asking for a staff or vendor session it may not revoke. **A missing key is `PERMISSION_DENIED`, never this**, so an Ops Staff member calling a Senior Ops operation is `PERMISSION_DENIED`|
| `REASON_REQUIRED`| A mandatory reason, or a field the reason's metadata makes mandatory, is absent (§35.9.2)|

### 5.5 `dispatch`, `delivery`, `returns`

| Code| Raised when|
|---|---|
| `RECIPIENT_NOT_CONFIRMED`| Doorstep dispatch attempted before recipient confirmation (§35.7.1)|
| `ORDER_NOT_COMMERCIALLY_CLEARED`| Dispatch readiness attempted with the commercial gate unsatisfied — `commercial_state` not one of `CREDIT_RESERVED`, `PREPAID` or `NO_VENDOR_CHARGE`|
| `OUTBOUND_CHARGE_UNPAID`| Outbound **clearance** or dispatch attempted before the Station Drop fee or combined covered charge is backend-confirmed paid (§35.7.7–8) — `clearOutboundForDispatch` refuses first, and dispatch revalidates. **Distinct from the credit gate**|
| `RECIPIENT_PAYMENT_OUTSTANDING`| Delivery closure or OTP dispatch attempted while the recipient's `OperationalPaymentDemand` is **not `SETTLED`** (§35.8.2, `MSC-DEC-362`). **A partially funded demand is outstanding**, however real the GH₵50 already received — a receipt is not settlement, and neither is an attempt succeeding|
| `PAYMENT_ALREADY_SETTLED`| Collection was requested against an obligation **already settled** — by an earlier attempt or an approved fallback. It is refused rather than creating a second debit|
| `FALLBACK_REQUIRES_AUTHORIZATION`| Merchant MoMo or cash was attempted while a provider collection is **unresolved** — `CREATED`, `PENDING` or `STATUS_UNKNOWN`. The customer may already have been debited. **Authorised Ops may proceed through the duplicate-risk exception**, with a reason and an explicit risk acknowledgement; **a Rider never can**|
| `PAYMENT_ALREADY_PENDING`| A collection was requested while **another unresolved attempt exists** for the same obligation. One at a time — a second prompt is a second debit|
| `PAYMENT_PROVIDER_UNAVAILABLE`| The provider could not accept the request. **The obligation is untouched** and an approved fallback may be offered|
| `PAYMENT_STATUS_UNKNOWN`| **A retry was refused because the previous attempt's outcome is unknown** — transmitted, unanswered. **A timeout is not a failure**, and this is the condition under which retrying debits a customer twice|
| `PAYMENT_AMOUNT_MISMATCH`| **A settlement outcome, not a denial that money arrived**. The confirmed principal did not equal the demand's frozen total, or the currency did not match. **The `PaymentReceipt` is still created at the amount that actually arrived** — a provider that authoritatively transferred GH₵50 against GH₵55 transferred GH₵50, and refusing the receipt would delete a real payment for being the wrong size. What this code carries is the **operational exception**: no line settles, the demand is partially funded, **handover is blocked**, and the next collection asks for the remainder. **It never appears as a guard failure on provider success**|
| `PAYMENT_COLLECTION_NOT_ALLOWED`| The actor, the stop state or the obligation does not permit collection — an unassigned stop, an out-of-scope hub, or nothing outstanding|
| `OTP_INVALID`| Delivery or return closure attempted without a valid OTP **and without an authorised Ops verification fallback** (§35.8.1, §35.8.9, `MSC-DEC-326`)|
| `DOORSTEP_WAIT_NOT_ELAPSED`| A physical delivery attempt was marked failed **before the controlled doorstep wait expired**. The guard reads server time; a client-supplied elapsed claim is not accepted|
| `REASON_NOT_VALID_FOR_CHECKPOINT`| The selected reason is not valid for this recipient-contact checkpoint. A `PRE_DISPATCH` reason is not selectable at a doorstep|
| `STOP_NOT_QUALIFYING`| A redelivery was scheduled against a `DeliveryStop` that is **not a qualifying failed physical delivery attempt**. A stop skipped at `NEXT_STOP` or held at `PRE_DISPATCH` never reached a door|
| `PARCEL_NOT_IN_HUB_CUSTODY`| A redelivery was scheduled for a parcel not under controlled hub custody. Melarc cannot commit a trip for goods it is not holding|
| `DISPATCH_NOT_CLEARED`| A parcel was included in a finalised physical load while its `PRE_DISPATCH` checkpoint was unresolved or failed. **Assigned to a run is not cleared to leave the hub**|
| `VERIFICATION_FALLBACK_NOT_AUTHORIZED`| A handover was attempted under the OTP/verification fallback **without an authorised Ops authorisation**. **Distinct from `OTP_INVALID`**, which means the code was wrong; this means the *bypass* was not granted|
| `FALLBACK_AUTHORIZATION_ALREADY_CONSUMED`| The Ops duplicate-risk grant has **already been spent** by an earlier fallback receipt. **One authorisation permits one settlement.** Reusing it is how the same authorised exception settles twice|
| `FALLBACK_AUTHORIZATION_SUPERSEDED`| **The condition the grant was issued for no longer exists**. The provider attempt resolved — to `SUCCEEDED`, so the money arrived; or to `FAILED`, `EXPIRED` or `CANCELLED`, so the duplicate risk is gone and **ordinary fallback rules apply** — or the demand was settled or voided. **A stale duplicate-risk grant must never take a second full payment**, and it is not reusable as ordinary authority|
| `FALLBACK_AUTHORIZATION_METHOD_MISMATCH`| The grant authorises a **different method** — a `CASH` authorisation cannot settle a Merchant MoMo payment, or the reverse. **The fallback taken must be the fallback authorised**|
| `FALLBACK_AUTHORIZATION_DEMAND_MISMATCH`| The grant belongs to a **different `OperationalPaymentDemand`**. An authorisation for one customer's obligation may not settle another's|
| `PAYMENT_FALLBACK_NOT_VERIFIED`| A fallback payment — Merchant MoMo or other approved method — was asserted but **not independently confirmed**. A screenshot is not proof. **Distinct from `PAYMENT_NOT_CONFIRMED`**, which is the integrated provider not yet returning `SUCCEEDED`|
| `COMMITMENT_REASON_REQUIRED`| A committed delivery date or window was revised without an attribution reason. The old value, the new value, the requester, the approver, the reason and the timestamp are all mandatory|
| `ORDER_NOT_ON_RUN`| An order was named on a parcel custody return that **carries no stop on that run**, or whose run answers to a different hub (`MSC-DEC-408`, `OQ-129` R1). **A rider hands back what they carried, not what they can name**|
| `CUSTODY_NOT_RETURNED`| A failed attempt was closed without returning custody to the hub. **No rider overnight hold exists** (§35.8.7)|
| ~~`DELIVERY_ATTEMPT_LIMIT_REACHED`~~| **Withdrawn 4 September 2026 at Gate C C1.9** — see §5.9. **No current Product rule caps physical delivery attempts**; each further trip is a scheduled `Redelivery` and formal Return is a deliberate Ops act. Removed from `failDeliveryStop` and from the `Error` enum. *Original entry:* reattempt attempted after the physical delivery attempt limit was reached (§35.8.6)|
| `RETURN_FEE_OUTSTANDING`| Return handover attempted with the fee gate unsatisfied (§35.8.9)|
| `HANDOFF_NOT_RECORDED`| Carrier state claimed without a recorded handoff|
| `CARRIER_NOT_APPROVED`| **Handoff to a carrier approved in neither mode** (§35.7.9). **Version 1 permits two**: a **registered** active courier or station on §24.7's register, and an **approved informal driver/agent**. **It refuses two distinct cases, and both are named because a single sentence hid them**: a `REGISTERED` capture whose `courier_provider_id` is **absent or inactive** on §24.7's register, and an `APPROVED_AGENT` capture whose agent is **not validly approved** under the informal-agent rules. **Neither mode permits an unapproved third party to receive custody**. A declared mode whose own required identity is missing is `VALIDATION_FAILED` rather than an implicit switch to the other mode. **Enforceable in both modes from `MSC-DEC-417`**, which closed `OQ-133`: a provider is approved while `ACTIVE` on the platform-wide register, and an agent while `ACTIVE` in the rider's hub's approved-agent register with a stored identity photo.|
| `WAYBILL_REQUIRED`| Registered handoff without a waybill. **This entry was already right and the enforcement was not**: `state-machines.md` §10's guard and `CarrierHandoffCapture`'s required list demanded a waybill of **every** handoff until `MSC-DEC-413` scoped both to the registered mode, where §24.7.3 and §35.9(9) put it|
| `EVIDENCE_REQUIRED`| **A handoff in either mode without the mandatory receipt or handoff photo** (§34.5) — `MSC-DEC-413` made evidence mandatory in both, and in the agent mode the photo stands in for the waybill.|
| `TERMINAL_FOR_STATION_DROP`| An outcome update was attempted after `HANDED_OVER` on a Station Drop order, where handoff is terminal. **`recordHandoffOutcome` refuses it**|

**One hundred and twenty live codes, derived from the contract's `Error` enum rather than restated here** — three added and one withdrawn on 2 October 2026: `NOT_FOUND`, `CREDENTIAL_LOCKED` and `CREDENTIAL_DELIVERY_FAILED` in; `OWNERSHIP_VIOLATION` out.

**`DEVICE_NOT_REGISTERED` was withdrawn by R1.2** — a synonym of `DEVICE_NOT_ENROLLED` that no operation ever returned. **Three more were added by R1** — `CHALLENGE_EXPIRED`, `CHALLENGE_UNUSABLE` and `CSRF_VALIDATION_FAILED`, none of which the catalogue could express. **Five were added by Gate A and one was relocated.** `MFA_ENROLMENT_REQUIRED` guarded bundle assignment, which `MSC-DEC-259` established it was never true of; it moved to §5.8 rather than being duplicated there, and the count above is derived rather than restated.

**Dormant is a third state, distinct from active and withdrawn.** A withdrawn code encodes a rule that no longer exists and never returns. A dormant code encodes a rule that exists and is currently unreachable because the path invoking it is deferred. Withdrawing a dormant code would destroy reasoning that `MSC-DEC-196` explicitly ordered preserved.

### 5.6 `staff` and `permission`

Added 24 August by `MSC-DEC-247`. **Two codes only** — the rest of the identity path reuses what exists.

| Code| Raised when|
|---|---|
| `WORK_EMAIL_IN_USE`| A staff profile is created against a work email already held by another identity. Unique **and** the recovery channel ([domain-model.md](domain-model.md) §6.8, §37.2), so a collision is an identity fault rather than a format one|

**`MFA_ENROLMENT_REQUIRED` moved to §5.8 on 26 August**. It was defined here to refuse a **privileged bundle assignment** without MFA — a rule that could not be satisfied, because a new employee cannot enrol a factor before authenticating. The code was never wrong; **the act it guarded was**. It now refuses a privileged **session**.

**Four refusals on this path reuse existing codes**, and that is the point of listing them:

| Refusal| Code| Why not a new one|
|---|---|---|
| The creator tried to approve their own profile| `SELF_APPROVAL_FORBIDDEN`| The same-actor exclusion is **one uniform rule** — §11.6, `MSC-DEC-135`. `approveOnePackageException` already returns this code. A second name would put two vocabularies on one constraint|
| A Senior Ops tried to approve a privileged bundle| `INSUFFICIENT_AUTHORITY`| The actor holds the key and not the standing. Exactly what this code means everywhere else|
| A rejection or suspension arrived without grounds| `REASON_REQUIRED`| §30.9's four grounds categories are reason metadata (§35.9.2), not a new mechanism|
| The record was not in the expected state| `STATE_CONFLICT`| §36.1, unchanged|

### 5.7 `evidence`

Added 24 August by `MSC-DEC-251`. **Two codes**, both guarding the same thing: that a declared evidence record is not the same as a stored one.

| Code| Raised when|
|---|---|
| `EVIDENCE_NOT_STORED`| **The operation requires a referenced Evidence record to be `STORED`, and a referenced record is not** — declared, but with no bytes behind it|
| `EVIDENCE_UPLOAD_EXPIRED`| Upload completion attempted after the instruction's `expires_at`|

**Applicability — `EVIDENCE_NOT_STORED`.** The condition is one rule; these are the shapes of reference it currently covers, and the list is what makes the coverage checkable rather than assumed.

<!-- ERROR-APPLICABILITY:EVIDENCE_NOT_STORED:BEGIN -->

| Reference shape| Operations|
|---|---|
| An `evidence_ids` **collection**, where any referenced record is not `STORED`| every operation accepting `evidence_ids` — currently `adjudicateDiscrepancy` (HIGH-11 audit remediation, 13 September 2026)|
| A **single targeted** Evidence resource that is not `STORED`| `createEvidenceRetrievalAuthorization`|
| A **single referenced** Evidence record named in a request body, that is not `STORED`| `approveAgent` — the agent's identity photo|

<!-- ERROR-APPLICABILITY:EVIDENCE_NOT_STORED:END -->

**The definition was narrower than the code's own meaning, and that is the defect R1.2 corrects.** *An `evidence_ids` array names a record that is not `STORED`* described the only reference shape that existed on 24 August. `MSC-DEC-291` then wrote a retrieval authorization that targets **one** record and declares the same code — correctly, because the condition is identical — while the catalogue still described a collection. **A contract that declares a code whose canonical condition does not cover the operation is inconsistent with itself**, and contract-consistency validation could not see it: it verified the code **exists**, not that the definition **reaches**.

**Generalising is the right repair and a second code is not.** The outward condition is one thing — *the evidence you referenced has no bytes behind it* — and a client's response to it is the same in both shapes. §5.9 records `DEVICE_NOT_REGISTERED` being withdrawn for exactly this: two names for one outward condition means clients branch on whichever they met first.

**`EVIDENCE_NOT_STORED` is the one that carries the weight.** `EVIDENCE_REQUIRED` has existed since v0.1 and asks *"was evidence attached?"* — a question a `PENDING_UPLOAD` record answers **yes** to. Without the second code, `AC-SLICE-001-42`'s *"damaged and tampered require evidence"* is satisfiable by creating a record and never uploading anything. **The two codes are not redundant: one checks presence, the other checks substance.**

### 5.8 `session`, `setup` and `mfa`

Added 26 August by Gate A.

| Code| Raised when|
|---|---|
| `SESSION_INVALID`| **No usable authenticated session** — missing, malformed, unknown, expired or terminated. The generic `401` code, and the contract had none|
| `SETUP_GRANT_INVALID`| A setup grant is unknown, expired, already consumed, superseded, or presented for a purpose or principal it was not issued for|
| `MFA_ENROLMENT_REQUIRED`| A **privileged session** was requested for an identity with no `ACTIVE` MFA factor|
| `MFA_PROOF_INVALID`| The submitted TOTP code is wrong, outside its window, or **already used within it**|
| `DEVICE_PROOF_INVALID`| **The rider sign-in's device proof could not be accepted**: the signature over the challenge does not verify against the sole `ACTIVE` device's registered public key — **or** no device proof can be checked because the phone is unknown or the rider has no `ACTIVE` device **and the PIN was not proven**. One answer for all of them, so that the response reveals nothing about which. **It does not cover an expired or consumed challenge** — those are `CHALLENGE_EXPIRED` and `CHALLENGE_UNUSABLE` — and a failure here **never counts toward a lockout**|
| `DEVICE_INTEGRITY_FAILED`| **At first enrolment or replacement, the required device-key attestation evidence was supplied and evaluated and failed policy** — the certificate chain, the trust root, revocation, the challenge, the application identity, the device's lock or boot state, or the binding of the attested key to the key being registered. **Distinct from `DEVICE_PROOF_INVALID`**, which is a failed signature over a challenge, and from `DEVICE_SECURITY_UNSUPPORTED`, which is a missing capability: one says *the key did not prove itself*, one says *the evidence would not vouch for the device*, one says *the device cannot offer the evidence*. **Never returned at sign-in, where no attestation is evaluated, and never for unavailable trust data, which is `TRUST_DATA_UNAVAILABLE`.** No integrity signal refuses an operation from a rider already holding custody.|
| `DEVICE_SECURITY_UNSUPPORTED`| **The handset cannot satisfy the minimum security capability production Rider enrolment or replacement requires** — its attestation shows a key below `TrustedEnvironment` security, so it cannot hold a hardware-backed key. **Distinct from `DEVICE_INTEGRITY_FAILED`**: here the device lacks the capability; there, evidence was supplied and failed policy. Returned at enrolment and replacement only|
| `DEVICE_NOT_ENROLLED`| **A rider who has proved their phone and PIN has no `ACTIVE` registered device** — the device was revoked and not replaced. A rider who never enrolled holds no PIN to prove and is `DEVICE_PROOF_INVALID`. **Returned only after the PIN is proven**, so it discloses nothing to a caller who knows only a phone number (`MSC-DEC-430`, Gate PD-3R1)|
| `CHALLENGE_EXPIRED`| An MFA or rider sign-in challenge **existed and is outside its validity window** — past `authentication_challenge_ttl_minutes`|
| `CHALLENGE_UNUSABLE`| The challenge **exists and has already been consumed, superseded, revoked or otherwise made unusable**, or its attempts are exhausted at `mfa_max_attempts`. **Distinct from expiry** — this one will never accept anything|
| `CSRF_VALIDATION_FAILED`| A cookie-authenticated unsafe request carried a missing, malformed or non-matching `X-CSRF-Token`, or failed `Origin` validation|
| `CREDENTIAL_LOCKED`| **A credential's failed-attempt threshold was reached and the credential is locked** (`signin_max_attempts`, `signin_lockout_minutes`; `MSC-DEC-431`). **Returned only to a request that has already reached the credential's factor** — a vendor request from a registered browser, a rider request carrying a valid device signature, or a staff request holding a live MFA challenge — **never to one that has not**, so it cannot be used to learn that an account exists or which factor an attacker should attack. A staff **password** sign-in during a lockout is deliberately `INVALID_CREDENTIALS`, because no earlier factor gates it. **It is not `ATTEMPTS_EXHAUSTED`**, which is bound to `handshake_max_wrong_attempts`|
| `CREDENTIAL_DELIVERY_FAILED`| **A setup grant, a vendor device grant, an MFA re-enrolment grant or an administrator-initiated recovery link could not be handed to its delivery channel** (`SECURITY_DESIGN.md` §13.9a, `PDA-54`; **the two rider device grants are returned in the response, are not messages and never produce it**). **The issuing act is rolled back: no grant exists and an earlier pending grant is untouched**, nothing was sent, and the caller may issue again. **Never returned by `requestCredentialRecovery`**, which answers `202` identically whether or not a message was sent — a failure there rolls the request back, is logged and counted by the provider-failure alert, and is not disclosed|
| `TRUST_DATA_UNAVAILABLE`| **The verifier cannot evaluate a handset's key attestation because the trust data it needs is not usable** (`MSC-DEC-437`, Gate PD-3R2; **confirmed by the Product Owner at Gate PD-3R3, `MSC-DEC-441`**): the accepted roots or Google's revocation list are older than the 24-hour maximum, **this instance has not loaded them yet**, or the roots could not be loaded. **`503` with a `Retry-After`, retryable, and the grant is still good**: nothing is written and nothing is consumed. **Returned by `completeRiderDeviceEnrolment` and by nothing else** — sign-in, sessions and every other operation never read trust data. **Not `DEVICE_INTEGRITY_FAILED`** (evidence evaluated and failed policy) **and not `DEVICE_SECURITY_UNSUPPORTED`** (capability missing): nothing is known to be wrong with the device|

**`SESSION_INVALID` is deliberately undifferentiated.** Missing, expired and terminated sessions return the same code: distinguishing them outward tells an unauthenticated caller which of its guesses was closest. The **audit** record keeps the precise cause, which is §5.4 of [audit.md](audit.md)'s asymmetry — undifferentiated outward, precise inward.

**`SESSION_SUPERSEDED` stays separate from it**, and only that one. §37.2 makes vendor displacement **deliberate product behaviour** the client must recognise: a colleague signing in elsewhere is routine on a shared credential, and *"your session expired"* invites a support call about a system working as designed.

**`MFA_ENROLMENT_REQUIRED` moved rather than being added.** It previously guarded **bundle assignment** — the circularity `MSC-DEC-259` removed — and now guards the only thing it was ever true of: **issuing a privileged session**. It is not `MFA_REQUIRED`, which [state-machines.md](state-machines.md) §13 reserves for the sign-in challenge itself.

**`CHALLENGE_EXPIRED` and `CHALLENGE_UNUSABLE` are deliberately separate, and they are not the handshake's codes either.** `CODE_EXPIRED` and `ATTEMPTS_EXHAUSTED` at §5.2 are bound by definition to `handshake_code_ttl_minutes` and `handshake_max_wrong_attempts`; reusing them here would make one code mean two mechanisms with two settings — the mirror of the `WRONG_HUB` duplication §5.9 records. And the two new codes differ from each other in what the user should do next: **expired says start again; unusable says this one is finished.**

**`DEVICE_PROOF_INVALID` is not `DEVICE_NOT_ENROLLED`, and the order they are decided in is the rule.** The server first looks for a device proof it can check: a rider with an `ACTIVE` device is held to a valid signature, and failing it is `DEVICE_PROOF_INVALID` before the PIN is ever looked at. A phone that is unknown, or a rider with no `ACTIVE` device, offers no proof to check, so the PIN is decided instead — wrong is `DEVICE_PROOF_INVALID` (uniform with the unknown phone), right is `DEVICE_NOT_ENROLLED`. Collapsing them would hide a failed cryptographic proof — the signal that matters — inside an ordinary enrolment gap, and answering `DEVICE_NOT_ENROLLED` before the PIN would tell anyone holding a phone number whether that rider has a device.

**`CREDENTIAL_LOCKED` is a third mechanism and has its own code** for the reason the challenge codes do: `ATTEMPTS_EXHAUSTED` is the handshake's, tied to `handshake_max_wrong_attempts`, and reusing it would make one code mean two mechanisms with two settings. The lockout codes' rule is in [SECURITY_DESIGN.md](../architecture/SECURITY_DESIGN.md) §13.4b: a failed attempt counts, and a lock is announced, only after the request has reached the credential factor.

**`TRUST_DATA_UNAVAILABLE` exists because the accepted parameter named a failure the catalogue did not have.** `MSC-DEC-437` accepted that past the maximum age enrolment *fails closed with the existing retryable service failure*. The repository declared no `5xx` code or response, and `SECURITY_DESIGN.md` §15.3 says an infrastructure outage is answered `503` *by the platform, outside the operation contract* — so the only available reading made stale trust data indistinguishable from an outage, and a handset could not know that the grant it held was still good. It is the contract's only declared `5xx`. A client that receives it retries **the same enrolment** after the `Retry-After`; it never treats it as a verdict on the device. **The Product Owner confirmed it at Gate PD-3R3** as a provider-neutral, retryable `503` that names no provider and no list, consumes and writes nothing, leaves the `SetupGrant` usable, and stays distinct from `DEVICE_INTEGRITY_FAILED` and `DEVICE_SECURITY_UNSUPPORTED`.

**Three codes for three device conditions, and the challenge codes are not among them**: `DEVICE_PROOF_INVALID` — the key did not prove itself; `DEVICE_INTEGRITY_FAILED` — the attestation evidence failed policy at enrolment or replacement; `DEVICE_SECURITY_UNSUPPORTED` — the handset cannot offer the capability. **An expired or consumed challenge is `CHALLENGE_EXPIRED` or `CHALLENGE_UNUSABLE` and is never `DEVICE_PROOF_INVALID`** — until 1 October 2026 the older code's own definition said it was, which `riderSignIn` declaring all three made ambiguous.

**And neither is `DEVICE_INTEGRITY_FAILED`**. `SECURITY_DESIGN.md` §15.2 had a forged or missing platform integrity token returning `DEVICE_PROOF_INVALID`, which is the same collapse the paragraph above forbids, one layer out: **a cryptographic proof failure and a platform attestation failure need opposite responses** — re-enrol the device, or investigate the handset — and an operator reading one code cannot tell which happened. The three are now distinct: **no device** (`DEVICE_NOT_ENROLLED`), **the key did not prove itself** (`DEVICE_PROOF_INVALID`), **the platform would not vouch for the device** (`DEVICE_INTEGRITY_FAILED`).

### 5.9 Withdrawn

| Code| Withdrawn| Why|
|---|---|---|
| `BOOKING_CUTOFF_PASSED`| 17 Aug 2026| `CONFLICT-024`. §21.1 requires a late booking to confirm and queue for Ops review, not to be refused. Nothing about a late booking is an error, so no code replaces it — `cutoff_exception_state` carries the condition instead.|
| `PARTIAL_COLLECTION_NOT_PERMITTED`| 16 Aug 2026| `MSC-DEC-194` permits partial collection, so the rule this code enforced no longer exists. A short collection now requires a variance reason and returns `REASON_REQUIRED` if absent.|
| `DELIVERY_ATTEMPT_LIMIT_REACHED`| 4 Sep 2026| **A code for a rule that no longer exists.** `MSC-DEC-350` retired the fixed physical-attempt maximum on 31 August — no maximum number of redeliveries, each further trip its own Ops decision — and `MSC-DEC-332` had already made Return a deliberate act rather than a counter's consequence. The code stayed defined here as live and declared by `failDeliveryStop` through four more passes, **exposing a refusal nothing could produce**. Withdrawn rather than redefined: a code that once meant *no more attempts* must not later mean anything else to a client that remembers it. Historical references in revision histories and superseded criteria are preserved|
| `PARTIAL_PAYMENT_NOT_SUPPORTED`| 4 Sep 2026| **A refusal of money the engine preserves.** `MSC-DEC-362` makes a confirmed payment short of the total *money received that settles no line*, on every method; `MSC-DEC-365` carries that into cash custody, so a GH₵50 tender against GH₵55 is a GH₵50 receipt and GH₵50 of custody with GH₵5 still due. **No current workflow refuses partial funding** — the §8 prepayment gate and the doorstep both stay shut on a short payment without turning it away, and report that through `PAYMENT_AMOUNT_MISMATCH` and `RECIPIENT_PAYMENT_OUTSTANDING`. Withdrawn from `recordRecipientCashPayment`, from the §8 and §16.3 machines and from the `Error` enum; `MSC-DEC-250`'s short-cash clause is marked refined in part|
| `DEVICE_NOT_REGISTERED`| 27 Aug 2026| **A synonym, and the more dangerous kind: one nothing used.** `DEVICE_NOT_ENROLLED` is canonical and is what `riderSignIn` declares; this one sat in the catalogue and the `Error` enum, referenced by **no operation**, while feature prose and acceptance criteria cited it as though it were live. Two names for one outward condition means clients branch on whichever they met first|
| `WRONG_HUB`| 21 Aug 2026| **A duplicate of `HUB_SCOPE_VIOLATION`**, which has existed since v0.1 and says the same thing. Added on 20 August for `SLICE-000` by an author who did not check whether the concept already had a code. **Recorded in this table at Gate C C1.9** — until then the strike-through at §5.4 was its only record, so a reader of the withdrawn table alone could not see it (contract-consistency validation).|
| `CANCELLATION_NOT_PERMITTED_AFTER_CUSTODY`| 16 Aug 2026| `MSC-DEC-195` superseded `MSC-DEC-188` item 3. The cutoff moved from custody to rider assignment, and the meaning changed: cancellation is never barred outright, only vendor **self**-cancellation. Replaced by `SELF_CANCEL_NOT_PERMITTED_AFTER_ASSIGNMENT`. Withdrawn rather than redefined — a code that meant "cancellation refused" must not later mean "self-cancellation refused."|
| `OWNERSHIP_VIOLATION`| 2 Oct 2026| **A refusal no principal may receive.** `MSC-DEC-432`: a Vendor asking for another vendor's record and a Rider looking up one that is not theirs are answered exactly as for a record that does not exist, as the specification requires (§43.2, §19.2), and an authenticated staff member refused across hub scope is told `HUB_SCOPE_VIOLATION`. Under those rules nothing says *this record is someone else's* — yet six operations declared the code and the catalogue defined it as exactly that, a disclosure the specification forbids. Withdrawn from the `Error` enum and from `getPickupRequest`, `cancelPickupRequest`, `verifyHandshake`, `createEvidence`, `completeEvidenceUpload` and `createEvidenceRetrievalAuthorization`, which return `NOT_FOUND`. `NOT_ASSIGNED_RIDER` and `NOT_CUSTODY_HOLDER` — a rider acting on work they name — are unchanged. Historical references in revision histories and superseded criteria are preserved|

A withdrawn code is recorded rather than deleted. It never returns to service: identifiers must not be reused, and a code that once meant "refused" must not later mean something else to a client that remembers it.

## 6. Enum index

Canonical homes only. **Nothing here is redefined**; follow the link.

**A numeric count in the Values column is a closed-enum declaration.** Where a type is an extensible catalogue, this column says so — a generator that reads `5` emits a five-value enum and rejects the sixth reason an operations manager adds, which is precisely what `MSC-DEC-330` exists to prevent *(Gate C R1.2)*.

| Enum| Values| Canonical home|
|---|---|---|
| `PickupRequest.state`| 4| `state-machines.md` §3|
| `DeliveryFailureReason`| **not an enum — a controlled extensible catalogue**, **five seeded defaults**| `state-machines.md` §12.1, as amended by `MSC-DEC-330` and `MSC-DEC-343`|
| `PickupManifest.state`| 5| `state-machines.md` §4|
| `PickupStop.state`| 6| `state-machines.md` §5|
| `CollectionHandshake.state`| 8| `state-machines.md` §6|
| `PickupIntake.state`| 6| `state-machines.md` §7|
| `Order.commercial_state`| `PRICED`, `PAYMENT_REQUIRED`, `CREDIT_RESERVED`, `NO_VENDOR_CHARGE`, `PREPAID`, `CLOSED`, `REVERSED`| `state-machines.md` §8|
| `Order.fulfilment_state`| 12| `state-machines.md` §9|
| `ThirdPartyHandoff.state`| **7** — `CANCELLED` joined at `MSC-DEC-417`| `state-machines.md` §10|
| `ThirdPartyHandoff.identity_mode`| `REGISTERED`, `APPROVED_AGENT`| `domain-model.md` §6.10|
| `CourierProvider.kind`| `COURIER`, `STATION`| `domain-model.md` §6.10|
| `CourierProvider.status`| `ACTIVE`, `INACTIVE` — **approved while `ACTIVE`**| `domain-model.md` §6.10|
| `ApprovedAgent.status`| `ACTIVE`, `WITHDRAWN`| `domain-model.md` §6.10|
| `ParcelCustodyReturn.state`| 4| `state-machines.md` 12.2|
| `ParcelCustodyReturnLine.line_state`| 5| `domain-model.md` §6.10|
| `ParcelCustodyReturnLine.disposition`| 3| `domain-model.md` §6.10 — **what was decided**, not why: `RECEIVED_LATE` · `CONFIRMED_NOT_RECEIVED` · `DECLARATION_CORRECTED`|
| `RecipientConfirmation.state`| 7| `state-machines.md` §11|
| `DeliveryRun.state`| 5| `state-machines.md` §12|
| `DeliveryStop.state`| **7** — `PENDING`, `ARRIVED`, `AWAITING_RECIPIENT`, `DELIVERED`, `FAILED`, `SKIPPED`, **`HANDED_OVER`**| `state-machines.md` §12.1|
| `RiderCashCustody.state`| 6| `state-machines.md` §16.3|
| `CashHandover.state`| 4| `state-machines.md` §16.4|
| `HubCashReconciliation.state`| 4| `state-machines.md` §20.2|
| `Redelivery.status`| 4| `state-machines.md` §20.5|
| `PaymentAttempt.state`| **8** — §36.11's seven plus `STATUS_UNKNOWN`| `state-machines.md` §20.6|
| `OperationalPaymentDemand.status`| `OPEN`, `PARTIALLY_SETTLED`, `SETTLED`, `VOID`| `domain-model.md` §6.12|
| `PaymentDemandLine.status`| `OPEN`, `SETTLED`, `VOID`| `domain-model.md` §6.12|
| `PaymentReceipt.method`| `HUBTEL`, `MERCHANT_MOMO`, `CASH`| `domain-model.md` §6.12|
| `PaymentReceipt.status`| `CONFIRMED`, `REVERSED_BY_PROVIDER`| `domain-model.md` §6.12|
| `PaymentFallbackAuthorization.status`| `ACTIVE`, `CONSUMED`, `SUPERSEDED`| `domain-model.md` §6.12|
| `FinancialAdjustmentRequired.reason`| `DUPLICATE_PAYMENT`, `OVERPAYMENT`, `PAID_OBLIGATION_VOIDED`, `LATE_PROVIDER_SUCCESS_AFTER_FALLBACK`| `domain-model.md` §6.12|
| `AccountingExportStatus`| `REQUESTED` · `GENERATED` · `FAILED`| `AccountingExport.status`. **No machine** — state-machines.md §20.7|
| `AccountingExportScope`| `SINGLE_HUB` · `ALL_HUBS`| `AccountingExport.scope`. `ALL_HUBS` requires the all-hubs scope of `payment.ledger.export`|
| `RecordRepresentation`| `EVENT_COMPLETE` · `CREATION_ONLY`| Per-record-type completeness, declared in the package manifest. **`EVENT_COMPLETE` is earned per-field**, never inferred from timestamp coverage|
| Statement, vendor and fleet states — deferred| —| `state-machines.md` §14|
| `Order.lane`| `DOORSTEP`, `THIRD_PARTY_HANDOFF`| `domain-model.md` §6.7|
| `Order.commercial_mode`| `STATION_DROP`, `MELARC_COVERED_THIRD_PARTY_DELIVERY`| `domain-model.md` §6.7|
| `Order.size_class`| `SMALL`, `MEDIUM`, `LARGE`| `domain-model.md` §6.7|
| `Session.principal_type`| `STAFF`, `RIDER`, `VENDOR`| `domain-model.md` §6.8|
| `Session.state`| `ACTIVE`, `TERMINATED`| `state-machines.md` §13 — **two states**; `ELEVATED` withdrawn by `MSC-DEC-228`|
| `Session.termination_reason`| `SIGNED_OUT`, `SUPERSEDED_BY_NEW_LOGIN`, **`REPLACED_BY_NEW_SESSION`**, `EXPIRED`, `CREDENTIAL_CHANGED`, `SUSPENDED`, `OFFBOARDED`, `ADMIN_REVOKED`, `AUTHORITY_CHANGED`, `HUB_SCOPE_CHANGED`, `DEVICE_REVOKED`, **`DEVICE_REPLACED`**, `MFA_RESET` — **thirteen**| `domain-model.md` §6.8, `state-machines.md` §13|
| `StaffIdentity.status`| `PENDING_APPROVAL`, `ACTIVE`, `REJECTED`, `SUSPENDED`, `OFFBOARDED` — **five**| `domain-model.md` §6.8, `state-machines.md` §13.3|
| `RiderIdentity.status`| `ACTIVE`, `INACTIVE`, `TEMPORARILY_UNAVAILABLE`, `SUSPENDED`, `OFFBOARDED`| `domain-model.md` §6.8|
| `MfaFactor.status`| `PENDING`, `ACTIVE`, `REVOKED`| `domain-model.md` §6.8, `state-machines.md` §18|
| `SetupGrant.purpose`| `STAFF_CREDENTIAL_SETUP`, `MFA_ENROLMENT`, `MFA_REENROLMENT`, `BOOTSTRAP_SETUP`, `RIDER_DEVICE_ENROLMENT`, `RIDER_DEVICE_REREGISTRATION`, `VENDOR_CREDENTIAL_SETUP`, `VENDOR_DEVICE_ENROLMENT` — **eight**| `domain-model.md` §6.8, `state-machines.md` §19|
| `SetupGrant.state`| `PENDING`, `CONSUMED`, `EXPIRED`, `SUPERSEDED`| `state-machines.md` §19|
| `RegisteredDevice.status`| `ACTIVE`, `REPLACED`, `REVOKED`| `domain-model.md` §6.8. **`REPLACED` — superseded through the replacement workflow; `REVOKED` — explicitly invalidated by Melarc; both non-active, neither returns to `ACTIVE`**|
| `Session.client_root_signal`| `NOT_DETECTED`, `DETECTED`, `UNKNOWN` — **three**| `domain-model.md` §6.8; the value arrives in the `riderSignIn` request body (`openapi.yaml` `RiderSignIn`). A recorded risk signal, **never an authentication control**|
| `VendorOrganization.operational_status`| `CREATED_BY_OPS`, `PENDING_SENIOR_OPS_REVIEW`, `ACTIVE`, `REJECTED`, `SUSPENDED`, `TERMINATED` — **six**. **`SUSPENDED` and `TERMINATED` are reached by `suspendVendor`, `reactivateVendor` and `terminateVendor`** (`MSC-DEC-397`, `OQ-033` closed 21 September 2026); **the machine is still untabled** — `OQ-132`.| `domain-model.md` §6.16, `state-machines.md` §14|
| `VendorAccountAllowance.state`| `DISABLED_PREPAYMENT_ONLY`, `ENABLED` — **two**, both directions Platform Admin, reason mandatory| `domain-model.md` §6.16, `state-machines.md` §14|
| `VendorSuspensionHold.state`| `HELD`, `RESUMED`, `AUTHORIZED_EXCEPTION_DISPOSITION` — **three** (§36.12). **One row per held work item**, not per suspension| `domain-model.md` §6.17, `state-machines.md` §14|
| `VendorSuspensionHold.grounds`| `NON_PAYMENT_OVERDUE`, `SUSPECTED_FRAUD_OR_ABUSE`, `SAFETY_OR_LEGAL_VIOLATION`, `REPEATED_SERVICE_QUALITY_FAILURE` — **four**. §29.6 calls them *“four starting grounds categories”* — **starting, and still four**| §29.6, `MSC-DEC-168`–`169`, `domain-model.md` §6.17|

**`SetupGrant.purpose` reached eight on 20 September with `VENDOR_DEVICE_ENROLMENT`**, and the shape of the gap is worth keeping. [vendor-authentication.md](../features/identity/vendor-authentication.md) §5.5 named this value on 13 September as **CRIT-01 audit remediation**, and it existed in **no enum anywhere in the repository** — not here, not in `domain-model.md` §6.8, not in `openapi.yaml`. The two operations it gates did not exist either. **A feature document cannot add an enum value by naming one**, and nothing compared the two, so a CRITICAL finding read as closed for a week. The value belongs to `SetupGrant` rather than `RecoveryRequest` by the same test the withdrawal below applies: registering an **additional** browser **establishes** a credential the account did not have, it does not repair one it already holds.


**`REPLACED_BY_NEW_SESSION` and `SUPERSEDED_BY_NEW_LOGIN` are not interchangeable**. The vendor reason is a **user-facing business event** — a colleague displaced a colleague on a shared credential, and the displaced client is told so with `SESSION_SUPERSEDED`. The rider reason is **the same person on the same handset**, so the old token simply fails as an ordinary invalid session and no rider ever sees `SESSION_SUPERSEDED`. Two reasons because the two events differ in what the user must be told, which is the test `CHALLENGE_EXPIRED` and `CHALLENGE_UNUSABLE` were separated on.

**The identity enums above were stale and R1.1 re-derived every one of them from the model.** `Session.termination_reason` indexed **six** values against a model carrying **eleven** — the five it omitted are `OFFBOARDED`, `AUTHORITY_CHANGED`, `HUB_SCOPE_CHANGED`, `DEVICE_REVOKED` and `MFA_RESET`, which is to say **every reason Gate A added**. `StaffIdentity.status` indexed three against five, omitting `PENDING_APPROVAL` and `REJECTED` — the two states the entire maker-checker onboarding at §30.8 moves through.

**This index is what an implementation generates enums from.** A value absent here is a value the code cannot express: `MFA_RESET` was written into the `MfaFactor` machine as a session-termination effect on 26 August while the enum index could not name it, so the machine specified a transition whose consequence had no representation. `MfaFactor`, `SetupGrant` and `RegisteredDevice` had **no rows at all**.
| `ParcelHandlingAssessment`| `STANDARD_HANDLING`, `REQUIRES_REVIEW`, `NOT_ACCEPTABLE`| `MSC-DEC-303`. Transport safety. **No kilogram or dimension threshold** — inventing one would repeat the rule `MSC-DEC-302` withdrew|
| `RoadExpenseFundingSource`| `COLLECTION_CASH`, `RIDER_PERSONAL`, `COMPANY_FLOAT`| `MSC-DEC-315`. **Never mixed.** The same GH₵20 has three different cash consequences and nothing else in the record distinguishes them|
| `RoadExpenseStatus`| `CLAIMED`, `APPROVED`, `REJECTED`| `MSC-DEC-319`. **Only `APPROVED` reduces the expected handover**; `CLAIMED` leaves the cash owed|
| `CommitmentChangeReason`| `CUSTOMER_DEFERRED`, `SENDER_SCHEDULED`, `CORRIDOR_SCHEDULE`, `MELARC_DELAY`| `MSC-DEC-307`. **Attribution is what makes the date history adjudicable** — the same revision means opposite things depending on cause|
| `RecipientContactCheckpoint`| `PRE_DISPATCH`, `NEXT_STOP`, `DOORSTEP` — **three contact checkpoints, not three delivery trips**| `domain-model.md` §6.12|
| `RecipientContactActorType`| `RIDER`, `OPS` — either may perform `PRE_DISPATCH`| `domain-model.md` §6.12|
| Reason domains| `DELIVERY_FAILURE`, **`RECIPIENT_CONTACT`**, **`PICKUP_STOP_SKIP`**, **`HANDOFF_FAILURE`** — the fourth added at `MSC-DEC-417` for an outbound stop that fails at the counter, **seeded at five**: `STATION_CLOSED`, `CARRIER_REFUSED_PARCEL`, `AGENT_NOT_PRESENT`, `RECIPIENT_REJECTED_WAYBILL_PRICE`, `VEHICLE_NOT_TERMINATING_AT_DESTINATION`, **none consuming a delivery attempt**; a covered-mode third party's `FAILED` or `RETURNED` takes a `DELIVERY_FAILURE` reason instead. The third added at `MSC-DEC-412`, closing `OQ-141`, and **seeded at four**: `RUN_CUT_SHORT`, `VENDOR_REQUESTED_SKIP`, `LOCATION_INACCESSIBLE`, `STOP_RAISED_IN_ERROR`. **Not §21.5's four pickup-failure categories**, which are closed by specification and describe a different act — §5 gives `FAILED` and `SKIPPED` separate rows — **one catalogue, several domains**; a reason declares the checkpoints it is valid for, in **`valid_checkpoints`** — fielded at `MSC-DEC-407`, having been stated here and at `domain-model.md` §6.12 and carried by neither. **The `RECIPIENT_CONTACT` contents are seeded at five by `MSC-DEC-409`** — `NO_ANSWER`, `NUMBER_INCORRECT`, `RECIPIENT_DECLINED` and `CONTACT_NOT_POSSIBLE_MELARC` at all three checkpoints, **`RECIPIENT_NOT_AT_LOCATION` at `DOORSTEP` only** — **seeded defaults in a controlled catalogue, not a closed enum**| `domain-model.md` §3.9, §6.12|
| `ReasonAttribution`| `CUSTOMER`, `MELARC`, `EXTERNAL`| `MSC-DEC-309`, `MSC-DEC-330`. Drives `consumes_delivery_attempt`|
| `PickupIntent`| `OWN_PACKAGES`, `COLLECT_FOR_VENDOR`, `ADHOC_SENDER`| `MSC-DEC-335`. A known Vendor is not re-onboarded daily; a third-party collection needs a pickup point the Vendor's own address cannot supply|
| `CashDispositionMethod`| `BANK_DEPOSIT`, `MERCHANT_MOMO_TRANSFER`, `FINANCE_HANDOVER`, `SAFE_CUSTODY`| `MSC-DEC-323`. Operational custody, **not** an accounting posting|
| `ReturnFeeWaiverReason`| `MELARC_OPERATIONAL_ERROR`, `UNRESOLVED_DOCUMENTED_DISPUTE`, `GOODWILL_SERVICE_RECOVERY`| `MSC-DEC-331`. **Free text supplements the category and never replaces it** — a register of prose cannot answer how often Melarc waives its own fee for its own errors|
| `ProhibitedItemCategory`| `ILLEGAL_DRUGS`, `WEAPONS_AMMUNITION`, `EXPLOSIVES_HAZARDOUS`, `LIVE_ANIMALS`, `CASH_NEGOTIABLE_INSTRUMENTS`, `FOOD`, `FRAGILE`| §35, `MSC-DEC-173`, `MSC-DEC-214`|
| `PickupIntake.count_variance`| `MATCH`, `SHORT`, `OVER`| `domain-model.md` §6.6|
| `PickupRequest.default_payer_intent`| `RECIPIENT_PAYS`, `SENDER_PAYS_FULL`, `SPLIT`| `domain-model.md` §6.2|
| `Evidence.purpose`| 9| `domain-model.md` §3.6|
| Corridor codes| `AMASAMAN_ENVIRONS`, `KASOA_CORRIDOR`| §51 glossary, `MSC-DEC-180`|
| Fee type| `SERVICE_AREA_BASE`, `CORRIDOR_OFF_DAY`, `STATION_DROP`, `SIZE_CLASS_SURCHARGE`, `CARRIER_COST`, `OUTSIDE_ACCRA_MARGIN`, `SINGLE_PACKAGE_PICKUP`, `RETURN`, `CANCELLATION`| `settings.md` §7.2|

**`NON_BATCH_RATE` and the batch/intra-corridor rate types are withdrawn**. `CORRIDOR_OFF_DAY` replaces `NON_BATCH_RATE`; the intra-corridor rate has no successor because intra-corridor pricing no longer exists. **`MSC-DEC-180`'s substantive rule survives the rename**: the off-day fee is a machine-stable term and is **not** an Express service. Display copy must not rename the machine term.

`EXTRA_LARGE` is withdrawn with `size_band`. A parcel that would once have been `EXTRA_LARGE` is now `LARGE` or is refused — there is no fourth class to fall into.

**`ProhibitedItemCategory` is the current prohibited-items catalogue**, including `FOOD` and `FRAGILE` alongside its other listed values.

The categories are **fixed, not configurable**. Ops refuses at intake with a mandatory reason, applying judgement *within* a category — the judgement is whether an item falls in the category, never whether the category applies.

## 7. Adding a code or an enum

1. A new **error code** is added here and nowhere else, with its raising condition and governing section. A code with no traceable rule is invented behaviour.
2. A new **enum** is defined in the document that owns the concept — state machines for lifecycles, domain model for attributes — and only *indexed* here.
3. Neither frontend nor backend "may independently change operations, payloads, **enums**, errors, or contract-visible behaviour" (§39.1). Changes are reviewed by both owners.
4. §36.13's canonicalization gate applies: no enum is final until the Product Owner approves the transition tables, display labels are separated from machine codes, and the domain model and OpenAPI reference the same codes.

## 8. Questions this document raised

None. Every code traces to an approved section or decision.

The one code that had been uncertain, `PARTIAL_COLLECTION_NOT_PERMITTED`, was withdrawn on 16 August when `MSC-DEC-194` permitted partial collection — see §5.6. Registering it as pending rather than assuming an answer is what made the withdrawal a one-line change instead of a correction spanning the catalogue.


