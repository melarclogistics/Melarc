import { sql, type SQL } from 'drizzle-orm';

/**
 * The pickup request as a read answers it (S1.13; domain-model.md section 6.2, the contract's `PickupRequest`), made from a row of
 * `pickup_request`. Nothing here is derived from the client and nothing is a price: the estimate is the inputs of the booking estimate,
 * given only by the operations that compute it (a read carries none, S1.13), and the cancellation charge is the amount that was applied,
 * as snapshotted.
 */
export interface LocationView {
  readonly address: string;
  readonly landmark?: string;
  readonly map_link?: string;
  readonly latitude?: number;
  readonly longitude?: number;
}

export interface MoneyView {
  readonly amount_minor: number;
  readonly currency: 'GHS';
}

export interface SettingSnapshotView {
  readonly amount_minor: number;
  readonly setting_key: string;
  readonly effective_version: string;
}

export interface EstimateComponentView {
  readonly kind: 'SERVICE_AREA_BASE_FEE' | 'CORRIDOR_OFF_DAY_FEE' | 'SINGLE_PACKAGE_PICKUP_FEE';
  readonly hub_id: string;
  readonly setting_key: string;
  readonly effective_version: string;
  readonly quantity: number;
  readonly amount: MoneyView;
}

export interface IndicativeEstimateView {
  readonly status: 'AVAILABLE' | 'UNAVAILABLE_OUTSIDE_SERVICE_AREA' | 'UNAVAILABLE_SETTING_MISSING';
  readonly provisional: true;
  readonly total: MoneyView | null;
  readonly assumes_size_class: 'SMALL';
  readonly excludes: readonly ('SIZE_SURCHARGE' | 'HIGH_VALUE_SURCHARGE')[];
  readonly components: readonly EstimateComponentView[];
}

/**
 * The exception as a request reads it. `requested_by`, `approved_by` and `note` are staff's: a caller that is not staff reads the outcome
 * only (the Product Owner's decision of 29 October 2026), and those three are then absent.
 */
export interface OnePackageExceptionView {
  readonly id: string;
  readonly state: 'REQUESTED' | 'APPROVED' | 'REJECTED';
  readonly requested_by?: string;
  readonly requested_at: string;
  readonly approved_by?: string | null;
  readonly decided_at: string | null;
  readonly note?: string;
  readonly recipient: {
    readonly name: string;
    readonly phone: string;
    readonly location: LocationView;
  };
  readonly single_package_fee: MoneyView | null;
}

/** Who reads an exception: staff read all of it, and every other principal reads the outcome only. */
export type ExceptionAudience = 'STAFF' | 'OUTCOME_ONLY';

/** Fail closed: only a staff principal is the staff audience, so a kind of principal added later reads the outcome only. */
export const exceptionAudienceOf = (principalType: string): ExceptionAudience =>
  principalType === 'STAFF' ? 'STAFF' : 'OUTCOME_ONLY';

/**
 * The outcome of an exception: its state, when it was asked for and decided, the recipient and the fee that became due, and nothing of
 * staff's (no note, no id of the staff who asked for or approved it). Written out member by member, so that a member added to the view
 * is staff's until someone says otherwise. The ETag digests this and nothing more of the exception, so that every audience holds one token.
 */
export function exceptionOutcomeOf(exception: OnePackageExceptionView): OnePackageExceptionView {
  return {
    id: exception.id,
    state: exception.state,
    requested_at: exception.requested_at,
    decided_at: exception.decided_at,
    recipient: exception.recipient,
    single_package_fee: exception.single_package_fee,
  };
}

/** The view an audience is shown: the exception in whole for staff, its outcome for the rest. */
export function forAudience(
  view: PickupRequestView,
  audience: ExceptionAudience,
): PickupRequestView {
  if (audience === 'STAFF' || view.one_package_exception === null) return view;
  return { ...view, one_package_exception: exceptionOutcomeOf(view.one_package_exception) };
}

/** The members of the representation, in the contract's words. The ETag is a digest of exactly these, so a new member must be hashed. */
export interface PickupRequestView {
  readonly id: string;
  readonly code: string;
  readonly state: 'PENDING' | 'CONFIRMED' | 'DECLINED' | 'CANCELLED';
  readonly responsible_hub_id: string;
  readonly pickup_intent: 'OWN_PACKAGES' | 'COLLECT_FOR_VENDOR' | 'ADHOC_SENDER';
  readonly vendor_organization_id: string | null;
  readonly ad_hoc_sender_id: string | null;
  /** Absent, not null, for an intent that has none (the contract types each as the object): a request is not a collection for a vendor. */
  readonly collection_point?: unknown;
  readonly collection_reference?: unknown;
  readonly collection_item?: unknown;
  readonly destination_location_id: string | null;
  readonly pickup_location: LocationView | null;
  readonly resolved_pickup_location: LocationView;
  readonly current_item_description: string | null;
  readonly scheduled_service_date: string;
  readonly declared_package_count: number;
  readonly default_payer_intent: string;
  readonly one_package_exception_id: string | null;
  readonly attempt_number: number;
  readonly replaces_request_id: string | null;
  readonly cancelled_by_actor_type: 'VENDOR' | 'OPS' | null;
  readonly declared_value_minor: number | null;
  readonly liability_cap_acknowledged_at: string | null;
  readonly liability_cap_snapshot: SettingSnapshotView | null;
  readonly cancellation_charge_outcome: string | null;
  readonly cancellation_charge: MoneyView | null;
  readonly created_at: string;
  readonly confirmed_at: string | null;
  readonly cutoff_exception_state: string | null;
  readonly vendor_pickup_location_id: string | null;
  readonly primary_phone: string | null;
  readonly secondary_phone: string | null;
  readonly replacement_request_id: string | null;
  readonly indicative_estimate: IndicativeEstimateView | null;
  readonly cancellation_charge_snapshot: SettingSnapshotView | null;
  readonly sender_name: string | null;
  readonly split_basis: 'FIXED_AMOUNT' | 'PERCENTAGE' | null;
  readonly split_sender_amount: MoneyView | null;
  readonly split_sender_percentage: number | null;
  readonly location_overrides: LocationView | null;
  readonly attempt_extension_id: string | null;
  readonly cancelled_at: string | null;
  /** When Ops judged the failed request out of its own hands (`escalatePickupRequest`); null until it does. */
  readonly escalated_at: string | null;
  readonly cancellation_reason: { readonly code: string; readonly label: string } | null;
  readonly rider_assigned: boolean;
  readonly one_package_exception: OnePackageExceptionView | null;
}

/** A row of `pickup_request` as the reads ask for it: the columns by name, the date and the moments as text. */
export interface PickupRequestRow {
  readonly id: string;
  readonly code: string;
  readonly state: PickupRequestView['state'];
  readonly responsible_hub_id: string;
  readonly pickup_intent: PickupRequestView['pickup_intent'];
  readonly vendor_organization_id: string | null;
  readonly ad_hoc_sender_id: string | null;
  readonly sender_name: string;
  readonly collection_point: unknown;
  readonly collection_reference: unknown;
  readonly collection_item: unknown;
  readonly destination_location_id: string | null;
  readonly pickup_location: LocationView | null;
  readonly resolved_pickup_location: LocationView;
  readonly current_item_description: string | null;
  readonly scheduled_service_date: string;
  readonly declared_package_count: number;
  readonly default_payer_intent: string;
  readonly one_package_exception_id: string | null;
  readonly attempt_number: number;
  readonly replaces_request_id: string | null;
  readonly replacement_request_id: string | null;
  readonly cancelled_by_actor_type: 'VENDOR' | 'OPS' | null;
  readonly declared_value_minor: number | null;
  readonly liability_cap_acknowledged_at: string | Date | null;
  readonly liability_cap_snapshot: SettingSnapshotView | null;
  readonly cancellation_charge_outcome: string | null;
  readonly cancellation_charge_snapshot: SettingSnapshotView | null;
  readonly created_at: string | Date;
  readonly created_at_text: string;
  readonly confirmed_at: string | Date | null;
  readonly cancelled_at: string | Date | null;
  readonly escalated_at: string | Date | null;
  readonly cutoff_exception_state: string | null;
  readonly vendor_pickup_location_id: string | null;
  readonly primary_phone: string | null;
  readonly secondary_phone: string | null;
  readonly split_basis: 'FIXED_AMOUNT' | 'PERCENTAGE' | null;
  readonly split_sender_amount_minor: number | null;
  readonly split_sender_percentage: string | number | null;
  readonly location_overrides: LocationView | null;
  readonly attempt_extension_id: string | null;
  readonly cancellation_reason_code: string | null;
  readonly cancellation_reason_label: string | null;
  readonly rider_assigned: boolean;
  readonly version: number;
}

/**
 * The columns a read selects. The service date is text (a `date` is read as the calendar day it is, whatever the server's time zone),
 * and the creation moment is also read as the text the database prints, because it is the position of a page (a token carries its
 * microseconds, which a JavaScript date cannot).
 */
export const REQUEST_COLUMNS: SQL = sql.raw(`
  id, code, state, responsible_hub_id, pickup_intent, vendor_organization_id, ad_hoc_sender_id, sender_name,
  collection_point, collection_reference, collection_item, destination_location_id, pickup_location, resolved_pickup_location,
  current_item_description, scheduled_service_date::text as scheduled_service_date, declared_package_count, default_payer_intent,
  one_package_exception_id, attempt_number, replaces_request_id, replacement_request_id, cancelled_by_actor_type,
  declared_value_minor, liability_cap_acknowledged_at, liability_cap_snapshot, cancellation_charge_outcome,
  cancellation_charge_snapshot, created_at, created_at::text as created_at_text, confirmed_at, cancelled_at, escalated_at, cutoff_exception_state,
  vendor_pickup_location_id, primary_phone, secondary_phone, split_basis, split_sender_amount_minor, split_sender_percentage,
  location_overrides, attempt_extension_id, cancellation_reason_code, cancellation_reason_label, rider_assigned, version`);

const iso = (value: string | Date | null): string | null =>
  value === null ? null : (value instanceof Date ? value : new Date(value)).toISOString();

const money = (minor: number): MoneyView => ({ amount_minor: minor, currency: 'GHS' });

/** What a read adds to the row: the estimate of the operation that computed it, and the exception the request carries. */
export interface ViewExtras {
  readonly estimate?: IndicativeEstimateView | null;
  readonly exception?: OnePackageExceptionView | null;
}

export function viewOf(row: PickupRequestRow, extras: ViewExtras = {}): PickupRequestView {
  const charged =
    row.cancellation_charge_outcome === 'APPLIED' && row.cancellation_charge_snapshot !== null;
  return {
    id: row.id,
    code: row.code,
    state: row.state,
    responsible_hub_id: row.responsible_hub_id,
    pickup_intent: row.pickup_intent,
    vendor_organization_id: row.vendor_organization_id,
    ad_hoc_sender_id: row.ad_hoc_sender_id,
    ...(row.collection_point === null ? {} : { collection_point: row.collection_point }),
    ...(row.collection_reference === null
      ? {}
      : { collection_reference: row.collection_reference }),
    ...(row.collection_item === null ? {} : { collection_item: row.collection_item }),
    destination_location_id: row.destination_location_id,
    pickup_location: row.pickup_location,
    resolved_pickup_location: row.resolved_pickup_location,
    current_item_description: row.current_item_description,
    scheduled_service_date: row.scheduled_service_date,
    declared_package_count: row.declared_package_count,
    default_payer_intent: row.default_payer_intent,
    one_package_exception_id: row.one_package_exception_id,
    attempt_number: row.attempt_number,
    replaces_request_id: row.replaces_request_id,
    cancelled_by_actor_type: row.cancelled_by_actor_type,
    declared_value_minor: row.declared_value_minor,
    liability_cap_acknowledged_at: iso(row.liability_cap_acknowledged_at),
    liability_cap_snapshot: row.liability_cap_snapshot,
    cancellation_charge_outcome: row.cancellation_charge_outcome,
    cancellation_charge: charged ? money(row.cancellation_charge_snapshot.amount_minor) : null,
    created_at: iso(row.created_at) ?? '',
    confirmed_at: iso(row.confirmed_at),
    cutoff_exception_state: row.cutoff_exception_state,
    vendor_pickup_location_id: row.vendor_pickup_location_id,
    primary_phone: row.primary_phone,
    secondary_phone: row.secondary_phone,
    replacement_request_id: row.replacement_request_id,
    indicative_estimate: extras.estimate ?? null,
    cancellation_charge_snapshot: row.cancellation_charge_snapshot,
    sender_name: row.sender_name,
    split_basis: row.split_basis,
    split_sender_amount:
      row.split_sender_amount_minor === null ? null : money(row.split_sender_amount_minor),
    split_sender_percentage:
      row.split_sender_percentage === null ? null : Number(row.split_sender_percentage),
    location_overrides: row.location_overrides,
    attempt_extension_id: row.attempt_extension_id,
    cancelled_at: iso(row.cancelled_at),
    escalated_at: iso(row.escalated_at),
    cancellation_reason:
      row.cancellation_reason_code === null || row.cancellation_reason_label === null
        ? null
        : { code: row.cancellation_reason_code, label: row.cancellation_reason_label },
    rider_assigned: row.rider_assigned,
    one_package_exception: extras.exception ?? null,
  };
}
