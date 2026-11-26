import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import { INTAKE_HUB_ID } from '../../../test-support/hub-intake-fixture';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import { captured } from '../../../test-support/orders-fixture';
import { renderApp } from '../../../test-support/render-app';
import { refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/payer-corrections` and `/payer-corrections/{id}` (`listPayerCorrections`, `getPayerCorrection`, `approvePayerCorrection`; S1.40; AC-SLICE-001-60 to 64): **the checker's queue** for the requests to change who pays
 * for an order whose price is fixed. The price never changes, only how it is shared; the amounts are the server's and the page adds nothing up; a senior officer decides on the version read, under a key, and a
 * different officer decides a change someone asked for. Each break named below is one these tests catch.
 */
const ACCRA = { id: INTAKE_HUB_ID, display_name: 'Accra Hub' };
const CHECKER = ['hub.read', 'pricing.correction.create', 'pricing.correction.approve'];
const ASKER = ['hub.read', 'pricing.correction.create'];
const LIST = 'GET /payer-corrections';
const REQUESTED = captured('correction-requested');
const DECIDED = captured('correction-decided');
const ID = REQUESTED.id as string;
const READ = `GET /payer-corrections/${ID}`;
const DECIDE = `POST /payer-corrections/${ID}/decision`;
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;
const FORBIDDEN =
  /\b(?:intakes?|adjudicat\w*|itemi[sz]\w*|reconciliation|advisory|the server|token)\b/i;

const pageOf = (items: readonly unknown[]) => ({ items: [...items], next_page_token: null });

let api: FakeApi;
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

function open(
  handlers: Record<string, Handler> = {},
  keys: readonly string[] = CHECKER,
  path = '/payer-corrections',
) {
  api = installFakeApi(
    staffApi(sessionWith(keys, { authorized_hubs: [ACCRA] }), {
      [LIST]: () => json(200, pageOf([REQUESTED])),
      [READ]: () => json(200, REQUESTED, { ETag: '"c1"' }),
      ...handlers,
    }),
  );
  return renderApp(path);
}

const sent = (route: string) =>
  api.requests.filter(
    (request) =>
      `${request.method} ${new URL(request.url).pathname.replace('/api/v1', '')}` === route,
  );
const bodyOf = async (request: Request | undefined): Promise<Record<string, unknown>> =>
  request === undefined ? {} : ((await request.clone().json()) as Record<string, unknown>);
const listReads = () =>
  api.requests
    .filter((request) => new URL(request.url).pathname === '/api/v1/payer-corrections')
    .map((request) => new URL(request.url).searchParams);

const table = async (): Promise<HTMLElement> => {
  const found = await screen.findByRole('table', { name: 'Changes of who pays' });
  await waitFor(() => {
    expect(found).not.toHaveAttribute('aria-busy', 'true');
  });
  return found;
};
/** The value of a fact of the change opened beside the list: its label is a term of a description list (the same words may head a column of the table). */
const factOf = (label: string): HTMLElement | null => {
  const term = screen.getAllByText(label).find((element) => element.tagName === 'DT');
  return term?.nextElementSibling instanceof HTMLElement ? term.nextElementSibling : null;
};
const openFirst = async (user: ReturnType<typeof renderApp>['user']): Promise<void> => {
  await user.click(
    within(await table()).getByRole('button', { name: /Open the change: ACC-OR-E5VMPB/ }),
  );
};

describe('the queue of the changes of who pays', () => {
  // Break caught: a share worked out by the page (it is the server's), a state that is not the server's filter, or the diagnostic text.
  it('lists what waits for a decision, with what was asked for in the server’s amounts', async () => {
    open();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Changes of who pays' }),
    ).toBeVisible();
    const rows = within(await table());
    expect(rows.getByText('ACC-OR-E5VMPB')).toBeVisible();
    expect(rows.getAllByText('Ama Mensah').length).toBeGreaterThan(0);
    expect(
      rows.getByText('The sender pays GH₵35.00 and the recipient pays GH₵0.00.'),
    ).toBeVisible();
    expect(rows.getAllByText('Waiting for a decision').length).toBeGreaterThan(0);
    // The views are the server's filter, and the first is what waits.
    expect(listReads()[0]?.get('state')).toBe('REQUESTED');
    const views = within(screen.getByRole('tablist', { name: 'Views of the changes of who pays' }));
    expect(views.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Waiting',
      'Approved',
      'Rejected',
      'All',
    ]);
    expect(document.body.textContent).not.toMatch(FORBIDDEN);
    expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
  });

  it('asks the server for the view the officer chose and filters nothing itself', async () => {
    const { user } = open({ [LIST]: () => json(200, pageOf([])) });
    await screen.findByRole('tablist', { name: 'Views of the changes of who pays' });
    await user.click(screen.getByRole('tab', { name: 'Approved' }));
    await waitFor(() => {
      expect(listReads().some((read) => read.get('state') === 'APPROVED')).toBe(true);
    });
    await user.click(screen.getByRole('tab', { name: 'All' }));
    await waitFor(() => {
      expect(listReads().some((read) => read.get('state') === 'all')).toBe(true);
    });
  });

  // Break caught: an empty view told as one that failed, or as a queue that is empty everywhere.
  it('says what an empty view means, in its own words', async () => {
    const { user } = open({ [LIST]: () => json(200, pageOf([])) });
    expect(await screen.findByText('Nothing is waiting for a decision.')).toBeVisible();
    await user.click(screen.getByRole('tab', { name: 'Rejected' }));
    expect(await screen.findByText('No change has been rejected yet.')).toBeVisible();
  });
});

describe('a change opened beside the list', () => {
  // Break caught: the price shown as changed (it never is), a portion drawn that the server did not give, or what the approval would do left unsaid.
  it('shows the fixed price, how it is paid now, what is asked for and what approving does', async () => {
    const { user } = open();
    await openFirst(user);
    expect(await screen.findByText('Price (fixed)')).toBeVisible();
    expect(factOf('Price (fixed)')).toHaveTextContent('GH₵35.00');
    expect(factOf('Paid like this now')).toHaveTextContent(
      'The sender pays GH₵0.00 and the recipient pays GH₵35.00.',
    );
    expect(factOf('Asked for')).toHaveTextContent('The sender pays all of it');
    expect(factOf('After approval the order')).toHaveTextContent(
      'The sender owes an amount, so the order waits for payment before it can go out.',
    );
    expect(factOf('Reason given')).toHaveTextContent('The vendor will pay on the phone');
    expect(screen.getByRole('link', { name: 'ACC-OR-E5VMPB' })).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/orders\//),
    );
    expect(document.body.textContent).not.toMatch(FORBIDDEN);
  });

  // Break caught: the act of a decider offered to an account that may not decide, or no word of who does.
  it('offers the decision to a senior officer, and tells an account that may not decide who does', async () => {
    const { user } = open({}, ASKER);
    await openFirst(user);
    expect(await screen.findByText('A senior officer decides this.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  // Break caught: an approval sent without a confirmation, without the version read or without a key; an approval that does not say what it does.
  it('approves on the version read, under a key, after a confirmation, and says it did', async () => {
    let reads = 0;
    const { user } = open({
      [READ]: () => {
        reads += 1;
        return reads === 1
          ? json(200, REQUESTED, { ETag: '"c1"' })
          : json(200, DECIDED, { ETag: '"c2"' });
      },
      [DECIDE]: () => json(200, DECIDED, { ETag: '"c2"' }),
    });
    await openFirst(user);
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = within(await screen.findByRole('alertdialog'));
    expect(dialog.getByText('Approve this change?')).toBeVisible();
    expect(dialog.getByText(/The price does not change\./)).toBeVisible();
    // Nothing is sent until the officer confirms.
    expect(sent(DECIDE)).toHaveLength(0);
    await user.type(dialog.getByLabelText(/Note \(optional\)/), 'Agreed with the vendor');
    await user.click(dialog.getByRole('button', { name: 'Yes, approve' }));

    expect(await screen.findByText('The change was approved.')).toBeVisible();
    const request = sent(DECIDE)[0];
    expect(request?.headers.get('If-Match')).toBe('"c1"');
    expect(request?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await bodyOf(request)).toEqual({ decision: 'APPROVE', note: 'Agreed with the vendor' });
    // The queue is read again: a decided change leaves it.
    await waitFor(() => {
      expect(listReads().length).toBeGreaterThan(1);
    });
  });

  it('rejects with no note, and sends none', async () => {
    const { user } = open({
      [DECIDE]: () =>
        json(
          200,
          {
            ...DECIDED,
            state: 'REJECTED',
            resulting_allocation: null,
            resulting_commercial_state: null,
          },
          { ETag: '"c2"' },
        ),
    });
    await openFirst(user);
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    const dialog = within(await screen.findByRole('alertdialog'));
    expect(dialog.getByText('Reject this change?')).toBeVisible();
    await user.click(dialog.getByRole('button', { name: 'Yes, reject' }));
    expect(await screen.findByText('The change was rejected.')).toBeVisible();
    expect(await bodyOf(sent(DECIDE)[0])).toEqual({ decision: 'REJECT' });
  });

  // Break caught: a checker's own request approved (the server refuses it, and the screen must say why in plain words and never offer a way round).
  it('tells that a different officer decides a change the account asked for', async () => {
    const { user } = open({
      [DECIDE]: () => refusal(403, 'SELF_APPROVAL_FORBIDDEN'),
    });
    await openFirst(user);
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = within(await screen.findByRole('alertdialog'));
    await user.click(dialog.getByRole('button', { name: 'Yes, approve' }));
    expect(
      await dialog.findByText('A different officer decides a change you asked for.'),
    ).toBeVisible();
    expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
  });

  // Break caught: a decision made on a change that was decided or changed since it was read (it must be told and never overwritten).
  it('tells a change that was decided meanwhile, and reads it again', async () => {
    let reads = 0;
    const { user } = open({
      [READ]: () => {
        reads += 1;
        return reads === 1
          ? json(200, REQUESTED, { ETag: '"c1"' })
          : json(200, DECIDED, { ETag: '"c2"' });
      },
      [DECIDE]: () => refusal(409, 'STATE_CONFLICT', { rule: 'stale' }),
    });
    await openFirst(user);
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = within(await screen.findByRole('alertdialog'));
    await user.click(dialog.getByRole('button', { name: 'Yes, approve' }));
    expect(
      await dialog.findByText(
        /This change was decided or changed after you opened it, so nothing was saved\./,
      ),
    ).toBeVisible();
    await user.click(dialog.getByRole('button', { name: /Reload/ }));
    // Read again, the change is the approved one: what the approval did is shown and no decision is offered.
    expect(await screen.findByText('What the approval did')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(factOf('Decided by')).toHaveTextContent('Ama Mensah');
  });

  // Break caught: a decided change offered for a decision again, or what it did left out.
  it('shows a decided change as decided, with what the approval did, and offers no decision', async () => {
    const { user } = open({
      [LIST]: () => json(200, pageOf([DECIDED])),
      [READ]: () => json(200, DECIDED, { ETag: '"c2"' }),
    });
    await user.click(await screen.findByRole('tab', { name: 'Approved' }));
    await openFirst(user);
    expect(await screen.findByText('What the approval did')).toBeVisible();
    expect(factOf('What the approval did')).toHaveTextContent(
      'The sender pays GH₵35.00 and the recipient pays GH₵0.00.',
    );
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByText('A senior officer decides this.')).toBeNull();
  });
});

describe('a change on a page of its own', () => {
  // Break caught: a link from an order that leads nowhere, or a change that cannot be read on another device.
  it('is read by its own address, for a link followed from an order', async () => {
    open({}, CHECKER, `/payer-corrections/${ID}`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Changes of who pays' }),
    ).toBeVisible();
    expect(await screen.findByText('Price (fixed)')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Changes of who pays' })).toHaveAttribute(
      'href',
      '/payer-corrections',
    );
  });

  // Break caught: a decision made on this page that changes nothing on it (the officer is left unsure it was made, with the decision still offered).
  it('says what the decision came to, and shows the change as decided, once it is made', async () => {
    let reads = 0;
    const { user } = open(
      {
        [READ]: () => {
          reads += 1;
          return reads === 1
            ? json(200, REQUESTED, { ETag: '"c1"' })
            : json(200, DECIDED, { ETag: '"c2"' });
        },
        [DECIDE]: () => json(200, DECIDED, { ETag: '"c2"' }),
      },
      CHECKER,
      `/payer-corrections/${ID}`,
    );
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Yes, approve' }),
    );
    expect(await screen.findByText('The change was approved.')).toBeVisible();
    // The change is read again as it now stands: decided, with what the approval did, and no decision is offered.
    expect(await screen.findByText('What the approval did')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(sent(DECIDE)).toHaveLength(1);
  });

  it('is told as not found when the change is not there', async () => {
    open({ [READ]: () => refusal(404, 'NOT_FOUND') }, CHECKER, `/payer-corrections/${ID}`);
    expect(await screen.findByRole('alert')).toHaveTextContent('This change could not be found.');
  });

  it('is told as not found when the address is not a change’s, and nothing is read', async () => {
    api = installFakeApi(staffApi(sessionWith(CHECKER, { authorized_hubs: [ACCRA] }), {}));
    renderApp('/payer-corrections/not-an-id');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'This change could not be found.' }),
    ).toBeVisible();
    expect(
      api.requests.some((request) => new URL(request.url).pathname.includes('/payer-corrections')),
    ).toBe(false);
  });
});

describeInterfaceStates('the queue of the changes of who pays', {
  loading: {
    test: async () => {
      open({ [LIST]: () => new Promise<Response>(() => undefined) });
      expect(await screen.findByText(/Loading/)).toBeVisible();
    },
  },
  empty: {
    test: async () => {
      open({ [LIST]: () => json(200, pageOf([])) });
      expect(await screen.findByText('Nothing is waiting for a decision.')).toBeVisible();
    },
  },
  'validation error': {
    test: async () => {
      open({
        [LIST]: () =>
          refusal(400, 'VALIDATION_FAILED', {
            violations: [{ in: 'query', pointer: '/state', rule: 'enum' }],
          }),
      });
      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeVisible();
      });
      expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    },
  },
  error: {
    test: async () => {
      open({ [LIST]: () => refusal(500, 'INTERNAL_ERROR') });
      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeVisible();
      });
      expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const { user } = open({
        [LIST]: () => {
          attempts += 1;
          return attempts === 1
            ? refusal(503, 'SERVICE_UNAVAILABLE')
            : json(200, pageOf([REQUESTED]));
        },
      });
      await user.click(await screen.findByRole('button', { name: /Retry|Try again/ }));
      expect(within(await table()).getByText('ACC-OR-E5VMPB')).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    test: async () => {
      const { user } = open({ [DECIDE]: () => refusal(409, 'STATE_CONFLICT', { rule: 'stale' }) });
      await openFirst(user);
      await user.click(await screen.findByRole('button', { name: 'Approve' }));
      const dialog = within(await screen.findByRole('alertdialog'));
      await user.click(dialog.getByRole('button', { name: 'Yes, approve' }));
      expect(await dialog.findByText(/decided or changed after you opened it/)).toBeVisible();
    },
  },
  success: {
    test: async () => {
      open();
      expect(within(await table()).getByText('ACC-OR-E5VMPB')).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      open({ [LIST]: () => refusal(403, 'PERMISSION_DENIED') });
      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeVisible();
      });
      // No change is drawn for an account the server refuses.
      expect(screen.queryByText('ACC-OR-E5VMPB')).toBeNull();
    },
  },
});
