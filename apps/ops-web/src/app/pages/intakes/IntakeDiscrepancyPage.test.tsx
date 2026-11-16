import { webcrypto } from 'node:crypto';

import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import {
  DECLARED,
  INTAKE_EVIDENCE_ONE,
  INTAKE_HUB_ID,
  INTAKE_ID,
  findingFixture,
  postCountFixture,
  preCountFixture,
  shortCountFixture,
} from '../../../test-support/hub-intake-fixture';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import { cannotText } from '../../../platform/problem/capability-words';
import { renderApp } from '../../../test-support/render-app';
import { etag, refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/intakes/{id}/discrepancy` (`adjudicateDiscrepancy`, with the evidence operations; S1.35). The task form of a senior officer's decision, **never offered to a session without the key** (the route is behind it).
 * Reachable on a count that matches (damage is independent of the count). The outcome is chosen, never defaulted, and the reason is mandatory; a condition can be set with it, with photos of the adjudicator's
 * own; the counts the server stated are beside the form and a decision changes none of them. `ESCALATED` leaves the case open. The act takes the version and no key.
 */
const PATH = `/intakes/${INTAKE_ID}/discrepancy`;
const GET = `GET /hub-intakes/${INTAKE_ID}`;
const ACT = `POST /hub-intakes/${INTAKE_ID}/discrepancy`;
const CREATE = 'POST /evidence';
const PUT = 'PUT /object-store/photo-1';
const COMPLETE = `POST /evidence/${INTAKE_EVIDENCE_ONE}/complete`;
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;
const SENIOR = ['hub.read', 'hub.intake.count', 'hub.osd.adjudicate'];
const REASON = 'Two parcels lost between the door and the table.';

let api: FakeApi;
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
  vi.unstubAllGlobals();
});

const ticket = () => ({
  evidence: {
    id: INTAKE_EVIDENCE_ONE,
    owner_type: 'PICKUP_INTAKE',
    owner_id: INTAKE_ID,
    purpose: 'OSD',
    captured_at: '2026-11-01T08:30:00Z',
    captured_by_actor: INTAKE_ID,
    state: 'PENDING_UPLOAD',
    access_rule: 'x',
    retention_policy: 'y',
  },
  upload: {
    method: 'PUT',
    url: 'https://store.example/object-store/photo-1?sig=bearer-capability',
    headers: { 'Content-Type': 'image/jpeg' },
    // An address the platform has just made lives for minutes from now: the portal judges it by the clock, and one that had run out is asked for again.
    expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
  },
});

function open(
  intake: object = shortCountFixture(),
  handlers: Record<string, Handler> = {},
  keys: readonly string[] = SENIOR,
) {
  api = installFakeApi(
    staffApi(
      sessionWith(keys, {
        authorized_hubs: [{ id: INTAKE_HUB_ID, display_name: 'Accra Central' }],
      }),
      {
        [GET]: () => json(200, intake, etag('v3')),
        [CREATE]: () => json(200, ticket(), etag('e1')),
        [PUT]: () => new Response(null, { status: 200 }),
        [COMPLETE]: () => json(200, { id: INTAKE_EVIDENCE_ONE, state: 'STORED' }),
        ...handlers,
      },
    ),
  );
  return renderApp(PATH);
}

const acts = () =>
  api.requests.filter(
    (request) => request.method === 'POST' && request.url.endsWith('/discrepancy'),
  );
const photo = () =>
  new File([new Uint8Array([1, 2, 3, 4])], 'seal.jpg', {
    type: 'image/jpeg',
    lastModified: Date.parse('2026-11-01T08:30:00Z'),
  });
const resolved = () => shortCountFixture({ state: 'READY_FOR_ITEMIZATION' });

async function decide(user: UserEvent, outcome: RegExp, reason = REASON): Promise<void> {
  await user.click(await screen.findByRole('radio', { name: outcome }));
  if (reason !== '') await user.type(screen.getByRole('textbox', { name: /Reason/ }), reason);
}
async function review(user: UserEvent): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: 'Review' }));
  return screen.findByRole('alertdialog');
}

describe('the form', () => {
  it('shows what the server stated of the count beside it, and says a decision changes none of it', async () => {
    open();

    expect(await screen.findByRole('heading', { level: 1, name: 'Adjudicate' })).toBeVisible();
    const counted = within(
      await screen.findByRole('heading', { level: 3, name: 'What was counted' }).then((heading) => {
        if (heading.parentElement === null) throw new Error('a heading with no parent');
        return heading.parentElement;
      }),
    );
    expect(counted.getByText(`${String(DECLARED)} parcels`)).toBeVisible();
    expect(counted.getByText('Short')).toBeVisible();
    expect(
      screen.getByText(/A decision explains the difference and never changes a count/),
    ).toBeVisible();
    for (const radio of screen.getAllByRole('radio')) expect(radio).not.toBeChecked();
  });

  it('is reachable on a count that matches, because damage is independent of the count', async () => {
    open(
      postCountFixture({
        state: 'RECONCILIATION_REQUIRED',
        condition: 'DAMAGED',
        condition_findings: [findingFixture()],
      }),
    );

    expect(await screen.findByRole('radio', { name: /Accept the count/ })).toBeVisible();
    expect(screen.getAllByText('Matches').length).toBeGreaterThan(0);
  });

  // Break caught: an outcome sent when none was chosen (an inertia answer), or a decision with no reason: the reason is mandatory.
  it('asks for an outcome and a reason at their fields, and sends nothing', async () => {
    const { user } = open();

    await user.click(await screen.findByRole('button', { name: 'Review' }));
    expect(await screen.findByText('Choose the outcome.')).toBeVisible();
    expect(screen.getByText('Write why you decided this.')).toBeVisible();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(acts()).toHaveLength(0);
  });

  // Break caught: the decision sent with a key (the operation declares none), without the version read, under other names, or with a condition nobody set.
  it('sends the outcome and the reason on the version read, under no key, and brings the officer to the record', async () => {
    const { user } = open(shortCountFixture(), {
      [ACT]: () => {
        api.on(GET, () => json(200, resolved(), etag('v4')));
        return json(200, resolved(), etag('v4'));
      },
    });
    await decide(user, /Write off the difference/);

    const dialog = within(await review(user));
    expect(
      dialog.getByText(
        /This records your decision and your reason against the count\. It changes no count\. The intake is then cleared for itemising\./,
      ),
    ).toBeVisible();
    await user.click(dialog.getByRole('button', { name: 'Record the decision' }));

    await waitFor(() => {
      expect(acts()).toHaveLength(1);
    });
    const [act] = acts();
    expect(act?.headers.get('If-Match')).toBe('"v3"');
    expect(act?.headers.get('Idempotency-Key')).toBeNull();
    expect(await act?.clone().json()).toEqual({ outcome: 'WRITTEN_OFF', note: REASON });
    expect(await screen.findByText('Your decision is recorded.')).toBeVisible();
    expect(
      await screen.findByText(
        'Counted and cleared. Itemising and closing an intake are later work: nothing on this page starts them.',
      ),
    ).toBeVisible();
  });

  it('says an escalation leaves the case open', async () => {
    const { user } = open();
    await decide(user, /Escalate/);

    const dialog = within(await review(user));
    expect(dialog.getByText(/The case stays open for a later decision\./)).toBeVisible();
    expect(dialog.queryByText(/cleared for itemising/)).toBeNull();
  });

  it('says what each outcome does and does not do, and that the portal sends no message to a vendor', async () => {
    open();
    expect(
      await screen.findByText(
        'Records that the vendor was told of the difference. The portal sends no message. The intake is cleared for itemising.',
      ),
    ).toBeVisible();
    expect(
      screen.getByText('Records your reason and leaves the case open for a later decision.'),
    ).toBeVisible();
  });

  // Break caught: a condition set with the decision that is sent without its photos, uploaded for the receiver's purpose, or not cited.
  // Break caught: a photo made for a senior's decision refused in the receiver's capability ("your account can't count parcels"), which sends an officer to ask for the wrong access.
  it('tells a photo the platform refused for this decision in the decision’s own capability', async () => {
    const { user } = open(shortCountFixture(), {
      [CREATE]: () => refusal(403, 'PERMISSION_DENIED'),
    });
    await decide(user, /Escalate/, 'Seal broken.');
    await user.click(
      screen.getByRole('checkbox', { name: /Also record the condition of the parcels/ }),
    );
    await user.click(await screen.findByRole('radio', { name: /Tampered with/ }));
    await user.upload(screen.getByLabelText(/Photos of what you found/), photo());

    expect(await screen.findByText(cannotText('hub.osd.adjudicate'))).toBeVisible();
    expect(screen.queryByText(cannotText('hub.intake.count'))).toBeNull();
  });

  it('sets a condition with the decision, uploads the photos for the adjudicator’s own purpose, and cites them', async () => {
    const { user } = open(shortCountFixture(), {
      [ACT]: () =>
        json(
          200,
          shortCountFixture({ condition: 'TAMPERED', state: 'RECONCILIATION_REQUIRED' }),
          etag('v4'),
        ),
    });
    await decide(user, /Escalate/, 'Seal broken.');
    await user.click(
      screen.getByRole('checkbox', { name: /Also record the condition of the parcels/ }),
    );
    await user.click(await screen.findByRole('radio', { name: /Tampered with/ }));
    await user.upload(screen.getByLabelText(/Photos of what you found/), photo());
    await screen.findByText('Stored');

    const declaration = api.requests.find(
      (request) => request.method === 'POST' && request.url.endsWith('/evidence'),
    );
    expect(await declaration?.clone().json()).toMatchObject({
      owner_type: 'PICKUP_INTAKE',
      purpose: 'OSD',
    });

    const dialog = within(await review(user));
    await user.click(dialog.getByRole('button', { name: 'Record the decision' }));
    await waitFor(() => {
      expect(acts()).toHaveLength(1);
    });
    expect(await acts()[0]?.clone().json()).toEqual({
      outcome: 'ESCALATED',
      note: 'Seal broken.',
      condition: 'TAMPERED',
      evidence_ids: [INTAKE_EVIDENCE_ONE],
    });
  });

  it('asks for a condition once it is to be set, and for a photo of damage and tampering', async () => {
    const { user } = open();
    await decide(user, /Accept the count/);
    await user.click(
      screen.getByRole('checkbox', { name: /Also record the condition of the parcels/ }),
    );

    await user.click(screen.getByRole('button', { name: 'Review' }));
    expect(await screen.findByText('Choose what you found.')).toBeVisible();
    await user.click(screen.getByRole('radio', { name: /Damaged/ }));
    await user.click(screen.getByRole('button', { name: 'Review' }));
    expect(await screen.findByText('Add at least one photo of what you found.')).toBeVisible();
    expect(acts()).toHaveLength(0);
  });

  // Break caught: a lost answer offered a retry for an act that takes no key: a second send might meet a record that has moved, so only a look at the record is offered.
  it('offers only a look at the record when the outcome is not known, because the act takes no key', async () => {
    const { user } = open(shortCountFixture(), {
      [ACT]: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await decide(user, /Accept the count/);

    const dialog = within(await review(user));
    await user.click(dialog.getByRole('button', { name: 'Record the decision' }));

    expect(await dialog.findByText(/We could not confirm whether this was done/)).toBeVisible();
    expect(dialog.getByRole('button', { name: 'Check the record' })).toBeVisible();
    expect(dialog.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it.each([
    [
      'not_awaiting_resolution',
      /This intake is not waiting for a decision: it may have been resolved already\./,
    ],
    ['stale', /This intake changed after you opened it, so the decision was not recorded/],
  ])('tells a refusal by %s in plain words, in the confirmation', async (rule, words) => {
    const { user } = open(shortCountFixture(), {
      [ACT]: () => refusal(409, 'STATE_CONFLICT', { rule }),
    });
    await decide(user, /Accept the count/);

    const dialog = within(await review(user));
    await user.click(dialog.getByRole('button', { name: 'Record the decision' }));

    expect(await dialog.findByText(words)).toBeVisible();
    expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
  });

  it('puts a missing reason, told by the server, at the reason', async () => {
    const { user } = open(shortCountFixture(), { [ACT]: () => refusal(422, 'REASON_REQUIRED') });
    await decide(user, /Accept the count/);

    const dialog = within(await review(user));
    await user.click(dialog.getByRole('button', { name: 'Record the decision' }));

    expect(
      await dialog.findByText(/A reason is needed\. Write why you decided this/),
    ).toBeVisible();
  });
});

describe('an intake the form is not for', () => {
  it('tells an intake that has not been counted, and shows no form and no number', async () => {
    open(preCountFixture());
    expect(
      await screen.findByText(
        /This intake has not been counted yet, so there is nothing to decide\./,
      ),
    ).toBeVisible();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByText(/declared/i)).toBeNull();
  });

  it('tells an intake that is not in review, and one that was resolved already', async () => {
    open(postCountFixture());
    expect(
      await screen.findByText(
        /This intake is not waiting for a decision: it may have been resolved already\./,
      ),
    ).toBeVisible();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  // Break caught: the act reachable by a session without its key (Ops Staff do not hold it): it is refused in plain words and no form is drawn.
  it('refuses a session without the key of the adjudication, in plain words, and asks the server nothing', async () => {
    open(shortCountFixture(), {}, ['hub.read', 'hub.intake.count']);

    expect(
      await screen.findByText(
        'Your account can’t decide a discrepancy found at receiving. Ask an administrator for access.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(api.requests.filter((request) => request.url.includes('/hub-intakes/'))).toHaveLength(0);
  });
});

describeInterfaceStates('the adjudication form', {
  loading: {
    test: async () => {
      open(shortCountFixture(), { [GET]: () => new Promise<Response>(() => undefined) });
      expect(await screen.findByText('Loading the intake…')).toBeVisible();
    },
  },
  empty: {
    inapplicable:
      'A form is never empty: an intake that is not there is the not-found page, which the count page’s test shows.',
  },
  'validation error': {
    test: async () => {
      const { user } = open();
      await user.click(await screen.findByRole('button', { name: 'Review' }));
      expect(await screen.findByText('Choose the outcome.')).toBeVisible();
    },
  },
  error: {
    test: async () => {
      open(shortCountFixture(), { [GET]: () => refusal(500, 'INTERNAL_ERROR') });
      expect(await screen.findByText('This intake could not be loaded.')).toBeVisible();
      expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const { user } = open(shortCountFixture(), {
        [GET]: () => {
          attempts += 1;
          return attempts === 1
            ? refusal(503, 'SERVICE_UNAVAILABLE')
            : json(200, shortCountFixture(), etag('v3'));
        },
      });
      await screen.findByText('This intake could not be loaded.');
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      expect(await screen.findByRole('radio', { name: /Accept the count/ })).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    test: async () => {
      const { user } = open(shortCountFixture(), {
        [ACT]: () => refusal(409, 'STATE_CONFLICT', { rule: 'stale' }),
      });
      await decide(user, /Accept the count/);
      const dialog = within(await review(user));
      await user.click(dialog.getByRole('button', { name: 'Record the decision' }));
      expect(await dialog.findByText(/changed after you opened it/)).toBeVisible();
    },
  },
  success: {
    test: async () => {
      const { user } = open(shortCountFixture(), {
        [ACT]: () => json(200, resolved(), etag('v4')),
      });
      await decide(user, /Accept the count/);
      const dialog = within(await review(user));
      await user.click(dialog.getByRole('button', { name: 'Record the decision' }));
      expect(await screen.findByText('Your decision is recorded.')).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      open(shortCountFixture(), { [GET]: () => refusal(403, 'PERMISSION_DENIED') });
      expect(
        await screen.findByText(
          'Your account can’t see what has been handed over at a hub. Ask an administrator for access.',
        ),
      ).toBeVisible();
    },
  },
});
