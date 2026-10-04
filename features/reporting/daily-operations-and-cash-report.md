# Daily Operations & Cash Report

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.5 (cleaned edition)
> **Date:** 4 October 2026
> **Domain:** report
> **Owns:** the behaviour and acceptance criteria for a read-only, hub-day-scoped projection that
> makes one operating day's operations and money flow accountable in one view
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §32, §10.2, §16.3
> **Slice:** `SLICE-012` (unwritten; this is its first feature document)

> **Link paths in this document use `../../`** — correct from `features/reporting/<name>.md`.

## 1. What this is, and why

This is the report `hub-daily-operating-cycle.md` §15/§16 has owed since Gate C: a single view that
answers, for one hub and one business date, *what happened operationally* and *where the money
is*, without requiring a reader to open eight different records to find out. It is a **read-only
projection** over records other features already write — it never itself opens a `CashHandover`,
counts a hub, or resolves a variance. **Version 1 boundary**: this is the operational + payment/
reconciliation report family (Master Specification §32.3 items 1 and 3), scoped to one hub and
one dated business day. It is **not** the always-on live dashboard (§32.2/§10.2, a different,
continuous artifact), **not** the vendor-statement or fleet/fuel report families, and it creates
**no accounting entry** — Gate C's cash events are the source events the Accounting, Finance &
Reporting domain consumes, not produces. That domain opened 20 September 2026 at
`MSC-DEC-395`, and its canonical export is
[accounting-export.md](../payments/accounting-export.md) — a different artifact from this report.

## 2. Governing sections

| Section| What it governs here|
|---|---|
| §32 (32.1–32.4)| Reporting principles (derive from authoritative records, apply the same hub/role/vendor rules as the application); the operational and payment/reconciliation report families this feature implements; access, privacy, masking and audit obligations. §32.5's downstream design items — exact KPIs beyond what §13 states, retention, export scale — are explicitly left to `OQ-049` and not answered here|
| §10.2| The confirmed operational category set (pickup, hub receiving, dispatch/delivery, cash exceptions, fleet) this report's Operations section mirrors, as a dated snapshot rather than a live dashboard|
| §16.3| Financial closure principle — the direct authority for this feature's central discipline: operational and financial closure are distinct, and no terminal parcel or unresolved money may disappear from reporting|
| §21.1, §22, §24, §25, §26.3, §26.5 *(cross-cutting, via `hub-daily-operating-cycle.md`)*| The operational workflow and cash-reconciliation rules whose current state this report reflects. **Not restated here** — see §6–§7 below|
| §35| Business rules generally. None is invented in this feature; every figure is a read of an existing record|
| §40| Non-functional targets. Freshness/latency for this report are `OQ-049`'s, not assumed here|

**Decisions that shape this feature:** none new. It stands on `MSC-DEC-320`, `-321`, `-322`,
`-323`, `-325`, `-341`, `-344`, `-345`, `-356`, `-362`, `-365` — all already governing the
entities it points at — and on `OQ-005` and `OQ-049`.

## 3. Surfaces and actors

| Surface| Actor| Can do| Gated by|
|---|---|---|---|
| Melarc Ops| Senior Ops| View **their own hub's** report for a chosen business date — the HUB-OPS view| `report.read`, own-hub scope|
| Melarc Ops| Platform Admin, Finance, Executive| View **any hub's** report for a chosen business date, one hub at a time — the OWNER/management view| `report.read`, all-hubs scope|
| Melarc Ops| Ops Staff| **N/A, by decision.** No Ops Staff bundle holds `report.read` at any scope ([permissions.md](../../contracts/permissions.md) §7) — `MSC-DEC-393` confirms this is deliberate, not an oversight: the report's cash section is the reconciliation record of the day Ops Staff are personally executing, the same segregation-of-duties reasoning that withholds `payment.cash.confirm` from a rider declaring the matching figure|
| Melarc Vendor| Vendor account| **N/A.** No vendor-scoped read key exists for this report; §32.4's role/hub/vendor-ownership scoping does not extend a company money-flow view to a vendor's own-record visibility|
| Melarc Rider| Rider| **N/A.** This is a whole-hub-day management view, not an assigned-stop or assigned-run view any rider permission reaches|
| Recipient channel| —| **N/A** — no portal (per `surfaces/recipient-channel.md` §1)|

## 4. Preconditions

The requested hub exists; the caller holds `report.read` at a scope covering the requested
`hub_id`; the requested `business_date` is any date up to and including today (a future date is
a request for a day with no records yet, not an error — see §5.2).

---

## 5. Behaviour

*This section and §13 are the only sections with original content. Everything else points
elsewhere.*

### 5.1 Normal path

1. The caller (Senior Ops at their hub, or Platform Admin/Finance/Executive at any hub) requests
   `getDailyOperationsCashReport` for `{hub_id, business_date}`.
2. The server checks `report.read` at the scope covering `hub_id` — own-hub for Senior Ops,
   all-hubs for Platform Admin/Finance/Executive.
3. The server computes the projection **fresh, at read time**, from the source records named at
   §6 below — never from a cached or persisted copy, the same discipline `VendorOperationalEligibility`
   already follows ([domain-model.md](../../contracts/domain-model.md) §6.12, §6.13).
4. The response returns the Operations section and the Money-Flow section for that hub-day, plus
   `unreconciledExceptionsOpen` and `generatedAt`.
5. Where `hub-daily-operating-cycle.md`'s own end-of-day closing conditions (its §5.5) are not all
   true for that date, the report reflects that honestly — an open exception, an unreconciled
   variance, a non-empty review queue — rather than presenting a closed-looking day.

**Operations section**, by pointer only (§6):

- Packages received (`PickupIntake`), delivery attempts vs. successful doorstep deliveries
  (`DeliveryStop`), Station Drops and third-party dispatches (`Order.commercial_mode`), failed
  deliveries awaiting Ops review (`Order.fulfilment_state = AT_HUB_AFTER_FAILURE`), returns
  awaiting formal initiation (`ReturnRecord`), parcels held at the hub with no scheduled
  onward movement, and missed commitments (`delivery.commitment.breached`).

**Money-flow section**, by pointer only (§6):

- Expected vs. collected cash per rider (`RiderCashCustody` / `CashHandover`'s three figures —
  `system_expected_minor`, `declared_total_minor`, `confirmed_total_minor`), road expenses
  applied (`RoadExpense.applied_to_cash_handover_id`), hub cash reconciliation and its variance
  state (`HubCashReconciliation`), cash disposition (`CashDisposition`), and confirmed revenue
  grouped by the **five** `PaymentDemandLine.obligation_type` values this contract models
  (`DELIVERY_FEE`, `REDELIVERY_DELIVERY_FEE`, `REDELIVERY_FEE`, `SINGLE_PACKAGE_PICKUP_FEE`,
  `RETURN_FEE`). **Station Drop revenue is shown** as a `commercialMode`-tagged breakout of
  `DELIVERY_FEE` (Accounting Pass 2) — `Order.price_components_snapshot` already prices a
  Station Drop order through this same obligation type, joined via
  `OperationalPaymentDemand.order_id` to `Order.commercial_mode`; it was never a missing
  category, only an unbroken-out one. **Return-fee revenue is shown for the ad-hoc-sender
  settlement path** (`SLICE-006` Pass 1, `ReturnRecord`, domain-model.md §6.14) — **a registered
  vendor's return fee is not shown**, because it settles through the future `VendorStatement`
  mechanism and raises no demand line for this report to read, the same way
  `single_package_pickup_fee`'s own statement-posted case is invisible here today.

### 5.2 Exception paths

| Path| Behaviour| Error code|
|---|---|---|
| Validation failure| `business_date` missing or malformed| Framework-level request validation; no accounting fact is asserted either way|
| Unauthorized| No `report.read` grant at all, or held only at a scope that does not cover the requested hub| `PERMISSION_DENIED` — matching `getRunCashSummary` / `getVendorOperationalEligibility`'s own convention of not separately declaring `HUB_SCOPE_VIOLATION` on this class of read|
| Wrong state| **N/A.** A read has no state to conflict with; the report simply reflects whatever state the source records are in today, including "still open" — that is this feature's entire value, not a defect (§5.3)|
| Duplicate / replay| **N/A.** Safe read, no side effect, no `Idempotency-Key` — the same omission `getRunCashSummary` and `getVendorOperationalEligibility` make for the same reason|
| Concurrent edit| **N/A.** No write occurs here|
| Retry| **N/A by construction.** A `GET` is naturally re-issuable; a second identical call may return a newer figure if source state changed between calls, which is correct read behaviour, not a retry failure|
| Offline (rider surfaces)| **N/A.** Ops Portal desktop-first surface only (§10.1); not a rider capability, so §19.8 does not apply|
| Missing configuration| **N/A.** This feature reads no setting of its own; every figure comes from records written under other features' own settings-gated behaviour|
| Cancellation / reversal| **N/A.** Nothing here is cancellable; requesting a different date or hub is simply another read|

### 5.3 What this feature must never do

- **Never compute a business rule the underlying entity does not already carry.** No independent
  "expected cash" formula — it reads `CashHandover.system_expected_minor`. The plausible mistake
  is re-deriving a figure "for display convenience" and drifting from the record that owns it.
- **Never write anything.** A tempting extension is "and let Ops correct a stray total from this
  screen" — that would collapse the operational/financial separation §16.3 requires to stay
  visible, and would put a write inside a feature whose entire authority is a read permission.
- **Never present a hub-day as closed or clean while a source record for that day carries an open
  exception** (`VARIANCE_OPEN`, `EXCEPTION_OPEN`). §16.3 forbids unresolved money becoming
  invisible; a tidy-looking report over a live variance is exactly that.
- **Never invent a revenue category the contracts do not model.** `revenueByType` reads
  `PaymentDemandLine.obligation_type` and nothing else. When this document was first written,
  Station Drop and return-fee revenue were real, priced, approved product concepts (§24.7.1,
  §28.4) with no demand-line representation, and `OQ-123` was raised rather than a line invented;
  both are representable now — Station Drop as a `commercialMode` breakout of `DELIVERY_FEE`, the
  ad-hoc-sender return fee as `RETURN_FEE` — and `OQ-123` is closed. **The rule outlives the
  example**: a registered vendor's return fee still raises no demand line, because it settles
  through the future `VendorStatement` mechanism, and the plausible mistake is adding a
  row for it here "since the business clearly has this revenue." It does not enter this contract
  layer's shape by a feature document's decision.
- **Never let scope leak.** The same `report.read` key serves two audiences; the grant's scope —
  never a client-supplied flag or query parameter — decides what hub(s) are visible, identically
  to how `payment.read` and `vendor.read` already split Finance's all-hub access from an
  own-hub actor's.

---

## 6. Entities — *pointer*

| Entity| Home|
|---|---|
| `DailyOperationsCashReport`| [domain-model.md](../../contracts/domain-model.md) §6.13 — `DERIVED-PROJECTION`, this feature's own entity|
| `RiderCashCustody`, `CashHandover`| domain-model.md §6.11|
| `HubCashReconciliation`, `CashDisposition`, `RoadExpense`, `OperationalPaymentDemand`, `PaymentDemandLine`, `PaymentReceipt`, `PaymentAllocation`| domain-model.md §6.12|
| `PickupIntake`| domain-model.md §6.6|
| `DeliveryStop`, `DeliveryRun`| domain-model.md §6.10|
| `Order` (`commercial_mode`, `fulfilment_state`)| domain-model.md §6.7|
| `ReturnRecord`| domain-model.md §6.14 — fully fielded at `SLICE-006` Pass 1; this feature reads its existence for a count and its `RETURN_FEE` demand line for revenue|

## 7. States — *pointer*

| Machine| Home| States this feature drives|
|---|---|---|
| `RiderCashCustody`| [state-machines.md](../../contracts/state-machines.md) §16.3| **None** — reads current state only|
| `CashHandover`| state-machines.md §16.4| **None**|
| `HubCashReconciliation`| state-machines.md §20.2| **None**|
| `RoadExpense`| state-machines.md §20.1| **None**|
| `Order.fulfilment_state`| state-machines.md §9| **None**|
| `DeliveryStop.state`| state-machines.md §12.1| **None**|

This feature drives no transition on any machine. It is a reader of current state, full stop.

## 8. Permissions — *pointer*

| Key| Holders| Scope| Home|
|---|---|---|---|
| `report.read`| Senior Ops, Platform Admin, Finance, Executive| own hub (Senior Ops) · all hubs (Platform Admin, Finance, Executive)| [permissions.md](../../contracts/permissions.md) §7|

**No new permission key is proposed.** `report.read` already exists, approved, and its existing
`own hub · all hubs` scope axis is exactly the HUB-OPS-vs-OWNER split this feature needs. **Ops
Staff holds no grant for this key, and `MSC-DEC-393` confirms that is deliberate** — not a gap
`OQ-124` left open, which is now closed. permissions.md §8's read-only bundles — **Auditor and
Executive/Report-consumer, two rather than three since `MSC-DEC-396` settled that
Finance/Reconciliation reads and acts** — carry `report.read` only as **"Proposed contents"**;
this feature relies only on the approved holder row in permissions.md §7's main read-key table,
not on that proposed bundle mapping.

## 9. Settings — *pointer*

None. This feature introduces no configurable value. §32.5's downstream figures — report
retention, freshness/latency thresholds, export scale — remain `OQ-049`'s and are not assumed
here.

## 10. Errors - *pointer*

| Code| When|
|---|---|
| `PERMISSION_DENIED`| No `report.read` grant, or held at a scope that does not cover the requested hub| [errors-and-enums.md](../../contracts/errors-and-enums.md) §5|
| `SESSION_INVALID`| No usable authenticated session| errors-and-enums.md §5|

No new error code. `HUB_SCOPE_VIOLATION` is deliberately not declared for this operation,
matching `getRunCashSummary` and `getVendorOperationalEligibility`'s own convention on this
class of hub-scoped read.

## 11. Audit events — *pointer*

**N/A.** This feature performs no write, so it emits no event. Neither of the two GET
operations this feature's own contract addition is modelled after — `getRunCashSummary`,
`getVendorOperationalEligibility` — carries an audit event either; a read is not separately
audited anywhere in this catalogue unless it is an export, and this pass adds no export
operation (§32.4's export-audit requirement is therefore out of scope here, not silently
dropped).

## 12. API operations — *pointer*

| Operation| Home|
|---|---|
| `getDailyOperationsCashReport`| [openapi.yaml](../../contracts/openapi.yaml)|

---

## 13. Acceptance criteria

*§43.1 form. Every criterion cites its governing §, decision, or entity invariant.*

### `AC-REPORT-01` — successful-delivery count reflects source truth

```text
Given a hub-day with N DeliveryStop records in state DELIVERED,
When the report is requested for that hub and business date,
Then operations.successfulDeliveriesCount equals N exactly,
And no stop in any other state is counted toward it.
```
**Governs:** §32.1, domain-model.md §6.10 · **Surface:** API · **Test level:** integration · **Expected code on rejection:** N/A (positive case)

### `AC-REPORT-02` — expected-cash total reflects source truth

```text
Given a hub-day with CashHandovers h1..hn opened against it,
When the report is requested for that hub and business date,
Then the sum of moneyFlow.riderCashPositions[].systemExpectedMinor equals the sum of
  system_expected_minor across h1..hn exactly,
And no figure is independently recomputed from gross cash or expenses by this report.
```
**Governs:** §26.3, `MSC-DEC-320`, domain-model.md §6.11 · **Surface:** API · **Test level:** integration

### `AC-REPORT-03` — an open variance is shown as unreconciled, never clean

```text
Given a hub-day whose HubCashReconciliation is in state VARIANCE_OPEN,
When the report is requested for that hub and business date,
Then unreconciledExceptionsOpen is true,
And moneyFlow.hubCashReconciliation.state reads VARIANCE_OPEN,
And the day is not presented as closed by any other field.
```
**Governs:** §16.3, `MSC-DEC-321`, `MSC-DEC-325` · **Surface:** API · **Test level:** integration

### `AC-REPORT-04` — no permission, no report

```text
Given an authenticated Ops Staff session holding no report.read grant,
When getDailyOperationsCashReport is requested for any hub and date,
Then the response is 403 PERMISSION_DENIED,
And no report content is returned in the response body.
```
**Governs:** §37.1 (deny by default), permissions.md §7 · **Surface:** API · **Test level:** integration · **Expected code on rejection:** `PERMISSION_DENIED`

### `AC-REPORT-05` — own-hub scope does not reach another hub

```text
Given a Senior Ops session holding report.read at own-hub scope for Hub A,
When getDailyOperationsCashReport is requested for Hub B,
Then the response is 403 PERMISSION_DENIED,
And no figure from Hub B is returned in the response body.
```
**Governs:** permissions.md §7 (`report.read` scope axis), §32.4 · **Surface:** API · **Test level:** integration · **Expected code on rejection:** `PERMISSION_DENIED`

### `AC-REPORT-06` — all-hub scope serves the owner/management view

```text
Given a Platform Admin, Finance or Executive session holding report.read at all-hubs scope,
When getDailyOperationsCashReport is requested for any hub the platform operates,
Then the response is 200 with that hub's report,
And requesting a second hub in a further call returns that hub's own figures, never a
  merged cross-hub total this feature does not compute.
```
**Governs:** permissions.md §7, §32.2, §10.2 · **Surface:** API · **Test level:** integration

### `AC-REPORT-07` — revenue by type never invents a category or a settlement path

```text
Given a hub-day with confirmed revenue against DELIVERY_FEE and REDELIVERY_FEE lines, an
  ad-hoc sender's settled RETURN_FEE demand, and a registered vendor's ReturnRecord earning a
  return fee the same day (settlement_path STATEMENT, no demand raised),
When the report is requested for that hub and business date,
Then moneyFlow.revenueByType contains only entries whose obligationType is one of
  DELIVERY_FEE, REDELIVERY_DELIVERY_FEE, REDELIVERY_FEE, SINGLE_PACKAGE_PICKUP_FEE, RETURN_FEE,
And the ad-hoc sender's RETURN_FEE entry reflects only their confirmed principal,
And the registered vendor's earned-but-statement-settled return fee does not appear in
  revenueByType under any label — it has no demand line to be read from.
```
**Governs:** domain-model.md §6.13, §6.12/§6.14 (`PaymentDemandLine.obligation_type`), `OQ-005`, `OQ-123` (closed at `SLICE-006` Pass 1) · **Surface:** API · **Test level:** integration

### `AC-REPORT-08` — missed commitments tie to the detection mechanism, not a live query

```text
Given sweep_missed_commitments has emitted delivery.commitment.breached exactly once today
  for hub H,
When the report is requested for hub H and today's business date,
Then operations.missedCommitmentsCount equals 1,
And the count is derived from the audit event, not from an independent commitment-date
  comparison this feature invents.
```
**Governs:** `hub-daily-operating-cycle.md` §5.5, `AC-OPS-04`, audit.md §5.3 · **Surface:** API · **Test level:** integration

### `AC-REPORT-09` — a legitimately active run is not read as a shortage

```text
Given a rider on an active run past cash_reconciliation_cutoff_time holding collected cash
  not yet handed to the hub,
When the report is requested for that hub and business date,
Then that rider's entry in moneyFlow.riderCashPositions shows an open (not yet CONFIRMED or
  RECONCILED) CashHandover state where one exists, or no handover row at all where none has
  been opened,
And the rider is not presented as short or delinquent by this report,
And this rule is reflected from hub-daily-operating-cycle.md's own AC-OPS-02, never
  re-derived independently here.
```
**Governs:** `MSC-DEC-324`, `hub-daily-operating-cycle.md` `AC-OPS-02` · **Surface:** API · **Test level:** integration

### `AC-REPORT-10` — the report states its own freshness

```text
Given any valid request for an existing hub and business date,
When the report is returned,
Then generatedAt is a timestamp no earlier than the request's receipt time,
And a second request one minute later, against unchanged source records, returns the same
  figures with a later generatedAt — proving computation, not a cached copy.
```
**Governs:** §10.2 ("identify freshness"), §32.2, domain-model.md §6.13 (`DERIVED-PROJECTION`) · **Surface:** API · **Test level:** integration

### `AC-REPORT-11` — Station Drop revenue is a breakout, not a missing category

```text
Given a hub-day with a DELIVERY_FEE demand line settled against a doorstep order, and a second
  DELIVERY_FEE demand line settled against a Station Drop order (Order.commercial_mode =
  STATION_DROP),
When the report is requested for that hub and business date,
Then moneyFlow.revenueByType contains a DELIVERY_FEE entry with commercialMode = STATION_DROP
  carrying only the Station Drop order's confirmed principal,
And a separate DELIVERY_FEE entry with commercialMode null carrying only the doorstep order's
  confirmed principal,
And neither entry's confirmedMinor includes the other's.
```
**Governs:** domain-model.md §6.12 (revised "Where a demand comes from" table, Pass 2), §6.7 (`Order.commercial_mode`, `price_components_snapshot`), §24.7.1, `OQ-123` · **Surface:** API · **Test level:** integration

---

## 14. Open questions blocking this feature

| ID| What it blocks here| Type|
|---|---|---|
| `OQ-049`| Exact KPI formulas beyond §13's testable criteria, data dictionary, masking detail, export scale, report retention| `ARTIFACT_REQUIRED`|
| `OQ-030`| No Ops Portal page inventory exists for this report yet| `ARTIFACT_REQUIRED`|

**`OQ-123` closed** at `SLICE-006` Pass 1 — both fees it originally raised are now representable
to the extent approved authority permits (Station Drop fully; the return fee for the
ad-hoc-sender settlement path, with the registered-vendor path deferred to `OQ-005`'s future
`VendorStatement` mechanism, not this report's to build).

**`OQ-124` closed** by `MSC-DEC-393` — Ops Staff holds no `report.read` grant, by decision, not
by gap. `VALUE_REQUIRED`/`EXTERNAL_INPUT` questions would block launch, not this document; neither
of the two remaining rows is that type, so neither blocks approval of the behaviour and criteria
as written — each blocks a narrower, named thing, stated in its own row.

## 15. What this feature still owes its slice

| Owed| Blocks which DoR area| Owner|
|---|---|---|
| `SLICE-012` itself is unwritten — this is the first feature document under its eventual scope| F (acceptance and delivery)| Engineering — `SLICE-012`|
| An Ops Portal screen| D (frontend)| `OQ-030`|
| Exact KPI formulas, masking detail, retention, export| B, C| `OQ-049`|

## 16. Build status — *honest, per surface*

| Surface| Status| Gap|
|---|---|---|
| Melarc Ops| ⚪ not built| No Ops Portal page inventory exists for this report; the operation is specified, not implemented|
| Melarc Vendor| N/A| Not a vendor capability (§3 above)|
| Melarc Rider| N/A| Not a rider capability (§3 above)|
| Recipient channel| N/A| No portal|

## 17. Related

- [hub-daily-operating-cycle.md](../operations/hub-daily-operating-cycle.md) — the operational
  cycle whose closing state (§5.5) this report surfaces; this feature restates none of its
  behaviour and points at its acceptance criteria (`AC-OPS-02`, `AC-OPS-04`) rather than
  duplicating their logic
- [exception-ownership-matrix.md](../operations/exception-ownership-matrix.md) — who owns each
  exception this report can show as open
- [cash-collection.md](../delivery/cash-collection.md) — where `RiderCashCustody` and the
  Receive Money engine's collection behaviour are specified
- [return-to-vendor.md](../returns/return-to-vendor.md) — where `ReturnRecord` and the
  `RETURN_FEE` obligation this report now shows are specified (`SLICE-006` Pass 1)
- [accounting-export.md](../payments/accounting-export.md) — the **accounting** export, a
  different artifact with different authority (`MSC-DEC-401`, `payment.ledger.export`, owned by
  `OQ-005`); this report's own CSV export stays `OQ-049`'s
- `delivery/IMPLEMENTATION_PLAN.md` §3 — `SLICE-012`, depends on `SLICE-004`, blocked by `OQ-049`
