# Hub Intake

> **Status:** ACTIVE SPECIFICATION — implementation status is stated separately
> **Version:** 0.12 (Run D revision: receiving by run on the door photos)
> **Date:** 4 October 2026; revised 16 November 2026
> **Domain:** `hub`
> **Owns:** the behaviour and acceptance criteria for the custody boundary — rider handover, the receiving of a run against the rider's door photos, the blind count of a stop with no photos, and OS&D
> **Governed by:** [PROJECT_MASTER_SPECIFICATION.md](../../PROJECT_MASTER_SPECIFICATION.md) §22, §35.5, §36.6 (the blind-receive rule as revised on 16 November 2026)
> **Slice:** `SLICE-001`

**Status of this revision.** The flow of §5.1 and §5.4 to §5.8 is the Product Owner's decision of 15 and 16 November 2026 (D-D1 to D-D8, recorded in [the plan's §11](../../delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md#11-decisions-recorded)). It is **designed here and not built**: what S1.31 to S1.35 built is the blind-count mode, which stays for the stops with no photos ([§5.5](#55-a-stop-with-no-parcel-photos-the-blind-count)), and the check-in of a run is built by S1.35a to S1.35c. Text marked *as built* describes Run C's build and still holds for the blind-count mode. **A reading of mine, where the decisions are silent, is marked provisional** and listed in the plan's §11 for the Product Owner. The words an officer reads are drafts; the vocabulary on the floor is run, vendor, parcels, check in, missing, extra, damaged and decide.

## 1. What this is, and why

Hub receiving is **the custody boundary** between rider road operations and Melarc's controlled inventory. §22.1 is emphatic that it "must be a distinct act, **not an automatic consequence of rider pickup completion**."

**How a run is checked (D-D1, D-D2).** The rider photographed every parcel at the door ([pickup-collection.md §5.5](../pickup/pickup-collection.md#55-the-photo-of-every-parcel)), and the officers who receive the run **see those photos from the handover on** (and on the stop's page before it, which is where early itemizing starts: [itemization.md](itemization.md)). Receiving is the check of the parcels on the table against those photos: the officer opens a **run**, each vendor on it is a section with its photos, and each parcel is checked in against its photo. **Nothing is hidden from the officer, and no number is typed for a vendor with photos**: the count of an intake is the number of its parcels checked in. This replaces the blind count (§22.4 as first written) for every stop that has parcel photos.

**The blind count stays for one case (D-D3).** A stop Ops let through without parcel photos (the camera failed) has none to check against, so its intake is **counted blind**, as Run C built it: the officer types the number of parcels before the rider's number is shown, and a mismatch goes to the senior officer ([§5.5](#55-a-stop-with-no-parcel-photos-the-blind-count)).

**Version 1 boundary.** Intake establishes what arrived and in what condition. It does not price, does not itemize, and does not decide dispatch. It ends when the parcels are checked in (or the count is made), the discrepancy workflow is closed and the intake is eligible for itemization.

## 2. Governing sections

| Section| What it governs here|
|---|---|
| §22.1| Receiving as a distinct custody act|
| §22.2| Rider handover — availability, count rows, pre-fill with correction, idempotency, offline|
| §22.3| The awaiting-receive queue, and what it must not expose (for a blind-count intake)|
| §22.4| The blind receive (now the mode of a stop with no photos; the check-in of §5.4 is the mode of every other)|
| §22.5| OS&D — three independent dimensions, fixed condition enum, senior review|
| §22.6| Intake lifecycle|
| §22.7| Count-parity control — the hub count is the close authority|
| §22.8| Concurrency and the advisory soft lock|
| §22.9| What vendors may see|
| §35.5| Hub-receiving rules|
| D-D1 to D-D8| The Product Owner's decisions of 15 and 16 November 2026 that this revision records|


## 3. Surfaces and actors

| Surface| Actor| Can do| Gated by|
|---|---|---|---|
| Melarc Rider| Rider| Submit the handover after all stops are terminal; correct the pre-filled count before submission| `hub.handover.submit` — owned completed run|
| Melarc Ops| Ops Staff| See the queue of runs, a run and the missing list| `hub.read`|
| Melarc Ops| Ops Staff| Open a run; check in a vendor's parcels (tap each photo, or confirm "All N here"); add a parcel that is not on the list; record a damaged parcel; check in a missing parcel that is found; finish a vendor; type the count of a stop with no photos; hold the advisory lock| `hub.intake.count`|
| Melarc Ops| Senior Ops| Decide a case (still searching, accept, write off, record that the vendor was told); correct a count or a check-in with a reason| `hub.osd.adjudicate`|
| Melarc Ops| Platform Admin| The same as Senior Ops; reopen a closed intake — privileged and audited| `hub.osd.adjudicate`, `hub.intake.reopen`|
| Melarc Vendor| Vendor account| **Receives the intake-completed and order summary only.** The check-in, the rider declaration, discrepancy evidence and internal adjudication are Ops-only (§22.9)| —|

No new permission key is made: each new act uses the key of the kind of act it is ([§8](#8-permissions--pointer)).

## 4. Preconditions

- The manifest is `COMPLETED` — handover is available only after **all** run stops are terminal (§22.2).
- At least one stop collected a non-zero count. **A zero collected count must never produce a completed handover or an empty intake** (§22.2, `MSC-DEC-120`).
- **The intake has a receiving mode, fixed by the handover from its stop:** *photo check-in* (`PHOTO_CHECK_IN`) when the stop's count carries door photos, *blind count* (`BLIND_COUNT`) when Ops let the count through without them. No writer chooses it and no act changes it.

---

## 5. Behaviour

### 5.1 Normal path

*Photo check-in, the mode of a stop with door photos. Designed (Run D); the state names are the machine's and stay (state-machines.md §7): `AWAITING_COUNT` reads "waiting to be checked in" and `COUNTED` "checked in".*

1. **The custody holder submits the handover** — one row per pickup request collected on the run (§22.2, `MSC-DEC-416`), each **pre-filled from that request's collected total and correctable before submission**, with a read-only total. It carries the device's capture time, is idempotent, and is Version 1's one offline command. **Each row opens one intake**; a request with nothing collected has no row and no intake. **A zero row is legal** — that request's parcels are not in the handover — and its intake opens all the same. **A stop whose count carries door photos opens its intake in photo mode with one expected parcel for each door photo, in the order the photos were taken; a stop Ops let through without photos opens in blind-count mode, with none.**
2. **The receiving queue is by run** (`listReceivingRuns`): one row for each run that has intakes to receive, naming the run's code, the rider and the vendors **by name** (never a phone number), how many parcels are expected, how long it has waited since the handover and who is checking in (§22.3). It carries a count of what waits, a hub filter, and a lookup that finds a run by its code and an intake by its run or vendor.
3. **The officer opens the run** (`getReceivingRun`). Each vendor is a section with its name and its door photos as thumbnails ("Kente Crafts — 12 parcels photographed"). **The advisory lock** (`acquireIntakeLock`, §22.8) is taken on the officer's **first act on a vendor, not by opening the page**, and the page says in one plain line who opened the check-in and when ("Ama Owusu opened this check-in at 09:12") and that it stops nobody. **As built (S1.32):** the idle time is the hub's `intake_lock_idle_ttl_minutes` and a hub with no usable value offers no takeover; the lock never moves the intake's `ETag`, so a check-in or a count is refused for the facts of the intake and never for a lock; an intake that is no longer waiting takes no lock ([state-machines.md §7](../../contracts/state-machines.md#7-pickupintake)).
4. **The counted pile matches: "All N here".** The officer chooses *All 12 here*; a confirmation names the vendor and the number ("Confirm 12 parcels from Kente Crafts? I counted 12 parcels from this vendor on the table."), shows the photos small, and offers *Cancel* and *Yes, all 12 are here*. **Nothing is recorded until it is confirmed.** Confirmed (`finishCheckIn` with `all_arrived` and `confirmed_count`), every photographed parcel of that vendor is `ARRIVED`, recorded with the officer and the time the database took, and the vendor is finished: the intake is counted at that number, the variance `MATCH`.
5. **The counted pile differs: photo check-in.** *The count is different* turns the section into a check-in: the officer taps each parcel's photo as it is found (`recordParcelArrival`; a second tap, while the vendor is open, takes it back). **Nothing is typed.** *Finish this vendor* (`finishCheckIn` with `all_arrived` false) marks every parcel not tapped **missing**, each shown with its picture, and counts the intake at the number checked in.
6. **A parcel on the table with no door photo: "Add a parcel not on the list".** The officer photographs it with the camera (`addExtraParcel`, a stored photo of the intake is required): it is an **extra** at the hub, `ARRIVED` at once and counted in the hub count (variance `OVER`). An extra added by mistake is taken back by the officer while the vendor is open (`recordParcelArrival` with `arrived` false: the parcel is `VOID`) and by a senior's correction after.
7. **Damage is recorded on the parcel's own photo:** *Damaged*, with a camera photo and a note (`recordIntakeCondition` naming the parcel): a finding of that parcel and not of the whole intake, recorded **once for each parcel** and sent to the senior's decision ([§5.6](#56-missing-extra-and-damaged-parcels)).
8. **Finishing the run** shows what the officer has to act on: what **arrived**, what is **missing** (each with its picture), what is **extra**, what is **damaged**, and the reminder *check the rider's bag before they leave*. The run is finished when every one of its vendors has been; the summary is read from recorded facts (`getReceivingRun`) and no number is typed.
9. **The count of an intake is the number of its parcels checked in as arrived, the extras that are not void included.** It is written when the vendor is finished, with the officer and the database's moment, and the variance and the difference are against the **expected** number (the door photos). **The System then moves the intake**: to `READY_FOR_ITEMIZATION` only when no parcel is missing, no extra stands, no condition other than `OK` was found and the declaration is above zero; to `RECONCILIATION_REQUIRED` otherwise, **a missing parcel and an extra of equal number included** (§22.5, [state-machines.md §7](../../contracts/state-machines.md#7-pickupintake)). `hub.intake.counted` is written once, when the vendor is finished.
10. **The senior decides every case in `RECONCILIATION_REQUIRED`** ([§5.7](#57-the-seniors-decision)): missing parcels are searched for first, inside the hub, and the case stays open in the *Missing — being searched for* list until a senior officer closes it.
11. **The intake records `received_at`, `received_by` and the hub received count** and becomes eligible for itemization (§22.4 steps 6–7), where itemizing may already have begun from the photos ([itemization.md](itemization.md)).

*A stop with no photos follows [§5.5](#55-a-stop-with-no-parcel-photos-the-blind-count) instead of steps 4 to 9: the officer types the count before the rider's number is shown.*

### 5.2 Exception paths

The `details.rule` of every `STATE_CONFLICT` below is in [errors-and-enums.md](../../contracts/errors-and-enums.md#53a-the-rules-of-the-receiving-sides-refusals).

| Path| Behaviour| Error code|
|---|---|---|
| **Declaration served before commit** (blind-count intakes)| The read model must not carry it. §22.3: the queue "must not expose the rider-declared count before the receiver submits the blind physical count"| `BLIND_COUNT_VIOLATED` — an internal invariant, never a response to a client request; tested as an absence|
| **Client submits the declaration as input** (blind count)| Refused. §22.4: "the client must never submit the hidden declared count as authoritative input"| `VALIDATION_FAILED` — the count request is `additionalProperties: false`|
| **A blind count of a photo intake**| Refused: a stop with photos is checked in and never counted blind| `STATE_CONFLICT` (`photo_check_in`)|
| **A check-in of a blind-count intake**| Refused: the stop has no photos to check against| `STATE_CONFLICT` (`blind_count_intake`)|
| **"All N here" with a number that is not the expected count**| Refused and nothing recorded: the photos or the intake changed since the officer read them| `STATE_CONFLICT` (`count_changed`)|
| **"All N here" with an extra on the table**| Refused: a pile with an extra is not "all N here"; the officer finishes the vendor as tapped| `STATE_CONFLICT` (`has_extra_parcels`)|
| **A parcel changed after its vendor is finished**| Refused. A missing parcel that is found is checked in while the case is open (§5.6); every other change is a senior's correction (§5.8)| `STATE_CONFLICT` (`check_in_finished`)|
| Count variance `SHORT` or `OVER`, a missing parcel or an extra| Intake moves to `RECONCILIATION_REQUIRED`; the discrepancy workflow runs| —|
| Condition `DAMAGED` or `TAMPERED`| **Supporting evidence and controlled review are required**, and senior review is mandatory (§22.5). `adjudicateDiscrepancy`'s `condition` enum carries all four §22.5 values and `evidence_ids` gates on a `STORED` reference (HIGH-11 audit remediation)| `PERMISSION_DENIED`, `REASON_REQUIRED`, `EVIDENCE_NOT_STORED`|
| **Condition finding on a matching count**| Fully supported. §22.5: damage, tampering or dispute "may be recorded even when the physical count matches"| —|
| **A condition recorded twice**| **Once for a parcel** (photo mode) **or once for an intake** (blind-count mode), judged by the finding history and held by the database for every writer (D-D7, migration `0097` for the intake). Only a senior officer changes a condition after deciding| `STATE_CONFLICT` (`condition_already_recorded`)|
| **A condition for the whole intake in photo mode**| Refused: damage on a photographed stop is a parcel's| `VALIDATION_FAILED` (rule `parcel_required`)|
| **A damaged parcel that has not arrived**| Refused: a condition is found on a parcel that is on the table| `STATE_CONFLICT` (`parcel_not_arrived`)|
| **An extra with no stored photo**| Refused: an extra at the hub needs its photo| `EVIDENCE_NOT_STORED`|
| Two receivers on one intake| The soft lock shows the active receiver; takeover after idle TTL. **The lock is advisory** — §22.8 requires backend transition and idempotency controls regardless| `STATE_CONFLICT`|
| **"Vendor told" before a write-off, or a second time**| Refused: it is a record that follows a write-off, made once ([§5.7](#57-the-seniors-decision))| `STATE_CONFLICT` (`not_written_off`, `vendor_already_told`)|
| **A senior's correction with no reason, by Ops Staff, or after itemizing began**| Refused ([§5.8](#58-a-seniors-correction))| `REASON_REQUIRED`, `PERMISSION_DENIED`, `STATE_CONFLICT` (`itemization_started`)|
| Handover before all stops terminal| Refused (§22.2)| `STOPS_UNRESOLVED`|
| Zero collected count reaching here| Impossible by rule — routed to pickup failure upstream| `ZERO_COLLECTION_IS_FAILURE`|
| **Zero declared for a collected request**| Legal. The intake opens; once it is counted (or its check-in finished) it goes to `RECONCILIATION_REQUIRED` whatever the variance, and **Senior Ops** resolves it with a reason| `PERMISSION_DENIED` for anyone else (a missing key is never `INSUFFICIENT_AUTHORITY`)|
| Handover rows not exactly the run's collected requests| Refused — a row omitted, repeated, or naming a request not collected on the run| `VALIDATION_FAILED`|
| Same idempotency key, different rows| Refused| `IDEMPOTENCY_KEY_CONFLICT`|
| Run with nothing collected| No handover and no intake: System completes the run (`MSC-DEC-416`, [pickup-manifest.md](../pickup/pickup-manifest.md))| —|
| Rider offline at handover| Queues and retries under the approved offline interaction (§22.2) — Version 1's one offline command. Each intake keeps the device's capture time apart from the server's receipt (§35.3.9)| —|
| Reopen a closed intake| Platform Admin only, privileged and audited (§36.6)| `PERMISSION_DENIED`|

### 5.3 What this feature must never do

- **Never let receiving be automatic.** §22.1: it is a distinct act, not a consequence of pickup completion. An intake created and checked in by the same event destroys the control.
- **Never serve or accept the rider declaration before the count commits, for a blind-count intake.** Both directions. §22.3 guards the read, §22.4 guards the write, and the OpenAPI schema enforces both — `HubIntakePreCount` has no such property and the count request is `additionalProperties: false`. (A photo-mode intake hides nothing: the declaration is a recorded fact beside the number of photos, D-D1.)
- **Never seed the hub count.** It is the number of parcels an officer checked in, each by a physical act, or the number an officer typed for a stop with no photos. **"All N here" is a confirmed statement of the officer's own count, never a default**, and it is refused when the number is not the expected one. Two independent checks (`MSC-DEC-194` part 3): a package lost between the door and the hub is visible only here.
- **Never type a number for a vendor with photos.** The count is the parcels checked in (D-D2).
- **Never use the rider declaration as the close target.** §22.7: the hub's physical count is the intake-close authority; the declaration is **immutable discrepancy history**.
- **Never collapse the three OS&D dimensions.** Count, condition and dispute are independent — a `MATCH` count does not close the condition question.
- **Never rely on the soft lock alone.** §22.8 says so in terms: a visual lock is not sufficient.
- **Never show a vendor the internals.** §22.9 limits them to the intake-completed and order summary: the check-in, the photos of a missing parcel and the decision stay Ops-only.
- **Never hide the door photos from the officer who receives, and never draw them where they are not needed.** They are the reference the parcels are checked against (D-D1; this reverses D-A10 point 6 for photo-mode intakes). A blind-count intake has none to hide.
- **Never let the system tell the vendor about a missing parcel.** "Vendor told" records that a person did; nothing is sent (D-D4).
- **Never change a count or a check-in after it is made without a senior officer's reason**, recorded with the old and the new numbers (D-D8).

### 5.4 The check-in of a vendor's parcels

*Designed (Run D). The parcel's own table and machine are [domain-model.md §6.6a](../../contracts/domain-model.md#66a-intakeparcel) and [state-machines.md §7](../../contracts/state-machines.md#7-pickupintake).*

- **A vendor's section is one intake**, and its expected parcels are its door photos, in the order they were taken. A parcel is `EXPECTED` until it is checked in, `ARRIVED` when it is, `MISSING` when its vendor was finished without it, and `VOID` for an extra taken back.
- **A tap checks a parcel in** (`recordParcelArrival` states the parcel's desired state, so it is idempotent by nature) and records the officer and the database's time. **An untap takes it back, while the vendor's check-in is open** (the intake is `AWAITING_COUNT`); after that only a found parcel, an extra or a senior's correction changes a parcel (§5.6, §5.8).
- **"All N here" and "Finish this vendor" are one operation** (`finishCheckIn`, an `Idempotency-Key` and the `If-Match` of the intake as read). With `all_arrived` it takes the number the officer counted (`confirmed_count`) and is refused unless it is the expected number (`count_changed`) and no extra stands (`has_extra_parcels`); without it, the parcels not tapped become `MISSING`. Either way the count, its variance and the System's move are made in the same change as the parcels (§5.1 step 9).
- **Counts are derived, not typed.** The intake's count is the number of its `ARRIVED` parcels; the database holds that for every writer once the vendor is finished. The rider's handover number is shown as a recorded fact beside the number photographed, and a declaration of zero still goes to the senior.
- **Photos are read like the stop's:** each opens with a retrieval authorization of its own, a thumbnail grid and a viewer with next and previous serve the officer on a tablet, and **the small copy that lists show** (OB-S1-86 part 2) is made by the evidence lane when the scan passes a photo (a derived JPEG about 320 px wide stored beside the original under the same retention) — **provisional: if Run D does not build it, the grid draws the original in a fixed box and says so**.
- **The camera is opened directly** for a photo taken at the hub (an extra, damage), with a choice of the gallery and no PDF on the floor; a photo is previewed before it is sent, its size is judged before the file is read, and the evidence limits are read from the platform (`getEvidenceLimits`).
- **A run is finished when all its vendors are**; the summary and the rider's-bag reminder are drawn from the recorded facts and decide nothing.

### 5.5 A stop with no parcel photos: the blind count

*D-D3. As built (S1.31 to S1.34); it stays for the intakes whose stop Ops let through without photos and for no other.*

1. **The officer types the count before the rider's number is shown.** On the receiving screens and their reads the rider's number is in no response, list, page or attribute before the count commits (other Ops pages are not required to hide it). `submitBlindCount` takes the count alone (a body that carries anything else, the declaration included, is `VALIDATION_FAILED` and nothing is committed) with an `Idempotency-Key` and the `ETag` of the read as `If-Match`; a count is committed once, so of two receivers who both count one succeeds and the other is `STATE_CONFLICT`, whoever holds the lock.
2. **The backend reveals the server-owned rider declaration and calculates the variance** (§22.4 steps 3–4): the database makes the comparison and takes the intake to `READY_FOR_ITEMIZATION` or `RECONCILIATION_REQUIRED` (a variance, or a zero declaration whatever the variance); the response is the first that carries the declaration and the comparison. A stop with no photos has no `parcel_photo_ids`.
3. **A mismatch goes to the senior officer** ([§5.7](#57-the-seniors-decision)), and the condition of such an intake is recorded for the whole intake, once, after the count (`recordIntakeCondition` without a parcel).
4. **The screen explains it in one line** and no more; the page that carried the long explanation of the blind count is simplified.

### 5.6 Missing, extra and damaged parcels

*Designed (Run D).*

- **A missing parcel** is a door parcel not checked in when its vendor was finished. It is shown with its picture, the vendor and the run, and **is searched for first, inside the hub** (D-D4). If it is found, an officer holding `hub.intake.count` checks it in (`recordParcelArrival`, `MISSING → ARRIVED`) **while the case is open** (the intake is in `RECONCILIATION_REQUIRED`); the intake's count and variance are recomputed in the same change, `hub.parcel.found` is written, and the intake **stays in `RECONCILIATION_REQUIRED`**: a senior closes the case even when nothing is missing any more.
- **An extra** is a parcel on the table that has no door photo, recorded with a stored photo taken at the hub (`addExtraParcel`, owner `PICKUP_INTAKE`, purpose `OSD`; allowed while the vendor is open and while the case is open, `hub.parcel.extra_added`). It is counted at once and the intake goes to the senior. **Provisional:** the senior's *Accept* accepts the extra; there is no "refuse an extra" in this run. A mistaken extra is `VOID` (§5.1 step 6) and counts nowhere; it stays in the history, shown struck through.
- **A damaged parcel** carries a finding of that parcel (`CONDITION`, `DAMAGED`, `TAMPERED` or `OTHER`), recorded once for the parcel, **after the parcel has arrived and before itemizing starts, whether or not its vendor is finished**; `DAMAGED` and `TAMPERED` carry stored evidence of the intake, and the case goes to the senior (a vendor not yet finished is routed at its finish, because a non-`OK` condition stands in the routing rule). `OK` is a finding that changes nothing. Only a senior officer changes a condition after deciding: the adjudication may set it, as built.
- **No finding changes a count.** The expected number, the received number and the variance survive every finding; a finding explains a discrepancy, it does not erase one.

### 5.7 The senior's decision

*D-D4. The wire values of `adjudicateDiscrepancy` stay; the words are the floor's. **Provisional reading C1:** `ESCALATED` is the outcome the officers call "Still searching".*

- **The outcomes, in the order they are offered:** *Still searching* (`ESCALATED`: records the act and **leaves the case open**), *Accept the count* (`ACCEPTED`: the intake is received as checked in; missing parcels stay recorded as missing, the extras stand), *Write off* (`WRITTEN_OFF`: the search is closed as **not found**) and *Vendor told* (`VENDOR_NOTIFIED`). `ACCEPTED` and `WRITTEN_OFF` resolve the case (`RECONCILIATION_REQUIRED → READY_FOR_ITEMIZATION`). A reason in words is mandatory, as built.
- **"Vendor told" is a record and nothing else.** It says that someone told the vendor; **the system sends nothing**. It is offered **only after the search is closed as not found** (an earlier `WRITTEN_OFF` finding of that intake) and **once**, it may be recorded when the intake is past reconciliation, and it moves no state (`not_written_off`, `vendor_already_told`).
- **The case stays open in a visible list, *Missing — being searched for*** (`listMissingParcels`): each missing parcel with its picture, the vendor, the run and how long it has been missing. A parcel is in it from the moment its vendor was finished without it until a senior officer closes the case with *Accept* or *Write off* (or it is found).
- **The decision page shows the facts first**: the comparison, the missing and extra parcels with their pictures, each damage with its note and photos; the outcomes follow.
- **No count changes by a decision.** An officer without the key is told that a senior officer will decide.

### 5.8 A senior's correction

*D-D8, approved by the Product Owner on 16 November 2026: only a senior officer, a required reason, the old and the new numbers recorded. Designed (Run D).*

A mistaken count or check-in is not undone by a retry: with no limit on the parcels of an intake (the owner's decision of 15 November), the safety net is a correction (`correctIntakeCount`, `hub.osd.adjudicate`). It needs a **reason in words** (`REASON_REQUIRED`; no catalogue), and it is allowed **before itemizing starts only** (`itemization_started` after). In photo mode it sets a door parcel `ARRIVED` or `MISSING` and an extra `ARRIVED` or `VOID`; in blind-count mode it corrects the physical count. It is audited as an **enhanced** event (`hub.intake.corrected`) that records the old and the new numbers and the parcels changed; the intake is then routed by the rule of §5.1 step 9 and a `hub.osd.opened` is written if a case opens. A correction explains nothing away: the rider's declaration and the door photos are never changed.

### 5.9 What D-D1 removes or narrows, and what replaces it

| What the blind count built (Stage 6)| What happens| What replaces it|
|---|---|---|
| The count typed for every intake (`submitBlindCount`, S1.33)| **Kept**, for blind-count intakes only; refused on a photo intake (`photo_check_in`)| For a photo intake: `recordParcelArrival` and `finishCheckIn`, the count derived from the parcels|
| The declaration withheld from every pre-count read (S1.31 grants, `HubIntakePreCount`, `BLIND_COUNT_VIOLATED`; **AC-37, AC-38**)| **Narrowed** to blind-count intakes| A photo intake is read in a third shape that carries the declaration, the photos and the parcels; the withholding of S1.31 stays for the column of a blind-count intake|
| The door photos hidden from the receiving side before the count (**AC-89**, `OB-S1-81`, this document's former §5.3 rule, `test/stop-photos-not-on-the-receiving-side.test.ts`)| **Reversed** for photo intakes: the photos are the reference. A blind-count intake has none| AC-92, and a test that the receiving side draws the door photos from the handover on|
| `hub_intake_after_count` answers the declaration and the photos only for an intake past `AWAITING_COUNT`| **Extended**: for a photo intake it answers from the start| The same function, with the mode in its judgement|
| One condition for the whole intake (0097)| **Kept** for blind-count intakes; **per parcel** in photo mode| Two unique findings, one for each parcel and one for each intake without a parcel|
| The ops-web guard that refuses a photo, a count or a declaration in a pre-count answer (`PreCountIntakeView`)| **Narrowed** to blind-count intakes| The check-in shape of a photo intake (`HubIntakeCheckIn`), judged like the others|
| The browser spec's leak scan and `world.leak` (`receiving.spec.ts`)| **Kept** for the blind-count screens| New specs for the run page, the check-in and the decision|
| The lock taken by opening the count page, the page's long explanation of the blind count and "Ask again"| **Replaced**| The lock taken on the first act, one line in plain words, a stated "cannot check the lock right now" when a refresh fails|
| `/intakes` as the queue of intakes, `/intakes/{id}/condition` as a page| **Replaced**| The queue by run, the run page, the damage dialog on the parcel ([surfaces/ops-portal.md](../../surfaces/ops-portal.md))|

---

## 6. Entities — *pointer*

| Entity| Home|
|---|---|
| `PickupIntake`| [domain-model.md](../../contracts/domain-model.md) §6.6|
| `IntakeParcel` *(designed, Run D)*| [domain-model.md](../../contracts/domain-model.md) §6.6a|
| `Evidence`| [domain-model.md](../../contracts/domain-model.md) §3.6|
| `CollectionRecord`| [domain-model.md](../../contracts/domain-model.md) §6.5 — read for history, never as the close target|

Non-obvious: `receiving_mode` is fixed by the handover; `rider_declared_count` is **never readable before commit and never seeded** from collection, **for a blind-count intake**; `condition` is a fixed four-value enum; `active_receiver_id` and `lock_acquired_at` carry the advisory lock; **a photo intake's count is derived from its parcels**.

## 7. States — *pointer*

| Machine| Home| Transitions this feature drives|
|---|---|---|
| `PickupIntake.state`| [state-machines.md](../../contracts/state-machines.md) §7| `AWAITING_COUNT → COUNTED` (the vendor is finished, or the count is typed); `→ RECONCILIATION_REQUIRED`; `→ READY_FOR_ITEMIZATION`; lock acquisition|
| `IntakeParcel.state` *(designed)*| [state-machines.md](../../contracts/state-machines.md) §7| `EXPECTED ⇄ ARRIVED`; `EXPECTED → MISSING`; `MISSING → ARRIVED` (found); `ARRIVED ⇄ VOID` (an extra)|

## 8. Permissions — *pointer*

| Key| Holders| Scope| Home|
|---|---|---|---|
| `hub.handover.submit`| **Rider only**| owned completed run| [permissions.md](../../contracts/permissions.md) §7|
| `hub.read`| Ops, Senior Ops, Platform Admin| own hub (Platform Admin: all hubs). The queue of runs, a run, an intake and the missing list||
| `hub.intake.count`| Ops, Senior Ops, Platform Admin| own hub (Platform Admin: all hubs). The check-in acts, an extra, a condition, the blind count||
| `hub.osd.adjudicate`| **Senior Ops, Platform Admin** — not Ops Staff| own hub (Platform Admin: all hubs). The decision and the correction of a count or a check-in||
| `hub.intake.reopen`| **Platform Admin only**| all hubs||

## 9. Settings — *pointer*

| Key| Why this feature reads it| Home|
|---|---|---|
| `intake_lock_idle_ttl_minutes`| **`PROVISIONAL`** — 15 minutes, a development value (§14, `OQ-051`).| [settings.md](../../contracts/settings.md) §7.3|

**There is no limit on the number of parcels of an intake** (the Product Owner, 15 November 2026: the setting `intake_parcel_cap`, 100, is removed). A request and its intake may hold any number of parcels: the system records the quantities declared and counted, and the count comparison and the discrepancy rules apply at any size. Only what the data type holds (a whole number, not negative) is checked.

## 10. Errors — *pointer*

`BLIND_COUNT_VIOLATED`, `STOPS_UNRESOLVED`, `ZERO_COLLECTION_IS_FAILURE`, `INSUFFICIENT_AUTHORITY`, `REASON_REQUIRED`, `EVIDENCE_NOT_STORED`, `STATE_CONFLICT` and its rules — [errors-and-enums.md](../../contracts/errors-and-enums.md). No new code: the check-in adds rules of `STATE_CONFLICT` and `VALIDATION_FAILED`, not codes.

## 11. Audit events — *pointer*

`hub.handover.submitted`, `hub.intake.counted` — **the first moment both counts may legally appear together for a blind-count intake; for a photo intake it is written once, when the vendor is finished** — `hub.osd.opened`, `hub.osd.resolved` *(enhanced)*, `hub.intake.reopened` *(enhanced)* — [audit.md](../../contracts/audit.md) §5.2. **Designed by Run D** (they join the catalogue's tables with the code that writes them): `hub.parcel.found`, `hub.parcel.extra_added`, `hub.intake.corrected` *(enhanced)*. There is no event for a tap: the parcel's row holds who and when.

## 12. API operations — *pointer*

`getHubIntake`, **`listHubIntakes`**, **`acquireIntakeLock`**, `submitBlindCount` (blind-count intakes only), `closeHubIntake`, `adjudicateDiscrepancy`, `recordIntakeCondition` (the receiver's condition and evidence, under the key the receiver holds; for a photo intake it names a parcel) and `submitHubHandover`, and `getIntakeSummary` (the vendor-facing summary of a closed intake) — [openapi.yaml](../../contracts/openapi.yaml). **`listHubIntakes` and `acquireIntakeLock` were added at `MSC-DEC-416`**: the queue and the lock this feature describes had no operation. **Designed by Run D (contract 5.108.0, added with the code of S1.35b):** the reads `listReceivingRuns`, `getReceivingRun`, `listMissingParcels` and `getEvidenceLimits`, and the acts `recordParcelArrival`, `finishCheckIn`, `addExtraParcel` and `correctIntakeCount`. The blind-count guarantee of a blind-count intake is carried by the schema: `HubIntakePreCount` omits the declaration entirely, and the count request declares `additionalProperties: false`.

---

## 13. Acceptance criteria

### `AC-SLICE-001-37` — The declaration is not served before commit

*Scope (Run D, D-D1 and D-D3): this criterion holds for an intake of a stop with no parcel photos (blind-count mode). A photo intake hides nothing: see AC-92.*

```text
Given an intake in AWAITING_COUNT whose stop has no parcel photos,
When any authorized Ops user reads it,
Then the response contains no rider_declared_count property at all,
And the awaiting-receive queue and the receiving page likewise do not expose it,
And it becomes readable only in the response to the committed physical count.
```

**Governs:** §22.3, §22.4, §43.2 · **Surface:** Melarc Ops · **Test level:** API · **Code:** none returned — the property is asserted absent (the internal invariant is named BLIND_COUNT_VIOLATED and is never a response)

### `AC-SLICE-001-38` — The client cannot submit the declaration

*Scope (Run D): blind-count mode, as AC-37.*

```text
Given an intake in AWAITING_COUNT whose stop has no parcel photos,
When a client submits a count payload that also carries rider_declared_count,
Then the request is rejected,
And no count is committed.
```

**Governs:** §22.4, `CONFLICT-005` · **Surface:** Melarc Ops · **Test level:** API · **Code:** `VALIDATION_FAILED`

### `AC-SLICE-001-39` — Receiving is a distinct act

```text
Given a manifest whose stops are all terminal and whose collection records exist,
When the run completes,
Then no intake is automatically counted or received,
And an intake exists in AWAITING_COUNT requiring a separate authorized receive action.
```

**Governs:** §22.1 · **Surface:** Melarc Ops · **Test level:** service

### `AC-SLICE-001-40` — The hub count is the close authority, not the declaration

*In photo mode the hub count is the number of parcels checked in, the extras that are not void included (Run D).*

```text
Given an intake where the rider declared 10 and the hub physically received 9,
When the intake proceeds to itemization and closure,
Then closure requires 9 itemized orders,
And the declared count of 10 is retained as immutable discrepancy history,
And it is never used as the close target.
```

**Governs:** §22.7, `MSC-DEC-119` · **Surface:** Melarc Ops · **Test level:** service · **Code:** `PARITY_NOT_MET`

### `AC-SLICE-001-41` — Condition is recordable on a matching count

*In photo mode the condition is a finding of one parcel (AC-96).*

```text
Given an intake whose physical count matches the declaration exactly,
When the receiver records a condition of DAMAGED with supporting evidence,
Then count_variance is MATCH,
And the condition and any dispute are recorded independently,
And the case routes to senior review.
```

**Governs:** §22.5, §35.5.4 · **Surface:** Melarc Ops · **Test level:** API

### `AC-SLICE-001-42` — Damaged and tampered require evidence and senior review

```text
Given a receiver recording a condition of TAMPERED,
When no supporting evidence is attached,
Then the submission is rejected with REASON_REQUIRED,
And when stored evidence is attached the case requires Senior Ops adjudication,
And an Ops Staff user cannot adjudicate it and is refused with PERMISSION_DENIED, because adjudication needs a key Ops Staff do not hold.
```

**Governs:** §22.5, `MSC-DEC-416` · **Surface:** Melarc Ops · **Test level:** API · **Code:** `REASON_REQUIRED`, `PERMISSION_DENIED`

### `AC-SLICE-001-43` — The soft lock is advisory, not a substitute

*Run D: the lock is taken on the officer's first act on a vendor, not by opening the page, and says who opened the check-in and when (§5.1 step 3).*

```text
Given receiver A holds the advisory lock on an intake,
When receiver B opens the same intake,
Then B sees that A is actively receiving,
And B may take over after the idle TTL,
And if both submit a count regardless, exactly one succeeds and the other receives STATE_CONFLICT.
```

**Governs:** §22.8, §35.5.6 · **Surface:** Melarc Ops · **Test level:** API · **Code:** `STATE_CONFLICT`

**Executable since `MSC-DEC-416`**: `acquireIntakeLock` takes the lock and shows who holds it. Until then no operation acquired it, and this criterion had nothing to run against. In photo mode "submit a count" reads "finish the vendor".

### `AC-SLICE-001-44` — The rider may correct the pre-filled count

```text
Given a rider submitting a handover with one row per collected pickup request,
When each row's count is pre-filled from that request's collection record,
Then the rider may correct any row before submission,
And each corrected value is what that row's intake carries as rider_declared_count,
And each correction is recorded.
```

**Governs:** §22.2, `MSC-DEC-416` · **Surface:** Melarc Rider · **Test level:** API

### `AC-SLICE-001-45` — Handover requires every stop terminal

```text
Given a manifest with one stop still PENDING,
When the rider attempts to submit the hub handover,
Then the submission is refused,
And handover becomes available only once every stop is terminal.
```

**Governs:** §22.2 · **Surface:** Melarc Rider · **Test level:** API · **Code:** `STOPS_UNRESOLVED`

### `AC-SLICE-001-46` — Vendors see the summary, never the internals

```text
Given a completed intake with a count variance and an adjudicated damage finding,
When the vendor views its records,
Then the vendor sees the intake-completed and order summary,
And the vendor sees no blind count, no rider declaration, no discrepancy evidence and no internal adjudication.
```

**Governs:** §22.9, §37.3 · **Surface:** Melarc Vendor · **Test level:** security

### `AC-SLICE-001-75` — The handover carries one row per collected request, and each row opens one intake

```text
Given a run whose stops are COLLECTED for requests P and Q, PARTIALLY_COLLECTED for R, and FAILED for S,
When the custody holder submits the hub handover with one row each for P, Q and R,
Then three intakes open at AWAITING_COUNT, one per row, each carrying its row's declared count, the run, the custody holder, the receipt time and the capture time,
And each intake of a stop with door photos opens in photo mode with one expected parcel for each door photo (Run D),
And no intake opens for S,
And a handover that omits R, repeats P or names S is refused with VALIDATION_FAILED and opens nothing,
And the same idempotency key replayed with different rows is refused with IDEMPOTENCY_KEY_CONFLICT.
```

**Governs:** §22.2, `MSC-DEC-416`, state-machines.md §4, §7 · **Surface:** Melarc Rider, backend · **Test level:** API · **Expected code on rejection:** `VALIDATION_FAILED`, `IDEMPOTENCY_KEY_CONFLICT`

### `AC-SLICE-001-76` — A zero declaration opens the intake and forces Senior Ops review

*Run D: in photo mode "commits a blind count of 0" reads "finishes the vendor"; the rule is the same in both modes.*

```text
Given a run on which request P was COLLECTED with 4 parcels,
When the custody holder's handover declares 0 for P,
Then P's intake opens at AWAITING_COUNT with rider_declared_count 0, and no pre-count view of a blind-count intake reveals it,
And when the receiver commits a blind count of 0, the intake moves to RECONCILIATION_REQUIRED although the variance is MATCH,
And only Senior Ops, with a reason, can move it to READY_FOR_ITEMIZATION,
And an Ops Staff user attempting that resolution is refused with PERMISSION_DENIED, because it needs a key Ops Staff do not hold.
```

**Governs:** §22.2, §22.5, `MSC-DEC-416`, state-machines.md §7 · **Surface:** Melarc Rider, Melarc Ops · **Test level:** integration · **Expected code on rejection:** `PERMISSION_DENIED`

### `AC-SLICE-001-77` — The awaiting-receive queue lists pre-count intakes and never a declaration

*Scope (Run D): the queue is by run (AC-92). It never carries the declaration of a blind-count intake, a zero one included.*

```text
Given three intakes awaiting count at the acting hub, one of them carrying a zero declaration and none of them of a photographed stop,
When an Ops user lists intakes filtered to AWAITING_COUNT,
Then all three are returned, each with its run, the rider who handed it over, its submission time and any active receiver,
And no item carries rider_declared_count, the zero declaration included,
And an intake at another hub is not returned,
And a user without hub.read is refused with PERMISSION_DENIED.
```

**Governs:** §22.3, §35.5.2, `MSC-DEC-416` · **Surface:** Melarc Ops · **Test level:** security · **Expected code on rejection:** `PERMISSION_DENIED`

### `AC-SLICE-001-89` — The parcel photos stay out of the blind count

*Reversed for photo mode by D-D1 (16 November 2026): the door photos are the reference of a photo check-in, and AC-92 says so. What remains of this criterion is the blind count of a stop with no photos, which has none: nothing of the rider's count reaches that intake's receiving reads in any form before the count commits.*

```text
Given an intake in AWAITING_COUNT of a stop Ops let through without parcel photos,
When any authorized Ops user reads the intake, the awaiting-receive queue or the receiving page,
Then no response carries a photo, a photo identifier or a number of photos, as none carries rider_declared_count,
And the declaration becomes readable on the intake only in the response to the committed physical count.
```

**Governs:** D-A10 (superseded for photo mode), D-D1, D-D3, [pickup-collection.md §5.5](../pickup/pickup-collection.md#55-the-photo-of-every-parcel), §22.3 · **Surface:** Melarc Ops · **Test level:** API · **Status:** built for the blind-count intakes of Run C (S1.32, S1.33: `hub-intakes.db.test.ts`, `hub-blind-count.db.test.ts`); the photo-mode half is replaced by AC-92.

### `AC-SLICE-001-92` — The door photos are the receiving officer's reference

```text
Given a run handed over whose stops have door photos,
When an authorized Ops user opens the run in the receiving queue,
Then each vendor of the run is a section with its name and its door photos as thumbnails, and the number photographed,
And each photo opens with a retrieval authorization of its own,
And the rider's handover number is shown as a recorded fact and is not withheld,
And a vendor whose stop Ops let through without photos shows none and is counted blind (AC-98).
```

**Governs:** D-D1, D-D2, [pickup-collection.md §5.5](../pickup/pickup-collection.md#55-the-photo-of-every-parcel) · **Surface:** Melarc Ops · **Test level:** API, browser · **Status:** designed (Run D)

### `AC-SLICE-001-93` — "All N here" is confirmed, and N must be the expected count

```text
Given a vendor section of 12 photographed parcels, none yet checked in,
When the officer chooses "All 12 here",
Then a confirmation names the vendor and the number, and nothing is recorded until it is confirmed,
And when it is confirmed every one of the 12 parcels is ARRIVED, recorded with the officer and the time the database took,
And the intake is counted at 12 with variance MATCH and moves to READY_FOR_ITEMIZATION (a declaration above zero, no finding),
And a confirmation whose number is not the number of parcels the intake expects, or one made while an extra stands, is refused and nothing is recorded.
```

**Governs:** D-D2, §22.4 (as revised) · **Surface:** Melarc Ops · **Test level:** API, browser · **Code:** `STATE_CONFLICT` · **Status:** designed (Run D)

### `AC-SLICE-001-94` — A photo check-in finds what is missing, and shows its picture

```text
Given a vendor section of 12 photographed parcels,
When the officer taps the photos of the 10 parcels found and finishes the vendor,
Then the 10 are ARRIVED and the 2 not tapped are MISSING, each shown with its picture,
And the intake is counted at 10 with variance SHORT and moves to RECONCILIATION_REQUIRED,
And a parcel tapped by mistake is taken back only while the vendor is open,
And a missing parcel that is found is checked in while the case is open, the count and the variance are recomputed, and the intake stays in RECONCILIATION_REQUIRED.
```

**Governs:** D-D2, D-D4 · **Surface:** Melarc Ops · **Test level:** API, browser · **Code:** `STATE_CONFLICT` · **Status:** designed (Run D)

### `AC-SLICE-001-95` — A parcel with no door photo is added as an extra

```text
Given a parcel on the table that has no door photo,
When the officer adds it with a camera photo,
Then it is recorded as an extra at the hub, ARRIVED, with its stored photo and the officer,
And it counts in the hub count, the variance is OVER and the case goes to the senior,
And an extra without a stored photo is refused,
And an extra added by mistake is voided by the officer while the vendor is open and by a senior's correction after, and counts nowhere.
```

**Governs:** D-D2 · **Surface:** Melarc Ops · **Test level:** API, browser · **Code:** `EVIDENCE_NOT_STORED` · **Status:** designed (Run D)

### `AC-SLICE-001-96` — Damage is a finding of one parcel, recorded once

```text
Given a parcel that has arrived,
When the officer records DAMAGED with a camera photo of the intake and a note,
Then the finding belongs to that parcel and not to the whole intake, and the case goes to the senior,
And DAMAGED without stored evidence is rejected with REASON_REQUIRED,
And a second condition for the same parcel is refused with STATE_CONFLICT whatever it says,
And only a senior officer changes the condition after deciding,
And a condition for the whole intake of a photographed stop is refused.
```

**Governs:** D-D2, D-D7, §22.5 · **Surface:** Melarc Ops · **Test level:** API, database · **Code:** `REASON_REQUIRED`, `STATE_CONFLICT` · **Status:** designed (Run D)

### `AC-SLICE-001-97` — Finishing the run says what is left to act on

```text
Given a run whose vendors are all finished, with one parcel missing, one extra and one damaged,
When the officer reads the run,
Then the summary lists what arrived, what is missing with its picture, what is extra and what is damaged,
And it says to check the rider's bag before they leave,
And no figure of it was typed by the officer.
```

**Governs:** D-D2 · **Surface:** Melarc Ops · **Test level:** API, browser · **Status:** designed (Run D)

### `AC-SLICE-001-98` — A stop with no parcel photos is counted blind

```text
Given an intake of a stop Ops let through without parcel photos,
When an authorized Ops user reads the receiving queue, the run or the intake,
Then the rider's number is in no response before the count commits,
And the count is typed before it is shown, and a body that carries the declaration is rejected,
And a mismatch moves the intake to RECONCILIATION_REQUIRED for the senior officer,
And a blind count of an intake that has photos is refused with STATE_CONFLICT.
```

**Governs:** D-D3, §22.4 · **Surface:** Melarc Ops · **Test level:** API, security · **Code:** `VALIDATION_FAILED`, `STATE_CONFLICT` · **Status:** built for the intake in Run C (AC-37 and AC-38); the refusal on a photo intake and the run page's words are designed (Run D)

### `AC-SLICE-001-99` — A missing parcel is searched for first, and the list shows it

```text
Given a case with a missing parcel,
When the senior officer decides,
Then "Still searching" is offered first and leaves the case open,
And while the case is open the parcel is in the Missing — being searched for list with its picture, its vendor, its run and how long it has been missing,
And the case closes only when a senior officer accepts the count or writes the parcel off,
And no decision changes a count.
```

**Governs:** D-D4 · **Surface:** Melarc Ops · **Test level:** API, browser · **Status:** designed (Run D)

### `AC-SLICE-001-100` — "Vendor told" is a record after a write-off, never a message

```text
Given a case closed by a write-off,
When a senior officer records that the vendor was told, with a note,
Then the intake carries that finding and no state moves,
And nothing is sent to the vendor by the system,
And before a write-off, or a second time, the record is refused with STATE_CONFLICT.
```

**Governs:** D-D4 · **Surface:** Melarc Ops · **Test level:** API · **Code:** `STATE_CONFLICT` · **Status:** designed (Run D)

### `AC-SLICE-001-101` — A senior officer corrects a count or a check-in, with a reason, recorded

```text
Given an intake whose check-in or count is finished and whose itemizing has not started,
When a senior officer corrects it with a reason,
Then the old and the new numbers and the parcels changed are recorded in an enhanced event,
And the intake is routed again by the rule of the check-in,
And a correction with no reason is rejected with REASON_REQUIRED,
And an Ops Staff user is refused with PERMISSION_DENIED,
And once itemizing has started the correction is refused with STATE_CONFLICT.
```

**Governs:** D-D8 · **Surface:** Melarc Ops · **Test level:** API · **Code:** `REASON_REQUIRED`, `PERMISSION_DENIED`, `STATE_CONFLICT` · **Status:** designed (Run D)

---

## 14. Open questions blocking this feature

| ID| What it blocks here| Type|
|---|---|---|
| `OQ-051`| **The soft-lock idle TTL now has a key** — `intake_lock_idle_ttl_minutes`, added to `contracts/settings.md` §7.3 on 23 August after being found here rather than in that inventory. Still unvalued. **An unset TTL degrades takeover, not correctness**, because §22.8 makes the lock advisory| `VALUE_REQUIRED` — blocks **launch**|

**`OQ-078` closed** 26 August 2026 by `MSC-DEC-256` — the four source-default keys were reviewed
and confirmed (`intake_parcel_cap` among them, which the Product Owner has since removed: §9); the status
disagreement this document raised resolved in `settings.md`'s favour. No `DECISION_NEEDED`
question blocks this feature. **The readings of Run D that the Product Owner may correct** (C1 to C12) are listed in [the plan's §11](../../delivery/planning/SLICE-001-IMPLEMENTATION-PLAN.md#11-decisions-recorded).

## 15. What this feature still owes its slice

| Owed| Blocks which DoR area| Owner|
|---|---|---|
| ~~**The handover's count shape — `CONFLICT-042`.**~~ **Resolved 26 September 2026 by `MSC-DEC-416`** — one row per collected pickup request, each opening its own intake. *Original text:* §5.1 and §22.2 require one count row per sender set, and each `PickupIntake` keeps its own `rider_declared_count`; `submitHubHandover` carries one `declared_count` for the run, so a declaration per intake cannot be recorded| E| Engineering — `SLICE-001`, the next pass|
| `intake_lock_idle_ttl_minutes` has no value| F — launch; `AC-SLICE-001-43` needs it| `OQ-051`|
| Evidence upload has no maximum size or MIME-type whitelist to validate against — condition and OS&D photos captured here are unbounded (MED-12 audit remediation). **Rate limiting is not owed**: evidence upload already falls under `rate_limit_authenticated_api` (120/minute, `MSC-DEC-371`), no dedicated sub-ceiling shown necessary| F — launch| `OQ-121`|
| **The receiving of a run on the door photos (D-D1 to D-D8)** — the parcel table, the check-in acts, the reads by run, the senior's correction and the screens| E| Run D, S1.35a to S1.35c|

The blind-count guarantee of a blind-count intake is enforced **structurally** — `HubIntakePreCount` omits the declaration entirely — and `AC-SLICE-001-37` and `-38` are testable against the contract today. §12 gained the three operations it owns on 23 August.

**Readiness is not assessed here.** [definition-of-ready.md](../../standards/definition-of-ready.md) assesses it **for the complete vertical slice** and records the verdict in the slice document; a feature cannot answer §44.3 or §44.4 alone. This section feeds that assessment instead of duplicating it (`MSC-DEC-239`, closing `CONFLICT-029`).

**Evidence became creatable on 24 August**. `createEvidence` and `completeEvidenceUpload` are written, and **`AC-SLICE-001-41` and `-42` are executable**. `Evidence` was fully modelled at [domain-model.md](../../contracts/domain-model.md) §3.6 and **no operation produced one**, so every criterion here requiring attached evidence was unexecutable — a fact recorded against `OQ-048` and **never against this feature**. The guard worth knowing: a `PENDING_UPLOAD` record **may not be referenced**, so "evidence attached" now means bytes actually arrived.

## 16. Build status — *honest, per surface*

| Surface| Status| Gap|
|---|---|---|
| Melarc Ops| 🟡 the blind-count screens are built (S1.35, Run C); **the receiving by run is designed (Run D)**| The queue by run, the run page and its check-in, the extras and the damage dialog, the senior's decision and the missing list, the camera and the photo grid (S1.35a to S1.35c); itemizing and closing are Stage 7|
| Melarc Rider| ⚪ not built| Handover submission|
| Melarc Vendor| ⚪ not built| Summary only|
| Recipient channel| N/A| —|

## 17. Related

- **Upstream:** [pickup-collection.md](../pickup/pickup-collection.md) — supplies custody and the door photos, **never** the count
- **Downstream:** [itemization.md](itemization.md) — what an eligible intake becomes, and the early itemizing from the photos
- **Slice:** `SLICE-001`
