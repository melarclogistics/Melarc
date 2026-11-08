import { describe, expect, it } from 'vitest';

import { reasonFixture } from '../../test-support/reason-fixture';
import { parseReasons } from './reason-definitions';

describe('parseReasons: the reasons a screen may offer', () => {
  it('keeps the code, the label and whether a note is mandatory, and nothing else', () => {
    const parsed = parseReasons([
      reasonFixture({ code: 'DEMO_A', label: 'Demo A', requiresNote: true }),
      reasonFixture({ code: 'DEMO_B', label: 'Demo B' }),
    ]);

    expect(parsed).toEqual([
      { code: 'DEMO_A', label: 'Demo A', requiresNote: true },
      { code: 'DEMO_B', label: 'Demo B', requiresNote: false },
    ]);
  });

  // Break caught: an inactive reason offered, which the server would refuse as REASON_NOT_ACTIVE after the person had typed a note.
  it('drops a reason that is not active', () => {
    const parsed = parseReasons([
      reasonFixture({ code: 'DEMO_A', label: 'Demo A' }),
      reasonFixture({ code: 'DEMO_OLD', label: 'Retired', active: false }),
    ]);

    expect(parsed?.map((reason) => reason.code)).toEqual(['DEMO_A']);
  });

  it('keeps the order the server gave', () => {
    const parsed = parseReasons([
      reasonFixture({ code: 'DEMO_Z', label: 'Zed' }),
      reasonFixture({ code: 'DEMO_A', label: 'Aye' }),
    ]);

    expect(parsed?.map((reason) => reason.code)).toEqual(['DEMO_Z', 'DEMO_A']);
  });

  it('reads a catalogue with nothing in it as an empty one, which is an answer', () => {
    expect(parseReasons([])).toEqual([]);
  });

  // Break caught: an answer that is not the catalogue (a proxy’s page, a list from another server version) being offered as one.
  it.each([
    ['null', null],
    ['an object', { items: [] }],
    ['a string', 'reasons'],
    ['an entry that is not an object', ['DEMO_A']],
    ['an entry with no code', [{ label: 'Demo', active: true }]],
    ['an entry with no label', [{ code: 'DEMO_A', active: true }]],
    ['an entry with an empty label', [{ code: 'DEMO_A', label: '', active: true }]],
    ['an entry with a code that is not a string', [{ code: 7, label: 'Demo', active: true }]],
    ['an entry with no active flag', [{ code: 'DEMO_A', label: 'Demo' }]],
    ['a code that is far too long', [reasonFixture({ code: 'D'.repeat(65) })]],
    ['a label that is far too long', [reasonFixture({ label: 'L'.repeat(201) })]],
    ['a label with a control character', [reasonFixture({ label: 'Two\nlines' })]],
    ['a code with a space', [reasonFixture({ code: 'DEMO A' })]],
    ['a requiresNote that is not a boolean', [{ ...reasonFixture(), requiresNote: 'yes' }]],
    [
      'two entries with one code',
      [reasonFixture({ code: 'DEMO_A' }), reasonFixture({ code: 'DEMO_A', label: 'Other' })],
    ],
  ])('refuses the whole answer for %s', (_label, body) => {
    expect(parseReasons(body)).toBeUndefined();
  });

  it('refuses a catalogue that is absurdly long', () => {
    const body = Array.from({ length: 501 }, (_, index) =>
      reasonFixture({ code: `DEMO_${String(index)}`, label: `Demo ${String(index)}` }),
    );

    expect(parseReasons(body)).toBeUndefined();
  });
});
