import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import {
  approvalFixture,
  exceptionFixture,
  PICKUP_HUB_ID,
  pickupRequestFixture,
  REQUEST_ID,
} from '../../../test-support/pickup-fixture';
import { renderApp } from '../../../test-support/render-app';
import { etag, refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/pickup-requests/{id}/exception` (`requestOnePackageException`; S1.19; AC-SLICE-001-03): the maker's half of the one-package exception,
 * with the recipient's name, phone and delivery address mandatory. The decision belongs to a holder of `pickup.exception.approve`, named by its
 * key and never by a role.
 */
const PATH = `/pickup-requests/${REQUEST_ID}/exception`;
const READ = `GET /pickup-requests/${REQUEST_ID}`;
const ASK = `POST /pickup-requests/${REQUEST_ID}/one-package-exception`;
const MAKER = ['pickup.read', 'pickup.exception.request'];
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;

const single = pickupRequestFixture({ declared_package_count: 1 });

let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

function open(
  read: Handler = () => json(200, single, etag('v1')),
  keys: readonly string[] = MAKER,
  handlers: Record<string, Handler> = {},
) {
  api = installFakeApi(
    staffApi(
      sessionWith(keys, {
        authorized_hubs: [{ id: PICKUP_HUB_ID, display_name: 'Accra Central' }],
      }),
      { [READ]: read, ...handlers },
    ),
  );
  return renderApp(PATH);
}

const asked = () => api.requests.filter((request) => request.method === 'POST');

async function fill(user: ReturnType<typeof renderApp>['user']) {
  await user.type(
    await screen.findByRole('textbox', { name: /Why this single package should be collected/ }),
    'Bridal gown, urgent',
  );
  await user.type(screen.getByRole('textbox', { name: /Recipient’s name/ }), 'Abena Demo');
  await user.type(screen.getByRole('textbox', { name: /Recipient’s phone/ }), '+233 24 000 0000');
  await user.type(screen.getByRole('textbox', { name: /Delivery address/ }), '9 Demo Street, Tema');
}

describe('the exception: asking for it', () => {
  it('names the request and the key that decides, and no role', async () => {
    open();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Request a one-package exception' }),
    ).toBeVisible();
    expect(await screen.findByText('For ACC-PR-7KQ2MZ.')).toBeVisible();
    expect(screen.getByText('pickup.exception.approve')).toBeVisible();
    expect(screen.getByRole('main').textContent).not.toMatch(/Ops Staff|Senior Ops|Platform Admin/);
    // The maker-checker rule is said in plain words, and decided by the server.
    expect(screen.getByText(/Whoever asks for an exception cannot also approve it/)).toBeVisible();
  });

  // §21.1: the recipient's name, phone and delivery address become mandatory, and travel with the exception.
  it('sends the note and the recipient, with no key and no version', async () => {
    const { user } = open(undefined, MAKER, { [ASK]: () => json(201, approvalFixture()) });

    await fill(user);
    await user.type(screen.getByRole('textbox', { name: /Landmark/ }), 'Near the demo clinic');
    await user.click(screen.getByRole('button', { name: 'Request the exception' }));

    const done = (await screen.findByText('The exception is requested')).closest('.pickup-booked');
    if (!(done instanceof HTMLElement)) throw new Error('no news');
    const [request] = asked();
    expect(request?.headers.has('Idempotency-Key')).toBe(false);
    expect(request?.headers.has('If-Match')).toBe(false);
    expect(await request?.clone().json()).toEqual({
      note: 'Bridal gown, urgent',
      recipient: {
        name: 'Abena Demo',
        phone: '+233 24 000 0000',
        location: { address: '9 Demo Street, Tema', landmark: 'Near the demo clinic' },
      },
    });
    expect(within(done).getByRole('link', { name: 'Back to the request' })).toHaveAttribute(
      'href',
      `/pickup-requests/${REQUEST_ID}`,
    );
  });

  it('refuses a request with a recipient missing, on the fields, before anything is sent', async () => {
    const { user } = open();

    await user.click(await screen.findByRole('button', { name: 'Request the exception' }));

    const note = screen.getByRole('textbox', {
      name: /Why this single package should be collected/,
    });
    await waitFor(() => {
      expect(note).toHaveFocus();
    });
    expect(note).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('textbox', { name: /Recipient’s name/ })).toHaveAccessibleDescription(
      'Enter the recipient’s name.',
    );
    expect(screen.getByRole('textbox', { name: /Delivery address/ })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(asked()).toHaveLength(0);
  });

  // The act takes no key and no read shows an exception that was requested: a lost answer is never sent again blindly.
  it('offers no blind retry when the answer is lost, and says to check with an approver', async () => {
    const { user } = open(undefined, MAKER, { [ASK]: () => refusal(503, 'INTERNAL') });

    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Request the exception' }));

    expect(await screen.findByText(/before you send it again/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Request the exception' })).toBeNull();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Check the request' })).toHaveFocus();
    });
  });
});

describe('the exception: when it does not apply', () => {
  it.each([
    ['a confirmed request', { state: 'CONFIRMED' as const }, /waits for confirmation/],
    ['a request of three packages', { declared_package_count: 3 }, /has 3 packages/],
    [
      'a request whose exception is approved',
      { one_package_exception_id: '6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d' },
      /already approved/,
    ],
    // The read now shows an exception that was asked for: it is not asked for twice.
    [
      'a request whose exception waits for approval',
      { one_package_exception: exceptionFixture() },
      /requested on 29 Oct, 08:20, and waits for a holder of pickup\.exception\.approve/,
    ],
  ])('says why for %s, and offers no form', async (_label, change, words) => {
    open(() => json(200, { ...single, ...change }, etag('v1')));

    expect(await screen.findByText(words)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Request the exception' })).toBeNull();
  });

  // A refused exception does not block a new one (requestOnePackageException).
  it('offers the form again after a refused exception, and says so', async () => {
    open(() =>
      json(
        200,
        { ...single, one_package_exception: exceptionFixture({ state: 'REJECTED' }) },
        etag('v1'),
      ),
    );

    expect(
      await screen.findByText(/An earlier exception for this request was refused/),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Request the exception' })).toBeVisible();
  });

  // Break caught: a conflict left with no way on but the same act again.
  it('offers to check the request when the server says one is already waiting', async () => {
    const { user } = open(undefined, MAKER, { [ASK]: () => refusal(409, 'STATE_CONFLICT') });

    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Request the exception' }));

    expect(await screen.findByText(/one is already waiting or approved/)).toBeVisible();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Check the request' })).toHaveFocus();
    });
    expect(screen.queryByRole('button', { name: 'Request the exception' })).toBeNull();
  });
});

describeInterfaceStates('The one-package exception', {
  loading: {
    test: async () => {
      let release: (response: Response) => void = () => undefined;
      const gate = new Promise<Response>((resolve) => {
        release = resolve;
      });
      open(() => gate);
      expect(await screen.findByText('Loading the pickup request…')).toBeInTheDocument();
      await act(async () => {
        release(json(200, single, etag('v1')));
        await gate;
      });
      expect(await screen.findByRole('button', { name: 'Request the exception' })).toBeVisible();
    },
  },
  empty: {
    inapplicable:
      'The page is a form about one request; a request that is not there is the not-found page, and one it does not apply to says why.',
  },
  'validation error': {
    test: async () => {
      const { user } = open(undefined, MAKER, {
        [ASK]: () =>
          refusal(400, 'VALIDATION_FAILED', {
            violations: [{ in: 'body', pointer: '/recipient/phone', rule: 'pattern' }],
          }),
      });
      await fill(user);
      await user.click(screen.getByRole('button', { name: 'Request the exception' }));
      const phone = screen.getByRole('textbox', { name: /Recipient’s phone/ });
      await waitFor(() => {
        expect(phone).toHaveFocus();
      });
      expect(phone).toHaveAccessibleDescription(
        expect.stringContaining('Enter the recipient’s phone number, with the country code.'),
      );
    },
  },
  error: {
    test: async () => {
      open(() => refusal(500, 'INTERNAL'));
      expect(await screen.findByText('This pickup request could not be loaded.')).toBeVisible();
      expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const view = open(() => {
        attempts += 1;
        return attempts === 1 ? refusal(503, 'INTERNAL') : json(200, single, etag('v1'));
      });
      await view.user.click(await screen.findByRole('button', { name: 'Try again' }));
      expect(await screen.findByRole('button', { name: 'Request the exception' })).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    test: async () => {
      // The request moved on under the person (confirmed elsewhere): read again, the page says the exception no longer applies.
      let state: 'PENDING' | 'CONFIRMED' = 'PENDING';
      const { user } = open(() => json(200, { ...single, state }, etag('v1')), MAKER, {
        [ASK]: () => {
          state = 'CONFIRMED';
          return refusal(503, 'INTERNAL');
        },
      });
      await fill(user);
      await user.click(screen.getByRole('button', { name: 'Request the exception' }));
      await user.click(await screen.findByRole('button', { name: 'Check the request' }));
      expect(await screen.findByText(/waits for confirmation/)).toBeVisible();
    },
  },
  success: {
    test: async () => {
      const { user } = open(undefined, MAKER, { [ASK]: () => json(201, approvalFixture()) });
      await fill(user);
      await user.click(screen.getByRole('button', { name: 'Request the exception' }));
      const done = (await screen.findByText('The exception is requested')).closest(
        '.pickup-booked',
      );
      await waitFor(() => {
        expect(done).toHaveFocus();
      });
      expect(within(done as HTMLElement).getByText(/stays pending until then/)).toBeVisible();
    },
  },
  'permission-restricted': {
    // ops-portal.md section 7: the refusal reads as who decides, by the key (pickup.exception.approve), and not as "you lack access".
    test: async () => {
      open(undefined, ['pickup.read']);
      expect(
        await screen.findByRole('heading', { level: 1, name: 'Approval is needed' }),
      ).toBeVisible();
      expect(screen.getByText('pickup.exception.approve')).toBeVisible();
      expect(screen.getByRole('main').textContent).not.toMatch(
        /do not have access|Ops Staff|Senior Ops|Platform Admin/,
      );
      expect(screen.queryByRole('button', { name: 'Request the exception' })).toBeNull();
      expect(api.requests.filter((request) => request.url.includes('/pickup-requests/'))).toEqual(
        [],
      );
    },
  },
});
