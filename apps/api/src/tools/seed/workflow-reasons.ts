import type {
  REASON_ATTRIBUTIONS,
  WORKFLOW_REASON_DOMAINS,
} from '../../platform/database/schema/reference-data.js';

/**
 * The workflow reasons that are specified and seeded (S1.7; domain-model.md section 3.9, "The `PICKUP_STOP_SKIP` contents are seeded",
 * `MSC-DEC-412`): the four reasons an authorised Ops skip of a pickup stop gives. The launch seed carried the twelve identity reasons
 * only, because "the workflow reasons are seeded by the slice that uses them" (MIGRATION_AND_SEEDING.md section 4); SLICE-001 uses this
 * one, so the reference seed writes it for a new database and migration 0044 writes it for one seeded earlier.
 *
 * **The three pickup catalogues** the Product Owner admitted on 29 October 2026 (D-05) and whose 25 codes he approved the same day:
 * `PICKUP_CANCELLATION` (each code's attribution decides the cancellation charge), `PICKUP_FAILURE` (within the four fixed failure
 * categories) and `PICKUP_SHORT_COUNT`. They are the three tables of the same section; a new database gets them from the seed and one
 * seeded earlier from migration 0054, and `seed-data.test.ts` holds this list to the document and to the list he approved.
 * `DELIVERY_FAILURE`, `RECIPIENT_CONTACT` and `HANDOFF_FAILURE` belong to later slices.
 *
 * **The label.** The document gives each code, the next action it routes to, its attribution and whether a note is required, and no
 * label. The label is the code's own words in sentence case and nothing added; the Product Owner may replace the copy (a finding of
 * S1.7), and `seed-data.test.ts` reads the document and fails when this list and its table differ.
 *
 * For all four (the document): active, no checkpoints (`valid_checkpoints` is null for this domain), `consumes_delivery_attempt` false
 * and inert, no `permitted_operations` (the identity domains only), and no photo, contact attempt, approval, Ops review or escalation
 * required. A skip consumes no pickup attempt either; the Vendor is always notified. The 25 codes of the three catalogues are active, with
 * no checkpoints, no permitted operations, no approval, no Ops review and no escalation, and consume no delivery attempt; the requirements
 * they carry are the document's tables'.
 *
 * **The eight carry-over reasons** (`PICKUP_CARRYOVER`; the decision of 2 November 2026, the reviewer's recommendation applied on the Product
 * Owner's instruction): the reason a manifest gives for each overdue request it carries over (`createPickupManifest`). They explain a
 * carry-over and do nothing else: the same flags as the three catalogues (no approval, no Ops review, no escalation, no delivery attempt),
 * so a carry-over reason never creates a charge, consumes an attempt or resets the promise it explains. **A code is the table's primary key,
 * so one code can belong to one domain only**: five of the eight approved names (`ROAD_OR_WEATHER_DISRUPTION`, `NO_RIDER_AVAILABLE`,
 * `OTHER_CUSTOMER_REASON`, `OTHER_MELARC_REASON`, `OTHER_EXTERNAL_REASON`) are already codes of `PICKUP_CANCELLATION`, with other
 * requirements for one of them, and cannot be written twice. Those five carry the prefix `CARRYOVER_`, and the names are approved as written
 * (the Product Owner, 2 November 2026; OB-S1-36); the label is the approved words without it. The document's table carries the label, since
 * the labels here are not the code in sentence case.
 */
export interface WorkflowReasonSeed {
  readonly code: string;
  readonly domain: (typeof WORKFLOW_REASON_DOMAINS)[number];
  readonly label: string;
  readonly validCheckpoints: null;
  readonly requiresNote: boolean;
  readonly requiresPhoto: boolean;
  readonly requiresContactAttempt: boolean;
  readonly requiresApproval: boolean;
  readonly attribution: (typeof REASON_ATTRIBUTIONS)[number];
  readonly consumesDeliveryAttempt: boolean;
  readonly requiresOpsReview: boolean;
  readonly requiresEscalation: boolean;
  readonly active: boolean;
  readonly permittedOperations: null;
}

/** The code's own words in sentence case and nothing added: the label until the Product Owner rewords it. */
const sentenceCase = (code: string): string => {
  const words = code.toLowerCase().split('_').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

type Attribution = WorkflowReasonSeed['attribution'];

/** What a reason of the three pickup catalogues may make mandatory beyond its code: a note, a contact attempt, a photo. */
interface Requirements {
  readonly note?: true;
  readonly contactAttempt?: true;
  readonly photo?: true;
}

const workflowReason = (
  domain: WorkflowReasonSeed['domain'],
  code: string,
  attribution: Attribution,
  requirements: Requirements,
): WorkflowReasonSeed => ({
  code,
  domain,
  label: sentenceCase(code),
  validCheckpoints: null,
  requiresNote: requirements.note === true,
  requiresPhoto: requirements.photo === true,
  requiresContactAttempt: requirements.contactAttempt === true,
  requiresApproval: false,
  attribution,
  consumesDeliveryAttempt: false,
  requiresOpsReview: false,
  requiresEscalation: false,
  active: true,
  permittedOperations: null,
});

const stopSkip = (
  code: string,
  attribution: Attribution,
  requiresNote: boolean,
): WorkflowReasonSeed =>
  workflowReason('PICKUP_STOP_SKIP', code, attribution, requiresNote ? { note: true } : {});

/** A cancellation reason: the attribution decides the charge (MSC-DEC-388), and a note is asked for only where the table says. */
const cancellation = (code: string, attribution: Attribution, note = false): WorkflowReasonSeed =>
  workflowReason('PICKUP_CANCELLATION', code, attribution, note ? { note: true } : {});

/** A pickup failure reason: every one needs a note, and the table says which need a contact attempt or a photo as well. */
const failure = (
  code: string,
  attribution: Attribution,
  more: Omit<Requirements, 'note'> = {},
): WorkflowReasonSeed =>
  workflowReason('PICKUP_FAILURE', code, attribution, { note: true, ...more });

/**
 * A carry-over reason: attributed as the catalogue attributes (who the delay is owed to), and it asks for a note wherever the reason is a
 * judgement or a statement someone made. The label is given, because five codes carry a prefix their words do not.
 */
const carryover = (
  code: string,
  attribution: Attribution,
  label: string,
  requiresNote: boolean,
): WorkflowReasonSeed => ({
  ...workflowReason('PICKUP_CARRYOVER', code, attribution, requiresNote ? { note: true } : {}),
  label,
});

/** A short-count reason: always the customer's side of the count, and the table says which need a note or a photo. */
const shortCount = (code: string, requirements: Requirements = {}): WorkflowReasonSeed =>
  workflowReason('PICKUP_SHORT_COUNT', code, 'CUSTOMER', requirements);

export const WORKFLOW_REASONS: readonly WorkflowReasonSeed[] = [
  stopSkip('RUN_CUT_SHORT', 'MELARC', false),
  stopSkip('VENDOR_REQUESTED_SKIP', 'CUSTOMER', false),
  stopSkip('LOCATION_INACCESSIBLE', 'EXTERNAL', true),
  stopSkip('STOP_RAISED_IN_ERROR', 'MELARC', true),

  cancellation('VENDOR_NO_LONGER_NEEDS_PICKUP', 'CUSTOMER'),
  cancellation('VENDOR_PARCELS_NOT_READY', 'CUSTOMER'),
  cancellation('VENDOR_WRONG_DETAILS', 'CUSTOMER'),
  cancellation('DUPLICATE_REQUEST', 'CUSTOMER'),
  cancellation('OTHER_CUSTOMER_REASON', 'CUSTOMER', true),
  cancellation('NO_RIDER_AVAILABLE', 'MELARC'),
  cancellation('HUB_SYSTEM_FAULT', 'MELARC'),
  cancellation('INTERNAL_ROUTING_ERROR', 'MELARC'),
  cancellation('OTHER_MELARC_REASON', 'MELARC', true),
  cancellation('ROAD_OR_WEATHER_DISRUPTION', 'EXTERNAL'),
  cancellation('GENUINE_EMERGENCY', 'EXTERNAL', true),
  cancellation('OTHER_EXTERNAL_REASON', 'EXTERNAL', true),

  failure('VENDOR_NOT_AT_LOCATION', 'CUSTOMER', { contactAttempt: true }),
  failure('VENDOR_UNREACHABLE_BY_PHONE', 'CUSTOMER', { contactAttempt: true }),
  failure('ENTRY_REFUSED_BY_SECURITY', 'EXTERNAL', { photo: true }),
  failure('LOCATION_CLOSED', 'EXTERNAL', { photo: true }),
  failure('PARCELS_NOT_PACKED', 'CUSTOMER'),
  failure('VENDOR_ASKED_TO_COME_BACK_LATER', 'CUSTOMER'),
  failure('VENDOR_REFUSED_HANDOVER', 'CUSTOMER'),
  failure('PARCEL_NOT_ACCEPTABLE', 'CUSTOMER'),

  shortCount('SOME_PARCELS_NOT_READY'),
  shortCount('VENDOR_HELD_BACK_PARCELS', { note: true }),
  shortCount('PARCEL_DAMAGED_OR_UNSAFE', { photo: true }),
  shortCount('BOOKED_COUNT_WRONG'),
  shortCount('VENDOR_DISPUTES_COUNT', { note: true }),

  carryover('CARRYOVER_ROAD_OR_WEATHER_DISRUPTION', 'EXTERNAL', 'Road or weather disruption', true),
  carryover('CARRYOVER_NO_RIDER_AVAILABLE', 'MELARC', 'No rider available', false),
  carryover('RUN_FULL_OR_OUT_OF_TIME', 'MELARC', 'Run full or out of time', true),
  carryover('VENDOR_ASKED_FOR_LATER_PICKUP', 'CUSTOMER', 'Vendor asked for a later pickup', true),
  carryover('HUB_OR_SYSTEM_FAULT', 'MELARC', 'Hub or system fault', true),
  carryover('CARRYOVER_OTHER_CUSTOMER_REASON', 'CUSTOMER', 'Other customer reason', true),
  carryover('CARRYOVER_OTHER_MELARC_REASON', 'MELARC', 'Other Melarc reason', true),
  carryover('CARRYOVER_OTHER_EXTERNAL_REASON', 'EXTERNAL', 'Other external reason', true),
];

/** A workflow reason as the reference seed's database function takes it: the columns of `reason_code` by name. */
export function workflowReasonRow(reason: WorkflowReasonSeed): Readonly<Record<string, unknown>> {
  return {
    code: reason.code,
    domain: reason.domain,
    valid_checkpoints: reason.validCheckpoints,
    label: reason.label,
    requires_note: reason.requiresNote,
    requires_photo: reason.requiresPhoto,
    requires_contact_attempt: reason.requiresContactAttempt,
    requires_approval: reason.requiresApproval,
    attribution: reason.attribution,
    consumes_delivery_attempt: reason.consumesDeliveryAttempt,
    requires_ops_review: reason.requiresOpsReview,
    requires_escalation: reason.requiresEscalation,
    active: reason.active,
    permitted_operations: reason.permittedOperations,
  };
}
