# Vendor saved pickup locations

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.1 (cleaned edition)
> **Date:** 4 October 2026
> **Domain:** vendor
> **Owns:** the behaviour and acceptance criteria for **maintaining** a registered vendor's
> saved pickup locations — creating them, editing them, choosing the one default, and
> deactivating one without breaking the requests that already used it
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §29.4, §29.1, §35.12.6, §11.3
> **Slice:** `SLICE-008` Pass 3

> **Link paths in this document use `../../`** — correct from `features/vendor/<name>.md`.

## 1. What this is, and why

A registered vendor books from places it uses repeatedly. §29.4 lets it keep **multiple
saved pickup locations and one default**; §29.1 makes maintaining them an **Ops capability**
too, so both the vendor and authorised Ops can manage the list.

**The consumption side already exists and this feature does not touch it.** Gate C R1.2 gave
`PickupRequest` its `vendor_pickup_location_id`, its `use_vendor_default_destination` flag
and its derived `resolved_pickup_location`, and
[pickup-request.md](../pickup/pickup-request.md) owns how a request resolves an origin.
**What was missing is the other half**: the entity had no fields, `is_default` existed
nowhere in any contract, and no operation could add, edit, default or retire a location.

**Version 1 boundary.** This feature does **not** change how a request resolves its origin,
does not revalidate serviceability at save time — §11.3 requires it *"revalidated per
request"*, which is booking's job and not this one — and builds **no** hard delete, because
§8 already settles that: *"deactivation, not deletion."*

## 2. Governing sections

| Section| What it governs here|
|---|---|
| §29.4| The rule in full — multiple saved locations, **one default**, locations belong to the vendor record, serviceability checked **at booking**, and request overrides that do not silently mutate the saved list|
| §29.1| That maintaining saved pickup locations is an **internal Ops capability**, which is why the key is held by staff as well as the vendor|
| §35.12.6| The same rule as a business rule: *"a vendor may maintain multiple saved pickup locations and one default; every selected location remains subject to responsible-hub serviceability"*|
| §11.3| *"Per-request contact/location edits do not rewrite sender defaults or saved vendor locations"*, and *"serviceability is revalidated per request"*|
| §3.5| The location shape every address in this product uses. **No new location format is invented here**|
| §8| **Deactivation, not deletion** — §34.7 requires historical records to stay interpretable, which is why a retired location is retained|

**Decisions that shape this feature:** Gate C R1.2's `resolved_pickup_location` (the derived
origin this feature feeds and never overrides), `MSC-DEC-295` (the master-identity scope class
that makes a saved address globally readable to Ops), and §8's deactivation rule.

## 3. Surfaces and actors

| Surface| Actor| Can do| Gated by|
|---|---|---|---|
| Melarc Vendor| Vendor account| Add, edit, set default and deactivate **its own** saved locations| `vendor.pickup_location.manage` — **V: own vendor only**|
| Melarc Ops| Ops Staff, Senior Ops, Platform Admin| The same, on behalf of a vendor at their own hub (§29.1)| `vendor.pickup_location.manage` — **A S P: own hub**|
| Melarc Rider| Rider| **N/A.** A rider is sent to a `resolved_pickup_location` on a request, never to this list| —|

## 4. Preconditions

The `VendorOrganization` is `ACTIVE`. A suspended vendor's login is blocked (§29.6), so the
vendor cannot reach these operations at all; **Ops still can**, because suspension stops the
vendor's ordinary work rather than Ops' administration of the record.

---

## 5. Behaviour

*This section and §13 are the only sections with original content. Everything else points
elsewhere.*

### 5.1 Normal path

1. **A location is added** (`createVendorPickupLocation`) with a label and a §3.5 location.
   The **first** location a vendor ever saves becomes the default automatically — a vendor
   with exactly one saved location and no default would be a list whose default is
   unreachable by any act the vendor can perform.
2. **A location is edited** (`updateVendorPickupLocation`). Editing changes the saved record
   from that moment; it **does not** rewrite the `resolved_pickup_location` already
   snapshotted on any existing `PickupRequest` (§3.7).
3. **The default moves** (`setDefaultVendorPickupLocation`). Setting a new default clears the
   previous one in the same act, because **exactly one** default is the rule and two writes
   would leave a window with none or two.
4. **A location is retired** (`deactivateVendorPickupLocation`). It stops appearing for
   selection and **is retained**, because requests that used it must stay interpretable (§8).
5. **Booking is unchanged.** A request resolves its origin exactly as
   [pickup-request.md](../pickup/pickup-request.md) already specifies, and serviceability is
   revalidated **per request** (§11.3) rather than at save.

### 5.2 Exception paths

| Situation| Behaviour|
|---|---|
| Deactivating the **default** while another active location exists| Refused — `STATE_CONFLICT`. Set a new default first; the alternative is a vendor with locations and no default, which §29.4 does not allow|
| Deactivating the **last** active location| **Permitted.** A vendor may legitimately have none saved, and `COLLECT_FOR_VENDOR` and per-request origins do not depend on the list|
| A vendor acts on another vendor's location| Refused — `PERMISSION_DENIED`. Scope is **own vendor only**|
| Ops acts for a vendor at another hub| Refused — `PERMISSION_DENIED`. **A S P: own hub**|
| Setting a deactivated location as default| Refused — `STATE_CONFLICT`|
| Any act while the organisation is `SUSPENDED`| The vendor cannot reach it (login blocked, §29.6); **Ops may**, because §29.1's administration capability is not what suspension stops|

### 5.3 What this feature must never do

- **Never hard-delete a location.** §8: *"deactivation, not deletion"*, because §34.7 requires
  a past request's origin to stay interpretable.
- **Never rewrite a request.** A saved location is an input at booking; the authoritative
  origin is `PickupRequest.resolved_pickup_location`, snapshotted then. Editing or retiring a
  location changes nothing already booked, which is §3.7's snapshot rule and §11.3's
  *"per-request edits do not rewrite… saved vendor locations"* read from the other side.
- **Never leave zero or two defaults** on a vendor with at least one active location.
- **Never check serviceability here.** §29.4 and §11.3 both place it **at booking**, and
  revalidating at save would let a location saved while a zone was served look permanently
  valid. `pickup-request.md` owns it.
- **Never invent a location format.** §3.5 is the one shape.

## 6. Entities — *pointer*

`VendorPickupLocation` is detailed at
[domain-model.md](../../contracts/domain-model.md) §6.18, written for this pass — it was
named at §6.9 and carried no field detail. `PickupRequest` §6.2 is **unchanged**.

## 7. States — *pointer*

**None, and that is not an omission.** §36 gives this entity no machine, and it needs none:
`active` is a boolean condition with one reversible-by-design transition, not a lifecycle.
Inventing a machine here would add a signature obligation for a flag.

## 8. Permissions — *pointer*

[permissions.md](../../contracts/permissions.md) §7 — **`vendor.pickup_location.manage`**,
one new key, holders **A S P V**. Both halves are approved: §29.1 makes this an Ops
capability, §29.4 gives the vendor it. The `A S P V` shape is `pickup.request.create`'s,
already in the catalogue.

## 9. Settings — *pointer*

**None.** §29.4 sets no cap on how many locations a vendor may save, and inventing one would
be a limit nobody approved.

## 10. Errors — *pointer*

[errors-and-enums.md](../../contracts/errors-and-enums.md) §5. **No code is added** —
`STATE_CONFLICT`, `PERMISSION_DENIED`, `VALIDATION_FAILED`, `SESSION_INVALID` and
`CSRF_VALIDATION_FAILED` carry every refusal above.

## 11. Audit events — *pointer*

[audit.md](../../contracts/audit.md) §5.6d. Three codes, **none enhanced**: a saved address is
not authority, not money and not custody, so §38.5's categories do not reach it. **The default
move is recorded** because it silently changes where a later booking sends a rider.

## 12. API operations — *pointer*

`createVendorPickupLocation`, `updateVendorPickupLocation`,
`setDefaultVendorPickupLocation`, `deactivateVendorPickupLocation` —
[openapi.yaml](../../contracts/openapi.yaml). Reading the list is the existing
`vendor.read`; no read operation is added, because §29.8's profile is explicitly downstream.

---

## 13. Acceptance criteria

*§43.1 form. Every criterion cites its governing §, decision, or entity invariant.*

### `AC-VLOC-01` — the first saved location becomes the default

```text
Given an ACTIVE VendorOrganization with no saved pickup locations,
When createVendorPickupLocation is called with a label and a location,
Then the location is saved and active,
And is_default reads true,
And vendor.pickup_location.created is emitted.
```
**Governs:** §29.4 *(one default)* · **Surface:** API · **Test level:** integration

### `AC-VLOC-02` — a later location does not become the default

```text
Given a vendor with one active default location,
When a second createVendorPickupLocation succeeds,
Then the new location is active with is_default false,
And the original location is still the default.
```
**Governs:** §29.4 · **Surface:** API · **Test level:** integration

### `AC-VLOC-03` — exactly one default, moved in one act

```text
Given a vendor with locations A default and B not,
When setDefaultVendorPickupLocation is called for B,
Then B reads is_default true and A reads is_default false,
And exactly one active location of that vendor has is_default true,
And vendor.pickup_location.default_changed is emitted naming both.
```
**Governs:** §29.4, §35.12.6 · **Surface:** API · **Test level:** integration

### `AC-VLOC-04` — editing a location does not rewrite a booked request

```text
Given a PickupRequest whose resolved_pickup_location was taken from location A,
When updateVendorPickupLocation changes A's address,
Then the PickupRequest's resolved_pickup_location is unchanged,
And the saved location A reads the new address.
```
**Governs:** §11.3, §3.7 *(snapshot)* · **Surface:** API · **Test level:** integration

### `AC-VLOC-05` — deactivation retains the record

```text
Given an active non-default location A referenced by a past PickupRequest,
When deactivateVendorPickupLocation is called for A,
Then A reads active false,
And A remains readable through vendor.read,
And the past PickupRequest still resolves its origin.
```
**Governs:** §8 *(deactivation, not deletion)*, §34.7 · **Surface:** API · **Test level:** integration

### `AC-VLOC-06` — the default cannot be retired while alternatives exist

```text
Given a vendor with active locations A default and B not,
When deactivateVendorPickupLocation is called for A,
Then the call is refused with STATE_CONFLICT,
And A is still active and still the default.
```
**Governs:** §29.4 *(one default)* · **Surface:** API · **Test level:** integration

### `AC-VLOC-07` — the last location may be retired

```text
Given a vendor whose only active location is A, the default,
When deactivateVendorPickupLocation is called for A,
Then A reads active false,
And the vendor has no active saved location,
And no default exists.
```
**Governs:** §29.4 · **Surface:** API · **Test level:** integration

### `AC-VLOC-08` — a deactivated location cannot become the default

```text
Given a deactivated location A,
When setDefaultVendorPickupLocation is called for A,
Then the call is refused with STATE_CONFLICT.
```
**Governs:** §29.4 · **Surface:** API · **Test level:** integration

### `AC-VLOC-09` — a vendor reaches only its own locations

```text
Given vendors V1 and V2, each with saved locations,
When V1's session calls updateVendorPickupLocation for a location of V2,
Then the call is refused with PERMISSION_DENIED.
```
**Governs:** §29.4 *(locations belong to that vendor record)*, permissions.md §7 · **Surface:** API · **Test level:** integration

### `AC-VLOC-10` — Ops acts at their own hub only

```text
Given a VendorOrganization whose responsible hub is H1,
When Ops authorised only at H2 calls createVendorPickupLocation for it,
Then the call is refused with PERMISSION_DENIED.
```
**Governs:** §29.1, permissions.md §7 · **Surface:** API · **Test level:** integration

### `AC-VLOC-11` — serviceability is not evaluated at save

```text
Given a location whose zone the responsible hub does not currently serve,
When createVendorPickupLocation is called,
Then the location is saved and active,
And no serviceability check is performed by this operation,
And a later PickupRequest selecting it is the call that revalidates (§11.3).
```
**Governs:** §29.4, §11.3 *(serviceability is revalidated per request)* · **Surface:** API · **Test level:** integration

---

## 14. Open questions blocking this feature

| ID| What it blocks here| Type|
|---|---|---|
| `OQ-030`| No Ops Portal or Vendor PWA page inventory exists for this feature yet| `ARTIFACT_REQUIRED`|

**Nothing else.** §29.4 is short, approved and stated identically in four places, and this
pass invents no rule beyond it.

### §29.8 is reported here, because Pass 3 is where it would have been built

§29.8 asks for *"a searchable profile showing identity/contact, serving hub,
approval/suspension history, financial allowance, global-limit exposure,
statements/payments/returns, saved locations, parcel history, and audited privileged
changes"* — and closes with *"exact pages, schemas, evidence, retention, and exports remain
**downstream artifacts**."*

**Its two halves are in different states, and neither is a new gap.**

- **The audit half is satisfied.** §29.8's *"audited privileged changes"* is delivered by
  `audit.md` §5.6b and §5.6c, written at Passes 1 and 2: every privileged vendor act —
  approval, rejection, allowance in both directions, suspension, reactivation, disposition,
  escalation, termination — now emits an event, and all but the two maker acts are enhanced.
  Before this slice, **none of them existed**.
- **The profile half is explicitly downstream, by §29.8's own sentence.** Building a schema
  for it here would contradict the approved text. It is also **`OQ-030`'s** in the part that
  is a page inventory, and the read it would compose is available today as `vendor.read`
  against records that all now exist.

**No question is raised for §29.8**, because nothing about it is undecided: one half is done
and the other is deferred by the specification itself.

## 15. What this feature still owes its slice

| Owed| Blocks which DoR area| Owner|
|---|---|---|
| A Vendor PWA screen for the saved-location list, and an Ops Portal equivalent| D (frontend)| `OQ-030`|
| §29.8's searchable profile — **explicitly downstream artifacts** by §29.8's own words, not a gap this slice can close| D| §29.8, `OQ-030`|

**§29 is now covered in substance.** §29.1–§29.2 and §29.5 at Pass 1, §29.6 at Pass 2, §29.3
by [vendor-authentication.md](../identity/vendor-authentication.md), §29.7 by the ad-hoc
sender rules `pickup-request.md` already carries, §29.4 here, and §29.8 reported above.

## 16. Build status — *honest, per surface*

| Surface| Status| Gap|
|---|---|---|
| Melarc Vendor| ⚪ not built| No page inventory; operations specified, not implemented|
| Melarc Ops| ⚪ not built| Same|
| Melarc Rider| N/A| Not a party — a rider is sent to a request's resolved origin|

## 17. Related

- [pickup-request.md](../pickup/pickup-request.md) — owns how a request resolves its origin
  from this list, including `use_vendor_default_destination` and the criterion asserting that
  a per-request override leaves the saved location and default unchanged
- [vendor-onboarding-and-allowance.md](vendor-onboarding-and-allowance.md) — Pass 1, the
  `ACTIVE` record these locations hang from
- [vendor-suspension.md](vendor-suspension.md) — Pass 2, why a suspended vendor cannot reach
  these operations while Ops still can
- `delivery/IMPLEMENTATION_PLAN.md` §3 — `SLICE-008`, vendor administration
