/**
 * GENERATED FILE - DO NOT EDIT.
 *
 * Wire types for the Melarc API, generated from contracts/openapi.yaml:
 *   Melarc Platform API 5.75.0-identity-reads-and-lockout
 *   SHA-256 ca476f42a7677008597d5e16a6d4d75338f16b7f2de30d4310aaeeab3d5cb1a1 (of the contract, line endings normalized to LF)
 * Generator: openapi-typescript 7.13.0
 * Regenerate with: pnpm run api-client:generate
 */
export interface paths {
    "/pickup-requests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List pickup requests
         * @description Scoped server-side to the actor's vendor ownership and hub (§37.6). Filters are
         *     authorization-checked, never trusted (§42.4).
         */
        get: operations["listPickupRequests"];
        put?: never;
        /**
         * Create a pickup request
         * @description Permission `pickup.request.create`. A vendor account may create only for itself
         *     (§37.3). Creates in `PENDING`; carries payer **intent** only — no *authoritative* price
         *     exists at this point (§5.2.1). The response carries an **indicative estimate**;
         *     the request entity itself stores no monetary amount.
         *
         *     **Idempotency-Key added 23 August.** `createPickupManifest` and `createDeliveryRun` both
         *     carried one; this - the highest-volume vendor-facing write in the product, submitted from
         *     a phone on Ghanaian mobile data - did not. A timeout retry created a second booking.
         *
         *     **`pickup_intent` is the discriminator and it decides what is required**.
         *     There is no single universal pickup form.
         *
         *     - **`OWN_PACKAGES`** — a known Vendor sending its own parcels. Requires
         *       `vendor_organization_id`; reuses the saved pickup location and business goods
         *       profile, and asks only what changes today. A `collection_point` or
         *       `collection_item` here is mis-declared and REJECTED.
         *     - **`COLLECT_FOR_VENDOR`** — collecting from a THIRD PARTY for a registered Vendor.
         *       Requires `collection_point`, `collection_reference` and `collection_item`, plus a
         *       destination: `destination_location_id`, or `use_vendor_default_destination` to
         *       resolve the Vendor's default saved location. A collection with nowhere to take it
         *       is not an executable instruction. **It is not merchandise COD** — no rider is
         *       authorised to pay the seller.
         *     - **`ADHOC_SENDER`** — a walk-in sender. EXACTLY ONE of `ad_hoc_sender_id` (a return
         *       visit, found by verified phone) or `new_ad_hoc_sender` (first use). Requiring an id
         *       made first-time senders unexecutable; permitting both made identity ambiguous.
         *       `current_item_description` is REQUIRED: the identity is reusable, the goods are not.
         *       The sender is never auto-promoted to a registered Vendor.
         *
         *     **Every intent resolves `resolved_pickup_location`**, which is what dispatch and the
         *     rider read. All three are creatable by Ops from WhatsApp intake.
         */
        post: operations["createPickupRequest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pickup-requests/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get: operations["getPickupRequest"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pickup-requests/{id}/confirm": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Confirm a pickup request
         * @description Permission `pickup.request.confirm`. Guards, each returning its own code:
         *     `PICKUP_MINIMUM_NOT_MET`, `EXCEPTION_NOT_AVAILABLE_TO_SELF_SERVICE`,
         *     `SERVICE_DATE_NOT_PERMITTED`, `ZONE_NOT_SERVICED_ON_DATE`, `BOOKING_CUTOFF_PASSED`,
         *     `SENDER_SUSPENDED`, `PICKUP_ATTEMPT_LIMIT_REACHED`.
         *
         *     Returns an INDICATIVE estimate — base fee × package count, assuming SMALL and in-area
         *     doorstep (MSC-DEC-211, superseding MSC-DEC-175). Creates no credit reservation and no
         *     charge (§5.2.1). The estimate is not a quote and the surface must present it as provisional.
         */
        post: operations["confirmPickupRequest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pickup-requests/{id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * @description **In V1 a vendor may cancel only its own `PENDING` request**. Vendor
         *     self-cancellation of a *confirmed* request is deferred — not deleted — so a vendor
         *     calling this on a `CONFIRMED` request receives `PERMISSION_DENIED`.
         *
         *     The request never becomes uncancellable. Office cancellation remains available at every
         *     point; after rider assignment it carries a **discretionary** charge. A
         *     client presenting any refusal here as a dead end misrepresents the policy.
         *
         *     **A missing charge setting does not block the cancellation.** An unset amount
         *     yields `cancellation_charge_outcome: UNAVAILABLE` and the cancellation proceeds. An
         *     operational decision is never held hostage to missing commercial configuration.
         *
         *     *Deferred guard, retained for re-enablement:* self-cancellation ends at rider assignment,
         *     read cross-record via `PickupManifest.assigned_rider_id`.
         *
         *     A reschedule must create its replacement in the same command, or `REPLACEMENT_REQUIRED`;
         *     the source and replacement may never both be active (`SOURCE_STILL_ACTIVE`, §35.4.4).
         *
         *     **Idempotency-Key added — CRIT-05 audit remediation.** `create_replacement: true` mints a
         *     new `PickupRequest`, and `apply_charge: true` records a discretionary charge — a repeated
         *     submission over a flaky Ops connection is exactly `createPickupManifest`'s risk of two
         *     priced records for one logical act, not a state a guard alone catches cleanly once the
         *     source has already left its prior state.
         */
        post: operations["cancelPickupRequest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pickup-requests/{id}/reassign-hub": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Move a pickup request to another hub, before custody
         * @description **The only way `responsible_hub_id` ever changes**. A generic PATCH of that
         *     field is forbidden: security scope is server-derived, and a client-editable scope column is
         *     a client-editable authorization boundary.
         *
         *     **34.9 has permitted this since the baseline** - reassignment "only before custody begins" -
         *     and no permission, operation or command carried it, so Gate B R0 read the field as
         *     universally immutable. That forbade approved behaviour, and the available workarounds were
         *     cancel-and-recreate, which breaks the 5.7 attempt chain, or a direct database edit no policy
         *     or audit event sees.
         *
         *     **The actor must be authorized for BOTH hubs.** Source-hub authority alone is not enough:
         *     moving work into a hub you cannot see exports it beyond your own authority.
         *     `HUB_SCOPE_VIOLATION` otherwise. Explicit all-hub authority satisfies this only where the
         *     Session actually grants it.
         *
         *     **Cutoff.** Permitted only before rider pickup or custody begins - `STATE_CONFLICT`
         *     afterwards. Where the request is already planned into a manifest, reassignment stays
         *     possible only before that run starts, and the old stop and planning assignments are revoked
         *     atomically and rebuilt under the target hub. **No old planning artifact may keep conferring
         *     the former scope** - a manifest still pointing at the request is itself scope-conferring, so
         *     leaving one behind lets the previous hub's staff and rider keep reaching it.
         *
         *     **Inter-hub transfer after custody is never simulated by editing this field**, and
         *     historical custody records never move.
         *
         *     Enhanced-audited as `pickup.request.hub_reassigned`, carrying previous hub, new hub, actor,
         *     correlation id and every planning artifact revoked or rebuilt.
         */
        post: operations["reassignPickupRequestHub"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pickup-requests/{id}/escalate": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Escalate a failed request out of the Ops decision context
         * @description `pickup.failure.resolve` - Ops, Senior Ops, Platform Admin at own hub.
         *
         *     21.6 gives Ops three resolutions for a failed stop: reschedule, cancel, or **escalate**.
         *     The first two are `cancelPickupRequest` with and without `create_replacement`. This is
         *     the third, and it had no operation until 23 August - which made **AC-SLICE-001-33** and
         *     **AC-SLICE-001-34** unexecutable against the contract.
         *
         *     **Two paths reach here and cannot leave any other way.** A `REFUSED_COLLECTION` failure
         *     is escalation-only (21.6): an ordinary reschedule is refused, and only hub Senior Ops
         *     force-extension (`extendPickupAttempts`) opens one. A request that has exhausted
         *     `MELARC_MAX_PICKUP_ATTEMPTS` is in the same position.
         *
         *     **The scheduled backstop calls this same transition** after
         *     `stale_failure_backstop_hours`, recording `trigger: BACKSTOP` rather than an actor. A
         *     queue nobody works is a queue that hides parcels, so the escalation must be reachable
         *     both ways and distinguishable afterwards.
         *
         *     **Enhanced-audited as `pickup.request.escalated`** — CRIT-09 audit remediation; this
         *     operation existed with no event at all until now.
         *
         *     **Idempotency-Key added — CRIT-05 audit remediation**, alongside CRIT-09's new
         *     `pickup.request.escalated` audit event: a State guard alone stops a second escalation
         *     from landing, but not a second audit row from a client that never saw the first response.
         */
        post: operations["escalatePickupRequest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pickup-requests/{id}/attempt-extension": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Force-extend the pickup attempt cap
         * @description `pickup.attempt.extend` - **hub Senior Ops and Platform Admin only**, own hub
         *     (21.6, MSC-DEC-116). Not Ops Staff.
         *
         *     Raises the ceiling for **this request alone** past `MELARC_MAX_PICKUP_ATTEMPTS`. It does
         *     not change the setting, and it is the only route by which a `REFUSED_COLLECTION` or an
         *     exhausted chain becomes reschedulable again.
         *
         *     **`reason` is required by the schema rather than by review.** 21.6, MSC-DEC-116 makes the
         *     reason mandatory and the audit immutable; a force-extension whose reason could be omitted
         *     is an attempt cap that quietly is not one.
         *
         *     **Idempotency-Key added — CRIT-05 audit remediation.** The extension is a ceiling raised
         *     for this request; nothing in this contract states it is measured rather than accumulated,
         *     and a Senior Ops officer retrying an unclear submission must not risk raising it twice.
         */
        post: operations["extendPickupAttempts"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pickup-requests/{id}/cancellation-charge/waiver": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Waive an applied cancellation charge
         * @description `pickup.cancellation_charge.waive` - **Senior Ops floor**, own hub.
         *
         *     The charge is applied at Ops discretion by `cancelPickupRequest`; **relieving it is a
         *     higher authority than applying it**, which is the whole shape of MSC-DEC-197: charged by
         *     default, relieved by judgement, and the waiver frequency visible in the audit trail. A
         *     rule with no relief valve gets ignored in practice; a relief valve with no record gets
         *     used until it is the rule.
         *
         *     Refused with `NO_CHARGE_APPLIED` where the cancellation recorded
         *     `cancellation_charge_outcome: UNAVAILABLE`, `NOT_APPLIED` or `EXEMPT` - there is nothing to waive,
         *     and a waiver recorded against no charge would corrupt the very frequency data that makes
         *     this control work.
         */
        post: operations["waiveCancellationCharge"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pickup-requests/{id}/one-package-exception": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * @description Maker side. Permission `pickup.exception.request` — **Ops only**. A vendor account
         *     attempting this receives `EXCEPTION_NOT_AVAILABLE_TO_SELF_SERVICE` (§35.2.4).
         */
        post: operations["requestOnePackageException"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pickup-requests/{id}/one-package-exception/approve": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * @description Checker side. Permission `pickup.exception.approve` — held by **Senior Ops, Platform
         *     Admin, or an Ops Staff member explicitly granted it**. **The permission is
         *     authoritative, not the role**: a hub-floor judgement routed to the busiest authority
         *     in the product stops being asked for.
         *
         *     *Superseded reading:* §11.4 row 3 placed this with Platform Admin **only**, and Gate C
         *     widened it.
         *
         *     The approver may not be the requester, or `SELF_APPROVAL_FORBIDDEN` (§37.4,
         *     MSC-DEC-135).
         *
         *     **The approved GH20 single-package fee becomes due on acceptance**, and
         *     settlement follows the Vendor's eligibility: posted to statement for an
         *     allowance-enabled unrestricted Vendor, settled before pickup proceeds where
         *     VendorOperationalEligibility.requires_prepayment.
         */
        post: operations["approveOnePackageException"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pickup-stops/{id}/arrive": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Mark arrival at a pickup stop
         * @description `pickup.run.execute` - the assigned rider only. PENDING to ARRIVED (5), guarded on the
         *     manifest being IN_PROGRESS (`MANIFEST_NOT_STARTED`).
         *
         *     **Arrival is a command, not a screen event.** 36.1: a record must not change state
         *     because a screen changed. The delivery side has had `arriveAtDeliveryStop` since
         *     26 August; this side was recorded as CONFLICT-038 and had no operation behind it
         *     until MSC-DEC-392.
         *
         *     **The cancellation window closes here**. That is the whole
         *     reason this cannot be a screen event: a commercial consequence - the vendor's
         *     self-service cancellation ending - hangs on this transition, and a state a client can
         *     assert is a charge a client can trigger.
         *
         *     Idempotent - for connection resilience, not offline capability (rule 4): arrival
         *     requires a connection in Version 1, and a retried arrival must not close
         *     the window twice. *Superseded:* "this is an offline command (35.3.9), the same as
         *     `recordCollection`".
         */
        post: operations["arriveAtPickupStop"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pickup-stops/{id}/collect": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Record the physical collection result
         * @description Rider only, assigned stop only (`NOT_ASSIGNED_RIDER`). Idempotent — for connection
         *     resilience, not offline capability (rule 4): **collection requires a connection in
         *     Version 1**. *Superseded:* "this is an offline command (§35.3.9)".
         *
         *     `collected_count` of zero is a **failed pickup** and may not accompany a collected stop:
         *     `ZERO_COLLECTION_IS_FAILURE` (§36.4).
         *
         *     **Partial collection is permitted**. A short count requires
         *     `variance_reason_code`, or `REASON_REQUIRED`. A short collection also raises the office
         *     notification at the time of the shortfall — it supplements the rider's phone call and
         *     does not replace it.
         *
         *     **The hub blind count still runs independently.** `collected_count` never seeds
         *     `HubIntake.rider_declared_count`. They are two checks, and a package lost between the
         *     door and the hub is visible only in the second (MSC-DEC-194 part 3).
         */
        post: operations["recordCollection"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pickup-stops/{id}/fail": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * @description Rider only, owned dispatched stop. Requires a categorized reason **and whatever that
         *     reason's metadata makes mandatory** — note, photo, or contact attempt (§35.4.1, §35.9.2).
         */
        post: operations["reportPickupFailure"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pickup-stops/{id}/skip": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Ops authorises a skip, and the run can close
         * @description `pickup.stop.skip` - **Ops Staff, Senior Ops or Platform Admin at own hub**.
         *     **Not the rider**: no rider bundle holds this key, and a rider who could skip a stop could
         *     choose which customers to serve.
         *
         *     **This performs state-machines.md 5's SIGNED `PENDING/ARRIVED` to `SKIPPED` row**, which
         *     named Ops with a mandatory reason and had no operation behind it. STATE_CONFLICT refuses a
         *     stop already in a terminal state.
         *
         *     **The reason is a PICKUP_STOP_SKIP catalogue code** (domain-model.md 3.9) - RUN_CUT_SHORT,
         *     VENDOR_REQUESTED_SKIP, LOCATION_INACCESSIBLE or STOP_RAISED_IN_ERROR, and an approved
         *     operational reason may be added without a contract change. REASON_REQUIRED without one;
         *     REASON_NOT_ACTIVE for an inactive or wrong-domain code. **A note is mandatory where the
         *     reason's metadata says so** - LOCATION_INACCESSIBLE and STOP_RAISED_IN_ERROR both do.
         *
         *     **THE VENDOR IS NOTIFIED, ALWAYS** (MSC-DEC-412, on MSC-DEC-348's field set): the vendor,
         *     the pickup request, the reason and the requested vendor action where anything would unblock
         *     it. A vendor whose parcels were not collected today is the party who can act.
         *
         *     **NO ATTEMPT IS CONSUMED.** The PickupRequest attempt chain is untouched and
         *     MELARC_MAX_PICKUP_ATTEMPTS is not approached: a skip is Melarc's operational decision, not
         *     a failed collection. **The request keeps the state it had** - Ops reschedule with 3's
         *     CONFIRMED to CANCELLED (replacement), which increments attempt_number, or cancel outright.
         *     Nothing is created automatically, because three of the four reasons reschedule and
         *     STOP_RAISED_IN_ERROR must not re-raise the stop it removed.
         */
        post: operations["skipPickupStop"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/hub-intakes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List intakes at the acting hub - the awaiting-receive queue
         * @description Permission `hub.read`, **hub-scoped**. Filtered to `state=AWAITING_COUNT` this is the
         *     awaiting-receive queue §22.3 describes: each intake's handover, run and rider, its
         *     submission timing, and whether another user is actively receiving.
         *
         *     **Pre-count items are `HubIntakePreCount`**, so no rider declaration - not even a zero
         *     one - is served before the blind count commits (§22.3, §35.5.2). A queue that flagged
         *     zero declarations would reveal the declared count by another route.
         *
         *     **Added at MSC-DEC-416.** The queue had a route in ops-portal.md and a step in
         *     hub-intake.md, and no operation behind either.
         */
        get: operations["listHubIntakes"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/hub-intakes/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        /**
         * Read an intake
         * @description **The blind-count guard lives here, on the read path.**
         *
         *     Before the physical count is committed this returns `HubIntakePreCount`, whose schema
         *     has no `rider_declared_count` property at all. §35.5.2 forbids the system to reveal it,
         *     and §43.2 states the criterion: the declared count "is not returned in the editable/view
         *     model used before submission." An implementation that returns the field and relies on
         *     the frontend to hide it violates the contract, not merely the UI guidance.
         *
         *     After commitment, `HubIntakePostCount` carries the declared count, the physical count
         *     and the comparison.
         */
        get: operations["getHubIntake"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/hub-intakes/{id}/lock": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Take the advisory receive lock on an intake, or see who holds it
         * @description Performs state-machines.md 7's signed *acquire receive lock* row exactly (§22.8). The
         *     caller takes the lock when no receiver holds it, or when the holder has been idle past
         *     `intake_lock_idle_ttl_minutes`; otherwise the intake comes back showing who is actively
         *     receiving, and nothing changes. The holder calling again refreshes `lock_acquired_at`.
         *
         *     **Advisory, and nothing may treat it otherwise.** §22.8: a visual lock alone is not
         *     sufficient. `submitBlindCount` keeps its own transition and idempotency guards, and two
         *     receivers who both submit a count get one success and one STATE_CONFLICT whatever this
         *     says (AC-SLICE-001-43).
         *
         *     **Added at MSC-DEC-416.** The row is signed and had no operation behind it - the same
         *     class as skipPickupStop at MSC-DEC-412.
         */
        post: operations["acquireIntakeLock"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/hub-intakes/{id}/count": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Submit the blind physical count
         * @description **The blind-count guard's write half.** The request body carries only the physical
         *     count. §35.5.2 forbids the system to "require the frontend to submit" the declared
         *     count, so it is absent from the request schema — a design that accepts it echoed back
         *     fails for a second, independent reason (§42.3).
         *
         *     The response reveals the comparison for the first time.
         *
         *     **Idempotency-Key added — CRIT-05 audit remediation.** `itemizeOrder` below already
         *     claimed *"`submitBlindCount`, the operation immediately before this one, carried both
         *     guards from the start"* — true of `If-Match` and false of `Idempotency-Key` until now.
         *     This closes that gap rather than correcting the claim, since the reasoning was already
         *     right: a receiving officer on the same flaky hub connection `itemizeOrder` describes
         *     needs the same replay safety one call earlier.
         */
        post: operations["submitBlindCount"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/hub-intakes/{id}/orders": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Itemize one order from an intake
         * @description Permission `hub.intake.itemize`. Creates one `Order` — the single itemized delivery unit.
         *
         *
         *     Destination zone is **server-resolved**; a free-text address alone is not authoritative
         *     (§35.6.6). The client sends the address and, where applicable, an explicit authorization;
         *     it never sends the zone.
         *
         *     Price is calculated server-side from the hub's service-area base fee, corridor off-day fee
         *     or station-drop fee, plus the size-class surcharge in third-party mode only, plus carrier
         *     cost and margin where applicable (MSC-DEC-207, 209, 210). The client never sends a price
         *     (§42.3) — only an observed carrier cost.
         *
         *
         *     **It also creates the order's initial `DeliveryCommitment`** -
         *     the side effect R1 defined in the domain model and did not put here.
         *
         *     **The SLA clock reaches BACKWARDS.** The Order does not exist at pickup: a pickup is a
         *     batch, and the Order is created here, hours after the custody that started its promise.
         *     The server reads the successful pickup-custody timestamp from the authoritative lineage -
         *     CollectionRecord to PickupStop to PickupManifest - and sets `sla_start_at` to THAT earlier
         *     time. `default_date` derives from the custody date, not from today. The corridor schedule
         *     applies where the destination has one, and an accepted sender or recipient requested date
         *     applies over it.
         *
         *     **Hub arrival and itemization time never reset it.** Starting the clock here would be
         *     simpler, would look correct, and would quietly award Melarc every hour of its own delay -
         *     measured from an event the sender cannot observe.
         *
         *     **The commitment is written atomically with the Order, at `sequence = 1`.** `(order_id,
         *     sequence)` is unique, so the Idempotency-Key retry above cannot mint a second initial
         *     commitment. **An Order without its initial commitment is not a state this operation may
         *     leave behind**: either both exist or neither does.
         *
         *     **Idempotency-Key and If-Match are both required, and both were absent until 23 August.**
         *     This operation **creates a money record and freezes a price**. A receiving officer
         *     retrying over a flaky hub connection would have created **two priced Orders for one
         *     physical parcel** - a duplicate credit reservation against a GH₵200 global limit, and two
         *     system parcels where the blind count proved there was one.
         *
         *     §22.8 does not leave this to judgement: the intake soft lock is **advisory**, and
         *     *"backend transition and idempotency controls are still required; a visual lock alone is
         *     not sufficient."* `submitBlindCount`, the operation immediately before this one, carried
         *     both guards from the start.
         */
        post: operations["itemizeOrder"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/hub-intakes/{id}/close": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Close an intake
         * @description Permission `hub.intake.close`. Parity is required: the itemized order count must
         *     reconcile to the **authoritative hub-received count**, or `PARITY_NOT_MET`.
         *
         *     **An order in `PAYMENT_REQUIRED` counts toward parity** (§35.6.11). Parity counts
         *     physical parcels itemized, not orders cleared for dispatch. An implementation that
         *     counts dispatch-ready orders will refuse to close correct intakes.
         *
         *     Closing without parity is possible only through `hub.intake.close_exception`, the sole
         *     approved exception route (§35.5.5).
         *
         *     **Idempotency-Key added — CRIT-05 audit remediation**, for consistency with the rest of
         *     the intake sequence (`submitBlindCount`, `itemizeOrder`) that already carries it over the
         *     same connection.
         */
        post: operations["closeHubIntake"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pickup-manifests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List manifests for the acting hub
         * @description Permission `pickup.read`. **Hub-scoped, never vendor-scoped.**
         *
         *     **Paginated — CRIT-10 audit remediation.** This was the one list operation in the
         *     contract still returning an unbounded raw array; every other list response carries
         *     `next_page_token` and this one now matches `listPickupRequests`'s envelope exactly.
         */
        get: operations["listPickupManifests"];
        put?: never;
        /**
         * Create a manifest from confirmed, unmanifested requests
         * @description Permission `pickup.manifest.create`. Ops only.
         *
         *     A manifest is **not vendor-owned** (domain-model §4). It groups stops across vendors,
         *     so vendor scoping must not be applied to it — a vendor may see their own stop, never
         *     the manifest.
         *
         *     Only `CONFIRMED` requests in the unmanifested pool are eligible. A request already on
         *     a manifest is rejected with `ALREADY_MANIFESTED`.
         */
        post: operations["createPickupManifest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pickup-manifests/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        /**
         * Manifest detail with ordered stops
         * @description `pickup.read`. **What a refusal reveals depends on who asks** (MSC-DEC-432, Gate PD-3R1): a staff
         *     member who asks for an existing manifest outside their hubs is `HUB_SCOPE_VIOLATION` and one who
         *     asks for a manifest that does not exist is `NOT_FOUND`; **a Rider who asks for a manifest that is
         *     not assigned to them is `NOT_FOUND`, identical in status, code, body shape and timing class to a
         *     manifest that does not exist** (19.2, 37.3). A rider is never told that a colleague's run exists.
         */
        get: operations["getPickupManifest"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pickup-manifests/{id}/stops": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        /**
         * Set the manual stop sequence
         * @description Permission `pickup.manifest.create`, whose scope explicitly includes ordering stops. **Ordering is manual in Version 1** — there is no
         *     route optimisation, and none may be inferred.
         *
         *     The sequence is a plan, not a constraint: a rider may work stops out of order and the
         *     system must not reject that. Rejecting out-of-order execution would fight the operation
         *     rather than record it.
         *
         *     Rejected once the manifest has left `DRAFT` — see `STATE_CONFLICT`. **Stop ordering stays
         *     open across rider assignment**, which sets a field and does not change the state;
         *     the window closes at dispatch. Corrected at MSC-DEC-405: this read
         *     `DRAFT`/`ASSIGNED`, naming a state the signed machine does not declare.
         *
         *     **Audited as `pickup.manifest.stops_ordered`** — CRIT-09 audit remediation; this
         *     operation existed with no event at all until now.
         *
         *     **Idempotency-Key added — CRIT-05 audit remediation**, alongside CRIT-09's new
         *     `pickup.manifest.stops_ordered` audit event. The final sequence is idempotent by `PUT`
         *     semantics already; the key exists so a connection retry replays one audit row, not two.
         */
        put: operations["setManifestStopOrder"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pickup-manifests/{id}/assign-rider": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Assign a rider to the manifest
         * @description Permission `pickup.manifest.assign`.
         *
         *     **This is the moment vendor self-cancellation closes**. A vendor may
         *     cancel freely before it and not at all after; office cancellation remains available
         *     with a charge. Implementations that place the cutoff at dispatch or at
         *     run start are wrong by one and two steps respectively.
         *
         *     Assignment does **not** start the run.
         */
        post: operations["assignRider"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pickup-manifests/{id}/dispatch": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Dispatch the manifest to the assigned rider
         * @description Permission `pickup.manifest.dispatch`. Requires an assigned rider.
         *
         *     **Dispatch notifies; it does not start the run.** Only the rider starts a run. Three
         *     distinct moments exist here and collapsing any two of them loses a rule: assignment
         *     (cancellation closes), dispatch (rider notified), run start (rider acts).
         */
        post: operations["dispatchManifest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pickup-manifests/{id}/start": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Rider starts the run
         * @description Rider only, assigned rider only (`NOT_ASSIGNED_RIDER`).
         */
        post: operations["startRun"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pickup-manifests/{id}/custody-handover": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Open a custody handover on a started run
         * @description `fleet.custody.initiate` - Ops, Senior Ops, Platform Admin at own hub.
         *
         *     **Ops-held because the rider who needs it cannot use it.** The scenario is a rider stranded
         *     mid-run with collected parcels aboard: broken down, injured, or holding a destroyed handset.
         *
         *     Names exactly one destination - another active rider for a field transfer, or **the hub**,
         *     which 43.4 requires wherever a field handover would be unsafe.
         *
         *     **Opening a handover moves nothing.** Custody stays with the original rider until acceptance,
         *     so no window exists in which nobody holds the parcels.
         */
        post: operations["initiateRunCustodyHandover"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pickup-manifests/{id}/custody-handover/accept": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Take custody of a started run's parcels
         * @description `fleet.custody.accept` - the **named receiving rider**, or Ops where the destination is the hub.
         *
         *     **Custody transfers here, and completion authority follows it.** After acceptance the receiver
         *     may complete the run and submit the hub handover; the original assigned rider may not, and
         *     receives `NOT_CUSTODY_HOLDER` if they try.
         *
         *     **`parcel_count_taken` is a custody record and never an authoritative count.** The hub blind
         *     count still runs independently at intake (22.4). Seeding the hub with a figure to match is the
         *     failure HubIntakePreCount omits a field to prevent.
         *
         *     **Completed-stop attribution is unchanged.** Stops worked before the transfer stay attributed
         *     to the original rider (43.4). The receiver inherits the remaining work, never the record.
         */
        post: operations["acceptRunCustodyHandover"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/run-custody-handovers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List the custody handovers this actor is a party to
         * @description `fleet.custody.read` - **a rider sees the handovers they are a party to**, as originating or
         *     as named receiver; Ops, Senior Ops and Platform Admin see their own hub's.
         *
         *     **Scoped server-side, never by filter** (37.6, 42.4). A rider does not pass their own id and
         *     cannot pass another's: the scope is `from_rider_id` or `to_rider_id` equal to the acting
         *     rider, which is data-scope-registry.md's "party to the handover" stated as a query.
         *
         *     **This is how a named receiver learns there is a handover at all.** Both surfaces are
         *     pull-only and no push exists for any native-app event, so without this list a rider
         *     named as receiver had no way to discover the manifest id acceptRunCustodyHandover requires.
         *
         *     **It does not widen what a receiver may read of the run.** PickupManifest and PickupStop
         *     stay scoped to the assigned rider in data-scope-registry.md, and 36.14 forbids a rider-ID
         *     edit as a substitute for a handover - so the receiver takes custody, Ops skips the remaining
         *     stops (state-machines.md 5, an OPS transition), and the custody holder submits the hub
         *     handover with the manifest id this record carries. The receiver never needs the stop list.
         *
         *     **Paginated**, the envelope every list in this contract uses.
         */
        get: operations["listRunCustodyHandovers"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pickup-manifests/{id}/hub-handover": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * The custody holder hands the run's collected parcels to the hub, one row per pickup request
         * @description Rider only, **the custody holder** only. Idempotent. **This is the run's completion**:
         *     state-machines.md 4's IN_PROGRESS to COMPLETED by the custody holder, amended and
         *     re-signed at MSC-DEC-416.
         *
         *     **One row per collected pickup request (§22.2, MSC-DEC-416).** The rows must be exactly
         *     the run's collected requests - every COLLECTED or PARTIALLY_COLLECTED stop's request,
         *     each once, and none other - or the handover is refused with VALIDATION_FAILED, naming the
         *     row. **Each row opens one intake** at AWAITING_COUNT, and the response is those intakes
         *     in row order. A run with nothing collected never reaches this operation: System
         *     completes it, with no handover and no intake (state-machines.md 4).
         *
         *     **A zero row is legal and never quiet.** It declares that a collected request's parcels
         *     are not in the handover. Its intake opens all the same, and after the blind count it goes
         *     to RECONCILIATION_REQUIRED whatever the variance, so Senior Ops resolves it with a reason
         *     (state-machines.md 7). §22.2's bar on an empty intake governs a zero COLLECTED count,
         *     which the pickup-failure flow handles upstream.
         *
         *     **captured_at is the field time, and the server keeps its own receipt time.** This is
         *     Version 1's one offline command: a handover queued with no connection may
         *     arrive long after it was made, so each intake records declaration_captured_at from this
         *     field and handed_over_at from the server - §35.3.9's original capture time, distinct from
         *     upload time. It is client-supplied for the reason Evidence.captured_at is.
         *
         *     *Superseded, 26 September 2026:* one `declared_count` for the whole run, stored on "the
         *     intake" - which could not fill one intake per pickup request.
         *
         *     **The custody holder, which is not always the assigned rider.** state-machines.md 4 names
         *     the actor for IN_PROGRESS to COMPLETED as *"the custody holder - the assigned rider, or
         *     whoever accepted a RunCustodyHandover"*, and the row is SIGNED. Ordinarily they are the
         *     same person. After a RunCustodyHandover (4.1, MSC-DEC-246) they are not, and the refusals
         *     separate: a rider with no relation to the run gets NOT_ASSIGNED_RIDER, and **the assigned
         *     rider who has handed custody over gets NOT_CUSTODY_HOLDER** - the distinction
         *     errors-and-enums.md states in terms. Until MSC-DEC-404 this operation declared only the
         *     first, and read *assigned rider only*, which refused the very receiver
         *     acceptRunCustodyHandover promises may complete the run.
         *
         *     Each row's count is **pre-filled from that request's collected total and correctable
         *     before submission** (§22). What the rider submits is a declaration, not a measurement.
         *
         *     **This value never seeds the hub blind count.** Each row is stored on its intake as
         *     `rider_declared_count` and is withheld from every pre-count response — see
         *     `HubIntakePreCount`, which has no such property by schema. A package lost between the
         *     last door and the hub is visible only because these two numbers are produced
         *     independently (MSC-DEC-194 part 3).
         */
        post: operations["submitHubHandover"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pickup-stops/{id}/handshake": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Generate and display the collection handshake code
         * @description Rider only, assigned stop only. **The primary rung of the ladder**: the
         *     rider displays the code and the vendor enters it in Melarc Vendor.
         *
         *     The code is subject to `handshake_code_ttl_minutes` and
         *     `handshake_max_wrong_attempts`.
         *
         *     **The code value is never returned to any surface but the rider's, never logged, and
         *     never written to an audit event** — audit records that a code was generated, never what
         *     it was.
         */
        post: operations["initiateHandshake"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pickup-stops/{id}/handshake/verify": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Vendor submits the code
         * @description Vendor account, own stop only. Records channel `PORTAL`.
         *
         *     Wrong codes count toward `handshake_max_wrong_attempts` and then `ATTEMPTS_EXHAUSTED`;
         *     expiry is `CODE_EXPIRED`.
         *
         *     **The channel is always recorded**, even on the primary path. A stop whose channel is
         *     null is a defect: persistent fallback use is only visible as data if the ordinary case
         *     is recorded too.
         */
        post: operations["verifyHandshake"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pickup-stops/{id}/handshake/sms-fallback": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Fallback 1 — send the code to the vendor's registered number
         * @description Rider triggers, at the door, when the portal path is genuinely unusable — no data,
         *     portal down (MSC-DEC-198 fallback 1).
         *
         *     **Sent to the registered number only.** A rider-supplied number is not accepted; a
         *     vendor with no registered number gets `NO_REGISTERED_NUMBER`.
         *
         *     **"Busy" is not a trigger.** The ladder addresses technical failure, not vendor
         *     inattention. A vendor too busy to read a code is subject to the ordinary door wait
         *     (`rider_door_wait_minutes`, 10) and then the ordinary failure flow. Treating
         *     inattention as a fallback trigger would convert an exception path into the normal one.
         *
         *     **Server-enforced, not client-side guidance — CRIT-08 audit remediation.** Refused with
         *     `SMS_FALLBACK_LIMIT_REACHED` where `sms_fallback_max_per_pickup` (3) sends have already
         *     gone out for this stop's handshake, or where `sms_fallback_cooldown_seconds` (60) has not
         *     yet elapsed since the last one. Exhausting the cap is not a dead end: Fallback 2
         *     (`authoriseHandshakeOverride`) is the ladder's next rung, built for exactly this case.
         *
         *     Every use is logged, so persistent fallback use becomes visible data.
         */
        post: operations["requestSmsHandshakeFallback"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pickup-stops/{id}/handshake/ops-override": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Fallback 2 — Ops authorises the handshake as a recorded exception
         * @description **Ops by definition** (MSC-DEC-198 fallback 2) — not the rider, and not the vendor.
         *     Used when SMS has also failed. Ops verifies the vendor by another means and authorises
         *     the handshake.
         *
         *     Requires a reason. Records channel `OPS_OVERRIDE` and the authorising actor.
         *
         *     This is a policy waiver rather than a verification step, so it sits with Ops under
         *     MSC-DEC-204's override-authority principle.
         */
        post: operations["authoriseHandshakeOverride"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/hub-intakes/{id}/discrepancy": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Adjudicate an over, short or damaged outcome
         * @description Permission `hub.osd.adjudicate`. **Senior Ops** for a variance outcome.
         *
         *     Recorded against the committed comparison, never in place of it: the declared count,
         *     the hub count and the variance survive adjudication unchanged. Adjudication explains a
         *     discrepancy; it does not erase one.
         *
         *     **Damage is recordable on a matching count.** A `MATCH` variance with a `DAMAGED`
         *     condition is a valid, expected combination — an implementation that only offers
         *     adjudication when counts differ will have no way to record the commonest real case.
         *
         *     **HIGH-11 audit remediation (13 September 2026).** `condition` now carries the fixed
         *     four-value enum §22.5 and domain-model.md's `PickupIntake.condition` already require —
         *     `OK`, `DAMAGED`, `TAMPERED`, `OTHER` — where the schema previously offered only `INTACT`
         *     and `DAMAGED`, so `TAMPERED` could not be submitted and `AC-SLICE-001-42` had no way to
         *     execute. `evidence_ids` is new: `DAMAGED` and `TAMPERED` without a `STORED` reference are
         *     rejected with `EVIDENCE_NOT_STORED`, the same guard `contracts/errors-and-enums.md` §5.7
         *     already describes and this operation had never actually declared.
         */
        post: operations["adjudicateDiscrepancy"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/staff/sign-in": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Staff sign-in with email and password
         * @description Ops, Senior Ops and Platform Admin (§11.2, §37.2).
         *
         *     **Two outcomes with two status codes, not one status code with two meanings**.
         *     Ops Staff receive **200** and a Session. Senior Ops and Platform Admin
         *     receive **202** and an `MfaChallenge` — no session, no session cookie, no CSRF cookie,
         *     no authority of any kind.
         *
         *     **The split is what makes the invariant testable.** A single 200 returning
         *     `oneOf[Session, MfaChallenge]` with Set-Cookie attached could not distinguish "privileged
         *     sign-in correctly withheld a session" from "privileged sign-in issued one", and the rule
         *     that no privileged Session exists before proven MFA is the central control of this Gate.
         *     A test can now assert it against the contract rather than against prose.
         *
         *     Completing the challenge at `/auth/staff/sign-in/mfa` issues the session, already
         *     privileged for its lifetime.
         *
         *     **A privileged identity whose password is correct but which has no `ACTIVE` MFA factor** receives
         *     the same `202` challenge as an enrolled one, so this answer reveals nothing about the factor. The
         *     refusal is `completeStaffMfaSignIn`'s: `MFA_ENROLMENT_REQUIRED`.
         *
         *     **`INVALID_CREDENTIALS` is returned identically** for an unknown email, a wrong password
         *     and a suspended account, with matching timing. Distinguishing them confirms which
         *     addresses are real staff, and Melarc staff emails follow a predictable pattern (§37.7).
         *
         *     The audit record does distinguish them (`auth.session.failed`) — undifferentiated
         *     outward, precise inward.
         *
         *     **Lockout is deliberately silent here**. A staff password is the first factor, so nothing has been proved when it is wrong, and announcing a lock to an unproved caller would let anyone learn which addresses are real staff by locking one. After `signin_max_attempts` (5) consecutive wrong passwords for an existing, active, credentialed identity the credential is locked for `signin_lockout_minutes` (15): every sign-in in that window, correct password included, is `INVALID_CREDENTIALS`, is not verified and does not extend the lock. Unknown, inactive and uncredentialed identities never lock and answer identically. The count resets on a complete sign-in, when the lock expires, and when a credential is set or recovered. A request refused by the rate limit (`RATE_LIMITED`) is neither verified nor counted.
         */
        post: operations["staffSignIn"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/staff/sign-in/mfa": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Present the second factor and receive the session
         * @description Completes a two-step sign-in for Senior Ops and Platform Admin.
         *
         *     **No session exists until this succeeds.** The challenge alone grants nothing - it is not a
         *     partial session, and it carries no authority.
         *
         *     The issued session is **privileged for its whole lifetime**. Elevation was withdrawn, so
         *     nothing re-challenges the user afterwards. MSC-DEC-234 bounds that exposure with two
         *     per-tier controls: session_lifetime_minutes 480 and session_idle_timeout_minutes **15**
         *     for privileged roles. The idle control is the operative one - the exposure is an
         *     unattended browser, which an absolute lifetime cannot tell apart from a working user.
         *
         *     **A wrong code counts twice**: against the challenge (`mfa_max_attempts` 3, then `CHALLENGE_UNUSABLE`) and against the identity's failed-attempt count shared with the password, so a thief who knows the password cannot guess codes across fresh challenges. The caller holds a live challenge - the password was proved - so a locked identity is told `CREDENTIAL_LOCKED` here. A complete sign-in resets the count.
         *
         *     **An identity with no `ACTIVE` MFA factor** (privileged, password correct, no factor proven yet) is answered `MFA_ENROLMENT_REQUIRED` with `403` here, never at `staffSignIn`, which gave it the same `202` challenge as an enrolled identity. **That attempt does not count towards the lockout**: no factor was presented. No session is issued.
         */
        post: operations["completeStaffMfaSignIn"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/rider/sign-in": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Rider sign-in with phone, PIN and registered device
         * @description Registered phone plus private PIN **on the one registered device** (§11.2, §37.2).
         *
         *     A request without a valid device proof is refused and no session is
         *     issued. Re-registration is **not self-service** — Senior Ops verifies identity (§37.2).
         *
         *     **Loss and theft are settled**: `revokeRiderDevice` revokes the binding on
         *     report with no identity check, and re-registration requires the rider at a hub in person.
         *
         *     **Any existing live session for this rider is terminated** with `REPLACED_BY_NEW_SESSION`
         *     - a NEW LOGIN displacing an older one, which is what that reason means.
         *
         *     **Device REVOCATION is a different event with a different reason**: revokeRiderDevice
         *     terminates with `DEVICE_REVOKED` (MSC-DEC-264, R1). Collapsing the two would make a stolen
         *     handset look like an ordinary second sign-in in the session record.
         *
         *     **The challenge is single-use and lives 5 minutes**. A FAILED signature
         *     consumes it: a nonce that survives a bad signature is an oracle to hammer, and requiring a
         *     fresh challenge per attempt routes every attempt through the rate limiter.
         *
         *     **An expired challenge is `CHALLENGE_EXPIRED` and a consumed or otherwise unusable one is
         *     `CHALLENGE_UNUSABLE`; neither is `DEVICE_PROOF_INVALID`**, which means only that the
         *     signature did not verify against the expected registered key.
         *
         *     **No platform attestation is evaluated at sign-in** (MSC-DEC-427, clarifying MSC-DEC-387).
         *     The server's trust decision is the rider's authentication material, the current device
         *     record and its status, the registered public key, the signature over this challenge, the
         *     challenge's freshness and single use, and the fact that the registration was accepted
         *     through key attestation at enrolment. **No third-party service is called**, so a sign-in
         *     never waits on one and `DEVICE_INTEGRITY_FAILED` is not declared here.
         *
         *     **The client does not nominate the device**. A rider has at most one `ACTIVE`
         *     production device, so the server resolves it from the rider and verifies the signature
         *     against its registered public key; **no copyable identifier is submitted**. The order the factors are decided in
         *     is set out below, and it is what each refusal is called.
         *
         *     **`client_root_signal` is a recorded risk signal and nothing more.** `DETECTED` is recorded
         *     on the session and in the audit trail and **does not by itself block sign-in**;
         *     `NOT_DETECTED` is not evidence that the device is trustworthy; `UNKNOWN` means the client
         *     could not establish a result, and is valid. A signature that does not verify is refused
         *     whatever the signal says.
         *
         *     **The order the factors are decided in is the rule** (MSC-DEC-431, MSC-DEC-432; SECURITY_DESIGN.md 13.4b). (1) The challenge: unknown or consumed is `CHALLENGE_UNUSABLE`, expired is `CHALLENGE_EXPIRED`, and any other request consumes it, pass or fail. (2) If the phone belongs to a rider with an `ACTIVE` device, the signature must verify against that key: if it does not the answer is `DEVICE_PROOF_INVALID`, **the PIN is never looked at and nothing is counted** - so a caller who does not hold the handset can neither guess the PIN nor lock the rider out. (3) If the phone is unknown, or the rider has no `ACTIVE` device, there is no proof to check, so the PIN is decided instead: wrong is `DEVICE_PROOF_INVALID` - the answer for an unknown phone - and right is `DEVICE_NOT_ENROLLED`. Nothing is counted here, and a PIN learned here dies at the next enrolment, which sets a new one. (4) With a valid signature, a status other than `ACTIVE` is `INVALID_CREDENTIALS`: the PIN is not examined, nothing is counted and no lock is announced, because the factor has not been reached. (5) With a valid signature and an `ACTIVE` status, a locked rider is `CREDENTIAL_LOCKED` and the PIN is not examined. (6) Otherwise a wrong PIN is `INVALID_CREDENTIALS` and counts toward the lockout (`signin_max_attempts` 5, `signin_lockout_minutes` 15). A correct PIN resets the count and issues the session. Every path performs one hash verification, so timing does not say which stage ended the request.
         */
        post: operations["riderSignIn"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/vendor/sign-in": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Vendor sign-in on the shared credential
         * @description One shared credential per vendor organisation, **one active session** (§11.2, §37.2).
         *
         *     **Three factors, all required**: the account identifier, the shared secret,
         *     and a valid `melarc_vendor_device` cookie proving this browser is the registered one.
         *     **Until R1.2 the third was decorative** - the credential was issued at setup and demanded
         *     by nothing, so a stolen shared secret alone signed in from any browser, which is precisely
         *     what the device credential exists to prevent.
         *
         *     **This operation does not issue a new device credential or rotate one.** It proves one that
         *     already exists, and **renews its lifetime**: the same credential is set again with a fresh
         *     `Max-Age` (`x-cookies`), so a browser in regular use never reaches the end of its 400 days.
         *     Rotation happens only where a browser is deliberately being registered - initial setup and
         *     recovery - because a login that silently re-registers whatever browser presents itself
         *     registers the attacker's browser too.
         *
         *     **A failure of any factor is reported identically.** `INVALID_CREDENTIALS` covers an
         *     unknown account, a wrong secret and an unregistered browser, in content and in timing.
         *     Distinguishing them would tell an attacker which of the three they had already defeated.
         *
         *     **A successful sign-in terminates the earlier session** with `SUPERSEDED_BY_NEW_LOGIN`.
         *     The displaced device receives `SESSION_SUPERSEDED` on its next call — not a generic 401.
         *     A colleague signing in elsewhere is routine on a shared credential, and a message reading
         *     "your session expired" invites a support call about a system working as designed.
         *
         *     **Audit identifies the account, never a person** (§37.5). Version 1 has no person-level
         *     attribution for vendors, and no surface may claim it.
         *
         *     **The order the factors are decided in is the rule**. (1) The registered browser: the `melarc_vendor_device` credential must be bound to the account named; if it is absent, unknown or bound to another account the answer is `INVALID_CREDENTIALS`, **the secret is not examined and nothing is counted** - so nobody can lock a vendor organisation out from a browser it never registered. (2) An account that is not `ACTIVE` is `INVALID_CREDENTIALS`. (3) With the browser proved, a locked account is `CREDENTIAL_LOCKED`. (4) A wrong secret is `INVALID_CREDENTIALS` and counts - `signin_max_attempts` 5 and `signin_lockout_minutes` 15, shared by everyone using the credential, the consequence §37.5 already accepts; a correct secret resets the count. Every path performs one hash verification, so timing does not say which stage ended the request.
         */
        post: operations["vendorSignIn"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The caller's current session
         * @description Returns principal, authorized hub set, expiry and the permission keys the session holds
         *     (`permissions`: from the session's snapshot, keys only, never role names). **Never the
         *     session credential.**
         *
         *     **There is no elevation state**. This described a field the Session schema has
         *     never carried.
         */
        get: operations["getCurrentSession"];
        put?: never;
        post?: never;
        /**
         * Sign out
         * @description Terminates the session with `SIGNED_OUT`. Idempotent.
         *
         *     **The session is ended on the server.** Expiring a cookie does not end a session: a client that
         *     kept the credential could still present it, so the session record is terminated whatever the
         *     client does with its cookies.
         *
         *     **A browser sign-out also expires the browser's cookies.** `melarc_session` and `melarc_csrf` are
         *     set again with `Max-Age=0` (an expiry in the past), host-only, `Path=/` and the `Secure` and
         *     `SameSite=Lax` attributes they were issued with (`HttpOnly` for the session), because a browser
         *     removes the cookie it holds only when the expiry matches it. `melarc_vendor_device` is **never**
         *     cleared: it identifies the vendor's registered browser and is not a session. **A Rider bearer
         *     sign-out sets no cookie**: a native client has none to clear.
         */
        delete: operations["signOut"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The live sessions of one principal, so an administrator can revoke the right one
         * @description `staff.read`, with the same tiering `revokeSession` carries: **Platform Admin for staff and vendors,
         *     Senior Ops for riders at their own hub**. A Senior Ops caller asking for a staff or vendor principal
         *     holds the key and not the tier, so the answer is `INSUFFICIENT_AUTHORITY`. The list is
         *     the read that gives the `revokeSession` screen something to show (Gate PD-3R1, `PDA-56`).
         *
         *     Returns the principal's `ACTIVE` sessions only, newest first. **No session credential, no token hash and
         *     no bundle contents** are returned (see Session). A principal that does not exist is `NOT_FOUND`.
         */
        get: operations["listSessions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/sessions/{id}/revoke": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Administratively revoke a session
         * @description Platform Admin for staff and vendors; Senior Ops for riders (§37.2).
         *
         *     Requires a reason. Terminates with `ADMIN_REVOKED` and emits an enhanced audit event.
         *
         *     This is the control §37.5 requires for a compromised **shared vendor credential**: the
         *     session can be cut without waiting for the vendor to change the secret.
         *
         *     **Tiers and the read** (MSC-DEC-432, Gate PD-3R1): Platform Admin may revoke a staff or vendor session; Senior Ops may revoke a rider session at their own hub. A Senior Ops caller naming a staff or vendor session holds the key and not the tier: `INSUFFICIENT_AUTHORITY`. The session is found with `listSessions`. The next request on the revoked session is `SESSION_INVALID`: revocation is a state change on the session record itself, with no cache between the decision and its effect.
         */
        post: operations["revokeSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/recovery/request": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Request recovery to a registered channel
         * @description Self-service, for staff and vendors. **Riders have no self-service path** (37.2) — a
         *     rider who has lost the handset cannot receive a token, because the device is half the
         *     credential.
         *
         *     **The request carries no destination.** The channel is resolved from the principal's
         *     registered work email, phone or account email. A supplied address is rejected outright.
         *     Accepting one would let anyone redirect a colleague's recovery, which is the single most
         *     exploitable mistake available here.
         *
         *     **Always returns 202**, whether or not the identifier exists, with matching timing. An
         *     enumerable recovery endpoint discloses which addresses are real staff (37.7).
         *
         *     Issuing supersedes any PENDING request for that principal, **except inside the supersede
         *     guard**: a request made less than `recovery_request_supersede_guard_seconds` (60, a starting
         *     value) after the pending link was issued neither supersedes it nor issues another, and is
         *     answered with the same `202` as any other, so nothing is revealed.
         *
         *     **A suspended principal's request proceeds like any other**; the suspension stands. **A message the delivery channel refuses changes nothing the caller can see**: the request is rolled back, the failure is logged and counted by the provider-failure alert, and `CREDENTIAL_DELIVERY_FAILED` is never returned here.
         */
        post: operations["requestCredentialRecovery"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/recovery/complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Consume a recovery token and set a new credential
         * @description **The sole consumer of a `RecoveryRequest`**, whoever created it (R1.3): the principal
         *     themselves through `requestCredentialRecovery`, or a Platform Admin through
         *     `recoverStaffCredential` or `recoverVendorCredential`. All three produce the same entity
         *     and this operation consumes it, which is why `RECOVERY_TOKEN_INVALID` is the only
         *     token-failure code it can return.
         *
         *     **`principal_type` on the `RecoveryRequest` discriminates the target** - `STAFF` replaces a
         *     password, `VENDOR` replaces a shared secret and rotates the browser device credential. No
         *     new discriminator was needed; the field already existed.
         *
         *     **Single use.** The token is marked CONSUMED; a second attempt fails. A reused token is a
         *     signal, not a retry.
         *
         *     **Completing terminates every session for the principal** with CREDENTIAL_CHANGED,
         *     including the session performing the recovery. 37.5 requires recovery to "revoke or
         *     control prior sessions" — and on the shared vendor credential that is the whole purpose:
         *     the vendor is usually trying to remove access from someone who knows the secret.
         *
         *     **Recovery never lifts a suspension.** A suspended principal who completes recovery is
         *     still suspended, and sign-in still fails.
         *
         *     **On the vendor branch this also replaces the browser device credential**.
         *     Prior `melarc_vendor_device` credentials are revoked and a fresh one is issued to the
         *     browser completing recovery. Rotating only the shared secret would have left the person
         *     the vendor is removing still holding a registered browser — **and on an account shared by
         *     design, removing that person is the entire purpose of recovery.**
         *
         *     **No Session is created here.** Recovery replaces credentials; the vendor then signs in
         *     normally. Issuing a session from a recovery link would make the link an authentication
         *     path, which is the one thing a setup credential must never be.
         *
         *     **Completion clears the credential's failed-attempt count and any lock**, so a locked staff member or vendor recovers by recovering. The new credential is held to the length bounds on `RecoveryComplete` (12 to 128 characters, spaces permitted, no composition rule). Completion by a suspended principal changes the credential and nothing else: the suspension stands (§29.6).
         */
        post: operations["completeCredentialRecovery"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/ops/riders/{riderId}/device/revoke": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                riderId: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Revoke a rider's device binding on report of loss or theft
         * @description Held by `staff.device.revoke` - **Ops Staff, Senior Ops and Platform Admin at own hub**.
         *
         *
         *     An existing rider outside the actor's hubs is `HUB_SCOPE_VIOLATION`; one that does not exist is `NOT_FOUND`. Revocation stays unverified and unconditional inside the actor's hubs.
         *
         *     **This operation performs no identity verification, deliberately.** Revocation is cheap
         *     and reversible: the worst outcome of a mistaken call is a rider who must re-register.
         *     Verifying identity first would leave a stolen handset live for exactly as long as the
         *     check took, which is the window an attacker needs.
         *
         *     **The rider's active Session terminates with `DEVICE_REVOKED`** (MSC-DEC-264, R1) - not
         *     `SUPERSEDED_BY_NEW_LOGIN`, which means a newer login displaced an older one and would make
         *     a stolen handset indistinguishable from an ordinary second sign-in in the session record.
         *
         *     **It grants nothing.** Re-registration is a separate, more restricted operation -
         *     `reregisterRiderDevice` under `staff.device.reregister`, Senior Ops - and MSC-DEC-235
         *     requires the rider to attend a hub **in person** for it. There is no remote re-binding
         *     path, and that is a decision rather than an omission: phone-based identity verification
         *     is the weakest link in this model.
         *
         *     **One termination reason applies here: `DEVICE_REVOKED`.** This description previously
         *     closed by saying the session terminates with `SESSION_SUPERSEDED`, contradicting its own
         *     preceding paragraph. `SUPERSEDED_BY_NEW_LOGIN` is vendor session displacement and nothing
         *     else; `SESSION_SUPERSEDED` is the error code a displaced VENDOR client reads, not a
         *     termination reason at all.
         */
        post: operations["revokeRiderDevice"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/orders/{id}/confirmation": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        /**
         * The order's recipient-confirmation record and every attempt
         * @description Permission `dispatch.read`.
         *
         *     Returns **every attempt**, not a count. 24.2 requires attempts be persisted and "not kept
         *     only in transient UI state" - a bare counter cannot answer when an attempt happened or
         *     what the outcome was, which is exactly what a dispute needs.
         */
        get: operations["getRecipientConfirmation"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/orders/{id}/confirmation/attempts": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Record the PRE_DISPATCH recipient-contact checkpoint
         * @description Permission `dispatch.recipient_confirmation.work`. **Checkpoint one of three**,
         *     writing a RecipientContactAttempt with checkpoint = PRE_DISPATCH.
         *
         *     **Either the assigned Rider or authorised Ops may perform it**, on the
         *     SAME canonical record. A rider is never made to repeat a call Ops already made - two
         *     parallel confirmation systems would give two answers to *has this recipient been
         *     reached*.
         *
         *     **Confirming clears the parcel for dispatch. Being planned onto a draft run does not**:
         *     an unresolved or failed checkpoint holds the parcel in hub custody, and
         *     DISPATCH_NOT_CLEARED refuses it into a finalised physical load. Confusing *assigned to
         *     a run* with *permitted to leave the hub* is how an undeliverable parcel gets onto a
         *     motorcycle.
         *
         *     **A failure here is not a physical delivery attempt.** No rider has travelled.
         *
         *     **Confirmation is mandatory before a doorstep parcel enters a run, regardless of payer**
         *     (20.2, 24.3). Not "where the recipient pays" - regardless of payer. A fully vendor-paid
         *     parcel still requires the call, and this is the rule most likely to be reasoned away by
         *     someone concluding that a prepaid parcel needs no recipient contact.
         *
         *     Four outcomes, and only one of them advances the order:
         *
         *       confirmed            -> the order becomes run-eligible
         *       reschedule           -> held
         *       address_correction   -> held
         *       unreachable          -> held
         *
         *     **Three of the four hold the order and none of them is a failure.**
         *
         *     **There is NO fixed contact-attempt ceiling**. Retry whenever it is
         *     operationally useful - a Vendor-supplied number, an alternative contact, another try
         *     before the run departs. **No force-extension is required to call again**, and
         *     exhausted calls do not start Return by themselves.
         *
         *     **Clearance is outcome-based, never count-based.** A call count is audit history.
         *     escalated_at is set when OPS JUDGES the contact avenues exhausted, and the order
         *     enters a senior decision queue - held, not lost.
         *
         *     An address correction that moves the order to a different SERVICE AREA after price freeze
         *     triggers the 35.6.8 repricing path: Ops requests, hub Senior Ops approves, and both price
         *     versions are preserved.
         */
        post: operations["recordConfirmationAttempt"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/orders/{id}/confirmation/escalate": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Ops escalates an order as contact-exhausted, by judgement and never by count
         * @description `dispatch.recipient_confirmation.work` - **Ops, Senior Ops or Platform Admin at own hub**.
         *     The key is also held by the assigned Rider on assigned parcels, and **a Rider
         *     is refused here with INSUFFICIENT_AUTHORITY**: escalation is an Ops judgement,
         *     and a rider may make the call, record it, and ask for help - never decide that the avenues
         *     are exhausted.
         *
         *     **The entrance to the senior decision queue** (state-machines.md 11, `→ ESCALATED`).
         *     MSC-DEC-230 gave the queue two exits and MSC-DEC-351 removed the counter that used to put
         *     an order into it; until Gate C C1.9 nothing put an order into it at all - the audit event
         *     `dispatch.confirmation.escalated` existed, `escalated_at` existed, and no operation set it.
         *
         *     **A mandatory reason, and no call count in the request.** Ops states why the avenues are
         *     exhausted - number unreachable and Vendor unresponsive, recipient declines to give a date,
         *     address unresolvable - and the attempt rows are the evidence beside it. The order is held,
         *     not lost.
         *
         *     **Leaving the queue.** A new useful avenue - a Vendor-supplied number, an alternative
         *     contact - is exercised by recording a further attempt through `recordConfirmationAttempt`,
         *     which returns the order to AWAITING_ATTEMPT with **no force-extension and no ceremony**.
         *     The other exit, a deliberate authorised Return with a mandatory reason, is the formal
         *     Return act and lands with SLICE-006.
         *
         *     **IDEMPOTENT.** A retried submission escalates once and emits once.
         */
        post: operations["escalateRecipientConfirmation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/delivery-runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List runs for the acting hub
         * @description Permission `dispatch.read`. **Hub-scoped.**
         *
         *     **Paginated — post-session audit remediation, CRIT-10's sibling.** Was an unbounded
         *     raw array, the same shape `listPickupManifests` carried before CRIT-10; matches
         *     `listPickupRequests`'s envelope exactly.
         */
        get: operations["listDeliveryRuns"];
        put?: never;
        /**
         * Open a draft delivery run
         * @description Permission `dispatch.run.create`. Ops only.
         *
         *     **Hub-scoped, never vendor-scoped** - a run spans vendors, so a vendor filter applied to
         *     it would either leak one vendor's existence to another or return an incoherent partial run.
         *
         *     A run **may freely mix carrier identities and commercial modes** (24.3, 24.7,
         *     MSC-DEC-154-155). Registered-courier and informal stops, STATION_DROP and
         *     MELARC_COVERED_THIRD_PARTY_DELIVERY, may share one run. **Ops is not required to build
         *     separate runs per mode**, and an implementation enforcing separation invents a constraint
         *     the specification explicitly removes.
         *
         *     **courier_provider_id, when given, must name an ACTIVE CourierProvider** - 24.4's
         *     *"selects active registered courier"*, checkable since MSC-DEC-417 fielded the register.
         *     An absent or inactive entry is VALIDATION_FAILED, as delivery-run-build.md's refusal
         *     table has it. **It is the plan, not the fact**: the handoff captures the courier actually
         *     handed to (36.10), and nothing requires the two to match.
         */
        post: operations["createDeliveryRun"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/delivery-runs/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        /** Run detail with ordered stops */
        get: operations["getDeliveryRun"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/delivery-runs/{id}/stops": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        /**
         * Set the manual stop sequence
         * @description Permission `dispatch.run.sequence` - **A S P, own hub, confirmed at MSC-DEC-232** (OQ-075
         *     closed 21 August 2026).
         *
         *     Manual ordering only. Version 1 has **no route optimisation** and none may be inferred.
         *     The sequence is a plan, not a constraint: a rider may work stops out of order and the
         *     system must not reject that.
         *
         *     **Adding a stop rechecks confirmation, availability and lane compatibility** (24.3). A stop
         *     that was eligible when the run was drafted may not be eligible now.
         */
        put: operations["setDeliveryStopOrder"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/delivery-runs/{id}/assign-rider": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Assign a rider to the run
         * @description Permission `dispatch.run.assign` - **A S P, own hub, confirmed at MSC-DEC-232** (OQ-075
         *     closed 21 August 2026).
         *
         *     A distinct permissioned act, not a step inside dispatch (MSC-DEC-222 applied
         *     symmetrically). Assignment does **not** dispatch, and dispatch does **not** start the run:
         *     three moments, three operations, each governing a different rule.
         */
        post: operations["assignDeliveryRider"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/delivery-runs/{id}/dispatch": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Dispatch the run - atomic, all-or-nothing
         * @description Permission `dispatch.run.dispatch`.
         *
         *     **24.5 makes this all-or-nothing, and the revalidation is the operation.** At commit the
         *     server revalidates, in one transaction:
         *
         *       - rider still active
         *       - rider's assigned motorcycle still serviceable (34.10) - CRIT-06 audit remediation;
         *         pickup-manifest.md's dispatch already revalidated this and atomic dispatch did not
         *       - courier still active, where an outbound mode requires one - the run's
         *         courier_provider_id, when set, still ACTIVE on the register
         *       - EVERY order's credit or payment gate - CREDIT_RESERVED, PREPAID or NO_VENDOR_CHARGE;
         *         a zero vendor portion is a satisfied gate, not a missing one
         *       - EVERY order's readiness and availability
         *       - lane compatibility
         *
         *     **If one check fails, every change rolls back.** The run stays DRAFT. Not "the failing
         *     stop is dropped and the rest proceed" - that is the plausible-looking implementation and
         *     it is wrong: 35.7.5 forbids the same order reaching two destinations through concurrent
         *     actions, and partial dispatch is how that happens.
         *
         *     **A rollback emits `dispatch.run.rollback`.** Without it a failed dispatch leaves no trace
         *     and is indistinguishable from Ops never pressing the button.
         *
         *     **One run-level rider notification follows success** (24.5) - one, not one per stop.
         *
         *     Outbound orders carry a second gate the credit gate does not satisfy: STATION_DROP cannot
         *     dispatch until its fee snapshot is backend-confirmed paid, and
         *     MELARC_COVERED_THIRD_PARTY_DELIVERY until the combined waybill-plus-Melarc charge is
         *     (35.7.7, 35.7.8).
         */
        post: operations["dispatchDeliveryRun"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/delivery-runs/{id}/start": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Rider starts the run
         * @description Rider only, assigned rider only. **Dispatch notifies; only the rider starts** (24.6).
         */
        post: operations["startDeliveryRun"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/staff-role-bundles/assignable": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The staff role bundles a maker may name when creating a staff profile
         * @description `permission.assignable_bundle.read` - Ops Staff, Senior Ops and Platform Admin, the bundles
         *     that hold `staff.identity.create` (30.8, MSC-DEC-439, MSC-DEC-443). **Not `permission.read`**:
         *     that key is Platform Admin's alone and gates no operation, so a maker below that tier would
         *     have had no way to fill the form. **Not `staff.identity.create` either**: that key gates
         *     `createStaffIdentity` only, and a read is gated by a read key.
         *
         *     **The key's scope is none.** No hub is named or evaluated, and the key confers no cross-hub
         *     staff-record access (SECURITY_DESIGN 14.1a). **It permits nothing else**: holding it does not
         *     itself permit staff creation, bundle assignment or approval.
         *
         *     **This exists because `createStaffIdentity` requires a `role_bundle_id` and nothing returned
         *     one** (Gate PD-3R2, `PDA-68`). The staff creation screen calls it and carries no list of its
         *     own.
         *
         *     Returns **only the bundles currently valid for assignment to human staff** - never the fixed
         *     Rider and Vendor bundles, never a technical identity's capability set, and never a bundle
         *     the Product Owner has only proposed (permissions.md 8). **The projection is minimal**: the
         *     bundle's `id`, its `name` and `requires_platform_admin_approval` - never its permissions, a
         *     permission count or who holds it. A bundle is configuration and not hub data, so the answer
         *     is the same at every hub.
         *
         *     **Choosing a bundle grants nothing.** The flag reports the existing approval policy
         *     and does not replace it: the profile is created `PENDING_APPROVAL`,
         *     a Platform Admin approves a privileged target, and the creator cannot approve their own
         *     profile. `createStaffIdentity` validates `role_bundle_id` itself and does not trust that the
         *     id came from this list.
         *
         *     Not paged: the assignable set is small and fixed by configuration. The list carries no ETag.
         */
        get: operations["listAssignableStaffRoleBundles"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/staff-identities": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List staff identities, so an approver can find what awaits them
         * @description `staff.read` - Senior Ops at own hub, Platform Admin at all hubs. **Ops Staff do not hold it, by
         *     design** (permissions.md: colleague identity records are personal data), so the maker of an
         *     identity learns its id from the creation response and a *different* person finds it here.
         *
         *     **This exists because maker-checker had no discovery path.** `approveStaffIdentity` takes the
         *     record's id and its ETag, and its approver is by rule someone other than the maker. Nothing
         *     returned the approver either (Gate PD-3R1, `PDA-47`).
         *
         *     Scoped server-side to the actor's hubs; filters are authorization-checked, never trusted. `status` =
         *     `PENDING_APPROVAL` is the approver's queue. The list is for **discovery**: it carries no ETag, and the
         *     ETag an operation takes comes from `getStaffIdentity` on the chosen record.
         */
        get: operations["listStaffIdentities"];
        put?: never;
        /**
         * Create a staff profile, awaiting independent approval
         * @description `staff.identity.create` - Ops Staff, Senior Ops, Platform Admin at own hub (30.8, MSC-DEC-247).
         *
         *     A `primary_hub_id` outside the actor's hubs is `HUB_SCOPE_VIOLATION`; the maker cannot place a profile in a hub they do not act in.
         *
         *     **`role_bundle_id` comes from `listAssignableStaffRoleBundles`**, which returns only the
         *     bundles valid for human staff, under its own key `permission.assignable_bundle.read`;
         *     this operation stays gated by `staff.identity.create`. This operation validates the id itself: one that names no bundle currently
         *     valid for human staff is `VALIDATION_FAILED`, the field named. Naming a privileged bundle grants nothing
         *     and the profile is created `PENDING_APPROVAL` all the same; a Platform Admin must approve a privileged
         *     target.
         *
         *     **The record is created in `PENDING_APPROVAL` and grants nothing.** No session may be issued
         *     against it (state-machines.md 13), and its `role_bundle_id` confers no permission until a
         *     different actor approves. 30.8: an independent approver acts "before it becomes active."
         *
         *     **The caller is recorded as `created_by` and cannot approve this record.** 11.6's same-actor
         *     exclusion is enforced at `approveStaffIdentity` and checkable afterwards from the two actor
         *     fields the record carries.
         *
         *     **MFA is NOT required to assign the bundle**. The former rule was circular -
         *     a new employee could not enrol a factor before authenticating and could not authenticate
         *     before enrolling - and its only exit was an administrator setting a boolean by hand. MFA now
         *     gates the privileged SESSION, not the assignment.
         */
        post: operations["createStaffIdentity"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/staff-identities/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        /**
         * Read one staff identity and the ETag a mutation takes
         * @description `staff.read`. **The read every staff-targeted mutation takes its `If-Match` from**:
         *     `approveStaffIdentity`, `resetStaffMfa`, `reissueStaffCredentialSetup`, `recoverStaffCredential`
         *     and `proposeBundleChange`.
         *
         *     **The ETag changes when the record changes** - status, bundle, name, email, phone, hub, credential
         *     established or changed, factor revoked - and **never because of a failed sign-in**: the failed-attempt
         *     count is not part of the version.
         *
         *     An existing record outside the actor's hubs is `HUB_SCOPE_VIOLATION`; a record that does not exist is
         *     `NOT_FOUND`. No credential property is ever returned (see StaffIdentity).
         */
        get: operations["getStaffIdentity"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/staff-identities/{id}/approve": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Approve or reject a pending staff profile
         * @description `staff.identity.approve` - Senior Ops or Platform Admin (30.8).
         *
         *     An existing record outside the actor's hubs is `HUB_SCOPE_VIOLATION`; one that does not exist is `NOT_FOUND`.
         *
         *     **This is the act that creates a usable identity**, and until 24 August the product had no
         *     way to perform it - CONFLICT-035, "the product cannot have its first user."
         *
         *     **The approver may not be the creator** (11.6, MSC-DEC-135). Returns
         *     `SELF_APPROVAL_FORBIDDEN`, the same code `approveOnePackageException` returns: one uniform
         *     rule keeps one code.
         *
         *     **A Platform Admin is required where the named bundle is privileged** - Senior Ops or
         *     Platform Admin - returning `INSUFFICIENT_AUTHORITY` (MSC-DEC-248, confirmed 26 August under
         *     MSC-DEC-253). **The same holds for rejection**: rejecting a profile that carries a privileged
         *     bundle needs a Platform Admin other than the maker, and a lower tier is
         *     `INSUFFICIENT_AUTHORITY` (`403`).
         *
         *     **Approval does NOT make sign-in possible**. It issues a SetupGrant to the
         *     verified work email; the employee establishes their own password, and a privileged identity
         *     must additionally prove a TOTP factor. An approved identity that has not completed setup
         *     grants zero authenticated access.
         *
         *     Rejection is the same call with `approved: false` and a mandatory reason. It is terminal and
         *     the record stays queryable (36.1). **Its work email is released**: a new profile may use it.
         *
         *     **Where `If-Match` comes from** (Gate PD-3R1, `PDA-47`): the ETag of `getStaffIdentity` on this record. A mismatch is `STATE_CONFLICT`. The approver who is not the maker finds the record with `listStaffIdentities`.
         *
         *     **Delivery** (Gate PD-3R1, `PDA-54`): the grant or link is handed to the delivery channel inside this operation, before it commits, and its raw token is never persisted. If the channel refuses it the operation is rolled back - no grant exists and an earlier pending grant is untouched - and the answer is `CREDENTIAL_DELIVERY_FAILED`; nothing was sent and the caller may issue again.
         */
        post: operations["approveStaffIdentity"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/staff-identities/{id}/bundle": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Propose a permission-bundle change on an active staff record
         * @description `permission.bundle.assign` - MSC-DEC-248, CONFIRMED by the Product Owner 26 August.
         *
         *
         *     **Proposing changes nothing.** The bundle in force is unchanged until
         *     `approveBundleChange` ratifies, exactly as opening a custody handover moves no parcels.
         *
         *     30.8 covers the bundle assigned **at creation** - the checker approves the person and their
         *     authority in one act. This is the separate act 30.3 requires for "assignment **and
         *     changes**" on a record that is already active, and 30 names no authority for it.
         *
         *     **Where `If-Match` comes from** (Gate PD-3R1, `PDA-47`): the ETag of `getStaffIdentity` on this record. A mismatch is `STATE_CONFLICT`. **One gap is recorded here, not closed** (Gate PD-3R2): `permission.bundle.assign` is held by Ops Staff, Senior Ops and Platform Admin, and `getStaffIdentity` needs `staff.read`, which only Senior Ops and Platform Admin hold, so an Ops Staff holder cannot read the version this operation requires. The operation belongs to `SLICE-009`, which decides whether the key's holders or the read's change.
         */
        post: operations["proposeBundleChange"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/staff-identities/{id}/bundle/approve": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Ratify a proposed permission-bundle change
         * @description `permission.bundle.approve` - MSC-DEC-248, CONFIRMED 26 August.
         *
         *     **This is the moment authority changes hands**, which is why 38.5 category 6 makes the
         *     emitted `permission.bundle.assigned` event **enhanced** with `before_after` carrying both
         *     bundles by name.
         *
         *     **The approver may not be the proposer** - `SELF_APPROVAL_FORBIDDEN`. A bundle grant is the
         *     one act that can manufacture every other authority in the system.
         *
         *     **A Platform Admin is required where the target bundle is privileged**, by analogy to 30.9,
         *     where suspending a Senior Ops or Platform Admin requires Platform Admin. The analogy is
         *     an analogy to 30.9 rather than a derivation, and it is the clause that was examined most
         *     closely at signature: without it a Senior Ops could CREATE a peer they may not SUSPEND.
         */
        post: operations["approveBundleChange"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/evidence": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Declare an evidence record and obtain upload instructions
         * @description **Evidence holds no authority of its own.** `x-permission: owner` means the caller must hold
         *     the write permission of the act this evidence attaches to - a rider capturing collection proof
         *     needs `pickup.run.execute`, a receiving officer recording condition needs `hub.osd.adjudicate`.
         *     11.6 draws `domain` from a closed seventeen-item list and **`evidence` is not on it**, which
         *     this reads as correct rather than as an omission: evidence is always captured in the course of
         *     another act, so its authorization is that act's authorization. MSC-DEC-253 confirmed that
         *     reading (OQ-098 closed): `evidence` is not a permission domain, and `x-permission: owner`
         *     stands as the stricter option.
         *
         *     **Step one of two.** This declares the metadata 34.7 requires and returns opaque upload
         *     instructions. The bytes are not sent here.
         *
         *     **The record is created `PENDING_UPLOAD` and cannot be referenced yet.** Any operation
         *     accepting `evidence_ids` rejects a record that is not `STORED` with `EVIDENCE_NOT_STORED` -
         *     which is what stops "attached evidence" being satisfiable by a record with no bytes behind it.
         *
         *     **`captured_at` is client-supplied and `storage_ref` is not.** Field capture time is genuinely
         *     the client's fact (3.6, 7.8 - evidence routinely arrives hours after capture over an
         *     unreliable link). A client-settable storage reference would let a caller point an evidence
         *     record at an object it does not own.
         *
         *     **Nor are the two scope columns**. `responsible_hub_id` and
         *     `vendor_organization_id` are derived from the owner at creation, returned on the read
         *     schema, and immutable. They are absent here for exactly the reason `storage_ref` is: a
         *     caller that could set them would place the record in another hub's or another vendor's
         *     scope, **and the record would look entirely legitimate**.
         *
         *     **The upload instruction is single-object scoped, time limited, size constrained and
         *     checksum constrained**, and the storage key it points at is opaque - it carries no
         *     recipient name, phone number, vendor name or address. A key leaks wherever it is
         *     printed, without ever granting access to the object.
         *
         *     **MED-12 audit remediation: `byte_size` has no `maximum` and `content_type` no enum,
         *     because no maximum or allowed-type whitelist is approved yet** (`OQ-121`,
         *     settings.md `evidence_upload_max_bytes` / `evidence_upload_allowed_mime_types`, both
         *     `OPEN`). This step's own size and checksum constraints are enforced against whatever the
         *     client declares until a ceiling exists to enforce against instead.
         */
        post: operations["createEvidence"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/evidence/{id}/complete": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Confirm the bytes landed, moving the record to STORED
         * @description **Step two of two.** The server validates what actually arrived - content type, byte size and
         *     checksum against what step one declared - and moves the record to `STORED`. Only then may the
         *     record be named in an `evidence_ids` array.
         *
         *     **Gate B widens what is verified and not what is returned**. Before `STORED`
         *     the server additionally checks the **actual file signature** against the declared MIME type
         *     and applies malicious-content validation appropriate to the supported types. A declared
         *     `image/jpeg` whose bytes are not a JPEG is rejected on the signature, not on the header the
         *     client chose. **A mismatch still leaves the record `PENDING_UPLOAD` and still returns
         *     `VALIDATION_FAILED`** - no new error code, because a second code for the same outward
         *     condition is the synonym failure 5.9 of errors-and-enums.md records DEVICE_NOT_REGISTERED
         *     as the cost of.
         *
         *     **Server-side validation is the point of this step, not the client's confirmation.** A client
         *     saying "done" proves nothing; 39.4 requires the contract to define **validation**, and this is
         *     where it happens. A mismatch leaves the record `PENDING_UPLOAD` and returns
         *     `VALIDATION_FAILED`.
         *
         *     **MED-12 audit remediation: "supported types" names a set this contract does not yet
         *     carry.** The file-signature check validates the actual bytes against the declared MIME
         *     type, and there is no closed list of which types are supported in the first place -
         *     `OQ-121` tracks `evidence_upload_allowed_mime_types` and `evidence_upload_max_bytes`,
         *     both `OPEN`.
         *
         *     **This call may later be replaced by a storage-side notification without changing the
         *     record's lifecycle**, which is why the state lives on the record rather than being implied by
         *     the presence of bytes.
         */
        post: operations["completeEvidenceUpload"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/evidence/{id}/retrieval-authorization": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Obtain a short-lived, single-object retrieval authorization
         * @description **Evidence holds no authority of its own**, so this is gated exactly as `createEvidence` is:
         *     `x-permission: owner` means the caller must hold the read permission of the subject this
         *     evidence attaches to. **No new Evidence permission is created** - 11.6's domain list is
         *     closed and evidence is always captured in the course of another act.
         *
         *     **The order of checks is the operation**: authenticate, verify the caller's
         *     existing permission to read the underlying subject, execute principal-specific RLS,
         *     evaluate `access_rule`, confirm the record is `STORED`, and only then issue the capability.
         *     A record that is not `STORED` returns `EVIDENCE_NOT_STORED`.
         *
         *     **This creates no state transition.** The Evidence machine at state-machines.md 17 is
         *     untouched and remains unsigned.
         *
         *     **Private means authorization-private, not network-unreachable.** The object endpoint may be
         *     Internet-reachable for a cryptographically valid, short-lived, single-object signed
         *     operation - that is what makes a presigned URL work, and what makes it safe is that the
         *     platform issued it after checking permission and it grants exactly one object for a few
         *     minutes. There is no anonymous read, no listing, no public ACL and no permanent URL.
         *
         *     **Five minutes** - `evidence_retrieval_authorization_ttl_minutes`.
         *     Deliberately shorter than the fifteen an upload gets: an upload may be redeemed by a rider
         *     on an unreliable link, while a retrieval is redeemed immediately by someone just
         *     authorized, and it is a bearer capability over evidence that may show a recipient, an
         *     address or a signature.
         *
         *     **The response is transient and is never logged.** No storage credential, no listing
         *     authority, no usable `storage_ref`, no permanent URL.
         */
        post: operations["createEvidenceRetrievalAuthorization"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/delivery-stops/{id}/arrive": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Mark arrival at a delivery stop
         * @description `delivery.stop.execute` - the assigned rider only. PENDING to ARRIVED (12.1).
         *
         *     **Arrival is a command, not a screen event.** 36.1: a record must not change state because a
         *     screen changed. The pickup side has the same transition and, since MSC-DEC-392, its own
         *     operation: `arriveAtPickupStop`. It had none from 26 August to 16 September - recorded as
         *     CONFLICT-038, now RESOLVED.
         */
        post: operations["arriveAtDeliveryStop"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/delivery-stops/{id}/payment": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Record cash collected at the door
         * @description `payment.cash.collect` - the assigned rider only (26.2). Records the physical cash tender
         *     actually taken against the stop's OperationalPaymentDemand - moving the order's
         *     RiderCashCustody from EXPECTED to COLLECTED_BY_RIDER on the first tender, and incrementing
         *     it on any later one (16.3, MSC-DEC-365).
         *
         *     **This satisfies nothing by itself and closes nothing financial.** The delivery gate is the
         *     DEMAND reaching SETTLED, which a full tender reaches at once and a short
         *     tender reaches only when the remainder arrives. 36.11: the run and workday stay open until
         *     hub reconciliation or an exception. Two obligations of different lifetimes over one amount.
         *
         *     **A short tender is preserved, never refused; an over-tender is accepted.** A tender below
         *     the remaining due is real money: it is recorded at the amount taken, settles no line, and
         *     leaves the remainder due - GH50 against GH55 leaves GH5 to collect by any allowed method.
         *     26.5 requires cash "short, or over" to be distinguishable, so an excess is reconciled as a
         *     variance rather than blocked - a rider cannot make change at a stranger's door, and refusing
         *     leaves the fee uncollected.
         *
         *     **Eligibility is the demand's, not the custody record's.** The demand must be OPEN or
         *     PARTIALLY_SETTLED with remaining due - PAYMENT_ALREADY_SETTLED otherwise - and the hub's
         *     recipient_cash_enabled capability must be on (PAYMENT_COLLECTION_NOT_ALLOWED). The rider
         *     records what was physically taken and nothing more: amount_minor is the tender, and a
         *     figure above it would be a claim about money the rider is not holding.
         *
         *     **Mobile money does not come through here.** 26.4 makes the backend authoritative for
         *     provider payments; cash custody exists precisely because cash has no provider to confirm it.
         *
         *     **Where a provider attempt is unresolved, a valid Ops fallback authorisation is REQUIRED**
         *     - `fallback_authorization_id`, and FALLBACK_REQUIRES_AUTHORIZATION
         *     without one. Where no unresolved attempt exists, ordinary fallback rules apply and no
         *     authorisation is needed.
         *
         *     **The grant is checked, not merely quoted.** It must be ACTIVE, it must name **this** demand
         *     and **that** attempt, and its method must be the method being taken -
         *     FALLBACK_AUTHORIZATION_ALREADY_CONSUMED, FALLBACK_AUTHORIZATION_DEMAND_MISMATCH,
         *     FALLBACK_AUTHORIZATION_METHOD_MISMATCH.
         *
         *     **A successful receipt CONSUMES the authorisation**, once and finally. A second settlement
         *     cannot reuse it.
         *
         *     **A RIDER CANNOT AUTHORISE THEMSELVES.** The grant is created by authorised Ops through
         *     authorizePaymentFallbackWhileUnresolved; the rider supplies its id and nothing more.
         *
         *     **Cash creates TWO records, deliberately**. A PaymentReceipt (method CASH)
         *     answers *what payment did Melarc accept*; RiderCashCustody answers *who physically holds
         *     the notes*. **They are not one entity**, and collapsing them loses one of the two
         *     reconciliations 26.3 compares.
         *
         *     **Cash runs the same atomic engine**. GH50 taken against GH55 creates a
         *     GH50 receipt and GH50 of rider custody, **settles no demand line**, leaves GH5 due and
         *     **keeps handover blocked**. **Custody is not settlement**: the rider holding the notes is
         *     a fact about accountability, not about whether the customer has paid in full.
         *
         *     **Every CASH receipt is traceable to the custody it created**. The receipt
         *     carries rider_cash_custody_id; the custody carries cash_receipt_ids and a collected_minor
         *     that is the sum of them. GH50 then GH5 in cash is TWO receipts and ONE custody record at
         *     GH55; GH50 in cash then GH5 by Hubtel is two receipts, GH50 of custody and GH5 of confirmed
         *     digital, and the demand settles once on the cumulative GH55. Nothing is invented and
         *     nothing is lost.
         *
         *     *Superseded description:* a short tender is refused with PARTIAL_PAYMENT_NOT_SUPPORTED -
         *     a code withdrawn at C1.9 because no current workflow raises it.
         */
        post: operations["recordRecipientCashPayment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/delivery-stops/{id}/otp": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Send the delivery OTP to the recipient of record
         * @description `delivery.stop.execute` - the assigned rider only.
         *
         *     **The request body is empty, and that is the guard.** 25.1: the OTP goes only to the
         *     recipient phone number recorded in Melarc Platform. **There is no destination field on this
         *     operation**, so a rider-supplied number is not validated away - it is inexpressible. If
         *     another person is receiving the parcel, the recorded recipient forwards the code.
         *
         *     **Refused while the stop's OperationalPaymentDemand is not SETTLED** -
         *     RECIPIENT_PAYMENT_OUTSTANDING. A partially funded demand is outstanding
         *     however real the GH50 already received: not an attempt succeeding, not a receipt existing,
         *     not cash in a pannier. 25.2 puts payment before handover, and this is where that ordering
         *     is enforced: no OTP is generated and none is sent.
         *     The reverse order fails badly - a recipient who has proved identity, seen the parcel, and
         *     then cannot pay.
         *
         *     **The OTP value is never returned.** 20.4 - the response confirms dispatch, never the code.
         *
         *     **Its length, validity window and wrong-attempt limit are set** -
         *     handover_otp_length, handover_otp_ttl_minutes and handover_otp_max_wrong_attempts,
         *     settings.md 7.4, all three CONFIRMED. One parameter set
         *     governs this OTP and requestReturnOtp, which mirrors it. *Superseded 5.67 text:* all
         *     three were keyed and unvalued (OPEN, MSC-DEC-403), and a client could assume neither a
         *     length nor a countdown.
         */
        post: operations["requestDeliveryOtp"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/delivery-stops/{id}/deliver": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Close the stop as delivered against a valid OTP
         * @description `delivery.stop.close` - the assigned rider only. ARRIVED to DELIVERED (12.1).
         *
         *     **Both conditions, in 25.2's order**: the recipient's OperationalPaymentDemand SETTLED where
         *     payment is due - not an attempt succeeded and not a receipt existing - then a
         *     valid OTP validated by the backend against the parcel and the recorded recipient contact.
         *
         *     **A fully vendor-paid parcel still requires the OTP.** 25.1 is explicit - such parcels "skip
         *     recipient payment collection but never skip OTP verification." The OTP proves who received
         *     it, which has nothing to do with who paid.
         *
         *     **Ops cannot call this.** 25.1 gives no ordinary override, and an Ops actor closing a stop as
         *     delivered would be that override wearing a different name. The extraordinary path is
         *     authoriseDeliveryWithoutOtp, and it is Senior Ops.
         *
         *     **Idempotent on replay** (25.2) - the same key returns the original result, emits no second
         *     audit event and creates no second payment effect.
         */
        post: operations["closeDeliveryStopDelivered"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/delivery-stops/{id}/authorise-without-otp": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Senior Ops authorises handover without OTP verification
         * @description `delivery.otp.override` - **hub Senior Ops**. 25.1's extraordinary path: the
         *     rider "cannot ORDINARILY override invalid or missing OTP", and this is the case that adverb
         *     implies.
         *
         *     **It inherits MSC-DEC-198's ladder rather than inventing a mechanism.** Pickup already has
         *     this shape - Ops authorises a handshake when portal and SMS both fail, recorded as an
         *     exception. One product, one fallback pattern.
         *
         *     **Senior Ops and not Platform Admin.** The fact needing verification - that this recipient is
         *     who they say and the handset genuinely failed - is local knowledge. Routing it upward
         *     produces approval without inspection.
         *
         *     **The payment gate is untouched.** This relaxes proof of identity, never 25.2's ordering:
         *     a demand not yet SETTLED returns RECIPIENT_PAYMENT_OUTSTANDING, whatever has
         *     already been received against it.
         *
         *     **Emits delivery.otp.overridden, enhanced.** The control is FREQUENCY - MSC-DEC-197 and
         *     MSC-DEC-198 both establish that a discretionary path's only real safeguard is that its rate
         *     stays visible. An override used routinely is a fraud control that has stopped existing.
         */
        post: operations["authoriseDeliveryWithoutOtp"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/orders/{id}/carrier-handoff": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        /**
         * The handoff record for an outbound order
         * @description `delivery.read` - Ops at own hub, the assigned rider, and the vendor on their own record.
         *     Returns the order's latest handoff record: its mode and what must be captured, and once
         *     handed over the captured identity, waybill, evidence, state and timestamps.
         *
         *     **Readable before the handoff**, from the moment Ops clears the order for dispatch - System
         *     opens the PENDING_HANDOFF record then (MSC-DEC-417, closing OQ-139) - so a rider can see
         *     what an outbound stop will require before reaching the counter.
         *
         *     **404 when the order has no handoff record** - it is not an outbound order, or it has not
         *     been cleared for dispatch. After a covered RETURNED and a re-dispatch, the latest record is
         *     returned; earlier ones are history.
         *
         *     *Superseded 5.66 text:* 404 for every order, the record having no producer.
         */
        get: operations["getCarrierHandoff"];
        put?: never;
        /**
         * Rider records the verified handoff to an approved courier or station
         * @description `delivery.handoff.perform` - **the rider holding the outbound run, and nobody else.**
         *     PENDING_HANDOFF to HANDED_OVER (state-machines.md 10), the one transition on that machine
         *     whose actor is the Rider, **at the order's outbound stop once ARRIVED** (state-machines.md
         *     12.1). The stop becomes HANDED_OVER and the order HANDED_TO_CARRIER in the same act.
         *
         *     **What must arrive depends on the identity mode.** In both: an approved
         *     identity, handed_to, and the receipt/handoff photograph (EVIDENCE_REQUIRED), already
         *     STORED. **REGISTERED** adds courier_provider_id naming an ACTIVE CourierProvider, and the
         *     waybill (WAYBILL_REQUIRED). **APPROVED_AGENT** adds agent_phone, which the server resolves
         *     to an ACTIVE ApprovedAgent at the rider's hub whose identity photo is stored; the handoff
         *     photo stands in for the waybill. **CARRIER_NOT_APPROVED** refuses an absent or inactive
         *     provider and an agent who is not approved - neither mode permits an unapproved third party
         *     to receive custody (MSC-DEC-417, closing OQ-133).
         *
         *     **The record already exists.** System opens it at PENDING_HANDOFF when Ops clears the order
         *     for dispatch with clearOutboundForDispatch (MSC-DEC-417, closing OQ-139). **404 means the
         *     order has no open handoff record** - it is not an outbound order, or its record is closed.
         *
         *     **commercial_mode was snapshotted when the record opened.** It decides whether HANDED_OVER
         *     is terminal. For STATION_DROP this is the end, and Melarc's fee is earned at
         *     handed_over_at. In the covered mode Ops records the outcome afterwards with
         *     recordHandoffOutcome, and the covered charge is earned only at DELIVERED (36.10).
         *
         *     **A counter that refuses is not this operation.** The rider fails the stop with
         *     failDeliveryStop and a HANDOFF_FAILURE reason, and the record stays PENDING_HANDOFF for a
         *     re-dispatch.
         *
         *     **Idempotent on replay.** The same key returns the original result, emits no second audit
         *     event and earns no second fee.
         *
         *     *Superseded 5.66 text:* three captures in every mode, CARRIER_NOT_APPROVED unenforceable,
         *     nothing creating the record, and 404 for every order.
         */
        post: operations["recordCarrierHandoff"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/carrier-handoffs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Handoff records in scope - the covered-mode outcome worklist
         * @description `delivery.read` - the hub's records for Ops at own hub. A vendor's
         *     own-record grant reaches only its own orders' records, as getCarrierHandoff's does, and a
         *     rider reads its stop's record with getCarrierHandoff rather than listing a hub's.
         *
         *     **The worklist recordHandoffOutcome needs.** Filtered to commercial_mode
         *     MELARC_COVERED_THIRD_PARTY_DELIVERY and state HANDED_OVER, IN_TRANSIT or FAILED, it is
         *     every parcel Melarc is still responsible for in a third party's hands (24.7.2). Without
         *     it an outcome could only be recorded against an order someone already remembered, and a
         *     forgotten one would rest at HANDED_TO_CARRIER indefinitely. **PENDING_HANDOFF** lists
         *     outbound orders cleared for dispatch and not yet handed over.
         */
        get: operations["listCarrierHandoffs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/orders/{id}/carrier-handoff/outcome": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Ops records a covered-mode handoff's outcome
         * @description `delivery.handoff.outcome` - Ops Staff, Senior Ops and Platform Admin at own hub
         *     (MSC-DEC-417, closing OQ-135). **Covered mode only**: a Station Drop is complete at handoff,
         *     and TERMINAL_FOR_STATION_DROP refuses it.
         *
         *     **Four outcomes, and what each moves** (state-machines.md 10 and 9):
         *     - IN_TRANSIT - the third party reports the parcel moving.
         *     - DELIVERED - the order moves to DELIVERED, and **the covered charge is earned here**,
         *       never at handoff (36.10).
         *     - FAILED - the third party cannot deliver and is bringing the parcel back. **Not terminal.**
         *       A reason is mandatory, from the DELIVERY_FAILURE catalogue; no delivery attempt is
         *       counted, because no Melarc rider stood at a door.
         *     - RETURNED - the parcel is back at the responsible hub. **Custody returns to Melarc**, and the
         *       order moves to AT_HUB_AFTER_FAILURE, where Ops re-dispatches it at Melarc's cost or starts
         *       a Return that owes the whole charge back. A reason is required unless the record is
         *       already FAILED with one.
         *
         *     **STATE_CONFLICT** refuses an outcome the record's state does not permit.
         */
        post: operations["recordHandoffOutcome"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/orders/{id}/outbound-clearance": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Ops clears a paid outbound order for dispatch, first time or after a failed or returned handoff
         * @description `dispatch.outbound.clear` - Ops Staff, Senior Ops and Platform Admin at own hub.
         *     **The operation state-machines.md 9's third-party `-> READY_FOR_DISPATCH` row
         *     never had**: it names Ops, and nothing performed it, so no outbound order could be
         *     dispatched at all.
         *
         *     **It refuses until the outbound charge is backend-confirmed paid** (OUTBOUND_CHARGE_UNPAID,
         *     35.7.7-8) - actual payment, where the ordinary gate would accept a credit reservation. On
         *     success the order is READY_FOR_DISPATCH, and **System opens its ThirdPartyHandoff at
         *     PENDING_HANDOFF** if none is open, snapshotting the commercial mode (closing OQ-139).
         *
         *     **The same operation re-dispatches** an order at AT_HUB_AFTER_FAILURE on the third-party
         *     lane - after a failed counter or a covered RETURNED - **with no new charge**: the outbound
         *     charge is still paid and not yet earned. A failed counter's PENDING_HANDOFF record is
         *     reused with its stop link cleared; after a covered RETURNED, a new record opens.
         */
        post: operations["clearOutboundForDispatch"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/courier-providers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The approved courier and station register
         * @description `courier.read`. **One platform-wide register** (24.7, MSC-DEC-417) - data-scope-registry.md
         *     classifies CourierProvider global. An entry is approved while ACTIVE.
         *
         *     **A rider reads ACTIVE entries only**. A registered-mode capture carries
         *     courier_provider_id, and a rider had no other way to learn one; the rider app offers
         *     these entries, with the run's own courier first where Ops selected one. A rider session
         *     is served ACTIVE entries, and status=INACTIVE from one is PERMISSION_DENIED. **The
         *     approved-agent register is never served to a rider** - listApprovedAgents takes no rider
         *     session.
         */
        get: operations["listCourierProviders"];
        put?: never;
        /**
         * Add an approved courier or station to the register
         * @description `courier.registry.manage` - **Senior Ops and Platform Admin, all hubs**. The
         *     entry is **ACTIVE, and so approved, from registration**; a registered-mode handoff may name
         *     it at once.
         */
        post: operations["registerCourierProvider"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/courier-providers/{id}/deactivate": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Withdraw a courier or station's approval, keeping its history
         * @description ACTIVE to INACTIVE, **reason mandatory**. **Deactivation never deletes**: past handoffs keep
         *     the entry they used, and a new registered-mode handoff naming it is refused with
         *     CARRIER_NOT_APPROVED.
         */
        post: operations["deactivateCourierProvider"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/courier-providers/{id}/reactivate": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Restore a deactivated courier or station's approval
         * @description INACTIVE to ACTIVE, **reason mandatory**, recorded beside the deactivation it reverses.
         */
        post: operations["reactivateCourierProvider"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/approved-agents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The approved agents at the acting hub
         * @description `courier.read`, **hub-scoped**. **Staff only**: a rider names an agent by
         *     phone at the counter and the server resolves it, so the register - names, phones and
         *     identity documents - is never served to a rider.
         */
        get: operations["listApprovedAgents"];
        put?: never;
        /**
         * Hub Senior Ops approves an informal driver or agent
         * @description `courier.agent.approve` - **hub Senior Ops and Platform Admin, own hub** (MSC-DEC-417,
         *     closing OQ-133's second half). In advance, or **on the spot while the rider waits** - agents
         *     *"cannot all be pre-registered"*.
         *
         *     **An ID-document photo is required before the agent can take custody.** Supply
         *     identity_evidence_id now - typically the photo the rider took at the counter - or attach one
         *     afterwards as COMPLIANCE_DOCUMENT evidence owned by the agent. It must be STORED
         *     (EVIDENCE_NOT_STORED). **STATE_CONFLICT** refuses a phone number already held by an ACTIVE
         *     agent at this hub.
         *
         *     **The identity document is Ops-only.** Whichever record owns the photo - the handoff at
         *     whose counter it was taken, or the agent - its access rule admits no vendor, recipient or
         *     rider. The order's vendor may see that a handoff happened, never the agent's ID.
         */
        post: operations["approveAgent"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/approved-agents/{id}/withdraw": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Withdraw an agent's approval, keeping its history
         * @description ACTIVE to WITHDRAWN, **reason mandatory**. Withdrawal never deletes; past handoffs keep their
         *     agent, and a new agent-mode handoff resolving to it is refused with CARRIER_NOT_APPROVED.
         */
        post: operations["withdrawAgentApproval"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/delivery-stops/{id}/fail": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Record a failed doorstep attempt, or an outbound stop that failed at the counter
         * @description `delivery.stop.close` - the assigned rider only. ARRIVED to FAILED, or AWAITING_RECIPIENT
         *     to FAILED once the server-timed doorstep wait has expired (12.1, MSC-DEC-349) -
         *     DOORSTEP_WAIT_NOT_ELAPSED refuses an ordinary no-contact failure before wait_expires_at.
         *
         *     **An outbound stop fails at the counter with a HANDOFF_FAILURE reason**:
         *     no delivery attempt is consumed, the order stays OUT_FOR_DELIVERY, its handoff record stays
         *     PENDING_HANDOFF, and the parcel returns with the run's custody return. A reason from the
         *     wrong domain for the stop's lane is refused with REASON_NOT_ACTIVE.
         *
         *     **No attempt ceiling is consulted, because none exists**. A physical attempt
         *     is consumed where the reason says so and is recorded as history; whether the parcel
         *     travels again is an Ops Redelivery decision, and formal Return is a separate deliberate act.
         *     *Superseded declaration:* DELIVERY_ATTEMPT_LIMIT_REACHED, withdrawn at C1.9.
         *
         *     **An ACTIVE entry from the Delivery Failure Reason Catalog**. The five original
         *     reasons are SEEDED DEFAULTS, not a permanently fixed set: authorised catalogue
         *     management may add an approved operational reason without a backend deployment.
         *
         *     **The admission test is unchanged and it is ROUTING**. 25.3 requires the
         *     reason to be ADJUDICABLE, so a category that changes nothing Ops does next is a note
         *     wearing an enum's clothes. A test for admission is not a bar on admission.
         *
         *     **The server rejects** an unknown code, an INACTIVE code, a code from another reason
         *     domain, and a submission missing the note or evidence the reason itself requires.
         *
         *     **Attempt consumption comes from the reason, never from this request and never from a
         *     hard-coded name**.
         *
         *     **RECIPIENT_REFUSED consumes an attempt and is not terminal.** The case that recurs is the
         *     wrong person answering the door, and a terminal refusal converts that misunderstanding into
         *     an earned vendor-paid return fee (25.5). Ops may still start the return immediately; what
         *     the rule removes is the SYSTEM deciding it on the rider's word.
         *
         *     **Money already taken stays with the rider.** MSC-DEC-229 - no refund at the door. The
         *     payment record travels into hub reconciliation, and payment_taken on the stop records it.
         *     **Nothing may read stop state to decide what a rider is holding.**
         */
        post: operations["failDeliveryStop"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/cash-handovers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Rider declares a cash total at the responsible hub
         * @description `payment.cash.handover` - the rider only, at the **responsible** hub (26.3).
         *
         *     **Opening a handover moves no CASH, and it derives the figure everything else is measured
         *     against.** The server, at opening: selects the eligible COLLECTION_CASH expenses -
         *     APPROVED, this rider, this run or operational period, not already applied - BINDS each to
         *     this handover by setting applied_to_cash_handover_id and applied_at, snapshots
         *     applied_expense_minor, and derives system_expected_minor as gross_cash_minor minus that
         *     total. **An opened handover already knows what it expects.**
         *     The hub then counts physical cash against a figure that already exists.
         *
         *     **Application is at opening and never at confirmation.** Applying at confirmation would
         *     mean the expectation the hub is counting against is computed after the count.
         *
         *     **The select-and-bind is one atomic conditional write per expense, not a read then a
         *     write** (HIGH-03 audit remediation, [domain-model.md](domain-model.md)'s `RoadExpense`
         *     application mechanism). Two concurrent handovers for the same rider can never both bind
         *     the same expense; the loser's write matches zero rows for anything the winner already
         *     took.
         *
         *     **Physical custody passes when the hub ACCEPTS ITS COUNT** - on CONFIRMED and
         *     on VARIANCE_OPEN alike, not on financial confirmation. A variance is a financial state;
         *     the hub still holds the money it counted.
         *
         *     **declared_total_minor need not equal the sum of the named custody records**, and forcing it
         *     to would defeat the control. The declared total is what the rider SAYS they are handing over;
         *     the sum of expectations is what the SYSTEM believes is owed. 26.3 compares them, so they must
         *     be independently recordable.
         */
        post: operations["openCashHandover"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/cash-handovers/{id}/confirm": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Hub records its own confirmed total
         * @description `payment.cash.confirm` - Ops, Senior Ops or Platform Admin at own hub. **Held by no rider
         *     bundle**: 26.3 names rider-declared and hub-confirmed as two figures, and one actor supplying
         *     both is not a comparison.
         *
         *     **The count is deliberately not blind** (MSC-DEC-254, closing OQ-092), diverging from 22.4's
         *     parcel count. Separation of actors survives; independence of the second figure does not. The
         *     case that carried it: blind, every honest miscount becomes a VARIANCE_OPEN that holds the run
         *     and needs Senior Ops - friction on a flow that runs daily for every rider, to catch a rare
         *     fault. And unlike parcels, cash stays countable after receipt.
         *
         *     **Equal totals reconcile every named custody record. Any difference opens a variance**, with
         *     a mandatory reason, and **the run cannot be financially closed** (26.3). No tolerance is
         *     modelled - 26.3 assigns variance thresholds to downstream design and none is set.
         *
         *     **The emitted event carries BOTH totals**, so a clean handover and a corrected one stay
         *     distinguishable afterwards.
         */
        post: operations["confirmCashHandover"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/cash-handovers/{id}/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Senior Ops dispositions a cash shortage or overage
         * @description `payment.variance.resolve` - **Senior Ops or Platform Admin**, own hub. Ops Staff cannot:
         *     this is the act that releases a financial hold on the run.
         *
         *     **A shortage and an overage are one state, deliberately.** 26.5 requires both to be
         *     distinguishable and they are, as a signed variance on the record - but both produce the
         *     identical obligation, so two states would double the table and change nothing anyone does.
         *
         *     **The disposition is recorded, never a silent adjustment.** Reason mandatory; emits
         *     payment.cash.variance_resolved, enhanced under 38.5 category 3.
         */
        post: operations["resolveCashVariance"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/staff/setup/credential": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Employee establishes their own permanent password from a setup grant
         * @description Consumes a `SetupGrant` of purpose `STAFF_CREDENTIAL_SETUP` and sets the permanent password.
         *
         *
         *     **The maker who created the identity never chooses, knows or supplies this.** Before Gate A
         *     `StaffIdentity.credential` was mandatory at creation with no operation able to supply it, so
         *     the only way to onboard anyone was an administrator writing a credential by hand - which
         *     makes it not a credential.
         *
         *     **Ordinary Ops Staff become authentication-ready here.** Normal sign-in follows.
         *
         *     **Privileged staff do not.** The response carries what is needed to provision a TOTP
         *     authenticator and an `MFA_ENROLMENT` grant; the identity stays unable to hold a session
         *     until completeMfaEnrolment proves a code. **No Session is issued by this operation for
         *     anyone** - it establishes a credential, it does not authenticate.
         *
         *     Also serves the BOOTSTRAP_SETUP grant, whose only difference is that it has no expiry.
         *
         *
         *     **The password is held to the length bounds on `CredentialSetup`**: 12 to 128 characters, spaces permitted, no composition rule. This operation also serves the bootstrap password. Establishing it resets the credential's failed-attempt count.
         */
        post: operations["completeStaffCredentialSetup"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/staff/setup/mfa": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Prove a TOTP code and activate the MFA factor
         * @description Consumes an **`MFA_ENROLMENT`** grant and a generated TOTP code.
         *
         *     **`MFA_ENROLMENT` is the only purpose that activates a factor**, whatever created the
         *     pending one - ordinary onboarding, bootstrap, or an administrative reset. Each of those
         *     origins issues its own `MFA_ENROLMENT` continuation grant, and the origin grant gets the
         *     workflow only as far as a provisioned `PENDING` factor.
         *
         *     **`BOOTSTRAP_SETUP` was accepted here until R1.2 and must not be.** It would have given
         *     the one grant with **no expiry** the power to activate a second factor at any later date,
         *     turning a deployment-channel secret into a permanent standing key to privileged access.
         *
         *     **The factor becomes ACTIVE only when a code is successfully proven.** A provisioned but
         *     unproven factor is `PENDING` and is not MFA - which is the difference between this record
         *     and the `mfa_enrolled` boolean it replaces, because a boolean can be set by a seed.
         *
         *     **No Session is issued.** The identity becomes authentication-ready and signs in normally
         *     with password plus TOTP. Issuing a session here would make enrolment an authentication path
         *     that skipped the password.
         */
        post: operations["completeMfaEnrolment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/ops/staff/{id}/mfa/reset": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Platform Admin resets another privileged identity's MFA factor
         * @description `staff.mfa.reset` - **Platform Admin only**. Mandatory reason; enhanced audit.
         *
         *     **MFA loss is not password loss, and this is the operation that keeps them apart.** If
         *     ordinary password recovery also cleared MFA, an attacker holding a compromised work email
         *     would have converted "password AND MFA" into "control of the email account" - and the email
         *     IS the password-recovery channel. Recovery therefore never touches the factor; only this
         *     does.
         *
         *     Effects: the old factor is REVOKED, **every session for the target terminates with
         *     `MFA_RESET`**, and a re-enrolment grant is issued. The target cannot hold another privileged
         *     session until a new factor is proven.
         *
         *     **The holder cannot turn MFA off.** There is no state in which a privileged identity has no
         *     factor and can still authenticate - no backup codes, no bypass codes, no support override.
         *
         *     **Refusals.** Resetting one's own factor is `SELF_APPROVAL_FORBIDDEN`; the other bootstrap
         *     Platform Admin is a valid actor, as is any Platform Admin. A target whose factor is only
         *     `PENDING` (never proven), and a non-privileged identity (it has no MFA), are `STATE_CONFLICT`.
         *     A stranded bootstrap administrator is in that state: it is resumed through the provisioning
         *     channel and not through this operation (MIGRATION_AND_SEEDING.md 3.3a).
         *
         *     **Where `If-Match` comes from** (Gate PD-3R1, `PDA-47`): the ETag of `getStaffIdentity` on this record. A mismatch is `STATE_CONFLICT`. The approver who is not the maker finds the record with `listStaffIdentities`.
         *
         *     **Delivery** (Gate PD-3R1, `PDA-54`): the grant or link is handed to the delivery channel inside this operation, before it commits, and its raw token is never persisted. If the channel refuses it the operation is rolled back - no grant exists and an earlier pending grant is untouched - and the answer is `CREDENTIAL_DELIVERY_FAILED`; nothing was sent and the caller may issue again.
         */
        post: operations["resetStaffMfa"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/ops/staff/{id}/credential/setup/reissue": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Re-issue an expired or lost initial STAFF_CREDENTIAL_SETUP grant
         * @description `staff.identity.approve` - Senior Ops or Platform Admin (30.8). **MED-10 audit
         *     remediation.**
         *
         *     An existing record outside the actor's hubs is `HUB_SCOPE_VIOLATION`; one that does not exist is `NOT_FOUND`.
         *
         *     **The gap this closes.** `approveStaffIdentity` issues the one and only
         *     `STAFF_CREDENTIAL_SETUP` grant a staff profile ever receives on its own, at
         *     `recovery_link_ttl_minutes` = 30. If it expires before the employee acts -
         *     lost email, a slow first day, a bounced message - the identity is `ACTIVE` with a `NULL`
         *     credential and no PENDING grant, and nothing in the contract could reach that state again.
         *     `recoverStaffCredential` does not apply: R1.3's boundary is explicit that recovery repairs
         *     a credential someone already has, and this employee has none to repair.
         *
         *     **Guard: `StaffIdentity.credential IS NULL`.** A profile that has already established a
         *     password is not being onboarded again - `STATE_CONFLICT`. Use recoverStaffCredential for
         *     that case.
         *
         *     **A bootstrap identity is refused with `STATE_CONFLICT`** (`409`): a fresh 30-minute grant would
         *     go to an address nobody verified, because the seeded Platform Admins never passed the approval
         *     that makes a work email verified. A stranded bootstrap administrator is resumed through the
         *     provisioning channel while it holds no `ACTIVE` factor, and by the other Platform Admin with
         *     `resetStaffMfa` once it does (MIGRATION_AND_SEEDING.md 3.3a).
         *
         *     **Effect: the signed SetupGrant machine's own `-> PENDING` transition** ("System, or the
         *     authorising actor for an administrative reset" - state-machines.md 19), for the same
         *     `STAFF_CREDENTIAL_SETUP` purpose, delivered to the same verified work email.
         *     Any stale PENDING grant is superseded, exactly as a second approval
         *     attempt would supersede the first. No new permission, no new audit event class - this is
         *     an already-approved transition that had no operation performing it, the same shape
         *     CONFLICT-038 names for a different entity.
         *
         *     **The token is never returned.** `auth.setup_grant.issued` records that a grant was issued,
         *     never its value (20.4).
         *
         *     **Where `If-Match` comes from** (Gate PD-3R1, `PDA-47`): the ETag of `getStaffIdentity` on this record. A mismatch is `STATE_CONFLICT`. The approver who is not the maker finds the record with `listStaffIdentities`.
         *
         *     **Delivery** (Gate PD-3R1, `PDA-54`): the grant or link is handed to the delivery channel inside this operation, before it commits, and its raw token is never persisted. If the channel refuses it the operation is rolled back - no grant exists and an earlier pending grant is untouched - and the answer is `CREDENTIAL_DELIVERY_FAILED`; nothing was sent and the caller may issue again.
         */
        post: operations["reissueStaffCredentialSetup"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/ops/riders": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List riders, so an officer can find the rider a device operation targets
         * @description `dispatch.read` at the actor's hub scope (Ops Staff, Senior Ops and Platform Admin). The roster
         *     returns **identity and readiness only** (RiderSummary): name, phone, status, hub, whether a PIN is set
         *     and whether an `ACTIVE` device exists. It is the read `registerRiderDevice`, `reregisterRiderDevice` and
         *     `revokeRiderDevice` need to find their target, and it is the same rider list dispatch already
         *     needs to assign a manifest (Gate PD-3R1, `PDA-47`).
         *
         *     The list is for discovery and carries no ETag; `getRider` on the chosen rider does.
         */
        get: operations["listRiders"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/ops/riders/{riderId}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                riderId: string;
            };
            cookie?: never;
        };
        /**
         * Read one rider with every device the rider has held, and the ETag a replacement takes
         * @description `dispatch.read`. **The read `reregisterRiderDevice` takes its `If-Match` from.** The ETag changes when
         *     the rider's status or device set changes - a registration, a replacement, a revocation - and never
         *     because of a failed sign-in.
         *
         *     The devices are returned in every status, because an officer verifying a report of a stolen handset
         *     needs to see what was `REVOKED` and what was `REPLACED`. Neither secret a device holds is represented.
         *
         *     An existing rider outside the actor's hubs is `HUB_SCOPE_VIOLATION`; one that does not exist is
         *     `NOT_FOUND`.
         */
        get: operations["getRider"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/ops/riders/{riderId}/device/register": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                riderId: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Senior Ops initiates in-person first device binding for a rider
         * @description `staff.device.register` - **Senior Ops at the rider's hub**, in person.
         *
         *     **The contract defined re-registration and no first registration**, so a rider could only
         *     become authentication-capable by an administrator writing rows.
         *
         *     **A rider has at most one `ACTIVE` device**. A rider who already has one is
         *     refused with `STATE_CONFLICT`, and a change of handset is `reregisterRiderDevice`, never a
         *     second binding. **A rider who has had a device revoked is refused with `STATE_CONFLICT` too**
         *     (`409`): only `reregisterRiderDevice`, which requires a verification note and the rider's ETag,
         *     binds that rider again. **One rider per handset is an operating rule that Senior Ops checks in
         *     person**; the system enforces the rider-to-key binding and **cannot identify one handset
         *     across riders**, and no handset identifier is collected or enforced to police it.
         *
         *     This issues a `RIDER_DEVICE_ENROLMENT` grant and returns it as an **enrolment URI the
         *     portal renders as a QR code**, **with a single-use attestation challenge
         *     the handset binds into its key attestation**. It does NOT create the key and does NOT set
         *     the PIN: the rider scans the code with their own handset, which generates a
         *     **non-exportable keypair** in Android secure hardware, and the rider establishes their PIN
         *     privately. **The officer never learns the PIN** - which is what makes it a second factor
         *     rather than a shared secret.
         *
         *     A separate key from `staff.device.reregister` deliberately: widening that one would leave
         *     the catalogue unable to say which act was authorised.
         */
        post: operations["registerRiderDevice"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/rider/device/enrol": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Rider registers the device public key and establishes their PIN
         * @description Consumes a `RIDER_DEVICE_ENROLMENT` grant (first binding) or a
         *     `RIDER_DEVICE_REREGISTRATION` grant (replacement handset) - MSC-DEC-264, MSC-DEC-269.
         *     **One completion operation for both**, because the act is identical: prove possession of a
         *     new non-exportable key and set a PIN.
         *
         *     **The `setup_token` arrives by QR scan** from the Ops Portal screen during the in-person
         *     ceremony. Before R1.1 no operation or response produced it, and this
         *     operation could not be reached.
         *
         *     The handset submits **only the public half** of a keypair generated in Android secure
         *     hardware. The private key never leaves the device and is never copied to a replacement -
         *     it cannot be, which is the point of non-exportability.
         *
         *     The rider sets their own PIN in the same call. Both together make the rider
         *     authentication-ready.
         *
         *     **The handset also submits `key_attestation`, and the server verifies it before it
         *     registers anything**. The key is a non-exportable, hardware-backed signing
         *     key generated for this enrolment with the attestation challenge issued with the grant; the
         *     evidence is its Android Key Attestation certificate chain. The verification policy is
         *     SECURITY_DESIGN 15.2.
         *
         *     - A key below `TrustedEnvironment` security is `DEVICE_SECURITY_UNSUPPORTED`. StrongBox is
         *       accepted and not required.
         *     - Any other failure of the policy - chain, trust root, revocation, challenge, application
         *       identity, device state, key binding - is `DEVICE_INTEGRITY_FAILED`.
         *     - An unknown, expired, consumed or superseded grant is `SETUP_GRANT_INVALID`. **The
         *       attestation challenge lives and dies with its grant**: single-use, and for the grant's
         *       lifetime.
         *
         *     **Atomic.** A refusal creates no device, consumes no grant, sets no PIN and, on
         *     replacement, leaves the existing device exactly as it was. Success registers the device,
         *     consumes the grant and sets the PIN together; on replacement it also moves the old device
         *     from `ACTIVE` to `REPLACED` and ends any live session on it with `DEVICE_REPLACED`.
         *     **If the trust data the verifier needs is too stale to evaluate against, or
         *     this instance has not loaded it yet, the operation fails closed with `503`
         *     `TRUST_DATA_UNAVAILABLE` and a `Retry-After`** (MSC-DEC-437, SECURITY_DESIGN 15.2.2) - no
         *     device is created, the grant is not consumed and the handset may try again, and it is
         *     neither `DEVICE_INTEGRITY_FAILED` nor `DEVICE_SECURITY_UNSUPPORTED`. Nothing else in the
         *     contract returns it.
         *
         *     **No Session is issued.** Enrolment establishes credentials; sign-in authenticates.
         */
        post: operations["completeRiderDeviceEnrolment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/rider/sign-in/challenge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Obtain a one-use challenge for the registered device to sign
         * @description Step one of rider sign-in. The server issues a short-lived, **single-use**
         *     challenge which the handset signs with its registered non-exportable private key.
         *
         *     **This must not become a rider-account enumeration endpoint.** A challenge is issued the
         *     same way whether or not the number belongs to an active rider with a registered device, and
         *     the response carries no account state. The existing non-disclosure posture (37.7) is
         *     preserved: an attacker learns nothing by asking.
         *
         *     The challenge alone authenticates nothing.
         */
        post: operations["requestRiderSignInChallenge"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/vendor/setup/credential": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Vendor establishes its shared secret and registers the current browser
         * @description Consumes a `VENDOR_CREDENTIAL_SETUP` grant issued to the account's registered recovery
         *     channel.
         *
         *     The vendor sets the shared secret and the server issues a **device credential** for this
         *     browser, delivered in a long-lived HttpOnly cookie and stored hashed. **Nobody types a
         *     device identifier** - the browser proves itself with the credential.
         *
         *     **The administrator never learns the vendor's permanent shared secret.** Vendor organisation
         *     approval and business administration remain SLICE-008; Gate A defines only the boundary at
         *     which an approved account becomes able to authenticate.
         *
         *     **The secret is held to the length bounds on `VendorCredentialSetup`**: 12 to 128 characters, spaces permitted, no composition rule. Establishing it resets the credential's failed-attempt count.
         */
        post: operations["completeVendorCredentialSetup"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/vendor/device/grant": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Request a grant to register an additional browser
         * @description `self` - the vendor acting on its own account from a live session
         *     (vendor-authentication.md 5.5, CRIT-01).
         *
         *     **The gap this closes.** `AC-SLICE-000-14` described a second browser joining without
         *     displacing the first, and the only path that registered a browser was setup or recovery -
         *     **both of which rotate the shared secret and terminate every live session**. The scenario
         *     was reachable in the acceptance criteria and unreachable in the product.
         *
         *     Issues a **single-use `VENDOR_DEVICE_ENROLMENT` grant** at the ordinary
         *     `recovery_link_ttl_minutes` lifetime to the account's **registered recovery channel**,
         *     resolved from the account record and **never from the request** - the same rule every
         *     other registered-channel transport follows (state-machines.md 19.1).
         *
         *     **It rotates no secret and terminates no session.** The single-session rule governs active
         *     SESSIONS; this registers a DEVICE. Conflating the two is what made the gap, and the two
         *     concepts stay separate here.
         *
         *     **Rate-limited on the `signin_max_attempts` ceiling**, because an authenticated caller who
         *     can post an OTP to a registered channel repeatedly is a nuisance channel if unbounded.
         *
         *     **Delivery** (Gate PD-3R1, `PDA-54`): the grant or link is handed to the delivery channel inside this operation, before it commits, and its raw token is never persisted. If the channel refuses it the operation is rolled back - no grant exists and an earlier pending grant is untouched - and the answer is `CREDENTIAL_DELIVERY_FAILED`; nothing was sent and the caller may issue again.
         */
        post: operations["requestAdditionalDeviceGrant"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/vendor/device/enrol": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Consume the grant and register this browser, without a session
         * @description Consumes a `VENDOR_DEVICE_ENROLMENT` grant from the new browser and issues that browser a
         *     **`melarc_vendor_device` credential**, registered **alongside** existing ones rather than
         *     replacing them (vendor-authentication.md 5.5).
         *
         *     **No session is issued, and that is the point.** A setup credential that produced a session
         *     would be an authentication path around the shared secret - the one thing
         *     state-machines.md 19 forbids of every grant. The vendor signs in afterwards on the new
         *     browser, presenting the new device credential **and** the secret, and that sign-in
         *     displaces the earlier session under the ordinary single-session rule.
         *
         *     **The grant is principal-bound**, so no account identifier is accepted here. Taking one
         *     would let a caller nominate whose browser is being registered.
         */
        post: operations["completeAdditionalDeviceEnrolment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/vendor/devices": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The browsers registered against this vendor account
         * @description `self` - a vendor reading its own account, from a live session.
         *
         *     **This exists because multi-browser enrolment created the need for it.** Before
         *     requestAdditionalDeviceGrant, a vendor had exactly ONE registered browser, so "which
         *     devices are registered" had one answer and "revoke the device" was indistinguishable
         *     from recovering the credential. Once an account can hold three, a holder who cannot
         *     enumerate them cannot notice one they did not authorise.
         *
         *     **Never the credential.** `device_credential_hash` is a hash the client must never see
         *     and `public_key` is not exposed; this returns identity and status only, the same rule
         *     RegisteredDevice already carries.
         *
         *     **Revoked and replaced devices are listed too**, because a holder checking for an
         *     unfamiliar browser needs to see that one was removed, not find a shorter list.
         *
         *     The `ETag` header is the version of this account's device set and is what `revokeVendorDevice` sends as `If-Match`.
         */
        get: operations["listVendorDevices"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/vendor/devices/{id}/revoke": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Revoke one registered browser without rotating the secret
         * @description `self` - a vendor acting on its own account, from a live session.
         *
         *     **The proportionate control multi-browser enrolment made necessary.** The only way a
         *     vendor could previously remove a browser was completeCredentialRecovery, which rotates
         *     the shared secret, terminates every session and revokes every device at once. That was
         *     adequate while an account held one browser. With several, it is a sledgehammer: removing
         *     a colleague's old laptop should not log out the whole business and force a new secret.
         *
         *     **Effects.** The RegisteredDevice reaches REVOKED, and any live Session bound to it is
         *     terminated with DEVICE_REVOKED - the existing termination reason, not a new one. **The
         *     shared secret is untouched** and every other browser keeps working.
         *
         *     **A vendor may not revoke the browser it is calling from** - STATE_CONFLICT. Self-revocation
         *     would end the caller's own session as a side effect of an administrative act, and signing
         *     out is what signOut is for.
         *
         *     **This is not suspension and not recovery.** It removes one device; 29.6 stops an account,
         *     and recovery repairs a compromised secret.
         *
         *     **Where `If-Match` comes from** (Gate PD-3R1, `PDA-47`): the `ETag` header of `listVendorDevices`, the version of the account's device set, which changes whenever a browser is registered or revoked. A mismatch is `STATE_CONFLICT`. A device id that is not this account's is `NOT_FOUND`, identical to one that does not exist.
         */
        post: operations["revokeVendorDevice"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/staff/setup/mfa/begin": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Begin MFA re-enrollment and obtain new TOTP provisioning material
         * @description Consumes an `MFA_REENROLMENT` grant and returns the provisioning material the authenticator
         *     needs (MSC-DEC-259, R1).
         *
         *     **This is the step the reset lifecycle was missing.** resetStaffMfa revoked the factor and
         *     issued a re-enrollment grant, and nothing ever returned a NEW TOTP secret - so the principal
         *     held an authorisation to re-enrol and no means of doing it.
         *
         *     Effects: any unusable `PENDING` factor is superseded, a new `PENDING` MfaFactor is created,
         *     a secret is generated, the `MFA_REENROLMENT` grant is **consumed**, and a short-lived
         *     `MFA_ENROLMENT` continuation grant is issued.
         *
         *     **An `MFA_REENROLMENT` grant can never activate a factor.** Activation requires the
         *     continuation grant plus a proven code at completeMfaEnrolment. Two grants because the two
         *     acts have different consequences: one authorises re-enrolment, the other proves possession.
         */
        post: operations["beginMfaReenrolment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/ops/staff/{id}/credential/recover": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Platform Admin performs exceptional staff credential recovery
         * @description `staff.credential.recover` - **Platform Admin**, all hubs (11.2).
         *
         *     Split out of the former polymorphic performOpsRecovery in R1. **One operation, one
         *     authorization rule.** Previously a single operationId declared one x-permission while its
         *     description named three different authorities, so the effective permission depended on
         *     request contents - which no mechanical check could verify and no reader could rely on.
         *
         *     **Creates a `RecoveryRequest` with `initiated_by` set to the acting Platform Admin**, and
         *     delivers its token to the staff member's **verified work email**. The staff member then
         *     completes it through the same `completeCredentialRecovery` operation self-service recovery
         *     uses, and their sessions terminate with `CREDENTIAL_CHANGED` at that point.
         *
         *     **This issued a `STAFF_CREDENTIAL_SETUP` grant until R1.3, and returned a `RecoveryRequest`
         *     in the same breath.** Producer, response and consumer named three different things:
         *     `completeCredentialRecovery` consumes a recovery token and returns `RECOVERY_TOKEN_INVALID`,
         *     not `SETUP_GRANT_INVALID`. **One lifecycle, end to end** (R1.3).
         *
         *     **The boundary is simple enough to remember and to test.** `SetupGrant` **establishes**
         *     authentication capability - first credential, MFA enrolment, device enrolment.
         *     `RecoveryRequest` **repairs an existing** credential. Exceptional recovery is a repair, and
         *     a staff member who already has a password is not being onboarded again.
         *
         *     **The MFA factor is untouched**. Password recovery is not MFA recovery; if it
         *     were, compromising the work email would defeat the second factor entirely. MFA reset is
         *     resetStaffMfa.
         *
         *     **The new credential is never returned to the performing actor.**
         *
         *     **Where `If-Match` comes from** (Gate PD-3R1, `PDA-47`): the ETag of `getStaffIdentity` on this record. A mismatch is `STATE_CONFLICT`. The approver who is not the maker finds the record with `listStaffIdentities`.
         *
         *     **Delivery** (Gate PD-3R1, `PDA-54`): the grant or link is handed to the delivery channel inside this operation, before it commits, and its raw token is never persisted. If the channel refuses it the operation is rolled back - no grant exists and an earlier pending grant is untouched - and the answer is `CREDENTIAL_DELIVERY_FAILED`; nothing was sent and the caller may issue again.
         */
        post: operations["recoverStaffCredential"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/ops/vendors": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List vendor accounts, so an officer can find the account a credential operation targets
         * @description `vendor.read` (Ops Staff, Senior Ops, Platform Admin and Finance). **Scoped to the caller's
         *     grant**: a hub's staff see a vendor account only where its `VendorOrganization`'s
         *     responsible hub (`responsible_hub_id`) is one of the hubs their grant reaches, and Platform Admin
         *     and Finance see accounts across hubs only where their actual grant reaches every hub. A
         *     `VendorAccount` stays a global master record at the persistence and domain level - a vendor's one
         *     account whichever hub serves it (data-scope-registry.md; SECURITY_DESIGN 14.20) - but **what a
         *     caller may read of it follows the caller's scope**. `hub_id` is a filter that can narrow what the
         *     caller may see and never widens it: it is authorization-checked and never trusted, and one outside
         *     the caller's grant yields an empty page and never `HUB_SCOPE_VIOLATION` (list endpoints never probe,
         *     SECURITY_DESIGN 14.4b). `reissueVendorCredentialSetup` acts at the vendor's own hub, and
         *     `recoverVendorCredential` is Platform Admin at all hubs. **Authentication status only** (VendorAccountSummary): identifier, organisation, status,
         *     whether a secret exists, how many browsers are `ACTIVE` and whether a recovery channel exists - never
         *     the channel's address. It is the read `recoverVendorCredential` and `reissueVendorCredentialSetup` need to
         *     find their target (Gate PD-3R1, `PDA-47`). Vendor *onboarding and approval* is `SLICE-008`.
         *
         *     The list carries no ETag; `getVendorAccount` does.
         */
        get: operations["listVendorAccounts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/ops/vendors/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        /**
         * Read one vendor account with its browsers, and the ETag a credential operation takes
         * @description `vendor.read`. **The read `recoverVendorCredential` and `reissueVendorCredentialSetup` take their
         *     `If-Match` from.** The ETag changes when the account's status, credential or device set changes and
         *     never because of a failed sign-in. Every browser the account has held is returned, `REVOKED` and
         *     `REPLACED` included.
         *
         *     **Scoped to the caller's grant**, as `listVendorAccounts` says: an account whose
         *     `VendorOrganization`'s responsible hub is outside the hubs the caller's grant reaches is
         *     `HUB_SCOPE_VIOLATION`, and one that does not exist is `NOT_FOUND` - staff are told which,
         *     as for `getStaffIdentity`. The account stays a global master record; the scope is the caller's.
         *     `reissueVendorCredentialSetup` acts at the vendor's own hub as well and refuses an officer outside it.
         */
        get: operations["getVendorAccount"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/ops/vendors/{id}/credential/recover": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Platform Admin performs exceptional vendor credential recovery
         * @description `vendor.credential.recover` - **Platform Admin**, all hubs (11.2, 37.5).
         *
         *     Split out of performOpsRecovery in R1.
         *
         *     **Creates a `RecoveryRequest` with `initiated_by` set to the acting Platform Admin**, and
         *     delivers its token to the account's **registered recovery channel**. Completing it through
         *     `completeCredentialRecovery` rotates BOTH credentials.
         *
         *     **This issued a `VENDOR_CREDENTIAL_RECOVERY` setup grant until R1.3**, while returning a
         *     `RecoveryRequest` and pointing at a consumer that reads recovery tokens. That purpose is
         *     **withdrawn from `SetupGrant`**: recovering an existing shared secret is a repair, not the
         *     establishment of a new authentication capability, and running two parallel token machines
         *     over one act guarantees they drift.
         *
         *     **For a shared credential this is the entire point of recovery**: the vendor is removing
         *     access from someone who knows the secret, so the old sessions and the old browser device
         *     credential must both stop working.
         *
         *     **Suspension is preserved.** Recovery re-establishes a path to a credential; it never
         *     changes an operational state (37.3).
         *
         *     **The administrator never learns the new shared secret.**
         *
         *     **Where `If-Match` comes from** (Gate PD-3R1, `PDA-47`): the ETag of `getVendorAccount` on this account. A mismatch is `STATE_CONFLICT`; the account is found with `listVendorAccounts`.
         *
         *     **Delivery** (Gate PD-3R1, `PDA-54`): the grant or link is handed to the delivery channel inside this operation, before it commits, and its raw token is never persisted. If the channel refuses it the operation is rolled back - no grant exists and an earlier pending grant is untouched - and the answer is `CREDENTIAL_DELIVERY_FAILED`; nothing was sent and the caller may issue again.
         */
        post: operations["recoverVendorCredential"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/ops/vendors/{id}/credential/setup/reissue": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Re-issue an expired or lost initial VENDOR_CREDENTIAL_SETUP grant
         * @description `vendor.organization.approve` - Senior Ops or Platform Admin, own hub (35.12.2). **MED-10
         *     audit remediation.**
         *
         *     An existing record outside the actor's hubs is `HUB_SCOPE_VIOLATION`; one that does not exist is `NOT_FOUND`.
         *     `INSUFFICIENT_AUTHORITY` is not declared: the key has one tier here and the operation states no higher one.
         *
         *     **The same gap `reissueStaffCredentialSetup` closes, for the vendor side.** Vendor
         *     organisation approval issues the one `VENDOR_CREDENTIAL_SETUP` grant an account receives on
         *     its own, at `recovery_link_ttl_minutes` = 30. If it lapses before anyone at the vendor acts
         *     on it, the account is approved with no shared secret and no PENDING grant, and
         *     `recoverVendorCredential` does not reach it - recovery repairs a secret that exists, and
         *     this account has none.
         *
         *     **Guard: `VendorCredential.secret IS NULL`.** An account that has already established its
         *     shared secret is not being onboarded again - `STATE_CONFLICT`. Use
         *     recoverVendorCredential for that case, which additionally rotates the browser device
         *     credential a genuine recovery must revoke.
         *
         *     **Effect: the signed SetupGrant machine's own `-> PENDING` transition**, for the same
         *     `VENDOR_CREDENTIAL_SETUP` purpose, delivered to the account's registered setup channel.
         *     Any stale PENDING grant is superseded. **Suspension is preserved** - re-issuing a setup
         *     grant establishes a path to a first credential; it never changes an operational state
         *     (37.3).
         *
         *     **The administrator never learns the vendor's permanent shared secret.**
         *
         *     **Where `If-Match` comes from** (Gate PD-3R1, `PDA-47`): the ETag of `getVendorAccount` on this account. A mismatch is `STATE_CONFLICT`; the account is found with `listVendorAccounts`.
         *
         *     **Delivery** (Gate PD-3R1, `PDA-54`): the grant or link is handed to the delivery channel inside this operation, before it commits, and its raw token is never persisted. If the channel refuses it the operation is rolled back - no grant exists and an earlier pending grant is untouched - and the answer is `CREDENTIAL_DELIVERY_FAILED`; nothing was sent and the caller may issue again.
         */
        post: operations["reissueVendorCredentialSetup"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/ops/riders/{riderId}/device/reregister": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                riderId: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Senior Ops initiates in-person replacement device binding
         * @description `staff.device.reregister` - **Senior Ops** at the rider's hub, **in person**.
         *
         *     Split out of performOpsRecovery in R1, and connected to the cryptographic lifecycle it was
         *     never wired to: it issues a `RIDER_DEVICE_REREGISTRATION` grant which the NEW handset
         *     completes through the SAME completion operation as first registration.
         *
         *     **Delivered by the same QR handoff as first registration**. One enrolment
         *     protocol, one transport, one completion operation - a replacement path with its own
         *     mechanics would be a second, less-exercised way into the same credential.
         *
         *     **One registration protocol, not two.** The replacement handset generates its own
         *     non-exportable keypair and submits only the public half. **A private key is never copied
         *     between devices** - it cannot be, which is what non-exportability buys.
         *
         *     **On completion** the old device, if it is still `ACTIVE`, becomes `REPLACED`
         *     and any live session on it ends with `DEVICE_REPLACED`; a device already `REVOKED` stays
         *     `REVOKED`, because it was revoked and not replaced. **The old record is retained either
         *     way.** Nothing changes until the new handset's enrolment, including its key attestation,
         *     succeeds: **a refused replacement leaves the existing device exactly as it
         *     was.** The rider re-establishes their PIN
         *     privately where required; **Senior Ops never sees it**.
         *
         *     Requires the rider present - MSC-DEC-235 admits no remote re-binding path.
         *
         *     **Senior Ops supplies no identifier for the new handset**. The rider is the
         *     path parameter, the grant is rider-bound, and the new handset establishes its own key when
         *     it completes the enrolment.
         *
         *     **Where `If-Match` comes from** (Gate PD-3R1, `PDA-47`): the ETag of `getRider` on this rider, which changes when the rider's status or device set changes. A mismatch is `STATE_CONFLICT`; the rider is found with `listRiders`. `registerRiderDevice` (first binding) takes no `If-Match`: it is refused with `STATE_CONFLICT` when an `ACTIVE` device exists or one has been revoked, and `revokeRiderDevice` takes none either, because revocation is deliberately immediate and unverified.
         */
        post: operations["reregisterRiderDevice"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/orders/{id}/delivery-commitment": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Revise the committed delivery date or window
         * @description `delivery.commitment.revise` - MSC-DEC-305, MSC-DEC-307. Appends a new DeliveryCommitment
         *     row. It NEVER updates the current one: the previous row keeps its committed_date and is
         *     marked superseded.
         *
         *     **A revision without an attribution reason is refused** - COMMITMENT_REASON_REQUIRED. The
         *     same change means opposite things depending on cause: a recipient deferring to Thursday is
         *     service working, and a breakdown pushing to Thursday is a failure Melarc owes an
         *     explanation for.
         *
         *     **A missed commitment is not repaired by revising it.** Superseding Tuesday with Wednesday
         *     leaves Tuesday's row intact, which is what makes the miss provable.
         *
         *     **A rider does not hold this key.** An instruction given at a door is recorded and passed
         *     to Ops.
         */
        post: operations["reviseDeliveryCommitment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/orders/{id}/delivery-commitments": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        /**
         * The full commitment history for an order
         * @description `delivery.read`. Every commitment the order has carried, oldest first, each with its
         *     default_date, requested_date, committed_date, attribution reason and actors.
         *
         *     **This is the record that answers whether Melarc kept its promise**, which a single
         *     mutable delivery_date could not.
         *
         *     **Paginated — post-session audit remediation, CRIT-10's sibling.** Bounded in practice
         *     by one order's own revision count, unlike `listPickupManifests`'s hub-lifetime growth —
         *     included for envelope consistency across every list operation, not because this one is
         *     at material risk of the memory or timeout failure CRIT-10 named.
         */
        get: operations["listDeliveryCommitments"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pickup-requests/{id}/service-window-override": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Schedule service outside the customer service window
         * @description `pickup.request.override_window` - MSC-DEC-301. Records the original window, the revision,
         *     the actor, the reason, the customer notification state and the timestamp.
         *
         *     **An out-of-window action is never silently counted as normal SLA performance.** That is
         *     the entire purpose of the record: a pickup at 08:30 reads as ordinary against 07:00-18:00
         *     operating hours and as an exception against the 11:00-16:00 customer window, and only the
         *     second reading lets Ops see that something unusual happened.
         */
        post: operations["overrideServiceWindow"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/pickup-requests/{id}/handling-assessment": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Record a parcel operational handling assessment
         * @description `hub.parcel.assess_handling` - MSC-DEC-303. STANDARD_HANDLING, REQUIRES_REVIEW or
         *     NOT_ACCEPTABLE, with a mandatory reason on the latter two.
         *
         *     **A transport-safety decision, never a pricing surcharge.** A parcel that passes review
         *     costs what its size class costs; one that fails is not carried at a higher price.
         *
         *     **No kilogram or dimension threshold exists** - MSC-DEC-302 withdrew weight as a pricing
         *     input, and inventing a limit here would reintroduce it through a different door.
         */
        post: operations["assessParcelHandling"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/delivery-stops/{id}/verification-fallback": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Rider reports an OTP or verification problem and requests assistance
         * @description `delivery.stop.execute` - the assigned rider. Raises the request. It does
         *     NOT authorise anything.
         *
         *     **The rider may not self-bypass verification.** Ops reviews the order, recipient, rider,
         *     location, payment state and verification attempts, then authorises through
         *     authoriseDeliveryWithoutOtp under `delivery.otp.override`.
         *
         *     **Gate C adds the request because only the grant was recorded.** Without this, a fallback
         *     that is REFUSED leaves no trace at all.
         *
         *     **No physical delivery attempt is consumed** - the failure is Melarc's.
         */
        post: operations["requestVerificationFallback"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/delivery-stops/{id}/next-stop-contact": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Record the NEXT_STOP recipient-contact checkpoint
         * @description Checkpoint two of three. The rider calls ahead when the recipient becomes the
         *     next planned stop: confirm they are still available, get final directions, tell them they
         *     are next.
         *
         *     **A failure here skips the stop and the rider continues the route.** The parcel stays in
         *     RIDER custody - it is not at the hub, and nothing may record it as returned while it is in
         *     a pannier. It comes back at end of run through the ordinary custody transfer.
         *
         *     **This is not a physical delivery attempt.** No rider reached the door, so
         *     Order.delivery_attempts is untouched whatever the reason's consumes_delivery_attempt says,
         *     and no redelivery could arise from it.
         *
         *     Vendor is notified with recipient name and order reference, and Ops may
         *     recover the stop later in the run.
         */
        post: operations["recordNextStopContact"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/delivery-stops/{id}/doorstep-contact": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Record the DOORSTEP checkpoint, and start the controlled wait on failure
         * @description Checkpoint three of three, opened by arriveAtDeliveryStop.
         *
         *     **On a failed contact the SERVER starts the controlled wait**: it sets
         *     wait_started_at and derives wait_expires_at from doorstep_wait_minutes. **No field here
         *     supplies either**, and a client-supplied elapsed claim is never accepted - the party who
         *     wants to leave is the wrong clock. Ops is alerted.
         *
         *     **Retries stay inside this checkpoint.** Calling four times is one checkpoint, not attempts
         *     four through seven. Rider, Ops and Vendor retries all count as this one.
         *
         *     **A recipient who appears before expiry is simply delivered to** - the stop returns to
         *     ARRIVED, no failure is recorded, no physical attempt is consumed and no redelivery arises.
         *
         *     **IDEMPOTENT.** A retried submission must not start a second timer or send a second Vendor
         *     notification.
         */
        post: operations["recordDoorstepContact"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/delivery-stops/{id}/payment-demand": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        /**
         * What is owed at this stop, and the demand id to collect it against
         * @description **THE PRODUCER of payment_demand_id**. `initiatePaymentCollection` requires
         *     one and, until C1.6, **no operation produced one** - so the approved rider path ended at an
         *     identifier nobody could obtain.
         *
         *     **One engine, two surfaces, one permission**. A Rider reads it on **their own
         *     assigned stop**; Ops reads it **within hub scope**. `payment.collection.read` is narrow and
         *     deliberately not `payment.read`.
         *
         *     **The backend derives the demand from authoritative obligations.** A client never
         *     constructs lines and never names an amount. Where a payable obligation has no demand yet,
         *     this read materialises the one those obligations already determine, under the same business
         *     key: **opening the screen five times produces one GH55 demand, not five**.
         *
         *     Returns the demand with its lines and total, what has already been received, whether
         *     collection may be initiated now, and - where a provider attempt is unresolved - the attempt
         *     id an Ops officer authorises a fallback against.
         */
        get: operations["getStopPaymentDemand"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/payment-demands": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Open operational payment demands in scope
         * @description **The Ops Mini POS producer** - the hub-scoped operational view behind
         *     `/payment-collections/new`. An officer **selects a modelled operational obligation**; they
         *     do not compose one.
         *
         *     **There is no arbitrary-demand creator, and this is not one.** Gate C collects modelled
         *     operational obligations - delivery fee, redelivery delivery fee, redelivery fee,
         *     single-package pickup fee. **General receipts and account allocation are Accounting &
         *     Reporting's**, and a screen that could assemble a demand from a free-text amount is a
         *     cashbook.
         *
         *     **Scope is the registry's, not this operation's.** Ops sees their hub; a Rider holding the
         *     same key reaches only demands for stops they are assigned. Nobody sees another hub.
         *
         *     **Paginated — post-session audit remediation, CRIT-10's sibling.** Was an unbounded raw
         *     array; matches `listPickupRequests`'s envelope exactly.
         */
        get: operations["listOperationalPaymentDemands"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/payment-collections": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Ask the payer's mobile-money provider for an outstanding operational obligation
         * @description **One engine, two surfaces**. The assigned Rider on their own stop, or Ops
         *     within hub scope, initiate through THIS operation. There is no RiderHubtelCollection and no
         *     OpsHubtelCollection: two implementations of one payment become two answers to *did this
         *     customer pay*, and the second is always found during an argument about money.
         *
         *     **The caller supplies the payer's number and nothing else that matters.** The server derives
         *     the obligation, the amount, the currency, the hub and the client reference. A caller able to
         *     set the amount could collect GH1 against a GH55 debt.
         *
         *     **The server requests the demand's remaining_due_minor, not its total**.
         *     GH55 owed with GH50 already confirmed prompts the payer for **GH5** - asking for GH55
         *     again would take GH105 for a GH55 delivery. **A Rider never chooses this figure**, and the
         *     one-unresolved-attempt rule applies to the new attempt exactly as to the first.
         *
         *     **Eligible while the demand is OPEN or PARTIALLY_SETTLED with remaining due** - never once
         *     it is SETTLED (PAYMENT_ALREADY_SETTLED) or VOID, and never while another attempt is
         *     unresolved. A SUCCEEDED attempt that left the demand short is resolved provider truth, so
         *     the GH5 attempt after a GH50 success is the ordinary next collection, not a retry. A
         *     contract that admitted only an OPEN demand here would dead-end every partial payment.
         *
         *     **Only the Melarc backend speaks to the provider**. A Rider handset or an Ops
         *     browser never does, and no provider credential appears in any response.
         *
         *     **This creates a REQUEST, not a receipt.** A 2xx here, a provider reference, a delivered
         *     push - none of them means money arrived. Only verified provider confirmation reaches
         *     SUCCEEDED.
         *
         *     **One unresolved attempt per obligation.** PAYMENT_ALREADY_PENDING refuses a second while
         *     one is outstanding, and PAYMENT_STATUS_UNKNOWN refuses a retry after a transmitted request
         *     went unanswered - **which is exactly when the money most likely moved and Melarc least knows
         *     it**. A timeout is not a failure.
         *
         *     **IDEMPOTENT.** A double tap produces one collection and one prompt.
         *
         *     **No PIN field exists here or anywhere else.** The payer authorises on their own handset
         *     through the provider's prompt.
         */
        post: operations["initiatePaymentCollection"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/payment-demands/{id}/fallback-authorization": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Authorise a fallback while a provider attempt is still unresolved
         * @description **The one controlled way through the settlement gate**.
         *
         *     A provider problem must not strand a delivery where the recipient is present and willing.
         *     But an unresolved attempt means the customer **may already have been
         *     debited**, so taking cash or a Merchant MoMo payment on top of it is a decision to accept a
         *     known risk - and it is made by someone who can see the attempt history.
         *
         *     **AUTHORISED OPS ONLY.** A Rider may report the provider problem and request assistance; a
         *     Rider may never authorise this, dismiss an unresolved attempt, or declare the provider safe
         *     to ignore.
         *
         *     Records the unresolved attempt, the demand, a **mandatory reason**, the chosen fallback
         *     method and an explicit **acknowledgement of duplicate-payment risk**.
         *
         *     **A later provider success becomes a FinancialAdjustmentRequired fact**, not a silent second
         *     settlement. Gate C records that money is owed back and stops; refund and
         *     credit are Accounting & Reporting's.
         *
         *     **This is not ordinary fallback under another name.** Without an authorisation here, an
         *     unresolved attempt refuses the fallback outright.
         *
         *     **Returns the authorisation, because a grant nothing can spend is not a grant**.
         *     Its id is what `confirmManualPayment` and `recordRecipientCashPayment`
         *     reference, and the record is **consumed exactly once** by the receipt that uses it -
         *     method-bound and demand-bound. **An audit log is not an authorisation database.**
         *
         *     **IDEMPOTENT.** One active grant per demand, attempt and method; a repeat returns the
         *     existing one rather than accumulating authorisations.
         */
        post: operations["authorizePaymentFallbackWhileUnresolved"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/payment-collections/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        /**
         * Current state of a collection attempt
         * @description Permission `payment.collection.read` - **narrow, and deliberately not `payment.read`**.
         *     A Rider holds it **on their own assigned stop**; Ops holds it **within hub
         *     scope**; a Vendor has no access.
         *
         *     **Without this the rider path did not exist.** initiatePaymentCollection permits a Rider,
         *     and this operation demanded `payment.read`, which no rider bundle holds - so a rider
         *     could ask a customer for money and had **no contractual way to learn whether it
         *     arrived**. Granting the broad key instead would have handed every rider hub-wide
         *     reconciliation to fix a status poll.
         *
         *     **STATUS_UNKNOWN is a first-class answer** and the UI must show it as *checking payment
         *     status, do not request payment again* - never as a failure with a retry button.
         */
        get: operations["getPaymentCollection"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/provider-callbacks/hubtel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Provider callback endpoint - server-to-server, not a human operation
         * @description **No browser session and no CSRF token**, because no browser calls this: it is a
         *     server-to-server notification. It is **not** an authenticated human operation and confers
         *     no authority on anyone.
         *
         *     **A callback is a hint, not proof**. Where the live product provides a
         *     verifiable signature or MAC it is validated; **where it does not, the attempt reaches
         *     SUCCEEDED only after an independent server-to-server status verification**. An
         *     unauthenticated endpoint receiving JSON that says *success* is not evidence that money
         *     moved.
         *
         *     **Idempotent and replay-safe.** The same success delivered three times produces ONE success
         *     effect, one receipt and one allocation.
         *
         *     **Monotonic.** A stale PENDING arriving after SUCCEEDED is discarded; terminal truth does
         *     not regress.
         *
         *     **Nothing in the body becomes authoritative on its own.** The amount, currency and
         *     obligation are verified against the frozen attempt; a callback for GH5 does not settle a
         *     GH55 obligation. **Fail closed on an unknown reference.** Payer numbers are redacted in
         *     logs; no secret appears in the URL.
         */
        post: operations["receiveHubtelPaymentCallback"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/orders/{id}/redeliveries": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        /**
         * Redelivery history for an order
         * @description The trip history. A Vendor reads their own order's redeliveries and **is not the payer**;
         *     a Rider reads the trip they are assigned. Neither writes.
         *
         *     **Paginated — post-session audit remediation, CRIT-10's sibling.** `MSC-DEC-350` sets no
         *     maximum trip count, so this list has no hard bound even though it is order-scoped;
         *     included for envelope consistency across every list operation.
         */
        get: operations["listRedeliveries"];
        put?: never;
        /**
         * Schedule a redelivery after a failed physical delivery attempt
         * @description **This operation creates the charge, and nothing earlier does**.
         *
         *     A failed physical attempt makes a parcel ELIGIBLE. A parcel may sit at the hub eligible and
         *     unscheduled, owing nothing. **The obligation exists because Melarc is about to send a rider
         *     out again**, which is the thing being paid for.
         *
         *     On scheduling the server:
         *
         *       1. verifies the originating DeliveryStop is a QUALIFYING FAILED PHYSICAL attempt -
         *          never a PRE_DISPATCH or NEXT_STOP contact failure, which are not attempts
         *       2. verifies the parcel is under controlled hub custody
         *       3. resolves destination and service, including any approved location change
         *       4. SNAPSHOTS applicable_delivery_fee_minor from the ordinary pricing rules
         *       5. SNAPSHOTS redelivery_fee_minor from the HUB setting
         *       6. sets payer = RECIPIENT, which ordinary Ops cannot change
         *       7. derives `chargeable` FROM THE ORIGINATING REASON
         *       8. writes a new DeliveryCommitment, preserving the original
         *       9. notifies the recipient and the Vendor
         *
         *     **Both fees are snapshots.** A later change to the hub setting never reprices a redelivery
         *     already scheduled.
         *
         *     **Where the originating reason attributes the failure to Melarc - a rider breakdown, a
         *     provider outage, an OTP failure that was not the recipient's doing - `chargeable` is false
         *     and both fees are zero.** Recipient is the payer WHEN A CHARGEABLE OBLIGATION EXISTS; those
         *     are two rules, and collapsing them bills a customer for Melarc's own outage.
         *
         *     **The original trip's fee is untouched** - not refunded, reversed or relabelled. Two events,
         *     two records.
         *
         *     **The redelivery runs the same three contact checkpoints**, starting with its own
         *     PRE_DISPATCH. It is a delivery cycle, not attempts four, five and six. **No maximum number
         *     of redeliveries exists**; each further trip needs its own approval.
         *
         *     **This is not a Return.** Return-to-vendor is a separate Ops decision with its
         *     own fee. redelivery_fee_minor and flat_return_fee_amount are separate settings that happen
         *     to share an Accra launch value.
         *
         *     **IDEMPOTENT.** A retried approval creates no second record, no duplicate commitment, no
         *     duplicate fee and no duplicate notification.
         *
         *     **HIGH-13 audit remediation (13 September 2026, corrected on review) — two different Ops
         *     users, not one retry.** `Idempotency-Key` alone stops the SAME caller's retry from
         *     duplicating; it does nothing about a SECOND, independent scheduling request for the same
         *     failed stop. **The guard that does is the order's own fulfilment transition.** Scheduling
         *     drives `AT_HUB_AFTER_FAILURE -> READY_FOR_REATTEMPT` (state-machines.md Sec9, signed);
         *     that transition is available only FROM `AT_HUB_AFTER_FAILURE`, so of two concurrent
         *     requests the first moves the order and the second finds the state already moved and fails
         *     `STATE_CONFLICT` - a code already in this operation's x-error-codes and, until now, never
         *     explained here.
         *
         *     **This is a state guard, NOT a one-per-stop constraint, and the difference matters.**
         *     Sec20.5 provides `SCHEDULED -> CANCELLED` for a trip that never departed, and states that
         *     **no maximum redelivery count exists**. A cancelled trip leaves the parcel at the hub with
         *     the same qualifying failed stop behind it and no new physical attempt, so a later, legitimate
         *     redelivery **references that same `originating_delivery_stop_id`**. An implementation that
         *     enforces uniqueness on that column would refuse the reschedule Sec20.5 explicitly allows.
         *     *Superseded reading, withdrawn on review:* that `originating_delivery_stop_id` is UNIQUE
         *     across `Redelivery` records - asserted here on 13 September, contradicted by the signed
         *     machine, and never a rule any approved source states.
         */
        post: operations["scheduleRedelivery"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/redeliveries/{id}/cancellation": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Cancel a scheduled or in-progress redelivery
         * @description `dispatch.run.create` - authorised Ops, the same authority that scheduled it (20.5,
         *     MSC-DEC-353). **A deliberate decision with a reason**, never a consequence: nothing
         *     cancels a redelivery by expiry, by a counter, or by another record changing state.
         *
         *     **Before IN_PROGRESS, both obligations become VOID** - the new delivery fee and the
         *     redelivery fee together. The trip was never made, so the charge for making it does not
         *     stand. **After IN_PROGRESS it is a disposition decision**, Return or otherwise, and the
         *     snapshots are RETAINED rather than deleted: the amounts a recipient was told remain
         *     readable after the trip they described was abandoned.
         *
         *     **Voiding an obligation is not reversing a payment.** Where money already arrived against
         *     it, the PaymentReceipt STANDS - a receipt records that money moved, and money did move.
         *     The demand goes VOID and the excess becomes a FinancialAdjustmentRequired for the
         *     finance workflow to resolve. **A cancellation must never
         *     silently delete a receipt**, which is what "cancel the charge" reads like to an
         *     implementer and is the reason this paragraph is here.
         *
         *     **This operation existed only as a transition until Gate C C1.9.** 20.5 named authorised
         *     Ops as the actor of `SCHEDULED -> CANCELLED` and `IN_PROGRESS -> CANCELLED` and no
         *     operation carried either, so the actor the machine named had no way to act - the same
         *     shape as CONFLICT-038. No Product rule is invented here: MSC-DEC-353 already decided
         *     what cancellation does, and this is the contract propagating it.
         *
         *     **IDEMPOTENT.** A retried cancellation voids nothing twice and raises no second
         *     adjustment.
         */
        post: operations["cancelRedelivery"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/orders/{id}/return": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Commit a ReturnRecord and begin formal Return processing
         * @description `returns.initiate` - Authorised Ops, the actor the signed fulfilment machine already
         *     names (state-machines.md Sec9, `AT_HUB_AFTER_FAILURE -> RETURN_TO_VENDOR_IN_PROGRESS`,
         *     MSC-DEC-332). SLICE-006 Pass 1, closing the remaining half of OQ-123.
         *
         *     **Ultimate failure does not itself start Return processing**. A third
         *     failed attempt is a rider's report, never an adjudication - the parcel sits at the hub
         *     eligible and unscheduled, owing nothing, until Ops reviews it and either schedules a
         *     further Redelivery or commits a Return. This operation is the second path.
         *
         *     On commit the server:
         *
         *       1. verifies the order is AT_HUB_AFTER_FAILURE
         *       2. derives settlement_path from whichever of the order's vendor_organization_id /
         *          ad_hoc_sender_id is set (5.2.4, 28.4) - never chosen by the caller
         *       3. SNAPSHOTS return_fee_minor from the hub's flat_return_fee_amount - charged by
         *          default, not derived from any failure-reason attribution
         *       4. drives the commercial machine's CREDIT_RESERVED/PREPAID/NO_VENDOR_CHARGE -> REVERSED
         *          transition, reversing the original delivery fee
         *       5. where the order's delivery-fee demand already carries CONFIRMED PaymentReceipts (a
         *          split-payment recipient portion collected before the final failed attempt), raises
         *          exactly ONE FinancialAdjustmentRequired (reason: PAID_OBLIGATION_VOIDED - the
         *          existing reason, no new value) for the SUM of those CONFIRMED receipts - a demand
         *          may carry several and a REVERSED_BY_PROVIDER receipt is excluded.
         *          Its source_key is the ReturnRecord commitment, so a retried commit raises no second
         *          adjustment. MSC-DEC-394 decided refund as the resolution class; execution stays
         *          OQ-005's
         *       6. emits order.return.initiated (Enhanced, already catalogued at audit.md 5.x)
         *
         *     **Creates no OperationalPaymentDemand where settlement_path = STATEMENT.** A registered
         *     vendor's return fee is earned here and settled through the future VendorStatement
         *     mechanism instead - this operation records the fact and stops. Only
         *     settlement_path = IMMEDIATE_DEMAND (an ad-hoc sender) produces a demand, materialised on
         *     the next read exactly as every other OperationalPaymentDemand obligation is.
         *
         *     **Waiver, if any, is requested and approved separately** through the existing
         *     returns.waiver.request / returns.waiver.approve keys, against this record's
         *     waiver_status - not through this operation. Full or partial: MSC-DEC-394 settled the
         *     amount as Senior Ops discretion, no formula - Ops proposes waiver_amount_minor, Senior
         *     Ops approves or rejects it as a whole.
         *
         *     **No cancellation, once committed.** A committed ReturnRecord always runs to completion
         *     - no operation in this contract cancels or reverses one.
         *
         *     **IDEMPOTENT.** A retried commit creates no second record, no duplicate fee snapshot and
         *     no duplicate reversal - the same state-guard reasoning scheduleRedelivery already
         *     documents: the fulfilment transition is available only from AT_HUB_AFTER_FAILURE, so a
         *     second concurrent request finds the state already moved and fails STATE_CONFLICT.
         */
        post: operations["initiateReturn"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/returns/{id}/otp": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Send the return OTP to the recorded vendor/sender contact
         * @description `returns.close` - **R** on their own assigned return, A S P on own hub. Mirrors
         *     `requestDeliveryOtp` exactly, redirected to a different contact (28.4).
         *
         *     **The request body is empty, and that is the guard**, the identical reasoning
         *     `requestDeliveryOtp` states: there is no destination field, so a caller-supplied number
         *     is inexpressible. The OTP goes only to the vendor/sender contact recorded on the order.
         *     **That contact may forward the code to another receiver** (28.4) - Melarc does not
         *     validate who physically holds the phone that reads it back.
         *
         *     **Refused while settlement_path = IMMEDIATE_DEMAND and the return-fee demand is not
         *     SETTLED** - RETURN_FEE_OUTSTANDING (35.8.9). Where settlement_path = STATEMENT, this
         *     gate does not apply: a registered vendor's return fee bills later, exactly as an
         *     ordinary CREDIT_RESERVED delivery fee does not block dispatch.
         *
         *     **The OTP value is never returned.**
         *
         *     **The same handover_otp_* parameters govern it** (settings.md 7.4, all CONFIRMED -
         *     MSC-DEC-418, MSC-DEC-421) - one mechanism, two destinations, one set of figures.
         */
        post: operations["requestReturnOtp"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/returns/{id}/close": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Close physical return custody against a valid OTP
         * @description `returns.close` - **R** on their own assigned return, A S P on own hub. The signed
         *     fulfilment machine names the actor as "Rider or Ops" (state-machines.md Sec9,
         *     `RETURN_TO_VENDOR_IN_PROGRESS -> RETURNED_TO_VENDOR`) - a rider executes a physical
         *     drop-off; Ops closes a return the vendor collects in person at the hub counter. **Both
         *     classes hold the identical key**, because the signed machine does not distinguish them
         *     by authority, only by which of them is physically present.
         *
         *     **Both conditions, 28.4's order**: the return-fee gate satisfied where
         *     settlement_path = IMMEDIATE_DEMAND (RETURN_FEE_OUTSTANDING), then a valid OTP validated
         *     against the order and the recorded vendor/sender contact (OTP_INVALID). Physical custody
         *     never closes on payment alone and never on discretion.
         *
         *     **IDEMPOTENT on replay** - the same key returns the original result, emits no second
         *     audit event and creates no second commercial effect.
         */
        post: operations["closeReturnHandover"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/financial-adjustments/{id}/resolution": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Propose how a FinancialAdjustmentRequired is resolved
         * @description **Proposes a remedy for money owed back.** MSC-DEC-395. The adjustment itself is a Gate C
         *     fact that stops at OPEN; this is the Accounting domain's answer to it.
         *
         *     **Proposing moves nothing.** The adjustment stays OPEN and reaches RESOLVED only when a
         *     holder of payment.adjustment.approve approves the proposal through the sibling operation.
         *
         *     **Class is constrained by who the payer is.** CREDIT requires a VendorBalance and is
         *     therefore a registered vendor's only - Sec49 places individual/ad-hoc credit outside
         *     Version 1 and no recipient or AdHocSender holds a balance. For a registered vendor CREDIT
         *     is the default and REFUND displaces it only on the vendor's recorded request.
         *
         *     **Melarc records this money - it does not move it.** Sec39.8's provider boundary is
         *     inbound only and names reversals/refunds among what the integration contract must still
         *     define, so a REFUND is executed out of band and evidenced here - the same shape
         *     CashDisposition already uses for a bank deposit.
         *
         *     **UNCLAIMED_DISPOSITION requires unclaimed_adjustment_grace_days to have elapsed** since
         *     the adjustment was raised - refused with STATE_CONFLICT before then. The figure is 90
         *     days, CONFIRMED at MSC-DEC-396 (settings.md 7.1; OQ-126 closed 20 September 2026).
         *
         *     **Refused with STATE_CONFLICT** where the adjustment is already RESOLVED or already
         *     carries a PROPOSED or APPROVED resolution: one adjustment, one resolution, resolved whole.
         */
        post: operations["proposeAdjustmentResolution"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/financial-adjustments/{id}/resolution/decision": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Approve or reject a proposed resolution
         * @description **Finance approves or rejects the proposal.** MSC-DEC-395.
         *
         *     **The decider is never the proposer** - refused with SELF_APPROVAL_FORBIDDEN. The
         *     maker-checker shape is payment.road_expense.approve's, for the reason audit.md gives that
         *     key: approval moves money out. The approver is Finance rather than Senior Ops because
         *     payment.cash.disposition and payment.cash.reconcile_hub already place outbound and
         *     cross-hub money there.
         *
         *     **On APPROVED the adjustment reaches RESOLVED.** On REJECTED it stays OPEN and a fresh
         *     proposal may follow; **the rejected record is kept**, because how often a proposed
         *     resolution is refused is the control on a discretionary money act.
         *
         *     Emits payment.adjustment.resolution_decided, Enhanced.
         */
        post: operations["decideAdjustmentResolution"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/orders/{id}/contact-assistance": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Vendor supplies a corrected or alternative recipient contact
         * @description A Vendor responding to a recipient-contact exception on their OWN order.
         *
         *     **This is an input, not an authority.** A corrected number arriving here does not become the
         *     recipient's number: Ops applies the controlled correction. **The channel must not decide who
         *     has authority** - a response captured by Ops from official WhatsApp reaches this same
         *     canonical workflow and carries exactly the same weight.
         *
         *     Vendor scope is their own order relationship and nothing wider. Gate B scope is unchanged.
         */
        post: operations["submitVendorContactAssistance"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/orders/{id}/delivery-location-change": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        /**
         * Ops decides a delivery-location change
         * @description **Ops authority, never the rider's**. Ops assesses serviceability, hub
         *     ownership, corridor and service-day rules, pricing effect and route feasibility.
         *
         *     **The original destination survives.** original_location is never overwritten; the record
         *     keeps what was asked for, what was authorised, by whom, and why. Vendor is notified.
         *
         *     **INSUFFICIENT_AUTHORITY is the code a rider gets here, and PERMISSION_DENIED is not.**
         *     The Rider holds dispatch.recipient_confirmation.work on assigned parcels (permissions.md,
         *     widened at MSC-DEC-361 so a rider may make the PRE_DISPATCH call), so the key check passes
         *     and the standing check is what refuses. state-machines.md 11 names INSUFFICIENT_AUTHORITY
         *     on the AWAITING_ATTEMPT to DETAILS_CORRECTION_REQUIRED row - SIGNED, and re-signed at
         *     MSC-DEC-366 - and this operation had not declared it. errors-and-enums.md keeps the two
         *     apart deliberately: one means the actor lacks the key, the other that the actor holds the
         *     key and not the standing.
         */
        put: operations["decideDeliveryLocationChange"];
        /**
         * Record a recipient's request for a different delivery location
         * @description The rider RECORDS the request. **The rider does not decide it.**
         *
         *     The parcel does not travel to an unapproved destination. A rider able to redirect could move
         *     a parcel outside its hub's service area, past a corridor day, and off the price it was sold
         *     at - which is why serviceability, hub ownership, corridor rules, pricing and route
         *     feasibility are assessed by Ops before anything is accepted.
         *
         *     The original destination is preserved. See decideDeliveryLocationChange.
         */
        post: operations["requestDeliveryLocationChange"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/orders/{id}/manual-payment-confirmation": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Confirm a Merchant MoMo receipt out of band
         * @description `payment.momo.confirm_manual` - MSC-DEC-328, MSC-DEC-329. Used when the integrated provider
         *     is unavailable and the recipient paid the official Melarc Merchant MoMo account.
         *
         *     **A screenshot is not proof** - PAYMENT_FALLBACK_NOT_VERIFIED. A payment image is trivially
         *     reproduced, reused and edited, and the rider at the door cannot distinguish a genuine one.
         *
         *     **Never held by a rider.** The person completing the delivery is not the person confirming
         *     the payment - 37.4,
         *     MSC-DEC-135's maker-checker, applied where the money rather than the record
         *     is at stake.
         *
         *     **Where a provider attempt is unresolved, a valid Ops fallback authorisation is REQUIRED**
         *     - `fallback_authorization_id`, and FALLBACK_REQUIRES_AUTHORIZATION
         *     without one. Where no unresolved attempt exists, ordinary fallback rules apply and no
         *     authorisation is needed.
         *
         *     **The grant is checked, not merely quoted.** It must be ACTIVE, it must name **this** demand
         *     and **that** attempt, and its method must be the method being taken -
         *     FALLBACK_AUTHORIZATION_ALREADY_CONSUMED, FALLBACK_AUTHORIZATION_DEMAND_MISMATCH,
         *     FALLBACK_AUTHORIZATION_METHOD_MISMATCH.
         *
         *     **A successful receipt CONSUMES the authorisation**, once and finally. A second settlement
         *     cannot reuse it.
         *
         *     **A confirmed Merchant MoMo payment creates a PaymentReceipt** (method MERCHANT_MOMO,
         *     MSC-DEC-358) for **the amount independently verified** and hands it to the SAME atomic
         *     settlement engine every other method uses: receipt first, then cumulative
         *     demand evaluation, then line allocation **only at full funding**.
         *     **GH50 verified against GH55 settles no line here either** - the demand stays partially
         *     funded, handover stays blocked, and GH5 remains due. *Superseded description:* the
         *     confirmation allocated across the frozen lines, which would have let a Merchant MoMo
         *     payment settle what an identical Hubtel payment does not. **No payment method gets its
         *     own commercial allocation policy.**
         *     It creates **no rider physical cash**.
         */
        post: operations["confirmManualPayment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/road-expenses": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List road expenses
         * @description `payment.run_position.read` - **R only on their own run**, A S P on own hub.
         *     A rider sees their own; Ops sees their hub's. The scope is the registry's,
         *     not this operation's.
         *
         *     **It required `payment.read` until C1.6, which no rider bundle holds.** The rider
         *     inventory told an implementer to build the approval-status and applied-to-handover rows
         *     against a hub-wide finance key - **and the screens were unbuildable**. The failure looks
         *     in the code exactly like the rule working: the permission check simply denies.
         *
         *     **Paginated — post-session audit remediation, CRIT-10's sibling.** Hub-scoped and grows
         *     continuously; was an unbounded raw array.
         */
        get: operations["listRoadExpenses"];
        put?: never;
        /**
         * Record an operational expense incurred on the road
         * @description `payment.road_expense.record` - MSC-DEC-314. Rider-held, because the rider is the actor who
         *     spent the money. Creates the expense in CLAIMED.
         *
         *     **A CLAIMED expense reduces nothing**, and **an APPROVED one reduces nothing
         *     either until it is applied**. Only an approved, eligible
         *     COLLECTION_CASH expense ACTUALLY BOUND to a handover lowers that handover's expected
         *     cash. Unresolved is treated as not-approved - otherwise the control is bypassed by not
         *     deciding.
         *
         *     **funding_source is mandatory and never mixed**: the same GH20 has three
         *     different cash consequences and nothing else in the record distinguishes them.
         */
        post: operations["createRoadExpense"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/road-expenses/{id}/decision": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Approve or reject a road expense
         * @description `payment.road_expense.approve` - MSC-DEC-319. Senior Ops, and the approver may not be the
         *     rider who claimed it (SELF_APPROVAL_FORBIDDEN).
         *
         *     **This is the key that makes a COLLECTION_CASH expense ELIGIBLE to move money out of a
         *     rider's cash accountability. It does not itself move any**.
         *     APPROVED means eligible for application. The expected handover falls only when the
         *     expense is APPLIED - bound to one specific CashHandover at that handover's opening.
         *     An approved expense never applied reduces nothing; one already applied elsewhere can
         *     never reduce a second handover. Rejecting leaves the cash owed, with a mandatory reason.
         *
         *     **There is no path back from REJECTED.** A rejected expense that is genuinely valid is
         *     re-raised as a new claim with its own evidence, so the rejection stays visible.
         */
        post: operations["decideRoadExpense"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/delivery-runs/{id}/cash-summary": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        /**
         * The calculated cash position for a run
         * @description `payment.run_position.read` - **R only on their own run**, A S P on own hub.
         *     A rider reads their OWN run: expected collections, confirmed digital,
         *     gross cash, applied collection-cash expenses, expected handover, the hub's counted
         *     result and their own variance. **It reaches no other rider's position, no hub-wide
         *     reconciliation and no unrelated customer payment.**
         *
         *     **It required `payment.read` until C1.6.** Four approved rider rows - the cash summary,
         *     the applied-expense figure, the handover outcome and the variance display - named a key
         *     held by Ops, Senior Ops, Platform Admin and Finance and **by no rider**.
         *
         *     **Reading a variance is not resolving one.** `payment.variance.resolve` stays Senior Ops.
         *
         *     MSC-DEC-312, MSC-DEC-313, MSC-DEC-320. Two reconciliations, deliberately
         *     separate, because collapsing them produces a confident wrong answer: expected GH425
         *     against cash counted GH125 reports a GH300 shortfall against a rider who is not short.
         *
         *     **Customer payment**: expected delivery amount against confirmed digital, confirmed
         *     fallback and gross recipient cash. **Cash custody**: gross cash minus **APPLIED**
         *     COLLECTION_CASH road expenses = expected handover - **never the approved total**.
         *     Approval makes an expense eligible; **application** at a
         *     handover's opening is what moves money out of a rider's accountability.
         *
         *     **The rider does not choose the expected total**. It is derived here.
         *
         *     **Gross cash is never rewritten by an expense**: 145 stays 145 and the
         *     GH20 stays an expense, because a model that nets fuel out of takings has recorded the
         *     money as never collected rather than as spent.
         */
        get: operations["getRunCashSummary"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/hubs/{id}/cash-reconciliations": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        /**
         * Hub cash reconciliations
         * @description `payment.read`. Finance holds this at all hubs - reconciliation is cross-hub by nature.
         *
         *     **Paginated — post-session audit remediation, CRIT-10's sibling.** One record per business
         *     day accumulates without bound over the platform's lifetime for the `{id}` hub this
         *     operation is scoped to; was an unbounded raw array.
         */
        get: operations["listHubCashReconciliations"];
        put?: never;
        /**
         * Record the end-of-day Hub cash count
         * @description `payment.cash.reconcile_hub` - MSC-DEC-322. Compares the expected Hub position against a
         *     physical count.
         *
         *     **Hub variance is not rider variance.** Netting them would assign a loss to whichever
         *     record was reconciled second.
         *
         *     **expected_minor is never edited to match the count**. A non-zero difference
         *     opens VARIANCE_OPEN with a mandatory reason; it does not adjust the expectation.
         *
         *     **Passing 18:00 is not a transition.** Open cash past cash_reconciliation_cutoff_time is an
         *     exception requiring visibility, not a shortage.
         */
        post: operations["recordHubCashCount"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/hub-cash-reconciliations/{id}/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Disposition a Hub cash variance
         * @description `payment.variance.resolve` - MSC-DEC-321, MSC-DEC-322. Reuses the existing variance key
         *     rather than adding a hub-specific one.
         *
         *     **The expected total is unchanged by resolution.** The variance is resolved, not erased -
         *     a resolution that rewrote the expectation would reach the same terminal state with no
         *     evidence anything happened.
         *
         *     **A rider may never resolve their own variance.** This key is Senior Ops and is not
         *     rider-holdable at all.
         */
        post: operations["resolveHubCashVariance"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/hub-cash-reconciliations/{id}/dispositions": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Record where the physical cash went
         * @description `payment.cash.disposition` - MSC-DEC-323. Bank deposit, Merchant MoMo transfer, Finance
         *     handover or approved safe custody, with amount, method, destination, reference and
         *     evidence where the method requires it.
         *
         *     **Cash is not settled because a rider handed it to a hub.** This is the last custody
         *     transfer and the one nobody naturally records: rider-to-hub is observed by two people,
         *     hub-to-bank is often one person and a deposit slip.
         *
         *     **This creates no accounting entry.** It is the operational source event the future
         *     Accounting domain consumes.
         */
        post: operations["recordCashDisposition"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/vendor-organizations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create a vendor record and its shared portal account, awaiting approval
         * @description `vendor.organization.create` - Ops Staff, Senior Ops, Platform Admin at own hub
         *     (18.2, 29.2.1, 35.12.1).
         *
         *     **A business cannot self-register.** There is no anonymous creation path and every
         *     record carries a staff `created_by`.
         *
         *     **The record is created in `PENDING_SENIOR_OPS_REVIEW` and grants nothing.** One act
         *     also creates the `VendorAccount` and `VendorCredential` that 29.2.1's "and initial
         *     shared portal account" requires - the credential carrying a registered recovery
         *     channel and a **null secret**. No session can be issued against it, because a vendor
         *     sign-in proves three factors and one of them does not exist yet.
         *
         *     **No administrator supplies the secret**, here or anywhere. It is set by
         *     the vendor from the setup grant that APPROVAL issues, not creation.
         *
         *     **The caller is recorded as `created_by` and cannot decide this record.** 35.12.2's
         *     exclusion is enforced at `decideVendorOrganization` and is checkable afterwards from
         *     the two actor fields the record carries.
         *
         *     **The allowance is not part of this act.** The organisation's `VendorAccountAllowance`
         *     is created `DISABLED_PREPAYMENT_ONLY` and only Platform Admin moves it (35.12.3).
         */
        post: operations["createVendorOrganization"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/vendor-organizations/{id}/decision": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Approve or reject operational activation
         * @description `vendor.organization.approve` - hub Senior Ops or Platform Admin, **own hub** (18.2,
         *     29.2.2). **One key carries both halves**, because 18.2 words the act as "approves or
         *     rejects" - the same shape `approveStaffIdentity` uses, and the reason no
         *     `vendor.organization.reject` key exists.
         *
         *     **The decider may not be the creator** (29.2.3, 35.12.2). Returns
         *     `SELF_APPROVAL_FORBIDDEN`, the same code every other same-actor exclusion returns:
         *     one uniform rule keeps one code (37.4, MSC-DEC-135).
         *
         *     **Approval issues exactly one `VENDOR_CREDENTIAL_SETUP` grant** to the account's
         *     registered recovery channel, resolved from the record and never from the request
         *     (state-machines.md 19.1). That grant is where vendor-authentication.md 5.1 begins.
         *
         *     **The approver chooses the delivery channel.** `delivery_channel` (`PHONE` or `EMAIL`) is required
         *     on approval and is stored on the vendor credential. It is the channel that grant, and every later
         *     credential-setup and recovery grant for the account, is delivered to; the vendor never supplies it.
         *
         *     **Delivery** (Gate PD-3R2, applying `PDA-54` to the one issuing operation that lacked it): the grant
         *     is handed to the delivery channel inside this operation, before it commits, and its raw token is
         *     never persisted. If the channel refuses it the operation is rolled back - no grant exists and the
         *     decision is not recorded - and the answer is `CREDENTIAL_DELIVERY_FAILED`; nothing was sent and the
         *     approver may decide again. Rejection issues no grant and cannot return it.
         *
         *     **Rejection is the same call with `approved: false` and a mandatory reason.** It is
         *     terminal and the record stays queryable (36.1). **Reapplication is a new
         *     `VendorOrganization`** (MSC-DEC-397; OQ-033 closed 21 September 2026) - no operation
         *     returns a `REJECTED` record to review, the rejection history stays on the rejected
         *     record, and linking a fresh application to it is duplicate detection's job.
         *
         *     **Approval does NOT enable the account allowance** (35.12.3, 36.12). Operational
         *     `ACTIVE` does not imply allowance `ENABLED`, and the two acts carry different keys
         *     with different scopes so that the separation is structural.
         */
        post: operations["decideVendorOrganization"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/vendor-organizations/{id}/allowance/enable": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Enable the account allowance for a vendor
         * @description `vendor.allowance.enable` - **Platform Admin only, all hubs** (29.2.4, 35.12.3). A
         *     separate decision from operational activation, by a different authority, which is why
         *     it is a separate operation on a separate key rather than a field on the decision above.
         *
         *     **A reason is mandatory** and **no probation threshold is evaluated.** 29.2.4 states
         *     that enabling follows "basic verification and with a recorded reason; no mandatory
         *     probation threshold applies" - the absence is decided, not missing, and an
         *     implementation that gated on elapsed time or completed orders would add a rule nobody
         *     approved.
         *
         *     **This sets a flag, not an amount.** The limit is one platform-wide figure,
         *     `global_vendor_account_limit_amount` (GH200, MSC-DEC-238), with no Version 1 override.
         *
         *     **The consequence is the commercial machine's, not this operation's.** 8 branches
         *     `PRICED -> CREDIT_RESERVED` on allowance enabled, account not OVERDUE and sufficient
         *     global exposure. This operation moves one of those three conditions.
         *
         *     **Basic verification is the recorded reason and nothing more** (MSC-DEC-397; OQ-033
         *     closed 21 September 2026): 29.2.4 names the verification and no contract carries an
         *     evidence set for it, by decision rather than by omission - the control is bounded by
         *     the GH200 near-prepay ceiling - so this operation records the reason and nothing more.
         */
        post: operations["enableVendorAllowance"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/vendor-organizations/{id}/allowance/disable": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Disable the account allowance for a vendor
         * @description `vendor.allowance.disable` - **Platform Admin only, all hubs** (29.2.5, 35.12.3), with
         *     a **mandatory reason**.
         *
         *     **Disablement is not retroactive, and 29.2.5 says so in its own words**: after
         *     disablement the prepayment gate applies to vendor-paid and split vendor portions
         *     calculated at itemization, "while existing confirmed itemized orders and outstanding
         *     obligations remain valid." Nothing here reprices, reverses or voids settled work -
         *     only orders priced after this transition meet the gate.
         *
         *     **A disabled allowance is not a suspension and not an OVERDUE status.** 35.12.8 names
         *     four distinct conditions and forbids collapsing them into one flag. This operation
         *     moves exactly one of the four.
         */
        post: operations["disableVendorAllowance"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/vendor-organizations/{id}/suspension": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Suspend a vendor, blocking the login and holding non-terminal work
         * @description `vendor.suspension.create` - hub Senior Ops at the vendor's responsible hub, or Platform
         *     Admin directly at any hub (29.6, MSC-DEC-168-169).
         *
         *     **The reason must cite one of FOUR grounds categories** and the set is fixed: non-payment
         *     or overdue beyond policy, suspected fraud or abuse, safety or legal violation, repeated
         *     service-quality failure. 29.6 calls them "four starting grounds categories" - starting,
         *     and still four. No fifth is created and none is widened by interpretation.
         *
         *     **Effects.** operational_status reaches SUSPENDED, VendorAccount.status reaches SUSPENDED,
         *     and every live Session terminates with reason SUSPENDED (domain-model.md 6.8, already
         *     specified and not restated). **One VendorSuspensionHold is created per non-terminal work
         *     item**, each recording where that item physically is - 29.6 requires that "the system must
         *     identify where each held item physically is", and a suspension that stopped the account
         *     without enumerating the parcels would lose custody of other people's goods.
         *
         *     **It charges, reverses and reprices nothing.** Outstanding obligations stay valid and
         *     payable, which is the same non-retroactivity 29.2.5 applies to allowance disablement.
         *
         *     **Terminal orders are not held.** A delivered parcel is history, and 29.6 preserves history
         *     rather than holding it.
         */
        post: operations["suspendVendor"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/vendor-organizations/{id}/suspension/lift": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Lift a suspension and resume every held item
         * @description `vendor.suspension.lift` - **symmetric or higher** (29.6, MSC-DEC-397). A suspension created
         *     by hub Senior Ops may be lifted by that hub's Senior Ops **or** by Platform Admin; a
         *     suspension created by Platform Admin may be lifted **only** by Platform Admin, returning
         *     `INSUFFICIENT_AUTHORITY` to anyone else.
         *
         *     **The asymmetry protects the case that matters.** The risk is a hub quietly undoing a
         *     Platform Admin fraud suspension. The routine case is "they paid, let them back", and routing
         *     that to Platform Admin would send a daily hub decision to the busiest authority in the
         *     product - the failure 11.4 warns about.
         *
         *     **Lifting resumes EVERY remaining HELD hold in one act**, moving each to RESUMED. No
         *     per-item resume decision is required, because 29.6 already says the hold persists "until
         *     reactivation or a disposition decision" - reactivation IS the resolution, and demanding a
         *     second decision per parcel would contradict the approved sentence.
         *
         *     **Effects.** operational_status returns to ACTIVE and VendorAccount.status to ACTIVE. **No
         *     session is issued** - the vendor signs in again normally. **The allowance is untouched**: it
         *     is a separate lifecycle with a separate authority (35.12.3), and a suspension never moved it.
         */
        post: operations["reactivateVendor"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/vendor-organizations/{id}/termination": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Terminate a suspended vendor whose holds are all resolved
         * @description `vendor.organization.terminate` - **Platform Admin only, all hubs** (29.6, MSC-DEC-397),
         *     with a mandatory reason and enhanced audit.
         *
         *     **Three preconditions, each closing a different hole.** The vendor must be **SUSPENDED** -
         *     which guarantees a reasoned suspension record and an enumerated parcel set behind every
         *     termination. **No VendorSuspensionHold may still be HELD** - you cannot end a relationship
         *     while holding someone's goods with no decision on them, which is the state 29.6 exists to
         *     prevent and would be perverse to reach through the act that closes the record. Both return
         *     `STATE_CONFLICT`. And Platform Admin only, because ending a platform-wide commercial
         *     relationship is not a single hub's call.
         *
         *     **Termination ends the relationship and the access, NOT the debt.** Outstanding obligations
         *     survive and stay payable; VendorBalance, statements and demands persist. **Settlement is not
         *     a precondition** - requiring it would give a defaulter a veto over their own termination,
         *     and the defaulting vendor is the main reason to terminate one.
         *
         *     **Retention of the terminated record is NOT decided here.** 29.6's offboarding retention is
         *     `OQ-028`'s, with the retention periods that need qualified legal input. Nothing is deleted
         *     by this operation.
         */
        post: operations["terminateVendor"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/vendor-suspension-holds/{id}/disposition": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Decide what happens to one held item
         * @description `vendor.held_parcel.decide` - hub Senior Ops or Platform Admin, **at the hub where the item
         *     physically is** (29.6, MSC-DEC-142). Reason mandatory, audit mandatory (35.12.9).
         *
         *     **RETURN_TO_VENDOR is absent from the enum, and that absence is the honest state of the
         *     contract rather than an omission.** 29.6 confirms it as a disposition and 29.6, MSC-DEC-171 fixes
         *     its fee, so it is approved policy - but `RETURNED_TO_VENDOR` is a terminal fulfilment
         *     outcome (16.1), and the **SIGNED** fulfilment machine at state-machines.md 9 has exactly
         *     one entry into RETURN_TO_VENDOR_IN_PROGRESS: from AT_HUB_AFTER_FAILURE. A suspended
         *     vendor's parcels sit in every non-terminal state, so for most held parcels there is no
         *     signed transition. Making the value unrepresentable keeps the gap a contract fact a check
         *     can see, instead of a runtime failure. See vendor-suspension.md 14.
         *
         *     **CONTINUE_HOLD has no expiry**, because 29.6 states that "no fixed maximum hold duration
         *     applies" - an indefinite hold is a legitimate steady state, not a gap.
         */
        post: operations["decideHeldParcelDisposition"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/vendor-suspension-holds/{id}/escalate": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Escalate a held item to a manual claims or security hold
         * @description `vendor.held_parcel.escalate` - **Platform Admin only, all hubs** (29.6, MSC-DEC-142), for
         *     cases neither continued hold nor return resolves. 29.6's examples are suspected fraud and
         *     an abandoned or undeliverable parcel.
         *
         *     The hold reaches **AUTHORIZED_EXCEPTION_DISPOSITION**, which is 36.12's named exit for a
         *     held work item that leaves the ordinary path.
         *
         *     **This escalates a PARCEL, and does not create a vendor-level SecurityRiskHold.** The two
         *     are different records at different grains, and `SecurityRiskHold` is written by
         *     `openSecurityRiskHold` and `clearSecurityRiskHold` (MSC-DEC-414, closing `OQ-128`).
         *     *Superseded:* it had no write authority anywhere in the repository.
         */
        post: operations["escalateHeldParcel"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/vendor-organizations/{id}/security-holds": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        /**
         * The security/risk holds recorded against one vendor
         * @description `vendor.read` **at all-Hub scope only** - data-scope-registry.md 4.3 restricts this record
         *     to all-Hub vendor.read and **denies the vendor its own row**. Ordinary Hub staff act on the
         *     OUTCOME through getVendorOperationalEligibility, which never discloses that a hold exists.
         *
         *     **This is how Platform Admin finds a hold to clear.** A record with a write and no read is
         *     the class MSC-DEC-406 and OQ-129 R1 removed twice; it is not repeated here.
         *
         *     **Paginated**. *Superseded shape:* a raw array, as MSC-DEC-414 first wrote it.
         */
        get: operations["listSecurityRiskHolds"];
        put?: never;
        /**
         * Platform Admin opens a vendor-level security/risk hold
         * @description `vendor.security_hold.manage` - **Platform Admin only**, all hubs.
         *     Performs state-machines.md 21's SIGNED `-> OPEN`. **A reason is mandatory** and the act is
         *     Enhanced-audited as vendor.security_hold.opened.
         *
         *     **An open hold stops NEW business and keeps work in flight.** While any hold on the vendor
         *     is OPEN, VendorOperationalEligibility's mayCreatePickup and mayConfirmVendorPaidOrder read
         *     false. **Parcels already moving continue to delivery and the vendor login is NOT blocked** -
         *     that is suspension's effect (35.12.7), and 35.12.8 requires the two to stay distinct.
         *     restrictionCategory never names the hold.
         *
         *     **Holds may coexist**: a second concern is a second record with its own reason.
         */
        post: operations["openSecurityRiskHold"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/security-holds/{id}/clear": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Platform Admin clears a security/risk hold
         * @description `vendor.security_hold.manage` - Platform Admin only. Performs state-machines.md 21's SIGNED
         *     `OPEN -> CLEARED`, with a mandatory reason, Enhanced-audited as
         *     vendor.security_hold.cleared. STATE_CONFLICT refuses a hold already CLEARED.
         *
         *     **The effect lifts only once no other hold on the vendor is OPEN**, and the record is kept.
         */
        post: operations["clearSecurityRiskHold"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/vendor-organizations/{id}/pickup-locations": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Save a pickup location for a vendor
         * @description `vendor.pickup_location.manage` - the Vendor on its own record, or Ops at the vendor's
         *     own hub. Both halves are approved: 29.1 makes this an internal Ops capability and 29.4
         *     gives the vendor it.
         *
         *     **The first location a vendor saves becomes the default.** A list whose default is
         *     unreachable by any available act is a state nobody can leave, so the rule is applied at
         *     creation rather than left to a second call.
         *
         *     **No serviceability check runs here.** 29.4 and 11.3 both place it at booking, and 11.3
         *     says "revalidated per request" - a check at save would let a location stored while a
         *     zone was served look permanently valid. pickup-request.md owns it.
         *
         *     **Saving a location changes nothing already booked.** The authoritative origin of a
         *     request is its own snapshotted resolved_pickup_location (3.7).
         */
        post: operations["createVendorPickupLocation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/vendor-pickup-locations/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Edit a saved pickup location
         * @description `vendor.pickup_location.manage` - own vendor for a Vendor, own hub for Ops.
         *
         *     **Editing does not rewrite a booked request.** A PickupRequest's
         *     resolved_pickup_location was snapshotted at booking (3.7), and 11.3 states the rule from
         *     the other side: per-request contact and location edits do not rewrite saved vendor
         *     locations, and the reverse holds too.
         *
         *     **The default is not set here** - setDefaultVendorPickupLocation is a separate act,
         *     because moving a default is a different decision from correcting an address.
         */
        patch: operations["updateVendorPickupLocation"];
        trace?: never;
    };
    "/vendor-pickup-locations/{id}/default": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Make this the vendor's one default pickup location
         * @description `vendor.pickup_location.manage` - own vendor for a Vendor, own hub for Ops.
         *
         *     **One act, both sides.** Setting a new default clears the previous one in the same
         *     operation, because 29.4 allows exactly one and two writes would leave a window with
         *     none or two.
         *
         *     **A deactivated location cannot become the default** - STATE_CONFLICT.
         *
         *     **This changes where a later booking sends a rider**, which is why it emits its own
         *     audit event naming both locations rather than reusing the update event.
         */
        post: operations["setDefaultVendorPickupLocation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/vendor-pickup-locations/{id}/deactivate": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Retire a saved pickup location, retaining it
         * @description `vendor.pickup_location.manage` - own vendor for a Vendor, own hub for Ops.
         *
         *     **Deactivation, not deletion** (domain-model.md 8). 34.7 requires a past request's
         *     origin to stay interpretable, so the record is retained and simply stops being
         *     selectable. There is no delete operation and none is planned.
         *
         *     **Retiring the default is refused while another active location exists** -
         *     STATE_CONFLICT, because 29.4 requires one. Set the new default first.
         *
         *     **Retiring the LAST active location is permitted.** A vendor may legitimately save
         *     none: COLLECT_FOR_VENDOR and per-request origins do not depend on the list.
         */
        post: operations["deactivateVendorPickupLocation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/vendors/{id}/operational-eligibility": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        /**
         * The safe operational yes/no for a vendor
         * @description `vendor.read` - MSC-DEC-339. A DERIVED projection. It has no row and is not a source of
         *     truth.
         *
         *     **It exists so Hub Ops can act without reading the restricted global control records.**
         *     Gate B's C1 restricted VendorAccountAllowance, VendorSuspensionHold and SecurityRiskHold
         *     to all-Hub vendor.read; this answers "may this vendor book today" without disclosing that
         *     a security hold exists, who raised it or why.
         *
         *     **A projection is safe precisely because it is lossy.** The four 35.12.8 conditions -
         *     operational suspension, OVERDUE status, allowance state, security/risk hold - are read
         *     SEPARATELY and never collapsed into one flag.
         *
         *     **Closes OQ-105.**
         */
        get: operations["getVendorOperationalEligibility"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/hubs/{id}/daily-operations-cash-report": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        /**
         * One hub-day's operations and money-flow report
         * @description `report.read` - THE EXISTING KEY (permissions.md 7), no new permission. **S** at `own hub`
         *     reads their own hub's day; **P**, **Finance** and **Executive** at `all hubs` read any
         *     hub's day, one hub at a time - the same scope split every other cross-hub read key
         *     already uses (payment.read, vendor.read). Ops Staff holds no grant for this key, by
         *     decision - MSC-DEC-393 closed OQ-124 on 17 September 2026 on the same
         *     segregation-of-duties reasoning that withholds payment.cash.confirm from a rider.
         *
         *     **Ops Portal only.** No `riderSession` - Melarc Rider has no assigned-stop or
         *     assigned-run reading of a whole hub's day, and no rider bundle holds report.read.
         *     Vendor holds no report.read grant either.
         *
         *     **A DERIVED projection, computed at read time** (domain-model.md 6.13,
         *     MSC-DEC-294's pattern). No row is stored, no accounting entry is created,
         *     and calling this twice recomputes rather than replays - there is nothing to replay,
         *     which is why this operation carries no Idempotency-Key.
         *
         *     **Never presents an open exception as a closed day** (MSC-DEC-325, 16.3).
         *     `unreconciledExceptionsOpen` is true whenever any RiderCashCustody is EXCEPTION_OPEN
         *     or the day's HubCashReconciliation is VARIANCE_OPEN.
         *
         *     **revenueByType is bounded to the five PaymentDemandLine.obligation_type values this
         *     contract models** - DELIVERY_FEE, REDELIVERY_DELIVERY_FEE, REDELIVERY_FEE,
         *     SINGLE_PACKAGE_PICKUP_FEE, RETURN_FEE - with DELIVERY_FEE further split by
         *     commercialMode, so Station Drop revenue is a breakout of an existing category rather
         *     than a category of its own (5.31, Accounting Pass 2). RETURN_FEE covers only the
         *     ad-hoc-sender settlement path (5.32, SLICE-006 Pass 1); a registered vendor's return
         *     fee raises no demand line and is not invented for this endpoint. OQ-123 is closed. The
         *     schema beneath states the same; the canonical ACCOUNTING export is a different
         *     artifact under the accounting-exports tag.
         */
        get: operations["getDailyOperationsCashReport"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/parcel-custody-returns": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Parcel custody returns in scope, filterable by state
         * @description `fleet.custody.read` - the hub's returns for Ops, the rider's own for a rider. Paginated,
         *     the envelope every list in this contract uses.
         *
         *     **The state filter is the operational visibility a declared-but-unconfirmed return needs.**
         *     A return sitting in DECLARED is one a rider has **named and no officer has checked**, so
         *     **no custody has moved and what the hub physically holds is still unknown** - the parcels
         *     may be on the counter, in the pannier, or nowhere (corrected at OQ-129 R1.1, which found
         *     this described as already handed over). 36.9 allows no rider overnight hold, so an ageing
         *     DECLARED return is precisely what a hub must be able to see.
         *
         *     **It does not see a run whose rider declared nothing at all.** No record exists to list, and
         *     detecting that absence needs a backstop this corpus does not have - carried on OQ-129 rather
         *     than invented here.
         */
        get: operations["listParcelCustodyReturns"];
        put?: never;
        /**
         * Rider declares the undelivered parcels coming back to the hub
         * @description `fleet.custody.return` - **the rider who holds the parcels**, on their own completed run.
         *
         *     **Custody, not assignment, is the test**, and both refusals are declared because they
         *     describe different people: `NOT_ASSIGNED_RIDER` for a rider with no relation to the run, and
         *     `NOT_CUSTODY_HOLDER` for one who had the parcels and no longer does. errors-and-enums.md
         *     keeps them apart for exactly this reason. **Today the two coincide on a delivery run**,
         *     because no delivery-run custody transfer exists - `RunCustodyHandover` is
         *     `PickupManifest`-scoped - so the holder is always the assigned rider. **The scope is written
         *     on custody anyway**, so that creating a delivery-run transfer later does not require
         *     rewriting this rule. It is the same correction MSC-DEC-404 made to submitHubHandover.
         *
         *     **Declaring is not transferring.** The return opens in DECLARED and **no custody moves and no
         *     order changes state**; that happens when the hub confirms, under a different key. A rider
         *     who could confirm their own return could close a run over parcels nobody counted - the
         *     separation AC-SLICE-003-16 already makes for cash.
         *
         *     **One open return per run** - STATE_CONFLICT on a second.
         *
         *     **Every undelivered order still aboard is named**, whatever state it is in. Only orders in
         *     ATTEMPT_FAILED move on confirmation, because 9 declares no transition for the others; a
         *     skipped or suspension-held parcel is carried on the record with its order state unchanged.
         *
         *
         *     **Each order must be on this run and at this hub** - `ORDER_NOT_ON_RUN` otherwise. The
         *     eligible set is the orders carrying a DeliveryStop on delivery_run_id whose stop is not
         *     DELIVERED, and the run's responsible_hub_id is the return's. A rider cannot hand back a
         *     parcel from another run, or to a hub that does not answer for it (34.9).
         */
        post: operations["openParcelCustodyReturn"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/parcel-custody-returns/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        /**
         * One parcel custody return, with its lines
         * @description `fleet.custody.read` - **Hub Ops, Senior Ops and Platform Admin at their own hub**, and **the
         *     rider on their own return**. Scoped server-side (37.6), never by a filter the caller
         *     supplies (42.4).
         *
         *     **This is how the confirming and resolving actors reach the record at all.** The rider opens
         *     it; a different actor confirms it and possibly a third resolves it.
         */
        get: operations["getParcelCustodyReturn"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/parcel-custody-returns/{id}/confirm": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Hub Ops confirms receipt, and custody transfers
         * @description `fleet.custody.receive` - Hub Ops at own hub, and **never a rider**: no rider bundle holds
         *     this key.
         *
         *     **confirmed_at records when Hub Ops made the physical comparison, and it is not by itself a
         *     custody instant** (OQ-129 R1.1). Every line the hub actually received moves to RECEIVED and
         *     transfers custody at confirmed_at; each such order in ATTEMPT_FAILED moves to
         *     AT_HUB_AFTER_FAILURE (state-machines.md 9), which is the transition whose guard - "custody
         *     returned to the responsible hub" - had no artifact behind it before MSC-DEC-408.
         *     **An OUT_FOR_DELIVERY order moves to the same state** where its stop is terminal and not
         *     DELIVERED - in practice SKIPPED - and **no live VendorSuspensionHold covers it**
         *     (MSC-DEC-411, closing OQ-143). **No attempt is consumed** and the skip is not
         *     retrospectively a physical attempt. **Where a hold does cover it, this operation moves
         *     physical custody only**: the hold's state and custody_location carry the fact, and an order
         *     already at RETURN_TO_VENDOR_IN_PROGRESS stays there - hub receipt changed where the parcel
         *     is, not what is to be done with it. **A MISSING
         *     line transfers no custody at all**, and one later dispositioned RECEIVED_LATE transfers at
         *     resolved_at. A confirmation that receives nothing still sets confirmed_at and moves nothing,
         *     which is why the record cannot carry one custody instant for all of its lines.
         *
         *     **A mismatch opens a variance rather than refusing.** A named parcel the hub cannot find is
         *     MISSING; one it holds that was not named is UNDECLARED; the return moves to VARIANCE_OPEN
         *     with a mandatory reason. **Custody still transfers for the lines actually received**, because
         *     a variance that moved all or nothing would either lose parcels the hub is holding or credit
         *     the rider with parcels nobody found.
         *
         *     **An undeclared id is held to the same eligibility rule as a declared one** (OQ-129 R1.1).
         *     Every received_order_ids entry the rider did not name must still carry a non-DELIVERED stop
         *     on this delivery_run_id, on a run whose responsible hub is the return's - ORDER_NOT_ON_RUN
         *     otherwise (domain-model.md 6.10). Confirmation is the second door into the line set, and
         *     the declaration path validates only what the rider named, so without this an order from
         *     another run or another hub enters the record unchecked.
         *
         *     **The order transition's actor is settled: it is the HUB's.** state-machines.md 12.2 is
         *     SIGNED (Product Owner, 25 September 2026, MSC-DEC-410), and the same act amended and
         *     re-signed 9's ATTEMPT_FAILED to AT_HUB_AFTER_FAILURE row, which had named the RIDER and
         *     guarded on "custody returned to the responsible hub". **It now names Hub Ops confirming
         *     this return** - or Hub Senior Ops on a RECEIVED_LATE disposition - and guards on the
         *     order's line reaching RECEIVED. **A rider's declaration moves no order state**, exactly as
         *     CashHandover 16.4 gives the confirmation to the hub.
         */
        post: operations["confirmParcelCustodyReturn"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/parcel-custody-returns/{id}/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Senior Ops dispositions a missing or undeclared parcel
         * @description `fleet.custody.variance_resolve` - Hub Senior Ops at own hub. INSUFFICIENT_AUTHORITY where
         *     the actor holds the key's domain but not the senior standing 12.2 requires.
         *
         *     **The variance is dispositioned, not erased** - MSC-DEC-321's rule for cash, applied to
         *     parcels. CLOSED records what was decided about each line and rewrites none of them.
         */
        post: operations["resolveParcelCustodyVariance"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/reason-definitions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The operational reason catalogue
         * @description `settings.reason.read` - MSC-DEC-330, MSC-DEC-361. Every reason a workflow may offer, with
         *     its attribution and the metadata that drives validation. Rider-holdable on an assigned stop
         *     or run: it reads active codes and their consequences, never a hub value and never an edit.
         *
         *     **Selecting a reason is not the authority to edit one.** A rider reads this catalogue and
         *     may never change what a code does.
         *
         *     **Filterable by domain and checkpoint** (MSC-DEC-407, closing OQ-138's engineering half).
         *     Until 24 September 2026 this operation took NO parameters, so a screen that had to offer
         *     the reasons valid at one checkpoint fetched the whole catalogue and filtered on a field
         *     that did not exist - rider-android.md families F and L both do exactly that. Both filters
         *     are ordinary narrowing of a read the caller is already entitled to: they change no scope,
         *     and 42.4's rule that filters are authorization-checked and never trusted applies unchanged.
         */
        get: operations["listReasonDefinitions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/reason-definitions/{code}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The stable reason code. Never reused after deactivation. */
                code: string;
            };
            cookie?: never;
        };
        get?: never;
        /**
         * Create or amend a reason definition
         * @description `settings.reason.manage` - MSC-DEC-330. Creates, edits, activates or deactivates a reason
         *     and its behaviour metadata.
         *
         *     **Deactivation never deletes** - history stays interpretable (35.9.1).
         *
         *     **Emits settings.reason.catalog_changed, enhanced.** Flipping consumes_delivery_attempt on
         *     a reason silently changes what every future delivery failure costs a customer, and it is
         *     the one edit that can rewrite policy without touching a document.
         *
         *     **21.5's four PICKUP-failure categories remain a closed enum** - 21.5 fixes them by
         *     specification and no decision has widened them.
         *
         *     **The DELIVERY set is different**. Its five reasons are SEEDED DEFAULTS in this
         *     catalogue, and an approved operational reason may be added through this operation.
         *     MSC-DEC-330 recorded them as closed; that reading was narrower than the rule approved.
         */
        put: operations["upsertReasonDefinition"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/accounting-exports": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Accounting exports in scope
         * @description `payment.ledger.read` — Finance, all hubs, the **read** key of the pair
         *     (permissions.md v1.39). **Filterable by `scope`, `hub_id`, period and `status`.**
         *
         *     **METADATA ONLY.** This returns `AccountingExport` records — scope, period, schema
         *     version, status, requester, row counts, manifest digest and `file_available_until`. It
         *     returns **no package, no row, no payment fact and no `storage_ref`**, and it confers no
         *     retrieval authority: a package is reached only through
         *     `createAccountingExportRetrievalAuthorization`, one object at a time.
         *
         *     **Paginated.** One record per requested period per scope accumulates without bound over
         *     the platform's lifetime, and a re-run is a new record rather than an update — so the
         *     set only grows.
         */
        get: operations["listAccountingExports"];
        put?: never;
        /**
         * Request a canonical accounting export for a closed period
         * @description `payment.ledger.export` — Finance, all hubs. **Creates an
         *     `AccountingExport` in `REQUESTED` and nothing else.** No accounting entry is made and no
         *     money moves: Melarc runs no ledger, which is exactly why the extract it hands to a
         *     system that does has to be canonical.
         *
         *     **GENERATION HAS TWO INDEPENDENT READINESS GATES, AND EACH REFUSES WITH ITS OWN NAMED
         *     CODE.** A caller must be able to tell *why* generation is unavailable, so one shared
         *     code would be worse than useless — the two resolve at different times and against
         *     different work.
         *
         *     1. **`EXPORT_RETENTION_NOT_CONFIGURED`** while `accounting_export_file_retention_days`
         *        holds no value. `file_available_until` cannot be computed without it, and
         *        generating a package with an undefined lifetime puts a file into the world with no
         *        stated expiry. **The format, the schemas, the entity and these four operations are
         *        fully specified regardless** — it is production generation that waits on the figure,
         *        the same shape `MSC-DEC-328` used when `recipient_cash_enabled` shipped Off.
         *
         *     2. **`EXPORT_SOURCE_NOT_EVENT_COMPLETE`** while **any** canonical source record type is
         *        `CREATION_ONLY`. **A package that cannot carry a `PaymentReceipt`
         *        reversal is not a canonical accounting export, however clearly its manifest declares
         *        the gap.** Eight of the twelve record types are `CREATION_ONLY` today, so this gate
         *        is closed; it opens when every required type is `EVENT_COMPLETE`, which is
         *        `SLICE-004` Pass 4's work and not this contract's.
         *
         *     **`PERIOD_NOT_RECONCILED` — canonical exports are final-period only.** Every day in
         *     `period_from`..`period_to` must have a **closed** `HubCashReconciliation`.
         *     An open hub-day's figures are still moving, and an export of a moving
         *     figure is a number two systems will later disagree about.
         *
         *     **IDEMPOTENT ON (scope, hub, period, schema version) WHILE A `REQUESTED` RECORD
         *     EXISTS.** A retried request matching an outstanding one **returns that record** and
         *     **does not queue a second package**. This is a natural-key rule, not an
         *     `Idempotency-Key` one: two officers who independently ask for August for the same hub
         *     are not two exports, and the duplicate would be discovered only as two manifests with
         *     two digests for one period.
         *
         *     **A completed export is never regenerated in place.** Once a record leaves `REQUESTED`
         *     the same tuple may be requested again, and **that is a new record with its own
         *     manifest digest** — §5.5's rule that a fact is never rewritten and a correction is a
         *     new record. There is deliberately no `REGENERATING` state and no path back to
         *     `REQUESTED` (state-machines.md §20.7, **no machine**).
         *
         *     **Emits `payment.ledger.exported` on generation, Enhanced** — §38.5 category 8, *"data
         *     exports and destructive retention actions"*. The event carries requester, scope, period
         *     range, schema version, per-record-type row counts and manifest digest. It is **the
         *     event that says payment facts left the platform**.
         */
        post: operations["requestAccountingExport"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/accounting-exports/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        /**
         * One accounting export, readable after its file is gone
         * @description `payment.ledger.read` — `MSC-DEC-401`, permissions.md v1.39. **Reading the record is not
         *     reaching the package**: this key confers no retrieval authority whatever, and the only
         *     route to bytes is `payment.ledger.export` through
         *     `createAccountingExportRetrievalAuthorization`.
         *
         *     **THIS RETURNS METADATA, ROW COUNTS AND MANIFEST DIGEST EVEN AFTER
         *     `file_available_until` HAS PASSED.** **The record is permanent; only the file
         *     expires.** `manifest_digest` and `row_counts` outlive the package deliberately, so the
         *     fact that an export happened — and what it contained — stays answerable when the bytes
         *     are gone. An expired export is **not** a 404 and **not** a `FAILED` record: it is a
         *     `GENERATED` record whose `file_available_until` is in the past, which a caller
         *     determines **by comparison**.
         *
         *     **File availability is not a status, and that is a decision rather than an omission**
         *     (plan §9). Adding a fourth value to `AccountingExportStatus` would make the passage of
         *     time look like a transition somebody took, and state-machines.md §20.7's test is
         *     precisely that no transition after creation is any actor's decision.
         *
         *     **No `storage_ref`, here as everywhere.** Returning it would hand a client the address
         *     to construct its own retrieval and bypass the authorization entirely.
         */
        get: operations["getAccountingExport"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/accounting-exports/{id}/retrieval-authorizations": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Obtain a short-lived, single-object retrieval authorization over a package
         * @description **This mirrors `createEvidenceRetrievalAuthorization` deliberately and completely**
         *     (§7.6). It is the repository's established shape for handing out a stored object, and a
         *     payment-ledger package is not the place to invent a second one.
         *
         *     **The order of checks is the operation**: authenticate, verify
         *     `payment.ledger.export`, execute principal-specific RLS, confirm the record is
         *     `GENERATED`, confirm `file_available_until` has not passed, and only then issue the
         *     capability. A record in `REQUESTED` or `FAILED` returns `STATE_CONFLICT` — there is no
         *     package to authorize. Past `file_available_until` it returns **`EXPORT_FILE_EXPIRED`**,
         *     deterministically, rather than an authorization over an absent object;
         *     `getAccountingExport` still answers for the export itself.
         *
         *     **THIS IS NOT A DOWNLOAD OPERATION.** It streams nothing and returns no package bytes.
         *     Private means authorization-private, not network-unreachable: the object endpoint may
         *     be Internet-reachable for a cryptographically valid, short-lived, single-object signed
         *     operation — that is what makes a presigned URL work, and what makes it safe is that the
         *     platform issued it after checking permission and it grants exactly one object for a few
         *     minutes. **There is no anonymous read, no listing, no public ACL and no permanent URL.**
         *
         *     **Five minutes** — `accounting_export_retrieval_authorization_ttl_minutes`
         *     (settings.md v1.38). It matches `evidence_retrieval_authorization_ttl_minutes`
         *     because the capability is regenerable and **a payment-ledger package is
         *     at least as sensitive as a single `Evidence` object**, so it earns no longer bearer
         *     lifetime than evidence's five minutes.
         *
         *     **The response is transient and is never logged.** No storage credential, no listing
         *     authority, no usable `storage_ref`, no permanent URL. `Cache-Control: no-store`.
         *
         *     **Emits `payment.ledger.export_retrieval_authorized`, Enhanced** — §38.5 category 8.
         *     **The event is named for what Melarc can observe**: the object is fetched from storage
         *     under the presigned authorization, so the platform records the capability it issued and
         *     **never the download that follows**. Calling it `accessed` would certify a fact nobody
         *     holds. The signed URL itself is never logged (audit.md §9).
         */
        post: operations["createAccountingExportRetrievalAuthorization"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /** @description One commitment state for an order. APPEND-ONLY: a row is never updated except to set supersededAt. The current commitment is the row with no supersededAt. */
        DeliveryCommitment: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            orderId: string;
            /** @description 1 for the original commitment */
            sequence: number;
            /**
             * Format: date
             * @description The calculated service date. Carried forward unchanged on every revision - it answers what ordinary service would have produced, and recomputing it destroys that.
             */
            defaultDate: string;
            /**
             * Format: date
             * @description What the sender or recipient asked for.
             */
            requestedDate?: string | null;
            /**
             * Format: date
             * @description What Melarc promised
             */
            committedDate: string;
            /** @example 10:00 */
            committedWindowStart?: string | null;
            /** @example 16:00 */
            committedWindowEnd?: string | null;
            /** @description Mandatory from sequence 2 onward. A CommitmentChangeReason. */
            changeReasonCode?: string | null;
            /** @enum {string|null} */
            requestedByParty?: "SENDER" | "RECIPIENT" | "MELARC" | "SYSTEM" | null;
            /** Format: uuid */
            approvedByStaffId?: string | null;
            /**
             * Format: date-time
             * @description Pickup custody, not hub arrival. Internal delay after pickup does not move it.
             */
            slaStartAt: string;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            supersededAt?: string | null;
        };
        DeliveryCommitmentRevision: {
            /** Format: date */
            committedDate: string;
            committedWindowStart?: string | null;
            committedWindowEnd?: string | null;
            /** Format: date */
            requestedDate?: string | null;
            /** @description Mandatory. CUSTOMER_DEFERRED, SENDER_SCHEDULED, CORRIDOR_SCHEDULE or MELARC_DELAY. Without it the revision is refused - the same change means opposite things depending on cause. */
            changeReasonCode: string;
            /** @enum {string} */
            requestedByParty: "SENDER" | "RECIPIENT" | "MELARC" | "SYSTEM";
            note?: string | null;
        };
        ServiceWindowOverride: {
            /** @example 08:30 */
            revisedWindowStart: string;
            /** @example 10:00 */
            revisedWindowEnd: string;
            /** Format: date */
            revisedDate?: string | null;
            /** @description Mandatory */
            reasonCode: string;
            /** @description The customer notification state at the time of the override. */
            customerNotified: boolean;
            note?: string | null;
        };
        /** @description A transport-safety judgement, never a pricing outcome. No kilogram or dimension threshold exists. */
        ParcelHandlingAssessment: {
            /** @enum {string} */
            assessment: "STANDARD_HANDLING" | "REQUIRES_REVIEW" | "NOT_ACCEPTABLE";
            /** @description Mandatory for REQUIRES_REVIEW and NOT_ACCEPTABLE. */
            reasonCode?: string | null;
            note?: string | null;
            /** Format: date-time */
            readonly assessedAt?: string;
        };
        /** @description The rider-side REQUEST only. It authorises nothing; the grant is authoriseDeliveryWithoutOtp under delivery.otp.override. */
        VerificationFallbackRequest: {
            failureReasonCode: string;
            recipientPresent: boolean;
            attemptsMade?: number;
            note?: string | null;
            /** @enum {string} */
            readonly status?: "REQUESTED" | "GRANTED" | "REFUSED";
        };
        /** @description Out-of-band confirmation of a Merchant MoMo receipt. A screenshot is not proof; the confirming actor is recorded and is never the rider. */
        ManualPaymentConfirmation: {
            amountMinor: number;
            /** @enum {string} */
            method: "MERCHANT_MOMO" | "OPS_ASSISTED";
            /**
             * Format: uuid
             * @description REQUIRED where a provider attempt is unresolved. The grant must be ACTIVE, name this demand and that attempt, and authorise MERCHANT_MOMO. A successful confirmation CONSUMES it - it cannot settle a second payment.
             */
            fallback_authorization_id?: string;
            /** @description The transaction reference actually verified */
            providerReference: string;
            /** Format: uuid */
            readonly confirmedByStaffId?: string;
            /** Format: date-time */
            readonly confirmedAt?: string;
        };
        RoadExpense: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            riderId: string;
            /** Format: uuid */
            deliveryRunId?: string | null;
            /** Format: uuid */
            motorcycleId?: string | null;
            /** Format: uuid */
            responsibleHubId?: string;
            /** @description From the configurable catalogue */
            categoryCode: string;
            amountMinor: number;
            /**
             * @description Never mixed. Only an approved, eligible COLLECTION_CASH expense ACTUALLY APPLIED to a handover reduces that handover's expected cash - approval alone reduces nothing. RIDER_PERSONAL records a reimbursement obligation and COMPANY_FLOAT reconciles against the float.
             * @enum {string}
             */
            fundingSource: "COLLECTION_CASH" | "RIDER_PERSONAL" | "COMPANY_FLOAT";
            description?: string;
            /** Format: uuid */
            evidenceId?: string | null;
            /** @enum {string} */
            status: "CLAIMED" | "APPROVED" | "REJECTED";
            /** Format: uuid */
            decidedByStaffId?: string | null;
            decisionReasonCode?: string | null;
            /**
             * Format: uuid
             * @description The one handover this expense reduced, or null while unapplied. Write-once per expense and immutable once set. NOT unique across expenses - many expenses may name one handover.
             */
            readonly appliedToCashHandoverId?: string | null;
            /**
             * Format: date-time
             * @description When this expense was applied. APPROVAL made it eligible; application is what reduced expected cash, and the two are different events at different times.
             */
            readonly appliedAt?: string | null;
            /** Format: date-time */
            incurredAt?: string;
            /** Format: date-time */
            createdAt?: string;
            /** Format: date-time */
            decidedAt?: string | null;
        };
        RoadExpenseCreate: {
            /** Format: uuid */
            deliveryRunId?: string | null;
            /** Format: uuid */
            motorcycleId?: string | null;
            categoryCode: string;
            amountMinor: number;
            /** @enum {string} */
            fundingSource: "COLLECTION_CASH" | "RIDER_PERSONAL" | "COMPANY_FLOAT";
            description: string;
            /** Format: uuid */
            evidenceId?: string | null;
            /** Format: date-time */
            incurredAt: string;
        };
        RoadExpenseDecision: {
            /** @enum {string} */
            decision: "APPROVED" | "REJECTED";
            /** @description Mandatory on REJECTED */
            reasonCode?: string | null;
            note?: string | null;
        };
        /** @description Two reconciliations, deliberately separate. Collapsing them reports a GH300 shortfall against a rider who is not short by a pesewa. */
        RunCashSummary: {
            /** Format: uuid */
            runId: string;
            /** @description Did every completed delivery receive what it was owed? */
            customerPayment: {
                expectedMinor: number;
                /** @description Only where Melarc CONFIRMED receipt */
                confirmedDigitalMinor: number;
                confirmedFallbackMinor?: number;
                /** @description Gross recipient cash. Never rewritten by an expense */
                grossCashMinor: number;
                totalAccountedMinor: number;
                varianceMinor: number;
            };
            /** @description What cash physically entered rider possession, and where did it go? */
            cashCustody: {
                grossCashMinor: number;
                /** @description APPROVED and eligible COLLECTION_CASH road expenses for this run. ELIGIBILITY, not a deduction: an expense here may already have been applied to an earlier handover, and deducting it again would charge the rider twice for one tank of fuel. */
                approvedCollectionCashExpenseMinor: number;
                /** @description Total APPLIED to the handover being reconciled - the figure that actually reduces expected cash. Equal to the approved total only when every eligible expense has been applied here. */
                appliedCollectionCashExpenseMinor: number;
                /** @description grossCashMinor minus appliedCollectionCashExpenseMinor (MSC-DEC-316, as corrected at Gate C R1.2). NEVER computed from the approved total. */
                expectedHandoverMinor: number;
                declaredMinor?: number | null;
                countedMinor?: number | null;
                varianceMinor?: number | null;
            };
            /** @description Per-order reconciliation. A run total can be right while both orders are wrong, and an aggregate nets one order's shortfall against another's excess. */
            orders: {
                /** Format: uuid */
                orderId?: string;
                requiredMinor?: number;
                allocatedMinor?: number;
                settlementStatus?: string;
                paymentMethods?: string[];
            }[];
        };
        HubCashReconciliation: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            hubId: string;
            /** Format: date */
            businessDate: string;
            openingPositionMinor?: number;
            /** @description Never edited to match the count. */
            expectedMinor: number;
            countedMinor?: number | null;
            /** @description Counted minus expected. Signed - a negative value is a shortage. */
            varianceMinor?: number | null;
            /** @enum {string} */
            state: "OPEN" | "COUNTED" | "RECONCILED" | "VARIANCE_OPEN";
            varianceReasonCode?: string | null;
            /** Format: uuid */
            reconciledByStaffId?: string | null;
            /** Format: date-time */
            openedAt?: string;
            /** Format: date-time */
            closedAt?: string | null;
        };
        HubCashCount: {
            /** Format: date */
            businessDate: string;
            countedMinor: number;
            /** @description Mandatory where the count differs from the expected position. */
            varianceReasonCode?: string | null;
            note?: string | null;
        };
        /** @description The last custody transfer, and the one nobody naturally records. Creates no accounting entry. */
        CashDisposition: {
            /** Format: uuid */
            readonly id?: string;
            /** Format: uuid */
            readonly hubCashReconciliationId?: string;
            amountMinor: number;
            /** @enum {string} */
            method: "BANK_DEPOSIT" | "MERCHANT_MOMO_TRANSFER" | "FINANCE_HANDOVER" | "SAFE_CUSTODY";
            destination: string;
            /** @description Mandatory for BANK_DEPOSIT and MERCHANT_MOMO_TRANSFER. */
            reference?: string | null;
            /** Format: uuid */
            evidenceId?: string | null;
            /** Format: uuid */
            readonly recordedByStaffId?: string;
            /** Format: date-time */
            readonly recordedAt?: string;
        };
        /**
         * @description **No secret field, and no status field.** The vendor sets its own secret from the
         *     grant APPROVAL issues, and the record's status is `PENDING_SENIOR_OPS_REVIEW`
         *     by construction - accepting either would let the creating actor hand itself an active
         *     vendor.
         *
         *     **At least one of `recovery_phone` / `recovery_email` is required** - it is the channel
         *     the setup grant is delivered to, and an account with no channel can never be activated.
         *     The business `contact_*` pair is deliberately separate: a business contact is not an
         *     authentication channel.
         */
        VendorOrganizationCreate: {
            /** Format: uuid */
            responsible_hub_id: string;
            legal_name: string;
            trading_name?: string;
            contact_phone?: string;
            contact_email?: string;
            recovery_phone?: string;
            recovery_email?: string;
        };
        /**
         * @description Entity at domain-model.md 6.16.
         *
         *     **`SUSPENDED` and `TERMINATED` are reached by `suspendVendor`, `reactivateVendor` and
         *     `terminateVendor`** (MSC-DEC-397; OQ-033 closed 21 September 2026): suspension by hub
         *     Senior Ops or Platform Admin, reactivation symmetric or higher, termination by Platform
         *     Admin from `SUSPENDED` only with no hold still `HELD`. **The machine itself is still
         *     untabled** - state-machines.md 14 holds `VendorOrganization` as state sets only, so
         *     three live operations drive transitions no signed table describes. That is OQ-132,
         *     owed by SLICE-008 and closing on a 36.13 signature. *Superseded reading:* declared and
         *     reachable by no operation here, exits and entries being OQ-033's - true until SLICE-008
         *     Pass 2, and carried here for two days after.
         *
         *     **Both actor fields are returned together on purpose.** 35.12.2's exclusion is enforced
         *     at the call, and an enforcement that leaves no queryable record is unfalsifiable
         *     afterwards - the same reasoning audit.md 5.6 records for `staff.identity.approved`.
         */
        VendorOrganization: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            responsible_hub_id: string;
            legal_name: string;
            trading_name?: string | null;
            contact_phone?: string | null;
            contact_email?: string | null;
            /** @enum {string} */
            operational_status: "CREATED_BY_OPS" | "PENDING_SENIOR_OPS_REVIEW" | "ACTIVE" | "REJECTED" | "SUSPENDED" | "TERMINATED";
            /** Format: uuid */
            created_by: string;
            /** Format: date-time */
            created_at: string;
            /** Format: uuid */
            decided_by?: string | null;
            /** Format: date-time */
            decided_at?: string | null;
            decision_reason?: string | null;
        };
        /**
         * @description One schema for both halves of 18.2's "approves or rejects", the same shape
         *     `StaffIdentityApproval` uses. A separate rejection operation would need a separate
         *     permission key for one decision.
         */
        VendorOrganizationDecision: {
            approved: boolean;
            /** @description Mandatory when `approved` is false (29.2.5). Optional on approval. */
            reason?: string;
            /**
             * @description Chosen by the approver at approval, and **required when `approved` is true**: which of the
             *     account's recovery channels (`recovery_phone`, `recovery_email`) the setup grant, and every
             *     later credential-setup and recovery grant for the account, is delivered to. It is stored on
             *     the vendor credential and never supplied by the vendor. A rejection issues no grant and
             *     needs none.
             * @enum {string}
             */
            delivery_channel?: "PHONE" | "EMAIL";
        };
        /**
         * @description **A reason and nothing else.** No amount - the limit is one platform-wide figure,
         *     `global_vendor_account_limit_amount` (GH200, MSC-DEC-238), and a per-vendor amount here
         *     would make an override representable that 29.2.4 does not grant. No target state -
         *     the operation's own path fixes the direction, so a body that disagreed with the path
         *     could not exist. No evidence reference: 29.2.4's "basic verification" names no evidence
         *     set in any contract, and MSC-DEC-397 settled that it is the recorded reason and nothing
         *     more (OQ-033 closed) - not this schema's to invent.
         */
        VendorAllowanceDecision: {
            reason: string;
        };
        /**
         * @description Entity at domain-model.md 6.16. Exactly one per organisation, created with it in
         *     `DISABLED_PREPAYMENT_ONLY` so that "no decision yet" and "deliberately disabled" are
         *     the same safe state rather than a null nobody interprets.
         *
         *     **This records the decision and does not enforce the consequence** - state-machines.md
         *     8 branches `PRICED -> CREDIT_RESERVED` on allowance enabled, not OVERDUE and sufficient
         *     global exposure, and restating that here would create a second place for it to be wrong.
         */
        VendorAccountAllowance: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            vendor_organization_id: string;
            /** @enum {string} */
            state: "DISABLED_PREPAYMENT_ONLY" | "ENABLED";
            /** Format: uuid */
            decided_by?: string | null;
            /** Format: date-time */
            decided_at?: string | null;
            reason?: string | null;
        };
        /**
         * @description **Four grounds and a reason, and the enum is closed.** 29.6 fixes the categories
         *     (29.6, MSC-DEC-168-169) and calls them "four starting grounds categories" - starting, and still
         *     four. A free-text grounds field would let a fifth arrive without a decision.
         *
         *     **The reason is separate from the grounds and both are required.** The category is what an
         *     auditor filters on; the reason is what a reviewer reads.
         */
        VendorSuspension: {
            /** @enum {string} */
            grounds: "NON_PAYMENT_OVERDUE" | "SUSPECTED_FRAUD_OR_ABUSE" | "SAFETY_OR_LEGAL_VIOLATION" | "REPEATED_SERVICE_QUALITY_FAILURE";
            reason: string;
        };
        /**
         * @description **A reason and nothing else.** No per-item selection: reactivation resumes EVERY remaining
         *     HELD hold in one act, because 29.6 already makes reactivation the resolution
         *     of a hold. Accepting a subset here would quietly create the per-item resume decision that
         *     decision rejected.
         */
        VendorReactivation: {
            reason: string;
        };
        /**
         * @description **A reason and nothing else.** No settlement flag and no write-off field: obligations
         *     survive termination and stay payable, so there is nothing here to close them
         *     with. No retention period either - that is `OQ-028`'s, awaiting legal input.
         */
        VendorTermination: {
            reason: string;
        };
        /**
         * @description Scoped to the order's responsible_hub_id - AUTHORITY, not custody (29.6, MSC-DEC-142).
         *     **The disposition may be decided while the parcel is still with a rider**, and deciding it
         *     asserts no hub possession and rewrites no custody: custody_location keeps recording the
         *     truth until a later custody-transfer event. **For the end-of-run rider-to-hub return that
         *     event now exists** - ParcelCustodyReturn (domain-model.md 6.10, machine at
         *     state-machines.md 12.2), where the HUB's confirmation moves custody, not the rider's
         *     declaration. **OQ-129 stays open for two things that are not this gap**: 12.2 carries no
         *     signature, and a run whose rider declares nothing at all still produces no record for any
         *     filter to find. *Superseded reading, corrected at OQ-129 R1.2:* "which is OQ-129's artifact
         *     gap".
         *     Where the order is OUT_FOR_DELIVERY the stop follows state-machines.md 12.1's SIGNED
         *     SKIPPED semantics - recipient delivery terminated for that stop, no attempt consumed, not
         *     recorded as returned, no recipient handover.
         *     A RETURN_TO_VENDOR closes through
         *     return-to-vendor.md's OTP-gated handover, unchanged - what 29.6 means by "reusing the
         *     Section 28.4 OTP-based closure". **CONTINUE_HOLD sets no expiry**:
         *     29.6 states that no fixed maximum hold duration applies.
         */
        HeldParcelDisposition: {
            /**
             * @description RETURN_TO_VENDOR became representable on 21 September 2026, when state-machines.md 9 gained the suspension route into RETURN_TO_VENDOR_IN_PROGRESS from the six non-terminal states that are not AT_HUB_AFTER_FAILURE (9.1). Until then it was confirmed policy (29.6, MSC-DEC-142) this contract could not express, held out of the enum so the gap stayed a contract fact rather than a runtime failure. THAT AMENDMENT WAS RE-SIGNED on 21 September 2026: 1.1 records the cost it carried while it was not - every dependant of 9 was barred from READY - and that bar is lifted. (Corrected at OQ-129 R1.2, which found this description still awaiting a signature given four days earlier.) The value is carried here because a transition nothing can trigger is the other half of the same inconsistency. It commits a ReturnRecord with originating_delivery_stop_id NULL and the same flat return fee as any other return (29.6, MSC-DEC-171) - no cause-based carve-out.
             * @enum {string}
             */
            outcome: "CONTINUE_HOLD" | "RETURN_TO_VENDOR";
            reason: string;
        };
        /**
         * @description Platform Admin only. Escalates **a parcel** to a manual claims or security hold and does not
         *     create a vendor-level `SecurityRiskHold`, which `openSecurityRiskHold` and
         *     `clearSecurityRiskHold` write (MSC-DEC-414, closing `OQ-128`).
         */
        HeldParcelEscalation: {
            reason: string;
        };
        /**
         * @description Entity at domain-model.md 6.17. **One row per held non-terminal work item**, not one per
         *     suspension - 36.12's machine is titled "Vendor work during suspension" and its subject is
         *     NON_TERMINAL_WORK, and 29.6 requires the system to identify where EACH held item physically
         *     is. See 6.17 for why that reading wins over data-scope-registry.md 4.3's prose.
         */
        VendorSuspensionHold: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            vendor_organization_id: string;
            /** Format: uuid */
            order_id: string;
            /**
             * Format: uuid
             * @description The hub ACCOUNTABLE for this item, derived from the order and immutable - the same meaning the term carries on Evidence, DeliveryCommitment and RoadExpense. Fixes the scope of the disposition. It does NOT say where the parcel is; custody_location does.
             */
            responsible_hub_id: string;
            /** @description Where the item ACTUALLY is, and the only field that says so - a shelf, a bay, or "with rider on run R". Null means the responsible hub holds it with no finer location recorded. 29.6's "identify where each held item physically is" is satisfied here, not by responsible_hub_id. */
            custody_location?: string | null;
            /** @enum {string} */
            state: "HELD" | "RESUMED" | "AUTHORIZED_EXCEPTION_DISPOSITION";
            /** @enum {string} */
            grounds: "NON_PAYMENT_OVERDUE" | "SUSPECTED_FRAUD_OR_ABUSE" | "SAFETY_OR_LEGAL_VIOLATION" | "REPEATED_SERVICE_QUALITY_FAILURE";
            reason?: string;
            /** Format: uuid */
            created_by: string;
            /** Format: date-time */
            created_at: string;
            /** Format: uuid */
            decided_by?: string | null;
            /** Format: date-time */
            decided_at?: string | null;
            decision_reason?: string | null;
        };
        /**
         * @description **No is_default field, and the omission is the rule.** The FIRST location a vendor saves
         *     becomes the default automatically; every later one does not, and moving it is
         *     setDefaultVendorPickupLocation's job. Accepting a flag here would let a create silently
         *     demote the existing default.
         *
         *     **No active field** - a created location is active. **No vendor id** either: for a
         *     Vendor it is the session's own, and for Ops it is the path.
         */
        VendorPickupLocationCreate: {
            label: string;
            location: components["schemas"]["Location"];
        };
        /**
         * @description Label, address, or both. **Neither is_default nor active is editable here** - each has
         *     its own operation, because moving a default and retiring a location are decisions of a
         *     different kind from correcting an address, and 29.4's one-default rule needs an act
         *     that clears the previous holder in the same transaction.
         */
        VendorPickupLocationUpdate: {
            label?: string;
            location?: components["schemas"]["Location"];
        };
        /**
         * @description Entity at domain-model.md 6.18.
         *
         *     **Exactly one active location per vendor has is_default true**, or none where the vendor
         *     has no active location. `is_default` is never null: a tri-state would make "no default"
         *     and "not the default" the same value.
         *
         *     **This is an input at booking and never the authoritative origin.** That is
         *     PickupRequest.resolved_pickup_location, snapshotted at booking (3.7), which is why
         *     editing or retiring a location changes nothing already booked.
         */
        VendorPickupLocation: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            vendor_organization_id: string;
            label: string;
            location: components["schemas"]["Location"];
            is_default: boolean;
            active: boolean;
            /** Format: uuid */
            created_by?: string;
            /** Format: date-time */
            created_at?: string;
            /** Format: uuid */
            updated_by?: string | null;
            /** Format: date-time */
            updated_at?: string | null;
        };
        /** @description DERIVED and computed at read time. Not a source of truth, not persisted. Persisting it would create a second truth able to disagree with the four 35.12.8 conditions it summarises, invisibly. */
        VendorOperationalEligibility: {
            /** Format: uuid */
            vendorOrganizationId: string;
            mayCreatePickup: boolean;
            mayConfirmVendorPaidOrder?: boolean;
            requiresPrepayment: boolean;
            recipientPaidOrdersAllowed?: boolean;
            /** @description An approved HIGH-LEVEL category, only where disclosure is allowed. It never discloses that a security hold exists, who raised it or why. */
            restrictionCategory?: string | null;
            /** Format: date-time */
            effectiveAt: string;
        };
        /** @description DERIVED and computed at read time (domain-model.md 6.13, MSC-DEC-294's pattern). Not a source of truth, not persisted, creates no accounting entry. Every figure is read from an already-APPROVED entity at 6.11/6.12 - this schema adds no state of its own. */
        DailyOperationsCashReport: {
            /** Format: uuid */
            hubId: string;
            /** Format: date */
            businessDate: string;
            /**
             * Format: date-time
             * @description When this projection was computed. Not a stored fact - recomputed on every read.
             */
            generatedAt: string;
            /** @description True whenever ANY RiderCashCustody for this hub-day is EXCEPTION_OPEN or the day's HubCashReconciliation is VARIANCE_OPEN (MSC-DEC-325, spec 16.3). A day is never presented as clean while either is true. */
            unreconciledExceptionsOpen: boolean;
            operations: {
                /** @description PickupIntake reaching COUNTED or later today (domain-model.md 6.6). */
                packagesReceivedCount: number;
                /** @description DeliveryStop terminal outcomes today (domain-model.md 6.10). */
                deliveryAttemptsCount: number;
                /** @description DeliveryStop.state = DELIVERED today. */
                successfulDeliveriesCount: number;
                /** @description Order.commercial_mode = STATION_DROP reaching its terminal handoff today. */
                stationDropsCount: number;
                /** @description Order.commercial_mode = MELARC_COVERED_THIRD_PARTY_DELIVERY dispatched today. */
                thirdPartyDispatchesCount: number;
                /** @description Order.fulfilment_state = AT_HUB_AFTER_FAILURE - undecided. */
                failedDeliveriesAwaitingReviewCount: number;
                /** @description ReturnRecord not yet formally initiated. */
                returnsAwaitingReviewCount: number;
                /** @description Custody with no scheduled onward movement today. */
                heldAtHubCount: number;
                /** @description delivery.commitment.breached events emitted today (sweep_missed_commitments). */
                missedCommitmentsCount: number;
            };
            moneyFlow: {
                /** @description One entry per CashHandover opened against this hub-day (domain-model.md 6.11). */
                riderCashPositions: {
                    /** Format: uuid */
                    riderId: string;
                    /** @description CashHandover.system_expected_minor - never rider- or caller-supplied. */
                    systemExpectedMinor: number;
                    /** @description CashHandover.declared_total_minor. */
                    declaredTotalMinor: number;
                    /** @description CashHandover.confirmed_total_minor. Null before the hub counts. */
                    confirmedTotalMinor?: number | null;
                    /** @description CashHandover.state - state-machines.md 16.4. */
                    state: string;
                }[];
                /** @description Sum of RoadExpense.amount_minor applied to this hub-day's handovers (domain-model.md 6.12). */
                roadExpensesAppliedMinor: number;
                /** @description Null where none has been opened yet for this hub-day. */
                hubCashReconciliation?: {
                    /** @description HubCashReconciliation.state - state-machines.md 20.2. */
                    state: string;
                    expectedMinor: number;
                    countedMinor?: number | null;
                    varianceMinor?: number | null;
                } | null;
                cashDispositions: {
                    amountMinor?: number;
                    /** @enum {string} */
                    method?: "BANK_DEPOSIT" | "MERCHANT_MOMO_TRANSFER" | "FINANCE_HANDOVER" | "SAFE_CUSTODY";
                }[];
                /** @description One entry per PaymentDemandLine.obligation_type this contract models - DELIVERY_FEE, REDELIVERY_DELIVERY_FEE, REDELIVERY_FEE, SINGLE_PACKAGE_PICKUP_FEE, RETURN_FEE - with DELIVERY_FEE further split by commercialMode (Pass 2). Station Drop revenue is a commercialMode = STATION_DROP entry, not a fifth obligation_type - it is already DELIVERY_FEE (domain-model.md 6.12, Order.price_components_snapshot). RETURN_FEE (SLICE-006 Pass 1) covers only the ad-hoc-sender, immediate-demand settlement path (domain-model.md 6.14) - a registered vendor's return fee settles through the future VendorStatement mechanism and never appears here. OQ-123 is closed. */
                revenueByType: {
                    /** @enum {string} */
                    obligationType: "DELIVERY_FEE" | "REDELIVERY_DELIVERY_FEE" | "REDELIVERY_FEE" | "SINGLE_PACKAGE_PICKUP_FEE" | "RETURN_FEE";
                    /**
                     * @description Order.commercial_mode (domain-model.md 6.7), joined via OperationalPaymentDemand.order_id. Present only on DELIVERY_FEE entries; null means an ordinary DOORSTEP order, never "unknown." Never set on REDELIVERY_DELIVERY_FEE, REDELIVERY_FEE, SINGLE_PACKAGE_PICKUP_FEE or RETURN_FEE - those obligations do not vary by commercial_mode.
                     * @enum {string|null}
                     */
                    commercialMode?: "STATION_DROP" | "MELARC_COVERED_THIRD_PARTY_DELIVERY" | null;
                    /** @description Sum of PaymentAllocation.amount_minor for this obligation type (and commercialMode, where present) - this hub and business date only. */
                    confirmedMinor: number;
                }[];
            };
        };
        /** @description A reason drives validation (35.9.2). Any workflow that hardcodes "this reason needs a photo" - or "this reason costs an attempt" - contradicts it. */
        ReasonDefinition: {
            /** @description Stable. Never reused after deactivation */
            code: string;
            domain: string;
            /** @description The recipient-contact checkpoints this reason may be selected at. **Non-empty where domain is RECIPIENT_CONTACT, null for every other domain**, which has no checkpoints. This is what REASON_NOT_VALID_FOR_CHECKPOINT evaluates, on recordConfirmationAttempt, recordNextStopContact and recordDoorstepContact. **Fielded at MSC-DEC-407, closing OQ-138's engineering half.** Named in this schema's camelCase, beside consumesDeliveryAttempt and requiresNote; domain-model.md 3.9 carries it as valid_checkpoints, which is that document's convention. domain-model.md 6.12's RecipientContactAttempt invariant already read "the catalogue carries the mapping" and errors-and-enums.md 6 that "a reason declares the checkpoints it is valid for" - and no field held it, so a declared refusal had nothing to read and a client had nothing to filter on. **The RECIPIENT_CONTACT contents are seeded by MSC-DEC-409**, closing OQ-142: NO_ANSWER, NUMBER_INCORRECT, RECIPIENT_DECLINED and CONTACT_NOT_POSSIBLE_MELARC at all three checkpoints, and RECIPIENT_NOT_AT_LOCATION at DOORSTEP only - it is the one that asserts physical presence. **Seeded defaults, not a closed set**: an approved operational reason may be added under settings.reason.manage without a contract change, on MSC-DEC-252's routing test. */
            validCheckpoints?: ("PRE_DISPATCH" | "NEXT_STOP" | "DOORSTEP")[] | null;
            label: string;
            /**
             * @description Who caused it.
             * @enum {string}
             */
            attribution: "CUSTOMER" | "MELARC" | "EXTERNAL";
            /** @description Whether selecting this reason counts as a consumed physical delivery attempt - history and redelivery chargeability, never a count against a maximum, because none exists. A Melarc outage must not. */
            consumesDeliveryAttempt: boolean;
            requiresNote?: boolean;
            requiresPhoto?: boolean;
            requiresContactAttempt?: boolean;
            requiresApproval?: boolean;
            requiresOpsReview?: boolean;
            requiresEscalation?: boolean;
            /** @description Deactivation never deletes */
            active: boolean;
        };
        Error: {
            /**
             * @description Stable machine code — **the only field a client may branch on**. The enumeration is
             *     the whole point: errors-and-enums.md 2 calls a rename a breaking contract change, and
             *     until 23 Aug this was an unconstrained string, so nothing could detect one. A
             *     withdrawn code is absent here, which is what makes "never reused" structural.
             * @enum {string}
             */
            code: "ACCOUNT_OVERDUE" | "ALLOWANCE_DISABLED" | "ATTEMPTS_EXHAUSTED" | "BLIND_COUNT_VIOLATED" | "CARRIER_COST_REQUIRED" | "CARRIER_NOT_APPROVED" | "CASH_HANDOVER_VARIANCE" | "CHALLENGE_EXPIRED" | "CHALLENGE_UNUSABLE" | "CODE_EXPIRED" | "CODE_INVALID" | "COLLECTION_NOT_RECORDED" | "COMMITMENT_REASON_REQUIRED" | "COMMITMENT_SOURCE_UNRESOLVED" | "CORRIDOR_DAY_NOT_PERMITTED" | "CREDENTIAL_DELIVERY_FAILED" | "CREDENTIAL_LOCKED" | "CREDIT_LIMIT_EXCEEDED" | "CSRF_VALIDATION_FAILED" | "CUSTODY_NOT_RETURNED" | "DELIVERY_CHANNEL_FAILED" | "DESTINATION_UNRESOLVED" | "DEVICE_INTEGRITY_FAILED" | "DEVICE_NOT_ENROLLED" | "DEVICE_PROOF_INVALID" | "DEVICE_SECURITY_UNSUPPORTED" | "DISPATCH_NOT_CLEARED" | "DOORSTEP_WAIT_NOT_ELAPSED" | "EVIDENCE_NOT_STORED" | "EVIDENCE_REQUIRED" | "EVIDENCE_UPLOAD_EXPIRED" | "EXCEPTION_NOT_AVAILABLE_TO_SELF_SERVICE" | "EXPORT_FILE_EXPIRED" | "EXPORT_RETENTION_NOT_CONFIGURED" | "EXPORT_SOURCE_NOT_EVENT_COMPLETE" | "FALLBACK_AUTHORIZATION_ALREADY_CONSUMED" | "FALLBACK_AUTHORIZATION_DEMAND_MISMATCH" | "FALLBACK_AUTHORIZATION_METHOD_MISMATCH" | "FALLBACK_AUTHORIZATION_SUPERSEDED" | "FALLBACK_REQUIRES_AUTHORIZATION" | "FINANCIAL_CLOSURE_INCOMPLETE" | "HANDOFF_NOT_RECORDED" | "HANDSHAKE_NOT_VERIFIED" | "HUB_SCOPE_VIOLATION" | "IDEMPOTENCY_KEY_CONFLICT" | "INSUFFICIENT_AUTHORITY" | "INVALID_CREDENTIALS" | "MANIFEST_EMPTY" | "MANIFEST_NOT_STARTED" | "MARGIN_NOT_CONFIGURED" | "MFA_ENROLMENT_REQUIRED" | "MFA_PROOF_INVALID" | "MFA_REQUIRED" | "NOTIFICATION_FAILED" | "NOT_ASSIGNED_RIDER" | "NOT_CUSTODY_HOLDER" | "NOT_FOUND" | "NO_CHARGE_APPLIED" | "NO_PRICING_CHANGE" | "NO_REGISTERED_NUMBER" | "NO_SERVICEABLE_MOTORCYCLE" | "ORDER_NOT_COMMERCIALLY_CLEARED" | "ORDER_NOT_ON_RUN" | "ORDER_UNPRICED" | "OTP_INVALID" | "OUTBOUND_CHARGE_UNPAID" | "PARCEL_NOT_ACCEPTABLE" | "PARCEL_NOT_IN_HUB_CUSTODY" | "PARITY_NOT_MET" | "PAYMENT_ALREADY_PENDING" | "PAYMENT_ALREADY_SETTLED" | "PAYMENT_AMOUNT_MISMATCH" | "PAYMENT_COLLECTION_NOT_ALLOWED" | "PAYMENT_FALLBACK_NOT_VERIFIED" | "PAYMENT_NOT_CONFIRMED" | "PAYMENT_PROVIDER_UNAVAILABLE" | "PAYMENT_STATUS_UNKNOWN" | "PERIOD_NOT_RECONCILED" | "PERMISSION_DENIED" | "PICKUP_ATTEMPT_LIMIT_REACHED" | "PICKUP_MINIMUM_NOT_MET" | "RATE_LIMITED" | "REASON_NOT_ACTIVE" | "REASON_NOT_VALID_FOR_CHECKPOINT" | "REASON_REQUIRED" | "RECIPIENT_NOT_CONFIRMED" | "RECIPIENT_PAYMENT_OUTSTANDING" | "RECOVERY_TOKEN_INVALID" | "REPLACEMENT_REQUIRED" | "RETURN_FEE_OUTSTANDING" | "RIDER_UNAVAILABLE" | "ROAD_EXPENSE_ALREADY_APPLIED" | "ROAD_EXPENSE_NOT_APPROVED" | "RUN_ALREADY_STARTED" | "SELF_APPROVAL_FORBIDDEN" | "SELF_CANCEL_NOT_PERMITTED_AFTER_ASSIGNMENT" | "SENDER_IDENTITY_AMBIGUOUS" | "SENDER_SUSPENDED" | "SERVICE_DATE_NOT_PERMITTED" | "SERVICE_WINDOW_OVERRIDE_REASON_REQUIRED" | "SESSION_INVALID" | "SESSION_SUPERSEDED" | "SETTING_INVALID" | "SETTING_MISSING" | "SETUP_GRANT_INVALID" | "SINGLE_PACKAGE_APPROVAL_REQUIRED" | "SIZE_CLASS_REQUIRED" | "SMS_FALLBACK_LIMIT_REACHED" | "SOURCE_STILL_ACTIVE" | "STATE_CONFLICT" | "STOPS_UNRESOLVED" | "STOP_NOT_QUALIFYING" | "TERMINAL_FOR_STATION_DROP" | "TRUST_DATA_UNAVAILABLE" | "VALIDATION_FAILED" | "VALUE_DECLARATION_REQUIRED" | "VERIFICATION_FALLBACK_NOT_AUTHORIZED" | "WAYBILL_REQUIRED" | "WORK_EMAIL_IN_USE" | "ZERO_COLLECTION_IS_FAILURE" | "ZONE_NOT_SERVICED_ON_DATE";
            /**
             * @description Diagnostic English. Never parsed, never shown to a vendor or rider — display copy
             *     is mapped from `code` by the surface (§36.13, OQ-037).
             */
            message: string;
            details?: {
                [key: string]: unknown;
            };
            request_id: string;
        };
        Money: {
            /** @description Minor units — Ghana pesewas. Never a float, never a decimal string. 2550 is GH₵25.50. */
            amount_minor: number;
            /**
             * @description Only launch currency. Present so multi-currency is a data change.
             * @enum {string}
             */
            currency: "GHS";
        };
        /**
         * @description Coordinates are optional and must never be required for validity — the operation runs on
         *     landmarks and phone calls. Service zone is **resolved from** a location, never stored on
         *     it, because zones are hub-owned and versioned.
         */
        Location: {
            address: string;
            landmark?: string;
            /** Format: uri */
            map_link?: string;
            latitude?: number;
            longitude?: number;
        };
        /**
         * @description Carries payer **intent** only. No AUTHORITATIVE price field exists on this schema: the
         *     authoritative price is still set at itemization, because the size class is selected there
         *     by the receiving officer and cannot be known at booking.
         *
         *     The response carries an indicative estimate, and **its composition depends on whether this
         *     booking has a destination**. A standard multi-package request has none (5.2.1),
         *     so the estimate is base fee x package count. A **one-package exception** carries a mandatory
         *     delivery address (21.1): the server resolves the service area and prices from the fee that
         *     actually applies - in-area, corridor batch day, or **corridor off-day**.
         *
         *     **The estimate is absent for a known outside-Accra destination.** The carrier's charge is
         *     unknowable until itemization, and a number invented for it would be worse than
         *     no number: 23.6, MSC-DEC-175 showed nothing precisely to avoid that.
         *
         *     It stays provisional either way, for the reason that survives - the size class is selected by
         *     a receiving officer at itemization.
         *
         *     **The client sends an address and never a price** (42.3). The server resolves the area.
         */
        PickupRequestCreate: {
            /**
             * @description MSC-DEC-335. OWN_PACKAGES reuses an established Vendor and asks only what
             *     changes today. COLLECT_FOR_VENDOR collects from a THIRD PARTY for a
             *     registered Vendor - it is not merchandise COD, and no rider is authorised to
             *     pay the seller. ADHOC_SENDER creates or REUSES the canonical AdHocSender
             *     and never auto-promotes it to a registered Vendor.
             * @enum {string}
             */
            pickup_intent: "OWN_PACKAGES" | "COLLECT_FOR_VENDOR" | "ADHOC_SENDER";
            /** Format: uuid */
            vendor_organization_id?: string;
            /**
             * Format: uuid
             * @description An EXISTING AdHocSender, found by verified phone on a return visit. Supply this OR new_ad_hoc_sender, never both and never neither.
             */
            ad_hoc_sender_id?: string;
            /** @description First-use identity, for a sender who has never used Melarc. Creating the reusable profile and the request is one idempotent act. */
            new_ad_hoc_sender?: components["schemas"]["NewAdHocSender"];
            collection_point?: components["schemas"]["CollectionPoint"];
            collection_reference?: components["schemas"]["CollectionReference"];
            collection_item?: components["schemas"]["CollectionItem"];
            /**
             * Format: uuid
             * @description COLLECT_FOR_VENDOR destination - a Vendor saved location or an approved alternative.
             */
            destination_location_id?: string | null;
            /** @description The sender's own pickup address. For COLLECT_FOR_VENDOR the collection point carries the address instead, and this is omitted. */
            pickup_location?: components["schemas"]["Location"];
            /** @description Today's goods - women's shoes, clothes, phone accessories, books. REQUIRED for ADHOC_SENDER, because identity is reusable and goods are not. Optional for OWN_PACKAGES, where the Vendor's established goods profile satisfies 21.1 and an established Vendor is not re-onboarded daily. */
            current_item_description?: string;
            /** @description Transaction override — never updates saved sender defaults (§35.2.6). */
            location_overrides?: components["schemas"]["Location"];
            /**
             * Format: date
             * @description Monday–Saturday only (§21.1, MSC-DEC-149). A date, not an instant.
             */
            scheduled_service_date: string;
            /**
             * @description Minimum 2 unless an approved one-package exception exists (§35.2.3). Accepting 1 here
             *     lets the server return `PICKUP_MINIMUM_NOT_MET` with its reason rather than a bare
             *     schema rejection.
             */
            declared_package_count: number;
            /** @enum {string} */
            default_payer_intent: "RECIPIENT_PAYS" | "SENDER_PAYS_FULL" | "SPLIT";
            /** @enum {string} */
            split_basis?: "FIXED_AMOUNT" | "PERCENTAGE";
            split_sender_amount?: components["schemas"]["Money"];
            split_sender_percentage?: number;
            /**
             * @description Declared item value in pesewas. Required above `value_declaration_threshold`
             *     (23.4, MSC-DEC-212) - declared **at booking**, not at itemization, because booking is
             *     the last moment the sender can still decline the terms.
             */
            declared_value_minor?: number;
            /**
             * @description The sender acknowledges liability is capped at `liability_cap_amount` **regardless of
             *     the value declared** (23.4, MSC-DEC-220). Mandatory once `declared_value_minor`
             *     exceeds the threshold; `VALUE_DECLARATION_REQUIRED` otherwise.
             *
             *     **No field here states the cap amount, and that is the guard.** The server snapshots
             *     the cap in force at this moment. A client able to state the cap it acknowledged could
             *     acknowledge a figure that was never in force - and MSC-DEC-220 exists precisely so the
             *     customer learns the real limit BEFORE Melarc takes custody, not after a loss.
             */
            liability_cap_acknowledged?: boolean;
        } & (unknown & unknown & unknown & unknown & unknown);
        PickupRequest: {
            /** Format: uuid */
            id: string;
            /**
             * @description Operational code per MSC-DEC-202. The pattern is the contract: an implementation
             *     emitting a code containing 0, O, 1, I or L fails validation, because these are
             *     read aloud on phone calls between Ops, riders and vendors.
             */
            code: string;
            /** @enum {string} */
            state: "PENDING" | "CONFIRMED" | "DECLINED" | "CANCELLED";
            /** Format: uuid */
            responsible_hub_id: string;
            /**
             * @description The workflow that created this request. Present on every read: an intent accepted at creation and absent from the resource is an intent the rest of the product cannot act on.
             * @enum {string}
             */
            pickup_intent?: "OWN_PACKAGES" | "COLLECT_FOR_VENDOR" | "ADHOC_SENDER";
            /** Format: uuid */
            vendor_organization_id?: string | null;
            /** Format: uuid */
            ad_hoc_sender_id?: string | null;
            collection_point?: components["schemas"]["CollectionPoint"];
            collection_reference?: components["schemas"]["CollectionReference"];
            collection_item?: components["schemas"]["CollectionItem"];
            /**
             * Format: uuid
             * @description Resolved COLLECT_FOR_VENDOR destination. Never null on a COLLECT_FOR_VENDOR request: either supplied, or defaulted to the Vendor's default saved location.
             */
            destination_location_id?: string | null;
            /** @description The sender's OWN address as supplied. Null for COLLECT_FOR_VENDOR, where the parcel is at a third party. Read resolved_pickup_location to dispatch a rider. */
            pickup_location?: components["schemas"]["Location"] | null;
            /** @description THE authoritative place the rider is sent, server-derived from pickup_intent and never null: the Vendor's selected or default saved location for OWN_PACKAGES, the AdHocSender's for ADHOC_SENDER, and THE COLLECTION POINT for COLLECT_FOR_VENDOR. The Vendor's address is where that parcel is GOING. */
            readonly resolved_pickup_location?: components["schemas"]["Location"];
            /** @description Today's goods, captured on the request. Mandatory for ADHOC_SENDER: a returning sender's identity is reusable and last month's shoes are not evidence about this box. Optional for OWN_PACKAGES, where the Vendor's business goods profile already satisfies the intake requirement. Unused by COLLECT_FOR_VENDOR, whose collection_item carries description, quantity and picture. */
            current_item_description?: string | null;
            /** Format: date */
            scheduled_service_date: string;
            declared_package_count?: number;
            default_payer_intent?: string;
            /** Format: uuid */
            one_package_exception_id?: string | null;
            /** @description Capped at MELARC_MAX_PICKUP_ATTEMPTS (3) absent a force-extension. */
            attempt_number: number;
            /** Format: uuid */
            replaces_request_id?: string | null;
            /** @enum {string|null} */
            cancelled_by_actor_type?: "VENDOR" | "OPS" | null;
            declared_value_minor?: number | null;
            /** Format: date-time */
            liability_cap_acknowledged_at?: string | null;
            /**
             * @description The cap **as it stood at acknowledgement** - amount, setting key and effective
             *     version, per domain model 3.7. Never a pointer to the live setting: a customer who
             *     acknowledged GH300 acknowledged that figure, and changing the setting later must not
             *     silently change what they agreed to.
             */
            liability_cap_snapshot?: {
                amount_minor?: number;
                setting_key?: string;
                effective_version?: string;
            } | null;
            /**
             * @description Non-null for **every** post-assignment cancellation. `UNAVAILABLE` means no charge
             *     amount is configured — the cancellation still proceeded. A null outcome on
             *     a post-assignment cancellation is indistinguishable from an unrecorded decision,
             *     which is what MSC-DEC-197 exists to prevent.
             * @enum {string|null}
             */
            cancellation_charge_outcome?: "APPLIED" | "WAIVED" | "NOT_APPLIED" | "UNAVAILABLE" | "EXEMPT" | null;
            /** @description Set only when the outcome is `APPLIED`. Snapshotted per domain-model §3.7. */
            cancellation_charge?: components["schemas"]["Money"] | null;
            /** Format: date-time */
            created_at?: string;
            /** Format: date-time */
            confirmed_at?: string | null;
        };
        /**
         * @description The uniform maker-checker record (§37.4, MSC-DEC-135). `approved_by` may never equal
         *     `requested_by`.
         */
        Approval: {
            /** Format: uuid */
            id: string;
            /** @enum {string} */
            state: "REQUESTED" | "APPROVED" | "REJECTED";
            /** Format: uuid */
            requested_by: string;
            /** Format: uuid */
            approved_by?: string | null;
            reason_code?: string;
            note?: string;
        };
        /** @description Persisted, never kept only in transient UI state (§35.7.2). */
        ContactAttempt: {
            /** Format: date-time */
            attempted_at: string;
            outcome: string;
        };
        CollectionRecordCreate: {
            /** @description Zero is a failed pickup — `ZERO_COLLECTION_IS_FAILURE` (§36.4). */
            collected_count: number;
            /**
             * @description Required when `collected_count < declared_count`. Its metadata may make a note or
             *     photo mandatory in turn (§35.9.2). Absent on a short count → `REASON_REQUIRED`.
             */
            variance_reason_code?: string;
            variance_note?: string;
            /**
             * @description Direction is fixed by 21.4, MSC-DEC-114–115 and may not be reversed: registered vendors
             *     enter a rider-displayed code; ad-hoc senders receive an SMS code the rider enters.
             * @enum {string}
             */
            handshake_type: "VENDOR_ENTERED_RIDER_DISPLAYED" | "SENDER_SMS_RIDER_ENTERED";
            /**
             * @description Which rung of the fallback ladder verified the handshake. **Recorded
             *     on every handshake, not only fallbacks** — the control is that persistent fallback
             *     use becomes visible, and a ratio needs both terms.
             * @default PORTAL
             * @enum {string}
             */
            handshake_channel?: "PORTAL" | "SMS_FALLBACK" | "OPS_OVERRIDE";
            /** @description Each id must name an evidence record in `STORED` (EVIDENCE_NOT_STORED otherwise). */
            evidence_ids?: string[];
            /**
             * Format: date-time
             * @description Field capture time, distinct from upload time. Preserved on sync along with ordering
             *     and conflict status (§35.3.9).
             */
            captured_at?: string;
        };
        /**
         * @description What was recorded for a stop: every field the rider sent (`CollectionRecordCreate`) as stored,
         *     and the fields the server adds. **It repeats the creation fields instead of composing the
         *     creation schema.** That schema is closed (`additionalProperties: false`, so a rider cannot send a
         *     server field), and a closed schema inside an `allOf` refuses every field its sibling adds, so no
         *     answer could satisfy the composition. The creation fields below are stated exactly as
         *     `CollectionRecordCreate` states them (a test holds the two together); the last five are the
         *     server's.
         */
        CollectionRecord: {
            /** @description Zero is a failed pickup — `ZERO_COLLECTION_IS_FAILURE` (§36.4). */
            collected_count: number;
            /**
             * @description Required when `collected_count < declared_count`. Its metadata may make a note or
             *     photo mandatory in turn (§35.9.2). Absent on a short count → `REASON_REQUIRED`.
             */
            variance_reason_code?: string;
            variance_note?: string;
            /**
             * @description Direction is fixed by 21.4, MSC-DEC-114–115 and may not be reversed: registered vendors
             *     enter a rider-displayed code; ad-hoc senders receive an SMS code the rider enters.
             * @enum {string}
             */
            handshake_type: "VENDOR_ENTERED_RIDER_DISPLAYED" | "SENDER_SMS_RIDER_ENTERED";
            /**
             * @description Which rung of the fallback ladder verified the handshake. **Recorded
             *     on every handshake, not only fallbacks** — the control is that persistent fallback
             *     use becomes visible, and a ratio needs both terms.
             * @default PORTAL
             * @enum {string}
             */
            handshake_channel?: "PORTAL" | "SMS_FALLBACK" | "OPS_OVERRIDE";
            /** @description Each id must name an evidence record in `STORED` (EVIDENCE_NOT_STORED otherwise). */
            evidence_ids?: string[];
            /**
             * Format: date-time
             * @description Field capture time, distinct from upload time. Preserved on sync along with ordering
             *     and conflict status (§35.3.9).
             */
            captured_at?: string;
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            pickup_stop_id: string;
            /** @description As stated by the sender at the door. */
            declared_count: number;
            /**
             * @description Present on every collection, not only partials — a clean count is a recorded
             *     outcome, not an absence.
             * @enum {string}
             */
            variance: "MATCH" | "SHORT";
            /**
             * Format: date-time
             * @description Set when the shortfall flag reached the Ops surface.
             */
            office_notified_at?: string | null;
        };
        PickupStop: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            pickup_manifest_id: string;
            /** Format: uuid */
            pickup_request_id: string;
            /** @description Manual ordering — no route optimization (§35.3.2). */
            sequence: number;
            /** @enum {string} */
            state: "PENDING" | "ARRIVED" | "COLLECTED" | "PARTIALLY_COLLECTED" | "FAILED" | "SKIPPED";
        };
        HubIntakeBase: {
            /** Format: uuid */
            id: string;
            code: string;
            /** Format: uuid */
            hub_id: string;
            /** Format: uuid */
            pickup_request_id: string;
            /**
             * Format: uuid
             * @description The run whose hub handover opened this intake.
             */
            pickup_manifest_id: string;
            /**
             * Format: uuid
             * @description The custody holder who submitted the handover - the assigned rider, or whoever accepted a RunCustodyHandover.
             */
            handed_over_by: string;
            /**
             * Format: date-time
             * @description Server receipt of the handover.
             */
            handed_over_at: string;
            /**
             * Format: date-time
             * @description When the rider made the declaration on the device - distinct from handed_over_at.
             */
            declaration_captured_at: string;
            /**
             * Format: uuid
             * @description The receiver holding the advisory lock (§22.8), if anyone does.
             */
            active_receiver_id?: string | null;
            /** Format: date-time */
            lock_acquired_at?: string | null;
            /** @enum {string} */
            state: "AWAITING_COUNT" | "COUNTED" | "RECONCILIATION_REQUIRED" | "READY_FOR_ITEMIZATION" | "ITEMIZING" | "CLOSED";
            /** @enum {string} */
            count_phase: "PRE_COUNT" | "POST_COUNT";
        };
        /**
         * @description **Deliberately has no `rider_declared_count` property.** This absence is the blind-count
         *     guarantee (§35.5.2, §43.2). Adding the field to this schema — even nullable, even
         *     "hidden by the UI" — breaks the contract.
         */
        HubIntakePreCount: components["schemas"]["HubIntakeBase"] & {
            /** @constant */
            count_phase?: "PRE_COUNT";
        } & {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            count_phase: "HubIntakePreCount";
        };
        HubIntakePostCount: components["schemas"]["HubIntakeBase"] & {
            /** @constant */
            count_phase?: "POST_COUNT";
            rider_declared_count: number;
            physical_count: number;
            /**
             * @description The comparison **outcome**, not the number. An enum because condition and dispute
             *     findings must be recordable even at `MATCH` (§35.5.4).
             * @enum {string}
             */
            count_variance: "MATCH" | "SHORT" | "OVER";
            /** @description Signed numeric difference. */
            count_difference?: number;
            /**
             * @description **HIGH-11 audit remediation, nullability corrected on review.** The fixed
             *     four-value classification domain-model.md's `PickupIntake.condition` defines and
             *     §22.5 requires — previously readable only by inspecting `condition_findings`'
             *     untyped contents, with no field stating the classification itself. Independent of
             *     `count_variance` (§35.5.4). **Non-nullable and required in this post-count
             *     projection**, because domain-model.md records the column as `Null: no` — it always
             *     carries one of the four values, `OK` included. *Superseded shape:* declared
             *     nullable with `null` in the enum, which contradicted that authority.
             * @enum {string}
             */
            condition: "OK" | "DAMAGED" | "TAMPERED" | "OTHER";
            /**
             * @description Detail behind a non-`OK` condition — evidence and adjudication notes, not the
             *     classification itself, which is `condition` above. Independent of count_variance —
             *     the three OS&D dimensions never collapse.
             */
            condition_findings?: {
                [key: string]: unknown;
            }[];
            dispute_state?: string | null;
            /** Format: uuid */
            parity_exception_id?: string | null;
        } & {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            count_phase: "HubIntakePostCount";
        };
        /**
         * @description **No price and no destination zone.** Both are server-derived (§35.6.6, §42.3). A client
         *     that could send either could set its own price.
         *
         *     `carrier_cost` is the one monetary value a client may submit, and it is deliberately not
         *     an exception to that rule. A price is a decision; a carrier cost is an observation with a
         *     waybill behind it. The client cannot influence the margin, the size surcharge or the total
         *     — the server applies the hub's configured margin to whatever cost is submitted, and the
         *     submitted figure is audited against the evidence.
         *
         *     Had outside-Accra been quoted freely, as first proposed, this schema would have needed a
         *     settable price field — which would have dismantled the guard entirely.
         */
        OrderItemize: {
            recipient: {
                name: string;
                /** @description E.164, normalised. As-entered form retained server-side. */
                phone: string;
                location: components["schemas"]["Location"];
            };
            /**
             * @description Selected by the receiving officer, not derived. MSC-DEC-209 establishes no weight or
             *     dimension thresholds, so no server rule can compute this. Surcharges apply only in
             *     MELARC_COVERED_THIRD_PARTY_DELIVERY; SMALL is always GH0.
             * @enum {string}
             */
            size_class: "SMALL" | "MEDIUM" | "LARGE";
            /**
             * @description The third-party carrier's ACTUAL charge, transcribed from their waybill. Required
             *     exactly when commercial_mode is MELARC_COVERED_THIRD_PARTY_DELIVERY; rejected otherwise.
             *     This is an OBSERVED COST, not a price. The server still computes the price by applying
             *     the hub's configured margin. See the schema description below.
             */
            carrier_cost?: components["schemas"]["Money"];
            /** @default false */
            is_high_value?: boolean;
            /** @enum {string} */
            lane?: "DOORSTEP" | "THIRD_PARTY_HANDOFF";
            /**
             * @description Required exactly when lane is THIRD_PARTY_HANDOFF.
             * @enum {string}
             */
            commercial_mode?: "STATION_DROP" | "MELARC_COVERED_THIRD_PARTY_DELIVERY";
            /** @description Parcel-level override of the request's default intent (§5.2). */
            payer_override?: Record<string, never>;
        };
        /**
         * @description Two orthogonal state fields, not one (domain-model §5.9). An order may be commercially
         *     `PREPAID` while physically `AT_HUB_AFTER_FAILURE`; its commercial standing does not move
         *     as it travels.
         */
        Order: {
            /** Format: uuid */
            id: string;
            code: string;
            /** Format: uuid */
            pickup_intake_id?: string;
            /** Format: uuid */
            responsible_hub_id?: string;
            /**
             * @description NO_VENDOR_CHARGE means the resolved vendor portion was zero, so the
             *     commercial gate had nothing to test. It is **not** a payment and **not** a
             *     reservation: counting it as revenue, as prepayment, or as consumed exposure is
             *     wrong in three different reports.
             * @enum {string}
             */
            commercial_state: "PRICED" | "PAYMENT_REQUIRED" | "CREDIT_RESERVED" | "NO_VENDOR_CHARGE" | "PREPAID" | "CLOSED" | "REVERSED";
            /** @enum {string} */
            fulfilment_state: "AWAITING_RECIPIENT_CONFIRMATION" | "READY_FOR_DISPATCH" | "ASSIGNED" | "OUT_FOR_DELIVERY" | "DELIVERED" | "ATTEMPT_FAILED" | "AT_HUB_AFTER_FAILURE" | "READY_FOR_REATTEMPT" | "HANDED_TO_CARRIER" | "RETURN_TO_VENDOR_IN_PROGRESS" | "RETURNED_TO_VENDOR";
            origin_zone_snapshot?: {
                [key: string]: unknown;
            };
            destination_zone_snapshot?: {
                [key: string]: unknown;
            };
            /** @enum {string} */
            size_class: "SMALL" | "MEDIUM" | "LARGE";
            /** Format: uuid */
            size_class_selected_by?: string | null;
            carrier_cost?: components["schemas"]["Money"];
            /** Format: date */
            derived_delivery_date?: string | null;
            is_high_value?: boolean;
            lane: string;
            commercial_mode?: string | null;
            locked_price?: components["schemas"]["Money"];
            /**
             * @description Each component carries HUB, setting key, effective version and value. Components:
             *     service-area base fee OR corridor off-day fee OR station-drop fee; size-class
             *     surcharge and carrier cost plus applied margin (third-party mode only).
             *
             *     The HUB is part of each component since MSC-DEC-218 made fees hub-scoped. Version
             *     counters are per hub and collide — service_area_base_fee v3 is GH35 in Accra and may
             *     be GH45 in Kumasi — so key plus version no longer identifies a value on its own
             *     (§35.1.5, domain-model §3.7).
             */
            price_components_snapshot?: {
                [key: string]: unknown;
            };
            delivery_attempt_count?: number;
        };
        /**
         * @description No rider and no sequence at creation. Both are separate, separately permissioned steps
         *     because each carries its own rule — sequencing is manual, assignment closes vendor
         *     cancellation.
         */
        PickupManifestCreate: {
            pickup_request_ids: string[];
            /** Format: date */
            service_date: string;
        };
        /**
         * @description **Hub-scoped, never vendor-scoped** (domain-model §4). A manifest spans vendors, so
         *     applying a vendor filter to it would leak one vendor's existence to another or return
         *     an incoherent partial manifest. A vendor sees their stop, never this.
         *
         *     `assigned_at`, `dispatched_at` and `started_at` are three distinct moments and are
         *     stored separately because each governs a different rule.
         */
        PickupManifest: {
            /** Format: uuid */
            id: string;
            code: string;
            /**
             * @description state-machines.md 4, SIGNED at MSC-DEC-233. **Rider assignment is not a state.** It is an action that sets assigned_rider_id and assigned_at and leaves the manifest DRAFT - MSC-DEC-195 makes that field the vendor self-cancellation cutoff, so the moment is recorded on the record rather than inferred from a state. A manifest is therefore DRAFT both before and after a rider is assigned, and leaves DRAFT only at dispatch. **ASSIGNED was removed at MSC-DEC-405**, where this enum carried six values against five in the signed machine, five in domain-model.md 6.3, five in errors-and-enums.md's enum index, and five in this file's own DeliveryRun - which state-machines.md 12 specifies as mirroring this machine.
             * @enum {string}
             */
            state: "DRAFT" | "DISPATCHED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
            /** Format: date */
            service_date: string;
            /** Format: uuid */
            responsible_hub_id: string;
            /** Format: uuid */
            assigned_rider_id?: string | null;
            /** Format: date-time */
            assigned_at?: string | null;
            /** Format: date-time */
            dispatched_at?: string | null;
            /** Format: date-time */
            started_at?: string | null;
            stops?: components["schemas"]["PickupStop"][];
        };
        /**
         * @description The complete sequence, not a delta. Manual ordering only — Version 1 has no route
         *     optimisation and the sequence is a plan a rider may depart from.
         */
        ManifestStopOrder: {
            ordered_stop_ids: string[];
        };
        RiderAssignment: {
            /** Format: uuid */
            rider_id: string;
        };
        /**
         * @description One row per collected pickup request (§22.2, MSC-DEC-416), each pre-filled from that
         *     request's collected total and correctable before submission. Each row is stored on its
         *     intake as `rider_declared_count` and **withheld from every pre-count response**.
         *     *Superseded shape:* one `declared_count` for the whole run.
         */
        HubHandoverSubmit: {
            /**
             * @description Exactly the run's collected pickup requests, each once. Anything else is
             *     VALIDATION_FAILED, naming the row.
             */
            rows: components["schemas"]["HubHandoverRow"][];
            /**
             * Format: date-time
             * @description When the rider made the declaration on the device - the field time, distinct from the
             *     server's receipt (§35.3.9). Recorded on each intake as declaration_captured_at.
             */
            captured_at: string;
            note?: string;
        };
        HubHandoverRow: {
            /** Format: uuid */
            pickup_request_id: string;
            /**
             * @description The parcels the rider hands over for this request. **Zero is legal**: the request's
             *     intake still opens, and is routed to reconciliation after the blind count.
             */
            declared_count: number;
        };
        /**
         * @description **The code value never appears on this schema.** It is displayed to the rider at
         *     generation and never returned, logged, or written to an audit event. Audit records that
         *     a code was generated, never its value (§20.4, audit §9).
         *
         *     `channel` is recorded on every path including the primary one, so that persistent
         *     fallback use is measurable rather than anecdotal.
         */
        Handshake: {
            /** Format: uuid */
            stop_id: string;
            /** @enum {string} */
            state: "PENDING" | "SENT" | "VERIFIED" | "EXPIRED" | "ATTEMPTS_EXHAUSTED" | "OVERRIDDEN" | "FAILED" | "CANCELLED";
            /** @enum {string|null} */
            channel?: "PORTAL" | "SMS" | "OPS_OVERRIDE" | null;
            attempts?: number;
            /** Format: date-time */
            expires_at?: string | null;
            fallback_used?: boolean;
            /** Format: uuid */
            authorised_by?: string | null;
        };
        HandshakeVerify: {
            code: string;
        };
        HandshakeOverride: {
            reason_code: string;
            /** @description How Ops verified the vendor by other means. Mandatory. */
            verification_note: string;
        };
        /**
         * @description Adjudication never rewrites the counts. The declared count, the hub count and the
         *     variance survive it unchanged — this explains a discrepancy, it does not erase one.
         */
        DiscrepancyAdjudication: {
            /** @enum {string} */
            outcome: "ACCEPTED" | "ESCALATED" | "WRITTEN_OFF" | "VENDOR_NOTIFIED";
            /**
             * @description **HIGH-11 audit remediation — the fixed four-value enum, matching domain-model.md's
             *     `PickupIntake.condition` and §22.5 exactly.** Valid on a MATCH variance; damage,
             *     tampering or dispute may be recorded independently of count. `DAMAGED` and `TAMPERED`
             *     require `evidence_ids` and route to Senior Ops. *Superseded enum:* `[INTACT, DAMAGED]`
             *     — two of the four approved values, `TAMPERED` and `OTHER`, could not be submitted
             *     through this operation at all, and `AC-SLICE-001-42` was not executable as written.
             * @enum {string}
             */
            condition?: "OK" | "DAMAGED" | "TAMPERED" | "OTHER";
            /**
             * @description **HIGH-11 audit remediation.** Required (`REASON_REQUIRED`) when `condition` is
             *     `DAMAGED` or `TAMPERED` (§22.5). Each id must name an evidence record in `STORED` —
             *     a `PENDING_UPLOAD` record is rejected with `EVIDENCE_NOT_STORED`, the same guard every
             *     other evidence-accepting operation carries.
             */
            evidence_ids?: string[];
            reason_code: string;
            note?: string;
        };
        StaffSignIn: {
            /**
             * @description The staff member's work email. Compared in its canonical form: trimmed, Unicode
             *     NFKC-normalised and lower-cased as a whole address, with no dot or plus-tag folding. The
             *     same form decides uniqueness and keys the rate limit. The address is stored and displayed
             *     as entered.
             *     The address is canonicalised first and only then checked to be an email address, which is
             *     `VALIDATION_FAILED` (`400`) when it is not. This schema carries no `format: email`, because
             *     that would refuse a padded or non-ASCII address before it could be canonicalised.
             */
            email: string;
            /**
             * @description Capped at 128 so a hash is never asked to chew an unbounded input. **No minimum is checked here**:
             *     a short guess is a wrong password, answered `INVALID_CREDENTIALS` like any other.
             */
            password: string;
        };
        RiderSignIn: {
            /** @description E.164, normalised. */
            phone: string;
            /** @description Six numeric digits, a fixed policy that this schema makes structural. */
            pin: string;
            /** @description The one-use nonce from requestRiderSignInChallenge */
            challenge: string;
            /** @description Signature over the challenge by the registered non-exportable private key */
            device_signature: string;
            /**
             * @description The Rider app's own root-detection result.
             *     **Producer:** the app, at sign-in, which sends one of the three values and sends
             *     `UNKNOWN` when it could not establish a result. **Consumer:** the backend, which records
             *     it on the session and in the audit trail (`auth.session.issued`) for Ops follow-up.
             *     **It is never an authentication control.** `DETECTED` does not by itself block sign-in,
             *     `NOT_DETECTED` is not evidence that the device is trustworthy, and no value relaxes
             *     another check. The check runs in the process an attacker controls, which is why it
             *     records and does not refuse. Required, so that a missing value is a protocol error and
             *     not an unreported result.
             * @enum {string}
             */
            client_root_signal: "NOT_DETECTED" | "DETECTED" | "UNKNOWN";
        };
        VendorSignIn: {
            /**
             * @description The vendor account's own identifier (`VendorAccount.account_identifier`): server-generated,
             *     human-typeable, **not a secret**. Ops reads it from `getVendorAccount` and the vendor is told it
             *     in the setup message.
             */
            account_identifier: string;
            /** @description Capped at 128 so a hash is never asked to chew an unbounded input. No minimum is checked here. */
            secret: string;
        };
        /**
         * @description Returned instead of a Session when the role requires a second factor. **Grants nothing.**
         *     It is not a partial session and carries no authority; the session is created only when the
         *     factor is accepted.
         */
        MfaChallenge: {
            /** Format: uuid */
            challenge_id: string;
            /** Format: date-time */
            expires_at: string;
        };
        MfaSignInComplete: {
            /** Format: uuid */
            challenge_id: string;
            /**
             * @description The TOTP code from the authenticator: 6 digits, 30-second step, one step accepted either
             *     side, single use (a code already used is refused again inside its window). A value that
             *     is not exactly 6 digits is `VALIDATION_FAILED`; a well-formed code that does not prove
             *     the factor is `MFA_PROOF_INVALID`.
             */
            code: string;
        };
        SessionRevoke: {
            /**
             * @description A code of the reason catalogue (`ReasonDefinition`), validated against the catalogue's
             *     identity domain for this operation: empty is `REASON_REQUIRED`, and a code that is unknown,
             *     retired or in another domain is `REASON_NOT_ACTIVE`.
             */
            reason_code: string;
            note?: string;
        };
        /**
         * @description **No session credential appears on this schema, ever**, and only its hash (`token_hash`) is
         *     persisted. Transport is now DEFINED rather than deferred: an HttpOnly, Secure,
         *     SameSite=Lax cookie for the browser surfaces and an opaque Bearer secret in Android secure
         *     storage for Melarc Rider.
         *
         *     **The precise rule**: a raw Session credential never appears in an ORDINARY
         *     Session resource representation - this schema, getCurrentSession, any listing. Browser
         *     credentials travel only as Set-Cookie. **Rider Session issuance returns the opaque Bearer
         *     credential exactly once**, through the dedicated RiderSessionIssued response, because a
         *     native client has no Set-Cookie equivalent and there is no other moment at which it can
         *     receive it.
         *
         *     *Superseded phrasing:* "never in a response body" - which read as an absolute and was
         *     contradicted by the one response that must return it. The distinction is between a
         *     RESOURCE representation and an ISSUANCE response, not between bodies and headers.
         *
         *     Never in a log and never in an audit event, in every case. Audit records that a session
         *     was issued, not its material - the same rule 20.4 applies to OTPs.
         *
         *     **Permission keys, never bundle contents or role names.** The session snapshots the bundle
         *     server-side so authority is evaluated against what was held at issue. `permissions` lists
         *     the keys of that snapshot and nothing else, as the source of navigation; a client never
         *     decides its own permissions from it, because the server checks the key on every request.
         *
         *     There is no elevation field. MSC-DEC-228 makes MFA a sign-in gate for Senior Ops and
         *     Platform Admin, so a session that exists is already privileged to whatever its bundle allows.
         */
        Session: {
            /** Format: uuid */
            id: string;
            /** @enum {string} */
            principal_type: "STAFF" | "RIDER" | "VENDOR";
            /** Format: uuid */
            principal_id?: string;
            /** @enum {string} */
            state: "ACTIVE" | "TERMINATED";
            authorized_hub_ids?: string[];
            /**
             * @description The permission keys this session holds, **from its snapshot**: keys only (permissions.md),
             *     **never role names** and never a bundle. Read-only, and fixed for the life of the session
             *     because it is the snapshot. It is the source a client builds navigation from (the Ops menu),
             *     and nothing more: the server stays authoritative and checks the key on every request, so
             *     what a client shows or hides decides nothing. Returned on the caller's own session
             *     (`getCurrentSession` and the sign-in responses); `listSessions` shows another principal's
             *     sessions and returns none.
             */
            readonly permissions?: string[];
            /** Format: uuid */
            registered_device_id?: string | null;
            /** Format: date-time */
            issued_at?: string;
            /**
             * Format: date-time
             * @description Absolute expiry, per-tier.
             */
            expires_at: string;
            /**
             * Format: date-time
             * @description Basis for the browser idle timeout. The approved 30/15-minute idle limits
             *     had NO field to evaluate against before Gate A, so an approved control was
             *     unimplementable. Non-null for EVERY session and initialised at issue (R1). Rider sessions record it and
             *     are never terminated by it - the rider exemption is from EVALUATION, not from recording.
             */
            last_activity_at?: string;
            /** @enum {string|null} */
            termination_reason?: "SIGNED_OUT" | "SUPERSEDED_BY_NEW_LOGIN" | "REPLACED_BY_NEW_SESSION" | "EXPIRED" | "CREDENTIAL_CHANGED" | "SUSPENDED" | "OFFBOARDED" | "ADMIN_REVOKED" | "AUTHORITY_CHANGED" | "HUB_SCOPE_CHANGED" | "DEVICE_REVOKED" | "DEVICE_REPLACED" | "MFA_RESET" | null;
        };
        /**
         * @description **No device identifier and no replacement device appear on this schema, and that is the
         *     guard.** The rider is the subject; the binding to revoke is whichever one is current.
         *
         *     A schema that accepted a replacement device would collapse revocation and re-registration
         *     into one call - and with it the asymmetry MSC-DEC-235 is built on, where revoking is
         *     unverified because it grants nothing and re-registering is gated because it grants
         *     everything. One operation doing both would have to be gated at the higher level, which
         *     is exactly what makes reporting a loss slow.
         */
        DeviceRevocation: {
            /**
             * @description Why the binding is being revoked - lost, stolen or otherwise compromised - as a code of the
             *     reason catalogue (`ReasonDefinition`), validated against the catalogue's identity domain for
             *     this operation: empty is `REASON_REQUIRED`, and a code that is unknown, retired or in another
             *     domain is `REASON_NOT_ACTIVE`. Audited. Replacement is not a revocation reason; a handset
             *     replaced through reregisterRiderDevice leaves REPLACED, and the two stay distinguishable.
             */
            reason_code: string;
        };
        /**
         * @description **No `resolution` field, and that is deliberate.** Escalation is the terminal Ops
         *     resolution; reschedule and cancel are `cancelPickupRequest`. Collapsing all three into
         *     one enum-carrying endpoint would put the escalation-only rule for `REFUSED_COLLECTION`
         *     behind a runtime branch instead of behind a separate permissioned call.
         */
        PickupEscalation: {
            reason_code: string;
            note?: string;
        };
        /**
         * @description **No `new_ceiling` field.** The extension is granted for this request, once; it is not a
         *     per-request configuration value. A settable ceiling would let one Senior Ops action
         *     create an effectively uncapped request, which is what the cap exists to prevent.
         */
        AttemptExtension: {
            /** @description Mandatory and immutable once recorded (21.6, MSC-DEC-116). */
            reason: string;
        };
        /**
         * @description **No `amount` field.** A waiver removes the applied charge in full or is not a waiver.
         *     A partial waiver would be a repricing of a snapshotted charge, which 3.7 forbids.
         */
        CancellationChargeWaiver: {
            reason_code: string;
            note?: string;
        };
        /**
         * @description **Exactly one of `to_rider_id` and `to_hub_id` is set**, and the schema carries no field for the
         *     original rider. A handover names where custody is **going**; where it comes **from** is read
         *     from the run. A settable origin would be a rider-ID edit wearing another name, and 36.14 forbids
         *     that outright because completed-stop attribution depends on it.
         */
        RunCustodyHandoverCreate: {
            /** Format: uuid */
            to_rider_id?: string;
            /** Format: uuid */
            to_hub_id?: string;
            reason_code: string;
            note?: string;
        };
        RunCustodyHandoverAccept: {
            /**
             * @description What the receiver physically took. **A custody record, not a count.** The hub blind count
             *     runs independently at intake and is never seeded from this figure.
             */
            parcel_count_taken: number;
        };
        RunCustodyHandover: {
            /** Format: uuid */
            id?: string;
            /** Format: uuid */
            manifest_id?: string;
            /** Format: uuid */
            from_rider_id?: string;
            /** Format: uuid */
            to_rider_id?: string | null;
            /** Format: uuid */
            to_hub_id?: string | null;
            /** @enum {string} */
            state?: "PENDING" | "COMPLETED" | "FAILED";
            parcel_count_taken?: number | null;
            /** Format: date-time */
            initiated_at?: string;
            /** Format: date-time */
            resolved_at?: string | null;
        };
        /**
         * @description **No destination field exists on this schema, and that is the guard.** A recovery request
         *     that could name its own delivery address is a redirect waiting to happen. RIDER is absent
         *     from the enum by design — there is no rider self-service path.
         */
        RecoveryRequestCreate: {
            /** @enum {string} */
            principal_type: "STAFF" | "VENDOR";
            /**
             * @description The account identifier or work email. **Not a destination.** The channel is resolved
             *     from the principal's registered contact; nothing here influences where the token goes.
             *     A work email is read in its canonical form: trimmed, Unicode NFKC-normalised and
             *     lower-cased as a whole address, with no dot or plus-tag folding.
             */
            identifier: string;
        };
        RecoveryComplete: {
            token: string;
            /**
             * @description 12 to 128 characters, counted in Unicode code points after NFKC normalisation.
             *     Spaces are permitted and no composition rule applies: no mandatory case, digit or symbol.
             *     Never trimmed, truncated or echoed. Argon2id-hashed server-side.
             *     `minLength` and `maxLength` check the string as sent and are a pre-filter; the service
             *     applies the rule after normalisation and is the authority (Gate PD-3R2).
             */
            new_credential: string;
        };
        /**
         * @description Replaces the polymorphic `OpsRecovery` (Gate PD-3R1, `PDA-62`). **No `principal_type`, no
         *     `principal_id`**: the path already names the staff member or vendor account, so the body
         *     carried two fields no operation read and one of them could disagree with the path. Taken by
         *     `recoverStaffCredential` and `recoverVendorCredential`, which each create a `RecoveryRequest`.
         */
        CredentialRecoveryInitiation: {
            /**
             * @description A code of the reason catalogue (`ReasonDefinition`), validated against the catalogue's
             *     identity domain for this operation: empty is `REASON_REQUIRED`, and a code that is unknown,
             *     retired or in another domain is `REASON_NOT_ACTIVE`.
             */
            reason_code: string;
            note?: string;
        };
        /**
         * @description Taken by `reregisterRiderDevice` only. The path names the rider; **no device identifier and no
         *     principal fields** appear.
         */
        RiderDeviceReregistration: {
            /**
             * @description A code of the reason catalogue (`ReasonDefinition`), validated against the catalogue's
             *     identity domain for this operation: empty is `REASON_REQUIRED`, and a code that is unknown,
             *     retired or in another domain is `REASON_NOT_ACTIVE`.
             */
            reason_code: string;
            /**
             * @description How Senior Ops verified the rider's identity in person. **Required**, because the rider's
             *     recovery path is a human verification step and the audit record must say how it was done.
             */
            verification_note: string;
        };
        /**
         * @description Entity at domain-model.md 6.8 (`RiderIdentity`). **Identity and readiness only**: no PIN, no
         *     public key, no failed-attempt count and nothing about the rider's work. A rider is
         *     authentication-ready when `status` is `ACTIVE`, `pin_established` and `has_active_device` are both
         *     true. Rider *administration* (onboarding, suspension, offboarding) is `SLICE-009`; this is the read
         *     the device operations need to find their target.
         */
        RiderSummary: {
            /** Format: uuid */
            id: string;
            full_name: string;
            /** @description E.164, normalised. */
            phone: string;
            /** @enum {string} */
            status: "ACTIVE" | "INACTIVE" | "TEMPORARILY_UNAVAILABLE" | "SUSPENDED" | "OFFBOARDED";
            /** Format: uuid */
            primary_hub_id: string;
            /** @description Whether the rider has set a PIN. The PIN itself is never represented. */
            pin_established: boolean;
            /** @description Whether exactly one `ACTIVE` RegisteredDevice exists. */
            has_active_device: boolean;
        };
        /**
         * @description The record `getRider` returns, with the `ETag` that `reregisterRiderDevice` takes as `If-Match`.
         *     Neither secret a device holds is represented (see RegisteredDevice).
         */
        RiderDetail: {
            rider: components["schemas"]["RiderSummary"];
            /** @description Every device the rider has held, `ACTIVE`, `REPLACED` and `REVOKED`, newest first. */
            devices: components["schemas"]["RegisteredDevice"][];
        };
        /**
         * @description Entity at domain-model.md 6.8 (`VendorAccount` and `VendorCredential`). **Authentication
         *     status only.** The recovery channel is shown as *whether* one exists and never as an address,
         *     so a reader learns that a grant can be delivered without learning where.
         */
        VendorAccountSummary: {
            /** Format: uuid */
            id: string;
            /** @description What the vendor types at sign-in. Not a secret. */
            account_identifier: string;
            /** Format: uuid */
            vendor_organization_id: string;
            legal_name: string;
            /**
             * Format: uuid
             * @description The linked VendorOrganization's responsible hub - the value the caller's scope is decided on (MSC-DEC-442; domain-model.md 6.16).
             */
            responsible_hub_id: string;
            /** @enum {string} */
            status: "ACTIVE" | "SUSPENDED";
            /** @description Whether the vendor has set a shared secret. The secret is never represented. */
            credential_established: boolean;
            active_device_count: number;
            has_recovery_email: boolean;
            has_recovery_phone: boolean;
            /**
             * @description Which recovery channel the approver chose at approval, so where this account's setup and
             *     recovery grants are delivered. Never the address itself. Null until the account's
             *     organisation is approved.
             * @enum {string|null}
             */
            readonly delivery_channel?: "PHONE" | "EMAIL" | null;
        };
        /**
         * @description The record `getVendorAccount` returns, with the `ETag` that `recoverVendorCredential` and
         *     `reissueVendorCredentialSetup` take as `If-Match`.
         */
        VendorAccountDetail: {
            account: components["schemas"]["VendorAccountSummary"];
            devices: components["schemas"]["RegisteredDevice"][];
        };
        /**
         * @description **The token never appears here.** Not on issue, not on read, not in an audit event — the
         *     same rule 20.4 applies to OTPs. A response carrying a recovery token would put it in logs,
         *     proxies and browser history.
         *
         *     `initiated_by` is null for self-service and holds the authorising actor otherwise.
         */
        RecoveryRequest: {
            /** Format: uuid */
            id: string;
            /** @enum {string} */
            principal_type: "STAFF" | "RIDER" | "VENDOR";
            /** @enum {string} */
            channel: "EMAIL" | "SMS" | "OPS_VERIFIED";
            /** @enum {string} */
            state: "PENDING" | "CONSUMED" | "EXPIRED" | "SUPERSEDED";
            /** Format: date-time */
            issued_at?: string;
            /** Format: date-time */
            expires_at: string;
            /** Format: date-time */
            consumed_at?: string | null;
            /** Format: uuid */
            initiated_by?: string | null;
        };
        /**
         * @description MED-10 audit remediation. **No `purpose` or `principal_type` field** — both are fixed by
         *     which reissue operation is called and the target named in the path, exactly as
         *     CancellationChargeWaiver carries no amount. A settable purpose would let this operation
         *     issue a grant for an act the caller was never authorised to reissue.
         */
        SetupGrantReissue: {
            /**
             * @description A code of the reason catalogue (`ReasonDefinition`), validated against the catalogue's
             *     identity domain for this operation: empty is `REASON_REQUIRED`, and a code that is unknown,
             *     retired or in another domain is `REASON_NOT_ACTIVE`.
             */
            reason_code: string;
            note?: string;
        };
        /**
         * @description MED-10 audit remediation — the first API-exposed shape for domain-model.md §6.8's
         *     `SetupGrant`, which existed as a signed entity and a signed machine (state-machines.md §19,
         *     MSC-DEC-274) with no schema a response could reference. **The token never appears here**,
         *     for the identical reason `RecoveryRequest` above omits it — never on issue, on read, or in
         *     an audit event (20.4).
         */
        SetupGrant: {
            /** Format: uuid */
            id: string;
            /** @enum {string} */
            principal_type: "STAFF" | "RIDER" | "VENDOR";
            /** Format: uuid */
            principal_id: string;
            /** @enum {string} */
            purpose: "STAFF_CREDENTIAL_SETUP" | "MFA_ENROLMENT" | "MFA_REENROLMENT" | "BOOTSTRAP_SETUP" | "RIDER_DEVICE_ENROLMENT" | "RIDER_DEVICE_REREGISTRATION" | "VENDOR_CREDENTIAL_SETUP" | "VENDOR_DEVICE_ENROLMENT";
            /** @enum {string} */
            state: "PENDING" | "CONSUMED" | "EXPIRED" | "SUPERSEDED";
            /** Format: date-time */
            issued_at: string;
            /**
             * Format: date-time
             * @description Null only for BOOTSTRAP_SETUP, which has no expiry
             */
            expires_at?: string | null;
            /** Format: date-time */
            consumed_at?: string | null;
        };
        /**
         * @description One attempt, one record. **Not a counter increment** - 24.2 requires attempts persisted
         *     rather than "kept only in transient UI state", and a count cannot say when or what happened.
         *
         *     A corrected_address that resolves to a different SERVICE AREA after price freeze triggers
         *     the 35.6.8 repricing path; it does not silently reprice.
         */
        ConfirmationAttempt: {
            /** @enum {string} */
            outcome: "confirmed" | "reschedule" | "address_correction" | "unreachable";
            /** @description **Mandatory on `unreachable` and not carried on the other three**. Must be an ACTIVE RECIPIENT_CONTACT reason whose validCheckpoints include PRE_DISPATCH - REASON_REQUIRED without one, REASON_NOT_VALID_FOR_CHECKPOINT for a reason seeded elsewhere. **The four outcomes map onto domain-model.md 6.12's two**: confirmed, reschedule and address_correction are SUCCESSFUL contacts - the person WAS reached, and a reschedule or a correction is a held order rather than a failed call, recorded by delivery_commitment_id or location_change_request_id - while unreachable is the UNSUCCESSFUL one. **Added at MSC-DEC-409**: state-machines.md 11's SIGNED AWAITING_ATTEMPT to ATTEMPTED_NO_ANSWER row guards on "an active PRE_DISPATCH reason", this operation has always declared REASON_REQUIRED, and the schema had no field to carry one. The seeded five are NO_ANSWER, NUMBER_INCORRECT, RECIPIENT_DECLINED, RECIPIENT_NOT_AT_LOCATION (DOORSTEP only, so not selectable here) and CONTACT_NOT_POSSIBLE_MELARC. */
            reason_code?: string;
            /**
             * @description Captured on the call and **copied onto the delivery stop** (24.2, 24.4). This is often
             *     the only thing standing between a rider and a wasted attempt in an area without
             *     addresses.
             */
            refined_location_note?: string;
            corrected_address?: components["schemas"]["Location"];
            note?: string;
        };
        /**
         * @description **No attempt count and no threshold.** Escalation is Ops judgement that the contact avenues
         *     are exhausted; a field carrying a count would reintroduce the retired ceiling
         *     as a request parameter. The attempt rows are the evidence, and the reason is mandatory.
         */
        RecipientConfirmationEscalation: {
            reason_code: string;
            note?: string;
        };
        /**
         * @description **The exact amount being asked of one payer in one interaction.** It is NOT a ledger: it
         *     answers *what are we asking this payer for right now* and stops. Accounting & Reporting owns
         *     the general ledger, receivables, statements and settlement.
         *
         *     **It is also the collision boundary for every payment method** - provider
         *     collection, Merchant MoMo and cash all consult it, so no method decides independently that
         *     the obligation looks unpaid.
         *
         *     **A short payment funds it and settles nothing**. GH50 against GH55
         *     is real money on a real receipt; **no line settles**, no priority is applied, and
         *     handover stays blocked. Receipts accumulate, and when cumulative confirmed principal
         *     reaches the frozen total **every line settles atomically for its exact amount**.
         *
         *     **Five figures, deliberately, and not one ambiguous amount_due.** total_due is what
         *     was frozen; confirmed_receipts is what arrived; allocated is what reached lines;
         *     remaining_due is what to ask for next; excess is what is owed back.
         */
        OperationalPaymentDemand: {
            /** Format: uuid */
            id: string;
            /** @enum {string} */
            readonly payer_type?: "RECIPIENT" | "VENDOR";
            /** Format: uuid */
            readonly order_id?: string | null;
            /** @enum {string} */
            readonly currency: "GHS";
            /** @description THE SUM OF THE LINES, server-computed and never supplied. A redelivery is 3500 + 2000 = 5500 - one prompt, not two. */
            readonly total_due_minor: number;
            /**
             * @description OPEN: nothing confirmed yet. PARTIALLY_SETTLED: confirmed_receipts_minor is GREATER THAN ZERO and LESS THAN total_due_minor, and NO line allocation has been finalised - the demand is partially FUNDED, not partially settled. SETTLED: cumulative principal reached the total and every frozen line was allocated its exact amount in one act. VOID: the obligations were withdrawn. IT IS NOT DERIVED FROM LINE STATES ALONE - OPEN and PARTIALLY_SETTLED have IDENTICAL line states, and only the receipt total distinguishes them.
             * @enum {string}
             */
            readonly status: "OPEN" | "PARTIALLY_SETTLED" | "SETTLED" | "VOID";
            /** @description CUMULATIVE confirmed eligible principal received against this demand, across ALL receipts. This is the figure atomic settlement watches - not any single receipt. GH50 then GH5 reads 5500 here. */
            readonly confirmed_receipts_minor?: number;
            /** @description Principal actually allocated to lines. ZERO until atomic settlement fires: a short payment settles no line, so this stays 0 while confirmed_receipts_minor is positive. */
            readonly allocated_minor?: number;
            /**
             * @description THE CANONICAL FORMULA, stated once and nowhere else:
             *       remaining_due_minor = max(total_due_minor - confirmed_receipts_minor, 0)
             *     where confirmed_receipts_minor is the cumulative ELIGIBLE confirmed principal received against this demand. THE NEXT COLLECTION REQUESTS THIS, not the total again - GH55 owed and GH50 received prompts for GH5. It is compatible with atomic settlement by construction: a short receipt REDUCES the remaining due while settling NO line, and the floor at zero means EXCESS never becomes new remaining due - excess is retained on its receipt and raises an adjustment. Server-derived; no caller supplies it and no rider chooses it.
             */
            readonly remaining_due_minor?: number;
            /** @description Confirmed principal above total_due_minor. It is NEVER allocated to a line or to another order - it stays on its receipt and raises a FinancialAdjustmentRequired. */
            readonly excess_minor?: number;
            readonly lines: components["schemas"]["PaymentDemandLine"][];
            /**
             * Format: date-time
             * @description Set when a PaymentAttempt is created against it. FROZEN means amount and line composition cannot move while a customer is being asked to pay them - no Rider or Ops screen can edit either.
             */
            readonly frozen_at?: string | null;
        };
        /**
         * @description One operational obligation. **Lines are filled together or not at all**.
         *     Once the demand's CUMULATIVE eligible confirmed principal reaches total_due_minor, the
         *     settlement engine atomically fills every frozen line for its authoritative amount, and
         *     PaymentAllocation records preserve which receipt contributed which principal.
         *     **That may be one receipt or several** - GH55 at once, or GH50 then GH5.
         *     *Superseded description:* a single provider success allocates across every line, which
         *     assumed every payment arrives exact and made a short receipt unrepresentable.
         */
        PaymentDemandLine: {
            /** Format: uuid */
            id: string;
            /**
             * @description RETURN_FEE is materialised only where ReturnRecord.settlement_path = IMMEDIATE_DEMAND (an ad-hoc sender, SLICE-006 Pass 1). A registered vendor's return fee settles through the future VendorStatement mechanism and never appears as a line here.
             * @enum {string}
             */
            obligation_type: "DELIVERY_FEE" | "REDELIVERY_DELIVERY_FEE" | "REDELIVERY_FEE" | "SINGLE_PACKAGE_PICKUP_FEE" | "RETURN_FEE";
            readonly obligation_ref?: string;
            readonly description_code?: string;
            readonly principal_due_minor: number;
            readonly principal_settled_minor?: number;
            /** @enum {string} */
            readonly status: "OPEN" | "SETTLED" | "VOID";
            readonly pricing_snapshot_ref?: string;
        };
        /**
         * @description **No amount field.** The demand already knows what is owed, and an officer who could type an
         *     amount here could settle GH55 with GH5.
         */
        FallbackAuthorizationRequest: {
            /**
             * Format: uuid
             * @description The attempt that is CREATED, PENDING or STATUS_UNKNOWN.
             */
            unresolved_payment_attempt_id: string;
            /** @enum {string} */
            fallback_method: "MERCHANT_MOMO" | "CASH";
            reason_code: string;
            note?: string;
            /** @description MUST be true. The authorising officer states that the customer may already have been debited and that a later provider success will raise a FinancialAdjustmentRequired. */
            duplicate_risk_acknowledged: boolean;
        };
        /**
         * @description **No amount field.** The adjustment already knows what is owed back, and partial
         *     resolution is not permitted - one adjustment resolves once, wholly. A
         *     proposer who could type an amount here could resolve GH55 with GH5.
         */
        AdjustmentResolutionProposal: {
            /** @enum {string} */
            resolution_class: "REFUND" | "CREDIT" | "ALLOCATION" | "UNCLAIMED_DISPOSITION";
            /**
             * @description Mandatory for REFUND and CREDIT. NONE where nothing moves.
             * @enum {string|null}
             */
            method?: "MERCHANT_MOMO_TRANSFER" | "BANK_TRANSFER" | "CASH_AT_HUB" | "VENDOR_BALANCE_CREDIT" | "NONE" | null;
            /** @description Account - wallet or party as the method requires. Mandatory for REFUND. */
            destination?: string | null;
            /** @description Mandatory for MERCHANT_MOMO_TRANSFER and BANK_TRANSFER. */
            reference?: string | null;
            /** Format: uuid */
            evidence_id?: string | null;
            /** @description Mandatory for UNCLAIMED_DISPOSITION, and for REFUND where the payer is a registered vendor - the vendor's request is what displaces the CREDIT default. */
            reason_code?: string | null;
        };
        AdjustmentResolutionDecision: {
            /** @enum {string} */
            outcome: "APPROVED" | "REJECTED";
            /** @description Mandatory on REJECTED - a refusal that records no reason teaches nothing. */
            reason_code?: string | null;
        };
        /** @description What was done about money owed back (domain-model.md 6.15, MSC-DEC-395). One per adjustment. This record creates NO accounting entry - Sec14.1 places general accounting outside Version 1 - and Melarc records this money rather than moving it, the same boundary CashDisposition holds. */
        FinancialAdjustmentResolution: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            readonly financial_adjustment_required_id: string;
            /** Format: uuid */
            readonly hub_id?: string;
            /** @enum {string} */
            readonly resolution_class: "REFUND" | "CREDIT" | "ALLOCATION" | "UNCLAIMED_DISPOSITION";
            /** @description Equals the adjustment's own amount. Partial resolution is not permitted. */
            readonly amount_minor: number;
            /** @enum {string} */
            readonly currency: "GHS";
            /** @enum {string|null} */
            readonly method?: "MERCHANT_MOMO_TRANSFER" | "BANK_TRANSFER" | "CASH_AT_HUB" | "VENDOR_BALANCE_CREDIT" | "NONE" | null;
            readonly destination?: string | null;
            readonly reference?: string | null;
            /** Format: uuid */
            readonly evidence_id?: string | null;
            readonly reason_code?: string | null;
            /**
             * @description The adjustment reaches RESOLVED only on APPROVED. A REJECTED record is kept and leaves the adjustment OPEN for a fresh proposal.
             * @enum {string}
             */
            readonly status: "PROPOSED" | "APPROVED" | "REJECTED";
            /** Format: uuid */
            readonly proposed_by_staff_id?: string;
            /** Format: date-time */
            readonly proposed_at?: string;
            /**
             * Format: uuid
             * @description Never equal to proposed_by_staff_id.
             */
            readonly decided_by_staff_id?: string | null;
            /** Format: date-time */
            readonly decided_at?: string | null;
        };
        /**
         * @description **The fact that money is owed back. Not the remedy.** No payment is reversed or deleted to
         *     raise one: both receipts stand, and this record is what points at the difference.
         */
        FinancialAdjustmentRequired: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            readonly payment_demand_id: string;
            /** Format: uuid */
            readonly payment_attempt_id?: string | null;
            /** Format: uuid */
            readonly order_id?: string | null;
            /** @enum {string} */
            readonly reason: "DUPLICATE_PAYMENT" | "OVERPAYMENT" | "PAID_OBLIGATION_VOIDED" | "LATE_PROVIDER_SUCCESS_AFTER_FALLBACK";
            readonly amount_minor: number;
            /** @enum {string} */
            readonly currency: "GHS";
            /** Format: date-time */
            readonly raised_at?: string;
            /**
             * @description OPEN is the only status Gate C writes. Refund, credit and allocation are Accounting & Reporting's; deciding them here would put refund policy in a delivery specification. RESOLVED is written by that domain when a FinancialAdjustmentResolution is APPROVED - never by a Gate C operation, so the original rule still holds exactly as written.
             * @enum {string}
             */
            readonly status: "OPEN" | "RESOLVED";
            /** @description Idempotent. One source condition raises ONE record - a late-success callback delivered three times produces one receipt effect and one adjustment. */
            readonly source_key?: string;
        };
        /**
         * @description **The Rider's and Ops's payment view of one stop, and the only documented source of a
         *     payment_demand_id.** Before this, initiatePaymentCollection required an id no operation
         *     produced: a rider had a screen, a permission, an uneditable amount, and **no way to obtain
         *     the identifier the request would not work without**. A database lookup, an undocumented
         *     admin call or a typed UUID were the only routes left, and all three mean the path does not
         *     exist.
         *
         *     **Reading resolves; it does not invent.** Where a payable obligation has no demand yet, the
         *     server materialises the one its obligations already determine, under the same business key
         *     - **opening this screen five times produces one GH55 demand, not five**.
         *
         *     **Nothing here is writable.** The amount, the lines, the settlement state and the
         *     permission to collect are all the server's.
         */
        StopPaymentView: {
            /** @description THE PRODUCER. This is where payment_demand_id comes from. Null only where nothing is currently payable for the stop. */
            readonly payment_demand?: components["schemas"]["OperationalPaymentDemand"] | null;
            /** @description Whether a collection may be offered NOW. False while an attempt is unresolved, while the demand is SETTLED or VOID, and where nothing is outstanding. TRUE for a PARTIALLY_SETTLED demand with remaining due: a partially funded demand is exactly when the next collection - for the remainder - must be offered. */
            readonly collection_allowed: boolean;
            /**
             * @description An actual inability to collect. PARTIALLY_SETTLED is deliberately NOT a value here - it is a demand status, and it means the remainder is collectable, not blocked. HUB_CASH_DISABLED blocks the cash method only; a digital collection stays offered.
             * @enum {string|null}
             */
            readonly collection_blocked_reason?: "NOTHING_OUTSTANDING" | "ALREADY_SETTLED" | "DEMAND_VOID" | "ATTEMPT_UNRESOLVED" | "HUB_CASH_DISABLED" | null;
            /**
             * Format: uuid
             * @description The attempt blocking an ordinary fallback - CREATED, PENDING or STATUS_UNKNOWN. This is the id an Ops officer authorises against.
             */
            readonly unresolved_payment_attempt_id?: string | null;
            /** @description The unspent Ops grant, where one exists. This is where its id comes from. */
            readonly active_fallback_authorization?: components["schemas"]["PaymentFallbackAuthorization"] | null;
            /** @description What has actually been received against this demand. TWO real payment events appear as TWO receipts - a fallback and a late provider success are both true. */
            readonly receipts?: components["schemas"]["PaymentReceipt"][];
        };
        /**
         * @description **Money Melarc has confirmed receiving through one method.** It is NOT a general-ledger
         *     entry: Accounting & Reporting owns the ledger, receivables and settlement.
         *
         *     **A confirmed receipt is never deleted because the obligation behind it was later voided.**
         *     The money arrived. Deleting the record is how a customer's payment quietly becomes
         *     Melarc's - the condition FinancialAdjustmentRequired exists to make visible.
         *
         *     **Two real payment events are two receipts.** A Merchant MoMo fallback of GH55 and a late
         *     Hubtel success of GH55 are BOTH true, and collapsing them destroys the evidence that a
         *     refund is owed. **The demand still settles once**, and the excess becomes an adjustment
         *     fact.
         *
         *     **A receipt SHORT of the demand total is still a receipt.** A provider that
         *     authoritatively transferred GH50 against GH55 transferred GH50, and recording that as a
         *     failure would model money that arrived as money that did not. The receipt
         *     is created at what arrived; what it does NOT do is settle a line.
         *
         *     **No operator creates one.** A receipt is the recorded consequence of a method confirming.
         */
        PaymentReceipt: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            readonly payment_demand_id: string;
            /**
             * @description The already-authorised methods and no other. HUBTEL and MERCHANT_MOMO are confirmed DIGITAL and create NO rider cash; CASH additionally moves RiderCashCustody, which is a separate record and not this one.
             * @enum {string}
             */
            readonly method: "HUBTEL" | "MERCHANT_MOMO" | "CASH";
            /** Format: uuid */
            readonly payment_attempt_id?: string | null;
            /** @description The verified Merchant MoMo reference or the doorstep cash record. */
            readonly manual_source_ref?: string | null;
            /**
             * Format: uuid
             * @description CASH only, and then mandatory: the RiderCashCustody this receipt increased. Null for HUBTEL and MERCHANT_MOMO, which create no custody.
             */
            readonly rider_cash_custody_id?: string | null;
            /**
             * Format: uuid
             * @description Set where this receipt was taken under an Ops duplicate-risk grant.
             */
            readonly fallback_authorization_id?: string | null;
            /** @description WHAT ACTUALLY ARRIVED. Not the amount requested, and NEVER net of provider_fee_minor - processing cost is not deducted from what a customer owes. */
            readonly received_principal_minor: number;
            /** @enum {string} */
            readonly currency: "GHS";
            readonly provider_transaction_id?: string | null;
            readonly provider_reference?: string | null;
            readonly payer_msisdn_masked?: string | null;
            /** Format: date-time */
            readonly confirmed_at: string;
            /**
             * @description The actor for cash and manual confirmation; SYSTEM for provider truth applied by the trusted service. A Rider is not a Staff member.
             * @enum {string|null}
             */
            readonly received_by_principal_type?: "RIDER" | "STAFF" | "SYSTEM" | null;
            /** Format: uuid */
            readonly received_by_principal_id?: string | null;
            /** @description IDEMPOTENT IDENTITY. The same provider success delivered three times produces ONE receipt. */
            readonly source_key?: string;
            /** @enum {string} */
            readonly status: "CONFIRMED" | "REVERSED_BY_PROVIDER";
            readonly allocations?: components["schemas"]["PaymentAllocation"][];
        };
        /**
         * @description **What a receipt settled.** One receipt may allocate across SEVERAL lines: GH55 becomes
         *     GH35 to the delivery-fee line and GH20 to the redelivery-fee line, both SETTLED, ONE
         *     provider prompt.
         *
         *     **Bounded by the money, not by the obligation.** The sum of a receipt's allocations never
         *     exceeds its received principal, and a line's settled principal never exceeds its due
         *     principal. **An excess is not allocated anywhere** - not spread onto unrelated orders or
         *     lines - and the difference becomes a FinancialAdjustmentRequired.
         *
         *     **Server-authoritative.** No screen allocates, re-allocates or un-allocates, and no
         *     permission represents the act.
         *
         *     **A confirmed receipt SHORT of the demand total allocates NOTHING**.
         *     The demand records PARTIALLY_SETTLED, the receipt stands at its confirmed amount, no
         *     line is settled and handover stays blocked. **No allocation priority exists** - not
         *     delivery-fee-first, not redelivery-fee-first, not pro rata. Atomic settlement removes
         *     the question rather than answering it, which is what the Product Owner ruled when
         *     closing OQ-111.
         *
         *     **Settlement is ATOMIC and may draw on SEVERAL receipts.** When cumulative confirmed
         *     principal reaches total_due_minor, every frozen line is allocated its exact
         *     principal_due_minor in ONE act. GH50 then GH5 against GH35 and GH20 produces three
         *     allocations - R1 to L1 3500, R1 to L2 1500, R2 to L2 500 - and both lines SETTLED.
         *
         *     **Provenance is preserved**. Every allocation names one receipt and one
         *     line; receipts are drawn in confirmed_at order and lines in frozen order, so a replay
         *     produces the same records. **A single anonymous GH55 allocation would erase the fact
         *     that two payments were involved**, which is the fact a refund argument turns on. The
         *     ordering decides WHICH RECEIPT'S MONEY reaches a line, never WHICH LINE GETS PAID.
         */
        PaymentAllocation: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            readonly payment_receipt_id: string;
            /** Format: uuid */
            readonly payment_demand_line_id: string;
            readonly amount_minor: number;
            /** Format: date-time */
            readonly allocated_at: string;
            readonly source_key?: string;
        };
        /**
         * @description **A grant that is consumed, not a line in an audit log**. MSC-DEC-357 created
         *     the duplicate-risk exception and **nothing could spend it**: both fallback operations
         *     refused an unresolved attempt outright, so the officer's authorisation reached nothing and
         *     the one controlled way through the settlement gate ended at a 201.
         *
         *     **An audit log is not an authorisation database.** Audit records that a decision was taken;
         *     it cannot be asked *is this grant still available*, and a settlement path must never query
         *     it for permission.
         *
         *     **One active grant per demand, attempt and method.** A repeat request returns the existing
         *     one rather than accumulating grants.
         *
         *     **VALIDITY IS EVALUATED AT THE MOMENT OF USE**, never assumed from the stored status.
         *     All six must hold: status ACTIVE; the referenced attempt still unresolved
         *     in an allowed state; the demand neither SETTLED nor VOID; the method matches the fallback
         *     being taken; not already consumed; and the demand it names is the demand being settled.
         *     **A stale duplicate-risk grant must never take a second full payment.**
         */
        PaymentFallbackAuthorization: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            readonly payment_demand_id: string;
            /** Format: uuid */
            readonly unresolved_payment_attempt_id: string;
            /**
             * @description THE FALLBACK TAKEN MUST BE THE FALLBACK AUTHORISED. A CASH grant cannot settle a Merchant MoMo payment - FALLBACK_AUTHORIZATION_METHOD_MISMATCH.
             * @enum {string}
             */
            readonly fallback_method: "MERCHANT_MOMO" | "CASH";
            /**
             * Format: uuid
             * @description Authorised Ops. NEVER a Rider - a rider may report and request, never authorise.
             */
            readonly authorized_by_staff_id?: string;
            readonly reason_code?: string;
            readonly note?: string | null;
            readonly duplicate_risk_acknowledged?: boolean;
            /** Format: date-time */
            readonly created_at: string;
            /**
             * @description SINGLE USE. A consumed grant is refused - FALLBACK_AUTHORIZATION_ALREADY_CONSUMED. Consumption is a system effect of the fallback receipt being written; nobody marks it consumed by hand. VALID BY EVENT, NOT BY CLOCK. It becomes SUPERSEDED the moment the condition it was granted for stops existing: the attempt reaches SUCCEEDED, FAILED, EXPIRED or CANCELLED, or the demand becomes SETTLED or VOID. There is NO TTL - the previous EXPIRED state had no duration, so nothing could enter or test it.
             * @enum {string}
             */
            readonly status: "ACTIVE" | "CONSUMED" | "SUPERSEDED";
            /** Format: date-time */
            readonly superseded_at?: string | null;
            /**
             * @description ATTEMPT_RESOLVED_SUCCEEDED - the money arrived, so a grant issued against *we cannot tell* must not authorise a second full payment. ATTEMPT_RESOLVED_SAFE - the provider is definitively terminal, the duplicate risk is gone, and ORDINARY fallback rules apply rather than this grant. DEMAND_SETTLED / DEMAND_VOID - nothing left to collect.
             * @enum {string|null}
             */
            readonly superseded_reason?: "ATTEMPT_RESOLVED_SUCCEEDED" | "ATTEMPT_RESOLVED_SAFE" | "DEMAND_SETTLED" | "DEMAND_VOID" | null;
            /** Format: date-time */
            readonly consumed_at?: string | null;
            /** Format: uuid */
            readonly consumed_by_receipt_id?: string | null;
        };
        /**
         * @description **Two fields, deliberately.** No amount, no currency, no hub, no status, no provider
         *     transaction id, no `paid`, no confirmed amount and NO PIN - every one of those is either
         *     server-derived or nobody's business but the provider's.
         *
         *     **payment_demand_id comes from getStopPaymentDemand or listOperationalPaymentDemands**,
         *     never from a client's own construction. Until C1.6 this list required
         *     `obligation_ref`, **which is not a property of this schema** - the request could not be
         *     satisfied as written, and the id it does require had no producer at all.
         */
        PaymentCollectionRequest: {
            /**
             * Format: uuid
             * @description The OperationalPaymentDemand to collect. The server requests its REMAINING DUE at this moment - total_due_minor minus what has already been confirmed - and never the total again once a receipt exists. A success creates a receipt for what actually arrived. It settles lines only when the demand's CUMULATIVE confirmed principal reaches the total, and then it settles ALL of them at once. *Superseded description:* the server requests total_due_minor and a success allocates across every line, which was true only while every payment was exact.
             */
            payment_demand_id: string;
            /** @description The payer's mobile-money number, canonically normalised. It is NOT necessarily the recipient's contact number, and using it here never rewrites the recipient record. */
            payer_msisdn: string;
        };
        /**
         * @description **Every field is readOnly.** A client observes a collection; it never states one. There is
         *     no field a caller could set to make an unpaid obligation look paid, and **no PIN field
         *     exists**.
         */
        PaymentCollection: {
            /** Format: uuid */
            id: string;
            /** @description The frozen demand, with its lines and total. */
            readonly payment_demand?: components["schemas"]["OperationalPaymentDemand"];
            /**
             * @description A RIDER is not a STAFF member. The record required a Staff id while permitting a Rider surface, which left the rider path unbuildable without forging a StaffIdentity. Exactly one initiator, immutable, coherent with the surface.
             * @enum {string}
             */
            readonly initiator_principal_type?: "RIDER" | "STAFF";
            /** Format: uuid */
            readonly order_id?: string | null;
            /** Format: uuid */
            readonly delivery_stop_id?: string | null;
            /**
             * @description One engine, two surfaces.
             * @enum {string}
             */
            readonly initiating_surface?: "RIDER" | "OPS";
            /** @description Masked for display. The full number is never returned to a client. */
            readonly payer_msisdn_masked?: string;
            /** @description THE DEMAND'S REMAINING DUE AT THE MOMENT THIS ATTEMPT WAS CREATED, snapshotted and immutable thereafter. NOT total_due_minor: a demand of GH55 with GH50 already confirmed creates an attempt for GH5, and prompting for GH55 again would take GH105 for a GH55 delivery. The demand's own total is preserved separately on the demand, so the original obligation is never lost. SERVER-DERIVED and never caller-supplied. It is the figure this attempt asks for - not the amount charged to the payer, and not net of any provider fee. What it CONFIRMS may be less, more or equal, and confirmed_principal_minor carries that; settlement is decided by the demand's cumulative total, never by one attempt. */
            readonly principal_amount_minor: number;
            /** @enum {string} */
            readonly currency: "GHS";
            /**
             * @description STATUS_UNKNOWN means TRANSMITTED AND UNANSWERED - not failed. No retry is permitted from it, because that is precisely the case where the customer may already have been debited.
             * @enum {string}
             */
            readonly state: "CREATED" | "PENDING" | "STATUS_UNKNOWN" | "SUCCEEDED" | "FAILED" | "EXPIRED" | "CANCELLED" | "REVERSED";
            /** @description Safe text for the operator. For STATUS_UNKNOWN it says to wait and NOT to request payment again; it never offers a retry. */
            readonly ui_instruction?: string;
            readonly client_reference?: string;
            readonly provider_transaction_id?: string | null;
            /** Format: date-time */
            readonly created_at: string;
            /** Format: date-time */
            readonly expires_at?: string | null;
            /** Format: date-time */
            readonly provider_confirmed_at?: string | null;
            readonly confirmed_principal_minor?: number | null;
            /** @description An external provider fact where returned. It NEVER reduces the obligation and is not a rider Road Expense. */
            readonly provider_fee_minor?: number | null;
            readonly net_settlement_minor?: number | null;
            /** @enum {string} */
            readonly reconciliation_status?: "NOT_REQUIRED" | "REQUIRED" | "IN_PROGRESS" | "RESOLVED";
        };
        /**
         * @description **A notification, not an authority**. Every value here is checked against the
         *     frozen attempt, and where callback authenticity cannot be cryptographically trusted the
         *     attempt is confirmed by an independent server-to-server status query before SUCCEEDED.
         *
         *     **Nothing here can create an obligation, change an amount or name a different order.**
         */
        ProviderPaymentCallback: {
            client_reference: string;
            provider_transaction_id?: string;
            provider_status: string;
            amount_minor?: number;
            currency?: string;
            payer_msisdn?: string;
        };
        RedeliveryCancellationRequest: {
            /** @description An ACTIVE reason from the redelivery-cancellation domain - REASON_NOT_ACTIVE otherwise. 36.12: a reason is a governed record, never free text, because the reason is what makes the obligation VOID rather than merely unpaid. */
            reason_code: string;
            /** @description Optional operator note. Never a substitute for the reason code. */
            note?: string;
        };
        /**
         * @description **No fee field exists here, deliberately**. Both amounts are SERVER-SNAPSHOTTED
         *     at scheduling - the applicable delivery fee from the ordinary pricing rules, the redelivery
         *     fee from the hub setting. **No payer field exists either**: it is always RECIPIENT, and
         *     ordinary Ops cannot change it.
         */
        RedeliveryScheduleRequest: {
            /**
             * Format: uuid
             * @description The QUALIFYING FAILED PHYSICAL DeliveryStop this answers. STOP_NOT_QUALIFYING where the stop was skipped at NEXT_STOP or held at PRE_DISPATCH - neither is a physical attempt.
             */
            originating_delivery_stop_id: string;
            /** Format: date */
            scheduled_date: string;
            scheduled_window?: string;
            /** Format: uuid */
            destination_location_id?: string | null;
            note?: string;
        };
        Redelivery: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            order_id: string;
            /**
             * Format: uuid
             * @description The qualifying failed physical DeliveryStop this trip answers. NOT unique across Redelivery records: a trip cancelled before it departed (Sec20.5, SCHEDULED -> CANCELLED) leaves the same failed stop as the only qualifying one, so a later redelivery references it again. Concurrency is guarded by the order's own AT_HUB_AFTER_FAILURE -> READY_FOR_REATTEMPT transition, not by a constraint here.
             */
            originating_delivery_stop_id: string;
            /** @description 1 for the first redelivery, 2 for the next. NO MAXIMUM - each further trip needs its own Ops approval, and no Product decision sets a ceiling. */
            sequence: number;
            /** Format: uuid */
            readonly scheduled_by_staff_id?: string;
            /**
             * Format: date-time
             * @description The snapshot moment. The charge is created here and nowhere earlier.
             */
            readonly scheduled_at: string;
            /**
             * Format: uuid
             * @description The NEW commitment. The original is preserved and never overwritten.
             */
            readonly delivery_commitment_id?: string;
            /** @description SNAPSHOTTED at scheduling from the ordinary pricing rules applied to the new trip - destination, service type, corridor rules, approved location changes. Not a fixed figure. */
            readonly applicable_delivery_fee_minor?: number;
            /** @description SNAPSHOTTED from the HUB's redelivery_fee_minor setting (GH20 at Accra launch). A later setting change never reprices a scheduled redelivery. DISTINCT from flat_return_fee_amount, which governs a different act and happens to share the launch value. */
            readonly redelivery_fee_minor?: number;
            /** @description The two above. GH35 + GH20 = GH55 in the Accra example. */
            readonly total_due_minor?: number;
            /**
             * @description ALWAYS the recipient. Not the Vendor, not the original payer, not an Ops-selected party. Ordinary Ops cannot change it.
             * @enum {string}
             */
            readonly payer: "RECIPIENT";
            /** @description DERIVED FROM THE ORIGINATING REASON, never chosen by the scheduling officer. False where the failure is attributed to Melarc - a rider breakdown, a provider outage, an OTP failure that was not the recipient's doing - and both fees are then 0. */
            readonly chargeable: boolean;
            /** @enum {string} */
            payment_state?: "NOT_REQUIRED" | "DUE" | "SETTLED";
            /** Format: uuid */
            delivery_run_id?: string | null;
            /** Format: uuid */
            delivery_stop_id?: string | null;
            /** @enum {string} */
            status: "SCHEDULED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
        };
        /**
         * @description **What the rider captured at the station or the carrier's counter**.
         *
         *     **Version 1 permits BOTH carrier identity modes** (MSC-DEC-413, closing OQ-140): a
         *     registered active courier or station, and an approved informal driver/agent. **What must
         *     arrive therefore depends on the mode.** handed_to and evidence_id are required in both.
         *     **waybill_reference is the REGISTERED mode's requirement** - 24.7.3 and 35.9(9) both scope
         *     it there, and WAYBILL_REQUIRED has always read *registered handoff without a waybill* -
         *     and it is not carried for an agent handoff. 24.7.1 earns Melarc's fee against a waybill AND
         *     a receipt/handoff photo on a registered handoff, so for that mode a partial capture is
         *     still not a handoff. **The conditional lives in the declared refusal rather than the
         *     required list**, as it does for variance_reason_code on a parcel-custody confirmation.
         *
         *     **No state field, and no COMMERCIAL mode field** - and identity_mode is not an exception
         *     to that rule but a different fact (MSC-DEC-413, amended). The state this produces is fixed
         *     by the operation, and commercial_mode is snapshotted server-side from the order: a client
         *     able to send either could declare a Station Drop complete, or turn a covered delivery into
         *     one. **commercial_mode is a property of the ORDER**, decided before dispatch.
         *     **identity_mode is a property of the ACT at the counter** - who the rider actually handed
         *     to - which the client necessarily reports, exactly as it reports handed_to. **The server
         *     validates the declared mode against the approved identity; it does not infer the mode from
         *     which optional fields arrived.** A future reader tempted to delete this field as *the mode
         *     field we said we do not have* should read this paragraph first.
         */
        CarrierHandoffCapture: {
            /**
             * @description **Which of 24.7.3's two carrier identity modes this handoff is** (MSC-DEC-413, amended before commit). Version 1 permits both, so **the request must say which** rather than leave the server to infer it from which optional fields arrived - an inference that would make a capture with neither a provider id nor an agent identity ambiguous instead of invalid.
             *     **REGISTERED** requires courier_provider_id naming an ACTIVE approved CourierProvider or station record, and waybill_reference. **APPROVED_AGENT** requires agent_phone, which the server resolves to an ACTIVE ApprovedAgent at the rider's hub whose identity photo is stored (MSC-DEC-417, closing OQ-133), and carries no waybill. **Both require evidence_id, the same custody authority, the same idempotency and the same audit record**: the mode changes what identifies the carrier, nothing else.
             *     **NEITHER MODE PERMITS AN UNAPPROVED THIRD PARTY TO RECEIVE CUSTODY.** CARRIER_NOT_APPROVED refuses a REGISTERED capture whose provider is absent or inactive, and an APPROVED_AGENT capture whose agent is not validly approved under the informal-agent rules. A declared mode whose own required identity is missing is VALIDATION_FAILED, not an implicit switch to the other mode.
             * @enum {string}
             */
            identity_mode: "REGISTERED" | "APPROVED_AGENT";
            /** @description The station or carrier ACTUALLY handed to, captured at the act (36.10). Distinct from Order.carrier_identity, which records what was planned. */
            handed_to: {
                /** @description The station or carrier as identified at handoff */
                name: string;
                /** @description Their own counter, desk or agent reference where one is given. */
                reference?: string | null;
            };
            /**
             * Format: uuid
             * @description The approved courier or station from 24.7's register, where the handoff is to a **registered** courier or station. **Null for an approved informal agent handoff**, which MSC-DEC-413 permits in Version 1 - which is why this field is NOT required.
             *     **The signed guard requires an approved courier or station CAPTURED, in both modes** - state-machines.md 10 names no commercial mode - and it does not say that the capture is always this foreign key. 24.7.3 separates the **carrier identity mode** from the commercial mode and names two: a *"registered active courier/station"*, and an *"approved informal agent mode"* whose *"approved driver/agent identity and evidence"* are *"defined by technical design"*. 35.9(9) repeats the pair.
             *     **So this is optional in the schema and that is not a weakening.** Making it required would forbid the informal-agent mode the frozen specification contemplates, and MSC-DEC-413 (closing OQ-140) decided that **Version 1 permits BOTH modes**. **Validation is possible**: MSC-DEC-417 (closing OQ-133) gave the courier and station register and the hub's approved-agent register their operations, so CARRIER_NOT_APPROVED is enforceable in both modes. *Superseded:* whether Version 1 permits the informal-agent mode was a PRODUCT decision owned by OQ-140, and the capture was unvalidatable because CourierProvider had no operations.
             *     5.50 read *"Required by the signed guard in both modes"* beside a nullable optional field. Corrected at Rider Four-Pass R1.1: the guard requires a capture, this field is one way to make it, and the set of permitted ways was decided at MSC-DEC-413.
             */
            courier_provider_id?: string | null;
            /** @description APPROVED_AGENT mode only - the agent's phone number, which the server resolves to an ACTIVE ApprovedAgent at the rider's hub whose identity photo is stored. The rider never reads the agent register. */
            agent_phone?: string | null;
            /** @description The third party's own waybill - REGISTERED mode only. WAYBILL_REQUIRED refuses a registered capture without one. */
            waybill_reference?: string;
            /**
             * Format: uuid
             * @description The mandatory receipt/handoff photograph (34.5, 24.7.1). **Must already be STORED** - state-machines.md 17 forbids referencing a PENDING_UPLOAD record, so a photo still uploading cannot complete a handoff.
             */
            evidence_id: string;
        };
        /**
         * @description A covered-mode outcome, recorded by Ops. reason_code comes from the
         *     DELIVERY_FAILURE catalogue and is required for FAILED, and for RETURNED unless the record
         *     is already FAILED with a reason.
         */
        HandoffOutcomeRecord: {
            /** @enum {string} */
            outcome: "IN_TRANSIT" | "DELIVERED" | "FAILED" | "RETURNED";
            reason_code?: string | null;
            note?: string | null;
        };
        /**
         * @description An entry in 24.7's approved courier/station register. **Approved while
         *     ACTIVE**; deactivation never deletes.
         */
        CourierProvider: {
            /** Format: uuid */
            id: string;
            name: string;
            /** @enum {string} */
            kind: "COURIER" | "STATION";
            contact_phone?: string | null;
            location_note?: string | null;
            /** @enum {string} */
            status: "ACTIVE" | "INACTIVE";
            /** Format: uuid */
            registered_by?: string;
            /** Format: date-time */
            registered_at: string;
            /** Format: uuid */
            status_changed_by?: string | null;
            /** Format: date-time */
            status_changed_at?: string | null;
            status_reason?: string | null;
        };
        CourierProviderRegister: {
            name: string;
            /** @enum {string} */
            kind: "COURIER" | "STATION";
            contact_phone?: string | null;
            location_note?: string | null;
        };
        /**
         * @description An informal driver or agent approved by hub Senior Ops. **Cannot take
         *     custody until identity_evidence_id is set**, and only for the approving hub's handoffs.
         */
        ApprovedAgent: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            approving_hub_id: string;
            full_name: string;
            phone: string;
            /** Format: uuid */
            identity_evidence_id?: string | null;
            /** @enum {string} */
            status: "ACTIVE" | "WITHDRAWN";
            /** Format: uuid */
            approved_by?: string;
            /** Format: date-time */
            approved_at: string;
            /** Format: uuid */
            withdrawn_by?: string | null;
            /** Format: date-time */
            withdrawn_at?: string | null;
            withdrawal_reason?: string | null;
        };
        ApprovedAgentApprove: {
            full_name: string;
            phone: string;
            /**
             * Format: uuid
             * @description A STORED COMPLIANCE_DOCUMENT photo of the agent's ID document - required before the agent can take custody, and attachable later.
             */
            identity_evidence_id?: string | null;
        };
        /**
         * @description **The evidence-backed custody transfer to an approved courier or station** (34.5, 24.7).
         *     Entity at domain-model.md 6.10, machine at state-machines.md 10 - **SIGNED 26 August 2026**,
         *     and without an operation until MSC-DEC-402.
         *
         *     **The two modes diverge here and the divergence is the most missed rule in the domain**.
         *     For STATION_DROP, HANDED_OVER is TERMINAL: Melarc's service completes and
         *     its fee is earned at verified handoff, and the third party's onward delivery is outside
         *     Melarc's tracked lifecycle entirely. For MELARC_COVERED_THIRD_PARTY_DELIVERY it is NOT
         *     terminal: Ops records the third party's outcome with recordHandoffOutcome, and FAILED is
         *     followed by RETURNED when the parcel is back (MSC-DEC-417, closing OQ-135). *Superseded:*
         *     the operations that would carry it further did not exist.
         */
        ThirdPartyHandoff: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            readonly order_id: string;
            /** Format: uuid */
            readonly delivery_stop_id?: string | null;
            /**
             * @description Snapshotted from the order at creation, never read live. It decides whether HANDED_OVER is terminal, which is to say it decides what a closed record means.
             * @enum {string}
             */
            readonly commercial_mode: "STATION_DROP" | "MELARC_COVERED_THIRD_PARTY_DELIVERY";
            /** @description The station or carrier name and its reference, as captured at the handoff. Non-null from HANDED_OVER. The registry link, where one applies, is the sibling courier_provider_id, which is a foreign key and not a capture. */
            readonly handed_to?: {
                name?: string;
                reference?: string | null;
            } | null;
            /** Format: uuid */
            readonly courier_provider_id?: string | null;
            /** @enum {string|null} */
            readonly identity_mode?: "REGISTERED" | "APPROVED_AGENT" | null;
            /** Format: uuid */
            readonly approved_agent_id?: string | null;
            readonly waybill_reference?: string | null;
            /** Format: uuid */
            readonly evidence_id?: string | null;
            /**
             * @description state-machines.md 10. PENDING_HANDOFF to HANDED_OVER is reached through recordCarrierHandoff; the outcome states are Ops' and are reached through recordHandoffOutcome (MSC-DEC-417, closing OQ-135). *Superseded:* only the first was reachable through this contract, and the outcome states had no operation.
             * @enum {string}
             */
            readonly state: "PENDING_HANDOFF" | "HANDED_OVER" | "IN_TRANSIT" | "DELIVERED" | "FAILED" | "RETURNED" | "CANCELLED";
            /** Format: uuid */
            readonly handed_over_by_rider_id?: string | null;
            /**
             * Format: date-time
             * @description Non-null from HANDED_OVER. **For a STATION_DROP this is the instant Melarc's fee is earned** (24.7.1) - the fee itself was collected before dispatch, so this marks the earning and never a collection.
             */
            readonly handed_over_at?: string | null;
            /** Format: uuid */
            readonly final_outcome_recorded_by_staff_id?: string | null;
            /** Format: date-time */
            readonly final_outcome_at?: string | null;
            /** @description Why a handoff reached FAILED or the parcel RETURNED (3.9). Mandatory on both. */
            readonly reason_snapshot?: Record<string, never> | null;
        };
        /**
         * @description **A vendor-level security/risk hold** (domain-model.md, machine at state-machines.md 21 -
         *     SIGNED, MSC-DEC-414). **Never readable by the vendor it concerns** (data-scope-registry.md
         *     4.3). An OPEN hold stops new business and keeps work in flight.
         */
        SecurityRiskHold: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            readonly vendor_organization_id: string;
            /** @enum {string} */
            readonly state: "OPEN" | "CLEARED";
            /**
             * Format: uuid
             * @description Platform Admin
             */
            readonly opened_by: string;
            /** Format: date-time */
            readonly opened_at: string;
            readonly open_reason: string;
            /** Format: uuid */
            readonly cleared_by?: string | null;
            /** Format: date-time */
            readonly cleared_at?: string | null;
            readonly clear_reason?: string | null;
        };
        /**
         * @description **Undelivered parcels coming back from a delivery run to the responsible hub**
         *     (domain-model.md 6.10, machine at state-machines.md 12.2 - SIGNED, MSC-DEC-410).
         *     Mirrors CashHandover: the rider declares, the hub receives, a mismatch opens a variance.
         */
        ParcelCustodyReturn: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            readonly delivery_run_id: string;
            /** Format: uuid */
            readonly rider_id: string;
            /** Format: uuid */
            readonly responsible_hub_id: string;
            /** @enum {string} */
            readonly state: "DECLARED" | "RECEIVED" | "VARIANCE_OPEN" | "CLOSED";
            /** Format: date-time */
            readonly declared_at: string;
            /**
             * Format: uuid
             * @description Hub Ops, and **never the rider_id**. Non-null from RECEIVED or VARIANCE_OPEN.
             */
            readonly received_by_staff_id?: string | null;
            /**
             * Format: date-time
             * @description **When Hub Ops recorded the physical comparison.** Non-null from RECEIVED or VARIANCE_OPEN. **Not a custody instant for the whole record**: a received line transfers custody at this moment, a MISSING line transfers none, and a line later dispositioned RECEIVED_LATE transfers at resolved_at. Renamed from received_at at OQ-129 R1.1, which found the old name asserting a transfer even where the hub received nothing.
             */
            readonly confirmed_at?: string | null;
            readonly variance_reason_code?: string | null;
            /** Format: uuid */
            readonly resolved_by_staff_id?: string | null;
            /** Format: date-time */
            readonly resolved_at?: string | null;
            readonly lines?: components["schemas"]["ParcelCustodyReturnLine"][];
        };
        ParcelCustodyReturnLine: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            order_id: string;
            declared_by_rider: boolean;
            received_by_hub?: boolean | null;
            /**
             * @description MISSING is a named parcel the hub cannot find; UNDECLARED is one it holds that was not named. **Kept apart deliberately** - collapsing them hides a loss inside a clerical error.
             * @enum {string}
             */
            line_state: "DECLARED" | "RECEIVED" | "MISSING" | "UNDECLARED" | "RESOLVED";
            /**
             * @description **What was decided about an open line.** Mandatory at RESOLVED and null before it. A reason says why the line is open; this says what was decided (OQ-129 R1).
             * @enum {string|null}
             */
            disposition?: "RECEIVED_LATE" | "CONFIRMED_NOT_RECEIVED" | "DECLARATION_CORRECTED" | null;
            reason_code?: string | null;
            note?: string | null;
        };
        ParcelCustodyReturnCreate: {
            /** Format: uuid */
            delivery_run_id: string;
            /** @description Every undelivered order still aboard. **No state field and no received flag**: the rider declares what they are carrying and the hub decides what it received. */
            order_ids: string[];
        };
        ParcelCustodyReturnConfirm: {
            /** @description What the hub physically has. May be empty, and may include orders the rider did not name - **each of which must still be eligible for this run**, or ORDER_NOT_ON_RUN. */
            received_order_ids: string[];
            /** @description **Mandatory where the received set differs from the declared set** - REASON_REQUIRED otherwise. */
            variance_reason_code?: string | null;
            note?: string | null;
        };
        /**
         * @description **A reason explains why a line is open; a disposition records what was decided about it.**
         *     The terminal state says the decision is recorded, so the schema must be able to tell the
         *     decisions apart - a reason code alone cannot.
         */
        ParcelCustodyVarianceResolution: {
            lines: {
                /** Format: uuid */
                order_id: string;
                /**
                 * @description **What was decided, and each value is a different custody outcome.** RECEIVED_LATE - the parcel was produced and custody transferred; the line becomes RESOLVED and, where the order is ATTEMPT_FAILED, it moves to AT_HUB_AFTER_FAILURE as a confirmed line does. CONFIRMED_NOT_RECEIVED - custody did **not** reach the hub; the line is RESOLVED as a recorded non-arrival and **no order state moves**. DECLARATION_CORRECTED - the line was a clerical error and **no parcel moved**: either a named parcel that was never aboard, or an UNDECLARED one reconciled to the run it belongs to. **What follows a CONFIRMED_NOT_RECEIVED is not decided here** - the damage, loss and claims apparatus is OQ-004's, and this field records the custody fact rather than opening a claim.
                 * @enum {string}
                 */
                disposition: "RECEIVED_LATE" | "CONFIRMED_NOT_RECEIVED" | "DECLARATION_CORRECTED";
                reason_code: string;
                note?: string | null;
            }[];
        };
        /** @description The sibling record to Redelivery at the identical decision point, AT_HUB_AFTER_FAILURE (domain-model.md 6.14, MSC-DEC-332). SLICE-006 Pass 1 models Sec28.1-28.4; MSC-DEC-394 (17 September 2026) decided and built partial waiver and no-cancellation into this schema, and decided a vendor's refusal as policy (escalates to Senior Ops, Sec28.7) without a schema change. Invalid/inaccessible phone number and exceptional OTP recovery (Sec28.5) and the damage/loss/claims apparatus (Sec28.6) remain OQ-004/OQ-042/OQ-084's, not this schema's. */
        ReturnRecord: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            order_id: string;
            /**
             * Format: uuid
             * @description The most recent failed physical DeliveryStop, where one exists. Null when the order reached AT_HUB_AFTER_FAILURE via a cancelled Redelivery rather than a fresh failed attempt - the failed stop of record is already linked from that Redelivery.
             */
            originating_delivery_stop_id?: string | null;
            /** Format: uuid */
            readonly committed_by_staff_id?: string;
            /**
             * Format: date-time
             * @description The snapshot moment. The obligation is created here and nowhere earlier.
             */
            readonly committed_at: string;
            /**
             * @description DERIVED from which of the order's vendor_organization_id / ad_hoc_sender_id is set (Sec5.2.4, Sec28.4). Never chosen by Ops. STATEMENT settles through the future VendorStatement mechanism and creates no OperationalPaymentDemand here.
             * @enum {string}
             */
            readonly settlement_path: "STATEMENT" | "IMMEDIATE_DEMAND";
            /** @description SNAPSHOTTED from the hub's flat_return_fee_amount at commit. Always populated - the fee is charged by default, never conditionally zeroed the way Redelivery.chargeable is. */
            readonly return_fee_minor: number;
            /** @enum {string} */
            waiver_status: "NOT_REQUESTED" | "REQUESTED" | "APPROVED" | "REJECTED";
            /** @description A ReturnFeeWaiverReason value. Mandatory from REQUESTED onward. */
            waiver_reason_code?: string | null;
            /** @description Proposed by Ops at REQUESTED. Senior Ops approves or rejects it as a whole at APPROVED/REJECTED - never edits it. 0 < waiver_amount_minor <= return_fee_minor. Mandatory from REQUESTED onward. */
            waiver_amount_minor?: number | null;
            /** Format: uuid */
            waiver_requested_by_staff_id?: string | null;
            /**
             * Format: uuid
             * @description Never equal to waiver_requested_by_staff_id (Sec28.4, MSC-DEC-163).
             */
            waiver_approved_by_staff_id?: string | null;
            /** Format: date-time */
            waiver_decided_at?: string | null;
            /** @description DERIVED - return_fee_minor minus waiver_amount_minor where waiver_status = APPROVED (a full waiver is waiver_amount_minor = return_fee_minor, giving zero), else return_fee_minor. Never independently set. Senior Ops discretion, no formula (Sec5.2.4, MSC-DEC-394). */
            readonly effective_return_fee_minor: number;
            /** Format: uuid */
            delivery_run_id?: string | null;
            /**
             * Format: uuid
             * @description Set when the return trip is built - the existing transport machinery - not a new one.
             */
            delivery_stop_id?: string | null;
            /** Format: date-time */
            otp_validated_at?: string | null;
            /**
             * @description No CANCELLED value - decided by MSC-DEC-394, not omitted: a committed ReturnRecord always runs to completion.
             * @enum {string}
             */
            status: "COMMITTED" | "IN_TRANSIT" | "COMPLETED";
        };
        /**
         * @description **No timer field exists here, deliberately**. wait_started_at and
         *     wait_expires_at are server-written; a client cannot post an expiry, and the failure guard
         *     reads authoritative time rather than a rider's claim that ten minutes passed.
         */
        RecipientContactRecord: {
            /** @enum {string} */
            outcome: "SUCCESSFUL" | "UNSUCCESSFUL";
            /** @description Mandatory when UNSUCCESSFUL. Must be an ACTIVE reason valid for THIS checkpoint - REASON_NOT_VALID_FOR_CHECKPOINT otherwise. A PRE_DISPATCH reason is not selectable at a doorstep. **The seeded five**: NO_ANSWER, NUMBER_INCORRECT, RECIPIENT_DECLINED and CONTACT_NOT_POSSIBLE_MELARC at all three checkpoints, **RECIPIENT_NOT_AT_LOCATION at DOORSTEP only**. **consumes_delivery_attempt is false on all five and nothing reads it here**: only a DeliveryStop outcome increments Order.delivery_attempts, so a DOORSTEP contact failure is not a physical delivery attempt - the wait expiring and failDeliveryStop is. */
            reason_code?: string;
            contact_number_used?: string;
            note?: string;
        };
        RecipientContactAttempt: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            order_id: string;
            /** Format: uuid */
            delivery_stop_id?: string | null;
            /**
             * @description THREE CONTACT CHECKPOINTS, NOT THREE DELIVERY TRIPS. Only DOORSTEP is reached by a rider who travelled, and only DOORSTEP can consume a physical attempt.
             * @enum {string}
             */
            checkpoint: "PRE_DISPATCH" | "NEXT_STOP" | "DOORSTEP";
            /** Format: uuid */
            performed_by_staff_id?: string;
            /**
             * @description Either may perform PRE_DISPATCH, on the same canonical record. A rider is never made to repeat a call Ops already made.
             * @enum {string}
             */
            performed_by_actor_type: "RIDER" | "OPS";
            /** Format: date-time */
            performed_at: string;
            contact_number_used?: string | null;
            /** @enum {string} */
            outcome: "SUCCESSFUL" | "UNSUCCESSFUL";
            reason_code?: string | null;
            /**
             * @description A FAILED send is a visible operational state, never a deletion. The contact event survives a notification that never arrived.
             * @enum {string|null}
             */
            vendor_notification_state?: "NOT_REQUIRED" | "REQUIRED" | "QUEUED" | "SENT" | "FAILED" | "ACKNOWLEDGED" | null;
            /** @enum {string|null} */
            ops_followup_state?: "NOT_REQUIRED" | "REQUIRED" | "IN_PROGRESS" | "RESOLVED" | null;
            /**
             * Format: date-time
             * @description DOORSTEP only. SERVER-SET.
             */
            readonly wait_started_at?: string | null;
            /**
             * Format: date-time
             * @description DOORSTEP only. SERVER-DERIVED as wait_started_at + doorstep_wait_minutes. The failure guard reads this, and DOORSTEP_WAIT_NOT_ELAPSED refuses an early failure.
             */
            readonly wait_expires_at?: string | null;
            note?: string | null;
        };
        /**
         * @description **An input awaiting Ops, not a correction applied on arrival**. Nothing here
         *     mutates the recipient record.
         */
        VendorContactAssistance: {
            /** @enum {string} */
            response_type: "CORRECTED_NUMBER" | "ALTERNATIVE_CONTACT" | "CLARIFICATION" | "NO_FURTHER_INFORMATION";
            contact_number?: string;
            contact_name?: string;
            note?: string;
        };
        /**
         * @description **The original destination is never overwritten**. This records what was
         *     asked for; Ops decides what is authorised.
         */
        DeliveryLocationChangeRequest: {
            requested_location: components["schemas"]["Location"];
            /** @enum {string} */
            requested_by?: "RECIPIENT" | "VENDOR";
            note?: string;
        };
        /**
         * @description **Only CONFIRMED makes an order run-eligible.** Reschedule, address correction and
         *     unreachable all hold it - three outcomes, one effect, and none of them a failure.
         *
         *     **Either the assigned Rider or authorised Ops writes this record**; the
         *     canonical per-attempt row is RecipientContactAttempt with checkpoint PRE_DISPATCH, and
         *     confirmation_attempts is its projection here. **There is no fixed call ceiling**.
         *
         *
         *     36.8 warns that the approved product policy "does not approve the complete state model".
         *     The machine at state-machines.md 11 was signed by MSC-DEC-233 on 21 August against a
         *     three-call ceiling; MSC-DEC-351 retired it, and **seven rows are AMENDED and await
         *     Product Owner re-signature**. *Superseded description:* a reasoned set rather than a
         *     signed one.
         */
        RecipientConfirmation: {
            /** Format: uuid */
            order_id: string;
            /** @enum {string} */
            state: "AWAITING_ATTEMPT" | "ATTEMPTED_NO_ANSWER" | "CONFIRMED" | "DETAILS_CORRECTION_REQUIRED" | "REFUSED" | "ESCALATED" | "MAX_ATTEMPTS_REACHED";
            confirmation_attempts?: {
                /** Format: date-time */
                attempted_at?: string;
                /** Format: uuid */
                actor_id?: string;
                /**
                 * @description Who made the PRE_DISPATCH call. The rider's queue shows 'confirmed by Ops' from this, and does not call again.
                 * @enum {string}
                 */
                performed_by_actor_type?: "RIDER" | "OPS";
                outcome?: string;
                note?: string;
            }[];
            refined_location_note?: string | null;
            /**
             * Format: date-time
             * @description Set when OPS JUDGES the contact avenues exhausted - never by a call count reaching a number. MAX_ATTEMPTS_REACHED remains in the enum for 36.8 and no current transition enters it.
             */
            escalated_at?: string | null;
        };
        /**
         * @description No rider and no sequence at creation - both are separately permissioned steps, because
         *     each carries its own rule.
         */
        DeliveryRunCreate: {
            order_ids: string[];
            /** Format: date */
            service_date: string;
            /**
             * Format: uuid
             * @description 24.4's registered courier for the run, where Ops selects one. Must name an ACTIVE CourierProvider, and dispatch revalidates it (24.5).
             */
            courier_provider_id?: string;
        };
        /** @description The complete sequence, not a delta. Manual ordering only. */
        DeliveryStopOrder: {
            ordered_stop_ids: string[];
        };
        /**
         * @description **Hub-scoped, never vendor-scoped** - a run spans vendors.
         *
         *     assigned_at, dispatched_at and started_at are **three distinct moments** stored
         *     separately, because each governs a different rule.
         */
        DeliveryRun: {
            /** Format: uuid */
            id: string;
            code: string;
            /** @enum {string} */
            state: "DRAFT" | "DISPATCHED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
            /** Format: date */
            service_date: string;
            /** Format: uuid */
            responsible_hub_id: string;
            /** Format: uuid */
            assigned_rider_id?: string | null;
            /** Format: uuid */
            courier_provider_id?: string | null;
            /** Format: date-time */
            assigned_at?: string | null;
            /** Format: date-time */
            dispatched_at?: string | null;
            /** Format: date-time */
            started_at?: string | null;
            stops?: components["schemas"]["DeliveryStop"][];
        };
        /**
         * @description Six states - PickupStop's five plus AWAITING_RECIPIENT.
         *     Payment and OTP are **guards** on ARRIVED -> DELIVERED, not states, and the payment guard
         *     is the OperationalPaymentDemand being SETTLED. *Superseded description:*
         *     five states.
         *
         *     **payment_taken may be true on a FAILED stop, and that is why the field exists.** A rider
         *     takes payment, the OTP will not validate, 36.9 forbids handover, and the stop fails
         *     carrying cash. The money is held for hub reconciliation, not refunded at the door.
         *
         *     **Nothing may read `state` to decide what a rider is holding.** A FAILED delivery stop and
         *     a FAILED pickup stop are identical here and are not identical in fact.
         *
         *     **failure_reason_code is a catalogue reference, not a closed enum**. The five
         *     seeded reasons were chosen because each ROUTES differently at the Ops queue,
         *     since 25.3 requires the reason to be adjudicable - and that routing test governs what may
         *     be ADMITTED to the catalogue, not whether anything may be. *Superseded description:* a
         *     closed enum of five.
         *
         *     **otp_overridden is not the same thing as failure_reason_code OTP_NOT_VERIFIED.** One
         *     records a stop that COMPLETED without OTP, the other a stop that FAILED. Collapsing them
         *     hides every override inside the failure statistics - exactly where MSC-DEC-197's frequency
         *     control would stop working.
         *
         *     `sequence` is a plan, not a constraint - a rider may work stops out of order.
         */
        DeliveryStop: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            order_id: string;
            sequence: number;
            /**
             * @description SIX states (state-machines.md 12.1). AWAITING_RECIPIENT is the server-timed doorstep wait after a failed DOORSTEP contact; the stop returns to ARRIVED when the recipient appears before expiry, or may FAIL after it.
             * @enum {string}
             */
            state: "PENDING" | "ARRIVED" | "AWAITING_RECIPIENT" | "DELIVERED" | "FAILED" | "SKIPPED" | "HANDED_OVER";
            refined_location_note?: string | null;
            /** Format: date-time */
            arrived_at?: string | null;
            /** Format: date-time */
            closed_at?: string | null;
            /** @description The ACTIVE Delivery Failure Reason Catalog code selected at the door, snapshotted. Not a closed enum: the five seeded defaults are RECIPIENT_UNAVAILABLE, ACCESS_DENIED, RECIPIENT_REFUSED, PAYMENT_NOT_COMPLETED and OTP_NOT_VERIFIED, and an approved operational reason may be added without a contract change. Mandatory on FAILED. */
            failure_reason_code?: string | null;
            /** @description Snapshot of the selected reason's consumes_delivery_attempt at the moment of failure. History, never a position against a maximum - none exists. */
            readonly consumed_delivery_attempt?: boolean | null;
            payment_taken?: boolean;
            otp_overridden?: boolean;
        };
        /**
         * @description The minimal projection `listAssignableStaffRoleBundles` returns (MSC-DEC-439; `RoleBundle` at
         *     domain-model.md 6.9). **No permission, no permission count and no holder is ever represented**:
         *     neither is needed to fill a form, and a maker below Platform Admin does not hold `permission.read`;
         *     the read that returns this projection is gated by `permission.assignable_bundle.read`.
         *
         *     `requires_platform_admin_approval` reports the approval policy and grants nothing - the same
         *     flag that makes a Senior Ops approver `INSUFFICIENT_AUTHORITY` at `approveStaffIdentity`.
         */
        AssignableStaffRoleBundle: {
            /**
             * Format: uuid
             * @description The value createStaffIdentity takes as role_bundle_id.
             */
            id: string;
            /** @description The display name the maker sees. */
            name: string;
            /** @description True when approving a profile that holds this bundle needs a Platform Admin. */
            requires_platform_admin_approval: boolean;
        };
        /**
         * @description **No `status` property, and that is the guard.** A settable status would let a caller create
         *     a record directly in `ACTIVE` and bypass 30.8's independent approval entirely - the whole
         *     control this operation exists to implement. Creation always lands in `PENDING_APPROVAL`.
         *
         *     **No `created_by` either.** The maker is the authenticated caller, read from the session.
         *     A settable creator would defeat the same-actor exclusion by letting an approver name someone
         *     else as the creator and then approve their own work.
         *
         *     `role_bundle_id` is required because `StaffIdentity.role_bundle_id` is non-null: 30.8 has the
         *     checker approve the person and their authority together. **Its producer is
         *     `listAssignableStaffRoleBundles`**.
         */
        StaffIdentityCreate: {
            /**
             * @description Compared in its canonical form: trimmed, Unicode NFKC-normalised and lower-cased as a whole
             *     address, with no dot or plus-tag folding. The same form decides uniqueness and keys the
             *     rate limit. The address is stored and displayed as entered.
             *     The address is canonicalised first and only then checked to be an email address, which is
             *     `VALIDATION_FAILED` (`400`) when it is not. This schema carries no `format: email`, because
             *     that would refuse a padded or non-ASCII address before it could be canonicalised.
             */
            work_email: string;
            full_name: string;
            /** @description E.164 */
            phone?: string;
            /**
             * Format: uuid
             * @description An id returned by listAssignableStaffRoleBundles. One that names no bundle currently valid for human staff is VALIDATION_FAILED.
             */
            role_bundle_id: string;
            /** Format: uuid */
            primary_hub_id?: string;
        };
        /**
         * @description `approved: false` rejects, and `reason_code` becomes mandatory - `REASON_REQUIRED`.
         *
         *     **The bundle cannot be changed here.** There is no `role_bundle_id` property: an approver who
         *     could substitute a different bundle at the moment of approval would be granting authority
         *     nobody proposed and nobody else reviewed, which is single-actor authority wearing a
         *     maker-checker shape. Approving a different bundle means rejecting and creating again.
         */
        StaffIdentityApproval: {
            approved: boolean;
            /**
             * @description Mandatory on rejection (`approved: false`). A code of the reason catalogue
             *     (`ReasonDefinition`), validated against the catalogue's identity domain for this operation:
             *     empty is `REASON_REQUIRED`, and a code that is unknown, retired or in another domain is
             *     `REASON_NOT_ACTIVE`.
             */
            reason_code?: string;
            note?: string;
        };
        /**
         * @description **No `from_role_bundle_id`.** The bundle in force is read from the record, never submitted.
         *     A client-supplied origin is the field that makes a stale proposal apply silently against a
         *     bundle that has since changed - the same reasoning that keeps an origin off
         *     `RunCustodyHandoverCreate`.
         *
         *     Confirmed 26 August 2026 - MSC-DEC-248, signed under MSC-DEC-253.
         */
        BundleChangeProposal: {
            /** Format: uuid */
            to_role_bundle_id: string;
            reason_code: string;
            note?: string;
        };
        /**
         * @description Ratifies or refuses the proposal as made. **No bundle field**, for the reason
         *     `StaffIdentityApproval` carries none: an approver who can alter what they approve is not a
         *     checker.
         *
         *     Confirmed 26 August 2026 - MSC-DEC-248, signed under MSC-DEC-253.
         */
        BundleChangeApproval: {
            approved: boolean;
            note?: string;
        };
        /**
         * @description The permission-review record 30.3 requires - "permission-review history" - carrying both
         *     actors so the same-actor exclusion is auditable after the fact rather than only enforced at
         *     the call. It feeds `StaffIdentity.permission_review_history`.
         */
        BundleChange: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            staff_identity_id: string;
            /** Format: uuid */
            from_role_bundle_id: string;
            /** Format: uuid */
            to_role_bundle_id: string;
            /** @enum {string} */
            state: "PROPOSED" | "APPROVED" | "REJECTED";
            /** Format: uuid */
            proposed_by: string;
            /** Format: uuid */
            approved_by?: string | null;
            reason_code?: string;
            /** Format: date-time */
            proposed_at?: string;
            /** Format: date-time */
            decided_at?: string | null;
        };
        /**
         * @description Entity at domain-model.md 6.8; machine at state-machines.md 13.3.
         *
         *     **`PENDING_APPROVAL` and `REJECTED` were added on 24 August**. The enum began
         *     at `ACTIVE`, so a profile created under 30.8 and awaiting its independent approval had no
         *     state to occupy and the rule was inexpressible in the contract - CONFLICT-036.
         *
         *     **No credential property, ever.** Hashed, never retrievable, never logged (6.8).
         */
        StaffIdentity: {
            /** Format: uuid */
            id: string;
            /**
             * @description As entered. Compared in its canonical form: trimmed, Unicode NFKC-normalised and
             *     lower-cased as a whole address, with no dot or plus-tag folding. The same form decides
             *     uniqueness and keys the rate limit. The address is stored and displayed as entered.
             */
            work_email: string;
            full_name: string;
            phone?: string | null;
            /** @enum {string} */
            status: "PENDING_APPROVAL" | "ACTIVE" | "REJECTED" | "SUSPENDED" | "OFFBOARDED";
            /** Format: uuid */
            role_bundle_id: string;
            /** Format: uuid */
            primary_hub_id?: string | null;
            mfa_enrolled: boolean;
            /** Format: uuid */
            created_by: string;
            /** Format: uuid */
            approved_by?: string | null;
        };
        /**
         * @description **The target hub and nothing else - and at R1.1 that is now literally true.** R1 declared
         *     the rule and carried a second free-text `note` property beside it, so the guard the
         *     schema stated was not the guard it implemented. `responsible_hub_id` is not accepted,
         *     and neither is any other input: the server derives the resulting scope from the target
         *     hub it validated the actor against, and `additionalProperties: false` now stops a
         *     caller smuggling anything alongside the one property the operation reads.
         *
         *     **No reason-code vocabulary is invented here**. Where the canonical override
         *     and audit rules already impose a reason, that rule applies unchanged.
         */
        PickupRequestHubReassignment: {
            /** Format: uuid */
            target_hub_id: string;
        };
        /**
         * @description **A temporary bearer capability, and it is treated as one.** It is never logged, never
         *     cached, never persisted and never returned in an audit payload - the same rule the session
         *     credential and the OTP already follow (38.2, 20.4).
         *
         *     **`storage_ref` is still absent**, here as everywhere. Returning it would hand a client the
         *     address to construct its own retrieval and bypass `access_rule` entirely, which is the
         *     reason it is absent from both the create and the read schema.
         */
        EvidenceRetrievalAuthorization: {
            /** @description HTTP method the client uses to fetch the one object */
            method: string;
            /**
             * @description **Opaque, single-object, short-lived.** The client does not parse, modify or construct
             *     it. Changing the object key invalidates the signature; it confers no listing authority
             *     and expires with `expires_at`.
             */
            url: string;
            /** @description Non-secret request headers the client must echo. Never a credential */
            headers?: {
                [key: string]: string;
            };
            /**
             * Format: date-time
             * @description `evidence_retrieval_authorization_ttl_minutes` from issue - **5 minutes**.
             */
            expires_at: string;
        };
        /**
         * @description **No `storage_ref` property, and that is the guard.** The storage reference is assigned by the
         *     server. A client that could set it could point an evidence record at an object belonging to
         *     another vendor, another hub, or another parcel - and the record would look entirely legitimate.
         *
         *     **No `access_rule` or `retention_policy` either.** Both are derived server-side from
         *     `owner_type` and `purpose`. A caller choosing its own retention would be setting data-protection
         *     policy per upload; periods are OQ-028 and the classification is not the client's.
         *
         *     **No `state`.** Creation always lands in `PENDING_UPLOAD`.
         */
        EvidenceCreate: {
            /** @enum {string} */
            owner_type: "PICKUP_STOP" | "PICKUP_INTAKE" | "ORDER" | "DELIVERY_STOP" | "THIRD_PARTY_HANDOFF" | "MOTORCYCLE" | "FUEL_RECORD" | "VENDOR_ORGANIZATION" | "APPROVED_AGENT";
            /** Format: uuid */
            owner_id: string;
            /** @enum {string} */
            purpose: "COLLECTION_PROOF" | "CONDITION" | "OSD" | "HANDOFF_RECEIPT" | "DELIVERY_PROOF" | "RETURN_PROOF" | "MAINTENANCE" | "FUEL" | "COMPLIANCE_DOCUMENT";
            /**
             * Format: date-time
             * @description **Field capture time, not upload time** (3.6). The rider app works under unreliable
             *     connectivity (7.8) and evidence routinely arrives hours later. Rejected if in the future.
             */
            captured_at: string;
            device_context?: {
                [key: string]: unknown;
            };
            content_type: string;
            byte_size: number;
            checksum_sha256: string;
        };
        EvidenceUploadTicket: {
            evidence: components["schemas"]["Evidence"];
            upload: components["schemas"]["EvidenceUploadInstruction"];
        };
        /**
         * @description **Deliberately opaque, and this is the design decision worth reviewing.** 39.4 requires the
         *     contract to define **upload initiation**, and OQ-048 recorded that the operation's shape
         *     "depends on the storage mechanism, presigned upload versus multipart."
         *
         *     This envelope satisfies the first without deciding the second: a presigned `PUT`, a presigned
         *     form `POST`, and a direct multipart endpoint all express as `method` + `url` + optional
         *     `headers`/`form_fields`. **The client follows instructions rather than knowing a mechanism**,
         *     so choosing the provider later changes no schema and breaks no client.
         *
         *     **The provider choice remains OQ-048.** What left OQ-048 is the *initiation contract*, which
         *     39.4 assigns to this document and 50.2 files as approved downstream design.
         */
        EvidenceUploadInstruction: {
            /** @description HTTP method the client uses to send the bytes */
            method: string;
            /** @description Opaque destination. The client does not parse or construct it */
            url: string;
            headers?: {
                [key: string]: string;
            };
            /** @description Present for form-style uploads; absent otherwise */
            form_fields?: {
                [key: string]: string;
            };
            /** Format: date-time */
            expires_at: string;
        };
        /**
         * @description Entity at domain-model.md 3.6; lifecycle at state-machines.md 17.
         *
         *     **`storage_ref` is absent from the read schema as well as the write schema.** 34.7 calls it an
         *     opaque storage reference; returning it would hand every client a key to construct its own
         *     retrieval URL, bypassing `access_rule` entirely. Retrieval is a separate operation gated by
         *     that rule - **and it is not written**, because 39.4's "access URLs" element binds to the
         *     storage service. OQ-091.
         *
         *     **The two scope columns are read-only and derived, and they duplicate a fact the owner
         *     already holds.** That duplication is deliberate. 5.6 chose one polymorphic
         *     entity and recorded the cost as a reference "the database cannot constrain by foreign
         *     key" - a modelling inconvenience. Under row-level security it is a security property: a
         *     policy cannot follow owner_type/owner_id into eight different parent tables, so with no
         *     direct column the only enforceable answer is application-level filtering, which
         *     SOLUTION_ARCHITECTURE.md 6 rejects by name.
         *
         *     **Gate B hardens the envelope and does not touch the lifecycle.** state-machines.md 17
         *     remains UNSIGNED.
         *
         *     **`owner_type` and `owner_id` are immutable after creation.** Re-pointing evidence at a
         *     different record rewrites what the record proves, which 35.1.5 forbids for historical
         *     transactions.
         */
        Evidence: {
            /** Format: uuid */
            id: string;
            owner_type: string;
            /** Format: uuid */
            owner_id: string;
            /**
             * Format: uuid
             * @description **Derived from the owner at creation and immutable**. The field the
             *     Hub row-level-security policy reads. Absent from EvidenceCreate for the same reason
             *     storage_ref is: a client that could set it would place a record in another hub's scope.
             *
             *     **NULL exactly when `owner_type = VENDOR_ORGANIZATION`**. That owner
             *     has no hub, and R0's non-null rule forced an implementer to invent one - an invented
             *     hub is a real access grant, because whichever hub was chosen could read the object
             *     and the vendor's other hubs could not. Vendor ownership is the whole boundary there.
             */
            readonly responsible_hub_id?: string | null;
            /**
             * Format: uuid
             * @description **Derived from the owner at creation and immutable.** Null where the owner is
             *     vendor-neutral - MOTORCYCLE, FUEL_RECORD and APPROVED_AGENT evidence belongs to no
             *     vendor, and domain-model.md 4 already records PickupManifest and DeliveryRun as
             *     deliberately not vendor-owned.
             */
            readonly vendor_organization_id?: string | null;
            purpose: string;
            /** Format: date-time */
            captured_at: string;
            /** Format: uuid */
            captured_by_actor: string;
            device_context?: {
                [key: string]: unknown;
            } | null;
            /** @enum {string} */
            state: "PENDING_UPLOAD" | "STORED" | "EXPIRED";
            access_rule: string;
            retention_policy: string;
            content_type?: string | null;
            byte_size?: number | null;
            /** Format: date-time */
            uploaded_at?: string | null;
        };
        /**
         * @description **amount_minor is the physical tender actually taken, and nothing else.** It may be short
         *     of the demand's remaining due, equal to it, or over it: a short
         *     tender is preserved as a receipt and custody of that amount, never refused. What the
         *     rider may not do is record more than they physically hold - custody is accountability.
         *
         *     **No expected_minor field.** The expectation was snapshotted at dispatch (domain-model.md
         *     6.11) and comparing the collection against a client-supplied expectation would make the
         *     check a transcription rather than a comparison - the same reasoning that keeps the rider's
         *     declared parcel count off HubIntakePreCount.
         *
         *     **No order_id either** - the stop identifies the order. A settable order would let a
         *     collection be recorded against a parcel the rider is not standing in front of.
         */
        CashCollection: {
            amount_minor: number;
            /**
             * Format: uuid
             * @description REQUIRED where a provider attempt is unresolved. Created by authorised OPS - a rider supplies the id and can never issue one. The grant must authorise CASH for this demand and that attempt, and this collection CONSUMES it.
             */
            fallback_authorization_id?: string;
            note?: string;
        };
        /**
         * @description **The OTP is submitted and never returned, logged or audited** (20.4). The audit records that
         *     validation occurred, with actor and timestamp, and never the value - the identical rule the
         *     collection handshake carries.
         *
         *     **No recipient identity fields.** 25.1 rules out receiver name, relationship, signature and
         *     delivery photograph for Version 1. Possession and validation of the OTP IS the approved
         *     authorization and proof; adding a second identity capture would create a competing
         *     authorization model beside the approved one.
         */
        DeliveryOtpSubmission: {
            otp: string;
        };
        /**
         * @description Senior Ops authorising 25.1's extraordinary handover.
         *
         *     **No otp field.** This operation exists precisely because no valid OTP is available; a
         *     schema accepting one would let the override be used to submit a code the backend would
         *     otherwise have rejected.
         *
         *     **Reason is mandatory and the emitted event is enhanced.** The control on this path is that
         *     its FREQUENCY stays visible, not that its reason text is persuasive.
         */
        OtpOverrideAuthorisation: {
            reason_code: string;
            note?: string;
        };
        /**
         * @description **The reason is a catalogue reference, not a closed enum** - amended at Gate C R1.
         *     The five seeded reasons remain and remain routing-distinct; what changed is
         *     that adding an approved operational reason no longer requires a code deployment, and the
         *     CONSEQUENCE of a reason is read from the reason.
         *
         *     **Attempt consumption is not in this payload and never was a rider's choice.** The
         *     catalogue entry carries `consumes_delivery_attempt`, so a Melarc outage records a failure
         *     without consuming a physical attempt against the customer - and a consumed
         *     attempt is history, not a position against a ceiling, because none exists.
         *
         *     **The selected code is snapshotted onto the record** (3.7). Deactivating a reason later
         *     never makes an old failure unreadable, and a changed display label never rewrites history.
         *
         *     **No terminal flag and no return trigger.** RECIPIENT_REFUSED consumes an attempt because
         *     its catalogue entry says so, and routes to the Ops decision queue. **Formal Return starts
         *     only when authorised Ops commits a ReturnRecord** - never because a counter
         *     reached three.
         */
        DeliveryFailure: {
            /** @description An ACTIVE code from the Delivery Failure Reason Catalog. The server rejects an unknown code, an INACTIVE code, and a code belonging to another reason domain. The reason - not this request - decides whether the customer's delivery attempt is consumed. */
            reason_code: string;
            note?: string;
            contact_attempts?: components["schemas"]["ContactAttempt"][];
            /**
             * @description Each id must name an evidence record in STORED (EVIDENCE_NOT_STORED otherwise).
             *     Whether evidence is REQUIRED is read from the reason definition.
             */
            evidence_ids?: string[];
        };
        /** @description First-use identity for a sender who has never used Melarc. Creating the reusable AdHocSender profile and the PickupRequest is one idempotent act - a retry must not mint a second sender identity. */
        NewAdHocSender: {
            name: string;
            /** @description E.164, normalised; as-entered form retained server-side - the same shape every other phone field in this contract declares. It carried a $ref to a `Phone` schema that HAS NEVER EXISTED here, so a generated client broke on it (Gate C C1.6, Check 45). The verified phone identity. 29.6, MSC-DEC-172 makes this the sender's identity and MSC-DEC-258 attaches blocking to it, so it is also how a returning sender is found. */
            phone: string;
            business_name?: string | null;
            pickup_contact_name?: string | null;
            pickup_location?: components["schemas"]["Location"];
        };
        /** @description The third party a COLLECT_FOR_VENDOR pickup collects from. Required for that intent and forbidden for the others. */
        CollectionPoint: {
            /** @description Pickup person or business */
            contact_name: string;
            /** @description E.164, normalised. Second of the two dangling `Phone` references corrected at Gate C C1.6. */
            phone: string;
            location: components["schemas"]["Location"];
            /** @description Where coordinates are unavailable */
            landmark?: string | null;
        };
        CollectionReference: {
            /** @description The name the seller holds the item under */
            reference_name: string;
            seller_order_reference?: string | null;
        };
        CollectionItem: {
            description: string;
            quantity: number;
            /**
             * Format: uuid
             * @description Picture of the item, where the sender supplied one.
             */
            evidence_id?: string | null;
            handling_note?: string | null;
        };
        /**
         * @description **The server applies eligible COLLECTION_CASH road expenses as part of opening**, and
         *     returns the handover already carrying applied_road_expense_ids, applied_expense_minor
         *     and system_expected_minor. No field here supplies any of them.
         *
         *     **declared_total_minor is stated by the rider and is not validated against the sum of
         *     custody_ids.** The two figures exist to be compared by the hub (26.3); making the system
         *     derive one from the other would destroy the comparison it is required to perform.
         */
        CashHandoverOpen: {
            /** Format: uuid */
            hub_id: string;
            declared_total_minor: number;
            custody_ids: string[];
        };
        /**
         * @description The hub's own figure. **variance_reason_code is mandatory when confirmed_total_minor
         *     differs from system_expected_minor** - REASON_REQUIRED otherwise.
         *
         *     **Variance is counted MINUS system expected, never counted minus declared**.
         *     Expected 125 / declared 125 / counted 125 is clean. Expected 125 / declared 100 /
         *     counted 100 is a variance of -25 even though the rider and the hub agree - agreement
         *     between two figures neither of which is authoritative proves nothing. Expected 125 /
         *     declared 125 / counted 120 is a variance of -5 the rider never disclosed.
         *
         *     **The rider's declaration is a separate assertion**, kept and separately auditable: it
         *     is what the rider SAID, and a shortfall against it is a disclosure, not the variance.
         *
         *     **The declared total is visible to the confirming officer** (MSC-DEC-254, closing OQ-092).
         *     This diverges from 22.4's blind parcel count deliberately: two actors survive, blindness does
         *     not, and unlike parcels, cash stays countable after receipt.
         */
        CashHandoverConfirm: {
            confirmed_total_minor: number;
            variance_reason_code?: string;
            note?: string;
        };
        /**
         * @description **No adjustment amount.** The variance is already recorded as the difference between two
         *     stated figures; a settable amount here would let the disposition silently rewrite what was
         *     counted. 26.3 requires collection, custody, handover, receipt, variance, correction and
         *     closure to be separate auditable events - not one field that reconciles itself.
         */
        CashVarianceResolution: {
            reason_code: string;
            note?: string;
        };
        /**
         * @description Entity at domain-model.md 6.11; machine at state-machines.md 16.3, whose collection row
         *     was AMENDED at C1.9 and RE-SIGNED by the Product Owner on 4 September 2026,
         *     one of that package's 27 rows. Corrected at OQ-129 R1.2.
         *
         *     **Custody accumulates by receipt and is not settlement**. A
         *     short tender is preserved as exactly what was taken; the delivery gate is the demand
         *     reaching SETTLED, never this record's state.
         *
         *     **expected_minor is snapshotted at DISPATCH, not at the door** (35.1.5). Resolving it live
         *     would compare today's price against yesterday's collection and make every post-hoc repricing
         *     look like a rider shortage.
         *
         *     **rider_id survives a RunCustodyHandover.** MSC-DEC-246 moves PARCELS between riders and says
         *     nothing about cash: money in a stranded rider's pocket does not move because their parcels
         *     did. Anything reading the run to find who holds the money is wrong on the day it matters.
         *
         *     **A record exists whenever cash is due, whether or not the stop succeeded** (12.1.1).
         *     Creating custody only on DELIVERED loses precisely the cash hardest to account for.
         */
        RiderCashCustody: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            order_id: string;
            /** Format: uuid */
            rider_id: string;
            /** @description Snapshotted at dispatch: the recipient amount then due for the trip, less anything already confirmed against the demand. A comparison figure, never a gate on custody. */
            expected_minor: number;
            /** @description THE SUM of the confirmed CASH PaymentReceipts linked through cash_receipt_ids. GH50 then GH5 reads 5500. May be below expected_minor while the remainder is due or was paid digitally, and above it on an over-tender. */
            readonly collected_minor?: number | null;
            /** @description Every CASH PaymentReceipt that increased this custody, in confirmed_at order. The provenance that traces GH55 in a pannier to two receipt facts. */
            readonly cash_receipt_ids?: string[];
            /** @enum {string} */
            state: "EXPECTED" | "COLLECTED_BY_RIDER" | "HANDED_TO_HUB" | "RECONCILED" | "EXCEPTION_OPEN" | "RESOLVED";
            /** Format: uuid */
            cash_handover_id?: string | null;
            /** Format: date-time */
            collected_at?: string | null;
            resolution_reason_code?: string | null;
        };
        /**
         * @description A coined record (GLOSSARY.md) - 26.3 requires the comparison and names nothing to hold it.
         *     Machine at state-machines.md 16.4, AMENDED at Gate C R1 and RE-SIGNED by the Product
         *     Owner on 4 September 2026, three of that package's 27 rows. Corrected at
         *     OQ-129 R1.2.
         *
         *     **The reconciliation is three-way, and R1 made it so.** The signed guard required only that
         *     the hub's count equal the rider's declaration - two figures, both supplied by parties who
         *     can both be wrong. Expected 125, declared 100, counted 100 reached CONFIRMED cleanly and a
         *     GH25 shortage left no trace. A clean handover now requires
         *     system_expected_minor = declared_total_minor = confirmed_total_minor.
         *
         *     **confirmed_total_minor is written by a hub actor and never by the rider** (26.3). Enforced
         *     by payment.cash.confirm, which no rider bundle holds.
         *
         *     **declared_total_minor IS visible to the confirming officer** (MSC-DEC-254, closing OQ-092)
         *     - a deliberate divergence from 22.4's blind parcel count. Separation of actors survives;
         *     independence of the second figure does not. Unlike parcels, cash stays countable.
         *
         *     **A rider under-declaring against a correct system figure produces a variance AND a
         *     disclosure**, and both are kept: the declaration stays separately auditable.
         */
        CashHandover: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            rider_id: string;
            /** Format: uuid */
            hub_id: string;
            /** @description SERVER-DERIVED and never caller-supplied: gross cash collected minus applied approved COLLECTION_CASH road expenses. The rider supplies one figure and the hub supplies one; this third belongs to neither. */
            readonly system_expected_minor: number;
            /** @description Gross recipient cash. Never rewritten by an expense. */
            readonly gross_cash_minor?: number;
            /** @description Approved COLLECTION_CASH road expenses applied to THIS handover, once each. */
            readonly applied_expense_minor?: number;
            /** @description Each expense is stamped with this handover and can never reduce another. */
            readonly applied_road_expense_ids?: string[];
            /** @description Rider-declared */
            declared_total_minor: number;
            /** @description Hub-counted */
            confirmed_total_minor?: number | null;
            /** @description confirmed_total_minor MINUS system_expected_minor. Signed. Measured against the SYSTEM figure, not against the rider's declaration - measuring it against what the rider said would let the rider set the target they are then measured against. */
            readonly variance_minor?: number | null;
            /** @enum {string} */
            state: "OPEN" | "CONFIRMED" | "VARIANCE_OPEN" | "CLOSED";
            variance_reason_code?: string | null;
            /**
             * Format: date-time
             * @description When the hub physically accepted the counted cash. Set on CONFIRMED AND on VARIANCE_OPEN - a variance is a financial state, not a reason to leave money attributed to a rider who no longer has it. PHYSICAL custody and FINANCIAL resolution are separately observable, and `state` carries the second.
             */
            readonly custody_transferred_at?: string | null;
            /** Format: date-time */
            opened_at?: string;
            /** Format: date-time */
            decided_at?: string | null;
        };
        /**
         * @description **No identity id.** The principal is resolved from the grant, which is principal-bound. A
         *     settable identity would let a grant issued for one employee establish another's credential.
         *
         *     **No bundle, status or mfa_enrolled.** Setup establishes a credential and changes no
         *     authority whatever.
         */
        CredentialSetup: {
            /** @description The single-use grant token. Never returned, never logged. */
            setup_token: string;
            /**
             * @description 12 to 128 characters, counted in Unicode code points after NFKC normalisation.
             *     Spaces are permitted and no composition rule applies: no mandatory case, digit or symbol.
             *     Never trimmed, truncated or echoed. Argon2id-hashed server-side.
             *     `minLength` and `maxLength` check the string as sent and are a pre-filter; the service
             *     applies the rule after normalisation and is the authority (Gate PD-3R2).
             */
            password: string;
        };
        /**
         * @description **No session, no token, for either path**. Establishing a credential is not
         *     authenticating, and a privileged identity is deliberately still unable to hold a session
         *     here.
         */
        CredentialSetupResult: {
            /** @description True for ordinary Ops Staff; false for privileged identities until MFA is proven */
            authentication_ready: boolean;
            mfa_enrolment_required?: boolean;
            mfa_provisioning?: components["schemas"]["MfaProvisioning"];
            /** @description The MFA_ENROLMENT continuation grant, present only for privileged identities. */
            mfa_setup_token?: string | null;
        };
        /**
         * @description Returned **once**, at provisioning, so the authenticator can be configured. The seed is
         *     stored encrypted server-side because verification requires recomputing codes
         *     from it - the one credential here that cannot be hashed - and is **never** returned again,
         *     logged, or written to an audit event.
         */
        MfaProvisioning: {
            /** @description Standard otpauth:// provisioning URI for the authenticator app */
            otpauth_uri: string;
        };
        /**
         * @description **The code is proof, not configuration.** A factor provisioned but never proven stays
         *     PENDING and is not MFA.
         */
        MfaEnrolment: {
            setup_token: string;
            /**
             * @description The TOTP code from the authenticator that proves the factor: 6 digits, 30-second step,
             *     one step accepted either side, single use (a code already used is refused again inside
             *     its window). A value that is not exactly 6 digits is `VALIDATION_FAILED`; a well-formed
             *     code that does not prove the factor is `MFA_PROOF_INVALID`.
             */
            totp_code: string;
        };
        /**
         * @description **No session.** The identity now signs in normally with password plus TOTP. Issuing a
         *     session here would make enrolment an authentication path that skipped the password.
         */
        MfaEnrolmentResult: {
            authentication_ready: boolean;
        };
        /**
         * @description **No disable flag and no factor field.** Reset revokes and re-issues; there is no shape in
         *     which this operation leaves a privileged identity able to authenticate without a factor.
         */
        MfaReset: {
            /**
             * @description A code of the reason catalogue (`ReasonDefinition`), validated against the catalogue's
             *     identity domain for this operation: empty is `REASON_REQUIRED`, and a code that is unknown,
             *     retired or in another domain is `REASON_NOT_ACTIVE`.
             */
            reason_code: string;
            note?: string;
        };
        /**
         * @description The re-enrolment grant is delivered to the target's verified work email, **never returned in
         *     this response** - the acting Platform Admin must not be able to complete the target's
         *     enrolment.
         */
        MfaResetResult: {
            /** @description Terminated with MFA_RESET */
            sessions_terminated: number;
            reenrolment_grant_issued?: boolean;
        };
        /**
         * @description **The in-person enrolment handoff**.
         *
         *     **This schema previously returned `expires_at` and nothing else**, on the reasoning that
         *     an officer holding the token could enrol a device the rider never touched. The reasoning
         *     was sound and the consequence was that **the flow could not be completed at all**:
         *     completeRiderDeviceEnrolment requires a `setup_token`, and no operation, response or
         *     documented transport ever put one in the rider's hands. Both rider lifecycles terminated
         *     here.
         *
         *     **The resolution keeps the property the omission was protecting.** The officer's screen
         *     shows a QR code, not a secret to transcribe; the credential travels from the Ops Portal
         *     display to the rider's own handset by scan, in the officer's presence - which is the
         *     in-person ceremony MSC-DEC-235 already requires. Senior Ops is the authority approving
         *     this binding, so displaying the QR discloses nothing to them they do not already control.
         *
         *     **What Senior Ops still never learns:** the rider's PIN, the rider's private key, and the
         *     rider's Session credential. The grant authorises enrolment completion and nothing else -
         *     it is not a session, and it carries no business authority.
         *
         *     Responses carrying it set `Cache-Control: no-store` and are excluded from logs, analytics
         *     and audit payloads.
         */
        DeviceEnrolmentGrant: {
            /**
             * @description The deep link the Ops Portal renders as a QR code for the rider to scan. Carries the
             *     single-use RIDER_DEVICE_ENROLMENT grant, and the single-use attestation challenge the
             *     handset binds into its key attestation. Never logged, audited or cached.
             */
            enrolment_uri: string;
            /**
             * Format: date-time
             * @description Ordinary SetupGrant lifetime - recovery_link_ttl_minutes, 30.
             */
            expires_at: string;
            /**
             * Format: uuid
             * @description The rider this grant is bound to. Display only, so the officer can confirm.
             */
            rider_id?: string;
        };
        /**
         * @description **No private key field exists and never will.** A schema able to accept one would defeat
         *     hardware-backed possession entirely.
         *
         *     **The PIN arrives from the rider's own device**, not from the registering officer's screen.
         */
        RiderDeviceEnrolment: {
            /**
             * @description From the QR the Ops Portal displayed at registerRiderDevice or reregisterRiderDevice.
             *     Purpose RIDER_DEVICE_ENROLMENT or RIDER_DEVICE_REREGISTRATION,
             *     rider-bound and single-use.
             */
            setup_token: string;
            /** @description Public half only. The private key is non-exportable and never leaves the handset */
            public_key: string;
            /**
             * @description Established by the rider: six numeric digits. Argon2id-hashed with a server-side
             *     pepper. Setting it resets the credential's failed-attempt count.
             */
            pin: string;
            /**
             * @description The Android Key Attestation chain for the key in `public_key`, produced by the handset
             *     for this enrolment with the attestation challenge issued with the grant.
             *     **Producer:** the Rider app. **Verifier:** the backend, before the device is registered;
             *     the handset's say-so is never trusted. **Lifecycle:** used once, at enrolment or
             *     replacement; the chain is not stored by value and is never logged. Required, so a
             *     client that cannot produce one cannot enrol. **The chain is bounded at ten certificates**:
             *     an Android attestation chain is a handful, so ten is a generous bound and not a measured
             *     one - an engineering parameter the Backend Engineer confirms. A longer chain is
             *     `VALIDATION_FAILED` and is not parsed.
             */
            key_attestation: {
                certificate_chain: string[];
            };
        };
        /**
         * @description **Deliberately minimal, and deliberately uninformative in reply.** See the operation: a
         *     challenge is issued the same way whether or not the number is a registered rider.
         */
        RiderChallengeRequest: {
            /** @description E.164 */
            phone: string;
        };
        /**
         * @description **Carries no account state** - no name, no hub, no device status, no indication that the
         *     number is known. Anything more would make this an enumeration endpoint (37.7).
         */
        RiderChallenge: {
            /** @description Single-use nonce to be signed by the registered private key */
            challenge: string;
            /** Format: date-time */
            expires_at: string;
        };
        /**
         * @description **No device identifier field.** The server generates the browser device credential and
         *     delivers it as a cookie; nobody types one.
         *
         *     **No administrator supplies the secret** - it is set here by the vendor and never learned by
         *     Melarc staff.
         */
        VendorCredentialSetup: {
            setup_token: string;
            /**
             * @description 12 to 128 characters, counted in Unicode code points after NFKC normalisation.
             *     Spaces are permitted and no composition rule applies: no mandatory case, digit or symbol.
             *     Never trimmed, truncated or echoed. Argon2id-hashed server-side.
             *     `minLength` and `maxLength` check the string as sent and are a pre-filter; the service
             *     applies the rule after normalisation and is the authority (Gate PD-3R2).
             */
            secret: string;
        };
        /**
         * @description **The token is the only field, and the omissions are the design.** No account identifier -
         *     the `VENDOR_DEVICE_ENROLMENT` grant is principal-bound, and accepting one would let a
         *     caller nominate whose browser is registered. No secret - this operation registers a
         *     browser and **does not rotate the shared secret** (vendor-authentication.md 5.5). No device
         *     identifier - the server generates the credential and delivers it as a cookie, the same rule
         *     `VendorCredentialSetup` follows.
         */
        AdditionalDeviceEnrolment: {
            setup_token: string;
        };
        /**
         * @description Entity at domain-model.md 6.8.
         *
         *     **Neither secret is ever returned.** `public_key` is not exposed because nothing outside the
         *     server needs it, and `device_credential_hash` is a hash the client must never see - the
         *     vendor's browser holds the credential itself in a cookie it cannot read either.
         *
         *     **The record is identified by `id`, and nothing a client sends selects it**.
         *     Possession is proved by signature for a rider and by the device-credential cookie for a
         *     vendor browser. The former `device_identifier` string proved nothing and is retired.
         */
        RegisteredDevice: {
            /** Format: uuid */
            id: string;
            /** @enum {string} */
            principal_type: "RIDER" | "VENDOR";
            /** Format: uuid */
            principal_id: string;
            /** @enum {string} */
            device_kind: "RIDER_ANDROID_KEYPAIR" | "VENDOR_BROWSER_CREDENTIAL";
            /** @enum {string} */
            status: "ACTIVE" | "REPLACED" | "REVOKED";
            /** Format: date-time */
            registered_at?: string;
            /** Format: uuid */
            registered_by?: string | null;
        };
        /**
         * @description **The only response in the contract that returns a raw Session credential** (MSC-DEC-261, R1).
         *
         *     Gate A returned the canonical `Session` resource from rider sign-in while deliberately
         *     keeping the credential off that schema - which left Melarc Rider correctly authenticated and
         *     holding nothing to send on the next request.
         *
         *     **This does not weaken the rule; it states it precisely**. Canonical
         *     `Session` resource representations never contain raw credentials - getCurrentSession and
         *     any session listing return `Session`, never this. A credential-ISSUANCE response
         *     necessarily returns the opaque token once, because there is no other moment at which the
         *     client can receive it.
         *
         *     The browser surfaces have the equivalent moment too, and it is a `Set-Cookie` header rather
         *     than a body field - which is why they need no schema like this one.
         *
         *     **No CSRF token accompanies it.** A Bearer credential is not attached automatically by a
         *     browser, so a rider request is not cross-site-forgeable and carries no synchronizer token.
         *
         *     `access_token` is stored on Android **only** in OS-backed secure credential storage, is
         *     never persisted server-side in plaintext, and never appears in logs, audit payloads,
         *     diagnostics or analytics.
         */
        RiderSessionIssued: {
            session: components["schemas"]["Session"];
            /** @description The newly issued opaque Session secret. Returned exactly once, here. */
            access_token: string;
            /** @enum {string} */
            token_type: "Bearer";
        };
        /**
         * @description **No TOTP code.** This operation provisions a factor; it cannot activate one. Activation
         *     requires the continuation grant plus a proven code at completeMfaEnrolment.
         */
        MfaReenrolmentBegin: {
            /** @description The MFA_REENROLMENT grant issued by resetStaffMfa. */
            setup_token: string;
        };
        /**
         * @description **No session, and no authentication readiness yet.** The factor is `PENDING` until a code is
         *     proven. A response that made the principal ready here would let a reset authorisation stand
         *     in for possession of the new authenticator.
         */
        MfaReenrolmentBegun: {
            mfa_provisioning: components["schemas"]["MfaProvisioning"];
            /** @description Short-lived MFA_ENROLMENT continuation grant. Ordinary security-link lifetime. */
            mfa_setup_token: string;
        };
        /**
         * @description **Documented for completeness; the browser normally reads it from the `melarc_csrf` cookie**
         *     rather than from a body.
         *
         *     That cookie is deliberately **not** `HttpOnly` - the page must read it to echo it, which is
         *     what makes a synchronizer token work. It is safe precisely because it is useless without the
         *     `HttpOnly` session cookie that JavaScript cannot read.
         */
        CsrfIssued: {
            /** @description Echo this in X-CSRF-Token on unsafe cookie-authenticated requests. */
            csrf_token: string;
        };
        /**
         * @description **A canonical extract of payment facts for a closed period. Creates no accounting entry
         *     and moves no money**. Entity at domain-model.md §6.12, whose field table
         *     this mirrors.
         *
         *     **THE RECORD IS PERMANENT; THE FILE IS NOT.** `manifest_digest` and `row_counts` outlive
         *     `file_available_until`, so the fact that an export happened — and what it contained —
         *     is answerable after the package is gone.
         *
         *     **A package is never regenerated in place.** A re-run is a **new record**, which is
         *     §5.5's own rule that a fact is never rewritten and a correction is a new record.
         *
         *     **`storage_ref` IS ABSENT, AND THE OMISSION IS THE CONTRACT** (rule 2 of this document's
         *     §42.3 rules; the same absence `Evidence` takes). The entity carries it and describes it
         *     as *"never returned to a client"* — returning it would hand a caller the address to
         *     construct its own retrieval and bypass the authorization entirely. Retrieval is a
         *     short-lived authorization over one object, never a stored URL.
         */
        AccountingExport: {
            /** Format: uuid */
            id: string;
            /**
             * @description `AccountingExportScope` (errors-and-enums.md §6). **`ALL_HUBS` requires the all-hubs
             *     scope of `payment.ledger.export`**, and `SINGLE_HUB` requires it too — no hub-scoped
             *     variant of the key exists.
             * @enum {string}
             */
            scope: "SINGLE_HUB" | "ALL_HUBS";
            /**
             * Format: uuid
             * @description **Mandatory for `SINGLE_HUB`, null for `ALL_HUBS`.**
             */
            hub_id?: string | null;
            /**
             * Format: date
             * @description First day of the closed hub-day range, **inclusive**.
             */
            period_from: string;
            /**
             * Format: date
             * @description Last day of the closed hub-day range, **inclusive**. **Every day in the range must
             *     have a closed `HubCashReconciliation`** or the request is refused
             *     with `PERIOD_NOT_RECONCILED`.
             */
            period_to: string;
            /**
             * @description **The EXPORT-FORMAT version, versioned independently of this contract's
             *     `info.version`.** A consumer pins the format it parses here; bumping `openapi.yaml`
             *     does not change a package, and changing the package format does not bump
             *     `openapi.yaml`.
             */
            schema_version: string;
            /**
             * @description `AccountingExportStatus` (errors-and-enums.md §6). **No machine**, and
             *     state-machines.md §20.7 records why: no transition after creation is any actor's
             *     decision. **A retry is a new record, never a transition** — there is deliberately no
             *     `REGENERATING` state and no path back to `REQUESTED`.
             * @enum {string}
             */
            status: "REQUESTED" | "GENERATED" | "FAILED";
            /**
             * Format: uuid
             * @description The holder of `payment.ledger.export` who requested it.
             */
            requested_by_staff_id: string;
            /** Format: date-time */
            requested_at: string;
            /**
             * Format: date-time
             * @description Non-null from `GENERATED`.
             */
            generated_at?: string | null;
            /** @description **Mandatory on `FAILED`**, null otherwise. */
            failure_reason_code?: string | null;
            /**
             * @description SHA-256 of the package manifest. Non-null from `GENERATED`. **SURVIVES FILE
             *     EXPIRY** — it is how the content of a vanished package stays attestable.
             */
            manifest_digest?: string | null;
            /**
             * @description Per-record-type row counts, keyed by `record_type` and **mirroring the manifest**.
             *     **SURVIVES FILE EXPIRY.**
             */
            row_counts?: {
                [key: string]: number;
            } | null;
            /**
             * Format: date-time
             * @description Computed at generation from `accounting_export_file_retention_days`; **null before
             *     generation**, and null-valued settings are why `requestAccountingExport` refuses
             *     with `EXPORT_RETENTION_NOT_CONFIGURED` rather than generating a file with no stated
             *     expiry.
             *
             *     **AVAILABILITY IS DERIVED BY COMPARISON, NOT BY A STATUS.** Past this instant the
             *     package is gone and `createAccountingExportRetrievalAuthorization` returns
             *     `EXPORT_FILE_EXPIRED`, while this record and every field above it stay readable.
             */
            file_available_until?: string | null;
        };
        /**
         * @description **The request carries what an export is OF, and nothing about what it becomes.**
         *
         *     **No `status`, no `id`, no `generated_at`, no `manifest_digest`, no `row_counts`, no
         *     `file_available_until` and no `storage_ref`.** Every one of those is derived by the
         *     server, and `additionalProperties: false` stops a caller smuggling one alongside the
         *     four properties this operation reads — a caller able to set `status` could declare an
         *     export `GENERATED` that was never generated.
         *
         *     **IDEMPOTENT ON (`scope`, `hub_id`, `period_from`..`period_to`, `schema_version`) WHILE
         *     A `REQUESTED` RECORD EXISTS.** A retry returns that record and queues no second package.
         */
        AccountingExportRequest: {
            /** @enum {string} */
            scope: "SINGLE_HUB" | "ALL_HUBS";
            /**
             * Format: uuid
             * @description **Required when `scope` is `SINGLE_HUB`; must be absent or null for `ALL_HUBS`.**
             *     Conditional on another property, so it is not in `required` — the invalid
             *     combinations are refused with `VALIDATION_FAILED` rather than tolerated.
             */
            hub_id?: string | null;
            /** Format: date */
            period_from: string;
            /** Format: date */
            period_to: string;
            /**
             * @description The export format the caller intends to receive. **Part of the idempotency key** —
             *     the same period at a different schema version is a different package.
             */
            schema_version: string;
        };
        /**
         * @description **The package manifest** — what this export contains, at what format version, and how
         *     completely each record type is represented. The digest of this document is the record's
         *     `manifest_digest`, which outlives the package itself.
         *
         *     Regenerated canonical CSV payloads for the same hub, period, schema version and closure instant
         *     are byte-identical, and therefore reproduce the same per-file sha256 values. generated_at may
         *     differ between runs, and the ZIP container's own bytes and hash are NOT guaranteed stable.
         *
         *     **That paragraph is the guarantee in full, and its last clause is load-bearing.** ZIP
         *     containers carry their own timestamps and ordering, so a container hash asserted as
         *     stable would be an assurance that fails the first time anyone tests it — **an
         *     overstated guarantee is worse than none.** A consumer that needs to prove two runs
         *     agree compares the per-file `sha256` values, never the archive.
         */
        AccountingExportManifest: {
            /**
             * @description **The export-format version, versioned independently of `openapi.yaml`, and carried
             *     in the package name as well as here.**
             *
             *     **Four of the format's cross-cutting representations are ALREADY FIXED by approved
             *     contract, and a package follows them rather than restating them.** They are named
             *     here so that no export-format version can quietly choose differently, and so that a
             *     reader does not mistake a settled convention for an open one:
             *
             *     - **Money** — a **minor-unit integer** with its currency code alongside; `GHS` is
             *       the only value Version 1 permits. **Never a float, never a decimal string**
             *       (domain-model.md §3.2, §34.6, `MSC-DEC-179`).
             *     - **Timestamps and zone** — stored and exported as **UTC instants**, and **an
             *       export carries an explicit offset**. domain-model.md §3.3 says so directly:
             *       *"Exports and anything readable outside Ghana carry an explicit offset."* The
             *       operating timezone is **`Africa/Accra`** (47.1, `MSC-DEC-035`–`037`), and the
             *       no-timezone-label display convention of `MSC-DEC-203` is a **display** rule that
             *       this exception explicitly removes an export from.
             *     - **Dates** — a calendar date is a `date`, **not an instant** (§3.3), which is why
             *       `period_from` and `period_to` are dates and `generated_at` is not.
             *     - **Identifiers** — the exported identifier is the **UUID v7** primary identifier,
             *       never the human-readable operational code, which domain-model.md 3.1 makes an attribute rather
             *       than an identifier precisely because it is mutable.
             *
             *     **What `schema_version` itself pins is what no approved decision has yet fixed**,
             *     and it is what a consumer keys its parser on: the exact ordered column list for each
             *     of the twelve record types, the CSV dialect (delimiter, quoting, escaping, line
             *     terminator and encoding — stated, not assumed), the single unambiguous null
             *     representation and how it is distinguished from an empty string, the serialised
             *     token for every boolean and enumeration, the deterministic row ordering, and the
             *     compatibility rule for what may be added within a version and what forces a new one.
             *     **Those tables are the export-format specification's, not this contract's** — a
             *     column list that lived in two documents would drift between them, and **inventing
             *     values for them here would put unapproved facts into an `APPROVED` document.**
             */
            schema_version: string;
            /** @enum {string} */
            scope: "SINGLE_HUB" | "ALL_HUBS";
            /**
             * Format: uuid
             * @description **Mandatory for `SINGLE_HUB`, null for `ALL_HUBS`** — the same rule the record carries.
             */
            hub_id?: string | null;
            /** Format: date */
            period_from: string;
            /** Format: date */
            period_to: string;
            /**
             * Format: date-time
             * @description When this package was generated. **Deliberately excluded from the reproducibility
             *     guarantee below** — it is the one field that legitimately differs between two runs
             *     over identical source facts.
             */
            generated_at: string;
            /**
             * @description One entry per record type in the package. `row_count` mirrors the record's
             *     `row_counts`, and `sha256` is the guarantee's unit.
             */
            files: {
                /** @description The canonical source record type this file carries, e.g. `PaymentAllocation`. */
                record_type: string;
                /**
                 * @description **Stable and deterministic, carrying scope and period**, so that two packages
                 *     for the same period are comparable by name before they are opened.
                 */
                filename: string;
                row_count: number;
                /**
                 * @description SHA-256 of **this file's canonical CSV payload**, not of the container. This
                 *     is the value the reproducibility guarantee is about.
                 */
                sha256: string;
                /**
                 * @description `RecordRepresentation` (errors-and-enums.md §6). **`EVENT_COMPLETE` means
                 *     every state change of the type is emitted as an event row; `CREATION_ONLY`
                 *     means only the creating event is emitted and post-creation transitions of the
                 *     type are NOT represented in the package.**
                 *
                 *     **`EVENT_COMPLETE` IS EARNED PER FIELD AND NEVER INFERRED FROM TIMESTAMP
                 *     COVERAGE.** A type whose every transition is stamped still fails where one
                 *     exported field cannot be reconstructed as at that instant —
                 *     `FinancialAdjustmentResolution` is exactly that case, complete in timestamps
                 *     and blocked by a single `reason_code` written by both the proposal and the
                 *     decision.
                 *
                 *     **While ANY entry here reads `CREATION_ONLY`, canonical generation is
                 *     unavailable** and `requestAccountingExport` refuses with
                 *     `EXPORT_SOURCE_NOT_EVENT_COMPLETE`. Four of the twelve types are
                 *     `EVENT_COMPLETE` today.
                 * @enum {string}
                 */
                representation: "EVENT_COMPLETE" | "CREATION_ONLY";
            }[];
        };
        /**
         * @description **One row of one record type's file: a LIFECYCLE EVENT, not a current-state snapshot.**
         *     Rendering a status is not exporting a change, and a period's package has to carry what
         *     happened in that period rather than what is true today.
         *
         *     **Row ordering within a file is deterministic and fixed by `schema_version`**, which is
         *     what makes two runs byte-identical and the per-file `sha256` reproducible.
         *
         *     **Where a record type's `representation` is `CREATION_ONLY`, only its creating event
         *     appears here** and its post-creation transitions are absent from the package — declared
         *     in the manifest rather than left to be discovered.
         */
        AccountingExportEventRow: {
            /** @description The canonical source record type, e.g. `PaymentAllocation`. */
            record_type: string;
            /**
             * Format: uuid
             * @description The source record this event belongs to.
             *
             *     **THIS IS NOT A PRIMARY KEY.** It **recurs once per lifecycle event**, and across
             *     periods — a record created in one period and settled in the next appears in both
             *     packages under the same `record_id`. **A consumer that keys on it silently drops
             *     transitions**, which is a defect that shows up as a reconciliation that is quietly
             *     short rather than as an error. The key is (`record_type`, `record_id`,
             *     `event_type`, `effective_at`).
             */
            record_id: string;
            /**
             * @description The lifecycle event this row is emitted for — **named for the state reached**, or
             *     `CREATED` where the record carries no status.
             */
            event_type: string;
            /**
             * Format: date-time
             * @description **THE MELARC-AUTHORITATIVE OCCURRENCE TIMESTAMP DEFINED FOR THAT EVENT TYPE, AND
             *     NOTHING ELSE.** It is named per record type and per event type — `created_at` for a
             *     demand's `CREATED`, `frozen_at` for its `FROZEN`, the linked
             *     `PaymentReceipt.confirmed_at` for a `PaymentAttempt`'s `SUCCEEDED` because that is
             *     **Melarc's acceptance rather than the provider's clock**.
             *
             *     **THIS ROW'S `effective_at` DECIDES ITS PERIOD, AND NOTHING ELSE DOES.** A provider
             *     timestamp may be exported as data in its own column under `attributes` and **must
             *     never determine the accounting-export period**: a backdated provider success routing
             *     a row into a closed period is the exact failure the late-facts rule prohibits — late
             *     facts are recognised in the period they become authoritative **in Melarc**, never
             *     back-posted, and a closed period is never rewritten.
             *
             *     **`PaymentAttempt.PENDING` IS CARRIED AS UNSETTLED, NOT AS SETTLED.**
             *     `provider_initiated_at` is written by the adapter at `CREATED → PENDING`, so the
             *     *event* is Melarc's — but **the field is provider-named and nothing states whether
             *     the value is Melarc's clock or the provider's payload**, and that difference decides
             *     whether it may determine a period at all. It is recorded here as an open question
             *     rather than resolved by this contract, and an implementer must not read its presence
             *     in the matrix as an approval.
             *
             *     **An event with no authoritative effective timestamp is not emitted.** That is why
             *     eight of the twelve record types are `CREATION_ONLY` rather than partially complete.
             */
            effective_at: string;
            /**
             * @description The status the record holds **after** this event. **Null for the two record types
             *     that carry no status at all** — a tri-state would make "no status" and "status
             *     unknown" the same value.
             */
            status_after?: string | null;
            /**
             * @description **The record type's allowlisted columns, valued AS AT this event's `effective_at`**
             *     — not as at generation time. The exact ordered column list per record type is fixed
             *     by `schema_version` and lives in the export-format specification.
             *
             *     **The allowlist excludes contact data and free text** (`payer_msisdn`,
             *     `payer_msisdn_masked`, `payer_context`, `destination`, `note`, `failure_detail`,
             *     `terminal_reason`), **idempotency keys** (`business_key`, `source_key`) and
             *     **deprecated fields** (`PaymentAttempt.obligation_ref`). **Controlled identifiers
             *     are kept** — `hub_id`, `order_id`, `rider_id`, `*_staff_id`, `payer_ref`, record
             *     foreign keys and `evidence_id` — because the export uses controlled identifiers and
             *     carries no name, phone number, address or `Evidence` content.
             *
             *     **A Melarc transition timestamp is never an attribute column.** It appears only as
             *     the `effective_at` of its own event row. The exception is a timestamp that is **not**
             *     a Melarc event stamp — a provider-supplied one such as
             *     `PaymentAttempt.provider_confirmed_at` — which is exported here as data and never
             *     determines the period.
             */
            attributes: {
                [key: string]: unknown;
            };
        };
        /**
         * @description **A temporary bearer capability, and it is treated as one.** It is never logged, never
         *     cached, never persisted and never returned in an audit payload — the same rule the
         *     session credential, the OTP and the evidence authorization already follow (§38.2,
         *     §20.4). `payment.ledger.export_retrieval_authorized` records that a capability was
         *     issued and **never the URL itself** (audit.md §9).
         *
         *     **This is a capability over ONE package, not a download and not a feed.** There is no
         *     anonymous read, no listing, no public ACL and no permanent URL, and nothing here streams
         *     bytes through the API.
         *
         *     **`storage_ref` is still absent**, here as everywhere. Returning it would hand a client
         *     the address to construct its own retrieval and bypass the authorization entirely, which
         *     is the reason it is absent from the record schema as well as this one.
         */
        AccountingExportRetrievalAuthorization: {
            /** @description HTTP method the client uses to fetch the one object */
            method: string;
            /**
             * @description **Opaque, single-object, short-lived.** The client does not parse, modify or
             *     construct it. Changing the object key invalidates the signature; it confers no
             *     listing authority and expires with `expires_at`.
             */
            url: string;
            /** @description Non-secret request headers the client must echo. Never a credential */
            headers?: {
                [key: string]: string;
            };
            /**
             * Format: date-time
             * @description `accounting_export_retrieval_authorization_ttl_minutes` from issue — **5 minutes**
             *     (settings.md v1.38), matching evidence's TTL.
             */
            expires_at: string;
        };
    };
    responses: {
        /**
         * @description 401 - no usable authenticated session. Missing, malformed, unknown, expired
         *     or terminated.
         *
         *     DELIBERATELY UNDIFFERENTIATED. `SESSION_INVALID` is returned for every one of those causes:
         *     distinguishing them outward tells an unauthenticated caller which guess was closest. The
         *     AUDIT record keeps the precise cause - audit.md 5.4's asymmetry, undifferentiated outward
         *     and precise inward.
         *
         *     `SESSION_SUPERSEDED` is the single exception, because 37.2 makes vendor displacement
         *     deliberate product behaviour the client must be able to recognise.
         */
        Unauthenticated: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /**
         * @description 429 - rate limited. Per credential, tightest on the shared vendor login and
         *     the rider device. The figures were set at MSC-DEC-371 (OQ-067 closed 5 September 2026)
         *     onto the six buckets and eight keys MSC-DEC-285 created at settings.md 7.7 (OQ-077
         *     closed); the RESPONSE was declarable before either landed, which is why it was
         *     declared first.
         */
        RateLimited: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /**
         * @description `PERMISSION_DENIED`, `INSUFFICIENT_AUTHORITY` or `HUB_SCOPE_VIOLATION` - the three
         *     refusals an authenticated caller may be told for who they are and where they act, each for a
         *     different gate - or `CSRF_VALIDATION_FAILED`, the refusal of a cookie-authenticated unsafe
         *     request whose CSRF token or Origin does not check out. All four are `403`.
         *     Deny by default (§37.1). **A record that exists but belongs to another vendor, or - when a
         *     rider looks it up - to work not assigned to that rider, is never a 403**: it is the `404`
         *     below, identical to a record that does not exist. A rider who acts on work they name and are
         *     not assigned is told `NOT_ASSIGNED_RIDER` or `NOT_CUSTODY_HOLDER`, not this.
         */
        Forbidden: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /**
         * @description `NOT_FOUND`. The record does not exist - **or** it exists and the caller is a
         *     Vendor or a Rider who may not know it does (§43.2, §19.2). The two are one response: same
         *     status, same code, same body shape and the same timing class. Staff who hold the key and
         *     reach an existing record outside their hubs are not given this: that is `HUB_SCOPE_VIOLATION`.
         */
        NotFound: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /**
         * @description `VALIDATION_FAILED`. `details` names the offending field. **Always `400`, never `422`**: a
         *     request that breaks a documented format or range is a `400`, and a named business rule
         *     (`RuleViolation`) is a `422`.
         */
        ValidationFailed: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /**
         * @description `STATE_CONFLICT` or `IDEMPOTENCY_KEY_CONFLICT`. **Every operation that takes an
         *     `Idempotency-Key` declares this response and `IDEMPOTENCY_KEY_CONFLICT`.**
         */
        Conflict: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /**
         * @description A business rule refused the command. `code` carries the specific reason from
         *     `contracts/errors-and-enums.md` §5. **Never `VALIDATION_FAILED`**, which is always a `400`
         *     (`ValidationFailed`).
         */
        RuleViolation: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
        /**
         * @description `503` `TRUST_DATA_UNAVAILABLE` (MSC-DEC-437, SECURITY_DESIGN 15.2.2). The verifier cannot
         *     evaluate a handset's key attestation because the trust data it needs - the accepted roots and
         *     Google's revocation list - is older than the 24-hour maximum, was never loaded by this
         *     instance, or could not be loaded. **Retryable, and the grant is still good**: nothing was
         *     written and nothing was consumed. `Retry-After` says when to try again.
         *
         *     **Returned by `completeRiderDeviceEnrolment` and by nothing else.** Sign-in, sessions and
         *     every other operation do not read trust data. It is not `DEVICE_INTEGRITY_FAILED`, which
         *     says the evidence was evaluated and failed policy, and not `DEVICE_SECURITY_UNSUPPORTED`,
         *     which says the handset lacks the capability: nothing is known to be wrong with the device.
         */
        TrustDataUnavailable: {
            headers: {
                "Retry-After": components["headers"]["RetryAfter"];
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error"];
            };
        };
    };
    parameters: {
        /**
         * @description Synchronizer token echoed from the `melarc_csrf` cookie on **unsafe cookie-authenticated**
         *     requests. The server compares its hash against `Session.csrf_token_hash` and
         *     validates `Origin`; either failing returns `CSRF_VALIDATION_FAILED`.
         *
         *     **Rider Bearer requests do not use CSRF** - a Bearer credential is not sent automatically by
         *     the browser, so there is nothing for a cross-site request to ride on.
         */
        CsrfToken: string;
        /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
        Id: string;
        /**
         * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
         *     than state-based, so a concurrent change that does not alter state is still caught.
         */
        IfMatch: string;
        /**
         * @description Client-generated. **Required for every operation whose contract declares this parameter**;
         *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
         *     and same payload replays the original result; same key with a different payload returns
         *     409 `IDEMPOTENCY_KEY_CONFLICT`.
         *
         *     **Rider commands carry it for connection resilience, not because the command is
         *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
         *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
         *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
         *     and `setManifestStopOrder` are the current examples (the last two added for their new
         *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
         *     this description no longer says *rider* alone: **a parameter description narrower than
         *     the parameter's declared use is a contract disagreeing with itself.**
         *
         *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
         *     state transition creates no second record and repeats no charge** -
         *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
         *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
         *
         *     **The key is scoped to the calling principal and the operation**, so a
         *     key chosen by one caller can never match another's. Clients need no coordination and
         *     may reuse any value they like across operations.
         *
         *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
         *     choosing `retry-1` on the same operation is expected behaviour for two independent
         *     clients; the second did not get an error, it got a **replay of the first vendor's
         *     stored result** - one caller receiving another's response body, through the mechanism
         *     that exists to make retries safe.
         */
        IdempotencyKey: string;
        PageSize: number;
        PageToken: string;
    };
    requestBodies: never;
    headers: {
        /**
         * @description One or more real `Set-Cookie` field lines.
         *
         *     **A response may emit several.** HTTP allows repeated `Set-Cookie` fields and OpenAPI
         *     cannot name them individually, so WHICH cookies a response establishes or expires is declared
         *     by the `x-set-cookies` extension on that response, resolving against the root `x-cookies` map.
         *
         *     **Expiry is declared the same way.** A cookie is removed by setting it again with `Max-Age=0`
         *     and the attributes it was issued with, so the cookies a sign-out clears are named in its
         *     `x-set-cookies` and checked against the same `x-cookies` attributes. `x-set-cookies-for` names
         *     a security scheme and limits the declaration to a request that presented that scheme's
         *     credential: any other request is owed none of those cookies and may not receive them.
         *     `x-set-cookies-when` names a type of principal (`principal_type`) and limits it to an answer for
         *     that type: an answer for another is owed none of them either.
         *
         *     **The previous representation invented `X-Set-Csrf-Cookie` and `X-Set-Vendor-Device-Cookie`
         *     to work around that limitation.** Those are not HTTP headers. An implementation reading the
         *     contract literally would have emitted two custom headers no browser stores, and the
         *     credentials would never have reached the client at all.
         *
         *     Raw cookie credentials appear here and **never in a JSON body**.
         */
        SetCookie: string;
        /**
         * @description `no-store`. Set on any response carrying a raw setup credential, so no
         *     intermediary or browser cache retains an enrolment secret.
         *
         *     **Required, and exactly `no-store`.** A response that references this header must carry it,
         *     and its value is the constant `no-store`: omitting it, or saying `public`, `private` or
         *     `no-cache`, does not conform.
         */
        CacheControlNoStore: "no-store";
        /** @description Opaque record version. Send back as `If-Match` on the next mutation. */
        ETag: string;
        /** @description Whole seconds the client should wait before it tries again (`TrustDataUnavailable`). */
        RetryAfter: number;
    };
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    listPickupRequests: {
        parameters: {
            query?: {
                state?: string;
                service_date?: string;
                page_size?: components["parameters"]["PageSize"];
                page_token?: components["parameters"]["PageToken"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["PickupRequest"][];
                        next_page_token: string | null;
                    };
                };
            };
            401: components["responses"]["Unauthenticated"];
        };
    };
    createPickupRequest: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PickupRequestCreate"];
            };
        };
        responses: {
            /** @description Created */
            201: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PickupRequest"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
        };
    };
    getPickupRequest: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PickupRequest"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    confirmPickupRequest: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Confirmed */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PickupRequest"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    cancelPickupRequest: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @description A reason's own metadata may make a note, photo or contact attempt mandatory
                     *     (§35.9.2). Omitting a field the reason requires returns `REASON_REQUIRED`.
                     */
                    reason_code: string;
                    note?: string;
                    /** @default false */
                    create_replacement?: boolean;
                    /**
                     * @description **Discretionary**. Requires `pickup.request.cancel_chargeable`
                     *     and a rider already assigned; a vendor may never set it.
                     *
                     *     **A request is ignored where the selected reason's `attribution` is
                     *     `MELARC`**. The server records
                     *     `cancellation_charge_outcome: EXEMPT` and the cancellation proceeds - it is
                     *     never refused, for the same reason a missing amount does not refuse it.
                     *     Billing a vendor for Melarc's own operational failure is the error
                     *     `scheduleRedelivery` already prevents by deriving `chargeable` from the same
                     *     attribution field. `CUSTOMER` and `EXTERNAL` attribution leave this field
                     *     exactly as discretionary as MSC-DEC-197 made it.
                     *
                     *     Required on a post-assignment cancellation — but either value is valid. The
                     *     requirement is that Ops makes an explicit decision, not that the charge
                     *     applies. There is no default, because a default would let the decision go
                     *     unmade.
                     */
                    apply_charge?: boolean;
                    /**
                     * @description **Mandatory on any post-assignment cancellation**, whichever way
                     *     `apply_charge` went. Recording why no charge applied matters as much as
                     *     recording why one did.
                     */
                    charge_reason_code?: string;
                };
            };
        };
        responses: {
            /** @description Cancelled */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PickupRequest"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            /**
             * @description `SELF_CANCEL_NOT_PERMITTED_AFTER_ASSIGNMENT` for a vendor after assignment, or
             *     `PERMISSION_DENIED` for a chargeable cancellation without the permission, or
             *     `CSRF_VALIDATION_FAILED` for a cookie-authenticated request whose CSRF check fails.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    reassignPickupRequestHub: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PickupRequestHubReassignment"];
            };
        };
        responses: {
            /** @description Reassigned. Planning under the previous hub has been revoked */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PickupRequest"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    escalatePickupRequest: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PickupEscalation"];
            };
        };
        responses: {
            /** @description Escalated */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PickupRequest"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    extendPickupAttempts: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AttemptExtension"];
            };
        };
        responses: {
            /** @description Ceiling extended for this request */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PickupRequest"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    waiveCancellationCharge: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CancellationChargeWaiver"];
            };
        };
        responses: {
            /** @description Charge waived */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PickupRequest"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["RuleViolation"];
        };
    };
    requestOnePackageException: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    reason_code: string;
                    note?: string;
                };
            };
        };
        responses: {
            /** @description Exception requested */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Approval"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
        };
    };
    approveOnePackageException: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Approved */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Approval"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["RuleViolation"];
        };
    };
    arriveAtPickupStop: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Stop ARRIVED */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PickupStop"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
        };
    };
    recordCollection: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CollectionRecordCreate"];
            };
        };
        responses: {
            /** @description Collection recorded */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CollectionRecord"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    reportPickupFailure: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    reason_code: string;
                    note?: string;
                    /**
                     * @description Each id must name an evidence record in `STORED`. A `PENDING_UPLOAD` record is
                     *     rejected with `EVIDENCE_NOT_STORED` - otherwise "attached evidence" is satisfiable
                     *     by a declaration with no bytes behind it.
                     */
                    evidence_ids?: string[];
                    contact_attempts?: components["schemas"]["ContactAttempt"][];
                };
            };
        };
        responses: {
            /** @description Failure recorded */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PickupStop"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    skipPickupStop: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description An ACTIVE PICKUP_STOP_SKIP code. A DELIVERY_FAILURE, RECIPIENT_CONTACT or 21.5 pickup-failure code is refused with REASON_NOT_ACTIVE - a skip is not a failure, and 5 gives them separate rows with different effects. */
                    reason_code: string;
                    /** @description Mandatory where the reason's requires_note is true (35.9.2). */
                    note?: string;
                };
            };
        };
        responses: {
            /** @description Stop is SKIPPED. The run may now reach COMPLETED if no other stop is open */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PickupStop"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    listHubIntakes: {
        parameters: {
            query?: {
                /** @description Narrow to one intake state. AWAITING_COUNT is the awaiting-receive queue. */
                state?: "AWAITING_COUNT" | "COUNTED" | "RECONCILIATION_REQUIRED" | "READY_FOR_ITEMIZATION" | "ITEMIZING" | "CLOSED";
                page_size?: components["parameters"]["PageSize"];
                page_token?: components["parameters"]["PageToken"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Intakes */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: (components["schemas"]["HubIntakePreCount"] | components["schemas"]["HubIntakePostCount"])[];
                        next_page_token: string | null;
                    };
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
        };
    };
    getHubIntake: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HubIntakePreCount"] | components["schemas"]["HubIntakePostCount"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
        };
    };
    acquireIntakeLock: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The intake, showing the current receiver */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HubIntakePreCount"] | components["schemas"]["HubIntakePostCount"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
        };
    };
    submitBlindCount: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    physical_count: number;
                };
            };
        };
        responses: {
            /** @description Counted; comparison revealed */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HubIntakePostCount"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            /** @description `BLIND_COUNT_VIOLATED` if the declared count was served or accepted before commit. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    itemizeOrder: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["OrderItemize"];
            };
        };
        responses: {
            /** @description Order created and priced */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Order"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            /**
             * @description `SETTING_MISSING` when the hub has no approved base fee, or `MARGIN_NOT_CONFIGURED`
             *     when outside-Accra pricing is attempted with no configured margin. Per §33.4 the
             *     system does **not** fall back to another hub's rates or a global default; it fails
             *     visibly.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    closeHubIntake: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Closed */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HubIntakePostCount"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    listPickupManifests: {
        parameters: {
            query?: {
                page_size?: components["parameters"]["PageSize"];
                page_token?: components["parameters"]["PageToken"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Manifests */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["PickupManifest"][];
                        next_page_token: string | null;
                    };
                };
            };
            401: components["responses"]["Unauthenticated"];
        };
    };
    createPickupManifest: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PickupManifestCreate"];
            };
        };
        responses: {
            /** @description Manifest created in DRAFT */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PickupManifest"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    getPickupManifest: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Manifest */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PickupManifest"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    setManifestStopOrder: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ManifestStopOrder"];
            };
        };
        responses: {
            /** @description Sequence set */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PickupManifest"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    assignRider: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RiderAssignment"];
            };
        };
        responses: {
            /** @description Rider assigned */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PickupManifest"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    dispatchManifest: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Dispatched */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PickupManifest"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    startRun: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Run started */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PickupManifest"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    initiateRunCustodyHandover: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RunCustodyHandoverCreate"];
            };
        };
        responses: {
            /** @description Handover opened, PENDING */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunCustodyHandover"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    acceptRunCustodyHandover: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RunCustodyHandoverAccept"];
            };
        };
        responses: {
            /** @description Custody transferred */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunCustodyHandover"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    listRunCustodyHandovers: {
        parameters: {
            query?: {
                page_size?: components["parameters"]["PageSize"];
                page_token?: components["parameters"]["PageToken"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Handovers this actor is a party to, newest first */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["RunCustodyHandover"][];
                        next_page_token: string | null;
                    };
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
        };
    };
    submitHubHandover: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["HubHandoverSubmit"];
            };
        };
        responses: {
            /** @description Handover recorded; one intake opened per row, in row order */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HubIntakePreCount"][];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    initiateHandshake: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Code generated */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Handshake"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    verifyHandshake: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["HandshakeVerify"];
            };
        };
        responses: {
            /** @description Verified */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Handshake"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["RuleViolation"];
        };
    };
    requestSmsHandshakeFallback: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Code sent to the registered number */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Handshake"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    authoriseHandshakeOverride: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["HandshakeOverride"];
            };
        };
        responses: {
            /** @description Handshake authorised by override */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Handshake"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    adjudicateDiscrepancy: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DiscrepancyAdjudication"];
            };
        };
        responses: {
            /** @description Adjudicated */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HubIntakePostCount"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    staffSignIn: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["StaffSignIn"];
            };
        };
        responses: {
            /**
             * @description **Ops Staff only.** Session established and the session cookies set. An unprivileged
             *     role needs no second factor.
             */
            200: {
                headers: {
                    "Set-Cookie": components["headers"]["SetCookie"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Session"];
                };
            };
            /**
             * @description **Senior Ops and Platform Admin.** Password accepted, **no session issued and no
             *     cookie set**. The response is a challenge, which grants nothing and is not a partial
             *     session. 202 rather than 200 because the request is accepted and the outcome is not
             *     yet complete.
             */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MfaChallenge"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            422: components["responses"]["RuleViolation"];
            429: components["responses"]["RateLimited"];
        };
    };
    completeStaffMfaSignIn: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MfaSignInComplete"];
            };
        };
        responses: {
            /**
             * @description Factor proven. **This is the only response that can establish a privileged Session**,
             *     which is what makes "no privileged Session before MFA" mechanically testable.
             */
            200: {
                headers: {
                    "Set-Cookie": components["headers"]["SetCookie"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Session"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            /**
             * @description `MFA_ENROLMENT_REQUIRED`. The identity is privileged, its password was proved and it has
             *     no `ACTIVE` MFA factor, so no privileged session can be issued. The attempt does not
             *     count towards the lockout.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            422: components["responses"]["RuleViolation"];
            429: components["responses"]["RateLimited"];
        };
    };
    riderSignIn: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RiderSignIn"];
            };
        };
        responses: {
            /** @description Session established. The opaque Bearer credential is returned here, once */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RiderSessionIssued"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            422: components["responses"]["RuleViolation"];
            429: components["responses"]["RateLimited"];
        };
    };
    vendorSignIn: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["VendorSignIn"];
            };
        };
        responses: {
            /**
             * @description Session established; any earlier session terminated. **The device credential is
             *     proved here and its lifetime renewed, never replaced**.
             */
            200: {
                headers: {
                    "Set-Cookie": components["headers"]["SetCookie"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Session"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            422: components["responses"]["RuleViolation"];
            429: components["responses"]["RateLimited"];
        };
    };
    getCurrentSession: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Current session */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Session"];
                };
            };
            401: components["responses"]["Unauthenticated"];
        };
    };
    signOut: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Signed out. For a request authenticated by the browser session the `Set-Cookie` lines expire
             *     `melarc_session` and `melarc_csrf`; for a bearer request there are none.
             */
            204: {
                headers: {
                    "Set-Cookie": components["headers"]["SetCookie"];
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
        };
    };
    listSessions: {
        parameters: {
            query: {
                principal_type: "STAFF" | "RIDER" | "VENDOR";
                principal_id: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["Session"][];
                    };
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    revokeSession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SessionRevoke"];
            };
        };
        responses: {
            /** @description Revoked */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Session"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["RuleViolation"];
        };
    };
    requestCredentialRecovery: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RecoveryRequestCreate"];
            };
        };
        responses: {
            /**
             * @description Accepted. Identical for known and unknown identifiers. **Where the principal exists a
             *     `RecoveryRequest` is created** and its token sent to the registered channel; where it
             *     does not, nothing is created and the response is the same (37.7).
             */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["ValidationFailed"];
            422: components["responses"]["RuleViolation"];
            429: components["responses"]["RateLimited"];
        };
    };
    completeCredentialRecovery: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RecoveryComplete"];
            };
        };
        responses: {
            /**
             * @description Credential set; all sessions terminated. **On the vendor branch, obsolete device
             *     credentials are revoked and `melarc_vendor_device` is re-issued.** No Session cookie
             *     is set for any principal type. **A staff recovery sets no cookie at all**: the device
             *     credential is the vendor branch's alone (`x-set-cookies-when`).
             */
            204: {
                headers: {
                    "Set-Cookie": components["headers"]["SetCookie"];
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["ValidationFailed"];
            422: components["responses"]["RuleViolation"];
            429: components["responses"]["RateLimited"];
        };
    };
    revokeRiderDevice: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                riderId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DeviceRevocation"];
            };
        };
        responses: {
            /** @description Binding revoked; any live session on the device terminated with DEVICE_REVOKED */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["RuleViolation"];
        };
    };
    getRecipientConfirmation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Confirmation record */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RecipientConfirmation"];
                };
            };
            401: components["responses"]["Unauthenticated"];
        };
    };
    recordConfirmationAttempt: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConfirmationAttempt"];
            };
        };
        responses: {
            /** @description Attempt recorded */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RecipientConfirmation"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    escalateRecipientConfirmation: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RecipientConfirmationEscalation"];
            };
        };
        responses: {
            /** @description Escalated to the senior decision queue; escalated_at set */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RecipientConfirmation"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    listDeliveryRuns: {
        parameters: {
            query?: {
                page_size?: components["parameters"]["PageSize"];
                page_token?: components["parameters"]["PageToken"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Runs */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["DeliveryRun"][];
                        next_page_token: string | null;
                    };
                };
            };
            401: components["responses"]["Unauthenticated"];
        };
    };
    createDeliveryRun: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DeliveryRunCreate"];
            };
        };
        responses: {
            /** @description Run created in DRAFT */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeliveryRun"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    getDeliveryRun: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Run */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeliveryRun"];
                };
            };
            401: components["responses"]["Unauthenticated"];
        };
    };
    setDeliveryStopOrder: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DeliveryStopOrder"];
            };
        };
        responses: {
            /** @description Sequence set */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeliveryRun"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    assignDeliveryRider: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RiderAssignment"];
            };
        };
        responses: {
            /** @description Rider assigned */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeliveryRun"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    dispatchDeliveryRun: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Dispatched. All state changes committed together */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeliveryRun"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            /**
             * @description Revalidation failed. **Nothing was committed** - the run remains DRAFT and every order
             *     is untouched. The body names which check failed on which order.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    startDeliveryRun: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Run started */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeliveryRun"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    listAssignableStaffRoleBundles: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["AssignableStaffRoleBundle"][];
                    };
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
        };
    };
    listStaffIdentities: {
        parameters: {
            query?: {
                status?: "PENDING_APPROVAL" | "ACTIVE" | "REJECTED" | "SUSPENDED" | "OFFBOARDED";
                hub_id?: string;
                /** @description Matches name or work email. */
                q?: string;
                page_size?: components["parameters"]["PageSize"];
                page_token?: components["parameters"]["PageToken"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["StaffIdentity"][];
                        next_page_token: string | null;
                    };
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
        };
    };
    createStaffIdentity: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["StaffIdentityCreate"];
            };
        };
        responses: {
            /** @description Profile created in PENDING_APPROVAL */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StaffIdentity"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    getStaffIdentity: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StaffIdentity"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    approveStaffIdentity: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["StaffIdentityApproval"];
            };
        };
        responses: {
            /** @description Approved to ACTIVE, or REJECTED */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StaffIdentity"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    proposeBundleChange: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BundleChangeProposal"];
            };
        };
        responses: {
            /** @description Change proposed, awaiting approval */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BundleChange"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    approveBundleChange: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BundleChangeApproval"];
            };
        };
        responses: {
            /** @description Bundle changed */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BundleChange"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    createEvidence: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EvidenceCreate"];
            };
        };
        responses: {
            /** @description Record created PENDING_UPLOAD, with upload instructions */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EvidenceUploadTicket"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    completeEvidenceUpload: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Evidence STORED and referenceable */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Evidence"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    createEvidenceRetrievalAuthorization: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Short-lived single-object retrieval authorization */
            200: {
                headers: {
                    /** @description Always `no-store`. The capability must not be cached by any intermediary */
                    "Cache-Control": "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EvidenceRetrievalAuthorization"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            422: components["responses"]["RuleViolation"];
        };
    };
    arriveAtDeliveryStop: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Stop ARRIVED */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeliveryStop"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
        };
    };
    recordRecipientCashPayment: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CashCollection"];
            };
        };
        responses: {
            /** @description Cash recorded at the amount taken; custody COLLECTED_BY_RIDER with the receipt linked. Whether the demand is now SETTLED is read from getStopPaymentDemand - this response reports custody, never settlement. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RiderCashCustody"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    requestDeliveryOtp: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OTP dispatched to the number of record. The value is not returned */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    closeDeliveryStopDelivered: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DeliveryOtpSubmission"];
            };
        };
        responses: {
            /** @description Stop DELIVERED */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeliveryStop"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    authoriseDeliveryWithoutOtp: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["OtpOverrideAuthorisation"];
            };
        };
        responses: {
            /** @description Stop DELIVERED without OTP verification, override audited */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeliveryStop"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    getCarrierHandoff: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The handoff record */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ThirdPartyHandoff"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    recordCarrierHandoff: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CarrierHandoffCapture"];
            };
        };
        responses: {
            /**
             * @description Handoff recorded. `state` is `HANDED_OVER`. For `STATION_DROP` this is terminal and
             *     Melarc's Station Drop fee is earned at `handed_over_at`.
             *
             *     **200 and not 201, because this operation creates nothing.** It transitions an existing
             *     PENDING_HANDOFF record and returns 404 when there is none, so a 201 would assert a
             *     creation that does not happen here - the mistaken assumption 5.47 was written under.
             *     This matches acceptRunCustodyHandover, the sibling POST that transitions a custody
             *     record it does not create, and the 91 other POSTs in this contract that answer 200 on a
             *     transition while the 21 that answer 201 each bring a new record into existence.
             *     Corrected at Rider Four-Pass R1.2.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ThirdPartyHandoff"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    listCarrierHandoffs: {
        parameters: {
            query?: {
                page_size?: components["parameters"]["PageSize"];
                page_token?: components["parameters"]["PageToken"];
                /** @description Narrow to one handoff state. */
                state?: "PENDING_HANDOFF" | "HANDED_OVER" | "IN_TRANSIT" | "DELIVERED" | "FAILED" | "RETURNED" | "CANCELLED";
                /** @description Narrow to one commercial mode, as snapshotted on the record. */
                commercial_mode?: "STATION_DROP" | "MELARC_COVERED_THIRD_PARTY_DELIVERY";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Handoff records */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["ThirdPartyHandoff"][];
                        next_page_token: string | null;
                    };
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
        };
    };
    recordHandoffOutcome: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["HandoffOutcomeRecord"];
            };
        };
        responses: {
            /** @description Outcome recorded */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ThirdPartyHandoff"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    clearOutboundForDispatch: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Cleared; the open handoff record */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ThirdPartyHandoff"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    listCourierProviders: {
        parameters: {
            query?: {
                /** @description Narrow to active or inactive entries. */
                status?: "ACTIVE" | "INACTIVE";
                page_size?: components["parameters"]["PageSize"];
                page_token?: components["parameters"]["PageToken"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Register entries */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["CourierProvider"][];
                        next_page_token: string | null;
                    };
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
        };
    };
    registerCourierProvider: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CourierProviderRegister"];
            };
        };
        responses: {
            /** @description Registered */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CourierProvider"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    deactivateCourierProvider: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Deactivated */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CourierProvider"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    reactivateCourierProvider: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Reactivated */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CourierProvider"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    listApprovedAgents: {
        parameters: {
            query?: {
                /** @description Narrow to active or withdrawn agents. */
                status?: "ACTIVE" | "WITHDRAWN";
                page_size?: components["parameters"]["PageSize"];
                page_token?: components["parameters"]["PageToken"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Approved agents */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["ApprovedAgent"][];
                        next_page_token: string | null;
                    };
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
        };
    };
    approveAgent: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ApprovedAgentApprove"];
            };
        };
        responses: {
            /** @description Approved */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApprovedAgent"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    withdrawAgentApproval: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Withdrawn */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ApprovedAgent"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    failDeliveryStop: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DeliveryFailure"];
            };
        };
        responses: {
            /** @description Stop FAILED, attempt chain extended */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeliveryStop"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    openCashHandover: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CashHandoverOpen"];
            };
        };
        responses: {
            /** @description Handover OPEN, awaiting hub confirmation */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CashHandover"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    confirmCashHandover: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CashHandoverConfirm"];
            };
        };
        responses: {
            /** @description CONFIRMED, or VARIANCE_OPEN where the totals differ */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CashHandover"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    resolveCashVariance: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CashVarianceResolution"];
            };
        };
        responses: {
            /** @description Variance resolved, handover CLOSED */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CashHandover"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    completeStaffCredentialSetup: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CredentialSetup"];
            };
        };
        responses: {
            /** @description Password established. MFA provisioning returned for privileged identities only */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CredentialSetupResult"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            422: components["responses"]["RuleViolation"];
            429: components["responses"]["RateLimited"];
        };
    };
    completeMfaEnrolment: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MfaEnrolment"];
            };
        };
        responses: {
            /** @description Factor ACTIVE, grant consumed, identity authentication-ready */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MfaEnrolmentResult"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            422: components["responses"]["RuleViolation"];
            429: components["responses"]["RateLimited"];
        };
    };
    resetStaffMfa: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MfaReset"];
            };
        };
        responses: {
            /** @description Factor revoked, sessions terminated, re-enrolment grant issued */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MfaResetResult"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    reissueStaffCredentialSetup: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SetupGrantReissue"];
            };
        };
        responses: {
            /** @description A fresh STAFF_CREDENTIAL_SETUP grant issued; any prior PENDING grant superseded */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SetupGrant"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    listRiders: {
        parameters: {
            query?: {
                status?: "ACTIVE" | "INACTIVE" | "TEMPORARILY_UNAVAILABLE" | "SUSPENDED" | "OFFBOARDED";
                hub_id?: string;
                /** @description Matches name or phone. */
                q?: string;
                page_size?: components["parameters"]["PageSize"];
                page_token?: components["parameters"]["PageToken"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["RiderSummary"][];
                        next_page_token: string | null;
                    };
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
        };
    };
    getRider: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                riderId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RiderDetail"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    registerRiderDevice: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                riderId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Enrolment grant issued as a scannable URI. **Consumed by the rider's handset at
             *     completeRiderDeviceEnrolment** - this response is the documented transport between
             *     the two operations.
             */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControlNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeviceEnrolmentGrant"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    completeRiderDeviceEnrolment: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RiderDeviceEnrolment"];
            };
        };
        responses: {
            /** @description Public key registered, PIN established, rider authentication-ready */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RegisteredDevice"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            422: components["responses"]["RuleViolation"];
            429: components["responses"]["RateLimited"];
            503: components["responses"]["TrustDataUnavailable"];
        };
    };
    requestRiderSignInChallenge: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RiderChallengeRequest"];
            };
        };
        responses: {
            /** @description Challenge issued. Carries no account state */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RiderChallenge"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            429: components["responses"]["RateLimited"];
        };
    };
    completeVendorCredentialSetup: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["VendorCredentialSetup"];
            };
        };
        responses: {
            /** @description Shared secret established, browser registered, account authentication-ready */
            200: {
                headers: {
                    "Set-Cookie": components["headers"]["SetCookie"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RegisteredDevice"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            422: components["responses"]["RuleViolation"];
            429: components["responses"]["RateLimited"];
        };
    };
    requestAdditionalDeviceGrant: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Accepted. A `VENDOR_DEVICE_ENROLMENT` grant was issued to the registered channel.
             *     **No grant material is returned here** - a response that carried it would make the
             *     registered channel decorative.
             */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
            429: components["responses"]["RateLimited"];
        };
    };
    completeAdditionalDeviceEnrolment: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdditionalDeviceEnrolment"];
            };
        };
        responses: {
            /** @description Browser registered alongside any existing ones. No session issued */
            200: {
                headers: {
                    "Set-Cookie": components["headers"]["SetCookie"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RegisteredDevice"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            422: components["responses"]["RuleViolation"];
            429: components["responses"]["RateLimited"];
        };
    };
    listVendorDevices: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Every device registered against the calling vendor account */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RegisteredDevice"][];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
        };
    };
    revokeVendorDevice: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Device REVOKED; secret and other devices untouched */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RegisteredDevice"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    beginMfaReenrolment: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MfaReenrolmentBegin"];
            };
        };
        responses: {
            /** @description New PENDING factor provisioned; continuation grant issued. No Session */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MfaReenrolmentBegun"];
                };
            };
            422: components["responses"]["RuleViolation"];
            429: components["responses"]["RateLimited"];
        };
    };
    recoverStaffCredential: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CredentialRecoveryInitiation"];
            };
        };
        responses: {
            /**
             * @description `RecoveryRequest` created, `initiated_by` recorded, token delivered to the verified
             *     work email. **No session is created and the password is not yet changed** - the staff
             *     member completes recovery themselves.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RecoveryRequest"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    listVendorAccounts: {
        parameters: {
            query?: {
                status?: "ACTIVE" | "SUSPENDED";
                hub_id?: string;
                /** @description Matches the organisation name or the account identifier. */
                q?: string;
                page_size?: components["parameters"]["PageSize"];
                page_token?: components["parameters"]["PageToken"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["VendorAccountSummary"][];
                        next_page_token: string | null;
                    };
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
        };
    };
    getVendorAccount: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    ETag: components["headers"]["ETag"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VendorAccountDetail"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    recoverVendorCredential: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CredentialRecoveryInitiation"];
            };
        };
        responses: {
            /**
             * @description `RecoveryRequest` created, `initiated_by` recorded, token delivered to the registered
             *     recovery channel. **No session, and no credential changed yet.**
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RecoveryRequest"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    reissueVendorCredentialSetup: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SetupGrantReissue"];
            };
        };
        responses: {
            /** @description A fresh VENDOR_CREDENTIAL_SETUP grant issued; any prior PENDING grant superseded */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SetupGrant"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    reregisterRiderDevice: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                riderId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RiderDeviceReregistration"];
            };
        };
        responses: {
            /**
             * @description Re-registration grant issued as a scannable URI, identical in form to first
             *     registration. **Consumed by the new handset at completeRiderDeviceEnrolment.**
             */
            200: {
                headers: {
                    "Cache-Control": components["headers"]["CacheControlNoStore"];
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeviceEnrolmentGrant"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    reviseDeliveryCommitment: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DeliveryCommitmentRevision"];
            };
        };
        responses: {
            /** @description New commitment appended; the previous row is superseded and intact */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeliveryCommitment"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    listDeliveryCommitments: {
        parameters: {
            query?: {
                page_size?: components["parameters"]["PageSize"];
                page_token?: components["parameters"]["PageToken"];
            };
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Commitment history, append-only */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["DeliveryCommitment"][];
                        next_page_token: string | null;
                    };
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
        };
    };
    overrideServiceWindow: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ServiceWindowOverride"];
            };
        };
        responses: {
            /** @description Override recorded and audited */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PickupRequest"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    assessParcelHandling: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ParcelHandlingAssessment"];
            };
        };
        responses: {
            /** @description Assessment recorded */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ParcelHandlingAssessment"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["RuleViolation"];
        };
    };
    requestVerificationFallback: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["VerificationFallbackRequest"];
            };
        };
        responses: {
            /** @description Request raised for Ops review. Nothing is authorised by this call */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VerificationFallbackRequest"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
        };
    };
    recordNextStopContact: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RecipientContactRecord"];
            };
        };
        responses: {
            /** @description Recorded */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RecipientContactAttempt"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
        };
    };
    recordDoorstepContact: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RecipientContactRecord"];
            };
        };
        responses: {
            /** @description Recorded */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RecipientContactAttempt"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
        };
    };
    getStopPaymentDemand: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The stop's current payment position */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StopPaymentView"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
        };
    };
    listOperationalPaymentDemands: {
        parameters: {
            query?: {
                status?: "OPEN" | "PARTIALLY_SETTLED";
                order_id?: string;
                page_size?: components["parameters"]["PageSize"];
                page_token?: components["parameters"]["PageToken"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Demands in scope */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["OperationalPaymentDemand"][];
                        next_page_token: string | null;
                    };
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
        };
    };
    initiatePaymentCollection: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PaymentCollectionRequest"];
            };
        };
        responses: {
            /** @description Collection created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaymentCollection"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
        };
    };
    authorizePaymentFallbackWhileUnresolved: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["FallbackAuthorizationRequest"];
            };
        };
        responses: {
            /** @description Authorised */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaymentFallbackAuthorization"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
        };
    };
    getPaymentCollection: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaymentCollection"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
        };
    };
    receiveHubtelPaymentCallback: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProviderPaymentCallback"];
            };
        };
        responses: {
            /** @description Accepted for verification */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["ValidationFailed"];
        };
    };
    listRedeliveries: {
        parameters: {
            query?: {
                page_size?: components["parameters"]["PageSize"];
                page_token?: components["parameters"]["PageToken"];
            };
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["Redelivery"][];
                        next_page_token: string | null;
                    };
                };
            };
            401: components["responses"]["Unauthenticated"];
        };
    };
    scheduleRedelivery: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RedeliveryScheduleRequest"];
            };
        };
        responses: {
            /** @description Scheduled */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Redelivery"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
        };
    };
    cancelRedelivery: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RedeliveryCancellationRequest"];
            };
        };
        responses: {
            /** @description Cancelled */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Redelivery"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
        };
    };
    initiateReturn: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description ReturnRecord COMMITTED; order RETURN_TO_VENDOR_IN_PROGRESS */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReturnRecord"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    requestReturnOtp: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OTP dispatched to the contact of record. The value is not returned */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    closeReturnHandover: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DeliveryOtpSubmission"];
            };
        };
        responses: {
            /** @description ReturnRecord COMPLETED; order RETURNED_TO_VENDOR */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReturnRecord"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    proposeAdjustmentResolution: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdjustmentResolutionProposal"];
            };
        };
        responses: {
            /** @description Resolution PROPOSED; the adjustment stays OPEN */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FinancialAdjustmentResolution"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    decideAdjustmentResolution: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdjustmentResolutionDecision"];
            };
        };
        responses: {
            /** @description Resolution APPROVED or REJECTED */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FinancialAdjustmentResolution"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    submitVendorContactAssistance: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["VendorContactAssistance"];
            };
        };
        responses: {
            /** @description Accepted for Ops review */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
        };
    };
    decideDeliveryLocationChange: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Decided */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
        };
    };
    requestDeliveryLocationChange: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DeliveryLocationChangeRequest"];
            };
        };
        responses: {
            /** @description Recorded for Ops decision */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
        };
    };
    confirmManualPayment: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ManualPaymentConfirmation"];
            };
        };
        responses: {
            /** @description Receipt confirmed and audited against the confirming actor */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ManualPaymentConfirmation"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    listRoadExpenses: {
        parameters: {
            query?: {
                page_size?: components["parameters"]["PageSize"];
                page_token?: components["parameters"]["PageToken"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Road expenses in scope */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["RoadExpense"][];
                        next_page_token: string | null;
                    };
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
        };
    };
    createRoadExpense: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RoadExpenseCreate"];
            };
        };
        responses: {
            /** @description Expense recorded in CLAIMED */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RoadExpense"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    decideRoadExpense: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RoadExpenseDecision"];
            };
        };
        responses: {
            /** @description Expense APPROVED or REJECTED */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RoadExpense"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    getRunCashSummary: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Customer-payment and cash-custody positions, per order and per run */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunCashSummary"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
        };
    };
    listHubCashReconciliations: {
        parameters: {
            query?: {
                page_size?: components["parameters"]["PageSize"];
                page_token?: components["parameters"]["PageToken"];
            };
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Reconciliations in scope */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["HubCashReconciliation"][];
                        next_page_token: string | null;
                    };
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
        };
    };
    recordHubCashCount: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["HubCashCount"];
            };
        };
        responses: {
            /** @description Reconciliation COUNTED, then RECONCILED or VARIANCE_OPEN */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HubCashReconciliation"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    resolveHubCashVariance: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CashVarianceResolution"];
            };
        };
        responses: {
            /** @description Variance dispositioned; expected_minor intact */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HubCashReconciliation"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    recordCashDisposition: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CashDisposition"];
            };
        };
        responses: {
            /** @description Disposition RECORDED */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CashDisposition"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    createVendorOrganization: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["VendorOrganizationCreate"];
            };
        };
        responses: {
            /** @description Created in PENDING_SENIOR_OPS_REVIEW, granting nothing */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VendorOrganization"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    decideVendorOrganization: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["VendorOrganizationDecision"];
            };
        };
        responses: {
            /** @description Activated to ACTIVE, or REJECTED */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VendorOrganization"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    enableVendorAllowance: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["VendorAllowanceDecision"];
            };
        };
        responses: {
            /** @description Allowance ENABLED */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VendorAccountAllowance"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    disableVendorAllowance: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["VendorAllowanceDecision"];
            };
        };
        responses: {
            /** @description Allowance DISABLED_PREPAYMENT_ONLY */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VendorAccountAllowance"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    suspendVendor: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["VendorSuspension"];
            };
        };
        responses: {
            /** @description Suspended; holds created for every non-terminal work item */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VendorOrganization"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    reactivateVendor: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["VendorReactivation"];
            };
        };
        responses: {
            /** @description Reactivated; every remaining hold RESUMED */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VendorOrganization"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    terminateVendor: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["VendorTermination"];
            };
        };
        responses: {
            /** @description TERMINATED; obligations preserved */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VendorOrganization"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    decideHeldParcelDisposition: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["HeldParcelDisposition"];
            };
        };
        responses: {
            /** @description Disposition recorded */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VendorSuspensionHold"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    escalateHeldParcel: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["HeldParcelEscalation"];
            };
        };
        responses: {
            /** @description Escalated to AUTHORIZED_EXCEPTION_DISPOSITION */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VendorSuspensionHold"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    listSecurityRiskHolds: {
        parameters: {
            query?: {
                page_size?: components["parameters"]["PageSize"];
                page_token?: components["parameters"]["PageToken"];
            };
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Every hold on this vendor, open and cleared */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["SecurityRiskHold"][];
                        next_page_token: string | null;
                    };
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    openSecurityRiskHold: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Hold is OPEN */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SecurityRiskHold"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    clearSecurityRiskHold: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Hold is CLEARED */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SecurityRiskHold"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    createVendorPickupLocation: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["VendorPickupLocationCreate"];
            };
        };
        responses: {
            /** @description Saved and active */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VendorPickupLocation"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    updateVendorPickupLocation: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["VendorPickupLocationUpdate"];
            };
        };
        responses: {
            /** @description Updated */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VendorPickupLocation"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    setDefaultVendorPickupLocation: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description This location is now the single default */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VendorPickupLocation"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    deactivateVendorPickupLocation: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Retired and retained */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VendorPickupLocation"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    getVendorOperationalEligibility: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Derived eligibility, computed at read time */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VendorOperationalEligibility"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
        };
    };
    getDailyOperationsCashReport: {
        parameters: {
            query: {
                /** @description The operating day to report on. Reflects source-record state as of read time. */
                business_date: string;
            };
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Operations and money-flow projection for this hub-day */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DailyOperationsCashReport"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
        };
    };
    listParcelCustodyReturns: {
        parameters: {
            query?: {
                page_size?: components["parameters"]["PageSize"];
                page_token?: components["parameters"]["PageToken"];
                /** @description Narrow to one state. **DECLARED is the unconfirmed set.** */
                state?: "DECLARED" | "RECEIVED" | "VARIANCE_OPEN" | "CLOSED";
                delivery_run_id?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Returns in scope, newest first */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["ParcelCustodyReturn"][];
                        next_page_token: string | null;
                    };
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
        };
    };
    openParcelCustodyReturn: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ParcelCustodyReturnCreate"];
            };
        };
        responses: {
            /** @description Return opened in DECLARED. No custody has moved */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ParcelCustodyReturn"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    getParcelCustodyReturn: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The return and its lines */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ParcelCustodyReturn"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    confirmParcelCustodyReturn: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /**
                 * @description ETag from the last read. A mismatch returns 409 `STATE_CONFLICT`. Version-based rather
                 *     than state-based, so a concurrent change that does not alter state is still caught.
                 */
                "If-Match": components["parameters"]["IfMatch"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ParcelCustodyReturnConfirm"];
            };
        };
        responses: {
            /** @description Receipt confirmed. state is RECEIVED, or VARIANCE_OPEN where lines differ */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ParcelCustodyReturn"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    resolveParcelCustodyVariance: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Client-generated. **Required for every operation whose contract declares this parameter**;
                 *     **all rider mutation commands declare it** unless an operation states otherwise. Same key
                 *     and same payload replays the original result; same key with a different payload returns
                 *     409 `IDEMPOTENCY_KEY_CONFLICT`.
                 *
                 *     **Rider commands carry it for connection resilience, not because the command is
                 *     offline-capable** (see rule 4). Ops commands carry it where a repeated submission would
                 *     otherwise repeat a side effect - `reassignPickupRequestHub`, `cancelPickupRequest`,
                 *     `escalatePickupRequest`, `extendPickupAttempts`, `submitBlindCount`, `closeHubIntake`
                 *     and `setManifestStopOrder` are the current examples (the last two added for their new
                 *     audit events under CRIT-05/CRIT-09, not a repeatable business effect) - and it is why
                 *     this description no longer says *rider* alone: **a parameter description narrower than
                 *     the parameter's declared use is a contract disagreeing with itself.**
                 *
                 *     **Not every Ops mutation carries it, and the omission is deliberate where a guarded
                 *     state transition creates no second record and repeats no charge** -
                 *     `confirmPickupRequest` is the current example: `If-Match` alone already makes a stale
                 *     retry fail cleanly, and confirmation reserves no credit and moves no money (§5.2.1).
                 *
                 *     **The key is scoped to the calling principal and the operation**, so a
                 *     key chosen by one caller can never match another's. Clients need no coordination and
                 *     may reuse any value they like across operations.
                 *
                 *     **R0 scoped it globally, and the consequence was not a collision.** Two vendors
                 *     choosing `retry-1` on the same operation is expected behaviour for two independent
                 *     clients; the second did not get an error, it got a **replay of the first vendor's
                 *     stored result** - one caller receiving another's response body, through the mechanism
                 *     that exists to make retries safe.
                 */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ParcelCustodyVarianceResolution"];
            };
        };
        responses: {
            /** @description Every line resolved; the return is CLOSED */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ParcelCustodyReturn"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
    listReasonDefinitions: {
        parameters: {
            query?: {
                /** @description Narrow to one reason domain, e.g. DELIVERY_FAILURE or RECIPIENT_CONTACT. */
                domain?: string;
                /** @description Narrow to the reasons valid at one recipient-contact checkpoint - the codes whose validCheckpoints contains this value. **This is the filter that makes REASON_NOT_VALID_FOR_CHECKPOINT avoidable at the screen** rather than discoverable only by submitting and being refused. */
                checkpoint?: "PRE_DISPATCH" | "NEXT_STOP" | "DOORSTEP";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Reason definitions */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReasonDefinition"][];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
        };
    };
    upsertReasonDefinition: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The stable reason code. Never reused after deactivation. */
                code: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReasonDefinition"];
            };
        };
        responses: {
            /** @description Reason definition stored */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReasonDefinition"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["RuleViolation"];
        };
    };
    listAccountingExports: {
        parameters: {
            query?: {
                /** @description `AccountingExportScope` — errors-and-enums.md §6. */
                scope?: "SINGLE_HUB" | "ALL_HUBS";
                /** @description Meaningful only against `SINGLE_HUB` exports; `ALL_HUBS` records carry no hub. */
                hub_id?: string;
                period_from?: string;
                period_to?: string;
                /** @description `AccountingExportStatus` — errors-and-enums.md §6. **No machine** (state-machines.md §20.7). */
                status?: "REQUESTED" | "GENERATED" | "FAILED";
                page_size?: components["parameters"]["PageSize"];
                page_token?: components["parameters"]["PageToken"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Accounting exports in scope */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["AccountingExport"][];
                        next_page_token: string | null;
                    };
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
        };
    };
    requestAccountingExport: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AccountingExportRequest"];
            };
        };
        responses: {
            /**
             * @description Export requested. `status` is `REQUESTED`; on an idempotent retry this is the
             *     record the first request created, unchanged.
             */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AccountingExport"];
                };
            };
            400: components["responses"]["ValidationFailed"];
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            422: components["responses"]["RuleViolation"];
        };
    };
    getAccountingExport: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description The export record — scope, period, schema version, status, row counts, manifest
             *     digest and `file_available_until`. Returned whether or not the package still exists.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AccountingExport"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
        };
    };
    createAccountingExportRetrievalAuthorization: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description UUID v7. The human-readable `code` is an attribute, never a path parameter. */
                id: components["parameters"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Short-lived single-object retrieval authorization */
            200: {
                headers: {
                    /** @description Always `no-store`. The capability must not be cached by any intermediary */
                    "Cache-Control": "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AccountingExportRetrievalAuthorization"];
                };
            };
            401: components["responses"]["Unauthenticated"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            422: components["responses"]["RuleViolation"];
        };
    };
}
