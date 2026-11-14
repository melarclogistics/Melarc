import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import {
  DECLARED,
  INTAKE_ADJUDICATION_ID,
  INTAKE_EVIDENCE_ONE,
  INTAKE_EVIDENCE_TWO,
  INTAKE_HUB_ID,
  INTAKE_ID,
  INTAKE_OFFICER_ID,
  INTAKE_PHOTO_ONE,
  INTAKE_PHOTO_TWO,
  PLANTED_DECLARATION,
  findingFixture,
  postCountFixture,
  preCountFixture,
  shortCountFixture,
} from '../../../test-support/hub-intake-fixture';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import { MANIFEST_ID, REQUEST_ONE_ID } from '../../../test-support/manifest-fixture';
import { renderApp } from '../../../test-support/render-app';
import { etag, refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/intakes/{id}` (`getHubIntake`; S1.35). The record of an intake. **Before the count it is the pre-count facts and a way to the count page, and shows no comparison**; after it, the comparison as the server
 * stated it, the condition and the findings in the order they were made with their photos, and the photos of the collection, each opened one at a time. Acts are offered by key and by what the record says;
 * **itemising and closing are not offered**, and the page says they are later work.
 */
const PATH = `/intakes/${INTAKE_ID}`;
const GET = `GET /hub-intakes/${INTAKE_ID}`;
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;
const RECEIVER = ['hub.read', 'hub.intake.count'];
const SENIOR = ['hub.read', 'hub.intake.count', 'hub.osd.adjudicate'];
const RETRIEVAL = (id: string) => `POST /evidence/${id}/retrieval-authorization`;

let api: FakeApi;
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

function open(
  intake: object,
  keys: readonly string[] = RECEIVER,
  handlers: Record<string, Handler> = {},
) {
  api = installFakeApi(
    staffApi(
      sessionWith(keys, {
        authorized_hubs: [{ id: INTAKE_HUB_ID, display_name: 'Accra Central' }],
      }),
      { [GET]: () => json(200, intake, etag('v3')), ...handlers },
    ),
  );
  return renderApp(PATH);
}

const authorizations = () =>
  api.requests.filter((request) => request.url.endsWith('/retrieval-authorization'));
const grant =
  (name: string): Handler =>
  () =>
    json(
      200,
      {
        method: 'GET',
        url: `https://photos.example/${name}?sig=one`,
        expires_at: '2026-11-14T10:05:00Z',
      },
      { 'Cache-Control': 'no-store' },
    );

describe('an intake that has not been counted', () => {
  it('is its pre-count facts and a way to the count, and shows no comparison', async () => {
    open(preCountFixture());

    expect(await screen.findByRole('heading', { level: 1, name: 'ACC-IN-7KQ2MZ' })).toBeVisible();
    expect(screen.getAllByText('Awaiting count').length).toBeGreaterThan(0);
    expect(screen.getByText(/Waiting to be counted\. The count is blind/)).toBeVisible();
    expect(
      screen.getByText(
        /This intake has not been counted\. The count is blind: nothing of the rider’s declaration is shown/,
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Count the parcels' })).toHaveAttribute(
      'href',
      `/intakes/${INTAKE_ID}/count`,
    );
    expect(screen.getByRole('link', { name: 'Open the run' })).toHaveAttribute(
      'href',
      `/manifests/${MANIFEST_ID}`,
    );
    expect(screen.getByRole('link', { name: 'Open the request' })).toHaveAttribute(
      'href',
      `/pickup-requests/${REQUEST_ONE_ID}`,
    );
    expect(screen.getByText('A rider')).toBeVisible();
    // No comparison, no declaration, no photos, no findings, and no act of a counted intake.
    for (const text of [
      /Declared by the rider/,
      /Counted at the hub/,
      /Comparison/,
      /Photos of the collection/,
      /Condition$/,
    ]) {
      expect(screen.queryByText(text)).toBeNull();
    }
    expect(screen.queryByRole('link', { name: /Adjudicate|Record the condition/ })).toBeNull();
  });

  // Break caught: a pre-count record whose answer carried the declaration drawn, in the text, an attribute or the title.
  it('refuses an answer that carries the declaration, and the number is nowhere on the page', async () => {
    open({ ...preCountFixture(), rider_declared_count: PLANTED_DECLARATION });

    expect(await screen.findByText('This intake could not be loaded.')).toBeVisible();
    expect(document.documentElement.outerHTML).not.toContain(String(PLANTED_DECLARATION));
    expect(screen.queryByRole('heading', { level: 1, name: 'ACC-IN-7KQ2MZ' })).toBeNull();
  });

  // Break caught: a photo of the collection asked for before the count, which would tell the receiver what the rider counted (the number of photos is the rider's count).
  it('asks for no photo and no evidence, and draws none', async () => {
    open(preCountFixture());
    await screen.findByRole('heading', { level: 1, name: 'ACC-IN-7KQ2MZ' });

    expect(authorizations()).toHaveLength(0);
    expect(api.requests.filter((request) => request.url.includes('/evidence'))).toHaveLength(0);
    expect(screen.queryByRole('list', { name: /Photos/ })).toBeNull();
  });

  it('offers the count only to a holder of its key, and says who is receiving now', async () => {
    open(
      preCountFixture({
        active_receiver_id: INTAKE_OFFICER_ID,
        lock_acquired_at: '2026-11-14T09:10:00Z',
      }),
      ['hub.read'],
    );

    expect(await screen.findByText(/^You, last active /)).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Count the parcels' })).toBeNull();
  });
});

describe('an intake that has been counted', () => {
  it('shows the declaration, the count and the server’s comparison, with the difference in words', async () => {
    open(shortCountFixture({ physical_count: 5, count_difference: -2 }));

    expect(await screen.findByRole('heading', { level: 1, name: 'ACC-IN-7KQ2MZ' })).toBeVisible();
    const count = within(screen.getByRole('region', { name: 'The count' }));
    expect(count.getByText(`${String(DECLARED)} parcels`)).toBeVisible();
    expect(count.getByText('5 parcels')).toBeVisible();
    expect(count.getByText('Short')).toBeVisible();
    expect(
      count.getByText('The count is 2 parcels short of what the rider declared.'),
    ).toBeVisible();
    expect(
      screen.getByText('The count or the condition needs a senior officer’s decision.'),
    ).toBeVisible();
  });

  it.each([
    ['MATCH', DECLARED, 0, 'Matches', 'The count matches what the rider declared.'],
    ['OVER', DECLARED + 3, 3, 'Over', 'The count is 3 parcels over what the rider declared.'],
  ] as const)(
    'tells a count that is %s as the server stated it',
    async (variance, physical, difference, badge, sentence) => {
      open(
        postCountFixture({
          physical_count: physical,
          count_variance: variance,
          count_difference: difference,
        }),
      );
      const count = within(await screen.findByRole('region', { name: 'The count' }));

      expect(count.getByText(badge)).toBeVisible();
      expect(count.getByText(sentence)).toBeVisible();
    },
  );

  // Break caught: a difference worked out by the page where the server stated none (the page works out no number).
  it('says a side of the comparison and no number when the server stated no difference', async () => {
    open(
      Object.fromEntries(
        Object.entries(shortCountFixture()).filter(([name]) => name !== 'count_difference'),
      ),
    );
    const count = within(await screen.findByRole('region', { name: 'The count' }));

    expect(count.getByText('The count is short of what the rider declared.')).toBeVisible();
  });

  it('says a zero declaration as zero parcels', async () => {
    open(
      postCountFixture({
        rider_declared_count: 0,
        physical_count: 0,
        count_difference: 0,
        state: 'RECONCILIATION_REQUIRED',
      }),
    );
    const count = within(await screen.findByRole('region', { name: 'The count' }));

    expect(count.getAllByText('0 parcels')).toHaveLength(2);
  });

  // Break caught: the photos of the collection drawn before one is opened, with their authorization asked for ahead of the officer, or kept after it is closed.
  it('lists the photos of the collection without a picture, opens one at a time with its own authorization, and drops it on close', async () => {
    const { user } = open(
      postCountFixture({ parcel_photo_ids: [INTAKE_PHOTO_ONE, INTAKE_PHOTO_TWO] }),
      RECEIVER,
      { [RETRIEVAL(INTAKE_PHOTO_TWO)]: grant('two'), [RETRIEVAL(INTAKE_PHOTO_ONE)]: grant('one') },
    );
    const photos = within(await screen.findByRole('list', { name: 'Photos of the collection' }));

    expect(photos.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Photo of the collection 1',
      'Photo of the collection 2',
    ]);
    expect(document.querySelector('img.stop-photo__image')).toBeNull();
    expect(authorizations()).toHaveLength(0);

    await user.click(photos.getByRole('button', { name: 'Open Photo of the collection 2' }));
    const dialog = await screen.findByRole('dialog', { name: 'Photo of the collection 2' });
    const image = await within(dialog).findByRole('img');
    expect(image).toHaveAttribute('src', 'https://photos.example/two?sig=one');
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(authorizations()).toHaveLength(1);
    expect(authorizations()[0]?.url).toContain(INTAKE_PHOTO_TWO);
    expect(document.body.textContent).not.toContain('photos.example');
    expect(document.body.textContent).not.toContain(INTAKE_PHOTO_TWO);

    await user.click(within(dialog).getByRole('button', { name: 'Close the photo' }));
    expect(document.querySelector('img.stop-photo__image')).toBeNull();
    await user.click(photos.getByRole('button', { name: 'Open Photo of the collection 2' }));
    await within(
      await screen.findByRole('dialog', { name: 'Photo of the collection 2' }),
    ).findByRole('img');
    expect(authorizations()).toHaveLength(2);
  });

  it('says no photos of the collection are attached where the answer has none', async () => {
    open(postCountFixture());
    expect(
      await screen.findByText('No photos of the collection are attached to this intake.'),
    ).toBeVisible();
  });

  it('tells a photo that cannot be opened in the words of an intake’s, and offers to close it', async () => {
    const { user } = open(postCountFixture({ parcel_photo_ids: [INTAKE_PHOTO_ONE] }), RECEIVER, {
      [RETRIEVAL(INTAKE_PHOTO_ONE)]: () =>
        json(403, {
          code: 'PERMISSION_DENIED',
          message: 'Diagnostic text that must never reach a screen.',
          request_id: 'r',
        }),
    });
    await user.click(await screen.findByRole('button', { name: 'Open Photo of the collection 1' }));

    expect(
      await screen.findByText(
        'Your account can’t see hub intakes. Ask an administrator for access.',
      ),
    ).toBeVisible();
    expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
  });
});

describe('the condition and the findings', () => {
  const findings = [
    findingFixture(),
    findingFixture({
      id: INTAKE_ADJUDICATION_ID,
      kind: 'ADJUDICATION',
      condition: null,
      outcome: 'ESCALATED',
      note: 'The vendor must see this.',
      evidence_ids: [INTAKE_EVIDENCE_TWO],
      recorded_by: INTAKE_OFFICER_ID,
      recorded_at: '2026-11-14T10:00:00Z',
    }),
  ];

  // Break caught: findings drawn in another order than they were made, an officer named, or a photo of a finding opened with another's authorization.
  it('lists the findings in the order they were made, each with who and when, never a name, and its photos', async () => {
    const { user } = open(
      shortCountFixture({ condition: 'DAMAGED', condition_findings: findings }),
      RECEIVER,
      { [RETRIEVAL(INTAKE_EVIDENCE_TWO)]: grant('finding-two') },
    );
    const list = within(
      await screen.findByRole('list', { name: 'Findings, in the order they were made' }),
    );

    const items = list
      .getAllByRole('listitem')
      .filter((item) => item.className === 'intake-finding');
    expect(items).toHaveLength(2);
    const [first, second] = items;
    if (first === undefined || second === undefined) throw new Error('two findings expected');
    expect(within(first).getByText('Condition recorded at receiving')).toBeVisible();
    expect(within(first).getByText('Damaged')).toBeVisible();
    expect(within(first).getByText('Two cartons crushed at one corner.')).toBeVisible();
    expect(within(first).getByText(/^Another member of staff, 14 Nov, 09:20$/)).toBeVisible();
    expect(within(second).getByText('Decided by a senior officer')).toBeVisible();
    expect(within(second).getByText('Escalated, still open')).toBeVisible();
    expect(within(second).getByText('The vendor must see this.')).toBeVisible();
    expect(within(second).getByText(/^You, 14 Nov, 10:00$/)).toBeVisible();
    expect(document.body.textContent).not.toContain(INTAKE_EVIDENCE_ONE);

    await user.click(within(second).getByRole('button', { name: 'Open Photo 1' }));
    await screen.findByRole('dialog', { name: 'Photo 1' });
    expect(authorizations()).toHaveLength(1);
    expect(authorizations()[0]?.url).toContain(INTAKE_EVIDENCE_TWO);
  });

  it('says no finding has been recorded when none was, and keeps the three dimensions apart', async () => {
    open(shortCountFixture());
    const condition = within(await screen.findByRole('region', { name: 'Condition' }));

    expect(condition.getByText('Good condition')).toBeVisible();
    expect(condition.getByText('No finding has been recorded.')).toBeVisible();
    // The variance is the count's, the condition is the receiver's: two panels, never one badge.
    expect(
      within(screen.getByRole('region', { name: 'The count' })).queryByText('Good condition'),
    ).toBeNull();
  });

  it('draws a note as text and never as markup', async () => {
    open(
      shortCountFixture({
        condition_findings: [
          findingFixture({
            note: '<img src=x onerror=alert(1)> and <b>bold</b>',
            evidence_ids: [],
          }),
        ],
      }),
    );
    expect(await screen.findByText('<img src=x onerror=alert(1)> and <b>bold</b>')).toBeVisible();
    expect(document.querySelector('main img')).toBeNull();
    expect(document.querySelector('main b')).toBeNull();
  });
});

describe('the acts the record offers', () => {
  // Break caught: the adjudication offered to a session without its key (Ops Staff do not hold it), or to an intake that is not in review; and the condition offered again once it is recorded.
  it('offers the adjudication and the condition to the key that holds them, while the intake is in review', async () => {
    open(shortCountFixture(), SENIOR);
    expect(await screen.findByRole('link', { name: 'Adjudicate' })).toHaveAttribute(
      'href',
      `/intakes/${INTAKE_ID}/discrepancy`,
    );
    expect(screen.getByRole('link', { name: 'Record the condition' })).toHaveAttribute(
      'href',
      `/intakes/${INTAKE_ID}/condition`,
    );
  });

  it('does not offer the adjudication to a session without its key, and says a senior officer decides it', async () => {
    open(shortCountFixture(), RECEIVER);
    expect(
      await screen.findByText(
        'A senior officer decides this. Your account can’t decide a discrepancy found at receiving. Ask an administrator for access.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Adjudicate' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Record the condition' })).toBeVisible();
  });

  it('does not offer the adjudication to an intake that is not in review', async () => {
    open(postCountFixture(), SENIOR);
    await screen.findByRole('heading', { level: 1, name: 'ACC-IN-7KQ2MZ' });
    expect(screen.queryByRole('link', { name: 'Adjudicate' })).toBeNull();
    expect(screen.queryByText(/A senior officer decides this/)).toBeNull();
  });

  it('offers the adjudication on a count that matches, because damage is independent of the count', async () => {
    open(
      postCountFixture({
        state: 'RECONCILIATION_REQUIRED',
        condition: 'DAMAGED',
        condition_findings: [findingFixture()],
      }),
      SENIOR,
    );
    expect(await screen.findByRole('link', { name: 'Adjudicate' })).toBeVisible();
    expect(screen.getByText('Matches')).toBeVisible();
  });

  it('offers the condition once: not after one is recorded', async () => {
    open(
      shortCountFixture({ condition: 'DAMAGED', condition_findings: [findingFixture()] }),
      SENIOR,
    );
    await screen.findByRole('heading', { level: 1, name: 'ACC-IN-7KQ2MZ' });
    expect(screen.queryByRole('link', { name: 'Record the condition' })).toBeNull();
  });

  it('does not offer the condition once itemising has begun', async () => {
    open(postCountFixture({ state: 'ITEMIZING' }), SENIOR);
    await screen.findByText('Itemising has begun.');
    expect(screen.queryByRole('link', { name: 'Record the condition' })).toBeNull();
  });

  // Break caught: itemising or closing offered, or a placeholder for either: they are later work, and the page says so.
  it('never offers itemising or closing, and says they are later work', async () => {
    open(postCountFixture(), SENIOR);

    expect(
      await screen.findByText(
        'Counted and cleared. Itemising and closing an intake are later work: nothing on this page starts them.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('link', { name: /itemi|close/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /itemi|close/i })).toBeNull();
  });
});

describeInterfaceStates('the intake record', {
  loading: {
    test: async () => {
      open(preCountFixture(), RECEIVER, { [GET]: () => new Promise<Response>(() => undefined) });
      expect(await screen.findByText('Loading the intake…')).toBeVisible();
    },
  },
  empty: {
    inapplicable:
      'A record page is never empty: an intake that is not there is the not-found page, which another test shows.',
  },
  'validation error': {
    inapplicable:
      'The record takes no input: the forms of its acts are other pages, each with its own validation test.',
  },
  error: {
    test: async () => {
      open(preCountFixture(), RECEIVER, { [GET]: () => refusal(500, 'INTERNAL_ERROR') });
      expect(await screen.findByText('This intake could not be loaded.')).toBeVisible();
      expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const { user } = open(preCountFixture(), RECEIVER, {
        [GET]: () => {
          attempts += 1;
          return attempts === 1
            ? refusal(503, 'SERVICE_UNAVAILABLE')
            : json(200, preCountFixture(), etag('v3'));
        },
      });
      await screen.findByText('This intake could not be loaded.');
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      expect(await screen.findByRole('heading', { level: 1, name: 'ACC-IN-7KQ2MZ' })).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    inapplicable:
      'The record changes nothing, so nothing the officer does here can leave it stale: the version an act takes is read by the act’s own page.',
  },
  success: {
    test: async () => {
      open(shortCountFixture());
      expect(await screen.findByRole('region', { name: 'The count' })).toBeVisible();
      await waitFor(() => {
        expect(screen.getByText('Short')).toBeVisible();
      });
    },
  },
  'permission-restricted': {
    test: async () => {
      open(preCountFixture(), RECEIVER, { [GET]: () => refusal(403, 'PERMISSION_DENIED') });
      expect(
        await screen.findByText(
          'Your account can’t see hub intakes. Ask an administrator for access.',
        ),
      ).toBeVisible();
    },
  },
});
