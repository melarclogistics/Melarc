# Financial Adjustment Resolution

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.4 (cleaned edition)
> **Date:** 4 October 2026
> **Domain:** payment
> **Owns:** the behaviour and acceptance criteria for resolving a `FinancialAdjustmentRequired` —
> how money Melarc owes back is dispositioned, by whom, and what is recorded
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §26.5, §26.6, §16.3
> **Slice:** `SLICE-004` (unwritten)

> **Link paths in this document use `../../`** — correct from `features/payments/<name>.md`.

## 1. What this is, and why

`MSC-DEC-357` built a record for money Melarc owes back — a duplicate payment, an overpayment, a
paid obligation later voided, a provider success arriving after a fallback had already settled —
and deliberately stopped at `OPEN`, saying *"refund, credit and allocation are Accounting &
Reporting's."* Nothing then resolved it. This feature is that resolution.

§16.3 is why it cannot stay unbuilt: the system must *"prevent unresolved money from becoming
invisible."* A record that can be raised and never closed becomes invisible the moment everyone
knows nothing will change.

**Version 1 boundary, stated plainly**: this feature **records** a resolution and **does not
execute** one. §39.8 makes Hubtel the approved provider boundary for *recipient mobile-money
payments and approved-vendor weekly-statement payments* — both inbound — and lists
*reversals/refunds* among what the integration contract **must still define**, which sits behind
the unverified `OQ-109`. There is no outbound rail to call. So a refund is executed out of band
and evidenced here, exactly as `CashDisposition` evidences a bank deposit. It also
models **no general ledger, chart of accounts, journal or financial period** — §14.1 places
general accounting outside Version 1 — and **creates no accounting entry**.

## 2. Governing sections

| Section| What it governs here|
|---|---|
| §26.5| Minimum financial distinctions — Version 1 must digitally distinguish an **adjustment**, which is the fact this feature resolves|
| §26.6| Remaining design areas — assigns **refunds/reversals** and post-payment correction rules to finance/domain design, which is this|
| §16.3| Financial closure principle — *"prevent unresolved money from becoming invisible"*, the reason an adjustment may not stay `OPEN` forever|
| §14.1| Out-of-scope — **general accounting/general ledger is outside Version 1**, and this feature stays inside that line|
| §39.8| Payments and disbursement integration — the provider boundary is inbound-only and refunds await the integration contract|
| §35| Business rules generally. None is invented here; every rule cites a section above or `MSC-DEC-395`|
| §40| Non-functional. Not applicable beyond what the existing payment operations already set — this feature adds no new target|

**Decisions that shape this feature:** `MSC-DEC-395` (the four policy calls and the two
evidence-settled boundaries), `MSC-DEC-357` (`FinancialAdjustmentRequired`, the fact this
resolves), `MSC-DEC-323` (`CashDisposition`, the precedent for recording money Melarc does not
move), `MSC-DEC-319` (`payment.road_expense.approve`, the maker-checker shape), `MSC-DEC-363`
(`PaymentAllocation`, the many-to-one shape deliberately **not** copied), `MSC-DEC-394` (the
CRIT-07 return refund this now gives a path to execute).

## 3. Surfaces and actors

| Surface| Actor| Can do| Gated by|
|---|---|---|---|
| Melarc Ops| Senior Ops, Platform Admin| Propose a resolution for an adjustment at their own hub| `payment.adjustment.resolve`|
| Melarc Ops| Finance, Platform Admin| Approve or reject a proposed resolution, at any hub| `payment.adjustment.approve`, decider ≠ proposer|
| Melarc Vendor| Vendor account| **N/A.** A vendor reads their balance and statement, never this record| —|
| Recipient channel| —| **N/A.** A recipient has no account and no portal (§49)| —|

## 4. Preconditions

A `FinancialAdjustmentRequired` exists with `status = OPEN` and carries no `PROPOSED` or
`APPROVED` resolution. For `UNCLAIMED_DISPOSITION` only, `unclaimed_adjustment_grace_days` has
elapsed since `raised_at`.

---

## 5. Behaviour

*This section and §13 are the only sections with original content. Everything else points
elsewhere.*

### 5.1 Normal path

1. An adjustment sits `OPEN` — raised by Gate C against a demand and a receipt, with a reason and
   an amount, and nothing yet done about it.
2. Senior Ops proposes a resolution (`proposeAdjustmentResolution`), naming the
   `resolution_class` and, where the class requires them, the `method`, `destination`, `reference`
   and `evidence_id`. **The amount is not submitted** — it is the adjustment's own, because one
   adjustment resolves once and wholly. `payment.adjustment.resolution_proposed` is emitted.
3. **The class is constrained by who the payer is.** Where the payer is a **registered vendor**,
   `CREDIT` against `VendorBalance` is the default, and `REFUND` displaces it only with the
   vendor's request recorded in `reason_code`. Where the payer is a **recipient or ad-hoc sender**,
   `CREDIT` is unavailable — §49 excludes individual/ad-hoc credit and neither holds a balance — so
   the class is `REFUND` or `ALLOCATION`.
   **A credit is evidenced here and posted elsewhere**: `VendorBalance` is a named entity with no
   field table (`domain-model.md` §5.5), and nothing in this contract increments it, so
   `VENDOR_BALANCE_CREDIT` records that the money became a vendor credit and who approved it —
   not the posting. **The same out-of-band shape a refund has, for a different reason**: a refund
   waits on a provider rail, a credit waits on the vendor-balance ledger that stays
   with `SLICE-007`.
4. **Proposing moves nothing.** The adjustment stays `OPEN`.
5. Finance approves or rejects (`decideAdjustmentResolution`), never as the proposer.
   `payment.adjustment.resolution_decided` is emitted, enhanced.
6. **On `APPROVED`** the resolution reaches `APPROVED` and the adjustment reaches `RESOLVED`.
   **On `REJECTED`** the resolution is kept with its reason and the adjustment stays `OPEN`, free
   to carry a fresh proposal.
7. Where the money physically moved, it moved **out of band** — a Merchant MoMo transfer, a bank
   transfer, cash at a hub — and this record is its evidence, not its instruction.

**Where the payer cannot be reached**, the adjustment stays `OPEN` until
`unclaimed_adjustment_grace_days` has elapsed, after which Senior Ops may propose
`UNCLAIMED_DISPOSITION` with a mandatory `reason_code`. Finance approves it like any other class,
because writing money off is still money moving.

### 5.2 Exception paths

| Path| Behaviour| Error code|
|---|---|---|
| Validation failure| Missing `method` or `destination` for `REFUND`; missing `reason_code` for `UNCLAIMED_DISPOSITION` or for a vendor `REFUND`; missing `reference` for a transfer method| `VALIDATION_FAILED`|
| Unauthorized| No `payment.adjustment.resolve`/`.approve` grant, or a hub-scoped proposer reaching another hub's adjustment| `PERMISSION_DENIED`|
| Self-approval| The decider is the proposer| `SELF_APPROVAL_FORBIDDEN`|
| Wrong state| The adjustment is already `RESOLVED`, already carries a `PROPOSED` or `APPROVED` resolution, or `UNCLAIMED_DISPOSITION` is proposed before the grace period elapses| `STATE_CONFLICT`|
| Duplicate / replay| `Idempotency-Key` on both operations — a retry creates no second resolution and no second decision| `IDEMPOTENCY_KEY_CONFLICT`|
| Concurrent edit| Two concurrent proposals for one adjustment — the uniqueness of `financial_adjustment_required_id` is the guard; only the first is created| `STATE_CONFLICT`|
| Retry| Idempotent by key (above); no separate retry interface state is approved for this workflow| —|
| Offline (rider surfaces)| **N/A.** No rider surface reaches this feature; §19.8's single approved offline command is unrelated| —|
| Missing configuration| **N/A since `MSC-DEC-396`.** `unclaimed_adjustment_grace_days` is `CONFIRMED` at **90**, so every class is proposable.| —|
| Cancellation / reversal| **N/A.** An approved resolution is not withdrawn; a resolution that was wrong is a new adjustment, on the same reasoning that makes a split case two adjustments| —|

### 5.3 What this feature must never do

- **Never execute a payment.** No operation here moves money. §39.8's boundary is inbound-only and
  refunds await the integration contract; an operation that called a provider would be
  inventing a rail the contract has not defined.
- **Never create an accounting entry.** §14.1 places general accounting outside Version 1. This
  record is an operational fact, exactly as `CashDisposition` is, and the accounting treatment of
  it is not Version 1's to hold.
- **Never treat a recorded `CREDIT` as a posted one.** `VendorBalance` has no structure in this
  contract and nothing here increments it. A screen that showed a vendor's balance as already
  reduced would be reporting a posting that has not happened.
- **Never offer `CREDIT` to a recipient or an ad-hoc sender.** §49 excludes individual/ad-hoc
  credit and neither party holds a balance to credit. A screen that offered it would be inventing
  an account.
- **Never accept an amount on the proposal.** The adjustment knows what is owed back. A proposer
  who could type an amount could resolve GH₵55 with GH₵5, and partial resolution is not permitted.
- **Never let the decider be the proposer.** Approval moves money out, which is the whole reason
  `payment.road_expense.approve` carries the same rule.
- **Never discard a rejected resolution.** How often a proposed resolution is refused is the only
  control on a discretionary money act — the same argument `MSC-DEC-197`'s pattern rests on.
- **Never resolve an adjustment twice.** One adjustment, one resolution, resolved whole;
  `PaymentAllocation`'s many-to-one shape is deliberately not copied here.

---

## 6. Entities — *pointer*

| Entity| Home|
|---|---|
| `FinancialAdjustmentResolution`| [domain-model.md](../../contracts/domain-model.md) §6.15 — new this pass. **Two open contradictions sit inside this record's own section**, raised 23 September 2026 by `SLICE-004` Pass 3's per-field derivability test and awaiting a ruling rather than information: **`CONFLICT-040`** — one `reason_code` column, written by the proposal as the disposition reason and again by a rejection as the refusal reason, so the proposed value does not survive — and **`CONFLICT-041`** — `financial_adjustment_required_id` is `UNIQUE` while the same section's invariants permit a fresh proposal after a rejection. Both are described in the unresolved requirements below. Until they are ruled, the precondition in section 4, step 6 of §5.1 and `AC-ADJUST-06`/`AC-ADJUST-07` state the invariants' reading beside the constraint's, and an implementer must not pick one silently|
| `FinancialAdjustmentRequired`| domain-model.md §6.12 — existing; `status` gains `RESOLVED`|
| `VendorBalance`| domain-model.md §5.5 — the only balance any party holds, which is why `CREDIT` is a vendor's only. **Named and bounded, with no field table**: a credit is evidenced here and posted out of band until `SLICE-007` gives it structure|
| `CashDisposition`| domain-model.md §6.12 — the precedent this record's shape follows|

## 7. States — *pointer*

| Machine| Home| States this feature drives|
|---|---|---|
| `FinancialAdjustmentResolution.status`| domain-model.md §6.15| `PROPOSED → APPROVED` · `PROPOSED → REJECTED` — a plain lifecycle field, not a signed machine, the same treatment `Redelivery.status` receives|
| `FinancialAdjustmentRequired.status`| domain-model.md §6.12| `OPEN → RESOLVED`, reached only through an approved resolution and by no Gate C operation|

## 8. Permissions — *pointer*

| Key| Holders| Scope| Home|
|---|---|---|---|
| `payment.adjustment.resolve`| Senior Ops, Platform Admin| own hub| [permissions.md](../../contracts/permissions.md) §7 — new this pass|
| `payment.adjustment.approve`| Finance, Platform Admin| all hubs, decider ≠ proposer| permissions.md §7 — new this pass|

**`OQ-005` named these `payment.refund.*`.** They are `payment.adjustment.*` because the
resolution covers credit, allocation and unclaimed disposition as well as refund, and a key named
for one of four outcomes would misdescribe the other three.

## 9. Settings — *pointer*

| Key| Why this feature reads it| Home|
|---|---|---|
| `unclaimed_adjustment_grace_days`| Gates `UNCLAIMED_DISPOSITION` — how long an unreachable payer's adjustment stays `OPEN` first. **90 days**| [settings.md](../../contracts/settings.md) §7.1|

## 10. Errors - *pointer*

| Code| When|
|---|---|
| `SELF_APPROVAL_FORBIDDEN`| The decider is the proposer| [errors-and-enums.md](../../contracts/errors-and-enums.md) §5|
| `STATE_CONFLICT`| Already resolved, already proposed, or the grace period has not elapsed| errors-and-enums.md §5|
| `VALIDATION_FAILED`| A field the class requires is absent| errors-and-enums.md §5|
| `PERMISSION_DENIED`| No grant, or another hub's adjustment| errors-and-enums.md §5|

No new error code. Every refusal this feature makes is already named.

## 11. Audit events — *pointer*

| Event| Enhanced?| Home|
|---|---|---|
| `payment.adjustment.resolution_proposed`| No| [audit.md](../../contracts/audit.md) §5 — new this pass|
| `payment.adjustment.resolution_decided`| **Yes**| audit.md §5 — new this pass; enhanced because approval moves money out|
| `payment.adjustment_required.created`| No| audit.md §5 — existing, the fact this feature answers|

## 12. API operations — *pointer*

| Operation| Home|
|---|---|
| `proposeAdjustmentResolution`| [openapi.yaml](../../contracts/openapi.yaml)|
| `decideAdjustmentResolution`| openapi.yaml|

---

## 13. Acceptance criteria

*§43.1 form. Every criterion cites its governing §, decision, or entity invariant.*

### `AC-ADJUST-01` — a vendor's adjustment resolves as a credit by default

```text
Given an OPEN FinancialAdjustmentRequired whose payer is a registered vendor,
When Senior Ops proposes a resolution without naming a class,
Then the proposal is recorded with resolution_class CREDIT and method VENDOR_BALANCE_CREDIT,
And no money leaves Melarc — the amount lands on VendorBalance for the weekly statement to net.
```
**Governs:** §27.1, `MSC-DEC-395` · **Surface:** API · **Test level:** integration

### `AC-ADJUST-02` — a vendor refund requires the vendor's recorded request

```text
Given an OPEN adjustment whose payer is a registered vendor,
When Senior Ops proposes resolution_class REFUND with no reason_code,
Then the response is 422 VALIDATION_FAILED,
And when the same proposal carries the vendor's request as reason_code, it is recorded.
```
**Governs:** `MSC-DEC-395` · **Surface:** API · **Test level:** integration · **Expected code on rejection:** `VALIDATION_FAILED`

### `AC-ADJUST-03` — a recipient cannot be credited

```text
Given an OPEN adjustment whose payer is a recipient or an AdHocSender,
When any client proposes resolution_class CREDIT,
Then the response is 422 VALIDATION_FAILED,
And the refusal cites that no balance exists for that payer — §49 places individual and ad-hoc
  credit outside Version 1.
```
**Governs:** §49, `MSC-DEC-395`, domain-model.md §6.15 · **Surface:** API · **Test level:** integration · **Expected code on rejection:** `VALIDATION_FAILED`

### `AC-ADJUST-04` — proposing moves nothing

```text
Given an OPEN adjustment,
When Senior Ops proposes any resolution,
Then the resolution status reads PROPOSED,
And the adjustment status still reads OPEN,
And payment.adjustment.resolution_proposed is emitted.
```
**Governs:** `MSC-DEC-395`, domain-model.md §6.15 · **Surface:** API · **Test level:** integration

### `AC-ADJUST-05` — Finance approves, and the approver is never the proposer

```text
Given a PROPOSED resolution raised by Senior Ops A,
When Senior Ops A attempts to decide it,
Then the response is 403 SELF_APPROVAL_FORBIDDEN,
And when a Finance holder decides it APPROVED, the resolution reads APPROVED and the adjustment
  reads RESOLVED,
And payment.adjustment.resolution_decided is emitted as an enhanced event.
```
**Governs:** `MSC-DEC-395`, permissions.md §7 · **Surface:** API · **Test level:** integration · **Expected code on rejection:** `SELF_APPROVAL_FORBIDDEN`

### `AC-ADJUST-06` — a rejection is kept and leaves the adjustment open

```text
Given a PROPOSED resolution,
When Finance decides it REJECTED with a reason_code,
Then the resolution is retained with status REJECTED and its reason,
And the adjustment status still reads OPEN,
And a fresh proposal may be made against the same adjustment.
```
**Governs:** `MSC-DEC-395` · **Surface:** API · **Test level:** integration

### `AC-ADJUST-07` — one adjustment, one live resolution

```text
Given an adjustment that already carries a PROPOSED resolution,
When a second proposal is made against it,
Then the response is 409 STATE_CONFLICT,
And no second resolution record is created — financial_adjustment_required_id is unique.
```
**Governs:** `MSC-DEC-395`, domain-model.md §6.15 · **Surface:** API · **Test level:** integration · **Expected code on rejection:** `STATE_CONFLICT`

### `AC-ADJUST-08` — the proposal cannot name an amount

```text
Given an OPEN adjustment for 5500 minor units,
When a client submits a proposal carrying an amount field,
Then the request is rejected as malformed — AdjustmentResolutionProposal declares
  additionalProperties false and no amount property,
And an accepted proposal always resolves the adjustment's own full amount.
```
**Governs:** `MSC-DEC-395` · **Surface:** contract · **Test level:** contract

### `AC-ADJUST-09` — an unclaimed disposition waits for the grace period

```text
Given an OPEN adjustment raised fewer than unclaimed_adjustment_grace_days ago,
When Senior Ops proposes UNCLAIMED_DISPOSITION,
Then the response is 409 STATE_CONFLICT,
And once the period has elapsed the same proposal is accepted with a mandatory reason_code.
```
**Governs:** §16.3, `MSC-DEC-395`, settings.md §7.1 · **Surface:** API · **Test level:** integration · **Expected code on rejection:** `STATE_CONFLICT`

### `AC-ADJUST-10` — a transfer method records its reference

```text
Given a proposal with resolution_class REFUND and method MERCHANT_MOMO_TRANSFER,
When it carries no reference,
Then the response is 422 VALIDATION_FAILED,
And a proposal carrying the transfer reference is recorded — the record evidences a movement
  Melarc made out of band, it does not instruct one.
```
**Governs:** §39.8, `MSC-DEC-395`, `MSC-DEC-323` (`CashDisposition`'s identical rule) · **Surface:** API · **Test level:** integration · **Expected code on rejection:** `VALIDATION_FAILED`

### `AC-ADJUST-11` — no ledger, no accounting entry

```text
Given any approved resolution of any class,
When the resulting records are read,
Then no journal entry, account code, financial period or ledger row exists anywhere in this
  contract,
And §14.1 keeps general accounting outside Version 1 — this feature records an operational act
  and the accounting treatment of it is not Version 1's.
```
**Governs:** §14.1, `MSC-DEC-395`, domain-model.md §6.15 · **Surface:** contract · **Test level:** contract

### `AC-ADJUST-12` — the returned order's refund now has a path

```text
Given a FinancialAdjustmentRequired raised by initiateReturn with reason PAID_OBLIGATION_VOIDED
  (MSC-DEC-394's CRIT-07 case, a recipient's collected portion on a returned order),
When Senior Ops proposes REFUND and Finance approves it,
Then the adjustment reaches RESOLVED,
And the class is REFUND rather than CREDIT because the payer is a recipient, which §49 leaves no
  balance to credit — the class MSC-DEC-394 chose is the one the baseline permitted.
```
**Governs:** `MSC-DEC-394`, `MSC-DEC-395`, §49 · **Surface:** API · **Test level:** integration

### `AC-ADJUST-13` — an approved credit is recorded, not posted

```text
Given an approved resolution with resolution_class CREDIT and method VENDOR_BALANCE_CREDIT,
When the vendor’s balance is read,
Then nothing in this contract has incremented it — VendorBalance carries no field table and no
  operation here posts to it,
And the resolution record is the evidence that the credit was approved and by whom, which the
  vendor-balance ledger consumes when SLICE-007 gives it structure.
```
**Governs:** §5.5, `MSC-DEC-395`, `OQ-005` · **Surface:** contract · **Test level:** contract

---

## 14. Open questions blocking this feature

| ID| What it blocks here| Type|
|---|---|---|
| `OQ-109`| The Hubtel merchant contract, which is why refunds are recorded out of band rather than executed| `EXTERNAL_INPUT`|
| `OQ-005`| Formal bank reconciliation and residual provider recovery. **The accounting-export format is no longer here** — specified 23 September 2026 at `MSC-DEC-401` by [accounting-export.md](accounting-export.md), though its feed waits on `OQ-131`. **Also `VendorBalance`'s structure**, which is why a `CREDIT` is evidenced rather than posted — that entity stays with `SLICE-007`| `ARTIFACT_REQUIRED`|
| `OQ-030`| No Ops Portal page inventory exists for this feature yet| `ARTIFACT_REQUIRED`|

None blocks the feature as written. **`OQ-126` closed at `MSC-DEC-396`** — the grace period is 90 days and
every class is now proposable. `OQ-109` is the reason the out-of-band shape is correct rather than a
limitation of it.

**`CONFLICT-040` and `CONFLICT-041` are not questions and are not listed above** — nothing is
missing in either; each needs a Product Owner ruling recorded in the owning contract, and both are `MSC-DEC-395`'s territory.
They sit inside this feature's own record and are named at §6, because the `UNIQUE` constraint and
the fresh-proposal invariant cannot both be built as written.

## 15. What this feature still owes its slice

| Owed| Blocks which DoR area| Owner|
|---|---|---|
| `SLICE-004` itself is unwritten — this is the first feature document under its eventual scope| F (acceptance and delivery)| Engineering — `SLICE-004`|
| An Ops Portal screen for the adjustment queue, proposal and Finance decision| D (frontend)| `OQ-030`|
| Formal bank reconciliation and residual provider recovery. **The immutable payment ledger is enumerated** (`domain-model.md` §5.5) and **the export format is specified** ([accounting-export.md](accounting-export.md), `MSC-DEC-401`), so neither is owed any longer; the export's feed is `OQ-131`'s| B, C| `OQ-005`, `OQ-131`|

## 16. Build status — *honest, per surface*

| Surface| Status| Gap|
|---|---|---|
| Melarc Ops| ⚪ not built| No Ops Portal page inventory; operations are specified, not implemented|
| Melarc Vendor| N/A| A vendor reads a balance and a statement, never this record|
| Melarc Rider| N/A| No rider surface reaches this feature|
| Recipient channel| N/A| A recipient has no account and no portal (§49)|

## 17. Related

- [cash-collection.md](../delivery/cash-collection.md) — where most adjustments originate, through
  a short tender, an over-tender or a duplicate payment
- [return-to-vendor.md](../returns/return-to-vendor.md) — `initiateReturn` raises a
  `PAID_OBLIGATION_VOIDED` adjustment; this feature is how that money gets back
- [daily-operations-and-cash-report.md](../reporting/daily-operations-and-cash-report.md) — the
  same domain's reporting half, opened first
- [accounting-export.md](accounting-export.md) — the domain's second feature, the canonical export
  that reads this record; its per-field derivability test is what surfaced `CONFLICT-040` and
  `CONFLICT-041`
- `delivery/IMPLEMENTATION_PLAN.md` §3 — `SLICE-004`, depends on `SLICE-003`, blocked by `OQ-005`
