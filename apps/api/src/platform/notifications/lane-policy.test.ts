import { describe, expect, it } from 'vitest';

import { OPEN_SETTINGS, createLanePolicy, type NotificationSettings } from './lane-policy.js';
import { templateOf, wordingDigest, type Template } from './templates.js';

const found = templateOf('PICKUP_CONFIRMED_SENDER', 1);
if (found === undefined) throw new Error('the wording of the confirmation is missing');
// The words the owner approved on 30 October 2026, with the approval taken off: what any wording is until the owner approves it.
const draft: Template = { ...found, approvedBy: null, approvedOn: null, approvedDigest: null };
const approved: Template = {
  ...draft,
  approvedBy: 'Product Owner',
  approvedOn: '2026-10-30',
  approvedDigest: wordingDigest(draft),
};

const settings = (over: Partial<NotificationSettings> = {}): NotificationSettings => ({
  ...OPEN_SETTINGS,
  ...over,
});

describe('what holds a message back before it is read or sent', () => {
  // Break caught: a kill switch that is not read, so the owner cannot stop the texts in a bad hour.
  it('holds every text back while the global switch is off', async () => {
    const policy = createLanePolicy({
      realProvider: false,
      settings: settings({ smsEnabled: () => Promise.resolve(false) }),
    });
    expect(await policy.withhold({ kind: 'PICKUP_CONFIRMED_SENDER', template: draft })).toBe(
      'KILL_SWITCH',
    );
  });

  // Break caught: the switch of one kind stopping the others, or not stopping its own.
  it('holds back the kinds whose own switch is off and no others', async () => {
    const policy = createLanePolicy({
      realProvider: false,
      settings: settings({
        disabledKinds: () => Promise.resolve(new Set(['PICKUP_CONFIRMED_SENDER'])),
      }),
    });
    expect(await policy.withhold({ kind: 'PICKUP_CONFIRMED_SENDER', template: draft })).toBe(
      'KILL_SWITCH',
    );
    expect(await policy.withhold({ kind: 'PICKUP_DECLINED_SENDER', template: draft })).toBeNull();
  });

  // Break caught (OQ-037, OB-S1-06): a real provider sending words the owner never approved.
  it('lets a real provider send approved words only, and a sender that reaches nobody send any', async () => {
    const real = createLanePolicy({ realProvider: true, settings: OPEN_SETTINGS });
    expect(await real.withhold({ kind: 'PICKUP_CONFIRMED_SENDER', template: draft })).toBe(
      'WORDING_NOT_APPROVED',
    );
    expect(await real.withhold({ kind: 'PICKUP_CONFIRMED_SENDER', template: approved })).toBeNull();
    const capture = createLanePolicy({ realProvider: false, settings: OPEN_SETTINGS });
    expect(await capture.withhold({ kind: 'PICKUP_CONFIRMED_SENDER', template: draft })).toBeNull();
  });

  // Break caught (OB-S1-06): the Product Owner's approval of the rider's run text (2 November 2026) opening more than the wording gate. It is the
  // approval of words only: the same words, edited, are held back again, and a switch that is off still holds the kind back, so nothing here
  // reaches a provider that the owner's switches and the controlled window have not opened.
  it('passes the wording gate for the rider’s approved run text and for nothing else about it', async () => {
    const run = templateOf('RUN_DISPATCHED_RIDER', 1);
    if (run === undefined) throw new Error('the wording of the rider’s run text is missing');
    const real = createLanePolicy({ realProvider: true, settings: OPEN_SETTINGS });
    expect(await real.withhold({ kind: 'RUN_DISPATCHED_RIDER', template: run })).toBeNull();
    expect(
      await real.withhold({
        kind: 'RUN_DISPATCHED_RIDER',
        template: { ...run, wording: `${run.wording} Thanks.` },
      }),
    ).toBe('WORDING_NOT_APPROVED');
    const switchedOff = createLanePolicy({
      realProvider: true,
      settings: settings({ smsEnabled: () => Promise.resolve(false) }),
    });
    expect(await switchedOff.withhold({ kind: 'RUN_DISPATCHED_RIDER', template: run })).toBe(
      'KILL_SWITCH',
    );
    const kindOff = createLanePolicy({
      realProvider: true,
      settings: settings({
        disabledKinds: () => Promise.resolve(new Set(['RUN_DISPATCHED_RIDER'])),
      }),
    });
    expect(await kindOff.withhold({ kind: 'RUN_DISPATCHED_RIDER', template: run })).toBe(
      'KILL_SWITCH',
    );
  });

  // Break caught: the order of the reasons: a switch that is off is the reason, whatever the words.
  it('names the switch before the wording', async () => {
    const policy = createLanePolicy({
      realProvider: true,
      settings: settings({ smsEnabled: () => Promise.resolve(false) }),
    });
    expect(await policy.withhold({ kind: 'PICKUP_CONFIRMED_SENDER', template: draft })).toBe(
      'KILL_SWITCH',
    );
  });

  it('hands the lane the limits the settings say', async () => {
    const policy = createLanePolicy({
      realProvider: true,
      settings: settings({ limits: () => Promise.resolve({ perNumberPerDay: 10, perDay: 500 }) }),
    });
    expect(await policy.limits()).toEqual({ perNumberPerDay: 10, perDay: 500 });
  });
});
