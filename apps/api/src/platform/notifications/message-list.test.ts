import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MESSAGES,
  PLANNED_MESSAGES,
  messageApplies,
  messageOfKind,
  messageStillTrue,
  messagesFor,
  parametersOf,
  type MessageDefinition,
  type PickupManifestFacts,
  type PickupRequestFacts,
} from './message-list.js';
import { NOTIFICATION_AUDIENCES, OUTBOX_AGGREGATE_TYPES } from './notification-vocabulary.js';
import {
  TEMPLATES,
  TemplateError,
  isApproved,
  render,
  spokenDate,
  templateOf,
  wordingDigest,
  type Template,
} from './templates.js';

const SPECIFICATION = resolve(
  import.meta.dirname,
  '../../../../../PROJECT_MASTER_SPECIFICATION.md',
);

/** The rows of §31.2 "Source-identified notification events", read from the document that owns them. */
function specificationRows(): string[] {
  const text = readFileSync(SPECIFICATION, 'utf8');
  const start = text.indexOf('## 31.2 ');
  const end = text.indexOf('## 31.3 ', start);
  if (start === -1 || end === -1)
    throw new Error('PROJECT_MASTER_SPECIFICATION.md §31.2 was not found');
  return text
    .slice(start, end)
    .split('\n')
    .filter(
      (line) => line.startsWith('| ') && !line.startsWith('| Event') && !line.startsWith('|---'),
    )
    .map((line) => (line.split('|')[1] ?? '').trim());
}

/**
 * What each row of §31.2 comes to in this build: the kinds that answer it, or why none does. A row of the document with no entry here
 * fails the test, and so does an entry for a row the document no longer has.
 */
const COVERAGE: Readonly<Record<string, readonly string[] | 'a later slice'>> = {
  'Pickup request confirmed/declined': [
    'PICKUP_CONFIRMED_SENDER',
    'PICKUP_CONFIRMED_VENDOR_FEED',
    'PICKUP_DECLINED_SENDER',
    'PICKUP_DECLINED_VENDOR_FEED',
  ],
  'Pickup run dispatched': ['RUN_DISPATCHED_RIDER', 'RUN_REASSIGNED_RIDER'],
  'Collection completion/handshake': ['HANDSHAKE_CODE_SENDER', 'HANDSHAKE_CODE_VENDOR_NUMBER'],
  'Pickup failure': ['PICKUP_FAILED_SENDER', 'PICKUP_FAILED_VENDOR_FEED', 'PICKUP_FAILED_OPS_FEED'],
  // Added to §31.2 on 12 November 2026 (OB-S1-51) for an event the acceptance criterion already signed: AC-SLICE-001-21, "an office notification is raised at that moment".
  'Pickup counted short (MSC-DEC-194)': ['COLLECTION_SHORT_OPS_FEED'],
  // Added to §31.2 on 2 November 2026 (S1.23) for an event the contract already signed: MSC-DEC-412, "the Vendor is notified, always".
  'Pickup stop skipped by Ops (MSC-DEC-412)': ['PICKUP_SKIPPED_VENDOR_FEED'],
  'Failure escalation': ['PICKUP_FAILURE_ESCALATED_OPS_FEED'],
  'Hub handover submitted': ['HUB_HANDOVER_SUBMITTED_OPS_FEED'],
  'Intake completed': ['INTAKE_COMPLETED_SENDER', 'INTAKE_COMPLETED_VENDOR_FEED'],
  'Recipient heads-up': ['RECIPIENT_HEADS_UP'],
  'Delivery run dispatched': ['DELIVERY_RUN_DISPATCHED_RIDER'],
  // The delivery journey is not SLICE-001's: its messages are designed with the slices that build the journey.
  'Courier handoff': 'a later slice',
  'Pickup confirmation; received/itemized; out for delivery; delivered; failed attempt; return started/completed':
    ['PICKUP_CONFIRMED_SENDER'],
};

const facts = (over: Partial<PickupRequestFacts> = {}): PickupRequestFacts => ({
  id: '5d1c8c1e-0000-4000-8000-000000000001',
  code: 'ACC-PR-ABC123',
  state: 'CONFIRMED',
  responsibleHubId: '5eed0100-0000-4000-8000-000000000001',
  vendorOrganizationId: null,
  adHocSenderId: '5d1c8c1e-0000-4000-8000-0000000000aa',
  scheduledServiceDate: '2026-11-03',
  attemptNumber: 1,
  ...over,
});

const manifestFacts = (over: Partial<PickupManifestFacts> = {}): PickupManifestFacts => ({
  id: '5d1c8c1e-0000-4000-8000-000000000002',
  code: 'ACC-MF-ABC123',
  state: 'DISPATCHED',
  responsibleHubId: '5eed0100-0000-4000-8000-000000000001',
  serviceDate: '2026-11-03',
  assignedRiderId: '5d1c8c1e-0000-4000-8000-0000000000bb',
  ...over,
});

/** Whether a message is for a request's audience, asked as the lane asks it (by the kind of record the facts are of). */
const appliesToRequest = (
  message: MessageDefinition | undefined,
  over: Partial<PickupRequestFacts>,
) =>
  message !== undefined && messageApplies(message, { type: 'PICKUP_REQUEST', facts: facts(over) });
const stillTrueOfRequest = (
  message: MessageDefinition | undefined,
  over: Partial<PickupRequestFacts>,
) =>
  message !== undefined &&
  messageStillTrue(message, { type: 'PICKUP_REQUEST', facts: facts(over) });
const appliesToRun = (message: MessageDefinition | undefined, over: Partial<PickupManifestFacts>) =>
  message !== undefined &&
  messageApplies(message, { type: 'PICKUP_MANIFEST', facts: manifestFacts(over) });
const stillTrueOfRun = (
  message: MessageDefinition | undefined,
  over: Partial<PickupManifestFacts>,
) =>
  message !== undefined &&
  messageStillTrue(message, { type: 'PICKUP_MANIFEST', facts: manifestFacts(over) });

describe('the list of messages, against the specification (§31.1 and §31.2)', () => {
  // Break caught: a row of the specification's table that nobody answered, or an answer to a row that is gone.
  it('answers every row of §31.2 and no row the document does not have', () => {
    const rows = specificationRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.toSorted()).toEqual(Object.keys(COVERAGE).toSorted());
  });

  // Break caught: a kind named in the coverage that the list does not hold, which the specification's row would then lack.
  it('holds every kind the coverage names, wired or planned', () => {
    const known = new Set([...MESSAGES, ...PLANNED_MESSAGES].map((message) => message.kind));
    for (const [row, answer] of Object.entries(COVERAGE)) {
      if (answer === 'a later slice') continue;
      for (const kind of answer) expect(known.has(kind), `${row}: ${kind}`).toBe(true);
    }
  });

  // Break caught: a message that no row of the specification asks for, which the owner never decided to send.
  it('holds no message that the coverage does not name', () => {
    const named = new Set(
      Object.values(COVERAGE).flatMap((answer) => (answer === 'a later slice' ? [] : answer)),
    );
    for (const message of [...MESSAGES, ...PLANNED_MESSAGES]) {
      expect(named.has(message.kind), message.kind).toBe(true);
    }
  });

  it('cites the specification for every message', () => {
    for (const message of [...MESSAGES, ...PLANNED_MESSAGES]) {
      expect(message.source, message.kind).toMatch(/PROJECT_MASTER_SPECIFICATION\.md §31/);
    }
  });

  // Break caught: two messages with one name, which the notification table's key could not tell apart.
  it('names each message once, in capitals, and a planned one is not a wired one', () => {
    const kinds = [...MESSAGES, ...PLANNED_MESSAGES].map((message) => message.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const kind of kinds) expect(kind).toMatch(/^[A-Z][A-Z0-9_]{2,63}$/);
  });

  // Break caught: an audience the table would refuse, found only when the first message of it is written.
  it('uses audiences and aggregates the table allows', () => {
    for (const message of [...MESSAGES, ...PLANNED_MESSAGES]) {
      expect(NOTIFICATION_AUDIENCES, message.kind).toContain(message.audience);
    }
    for (const message of MESSAGES) expect(OUTBOX_AGGREGATE_TYPES).toContain(message.aggregateType);
  });

  // Break caught: a feed audience over the text channel, or a person over the feed, which no screen or provider could serve.
  it('sends a person a text and puts the rest in a feed', () => {
    for (const message of [...MESSAGES, ...PLANNED_MESSAGES]) {
      const feed = message.audience === 'VENDOR_FEED' || message.audience === 'OPS_FEED';
      expect(message.channel, message.kind).toBe(feed ? 'FEED' : 'SMS');
    }
  });
});

describe('what the wired messages decide', () => {
  it('finds the messages of an event, in order, and none for an event it does not know', () => {
    expect(messagesFor('pickup.request.confirmed').map((message) => message.kind)).toEqual([
      'PICKUP_CONFIRMED_SENDER',
      'PICKUP_CONFIRMED_VENDOR_FEED',
    ]);
    expect(messagesFor('pickup.request.declined')).toEqual([]);
    expect(messagesFor('something.else')).toEqual([]);
    expect(messageOfKind('PICKUP_CONFIRMED_SENDER')?.audience).toBe('AD_HOC_SENDER');
    expect(messageOfKind('NOT_A_KIND')).toBeUndefined();
  });

  // Break caught: a text sent to a vendor's request, which has no ad-hoc sender, or a feed entry written for a walk-in.
  it('texts the ad-hoc sender of a request and writes the feed of a registered vendor, and neither for the other', () => {
    const sender = messageOfKind('PICKUP_CONFIRMED_SENDER');
    const feed = messageOfKind('PICKUP_CONFIRMED_VENDOR_FEED');
    expect(appliesToRequest(sender, {})).toBe(true);
    expect(appliesToRequest(sender, { adHocSenderId: null, vendorOrganizationId: 'v' })).toBe(
      false,
    );
    expect(appliesToRequest(feed, {})).toBe(false);
    expect(appliesToRequest(feed, { adHocSenderId: null, vendorOrganizationId: 'v' })).toBe(true);
  });

  // Break caught: a confirmation texted after the request was cancelled or declined, which says what is no longer so.
  it('says "confirmed" only while the request stands confirmed', () => {
    const sender = messageOfKind('PICKUP_CONFIRMED_SENDER');
    expect(stillTrueOfRequest(sender, { state: 'CONFIRMED' })).toBe(true);
    for (const state of ['PENDING', 'CANCELLED', 'DECLINED']) {
      expect(stillTrueOfRequest(sender, { state }), state).toBe(false);
    }
  });

  // Break caught (S1.21): the rider's text raised from the wrong event or the wrong record, sent to a run nobody was given, or sent to a
  // person for facts of another kind of record (a message about a run asked of a request's facts would be true of everything).
  it('texts the rider of a dispatched run, once, and nobody for a run that has none', () => {
    const run = messageOfKind('RUN_DISPATCHED_RIDER');
    expect(messagesFor('pickup.manifest.dispatched').map((message) => message.kind)).toEqual([
      'RUN_DISPATCHED_RIDER',
    ]);
    expect(run).toMatchObject({
      event: 'pickup.manifest.dispatched',
      aggregateType: 'PICKUP_MANIFEST',
      audience: 'RIDER',
      channel: 'SMS',
    });
    expect(appliesToRun(run, {})).toBe(true);
    expect(appliesToRun(run, { assignedRiderId: null })).toBe(false);
    // Facts of a request are not a run's: the same message asked of them is never true.
    expect(
      run !== undefined && messageApplies(run, { type: 'PICKUP_REQUEST', facts: facts() }),
    ).toBe(false);
    expect(
      run !== undefined && messageStillTrue(run, { type: 'PICKUP_REQUEST', facts: facts() }),
    ).toBe(false);
  });

  // Break caught: a text that says "your run is ready" after the run was started, cancelled or completed.
  it('says a run is ready only while it stands dispatched', () => {
    const run = messageOfKind('RUN_DISPATCHED_RIDER');
    expect(stillTrueOfRun(run, { state: 'DISPATCHED' })).toBe(true);
    for (const state of ['DRAFT', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']) {
      expect(stillTrueOfRun(run, { state }), state).toBe(false);
    }
  });

  it('lets a text go stale in hours and a feed entry stay for months', () => {
    for (const message of MESSAGES) {
      expect(message.timeToLiveMs, message.kind).toBeGreaterThan(0);
      if (message.channel === 'SMS')
        expect(message.timeToLiveMs, message.kind).toBeLessThanOrEqual(24 * 60 * 60_000);
    }
  });
});

describe('the wording', () => {
  it('has the words of every wired message, at the version the list names, and no words for a message the list lacks', () => {
    for (const message of MESSAGES) {
      expect(templateOf(message.kind, message.templateVersion), message.kind).toBeDefined();
    }
    for (const template of TEMPLATES) {
      const message = messageOfKind(template.kind);
      expect(message, template.kind).toBeDefined();
      expect(template.version).toBeLessThanOrEqual(message?.templateVersion ?? 0);
    }
  });

  // Break caught: a title on a text or none on a feed entry.
  it('titles a feed entry and no text message', () => {
    for (const template of TEMPLATES) {
      const channel = messageOfKind(template.kind)?.channel;
      expect(template.title !== null, template.kind).toBe(channel === 'FEED');
    }
  });

  // Break caught: an approval half recorded, which the real-provider gate would read as either answer.
  it('records an approval as who, when and which words, or as none of them', () => {
    for (const template of TEMPLATES) {
      expect(template.approvedBy === null, template.kind).toBe(template.approvedOn === null);
      expect(template.approvedBy === null, template.kind).toBe(template.approvedDigest === null);
      expect(isApproved(template), template.kind).toBe(template.approvedBy !== null);
    }
  });

  // Break caught: a wording approved in code without the owner's word, or approved words that were edited. The Product Owner approved the first
  // two, exactly as they stand, on 30 October 2026 (OQ-037), and the rider's run text on 2 November 2026 (OB-S1-06); another approval is a
  // decision of theirs, and is recorded with its date in the same change as this list. Each approval is pinned to the words and to the digest
  // of the words, so that an edit that kept the approval would fail here as well as in `isApproved`.
  it('holds approved exactly the wording the Product Owner approved, on the days they approved it', () => {
    const APPROVED: Record<string, { on: string; digest: string; wording: string }> = {
      'PICKUP_CONFIRMED_SENDER@1': {
        on: '2026-10-30',
        digest: '649f6799e75097c57350915c178b2f5fa4ec61d17412670ed8bc41aac7e8bd0e',
        wording:
          'Melarc: your pickup {code} is confirmed for {date}. Please have your parcels ready.',
      },
      'PICKUP_CONFIRMED_VENDOR_FEED@1': {
        on: '2026-10-30',
        digest: 'b39cd4dd78d83e7509819ad9d8c431d25bc281312b933e5a6ae23458b822b499',
        wording: 'Your pickup request {code} is confirmed for {date}.',
      },
      'RUN_DISPATCHED_RIDER@1': {
        on: '2026-11-02',
        digest: '1846cc8b7b2e3354dbb3088d54023af692e977dd4dbae1fd2f3df92a81346b89',
        wording:
          'Melarc: your pickup run {code} for {date} is ready. Open the Melarc app to see your stops.',
      },
    };
    const approved = TEMPLATES.filter(isApproved);
    expect(
      approved.map((template) => `${template.kind}@${String(template.version)}`).toSorted(),
    ).toEqual(Object.keys(APPROVED).toSorted());
    for (const template of approved) {
      const held = APPROVED[`${template.kind}@${String(template.version)}`];
      expect(template.approvedBy, template.kind).toBe('Mathias Elorm, Product Owner');
      expect(template.approvedOn, template.kind).toBe(held?.on);
      expect(template.approvedDigest, template.kind).toBe(held?.digest);
      expect(template.wording, template.kind).toBe(held?.wording);
    }
  });

  // Break caught (OB-S1-06): the rider's run text approved with other words, a changed placeholder, or a digest that is not of these words. The
  // words are the Product Owner's of 2 November 2026, and the approval is wording only: it sends nothing, and the real provider still needs the
  // controlled window, its allow-list and its credentials (lane-policy.ts).
  it('approves the rider’s run text for exactly the words the Product Owner gave', () => {
    const template = templateOf('RUN_DISPATCHED_RIDER', 1);
    expect(template).toBeDefined();
    if (template === undefined) return;
    expect(isApproved(template)).toBe(true);
    expect(wordingDigest(template)).toBe(template.approvedDigest);
    expect(template.placeholders).toEqual(['code', 'date']);
    expect(template.title).toBeNull();
    expect(render(template, { code: 'ACC-MF-Q92422', date: 'Wednesday 4 November' })).toBe(
      'Melarc: your pickup run ACC-MF-Q92422 for Wednesday 4 November is ready. Open the Melarc app to see your stops.',
    );
    // One word of the approved text changed is a draft again, whatever the version says.
    expect(isApproved({ ...template, wording: template.wording.replace('ready', 'waiting') })).toBe(
      false,
    );
  });

  // Break caught: a text that is not plain, carries a link, or runs past one message: each costs the owner money or trust.
  it('writes every text in plain ASCII, with no link and within one message, whatever the values', () => {
    const longest: Record<string, string> = {
      code: 'ACC-PR-ABC123',
      date: 'Wednesday 30 September',
    };
    for (const template of TEMPLATES) {
      expect(template.wording, template.kind).toMatch(/^[\x20-\x7e]+$/);
      expect(template.wording.toLowerCase(), template.kind).not.toMatch(
        /https?:|www\.|\.com|\.org|\.net/,
      );
      if (messageOfKind(template.kind)?.channel === 'SMS') {
        const values = Object.fromEntries(
          template.placeholders.map((name) => [name, longest[name] ?? 'x'.repeat(20)]),
        );
        expect(render(template, values).length, template.kind).toBeLessThanOrEqual(160);
      }
    }
  });

  it('puts the values in', () => {
    const template = templateOf('PICKUP_CONFIRMED_SENDER', 1);
    expect(template).toBeDefined();
    if (template === undefined) return;
    expect(render(template, { code: 'ACC-PR-ABC123', date: 'Tuesday 3 November' })).toBe(
      'Melarc: your pickup ACC-PR-ABC123 is confirmed for Tuesday 3 November. Please have your parcels ready.',
    );
  });

  // Break caught: a value that turns the text into something it was never approved to say.
  it.each([
    ['a link', 'see https://x.test/a'],
    ['a host', 'www.example'],
    ['a second line', 'a\nb'],
    ['a curly quote', 'it’s'],
    ['a value that is too long', 'x'.repeat(65)],
    ['nothing', ''],
  ])('refuses a value that is %s', (_what, value) => {
    const template = templateOf('PICKUP_CONFIRMED_SENDER', 1);
    if (template === undefined) throw new Error('no template');
    expect(() => render(template, { code: value, date: 'Tuesday 3 November' })).toThrow(
      TemplateError,
    );
  });

  it('refuses a value that is missing and a value nothing asked for', () => {
    const template = templateOf('PICKUP_CONFIRMED_SENDER', 1);
    if (template === undefined) throw new Error('no template');
    expect(() => render(template, { code: 'ACC-PR-ABC123' })).toThrow(TemplateError);
    expect(() => render(template, { code: 'a', date: 'b', extra: 'c' })).toThrow(TemplateError);
  });

  it('refuses a wording that uses a placeholder it does not name', () => {
    expect(() =>
      render(
        {
          kind: 'X',
          version: 1,
          title: null,
          wording: 'Hello {name}',
          placeholders: [],
          approvedBy: null,
          approvedOn: null,
          approvedDigest: null,
        },
        {},
      ),
    ).toThrow(/does not name/);
  });

  // Break caught: a half-recorded approval read as an approval, which lets a real provider send words nobody approved.
  it('counts as approved only when the approver, the day and the digest of these very words are recorded', () => {
    const base = TEMPLATES[0];
    if (base === undefined) throw new Error('no template');
    const digest = wordingDigest(base);
    const by = 'Product Owner';
    const on = '2026-10-30';
    expect(isApproved({ ...base, approvedBy: by, approvedOn: null, approvedDigest: digest })).toBe(
      false,
    );
    expect(isApproved({ ...base, approvedBy: null, approvedOn: on, approvedDigest: digest })).toBe(
      false,
    );
    expect(isApproved({ ...base, approvedBy: by, approvedOn: on, approvedDigest: null })).toBe(
      false,
    );
    expect(isApproved({ ...base, approvedBy: null, approvedOn: null, approvedDigest: null })).toBe(
      false,
    );
    expect(isApproved({ ...base, approvedBy: by, approvedOn: on, approvedDigest: digest })).toBe(
      true,
    );
  });

  // Break caught: an approval that survives an edit of the words, so that words the owner never saw go out under the owner's name.
  it('stops counting as approved when the words, the version, the title or the placeholders are edited', () => {
    const base = TEMPLATES[0];
    if (base === undefined) throw new Error('no template');
    const approved: Template = {
      ...base,
      approvedBy: 'Product Owner',
      approvedOn: '2026-10-30',
      approvedDigest: wordingDigest(base),
    };
    expect(isApproved(approved)).toBe(true);
    expect(isApproved({ ...approved, wording: `${base.wording} Thanks.` })).toBe(false);
    expect(isApproved({ ...approved, version: base.version + 1 })).toBe(false);
    expect(isApproved({ ...approved, title: 'A title' })).toBe(false);
    expect(isApproved({ ...approved, placeholders: [...base.placeholders, 'extra'] })).toBe(false);
    expect(isApproved({ ...approved, kind: 'PICKUP_CONFIRMED_OTHER' })).toBe(false);
    // The digest is of the words only: who approved them, and when, are not part of what is approved.
    const reapproved: Template = {
      ...approved,
      approvedBy: 'Someone else',
      approvedOn: '2026-11-01',
    };
    expect(wordingDigest(reapproved)).toBe(wordingDigest(base));
    expect(wordingDigest(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writes a service date as a day, a number and a month', () => {
    expect(spokenDate('2026-11-03')).toBe('Tuesday 3 November');
    expect(spokenDate('2026-12-31')).toBe('Thursday 31 December');
    expect(spokenDate('2027-01-01')).toBe('Friday 1 January');
  });

  it.each(['2026-02-30', '2026-13-01', '03/11/2026', '', '2026-11-3'])(
    'refuses %s as a service date',
    (value) => {
      expect(() => spokenDate(value)).toThrow(TemplateError);
    },
  );
});

describe('the notice of a skipped stop (S1.23; MSC-DEC-412)', () => {
  const notice = messageOfKind('PICKUP_SKIPPED_VENDOR_FEED');

  it('is a feed entry for a registered vendor, raised by the skip and never texted', () => {
    expect(notice).toMatchObject({
      event: 'pickup.stop.skipped',
      aggregateType: 'PICKUP_REQUEST',
      audience: 'VENDOR_FEED',
      channel: 'FEED',
      carries: ['reason', 'action'],
    });
    expect(messagesFor('pickup.stop.skipped').map((each) => each.kind)).toEqual([
      'PICKUP_SKIPPED_VENDOR_FEED',
    ]);
  });

  // Break caught: a notice for a pickup that has no vendor, or one that is withheld because the request moved on (a skip is a fact of the day,
  // whatever Ops did with the request afterwards).
  it('applies to a request with a vendor and stays true whatever became of the request', () => {
    expect(appliesToRequest(notice, { vendorOrganizationId: null })).toBe(false);
    expect(appliesToRequest(notice, { vendorOrganizationId: 'v-1', adHocSenderId: null })).toBe(
      true,
    );
    for (const state of ['CONFIRMED', 'CANCELLED', 'DECLINED']) {
      expect(stillTrueOfRequest(notice, { state }), state).toBe(true);
    }
  });

  // Break caught: a payload member copied that the message did not declare, a value that is not a token (free text, a number, an address) reaching
  // the table's check, or a declared member the payload lacks making the message fail.
  it('copies only the declared members of the payload, and only when each is a token', () => {
    const copy = (payload: Record<string, unknown>) =>
      parametersOf(notice ?? { carries: [] }, payload);
    expect(copy({ reason: 'LOCATION_INACCESSIBLE', action: 'CORRECT_PICKUP_LOCATION' })).toEqual({
      reason: 'LOCATION_INACCESSIBLE',
      action: 'CORRECT_PICKUP_LOCATION',
    });
    expect(copy({ reason: 'RUN_CUT_SHORT', note: 'The gate was welded shut', extra: 'X' })).toEqual(
      {
        reason: 'RUN_CUT_SHORT',
      },
    );
    expect(copy({ reason: 'run cut short', action: 7 })).toEqual({});
    expect(copy({ reason: 'A'.repeat(65) })).toEqual({});
    expect(copy({ reason: '+233201234567', action: 'NONE NONE' })).toEqual({});
    expect(copy({})).toEqual({});
    // A message that declares nothing copies nothing.
    expect(parametersOf({}, { reason: 'RUN_CUT_SHORT' })).toEqual({});
  });

  // Break caught: wording that carries Ops's note or a private detail, or a template that is approved without the owner (the capture adapter
  // would send any, and the owner has not approved these words).
  it('has draft wording that names the request, the day, the reason and the action, and none of Ops’s note', () => {
    const template = templateOf('PICKUP_SKIPPED_VENDOR_FEED', 1);
    expect(template?.placeholders).toEqual(['code', 'date', 'reason', 'action']);
    expect(template === undefined ? undefined : isApproved(template)).toBe(false);
    expect(template?.wording).not.toMatch(/note|address|phone/i);
    expect(
      template === undefined
        ? ''
        : render(template, {
            code: 'ACC-PR-ABC123',
            date: 'Tuesday 3 November',
            reason: 'LOCATION_INACCESSIBLE',
            action: 'CORRECT_PICKUP_LOCATION',
          }),
    ).toBe(
      'Your pickup request ACC-PR-ABC123 for Tuesday 3 November was not collected on this run (LOCATION_INACCESSIBLE). What we need from you: CORRECT_PICKUP_LOCATION.',
    );
  });
});

describe('the messages of a failure (S1.28) and the office entry for a short count (OB-S1-51)', () => {
  const sender = messageOfKind('PICKUP_FAILED_SENDER');
  const vendorFeed = messageOfKind('PICKUP_FAILED_VENDOR_FEED');
  const opsFeed = messageOfKind('PICKUP_FAILED_OPS_FEED');
  const shortFeed = messageOfKind('COLLECTION_SHORT_OPS_FEED');
  const vendorRequest = { vendorOrganizationId: 'v-1', adHocSenderId: null };

  // Break caught: a message raised from the wrong event (the lane dead-letters an envelope no message answers), or a short count that raises the failure's messages.
  it('are raised by the two events the database writes, in the order of the list', () => {
    expect(messagesFor('pickup.failure.reported').map((each) => each.kind)).toEqual([
      'PICKUP_FAILED_SENDER',
      'PICKUP_FAILED_VENDOR_FEED',
      'PICKUP_FAILED_OPS_FEED',
    ]);
    expect(messagesFor('pickup.collection.shortfall_flagged').map((each) => each.kind)).toEqual([
      'COLLECTION_SHORT_OPS_FEED',
    ]);
    for (const message of [sender, vendorFeed, opsFeed, shortFeed]) {
      expect(message?.aggregateType, message?.kind).toBe('PICKUP_REQUEST');
    }
  });

  // Break caught: a text to a registered vendor's request (it has no sender to text), a feed entry written for a walk-in, or an Ops entry that a kind of sender can switch off.
  it('text an individual sender only, write the vendor’s entry for a registered vendor only, and tell the office of every failure and short count', () => {
    expect(sender).toMatchObject({ audience: 'AD_HOC_SENDER', channel: 'SMS' });
    expect(appliesToRequest(sender, {})).toBe(true);
    expect(appliesToRequest(sender, vendorRequest)).toBe(false);

    expect(vendorFeed).toMatchObject({ audience: 'VENDOR_FEED', channel: 'FEED' });
    expect(appliesToRequest(vendorFeed, {})).toBe(false);
    expect(appliesToRequest(vendorFeed, vendorRequest)).toBe(true);

    for (const entry of [opsFeed, shortFeed]) {
      expect(entry, entry?.kind).toMatchObject({ audience: 'OPS_FEED', channel: 'FEED' });
      expect(appliesToRequest(entry, {}), entry?.kind).toBe(true);
      expect(appliesToRequest(entry, vendorRequest), entry?.kind).toBe(true);
    }
  });

  // Break caught: a failure withheld because the office decided first (cancelled, rescheduled), which would leave the sender and the vendor not told of what happened.
  it('stay true whatever became of the request: a failure and a count are facts of the day', () => {
    for (const message of [sender, vendorFeed, opsFeed, shortFeed]) {
      for (const state of ['CONFIRMED', 'CANCELLED', 'DECLINED', 'PENDING']) {
        expect(stillTrueOfRequest(message, { state }), `${message?.kind ?? ''} ${state}`).toBe(
          true,
        );
      }
    }
  });

  // Break caught: a payload member copied that the message did not declare (the stop, the rider's note), a value that is not a token reaching the table's check, or a text that
  // carries the reason (the text to a sender says nothing of why).
  it('copy the category and the reason as tokens and nothing else; the text to the sender copies nothing', () => {
    const payload = {
      stop: '8f1c8c1e-0000-4000-8000-000000000003',
      category: 'VENDOR_UNAVAILABLE',
      reason: 'VENDOR_NOT_AT_LOCATION',
      note: 'The gate was welded shut',
    };
    for (const message of [vendorFeed, opsFeed]) {
      expect(message?.carries, message?.kind).toEqual(['category', 'reason']);
      expect(parametersOf(message ?? {}, payload), message?.kind).toEqual({
        category: 'VENDOR_UNAVAILABLE',
        reason: 'VENDOR_NOT_AT_LOCATION',
      });
    }
    expect(shortFeed?.carries).toEqual(['reason']);
    expect(parametersOf(shortFeed ?? {}, { ...payload, reason: 'SOME_PARCELS_NOT_READY' })).toEqual(
      { reason: 'SOME_PARCELS_NOT_READY' },
    );
    expect(sender?.carries).toBeUndefined();
    expect(parametersOf(sender ?? {}, payload)).toEqual({});
    // A reason that is not a token (free text, a number) is left out and the message is still raised.
    expect(parametersOf(opsFeed ?? {}, { category: 'ACCESS_DENIED', reason: 'the gate' })).toEqual({
      category: 'ACCESS_DENIED',
    });
  });

  // Break caught: wording approved without the owner (the capture adapter would send any, and the owner has not approved these words), a text that says why, or a word of the
  // rider's note, a count, a number or an address in any of the four.
  it('are drafts, and none of the words carries a note, a count, a number or an address', () => {
    for (const message of [sender, vendorFeed, opsFeed, shortFeed]) {
      const template = templateOf(message?.kind ?? '', 1);
      expect(template, message?.kind).toBeDefined();
      expect(template === undefined ? true : isApproved(template), message?.kind).toBe(false);
      expect(template?.placeholders, message?.kind).not.toContain('note');
      expect(template?.wording, message?.kind).not.toMatch(/note|address|phone|number|http/i);
    }
    expect(templateOf('PICKUP_FAILED_SENDER', 1)?.placeholders).toEqual(['code', 'date']);
    expect(templateOf('PICKUP_FAILED_VENDOR_FEED', 1)?.placeholders).toEqual([
      'code',
      'date',
      'category',
      'reason',
    ]);
    expect(templateOf('PICKUP_FAILED_OPS_FEED', 1)?.placeholders).toEqual([
      'code',
      'date',
      'category',
      'reason',
    ]);
    expect(templateOf('COLLECTION_SHORT_OPS_FEED', 1)?.placeholders).toEqual([
      'code',
      'date',
      'reason',
    ]);
  });

  it('say, in draft words, what happened to the request and the day it was for', () => {
    const text = templateOf('PICKUP_FAILED_SENDER', 1);
    expect(
      text === undefined ? '' : render(text, { code: 'ACC-PR-ABC123', date: 'Tuesday 3 November' }),
    ).toBe(
      'Melarc: we could not complete your pickup ACC-PR-ABC123 planned for Tuesday 3 November. We will be in touch about the next step.',
    );
    const entry = templateOf('COLLECTION_SHORT_OPS_FEED', 1);
    expect(
      entry === undefined
        ? ''
        : render(entry, {
            code: 'ACC-PR-ABC123',
            date: 'Tuesday 3 November',
            reason: 'SOME_PARCELS_NOT_READY',
          }),
    ).toBe(
      'Pickup request ACC-PR-ABC123 for Tuesday 3 November was counted short at the door (SOME_PARCELS_NOT_READY). The office is asked to follow it up.',
    );
  });
});
