import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { byHand } from '../../../test-support/by-hand';
import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import {
  approvedFixture,
  EARLIER_REQUEST_ID,
  exceptionFixture,
  exceptionOutcomeFixture,
  OFFICER_ID,
  PICKUP_HUB_ID,
  pickupRequestFixture,
  REQUEST_ID,
} from '../../../test-support/pickup-fixture';
import { pagerRegion } from '../../../test-support/queue-pager';
import { renderApp } from '../../../test-support/render-app';
import { refusal, sessionWith, staffApi } from '../../../test-support/staff-api';
import { cannotText } from '../../../platform/problem/capability-words';

/**
 * `/approvals` (`listPickupRequests` with `one_package_exception_state=REQUESTED`, and `approveOnePackageException`; S1.19): the approver's
 * queue of one-package exceptions. The page asks for the queue the server keeps, says what an approval does before it is made, sends the
 * approval with nothing but the request's id, and decides no maker-checker rule itself: the server's refusal is told as the rule, by the key of
 * whoever can approve instead, never a role. After an approval it shows what the answer said and reads the queue again.
 */
const PATH = '/approvals';
const LIST = 'GET /pickup-requests';
const APPROVE = `POST /pickup-requests/${REQUEST_ID}/one-package-exception/approve`;
const APPROVER = ['pickup.read', 'pickup.exception.approve'];
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;

/** A single package whose exception a colleague asked for, waiting for approval. */
const waiting = pickupRequestFixture({
  declared_package_count: 1,
  one_package_exception: exceptionFixture(),
});

const page = (items: unknown[], next: string | null = null): Response =>
  json(200, { items, next_page_token: next });

let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

function open(
  list: Handler = () => page([waiting]),
  keys: readonly string[] = APPROVER,
  handlers: Record<string, Handler> = {},
) {
  api = installFakeApi(
    staffApi(
      sessionWith(keys, {
        authorized_hubs: [{ id: PICKUP_HUB_ID, display_name: 'Accra Central' }],
      }),
      { [LIST]: list, ...handlers },
    ),
  );
  return renderApp(PATH);
}

/** The table tells a failure in its alert; the reference of the answer follows the sentence in the same text, so the sentence is matched as part of it. */
const alertSaying = async (text: string): Promise<HTMLElement> => {
  await waitFor(() => {
    expect(screen.getByRole('alert')).toHaveTextContent(text);
  });
  return screen.getByRole('alert');
};

/** The rows of requests the table draws: a request's row header is its code. The table's own message (nothing yet, a failure) sits in a cell and is not one. */
const requestRows = () => screen.queryAllByRole('rowheader');

const lists = () =>
  api.requests.filter((request) => new URL(request.url).pathname === '/api/v1/pickup-requests');
const queryOf = (index = -1) => new URL(lists().at(index)?.url ?? 'http://x/').searchParams;
const approvals = () => api.requests.filter((request) => request.method === 'POST');

/** The queue answers with what waits until the approval is made, and with nothing after. */
function queueThatEmpties(): { list: Handler; approve: Handler } {
  let decided = false;
  return {
    list: () => page(decided ? [] : [waiting]),
    approve: () => {
      decided = true;
      return json(200, approvedFixture());
    },
  };
}

async function openApproval(user: ReturnType<typeof renderApp>['user']) {
  await user.click(
    await screen.findByRole('button', { name: 'Approve the exception of ACC-PR-7KQ2MZ' }),
  );
  return screen.getByRole('alertdialog', { name: 'Approve the exception of ACC-PR-7KQ2MZ?' });
}

describe('the queue: what it shows', () => {
  // Break caught (the Product Owner, 9 November 2026): a paragraph of rules above the table, and an empty band left in its place. The rules are in the question of the approval, where the
  // choice is made.
  it('draws no paragraph of rules and no empty band above the table', async () => {
    open();

    await screen.findByRole('rowheader', { name: /^ACC-PR-7KQ2MZ/ });
    expect(document.querySelectorAll('.pickup-form-note')).toHaveLength(0);
    expect(document.querySelectorAll('.ui-queue-workspace__notice')).toHaveLength(0);
    expect(screen.queryByText(/highest tier|the server checks/)).toBeNull();
  });

  it('shows each exception waiting: the request, sender, packages, recipient, why, who asked and when, and the hub', async () => {
    open();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'One-package exceptions to approve' }),
    ).toBeVisible();
    expect(document.title).toBe('One-package exceptions to approve · Melarc Ops Portal');
    const row = (await screen.findByRole('rowheader', { name: /^ACC-PR-7KQ2MZ/ })).closest('tr');
    if (row === null) throw new Error('no row');
    expect(within(row).getByRole('link', { name: 'ACC-PR-7KQ2MZ' })).toHaveAttribute(
      'href',
      `/pickup-requests/${REQUEST_ID}`,
    );
    expect(within(row).getByText('Demo Fabrics Ltd')).toBeVisible();
    expect(within(row).getByText('1 package')).toBeVisible();
    expect(within(row).getByText('Abena Demo')).toBeVisible();
    expect(within(row).getByText('9 Demo Street, Tema')).toBeVisible();
    expect(within(row).getByText('Bridal gown, urgent')).toBeVisible();
    expect(within(row).getByText('Another member of staff')).toBeVisible();
    expect(within(row).getByText('29 Oct, 08:20')).toBeVisible();
    expect(within(row).getByText('Accra Central')).toBeVisible();
    expect(screen.getByText('Showing 1 exception.')).toBeVisible();
    // A request is named by its code, and a person by nothing the read does not give.
    expect(document.body.textContent).not.toContain(REQUEST_ID);
    expect(document.body.textContent).not.toMatch(/9b2e3d4f/);
  });

  // Break caught: the approver's queue read as the whole list, or narrowed by a filter the page made up.
  it('asks the server for the exceptions waiting for approval, and for nothing else', async () => {
    open();

    await screen.findByRole('rowheader', { name: /^ACC-PR-7KQ2MZ/ });
    expect([...queryOf().entries()]).toEqual([['one_package_exception_state', 'REQUESTED']]);
  });

  // Break caught: a queue drawn from a page that is not the approver's (a request with no exception waiting), which would offer an approval
  // the server never asked for.
  it('refuses a page whose requests do not wait on an exception', async () => {
    open(() => page([pickupRequestFixture({ declared_package_count: 1 })]));

    expect(
      (await screen.findAllByText('The exceptions waiting for approval could not be loaded.'))[0],
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
  });

  it('pages by the server’s token, and says more follow', async () => {
    let calls = 0;
    const { user } = open(() => {
      calls += 1;
      return calls === 1
        ? page([waiting], 'next-page')
        : page([
            pickupRequestFixture({
              id: EARLIER_REQUEST_ID,
              code: 'ACC-PR-9WXH4T',
              declared_package_count: 1,
              one_package_exception: exceptionFixture(),
            }),
          ]);
    });

    expect(
      await screen.findByText('Showing 1 exception. More follow on the next page.'),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Next page' }));

    expect(await screen.findByRole('rowheader', { name: /^ACC-PR-9WXH4T/ })).toBeVisible();
    expect(queryOf().get('page_token')).toBe('next-page');
    expect(queryOf().get('one_package_exception_state')).toBe('REQUESTED');
  });

  // Break caught (the review of 499399c): a pager whose button is gone while the next page loads and drops focus on the document, because this queue never asked for the results to take
  // it as the other queues do. Once a page is read, whichever way the person moved, focus is on the results.
  it('puts focus on the results once a page is read, going on and coming back', async () => {
    let calls = 0;
    const other = pickupRequestFixture({
      id: EARLIER_REQUEST_ID,
      code: 'ACC-PR-9WXH4T',
      declared_package_count: 1,
      one_package_exception: exceptionFixture(),
    });
    const { user } = open(() => {
      calls += 1;
      return page([calls === 2 ? other : waiting], calls === 2 ? null : 'next-page');
    });
    const results = () =>
      screen.getByRole('region', { name: 'One-package exceptions waiting for approval' });
    await screen.findByText('Showing 1 exception. More follow on the next page.');

    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByRole('rowheader', { name: /^ACC-PR-9WXH4T/ })).toBeVisible();
    await waitFor(() => {
      expect(results()).toHaveFocus();
    });

    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(await screen.findByRole('rowheader', { name: /^ACC-PR-7KQ2MZ/ })).toBeVisible();
    await waitFor(() => {
      expect(results()).toHaveFocus();
    });
  });

  // Break caught (the review of 499399c): a pager taken out of the page while the next page is read and made anew with its words, which most screen readers do not announce: the status
  // region is the same element through the read, empty while the page is read.
  it('keeps the pager’s status region while the next page is read', async () => {
    const reads = byHand();
    let calls = 0;
    const { user } = open((request) => {
      calls += 1;
      return calls === 1 ? page([waiting], 'next-page') : reads.handler(request);
    });
    await screen.findByText('Showing 1 exception. More follow on the next page.', undefined, {
      timeout: 5000,
    });
    const region = pagerRegion();

    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => {
      expect(region).toBeEmptyDOMElement();
    });
    expect(pagerRegion()).toBe(region);

    await reads.answer(
      page([
        pickupRequestFixture({
          id: EARLIER_REQUEST_ID,
          code: 'ACC-PR-9WXH4T',
          declared_package_count: 1,
          one_package_exception: exceptionFixture(),
        }),
      ]),
    );
    await waitFor(() => {
      expect(region).toHaveTextContent('Showing 1 exception on page 2.');
    });
    expect(pagerRegion()).toBe(region);
  });

  // A page read before a request was cancelled still shows its exception (the server's queue leaves a cancelled request out, AC-QSUM-12);
  // approving it would make a fee due for a pickup that will not happen, so the page shows it with its state and offers no approval.
  it('offers no approval for a request that is no longer waiting for confirmation', async () => {
    open(() =>
      page([
        pickupRequestFixture({
          state: 'CANCELLED',
          declared_package_count: 1,
          one_package_exception: exceptionFixture(),
        }),
      ]),
    );

    const row = (await screen.findByRole('rowheader', { name: /^ACC-PR-7KQ2MZ/ })).closest('tr');
    if (row === null) throw new Error('no row');
    expect(within(row).getByText('Cancelled')).toBeVisible();
    expect(within(row).getByText(/Nothing to approve/)).toBeVisible();
    expect(within(row).queryByRole('button')).toBeNull();
  });
});

describe('approving', () => {
  it('says what an approval does before it is made, and sends nothing when it is not made', async () => {
    const { user } = open();

    const dialog = await openApproval(user);
    expect(within(dialog).getByText(/the single-package pickup fee becomes due/)).toBeVisible();
    expect(within(dialog).getByText(/the request can be confirmed/)).toBeVisible();
    // A fee is named and never stated: the page is not given one.
    expect(dialog.textContent).not.toMatch(/GH₵|\d+\.\d\d/);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(approvals()).toHaveLength(0);
  });

  // The operation takes no body, no version and no key: the request's id is the whole of what is approved.
  it('approves with the request’s id alone, says what the answer said, and the request leaves the queue', async () => {
    const queue = queueThatEmpties();
    const { user } = open(queue.list, APPROVER, { [APPROVE]: queue.approve });

    const dialog = await openApproval(user);
    await user.click(within(dialog).getByRole('button', { name: 'Approve the exception' }));

    expect(
      await screen.findByText(
        'The one-package exception of ACC-PR-7KQ2MZ is approved by you. The request can now be confirmed.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open ACC-PR-7KQ2MZ' })).toHaveAttribute(
      'href',
      `/pickup-requests/${REQUEST_ID}`,
    );
    const [request] = approvals();
    expect(request?.headers.has('If-Match')).toBe(false);
    expect(request?.headers.has('Idempotency-Key')).toBe(false);
    expect(await request?.clone().text()).toBe('');
    // The queue is read again, and the request is no longer in it.
    expect(
      await screen.findByRole('heading', { name: 'No exceptions waiting for approval yet' }),
    ).toBeVisible();
    expect(lists()).toHaveLength(2);
    expect(document.body.textContent).not.toMatch(/GH₵/);
  });

  // Break caught (the review of 499399c): an approval whose queue cannot be read again afterwards, drawn as a failure that takes away the rows the officer was working on, or as if nothing were
  // wrong: the rows stay, under a line that says they may be out of date, with the way to read them again.
  it('keeps the rows, with a line that says so, when the queue cannot be read again after an approval', async () => {
    let reads = 0;
    const { user } = open(
      () => {
        reads += 1;
        if (reads === 2) return refusal(500, 'INTERNAL_ERROR');
        return page(reads === 1 ? [waiting] : []);
      },
      APPROVER,
      { [APPROVE]: () => json(200, approvedFixture()) },
    );

    const dialog = await openApproval(user);
    await user.click(within(dialog).getByRole('button', { name: 'Approve the exception' }));

    const line = (await screen.findByText(/could not be read again/)).parentElement;
    if (line === null) throw new Error('no stale line');
    expect(screen.getByRole('rowheader', { name: /^ACC-PR-7KQ2MZ/ })).toBeVisible();
    expect(screen.queryByText('The pickup requests could not be loaded.')).toBeNull();
    expect(screen.getByText(/ACC-PR-7KQ2MZ is approved by you/)).toBeVisible();

    await user.click(within(line).getByRole('button', { name: 'Refresh' }));
    expect(
      await screen.findByRole('heading', { name: 'No exceptions waiting for approval yet' }),
    ).toBeVisible();
    expect(screen.queryByText(/could not be read again/)).toBeNull();
    expect(reads).toBe(3);
  });

  // permissions.md section 6: the requester may not approve their own exception unless the approval is at the highest tier. The page cannot
  // see tiers, so it says the rule, sends the approval, and tells the server's refusal as the rule, naming the key of who approves instead.
  it('sends the approval of the person’s own exception, and tells the refusal as the rule, by the key', async () => {
    const own = pickupRequestFixture({
      declared_package_count: 1,
      one_package_exception: exceptionFixture({ requested_by: OFFICER_ID }),
    });
    const { user } = open(() => page([own]), APPROVER, {
      [APPROVE]: () => refusal(422, 'SELF_APPROVAL_FORBIDDEN'),
    });

    const row = (await screen.findByRole('rowheader', { name: /^ACC-PR-7KQ2MZ/ })).closest('tr');
    if (row === null) throw new Error('no row');
    expect(within(row).getByText('You')).toBeVisible();
    const dialog = await openApproval(user);
    expect(within(dialog).getByText(/You asked for this exception yourself/)).toBeVisible();
    // Plain words (the Product Owner, 9 November 2026): no tier and no word of what the server does.
    expect(dialog.textContent).not.toMatch(/highest tier|the server/);
    await user.click(within(dialog).getByRole('button', { name: 'Approve the exception' }));

    expect(
      await within(dialog).findByText(
        'You requested this exception yourself, so a different approver has to decide it.',
      ),
    ).toBeVisible();
    expect(approvals()).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/Ops Staff|Senior Ops|Platform Admin/);
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
    // The refusal ends the attempt: the dialog stays, and can be closed.
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  // Break caught: an exception drawn without its requester, whose self-approval notice then never shows, so that an approval of one's own
  // exception looks as eligible as any other. The exception that arrives without it is not staff's, so the queue is refused whole and offers none.
  it('offers no approval for an exception that arrives without who asked for it, and refuses the queue', async () => {
    open(() => page([{ ...waiting, one_package_exception: exceptionOutcomeFixture() }, waiting]));

    await alertSaying('The exceptions waiting for approval could not be loaded.');
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(requestRows()).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
  });

  it('tells a refusal for want of the key by the key', async () => {
    const { user } = open(undefined, APPROVER, {
      [APPROVE]: () => refusal(403, 'PERMISSION_DENIED'),
    });

    const dialog = await openApproval(user);
    await user.click(within(dialog).getByRole('button', { name: 'Approve the exception' }));

    expect(
      await within(dialog).findByText(
        'Your account can’t approve a one-package exception. Ask an administrator for access.',
      ),
    ).toBeVisible();
  });

  // The act takes no key: a lost answer is never sent again blindly, and the way on is to read the queue, where an approved request is gone.
  it('offers only a look at the queue when the answer is lost', async () => {
    const { user } = open(undefined, APPROVER, { [APPROVE]: () => refusal(503, 'INTERNAL') });

    const dialog = await openApproval(user);
    await user.click(within(dialog).getByRole('button', { name: 'Approve the exception' }));

    expect(
      await within(dialog).findByText(/We could not confirm whether this was done/),
    ).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: 'Try again' })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Check the record' }));

    await waitFor(() => {
      expect(lists()).toHaveLength(2);
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(approvals()).toHaveLength(1);
  });

  // Break caught: an answer that is not the approval of this exception (another exception's, or one still waiting) told as done.
  it.each([
    ['still waiting', approvedFixture({ state: 'REQUESTED', approved_by: null })],
    ['of another exception', approvedFixture({ id: '7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e' })],
  ])('does not tell an answer %s as an approval', async (_label, body) => {
    const { user } = open(undefined, APPROVER, { [APPROVE]: () => json(200, body) });

    const dialog = await openApproval(user);
    await user.click(within(dialog).getByRole('button', { name: 'Approve the exception' }));

    expect(
      await within(dialog).findByText(/We could not confirm whether this was done/),
    ).toBeVisible();
    expect(screen.queryByText(/is approved/)).toBeNull();
  });
});

describeInterfaceStates('The exceptions to approve', {
  loading: {
    test: async () => {
      let release: (response: Response) => void = () => undefined;
      const gate = new Promise<Response>((resolve) => {
        release = resolve;
      });
      open(() => gate);
      expect(
        await screen.findByText('Loading exceptions waiting for approval'),
      ).toBeInTheDocument();
      await act(async () => {
        release(page([waiting]));
        await gate;
      });
      expect(await screen.findByRole('rowheader', { name: /^ACC-PR-7KQ2MZ/ })).toBeVisible();
    },
  },
  empty: {
    test: async () => {
      open(() => page([]));
      expect(
        await screen.findByRole('heading', { name: 'No exceptions waiting for approval yet' }),
      ).toBeVisible();
      expect(requestRows()).toHaveLength(0);
    },
  },
  'validation error': {
    inapplicable:
      'The page takes nothing typed: its one filter is fixed by the page, and its one act sends no body.',
  },
  error: {
    test: async () => {
      open(() => refusal(500, 'INTERNAL'));
      await alertSaying('The exceptions waiting for approval could not be loaded.');
      expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const view = open(() => {
        attempts += 1;
        return attempts === 1 ? refusal(503, 'INTERNAL') : page([waiting]);
      });
      await view.user.click(await screen.findByRole('button', { name: 'Retry' }));
      expect(await screen.findByRole('rowheader', { name: /^ACC-PR-7KQ2MZ/ })).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    // Someone else decided the exception meanwhile: the conflict says so, and the queue is read again.
    test: async () => {
      const { user } = open(undefined, APPROVER, {
        [APPROVE]: () => refusal(409, 'STATE_CONFLICT'),
      });
      const dialog = await openApproval(user);
      await user.click(within(dialog).getByRole('button', { name: 'Approve the exception' }));
      expect(
        await within(dialog).findByText(/no longer waiting for approval.*Reload the list/),
      ).toBeVisible();
      await waitFor(() => {
        expect(within(dialog).getByRole('button', { name: 'Reload the record' })).toHaveFocus();
      });
      await user.click(within(dialog).getByRole('button', { name: 'Reload the record' }));
      await waitFor(() => {
        expect(lists()).toHaveLength(2);
      });
      expect(screen.queryByRole('alertdialog')).toBeNull();
    },
  },
  success: {
    test: async () => {
      const queue = queueThatEmpties();
      const { user } = open(queue.list, APPROVER, { [APPROVE]: queue.approve });
      const dialog = await openApproval(user);
      await user.click(within(dialog).getByRole('button', { name: 'Approve the exception' }));
      const notice = (await screen.findByText(/is approved by you/)).closest('.pickup-notice');
      await waitFor(() => {
        expect(notice).toHaveFocus();
      });
    },
  },
  'permission-restricted': {
    // ops-portal.md section 7: forbidden only where the session does not hold the key, which the page tells as what the account cannot do; never the key and never a role.
    test: async () => {
      open(undefined, ['pickup.read', 'pickup.exception.request']);
      expect(
        await screen.findByRole('heading', {
          level: 1,
          name: 'You do not have access to this page',
        }),
      ).toBeVisible();
      expect(screen.getByText(cannotText('pickup.exception.approve'))).toBeVisible();
      expect(screen.getByRole('main').textContent).not.toMatch(
        /Ops Staff|Senior Ops|Platform Admin/,
      );
      expect(lists()).toEqual([]);
    },
  },
});
