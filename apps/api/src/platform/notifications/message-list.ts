import type { NotificationAudience, NotificationChannel } from './notification-vocabulary.js';

/**
 * The list of messages the notification lane can raise (S1.12b; PROJECT_MASTER_SPECIFICATION.md §31.1 and §31.2; the Product Owner's
 * decisions of 29 October 2026, plan section 11): for each business event, who is told, over what channel, which wording, how long the
 * message stays worth sending and what must still be true when it is sent. **A test holds this list to the documents**: every event the
 * specification's table names is here, wired or planned, and a message that no document asks for is not.
 *
 * **Who is texted** (decided 29 October 2026): the ad-hoc sender (a pickup confirmed or declined, the handshake code, a pickup failure
 * without private details, the intake completed with its order reference, and never a link), the registered vendor's registered number
 * for the handshake fallback only, the rider (one text when a run is dispatched and one when it is reassigned) and the recipient of a
 * parcel (the heads-up, once per parcel, on). **A registered vendor's other milestones stay in the app feed**: a feed entry is written
 * for them and read by the Vendor's screens (SLICE-015). English only.
 *
 * **Wired and planned.** A message is *wired* when the operation that raises its event exists: the lane materialises it. A *planned*
 * message is documented here so that the task that builds its operation wires it in the same change; the lane does not know its event
 * and dead-letters an envelope that names one (`UNKNOWN_EVENT`), which a task cannot do by accident because the table's list of
 * aggregates grows with the migration that adds the aggregate.
 */

/**
 * What the lane knows of the collection handshake of a request's stop when it decides whether the text that carries a code is still worth sending
 * (S1.27): the handshake as the database shows it to the lane, and never the digest, the counters or the code. The code itself is made at the send.
 */
export interface HandshakeFacts {
  readonly id: string;
  readonly stopId: string;
  readonly direction: 'VENDOR_ENTERED_RIDER_DISPLAYED' | 'SENDER_SMS_RIDER_ENTERED';
  readonly state: string;
  /** The generation of the live code: the number of codes the handshake has made. */
  readonly generation: number;
  /** The version of the key the live code's digest was made under. */
  readonly keyVersion: number;
  /** The number of digits of the live code, as it was when the code was made: the setting may say another by now, and the code is made with this one. */
  readonly codeLength: number;
  /** Whether the code has not run out, on the database's clock. */
  readonly live: boolean;
}

/** The event of a request for a code to be texted, written in the transaction of the act that made the code. */
export const HANDSHAKE_REQUESTED = 'pickup.handshake.requested';

/** What the lane knows of a pickup request when it decides who is told and whether the message is still true. */
export interface PickupRequestFacts {
  readonly id: string;
  readonly code: string;
  readonly state: string;
  readonly responsibleHubId: string;
  readonly vendorOrganizationId: string | null;
  readonly adHocSenderId: string | null;
  /** `YYYY-MM-DD`, a date in the hub's calendar. */
  readonly scheduledServiceDate: string;
  readonly attemptNumber: number;
  /** The handshake of the request's stop, for the messages that carry a code; absent where it was not read or there is none. */
  readonly handshake?: HandshakeFacts | undefined;
}

/**
 * What the lane knows of a pickup manifest when it decides who is told and whether the message is still true (S1.21): the run, the day it is
 * to be worked and the rider it is given to. The rider's number is read apart, for one send, and held in memory only.
 */
export interface PickupManifestFacts {
  readonly id: string;
  readonly code: string;
  readonly state: string;
  readonly responsibleHubId: string;
  /** `YYYY-MM-DD`, a date in the hub's calendar: the day the run is to be worked. */
  readonly serviceDate: string;
  readonly assignedRiderId: string | null;
}

export interface MessageBase {
  /** The stable name of the message: what a notification row records and the Ops log shows. */
  readonly kind: string;
  /** The event of the envelope that raises it, spelled as the audit event code. */
  readonly event: string;
  readonly audience: NotificationAudience;
  readonly channel: NotificationChannel;
  /** The version of the wording (`templates.ts`): a later edit is a new version and never rewrites what was said. */
  readonly templateVersion: number;
  /** How long after it is raised the message is still worth sending; after that it expires unsent. A feed entry's is its retention. */
  readonly timeToLiveMs: number;
  /** Where the documents ask for it. */
  readonly source: string;
  /**
   * The members of the envelope's payload the message copies into the notification as its `parameters` (S1.23): closed tokens of the
   * act, such as the reason of a skipped stop, which the Vendor's feed entry names. A member the payload lacks, or whose value is not a
   * token, is left out and the message is still raised; no other member of the payload is ever copied.
   */
  readonly carries?: readonly string[];
}

/** A message about a pickup request. */
export interface RequestMessageDefinition extends MessageBase {
  readonly aggregateType: 'PICKUP_REQUEST';
  /** Who is told: false where the aggregate has nobody of this audience (a vendor's request has no ad-hoc sender to text). */
  readonly appliesTo: (facts: PickupRequestFacts) => boolean;
  /** What must still be true when the message is sent; a message that events overtook is held back and never sent. */
  readonly stillTrue: (facts: PickupRequestFacts) => boolean;
}

/** A message about a pickup manifest: the run-level text of a rider. */
export interface ManifestMessageDefinition extends MessageBase {
  readonly aggregateType: 'PICKUP_MANIFEST';
  /** Who is told: false where the run has nobody of this audience (a run with no rider has no rider to text). */
  readonly appliesTo: (facts: PickupManifestFacts) => boolean;
  /** What must still be true when the message is sent; a message that events overtook is held back and never sent. */
  readonly stillTrue: (facts: PickupManifestFacts) => boolean;
}

export type MessageDefinition = RequestMessageDefinition | ManifestMessageDefinition;

/** The aggregate an envelope names, as the lane loaded it: the facts, and the kind of record they are of. */
export type AggregateFacts =
  | { readonly type: 'PICKUP_REQUEST'; readonly facts: PickupRequestFacts }
  | { readonly type: 'PICKUP_MANIFEST'; readonly facts: PickupManifestFacts };

/** Whether the message is for this aggregate's audience; false for facts of another kind of record. */
export function messageApplies(message: MessageDefinition, loaded: AggregateFacts): boolean {
  if (message.aggregateType === 'PICKUP_REQUEST') {
    return loaded.type === 'PICKUP_REQUEST' && message.appliesTo(loaded.facts);
  }
  return loaded.type === 'PICKUP_MANIFEST' && message.appliesTo(loaded.facts);
}

/** Whether the message is still true of this aggregate; false for facts of another kind of record. */
export function messageStillTrue(message: MessageDefinition, loaded: AggregateFacts): boolean {
  if (message.aggregateType === 'PICKUP_REQUEST') {
    return loaded.type === 'PICKUP_REQUEST' && message.stillTrue(loaded.facts);
  }
  return loaded.type === 'PICKUP_MANIFEST' && message.stillTrue(loaded.facts);
}

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

const SPEC_31_2 = 'PROJECT_MASTER_SPECIFICATION.md §31.2';

/** The messages whose events exist now. */
export const MESSAGES: readonly MessageDefinition[] = [
  {
    kind: 'PICKUP_CONFIRMED_SENDER',
    event: 'pickup.request.confirmed',
    aggregateType: 'PICKUP_REQUEST',
    audience: 'AD_HOC_SENDER',
    channel: 'SMS',
    templateVersion: 1,
    // A confirmation that arrives the next day, after an outage, is noise: the sender has already been told by Ops or has called.
    timeToLiveMs: 6 * HOUR_MS,
    appliesTo: (facts) => facts.adHocSenderId !== null,
    // Said while the request stands confirmed: cancelled or declined since, the text would say what is no longer so.
    stillTrue: (facts) => facts.state === 'CONFIRMED',
    source: `${SPEC_31_2}: "Pickup request confirmed/declined" (ad-hoc: SMS)`,
  },
  {
    kind: 'PICKUP_CONFIRMED_VENDOR_FEED',
    event: 'pickup.request.confirmed',
    aggregateType: 'PICKUP_REQUEST',
    audience: 'VENDOR_FEED',
    channel: 'FEED',
    templateVersion: 1,
    timeToLiveMs: 90 * DAY_MS,
    appliesTo: (facts) => facts.vendorOrganizationId !== null,
    stillTrue: () => true,
    source: `${SPEC_31_2}: "Pickup request confirmed/declined" (registered vendor: in-app); §31.1`,
  },
  {
    // S1.21: raised by `dispatchManifest`, in the transaction of the act. The rider is texted once for a run, and the text says nothing of any
    // stop: the stops are in the app, where the summary of each is, and a text holds no address, no name, no amount and no note.
    kind: 'RUN_DISPATCHED_RIDER',
    event: 'pickup.manifest.dispatched',
    aggregateType: 'PICKUP_MANIFEST',
    audience: 'RIDER',
    channel: 'SMS',
    templateVersion: 1,
    // A run dispatched in the morning and texted in the evening is noise: the rider has opened the list by then.
    timeToLiveMs: 6 * HOUR_MS,
    appliesTo: (facts) => facts.assignedRiderId !== null,
    // Said while the run stands dispatched: started, cancelled or completed since, the text would say what is no longer so.
    stillTrue: (facts) => facts.state === 'DISPATCHED',
    source: `${SPEC_31_2}: "Pickup run dispatched" (rider run-level notification); decided 29 October 2026 (D-11)`,
  },
  {
    // S1.27: raised by `initiateHandshake` for an individual sender's pickup, in the transaction of the act. The sender is texted the code the rider
    // will ask for; it goes nowhere else, with no link. It is worth sending while the code is the live one and has not been delivered: a code made
    // since (the fallback does not apply to a sender, but a later generation would supersede this) or one that has run out is not sent.
    kind: 'HANDSHAKE_CODE_SENDER',
    event: HANDSHAKE_REQUESTED,
    aggregateType: 'PICKUP_REQUEST',
    audience: 'AD_HOC_SENDER',
    channel: 'SMS',
    templateVersion: 1,
    timeToLiveMs: HOUR_MS / 2,
    appliesTo: (facts) => facts.adHocSenderId !== null,
    stillTrue: (facts) =>
      facts.handshake?.direction === 'SENDER_SMS_RIDER_ENTERED' &&
      facts.handshake.state === 'CODE_GENERATED' &&
      facts.handshake.live,
    source: `${SPEC_31_2}: "Collection completion/handshake" (ad-hoc SMS path); pickup-collection.md`,
  },
  {
    // S1.27: raised by `requestSmsHandshakeFallback`, in the transaction of the act, for a registered vendor's pickup. The code goes to the vendor
    // organisation's registered number only (F-23: the phone of its credential whose delivery channel is PHONE, which the database gives the lane for this request alone; the business contact number is
    // not an authentication channel and is never used), which the vendor reads out to the rider.
    kind: 'HANDSHAKE_CODE_VENDOR_NUMBER',
    event: HANDSHAKE_REQUESTED,
    aggregateType: 'PICKUP_REQUEST',
    audience: 'VENDOR_NUMBER',
    channel: 'SMS',
    templateVersion: 1,
    timeToLiveMs: HOUR_MS / 2,
    appliesTo: (facts) => facts.vendorOrganizationId !== null,
    stillTrue: (facts) =>
      facts.handshake?.direction === 'VENDOR_ENTERED_RIDER_DISPLAYED' &&
      facts.handshake.state === 'CODE_GENERATED' &&
      facts.handshake.live,
    source: `${SPEC_31_2}: "Collection completion/handshake" (registered vendor: in-app or approved flow); decided 29 October 2026`,
  },
  {
    // S1.23: raised by `skipPickupStop`, in the transaction of the act, for a registered vendor (MSC-DEC-412: "the Vendor is notified, always").
    // The feed entry names the request, the reason and what would unblock the pickup, as tokens; it holds none of Ops's note.
    kind: 'PICKUP_SKIPPED_VENDOR_FEED',
    event: 'pickup.stop.skipped',
    aggregateType: 'PICKUP_REQUEST',
    audience: 'VENDOR_FEED',
    channel: 'FEED',
    templateVersion: 1,
    timeToLiveMs: 90 * DAY_MS,
    appliesTo: (facts) => facts.vendorOrganizationId !== null,
    // A skip is a fact of the day, whatever became of the request since (rescheduled, cancelled): the vendor is told what happened.
    stillTrue: () => true,
    carries: ['reason', 'action'],
    source: `${SPEC_31_2}: "Pickup stop skipped by Ops" (registered vendor: in-app); contracts/openapi.yaml skipPickupStop; MSC-DEC-412`,
  },
  {
    // S1.28: the three messages of `reportPickupFailure`, raised by the one envelope `pickup.failure.reported`, which the database writes in the transaction of the act from the
    // stop the rider has just failed (`melarc.failure_envelope`). Each is a DRAFT (OQ-037; OB-S1-06): no real provider is asked to send the words before the Product Owner approves them.
    // This one texts an individual sender, with no reason, no note and no address: the pickup that was planned could not be completed. A failure is a fact of the day whatever became
    // of the request since (rescheduled, cancelled), so nothing overtakes it; it is worth sending for a day.
    kind: 'PICKUP_FAILED_SENDER',
    event: 'pickup.failure.reported',
    aggregateType: 'PICKUP_REQUEST',
    audience: 'AD_HOC_SENDER',
    channel: 'SMS',
    templateVersion: 1,
    timeToLiveMs: DAY_MS,
    appliesTo: (facts) => facts.adHocSenderId !== null,
    stillTrue: () => true,
    source: `${SPEC_31_2}: "Pickup failure" (ad-hoc: PII-safe SMS); decided 29 October 2026 (D-11)`,
  },
  {
    // S1.28: the registered vendor's feed entry for a failure: the category and the reason, as closed tokens that the Vendor's screens turn into words (SLICE-015), and none of the
    // rider's note.
    kind: 'PICKUP_FAILED_VENDOR_FEED',
    event: 'pickup.failure.reported',
    aggregateType: 'PICKUP_REQUEST',
    audience: 'VENDOR_FEED',
    channel: 'FEED',
    templateVersion: 1,
    timeToLiveMs: 90 * DAY_MS,
    appliesTo: (facts) => facts.vendorOrganizationId !== null,
    stillTrue: () => true,
    carries: ['category', 'reason'],
    source: `${SPEC_31_2}: "Pickup failure" (registered vendor: in-app)`,
  },
  {
    // S1.28: the "Ops event" of §31.2: every failure, whoever the sender is, is written to the Ops feed of the request's hub, where the staff of that hub read it under
    // `notification.read`. The decision queue itself is the failure read (`listPickupFailures`); this is the entry that says a failure has come in.
    kind: 'PICKUP_FAILED_OPS_FEED',
    event: 'pickup.failure.reported',
    aggregateType: 'PICKUP_REQUEST',
    audience: 'OPS_FEED',
    channel: 'FEED',
    templateVersion: 1,
    timeToLiveMs: 90 * DAY_MS,
    appliesTo: () => true,
    stillTrue: () => true,
    carries: ['category', 'reason'],
    source: `${SPEC_31_2}: "Pickup failure" (Ops event)`,
  },
  {
    // OB-S1-51: the office is told in the system of a short count, in the transaction of `recordCollection` (the envelope `pickup.collection.shortfall_flagged`, written by the
    // database from the record the rider has just made), and not only by the timestamp `office_notified_at`. The entry names the request and the reason as a closed token; the
    // counts are the record's, which the staff read in the shortfall list, and a feed entry holds no number. Whoever the sender is, the office is told.
    kind: 'COLLECTION_SHORT_OPS_FEED',
    event: 'pickup.collection.shortfall_flagged',
    aggregateType: 'PICKUP_REQUEST',
    audience: 'OPS_FEED',
    channel: 'FEED',
    templateVersion: 1,
    timeToLiveMs: 90 * DAY_MS,
    appliesTo: () => true,
    stillTrue: () => true,
    carries: ['reason'],
    source: `${SPEC_31_2}: "Pickup counted short (MSC-DEC-194)" (Ops feed); pickup-collection.md AC-SLICE-001-21; OB-S1-51`,
  },
];

/** A message the documents ask for whose event no operation raises yet: the task that builds the operation wires it. */
export interface PlannedMessage {
  readonly kind: string;
  readonly event: string;
  readonly audience: NotificationAudience;
  readonly channel: NotificationChannel;
  /** The operation or area that raises the event, and so the task that wires the message. */
  readonly raisedBy: string;
  readonly source: string;
}

export const PLANNED_MESSAGES: readonly PlannedMessage[] = [
  {
    kind: 'PICKUP_DECLINED_SENDER',
    event: 'pickup.request.declined',
    audience: 'AD_HOC_SENDER',
    channel: 'SMS',
    raisedBy:
      'a decline of a pickup request, which no operation of the contract performs yet (cancelPickupRequest cancels)',
    source: `${SPEC_31_2}: "Pickup request confirmed/declined" (ad-hoc: SMS)`,
  },
  {
    kind: 'PICKUP_DECLINED_VENDOR_FEED',
    event: 'pickup.request.declined',
    audience: 'VENDOR_FEED',
    channel: 'FEED',
    raisedBy: 'a decline of a pickup request, which no operation of the contract performs yet',
    source: `${SPEC_31_2}: "Pickup request confirmed/declined" (registered vendor: in-app)`,
  },
  {
    kind: 'PICKUP_FAILURE_ESCALATED_OPS_FEED',
    event: 'pickup.failure.escalated',
    audience: 'OPS_FEED',
    channel: 'FEED',
    raisedBy: 'the failure escalation (Stage 4): the Senior Ops internal queue',
    source: `${SPEC_31_2}: "Failure escalation" (Senior Ops internal queue/notification)`,
  },
  {
    kind: 'HUB_HANDOVER_SUBMITTED_OPS_FEED',
    event: 'handover.submitted',
    audience: 'OPS_FEED',
    channel: 'FEED',
    raisedBy: 'the hub handover (Stage 5): the Ops receive queue',
    source: `${SPEC_31_2}: "Hub handover submitted" (Ops receive queue)`,
  },
  {
    kind: 'INTAKE_COMPLETED_SENDER',
    event: 'intake.completed',
    audience: 'AD_HOC_SENDER',
    channel: 'SMS',
    raisedBy: 'the completion of an intake (Stage 5): the order reference, no link',
    source: `${SPEC_31_2}: "Intake completed" (ad-hoc tracking SMS)`,
  },
  {
    kind: 'INTAKE_COMPLETED_VENDOR_FEED',
    event: 'intake.completed',
    audience: 'VENDOR_FEED',
    channel: 'FEED',
    raisedBy: 'the completion of an intake (Stage 5): the order summary',
    source: `${SPEC_31_2}: "Intake completed" (registered vendor in-app order summary)`,
  },
  {
    kind: 'RECIPIENT_HEADS_UP',
    event: 'delivery.heads_up.due',
    audience: 'RECIPIENT',
    channel: 'SMS',
    raisedBy:
      'the delivery journey (a later slice): once per parcel, on by decision of 29 October 2026; legal basis OQ-028 is a go-live gate',
    source: `${SPEC_31_2}: "Recipient heads-up" (recipient SMS, once per parcel if enabled)`,
  },
  {
    kind: 'DELIVERY_RUN_DISPATCHED_RIDER',
    event: 'dispatch.run.dispatched',
    audience: 'RIDER',
    channel: 'SMS',
    raisedBy:
      'dispatchDeliveryRun (the dispatch slice): one text when a delivery run is dispatched',
    source: `${SPEC_31_2}: "Delivery run dispatched" (rider run-level notification)`,
  },
  {
    kind: 'RUN_REASSIGNED_RIDER',
    event: 'dispatch.run.reassigned',
    audience: 'RIDER',
    channel: 'SMS',
    raisedBy:
      'a reassignment of a run that has gone out (not built: the assignment of a pickup manifest is of a draft only, and the reassignment before the start belongs to the pre-run breakdown of SLICE-011): one text when a run is reassigned',
    source: `${SPEC_31_2}: "Pickup run dispatched" (rider run-level notification); decided 29 October 2026`,
  },
];

const PARAMETER_TOKEN = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * The parameters a message copies from the payload of its envelope (`MessageBase.carries`): the declared members whose value is a closed
 * token, under the same names, and nothing else. The notification table holds them under a check of the same shape, so a value that is
 * not a token can only be left out here and never reach the table.
 */
export function parametersOf(
  message: Pick<MessageBase, 'carries'>,
  payload: Readonly<Record<string, unknown>>,
): Record<string, string> {
  const parameters: Record<string, string> = {};
  for (const key of message.carries ?? []) {
    const value = payload[key];
    if (typeof value === 'string' && PARAMETER_TOKEN.test(value)) parameters[key] = value;
  }
  return parameters;
}

/** The messages one event raises, in the order of the list. None for an event the list does not know. */
export function messagesFor(event: string): readonly MessageDefinition[] {
  return MESSAGES.filter((message) => message.event === event);
}

/** The definition of a kind, wired or not. */
export function messageOfKind(kind: string): MessageDefinition | undefined {
  return MESSAGES.find((message) => message.kind === kind);
}
