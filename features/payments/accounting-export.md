# Accounting Export

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.3 (cleaned edition)
> **Date:** 4 October 2026
> **Domain:** payment
> **Owns:** the behaviour and acceptance criteria for the canonical accounting export —
> what a closed period's package contains, which period a fact is recognised in, how
> completely each record type is represented, and how a generated package is reached
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §27.4, §32, §50.2
> **Slice:** `SLICE-004` (unwritten)

> **Link paths in this document use `../../`** — correct from `features/payments/<name>.md`.

## 1. What this is, and why

This feature is a **read-only extract of payment facts for a closed period**, handed to an
external accounting system in a canonical, versioned package. Melarc runs no ledger, which is
precisely why the extract it gives to a system that does has to be canonical.

§27.4 assigns the work and disposes of the *needs-another-interview* question in its own opening
sentence: the remaining work *"does not require another broad Product Owner policy interview, but
it remains mandatory before implementation"*, and it lists *"payment receipt, immutable ledger,
adjustment and **accounting-export formats**"*. Three of that bullet's four items are already
built. **This is the remainder.**

The source facts already exist and are already enumerated: `domain-model.md 5.5` settles the
immutable payment ledger as **twelve record types**, all `APPROVED`. **The export invents no
entity to read from and changes no source record.**

**Version 1 boundary, stated plainly**: this feature **creates no accounting entry**. §14.1 places
general accounting — general ledger, chart of accounts, journal, financial period — outside
Version 1, and this stays inside that line. It produces a file of facts; what an accountant does
with them is not Version 1's to hold. It also **moves no money** and **writes nothing back** to
any of the twelve source records.

## 2. Governing sections

| Section| What it governs here|
|---|---|
| §27.4| Downstream design controls — assigns the **accounting-export format** to finance technical design, which is this document|
| §32| Reporting and analytics — *"Authorized report data may be exported as CSV"*, the **only export encoding approved anywhere in the corpus**; the same hub, role, timezone, money and audit rules as the underlying application; **company-wide export access explicit, not implied by ordinary Senior Ops status**; and export generation, requester, scope, timestamp and file access auditable|
| §50.2| Approved downstream-design follow-ups — where `OQ-005` places this format|
| §14.1| Out-of-scope — **general accounting/general ledger is outside Version 1**, and this feature stays inside that line|
| §16.3| Financial closure principle — operational and financial closure are *"related but **distinct**"*, which is what makes a **closed hub-day** a meaningful boundary to export on|
| §38.2| *"never unnecessary personal data"* — the data-minimisation rule the column allowlists enforce. `SECURITY_DESIGN.md 14.10` reads it as applying **to identifiers as much as to payloads**|
| §38.5| Enhanced audit mandatory for *"Data exports and destructive retention actions"* — why **both** audit events are Enhanced|
| §37.7| Privacy and sensitive data — already lists **export** among the security/privacy design work, which is where `OQ-120` sits|
| §35| Business rules generally. None is invented here; every rule cites a section above or `MSC-DEC-401`|
| §40| Non-functional. Not applicable beyond what the existing payment operations already set — this feature adds no new target|

**Decisions that shape this feature:** `MSC-DEC-401` (the two Product rules, the retrieval TTL and
the engineering routing), `MSC-DEC-322` (`HubCashReconciliation` is the act that closes a hub's
financial position, and therefore what *"closed period"* means), `MSC-DEC-297` (the evidence
retrieval TTL this one mirrors), `MSC-DEC-291` (the order of checks on a retrieval), `MSC-DEC-328`
(the shape of shipping a capability Off until the chain behind it is operational), `MSC-DEC-395`
(`FinancialAdjustmentResolution`, whose `reason_code` decides its representation), `MSC-DEC-365`
(the identity that makes `RiderCashCustody.collected_minor` reconstructible), `MSC-DEC-344`
(`custody_transferred_at` stamping two `CashHandover` transitions).

## 3. Surfaces and actors

| Surface| Actor| Can do| Gated by|
|---|---|---|---|
| Melarc Ops| Finance, Platform Admin| Request a canonical export for a closed period, and obtain a retrieval authorization over a generated package| `payment.ledger.export`, all hubs|
| Melarc Ops| Finance, Platform Admin| List and read export records — scope, period, row counts, manifest digest| `payment.ledger.read`, all hubs. **Confers no retrieval authority whatever**|
| Melarc Ops| Senior Ops| **N/A.** §32 requires company-wide export access to be *"explicit, not implied by ordinary Senior Ops status"*, and that sentence decides the holders| —|
| Melarc Vendor| Vendor account| **N/A.** A vendor reads a balance and a statement, never the payment-fact ledger| —|
| Melarc Rider| Rider| **N/A.** No rider surface reaches this feature| —|
| Recipient channel| —| **N/A.** A recipient has no account and no portal (§49)| —|

## 4. Preconditions

Every day in `period_from`..`period_to` carries a **closed** `HubCashReconciliation`.
For a `SINGLE_HUB` export, `hub_id` is supplied; for `ALL_HUBS` it is absent.
`accounting_export_file_retention_days` carries a value, and every canonical record type is
`EVENT_COMPLETE` — the two readiness gates of 5.8, **both of which are closed today**.

---

## 5. Behaviour

*This section and §13 are the only sections with original content. Everything else points
elsewhere.*

### 5.1 The two Product rules

**Both were approved by the Product Owner at R2e review and are the Product portion of
`MSC-DEC-401`.** They are financial-recognition policy, not CSV mechanics, which is why they are
stated here rather than inside a column table.

**Product rule 1 — final-period only.**

> **Canonical Version 1 accounting exports are closed-hub-day / final-period only. A hub-day
> becomes exportable only after its financial closure is confirmed. Melarc does not provide
> provisional or intraday accounting exports in Version 1.**

Two models were always available — final-period, or an as-of/incremental export up to a cutoff —
and choosing has a business consequence, stated rather than discovered: **Finance can obtain no
canonical accounting feed during the current financial day.** An open hub-day's figures are still
moving, and an export of a moving figure is a number two systems will later disagree about. What
*"financial closure"* means is not invented here: §16.3 requires operational and financial closure
to be distinct and separately visible, and `MSC-DEC-322` makes `HubCashReconciliation` the act
that closes the hub's financial position.

**Product rule 2 — late facts post forward; closed periods are never rewritten.**

> **Late-arriving financial facts are recognised in the accounting-export period in which the
> fact becomes authoritative in Melarc. The canonical export never back-posts a newly established
> fact into a previously closed export period, and never reissues an amended closed-period
> package.**

**The worked example the wording exists for.** The provider says the payment succeeded on **Day
D**. Melarc receives and authoritatively establishes that success on **D+2**. Day D is already
closed. **The fact is recognised on D+2**, because D+2 is when Melarc could know it.

**Why the wording matters, and why an earlier draft's wording would have defeated the rule it
states.** Had the rule read *"the period in which the fact occurs"*, a **provider-supplied
historical timestamp would pull the fact back into a closed Day D** — the exact back-posting this
rule exists to prohibit, reintroduced through the rule's own wording. *"Becomes authoritative in
Melarc"* is the clause that closes it.

**Late money is never discarded, so this case is real rather than theoretical.**
`state-machines.md 20.6` holds `STATUS_UNKNOWN → SUCCEEDED` — *"the same verification, arriving
late"* — and
`FinancialAdjustmentRequired` carries `LATE_PROVIDER_SUCCESS_AFTER_FALLBACK` for exactly this. A
`PaymentReceipt` against Day D's demand **can be written after Day D closes**. Back-posting,
prior-period adjustment and amended exports are all coherent alternatives; this rule chooses one.

### 5.2 Normal path

1. A holder of `payment.ledger.export` requests an export (`requestAccountingExport`) naming the
   scope, the hub where the scope is `SINGLE_HUB`, the closed period and the export schema
   version. **The request carries what an export is OF, and nothing about what it becomes** — no
   status, no digest, no row counts, no expiry.
2. The request is refused where either readiness gate is closed, or where any day in the range is
   not reconciled (5.8). Otherwise an `AccountingExport` is created in `REQUESTED` **and nothing
   else happens yet**.
3. **A retry of the same tuple while a `REQUESTED` record exists returns that record.** Two
   officers who independently ask for the same hub and period are not two exports; the duplicate
   would surface only as two manifests with two digests for one period.
4. Generation produces the package of 5.3, computes `file_available_until` from
   `accounting_export_file_retention_days`, and moves the record to `GENERATED`.
   `payment.ledger.exported` is emitted, **Enhanced** — the event that says payment facts left the
   platform. Failure moves it to `FAILED` with a reason code.
5. A holder of `payment.ledger.read` lists and reads export records (`listAccountingExports`,
   `getAccountingExport`) — metadata, row counts and manifest digest, **never a package and never
   a row of payment data**.
6. A holder of `payment.ledger.export` obtains a short-lived single-object retrieval authorization
   over a generated package (`createAccountingExportRetrievalAuthorization`), per 5.7.
   `payment.ledger.export_retrieval_authorized` is emitted, **Enhanced**.
7. **A package is never regenerated in place.** Once a record leaves `REQUESTED` the same tuple may
   be requested again, and that is a **new record** with its own manifest digest — the same rule
   that makes a correction a new record rather than an edit.

### 5.3 What the package contains

One export is **one versioned ZIP package**:

| Part| What it is|
|---|---|
| **Twelve CSVs**| One per source record type. **Twelve files because the twelve record types have twelve distinct column sets**, not because the ledger has two classes — two classes would justify two files|
| **One manifest**| Machine-readable: export schema version, scope and hub, period range, `generated_at`, and per file a `record_type`, `filename`, `row_count`, `sha256` and `representation`|
| **A stable, deterministic filename per file**| Carrying scope and period, so two packages for the same period are comparable by name before either is opened|

**Row counts and per-file hashes are what make the package reconcilable by the receiving
accountant.** They are also the unit of the reproducibility guarantee:

> **Regenerated canonical CSV payloads for the same hub, period, schema version and closure
> instant are byte-identical, and therefore reproduce the same per-file SHA-256 values. The
> manifest's `generated_at` may differ between runs and the ZIP container's own bytes and hash are
> not guaranteed stable.**

**The last clause is load-bearing.** ZIP containers carry their own timestamps, entry ordering and
compression representation, so a container hash asserted as stable would be an assurance that
fails the first time anyone tests it. **An overstated guarantee is worse than none.** A consumer
proving two runs agree compares the per-file digests, never the archive.

**Four cross-cutting representations are already fixed by approved contract and the package
follows them rather than choosing again**: money is a **minor-unit integer** with its currency
alongside, never a float and never a decimal string (`domain-model.md 3.2`); timestamps are UTC
instants and **an export carries an explicit offset**, the operating timezone being `Africa/Accra`
(`domain-model.md 3.3`); a calendar date is a date and not an instant, which is why `period_from`
and `period_to` are dates and `generated_at` is not; and an exported identifier is the primary
identifier, never the human-readable operational code, which is mutable (`domain-model.md 3.1`).
**What the export schema version itself pins** is what no approved decision has yet fixed: the
exact ordered column list per record type, the CSV dialect, the single unambiguous null
representation and how it differs from an empty string, the serialised token for every boolean and
enumeration, the deterministic row ordering, and the compatibility rule for what may be added
within a version and what forces a new one.

### 5.4 The twelve column allowlists

**The data-minimisation rule is not *"no PII"*, and an earlier draft that said so was wrong.**
`SECURITY_DESIGN.md 14.10` reads §38.2's *"never unnecessary personal data"* as applying **to
identifiers as much as to payloads**, so a claim that the package carries no personal data at all
would be an overclaim. The accurate statement, and the one the allowlists enforce:

> **The accounting export contains no recipient or customer contact fields and no other direct
> contact information. It uses controlled identifiers only, and excludes names, phone numbers,
> addresses and `Evidence` content.**

**An explicit column allowlist per record type is the enforceable form of that claim.** It is
**not a masking design** — an allowlist decides what is included, not how an included sensitive
field is obscured — so `OQ-049`'s masking work is untouched.

Four rules produce the lists, and every field a rule removes is named rather than silently
skipped:

| Rule| Effect|
|---|---|
| **A1 — contact data and free text**| Excluded: `payer_msisdn`, `payer_msisdn_masked`, `payer_context`, `destination`, `note`, `failure_detail`, `terminal_reason`. **A masked phone number is still a phone number**, and a free-text field that may carry a person's name is a name field|
| **A2 — idempotency keys**| `business_key`, `source_key` excluded. Write-path collision controls, not accounting facts; nothing downstream reconciles on them|
| **A3 — deprecated fields**| `PaymentAttempt.obligation_ref` excluded — *"not canonical truth for a multi-line demand"*|
| **A4 — a Melarc transition timestamp is not an attribute column**| It appears only as the `effective_at` of its own event row. **The exception is a timestamp that is not a Melarc event stamp** — a provider-supplied one — which is exported as data and never determines the period|

**Controlled identifiers are kept.** `hub_id`, `order_id`, `rider_id`, `*_staff_id`, `payer_ref`,
record foreign keys and `evidence_id` are all included: the statement above excludes names, phone
numbers, addresses and `Evidence` **content**, and uses controlled identifiers only.

**The twelve lists.** Each is the type's allowlisted **attribute** columns, carried alongside the
fixed event-row columns of 5.5 and valued **as at that event's `effective_at`**.

| Record type| Allowlisted attribute columns| Excluded here, and by which rule|
|---|---|---|
| `OperationalPaymentDemand`| `hub_id` · `payer_type` · `payer_ref` · `order_id` · `currency` · `total_due_minor` · `confirmed_receipts_minor` · `allocated_minor` · `remaining_due_minor` · `excess_minor`| `business_key` — A2|
| `PaymentDemandLine`| `demand_id` · `obligation_type` · `obligation_ref` · `description_code` · `principal_due_minor` · `principal_settled_minor` · `pricing_snapshot_ref`| —|
| `PaymentAttempt`| `hub_id` · `payment_demand_id` · `order_id` · `provider` · `principal_amount_minor` · `currency` · `client_reference` · `provider_transaction_id` · `provider_confirmed_at` *(data column)* · `confirmed_principal_minor` · `provider_amount_charged_minor` · `provider_fee_minor` · `net_settlement_minor` · `failure_code` · `reconciliation_status`| `payer_msisdn`, `failure_detail`, `terminal_reason` — A1; `obligation_ref` — A3; `last_provider_status_at` — **overwritten on every status poll**, so exporting it would put a present-tense value on a historical row; `expires_at` — a provider deadline, not a Melarc fact; `provider_request_id`, `provider_mode` — transport-level; `initiator_principal_type`, `initiator_principal_id`, `initiating_surface`, `delivery_stop_id` — operational attribution, not an accounting fact|
| `PaymentReceipt`| `hub_id` · `payment_demand_id` · `method` · `payment_attempt_id` · `manual_source_ref` · `rider_cash_custody_id` · `fallback_authorization_id` · `received_principal_minor` · `currency` · `provider_transaction_id` · `provider_reference` · `received_by_principal_type` · `received_by_principal_id`| `payer_msisdn_masked`, `payer_context` — A1; `source_key` — A2|
| `PaymentAllocation`| `payment_receipt_id` · `payment_demand_line_id` · `amount_minor`| `source_key` — A2. **The record carries no `hub_id`**, so a `SINGLE_HUB` export scopes allocations through `PaymentReceipt.hub_id`. That is a scoping join, not a derivability failure|
| `RiderCashCustody`| `order_id` · `rider_id` · `expected_minor` · `collected_minor` · `cash_receipt_ids` · `cash_handover_id` · `resolution_reason_code`| —|
| `CashHandover`| `rider_id` · `hub_id` · `system_expected_minor` · `gross_cash_minor` · `applied_expense_minor` · `declared_total_minor` · `confirmed_total_minor` · `variance_minor` · `variance_reason_code`| —|
| `HubCashReconciliation`| `hub_id` · `business_date` · `opening_position_minor` · `expected_minor` · `counted_minor` · `variance_minor` · `variance_reason_code` · `reconciled_by_staff_id`| —|
| `CashDisposition`| `hub_cash_reconciliation_id` · `hub_id` · `amount_minor` · `method` · `reference` · `evidence_id` · `recorded_by_staff_id`| `destination` — A1. It is *"account, recipient or location as the method requires"*, so on a finance handover it carries a person. **`method` + `reference` + `hub_id` is what an accountant reconciles on**. `evidence_id` is the identifier, never the `Evidence` content|
| `PaymentFallbackAuthorization`| `hub_id` · `payment_demand_id` · `unresolved_payment_attempt_id` · `fallback_method` · `authorized_by_staff_id` · `reason_code` · `duplicate_risk_acknowledged` · `consumed_by_receipt_id` · `superseded_reason`| `note` — A1, free text beside a mandatory `reason_code` that carries the classification; `business_key` — A2|
| `FinancialAdjustmentRequired`| `hub_id` · `payment_demand_id` · `payment_attempt_id` · `payment_receipt_ref` · `order_id` · `reason` · `amount_minor` · `currency`| `source_key` — A2|
| `FinancialAdjustmentResolution`| `financial_adjustment_required_id` · `hub_id` · `resolution_class` · `amount_minor` · `currency` · `method` · `reference` · `evidence_id` · `proposed_by_staff_id` · `decided_by_staff_id` · `reason_code`| `destination` — A1|

### 5.5 Event rows

**A period's package carries what happened in that period, not what is true today.** Rendering a
record's status as at the closure instant is **not** exporting a change: freeze a
`FinancialAdjustmentResolution` as `PROPOSED` in Day D's package, approve it on D+3, and under a
one-row-per-record model the approval appears **nowhere** — not in D, which is final, and not in
D+3, because the record already belongs to D.

**So the representation is event rows, for every status-bearing record type.** One record
contributes **one row per lifecycle event**, each attributed to the period containing its own
`effective_at`:

| Column| What it holds|
|---|---|
| `record_type`| The canonical source record type|
| `record_id`| The source record this event belongs to. **Not a primary key** — see below|
| `event_type`| The lifecycle event, **named for the state reached**, or `CREATED` where the record carries no status|
| `effective_at`| The **Melarc-authoritative** occurrence timestamp defined for that event type, and nothing else|
| `status_after`| The status the record holds after this event. **Null for the two types that carry no status at all** — a tri-state would make *"no status"* and *"status unknown"* the same value|
| *(attributes)*| The type's allowlisted columns from 5.4, **valued as at this event's `effective_at`**, not as at generation time|

**The export becomes append-only in its own right**, which is the property an accounting feed needs
and a mutable-entity snapshot cannot provide.

> **`record_id` is not a primary key.** It **recurs once per lifecycle event**, and across
> periods: a record created in one period and settled in the next appears in both packages under
> the same `record_id`. **A consumer that keys on it silently drops transitions** — a defect that
> shows up as a reconciliation quietly short rather than as an error. The key is
> (`record_type`, `record_id`, `event_type`, `effective_at`).

**`effective_at` decides the row's period, and nothing else does.** An upstream or provider event
timestamp **may be exported as data** in its own allowlisted column — `provider_confirmed_at` is
the case that matters — and **must never determine the accounting-export period**. Without that
clause the format could satisfy the letter of period attribution while violating Product rule 2: a
provider's backdated success timestamp would route the row into a closed period. **An event with
no authoritative effective timestamp is not emitted at all.**

**The authoritative `effective_at`, per record type and per event type.** This is the table an
implementer reads instead of guessing. **A `none` entry is one reason a type is `CREATION_ONLY`,
and it is not the only one**: seven of the eight carry at least one `none` entry; the eighth,
`FinancialAdjustmentResolution`, is **fully stamped** and fails on a field — see 5.6. **Two of the
other seven fail on a field as well**, and would still fail with every timestamp in place:
`OperationalPaymentDemand` on `confirmed_receipts_minor` and `PaymentAttempt` on
`reconciliation_status`. **Reading this table as the whole of `OQ-131`'s work is the exact
conflation the per-field rule exists to prevent** — Pass 4 is not a list of missing timestamps.

| Record type| Event| Authoritative `effective_at`|
|---|---|---|
| `OperationalPaymentDemand`| `CREATED` · `FROZEN` · `SETTLED` · `VOID`| `created_at` · `frozen_at` · `fully_settled_at` · `voided_at`|
| `OperationalPaymentDemand`| `PARTIALLY_SETTLED`| **none** — no field stamps it|
| `PaymentDemandLine`| `CREATED`| **none** — the record carries **no timestamp of any kind**, and the parent's `created_at` is not the line's: composition may change until `frozen_at`|
| `PaymentDemandLine`| `SETTLED`| `max(PaymentAllocation.allocated_at)` for the line — settlement is atomic, so one line's allocations share one Melarc instant|
| `PaymentDemandLine`| `VOID`| **none attributable** — nothing binds a line's void to its demand's|
| `PaymentAttempt`| `CREATED`| `created_at`|
| `PaymentAttempt`| `PENDING`| `provider_initiated_at`, **carried as unsettled** — the event is Melarc's, but the field is provider-named and nothing states whose clock the value is. Recorded as a question, not approved|
| `PaymentAttempt`| `SUCCEEDED`| the linked `PaymentReceipt.confirmed_at` — **Melarc's acceptance, not the provider's clock**. A success creates exactly one receipt, so the join is single-valued|
| `PaymentAttempt`| `STATUS_UNKNOWN` · `FAILED` · `EXPIRED` · `CANCELLED` · `REVERSED`| **none** — five events, no stamp. `REVERSED` is money that arrived and then left|
| `PaymentReceipt`| `CONFIRMED`| `confirmed_at`|
| `PaymentReceipt`| `REVERSED_BY_PROVIDER`| **none** — no `reversed_at` on the record and no reversal event in the audit catalogue|
| `PaymentAllocation`| `ALLOCATED`| `allocated_at`. No status; one creation event|
| `RiderCashCustody`| `EXPECTED`| **none** — **the record carries no creation timestamp at all**|
| `RiderCashCustody`| `COLLECTED_BY_RIDER`| `collected_at`|
| `RiderCashCustody`| `HANDED_TO_HUB` · `RECONCILED` · `EXCEPTION_OPEN`| parent `CashHandover.custody_transferred_at` — the transition's guard **is** the hub accepting the count|
| `RiderCashCustody`| `RESOLVED`| **none** — the Senior Ops disposition is stamped nowhere|
| `CashHandover`| `OPEN`| `opened_at`|
| `CashHandover`| `CONFIRMED` · `VARIANCE_OPEN`| `custody_transferred_at` — the **same field stamps both**|
| `CashHandover`| `CLOSED`| **none attributable** — `decided_at` exists and no contract text, machine row or invariant says which transition writes it|
| `HubCashReconciliation`| `OPEN` · `RECONCILED`| `opened_at` · `closed_at`|
| `HubCashReconciliation`| `COUNTED` · `VARIANCE_OPEN`| **none** — the hub's physical count is written at an event no field stamps|
| `CashDisposition`| `RECORDED`| `recorded_at`. One state; a correction is a new row|
| `PaymentFallbackAuthorization`| `ACTIVE` · `CONSUMED` · `SUPERSEDED`| `created_at` · `consumed_at` · `superseded_at`|
| `FinancialAdjustmentRequired`| `OPEN`| `raised_at`|
| `FinancialAdjustmentRequired`| `RESOLVED`| `FinancialAdjustmentResolution.decided_at`, joined on the unique `financial_adjustment_required_id` and **restricted to that resolution's `status` being `APPROVED`**. **There is no `resolved_at` on this record and an implementer must not hunt for one**; the restriction is load-bearing, because an unrestricted join would emit a resolved row for an adjustment a rejection left open|
| `FinancialAdjustmentResolution`| `PROPOSED` · `APPROVED` · `REJECTED`| `proposed_at` · `decided_at` · `decided_at`|

### 5.6 Completeness — what each record type may claim

The manifest carries a per-record-type `representation`, one of two values:

| Value| Meaning|
|---|---|
| `EVENT_COMPLETE`| Every state change of this record type is emitted as an event row|
| `CREATION_ONLY`| Only the creating event is emitted. **Post-creation transitions of this type are not represented in this package**|

**`EVENT_COMPLETE` is earned per field and never inferred from timestamp coverage.** A type carries
it only after its **complete** column allowlist passes the test: event → authoritative effective
timestamp → exported field → authoritative historical source → derivable? **If even one mutable
exported field cannot be reconstructed as at that event, the type is `CREATION_ONLY`**, however
complete its timestamps are.

**The twelve verdicts, and the single blocking field or event behind each.** These are the values a
manifest must carry; a manifest that disagrees with this table is wrong.

| Record type| `representation`| The blocking field or event|
|---|---|---|
| `OperationalPaymentDemand`| `CREATION_ONLY`| `confirmed_receipts_minor` — it must net receipts reversed by the instant, and `PaymentReceipt` has no `reversed_at`|
| `PaymentDemandLine`| `CREATION_ONLY`| The creating event — **the record carries no timestamp of any kind**|
| `PaymentAttempt`| `CREATION_ONLY`| `reconciliation_status` — four values, no transition timestamps, moving on the reconciliation worker's schedule independently of `state`|
| `PaymentReceipt`| `CREATION_ONLY`| `REVERSED_BY_PROVIDER` — no `reversed_at` and no reversal event in the audit catalogue|
| `PaymentAllocation`| **`EVENT_COMPLETE`**| —|
| `RiderCashCustody`| `CREATION_ONLY`| The creating event — **the record carries no creation timestamp**. *(`collected_minor` and `cash_receipt_ids` both pass: they reconstruct as the linked confirmed `CASH` receipts, and a `CASH` receipt has no attempt and therefore cannot be reversed.)*|
| `CashHandover`| `CREATION_ONLY`| `CLOSED` — unstamped; `decided_at` exists and nothing says which transition writes it|
| `HubCashReconciliation`| `CREATION_ONLY`| `COUNTED` — unstamped, so the hub's physical count is written at an event that cannot be periodised|
| `CashDisposition`| **`EVENT_COMPLETE`**| —|
| `PaymentFallbackAuthorization`| **`EVENT_COMPLETE`**| —|
| `FinancialAdjustmentRequired`| **`EVENT_COMPLETE`**| — *(resolved via the unique join above)*|
| `FinancialAdjustmentResolution`| `CREATION_ONLY`| `reason_code` — **one field, two writers**: the proposal writes it and a rejection overwrites it, so its value as at the proposal does not survive|

**Four `EVENT_COMPLETE`, eight `CREATION_ONLY`.** `FinancialAdjustmentResolution` entered the
analysis a candidate on the strength of `proposed_at` and `decided_at` and **fell on a field test
its timestamps would have passed** — which is the outcome the per-field rule exists to make
possible.

**Four record types cannot emit a truthful creating event either, and `CREATION_ONLY` overstates
what a package would contain for all four.** An earlier draft of the plan put the number at two;
the per-field matrix's own rows say **four**:

| Record type| Why the creating event is not truthful|
|---|---|
| `RiderCashCustody`| **No authoritative timestamp for it at all** — the record is created at dispatch and nothing on it records when|
| `PaymentDemandLine`| **No authoritative timestamp for it at all** — no timestamp of any kind, and the parent's cannot be inherited|
| `OperationalPaymentDemand`| It **has** `created_at`, and carries a column that cannot be filled at that event: `total_due_minor` is fixed only at `frozen_at`, no earlier value survives, and `remaining_due_minor` inherits the failure|
| `FinancialAdjustmentResolution`| It **has** `proposed_at`, and carries a column that cannot be filled at that event: `reason_code` — at the very event a later rejection destroys|

**A declared gap is honest, not safe.** A consumer that reads a `PaymentReceipt` creation row and
never receives the reversal holds **incorrect financial history**. The manifest warns it; the
missing event is still missing. **A declaration is not a remedy** — which is why generation is
gated on completeness rather than shipped with a warning label (5.8, Gate 2).

**The two-value enum is safe only while Gate 2 holds unconditionally, and a later reader must be
able to see that.** Two values suffice today because no package can be generated at all while any
type is `CREATION_ONLY`, so the four types above never have to declare anything. **Relax Gate 2 and
a package could declare `CREATION_ONLY` for a type that cannot produce a creation row** — a
**false** declaration rather than an incomplete one, which is worse than the state the field exists
to avoid. Whoever relaxes the gate must move this enum too, or the manifest starts lying instead of
warning.

> **No *"partial accounting export"* mode exists in Version 1.** Introducing one would be a
> separate Product feature with its own decision, and no approved source asks for it.

### 5.7 Retrieval

**Retrieval uses the repository's established pattern and invents no second one.**
`createEvidenceRetrievalAuthorization` set it: permission checked first, then a short-lived,
single-object presigned authorization. A streaming download would be a second file-delivery
pattern beside a working one.

- **The order of checks is the operation**: authenticate, verify
  `payment.ledger.export`, execute principal-specific isolation, confirm the record is
  `GENERATED`, confirm `file_available_until` has not passed, and only then issue the capability.
- **Five minutes** — `accounting_export_retrieval_authorization_ttl_minutes`. It matches evidence's
  TTL because the capability is **regenerable**, so a short window costs a caller
  one extra request, and **a payment-ledger package is at least as sensitive as a single `Evidence`
  object**: it earns no longer bearer lifetime.
- **Never a stored URL.** No anonymous read, no listing, no public ACL and no permanent URL.
  `storage_ref` is returned nowhere — handing a client the address would let it construct its own
  retrieval and bypass the authorization entirely.
- **The response is transient and is never logged.** `Cache-Control: no-store`. The audit event
  records that a capability was issued and never the URL.
- **The second audit event is named for what Melarc can observe.** The object is fetched from
  storage under the presigned authorization, so the platform records the authorization it issued
  and **never the download**. Calling it *accessed* would certify a fact nobody holds.
- **After `file_available_until` passes, retrieval refuses deterministically** rather than issuing
  an authorization over an absent object — while `getAccountingExport` still returns metadata, row
  counts and manifest digest, **because the fact that the export happened is permanent even when
  the file is gone**. An expired export is not a 404 and not a `FAILED` record; it is a `GENERATED`
  record whose `file_available_until` is in the past, determined **by comparison**. File
  availability is deliberately **not** a status: a fourth status value would make the passage of
  time look like a transition somebody took.

### 5.8 Exception paths

**Production generation has two independent readiness gates, and each refuses with its own named
code.** A caller must be able to tell *why* generation is unavailable — the two resolve at
different times and against different work — so one shared code would be worse than useless.

| Path| Behaviour| Error code|
|---|---|---|
| **Gate 1 — retention unset**| `accounting_export_file_retention_days` holds no value, so `file_available_until` cannot be computed. **Generation refuses rather than putting a file into the world with no stated lifetime.** The format, schemas, entity and operations are fully specified regardless; what waits on the figure is production generation| `EXPORT_RETENTION_NOT_CONFIGURED`|
| **Gate 2 — a source type is not event-complete**| At least one canonical record type is `CREATION_ONLY`. **A package that cannot carry a `PaymentReceipt` reversal is not a canonical accounting export, however clearly its manifest declares the gap**| `EXPORT_SOURCE_NOT_EVENT_COMPLETE`|
| Period not final| Any day in the requested range has no closed `HubCashReconciliation`| `PERIOD_NOT_RECONCILED`|
| Validation failure| `hub_id` absent for `SINGLE_HUB` or present for `ALL_HUBS`; `period_to` before `period_from`; unknown schema version| `VALIDATION_FAILED`|
| Unauthorized| No `payment.ledger.export` for a request or a retrieval authorization; no `payment.ledger.read` for a list or a read. **Senior Ops holds neither**| `PERMISSION_DENIED`|
| Wrong state on retrieval| The record is `REQUESTED` or `FAILED` — there is no package to authorize| `STATE_CONFLICT`|
| Package expired| `file_available_until` has passed. **The export record stays readable**| `EXPORT_FILE_EXPIRED`|
| Duplicate / replay| **A natural-key rule, not an `Idempotency-Key` one**: a request matching an outstanding `REQUESTED` record for the same scope, hub, period and schema version returns that record and queues no second package| —|
| Cancellation / reversal| **N/A.** A generated package is not withdrawn or amended; a re-run is a new record with its own digest| —|
| Offline (rider surfaces)| **N/A.** No rider surface reaches this feature| —|

### 5.9 What this feature must never do

- **Never export an open hub-day.** Product rule 1, and `PERIOD_NOT_RECONCILED` is the refusal.
- **Never back-post into a closed period, and never reissue an amended closed-period package.**
  Product rule 2.
- **Never let a provider timestamp determine a period.** `provider_confirmed_at` is exported as
  data in its own column. A row's period comes from its own `effective_at` and nowhere else.
- **Never emit an event with no authoritative effective timestamp.** Inheriting a parent's stamp,
  or inventing one, would put a row in a period nothing entitles it to.
- **Never treat `record_id` as a primary key**, in the format or in a consumer.
- **Never create an accounting entry.** §14.1 keeps general accounting outside Version 1. This
  hands source facts to a system that runs one.
- **Never write back to a source record.** No timestamp is invented and no Gate C record is edited
  to suit the export — including the `reversed_at` this analysis shows is most needed. That is
  `OQ-131`'s, and editing a signed record to suit an export's convenience is the drift the review
  process exists to catch.
- **Never rely on the `AuditEvent` ledger as a system of record.** *"An audit log is not an
  authorisation database"*; audit records **that** a decision was taken and cannot be asked the
  state question. Making completeness depend on replaying audit events is that same pattern one
  step further.
- **Never ship a partial feed behind a warning label.** Gate 2, and 5.6.
- **Never return `storage_ref`, log a retrieval URL, or issue a permanent one.**
- **Never grant Senior Ops company-wide export access.** §32 decides that, not preference here.

### 5.10 The `OQ-120` boundary

`OQ-120` — data residency and cross-border transfer — *"have never been decided — only latency
has"*. §37.7 already lists **export** among the security and privacy design work, and a package of
payment identifiers leaving for an external accounting system sits **inside that question's
existing scope**.

> Defining the canonical export format does not by itself authorize any production cross-border
> transfer or external-accounting-system delivery that `OQ-120` may govern. **Specification is not
> authorisation to ship data.**

---

## 6. Entities — *pointer*

| Entity| Home|
|---|---|
| `AccountingExport`| [domain-model.md](../../contracts/domain-model.md) §6.12 — new this pass. Carries `file_available_until`, `manifest_digest` and `row_counts`; **the record is permanent, the file is not**|
| The twelve source record types| `domain-model.md 5.5` enumerates the immutable payment ledger, and `domain-model.md` sections 6.11, 6.12 and 6.15 hold their field tables. **None is changed by this feature**|
| `HubCashReconciliation`| [domain-model.md](../../contracts/domain-model.md) §6.12 — the record whose closure makes a hub-day exportable|

## 7. States — *pointer*

| Machine| Home| States this feature drives|
|---|---|---|
| `AccountingExport.status`| [state-machines.md](../../contracts/state-machines.md) §20.7| `REQUESTED → GENERATED` · `REQUESTED → FAILED`. **No machine, and that is the conclusion of that section's own test**: no transition after creation is any actor's decision — generation is the arithmetic consequence of the job succeeding and failure of it not. The Product-semantic act is the **request**|

**File availability is represented separately and deliberately not as a status.**
`file_available_until` makes it derivable by comparison, not by a fourth status and not by a second
machine.

## 8. Permissions — *pointer*

| Key| Holders| Scope| Home|
|---|---|---|---|
| `payment.ledger.export`| **Finance**, Platform Admin| all hubs| [permissions.md](../../contracts/permissions.md) §7 — new this pass. Requests an export and obtains a retrieval authorization|
| `payment.ledger.read`| **Finance**, Platform Admin| all hubs| permissions.md §7 — new this pass. Lists and reads export records. **Confers no retrieval authority at all**|

**Two keys, and the split is on the verb.** Issuing a capability over a period's payment facts is
not a lesser act than requesting one, so both live behind the export key; **a metadata read issues
no capability**, and this catalogue has twice decided that a narrow read needs a read key.
**Senior Ops holds neither** — §32 requires company-wide export access to be explicit rather than
implied, and `OQ-049`'s register row now narrows to *report* exports so that two questions do not
own one artifact.

## 9. Settings — *pointer*

| Key| Why this feature reads it| Home|
|---|---|---|
| `accounting_export_retrieval_authorization_ttl_minutes`| Lifetime of a retrieval authorization. **5 minutes**| [settings.md](../../contracts/settings.md) §7.7|
| `accounting_export_file_retention_days`| How long a generated package stays retrievable, and the input to `file_available_until`. **Value undecided — `OQ-130`**, and Gate 1 refuses generation until it lands| [settings.md](../../contracts/settings.md) §7.1|

## 10. Errors — *pointer*

| Code| When| Home|
|---|---|---|
| `EXPORT_RETENTION_NOT_CONFIGURED`| Gate 1 — the retention figure holds no value| [errors-and-enums.md](../../contracts/errors-and-enums.md) §5.4|
| `EXPORT_SOURCE_NOT_EVENT_COMPLETE`| Gate 2 — a canonical record type is `CREATION_ONLY`| errors-and-enums.md 5.4|
| `PERIOD_NOT_RECONCILED`| A day in the range has no closed reconciliation| errors-and-enums.md 5.4|
| `EXPORT_FILE_EXPIRED`| The package passed `file_available_until`; the record stays readable| errors-and-enums.md 5.4|
| `PERMISSION_DENIED` · `STATE_CONFLICT` · `VALIDATION_FAILED`| No grant; nothing to authorize; a malformed scope, period or schema version| errors-and-enums.md 4 — cross-cutting, existing|

**Enums:** `AccountingExportStatus`, `AccountingExportScope` and `RecordRepresentation` —
[errors-and-enums.md](../../contracts/errors-and-enums.md) §6, all new this pass.

## 11. Audit events — *pointer*

| Event| Enhanced?| Home|
|---|---|---|
| `payment.ledger.exported`| **Yes**| [audit.md](../../contracts/audit.md) §5.3 — new this pass. Requester, scope, period range, schema version, per-record-type row counts and manifest digest|
| `payment.ledger.export_retrieval_authorized`| **Yes**| audit.md 5.3 — new this pass. Export, requester, expiry — **never the URL** (audit.md 9)|

Both are Enhanced on the specification's own words: §38.5 makes enhanced audit mandatory for
*"Data exports and destructive retention actions"*.

## 12. API operations — *pointer*

| Operation| Home|
|---|---|
| `requestAccountingExport`| [openapi.yaml](../../contracts/openapi.yaml) — new this pass|
| `listAccountingExports`| openapi.yaml — new this pass|
| `getAccountingExport`| openapi.yaml — new this pass|
| `createAccountingExportRetrievalAuthorization`| openapi.yaml — new this pass; mirrors `createEvidenceRetrievalAuthorization`|

**These are the contract's first export operations.** Schemas for the request, the record, the
package manifest, the event row and the retrieval authorization sit beside them.

---

## 13. Acceptance criteria

*§43.1 form. Every criterion cites its governing §, decision, or entity invariant.*

**None of these is executable today, and that is Gate 2 rather than a gap in the criteria.** A
format specification describes what a package contains once one can be produced, so most criteria
below are written against a generated package. **The distinction that matters is between a
criterion whose *premise* waits on Gate 2 and one whose *assertion* depends on a verdict Gate 2
keys on.** The first needs no caveat — `AC-EXPORT-07`, `-08`, `-10`, `-11` and `-12` state what
the format does, and the gate only decides when it can be run. The second does, and carries it in
the criterion: **`AC-EXPORT-06`** names `PaymentAttempt` reaching `EVENT_COMPLETE` as a
precondition, and **`AC-EXPORT-09`** is stated about the manifest field rather than about a
package, because the values it asserts are the ones that keep the gate shut. **A criterion may
never assert an event row for a `CREATION_ONLY` type**, however the gate stands.

### `AC-EXPORT-01` — generation refuses while the retention figure is unset

```text
Given accounting_export_file_retention_days carries no value,
When a Finance holder calls requestAccountingExport for a fully reconciled period,
Then the response is 422 EXPORT_RETENTION_NOT_CONFIGURED,
And no AccountingExport record is created and no package is queued,
And once the setting carries a value the same request passes this gate.
```
**Governs:** `MSC-DEC-401`, `OQ-130`, settings.md 7.1 · **Surface:** API · **Test level:** integration · **Expected code on rejection:** `EXPORT_RETENTION_NOT_CONFIGURED`

**Why:** `file_available_until` cannot be computed without the figure, and a file with no stated
lifetime is not put into the world.

### `AC-EXPORT-02` — generation refuses while any source type is not event-complete, with its own distinct code

```text
Given at least one canonical record type would export as CREATION_ONLY,
When a Finance holder calls requestAccountingExport with the retention figure set,
Then the response is 422 EXPORT_SOURCE_NOT_EVENT_COMPLETE,
And that code is not EXPORT_RETENTION_NOT_CONFIGURED — the two gates resolve at different times
  and against different work, so a caller can tell which one it is waiting on,
And when both gates are open the same request is accepted.
```
**Governs:** `MSC-DEC-401`, `OQ-131`, errors-and-enums.md 5.4 · **Surface:** API · **Test level:** integration · **Expected code on rejection:** `EXPORT_SOURCE_NOT_EVENT_COMPLETE`

### `AC-EXPORT-03` — an open hub-day is not exportable

```text
Given a requested period in which one hub-day has no closed HubCashReconciliation,
When a Finance holder calls requestAccountingExport with both readiness gates open,
Then the response is 422 PERIOD_NOT_RECONCILED,
And once that hub-day's reconciliation is closed the same request is accepted,
And no provisional or intraday variant of the request exists to fall back to.
```
**Governs:** §16.3, `MSC-DEC-401`, `MSC-DEC-322` · **Surface:** API · **Test level:** integration · **Expected code on rejection:** `PERIOD_NOT_RECONCILED`

### `AC-EXPORT-04` — Senior Ops is refused, and a metadata read reaches no package

```text
Given a Senior Ops holder with no payment.ledger.export and no payment.ledger.read grant,
When they call requestAccountingExport or createAccountingExportRetrievalAuthorization,
Then the response is 403 PERMISSION_DENIED,
And a holder of payment.ledger.read alone can call listAccountingExports and getAccountingExport
  and is refused createAccountingExportRetrievalAuthorization with the same code.
```
**Governs:** §32, `MSC-DEC-401`, permissions.md 7 · **Surface:** API · **Test level:** integration · **Expected code on rejection:** `PERMISSION_DENIED`

**Why:** §32 requires company-wide export access to be explicit rather than implied by ordinary
Senior Ops status, and a metadata read issues no capability.

### `AC-EXPORT-05` — a lifecycle event lands in the period containing its own effective_at

```text
Given a PaymentFallbackAuthorization created on day D and consumed on day D+3, both days closed,
  its representation being EVENT_COMPLETE,
When the packages for D and for D+3 are generated,
Then D carries one event row for that record with event_type ACTIVE and effective_at equal to
  created_at,
And D+3 carries one event row for the same record with event_type CONSUMED and effective_at equal
  to consumed_at,
And neither package carries the other's row — no row is added to a closed period and no closed
  period is rewritten.
```
**Governs:** `MSC-DEC-401`, `MSC-DEC-364`, domain-model.md 6.12 · **Surface:** contract · **Test level:** integration

**Why this record and not `FinancialAdjustmentResolution`.** A `PROPOSED`/`APPROVED` pair across
two periods is the more familiar illustration and **it is not assertable**: that type is
`CREATION_ONLY` (5.6), so the format emits no `APPROVED` row for it, and its `PROPOSED` row is one
of the four 5.6 shows cannot be truthfully emitted at all. `PaymentFallbackAuthorization` is
`EVENT_COMPLETE` and gives the same two-period shape.

### `AC-EXPORT-06` — a provider-backdated timestamp does not route a row into a closed period

```text
Given PaymentAttempt's representation is EVENT_COMPLETE — OQ-131 closed and Gate 2 open, without
  which no package is generated at all,
And a PaymentAttempt whose provider_confirmed_at reads day D and whose linked PaymentReceipt was
  confirmed on day D+2, with day D already closed,
When the packages for D and for D+2 are generated,
Then the SUCCEEDED event row appears in D+2, because its effective_at is the linked receipt's
  confirmed_at — Melarc's acceptance, not the provider's clock,
And no row is added to D,
And provider_confirmed_at appears in the D+2 row as an exported data column and determines
  nothing about the period.
```
**Governs:** `MSC-DEC-401` *(Product rule 2)*, `OQ-131`, state-machines.md 20.6 · **Surface:** contract · **Test level:** integration

**This criterion is conditional, and deliberately so.** `PaymentAttempt` is the only record that
carries a provider timestamp, so no `EVENT_COMPLETE` type can stand in for it, and the
backdated-provider case is the one Product rule 2 exists for. It is therefore stated against the
state Pass 4 reaches rather than against today's, and it is **not executable until `OQ-131`
closes** — which is the honest position, not a gap.

### `AC-EXPORT-07` — record_id recurs across periods and is not a primary key

```text
Given a PaymentFallbackAuthorization created in period P1 and consumed in period P2,
When both packages are read,
Then the same record_id appears once in each, with event_type ACTIVE and CONSUMED respectively,
And a consumer keying rows on record_id alone retains one row and drops the other,
And the format states the key as record_type, record_id, event_type and effective_at together.
```
**Governs:** `MSC-DEC-401`, `MSC-DEC-364` · **Surface:** contract · **Test level:** contract

### `AC-EXPORT-08` — the package is a ZIP of twelve CSVs and one manifest

```text
Given a generated AccountingExport,
When the package is opened,
Then it contains twelve CSV files, one per source record type, and one machine-readable manifest,
And the manifest carries the export schema version, scope, hub, period range, generated_at, and
  per file a record_type, filename, row_count, sha256 and representation,
And each filename is deterministic and carries scope and period.
```
**Governs:** §32, `MSC-DEC-401`, domain-model.md 6.12 · **Surface:** contract · **Test level:** contract

### `AC-EXPORT-09` — the manifest's representation matches the per-field verdicts

```text
Given the representation a manifest would declare for each of the twelve record types, computed
  from the source records as they stand today,
When each value is compared with the per-field verdicts of 5.6,
Then PaymentAllocation, CashDisposition, PaymentFallbackAuthorization and
  FinancialAdjustmentRequired compute EVENT_COMPLETE,
And the other eight compute CREATION_ONLY,
And no type computes EVENT_COMPLETE on timestamp coverage alone — FinancialAdjustmentResolution
  carries both of its transition timestamps and is CREATION_ONLY, because one reason_code field
  is written by the proposal and overwritten by a rejection,
And a manifest may carry only the value this computation produces for a type, never a value
  asserted beside it.
```
**Governs:** `MSC-DEC-401`, `OQ-131`, errors-and-enums.md 6 · **Surface:** contract · **Test level:** contract

**This is a rule about the field, not about a package, and that is the point.** Stating it as
*"given a generated package"* would have made its Given and its Then unable to hold together —
Gate 2 blocks generation while any type is `CREATION_ONLY`, and eight are. **Making it conditional
on `OQ-131` instead would have been worse**: closing `OQ-131` is precisely what moves these
verdicts, so a criterion that waits for the gate to open would assert a set of values that the
gate opening falsifies. The stable assertion is that **the declared value is the computed one**;
the twelve values above are that computation's output today.

### `AC-EXPORT-10` — a CREATION_ONLY type emits only its creating event, and four cannot truthfully emit even that

```text
Given the emission rule for a CREATION_ONLY type, applied to a PaymentReceipt confirmed in one
  period and reversed by the provider in a later one,
When the rows the format would emit for each of the two periods are computed,
Then the first period's rows carry the CONFIRMED event row and neither period's carry a
  REVERSED_BY_PROVIDER row,
And the representation computed for PaymentReceipt is CREATION_ONLY,
And for RiderCashCustody, PaymentDemandLine, OperationalPaymentDemand and
  FinancialAdjustmentResolution the creating row is not truthful either — the first two have no
  authoritative timestamp for it and the second two carry a column that cannot be filled at it,
And no package is generated at all while any of this holds, because Gate 2 is closed — the
  rows above are what a package would contain, never what one does.
```
**Governs:** `MSC-DEC-401`, `OQ-131`, domain-model.md 6.12 · **Surface:** contract · **Test level:** contract

**Stated against the emission rule and not against a package, for the reason `AC-EXPORT-09`
gives.** Gate 2 makes the package this criterion would otherwise open with ungeneratable, and a
`When` that reads two packages beside a `Then` that says none exists cannot both hold — which is
the defect v0.2 removed from `AC-EXPORT-09` and v0.3 removes here.

### `AC-EXPORT-11` — the column allowlist carries no contact data and no evidence content

```text
Given a generated package for any period,
When every column of all twelve files is read,
Then no recipient or customer contact field appears — not payer_msisdn, not payer_msisdn_masked,
  not payer_context, not destination,
And no free-text field appears that could carry a person's name — not note, not failure_detail,
  not terminal_reason,
And no Evidence content appears, only evidence_id,
And the controlled identifiers hub_id, order_id, rider_id, the staff identifiers, payer_ref and
  the record foreign keys do appear, because the claim is data minimisation and controlled
  identifiers, never an absence of personal data altogether.
```
**Governs:** §38.2, `MSC-DEC-401`, `SECURITY_DESIGN.md 14.10` · **Surface:** contract · **Test level:** contract

### `AC-EXPORT-12` — regenerating reproduces every per-file digest and does not promise the container

```text
Given a package generated for a hub, period, schema version and closure instant,
When a second package is generated for the same four,
Then every per-file sha256 in the manifest is identical to the first run's,
And generated_at legitimately differs,
And the ZIP container's own bytes and hash are not asserted to be stable, because container
  metadata, ordering and compression representation may differ over identical payloads.
```
**Governs:** `MSC-DEC-401` · **Surface:** contract · **Test level:** integration

### `AC-EXPORT-13` — after expiry the record answers and the package does not

```text
Given a GENERATED AccountingExport whose file_available_until has passed,
When a Finance holder calls getAccountingExport,
Then it returns 200 with scope, period, schema version, status, row counts, manifest digest and
  file_available_until — not a 404, and not a FAILED record,
And when the same holder calls createAccountingExportRetrievalAuthorization, the response is 422
  EXPORT_FILE_EXPIRED rather than an authorization over an absent object,
And no status value ever represented the expiry — it is determined by comparison.
```
**Governs:** `MSC-DEC-401`, state-machines.md 20.7, domain-model.md 6.12 · **Surface:** API · **Test level:** integration · **Expected code on rejection:** `EXPORT_FILE_EXPIRED`

### `AC-EXPORT-14` — retrieval is a five-minute single-object capability, and it is never logged

```text
Given a GENERATED AccountingExport within its availability window,
When a holder of payment.ledger.export calls createAccountingExportRetrievalAuthorization,
Then the response carries a method, an opaque single-object URL and an expires_at five minutes
  ahead, and no storage_ref,
And the response is sent with Cache-Control no-store,
And the emitted payment.ledger.export_retrieval_authorized event carries the export, requester
  and expiry and never the URL.
```
**Governs:** §38.5, `MSC-DEC-401`, `MSC-DEC-297`, `MSC-DEC-291` · **Surface:** API · **Test level:** integration

**Why:** the capability is regenerable and a payment-ledger package is at least as sensitive as a
single `Evidence` object, so it earns no longer bearer lifetime than evidence's five minutes.
**The boundary this feature must not cross — that no operation here creates a journal entry,
account code, financial period or ledger row — is §14.1's and is stated at 1 and 5.9 rather than
asserted here**, because Version 1 contains no such structure for a test to look for.

---

## 14. Open questions blocking this feature

| ID| What it blocks here| Type|
|---|---|---|
| `OQ-130`| The accounting-export **file retention window**. Shape decided, figure the Product Owner's. **Generation is unavailable until it is answered** — Gate 1| `VALUE_REQUIRED`|
| `OQ-131`| **Event-history derivability**, not merely missing timestamps: every lifecycle event needs an authoritative effective timestamp, and every exported event-row column must be immutable, written by that event, or historically reconstructible at it. Eight of twelve types fail it today. **Generation is unavailable until it closes** — Gate 2. It touches a signed machine, so it needs Product Owner re-signature| `ARTIFACT_REQUIRED`|
| `OQ-120`| **Data residency and cross-border transfer.** Not resolved and not narrowed here. Specifying the format authorises no production transfer or external delivery — 5.10| `EXTERNAL_INPUT`|
| `OQ-005`| Narrows: the **format** is specified. Formal bank reconciliation, residual provider recovery and `VendorBalance`'s structure remain, and the completeness dependency is now tracked at `OQ-131`| `ARTIFACT_REQUIRED`|
| `OQ-049`| Narrows to report formulas, data dictionary, masking, retention and **report** export. It does not own the accounting export| `ARTIFACT_REQUIRED`|
| `OQ-030`| No Ops Portal page inventory exists for this feature yet| `ARTIFACT_REQUIRED`|

**Two of these block the behaviour rather than the specification.** `OQ-130` and `OQ-131` each
close a readiness gate, and the format, schemas, entity, permissions, events and operations are
fully specified regardless — what waits on them is production generation.

## 15. What this feature still owes its slice

| Owed| Blocks which DoR area| Owner|
|---|---|---|
| `SLICE-004` itself is unwritten — **one feature does not assess a slice**, and nothing here claims the slice is ready| F (acceptance and delivery)| Engineering — `SLICE-004`|
| Event-history derivability for the eight `CREATION_ONLY` types, including `PaymentReceipt`'s absent reversal stamp| B, C| `OQ-131`, `SLICE-004` Pass 4|
| The retention figure| C| `OQ-130`|
| An Ops Portal screen for requesting, listing and retrieving an export| D (frontend)| `OQ-030`|
| Residency and lawful-basis determination before any production delivery| —| `OQ-120`|

## 16. Build status — *honest, per surface*

| Surface| Status| Gap|
|---|---|---|
| Melarc Ops| ⚪ not built| No Ops Portal page inventory; the operations are specified, not implemented, and **both readiness gates are closed**, so no package would be generated even once they are|
| Melarc Vendor| N/A| A vendor reads a balance and a statement, never the payment-fact ledger|
| Melarc Rider| N/A| No rider surface reaches this feature|
| Recipient channel| N/A| A recipient has no account and no portal (§49)|

## 17. Related

- [financial-adjustment-resolution.md](financial-adjustment-resolution.md) — the domain's first
  feature, and the record whose single `reason_code` decides this export's hardest verdict
- [daily-operations-and-cash-report.md](../reporting/daily-operations-and-cash-report.md) — the
  **report** export, a different artifact with different authority, owned by `OQ-049`
- [cash-collection.md](../delivery/cash-collection.md) — where most of the exported cash facts
  originate
- `delivery/IMPLEMENTATION_PLAN.md` §3 — `SLICE-004`, depends on `SLICE-003`, blocked by `OQ-005`
