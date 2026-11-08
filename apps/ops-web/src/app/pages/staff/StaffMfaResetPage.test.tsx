import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi } from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import { reasonFixture } from '../../../test-support/reason-fixture';
import { renderApp } from '../../../test-support/render-app';
import { etag, KEYS, refusal, sessionWith, staffApi } from '../../../test-support/staff-api';
import { HUB_ID, STAFF_ID, staffIdentityFixture } from '../../../test-support/staff-fixture';
import { wcagViolations } from '../../../test-support/wcag';

let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

const PATH = `/admin/staff/${STAFF_ID}/mfa/reset`;
const RECORD = `GET /staff-identities/${STAFF_ID}`;
const RESET = `POST /ops/staff/${STAFF_ID}/mfa/reset`;
const REASONS = 'GET /reason-definitions';
const DIAGNOSTIC = /Diagnostic text that must never reach a screen/;
const ME = '8a1d2c3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';

const withFactor = staffIdentityFixture({
  status: 'ACTIVE',
  mfa_enrolled: true,
  mfa_reset_state: 'FACTOR_ACTIVE',
});
const unfinished = staffIdentityFixture({
  status: 'ACTIVE',
  mfa_enrolled: false,
  mfa_reset_state: 'ENROLMENT_UNFINISHED',
});
const ineligible = staffIdentityFixture({ status: 'ACTIVE', mfa_reset_state: 'NOT_ELIGIBLE' });

const reasons = () =>
  json(200, [
    reasonFixture({
      code: 'PHONE_LOST',
      label: 'The phone was lost',
      permittedOperations: [{ operationId: 'resetStaffMfa', branch: 'FACTOR_ACTIVE' }],
    }),
  ]);

function open(
  keys: readonly string[] = KEYS.everything,
  handlers: Record<string, () => Response | Promise<Response>> = {},
  path = PATH,
  principalId = ME,
) {
  api = installFakeApi(
    staffApi(
      sessionWith(keys, {
        principal_id: principalId,
        authorized_hubs: [{ id: HUB_ID, display_name: 'Accra Central' }],
      }),
      {
        [RECORD]: () => json(200, withFactor, etag('v1')),
        [REASONS]: reasons,
        ...handlers,
      },
    ),
  );
  return renderApp(path);
}

const posts = () => api.requests.filter((request) => request.method === 'POST');
const heading = (name: string) => screen.findByRole('heading', { level: 1, name });
const reasonRequests = () =>
  api.requests.filter((request) => request.url.includes('/reason-definitions'));

async function reset(view: ReturnType<typeof open>) {
  await view.user.click(await screen.findByRole('button', { name: 'Reset authenticator' }));
  const dialog = screen.getByRole('alertdialog', {
    name: 'Reset the authenticator of Kofi Boateng?',
  });
  await view.user.selectOptions(
    await within(dialog).findByRole('combobox', { name: 'Reason (required)' }),
    'PHONE_LOST',
  );
  await view.user.click(within(dialog).getByRole('button', { name: 'Reset authenticator' }));
}

describe('the reset of an authenticator: what it shows', () => {
  it('names the page and the person, and links back to the profile', async () => {
    open();

    expect(await heading('Reset authenticator')).toBeVisible();
    expect(await screen.findByText('Kofi Boateng')).toBeVisible();
    expect(document.title).toBe('Reset authenticator · Melarc Ops Portal');
    expect(screen.getByRole('link', { name: 'Back to profile' })).toHaveAttribute(
      'href',
      `/admin/staff/${STAFF_ID}`,
    );
  });

  it('says plainly what a reset does, and that the person sets up the new one themselves', async () => {
    open();

    expect(
      await screen.findByText(
        /Kofi Boateng’s authenticator stops working, every session of theirs ends, and a link to set up a new one is sent to kofi\.boateng@example\.test\. You will not see the link: Kofi Boateng sets it up themselves\./,
      ),
    ).toBeVisible();
  });

  it('says what it means to reset a set-up that was not finished', async () => {
    open(KEYS.everything, { [RECORD]: () => json(200, unfinished, etag('v1')) });

    expect(
      await screen.findByText(
        /Kofi Boateng started setting up an authenticator and did not finish\. The unfinished set-up is cancelled, any session of theirs ends, and a new link is sent to kofi\.boateng@example\.test\./,
      ),
    ).toBeVisible();
  });

  // Break caught (ops-portal.md section 7): the action offered for a profile it cannot be done to.
  it('hides the action for a profile that cannot have its authenticator reset, and says why', async () => {
    open(KEYS.everything, { [RECORD]: () => json(200, ineligible, etag('v1')) });

    expect(
      await screen.findByText(
        'An authenticator can be reset only for a profile that has one, or whose set-up was started and not finished.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Reset authenticator' })).toBeNull();
    expect(reasonRequests()).toHaveLength(0);
  });

  it('says a person cannot reset their own authenticator, and offers no button', async () => {
    open(KEYS.everything, {}, PATH, STAFF_ID);

    expect(
      await screen.findByText(
        'You cannot reset your own authenticator. Another Platform Admin has to do it.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Reset authenticator' })).toBeNull();
  });
});

describe('the reset of an authenticator: the act', () => {
  it('asks for the reasons of this branch only, once the dialog is opened and not before', async () => {
    const view = open();
    await view.user.click(await screen.findByRole('button', { name: 'Reset authenticator' }));
    await screen.findByRole('combobox', { name: 'Reason (required)' });

    const url = new URL(reasonRequests()[0]?.url ?? 'http://x');
    expect(url.searchParams.get('operation')).toBe('resetStaffMfa');
    expect(url.searchParams.get('branch')).toBe('FACTOR_ACTIVE');
  });

  it('asks for the reasons of the unfinished branch for an unfinished set-up', async () => {
    const view = open(KEYS.everything, { [RECORD]: () => json(200, unfinished, etag('v1')) });
    await view.user.click(await screen.findByRole('button', { name: 'Reset authenticator' }));
    await screen.findByRole('combobox', { name: 'Reason (required)' });

    expect(new URL(reasonRequests()[0]?.url ?? 'http://x').searchParams.get('branch')).toBe(
      'ENROLMENT_UNFINISHED',
    );
  });

  it('asks in the dialog, in the danger treatment, and says what ends', async () => {
    const view = open();
    await view.user.click(await screen.findByRole('button', { name: 'Reset authenticator' }));

    const dialog = screen.getByRole('alertdialog', {
      name: 'Reset the authenticator of Kofi Boateng?',
    });
    expect(dialog).toHaveAccessibleDescription(
      /Every session of Kofi Boateng ends\. This cannot be undone\./,
    );
    expect(within(dialog).getByRole('button', { name: 'Reset authenticator' })).toHaveClass(
      'ui-button--danger',
    );
  });

  it('sends the reason with the version it read, and no key, because the version is the guard', async () => {
    const view = open(KEYS.everything, {
      [RESET]: () => json(200, { sessions_terminated: 2, reenrolment_grant_issued: true }),
    });

    await reset(view);

    await waitFor(() => {
      expect(posts()).toHaveLength(1);
    });
    const [request] = posts();
    expect(request?.headers.get('If-Match')).toBe('"v1"');
    expect(request?.headers.has('Idempotency-Key')).toBe(false);
    expect(await request?.json()).toEqual({ reason_code: 'PHONE_LOST' });
  });

  it('sends the note as it was typed', async () => {
    const view = open(KEYS.everything, {
      [RESET]: () => json(200, { sessions_terminated: 1, reenrolment_grant_issued: true }),
    });
    await view.user.click(await screen.findByRole('button', { name: 'Reset authenticator' }));
    const dialog = screen.getByRole('alertdialog');
    await view.user.selectOptions(
      await within(dialog).findByRole('combobox', { name: 'Reason (required)' }),
      'PHONE_LOST',
    );
    await view.user.click(within(dialog).getByRole('textbox', { name: 'Note' }));
    await view.user.paste('Verified in person.');
    await view.user.click(within(dialog).getByRole('button', { name: 'Reset authenticator' }));

    await waitFor(() => {
      expect(posts()).toHaveLength(1);
    });
    expect(await posts()[0]?.json()).toEqual({
      reason_code: 'PHONE_LOST',
      note: 'Verified in person.',
    });
  });

  it('says the authenticator is reset, how many sessions ended, and where the link went', async () => {
    const view = open(KEYS.everything, {
      [RESET]: () =>
        json(200, {
          sessions_terminated: 2,
          reenrolment_grant_issued: true,
          grant_expires_at: '2026-10-23T08:30:00Z',
        }),
    });

    await reset(view);

    expect(await screen.findByRole('heading', { name: 'Authenticator reset' })).toBeVisible();
    expect(screen.getByText('2 sessions were ended.')).toBeVisible();
    expect(
      screen.getByText(
        'A link to set up a new authenticator is on its way to kofi.boateng@example.test. It works until 23 Oct, 08:30.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Reset authenticator' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to profile' })).toBeVisible();
  });

  it('says it in the singular, and says when no session was open', async () => {
    const one = open(KEYS.everything, {
      [RESET]: () => json(200, { sessions_terminated: 1, reenrolment_grant_issued: true }),
    });
    await reset(one);
    expect(await screen.findByText('1 session was ended.')).toBeVisible();
    one.unmount();
    api.restore();

    const none = open(KEYS.everything, {
      [RESET]: () => json(200, { sessions_terminated: 0, reenrolment_grant_issued: true }),
    });
    await reset(none);
    expect(await screen.findByText('No session was open.')).toBeVisible();
  });

  // Break caught: a repeated request, answered by the existing grant's metadata, told as "a new link was sent".
  it('says nothing new was sent when a link was already on its way', async () => {
    const view = open(KEYS.everything, {
      [RESET]: () =>
        json(200, {
          sessions_terminated: 0,
          reenrolment_grant_issued: false,
          coalesced: true,
          grant_expires_at: '2026-10-23T08:30:00Z',
        }),
    });

    await reset(view);

    expect(
      await screen.findByText(
        'Nothing new was sent. A link to set up a new authenticator was already on its way to kofi.boateng@example.test. It works until 23 Oct, 08:30.',
      ),
    ).toBeVisible();
  });

  // Break caught (ops-portal.md section 7): the re-enrolment grant shown to the administrator who reset the factor. Whatever the server sends,
  // the screen has nowhere to put it.
  it('shows no grant, token or link, even if the server sent one', async () => {
    const view = open(KEYS.everything, {
      [RESET]: () =>
        json(200, {
          sessions_terminated: 1,
          reenrolment_grant_issued: true,
          setup_token: 'SECRET-TOKEN',
          mfa_setup_token: 'SECRET-TOKEN',
          link: 'https://example.test/setup/mfa#token=SECRET-TOKEN',
        }),
    });

    await reset(view);
    await screen.findByRole('heading', { name: 'Authenticator reset' });

    expect(document.body.textContent).not.toContain('SECRET');
    expect(document.querySelector('input, textarea, [contenteditable="true"], code')).toBeNull();
    expect(document.querySelector('a[href*="SECRET"], a[href*="token"]')).toBeNull();
    expect(document.querySelector('canvas, svg[data-qr], [data-qr]')).toBeNull();
  });
});

describe('the reset of an authenticator: a refusal', () => {
  async function refuseWith(status: number, code: string) {
    const view = open(KEYS.everything, { [RESET]: () => refusal(status, code) });
    await reset(view);
    return view;
  }

  it.each([
    [
      'SELF_APPROVAL_FORBIDDEN',
      422,
      'You cannot reset your own authenticator. Another Platform Admin has to do it.',
    ],
    [
      'PERMISSION_DENIED',
      403,
      'Your session does not hold the permission to reset authenticators (staff.mfa.reset).',
    ],
    [
      'CREDENTIAL_DELIVERY_FAILED',
      422,
      'Nothing was changed. The message channel is not available yet, so the link could not be sent. You can try again once it is.',
    ],
  ])('tells %s in its own words and keeps the dialog', async (code, status, message) => {
    await refuseWith(status, code);

    expect(await within(screen.getByRole('alertdialog')).findByRole('alert')).toHaveTextContent(
      message,
    );
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
  });

  // Break caught (ops-portal.md section 7, stale/conflict): a reset on a record that moved, or a conflict that leaves the old state on screen.
  it('says the record changed or cannot be reset as it stands, and reads it again', async () => {
    let count = 0;
    const view = open(KEYS.everything, {
      [RECORD]: () => {
        count += 1;
        return count === 1 ? json(200, withFactor, etag('v1')) : json(200, ineligible, etag('v3'));
      },
      [RESET]: () => refusal(409, 'STATE_CONFLICT'),
    });
    await reset(view);

    expect(
      await screen.findByText(
        /changed after you opened it, or its authenticator cannot be reset as it stands/,
      ),
    ).toBeVisible();
    await view.user.click(screen.getByRole('button', { name: 'Reload the record' }));

    expect(
      await screen.findByText(
        'An authenticator can be reset only for a profile that has one, or whose set-up was started and not finished.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('says the outcome is not known when the answer is lost, and offers the record and not a second reset', async () => {
    const view = open(KEYS.everything, {
      [RESET]: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await reset(view);

    expect(await screen.findByText(/could not confirm whether this was done/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Check the record' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(posts()).toHaveLength(1);
  });

  // Break caught: an answer that is not a reset taken for one, which would tell an administrator the factor is gone when it may not be.
  it('does not say it is done for an answer that is not a reset', async () => {
    const view = open(KEYS.everything, { [RESET]: () => json(200, { surprise: true }) });
    await reset(view);

    expect(await screen.findByText(/could not confirm whether this was done/i)).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Authenticator reset' })).toBeNull();
  });
});

describe('the reset of an authenticator: when it cannot be had', () => {
  it('names staff.mfa.reset for a session that does not hold it, and reads nothing', async () => {
    open(KEYS.approver);

    expect(await heading('You do not have access to this page')).toBeVisible();
    expect(screen.getByText('staff.mfa.reset')).toBeVisible();
    expect(api.requests.filter((request) => request.url.includes('staff-identities'))).toHaveLength(
      0,
    );
  });

  it('says a profile that does not exist is not there, as a page of its own', async () => {
    open(KEYS.everything, { [RECORD]: () => refusal(404, 'NOT_FOUND') });

    expect(await heading('Profile not found')).toBeVisible();
  });

  it('says a profile in a hub the session does not act in is outside its hubs, as a page of its own', async () => {
    open(KEYS.everything, { [RECORD]: () => refusal(403, 'HUB_SCOPE_VIOLATION') });

    expect(await heading('This is outside your hubs')).toBeVisible();
  });

  it('says a profile whose address is not an id is not there, without asking the server', async () => {
    open(KEYS.everything, {}, '/admin/staff/nope/mfa/reset');

    expect(await heading('Profile not found')).toBeVisible();
    expect(api.requests.filter((request) => request.url.includes('staff-identities'))).toHaveLength(
      0,
    );
  });

  it('says it could not load, with a retry', async () => {
    let answers = 0;
    const view = open(KEYS.everything, {
      [RECORD]: () => {
        answers += 1;
        return answers === 1 ? refusal(500, 'INTERNAL_ERROR') : json(200, withFactor, etag('v1'));
      },
    });

    expect(await screen.findByText('This profile could not be loaded.')).toBeVisible();
    await view.user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('button', { name: 'Reset authenticator' })).toBeVisible();
  });
});

describe('the reset of an authenticator: the session', () => {
  // Break caught: an act reported as done, or an error shown, to a person whose session has ended: the boundary has taken them away.
  it('goes to sign-in, and says nothing about the reset, when the session ended during it', async () => {
    const view = open(KEYS.everything, { [RESET]: () => refusal(401, 'SESSION_INVALID') });

    await reset(view);

    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Authenticator reset' })).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.body.textContent).not.toContain('Kofi Boateng');
  });
});

describeInterfaceStates('The reset of an authenticator', {
  loading: {
    test: async () => {
      open(KEYS.everything, { [RECORD]: () => new Promise<Response>(() => undefined) });

      expect(await heading('Reset authenticator')).toBeVisible();
      expect(await screen.findByText('Loading the profile…')).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Reset authenticator' })).toBeNull();
    },
  },
  empty: {
    inapplicable:
      'The page is one act on one record, not a list: a profile that cannot have its authenticator reset is its own state, tested above.',
  },
  'validation error': {
    test: async () => {
      const view = open();
      await view.user.click(await screen.findByRole('button', { name: 'Reset authenticator' }));
      const dialog = screen.getByRole('alertdialog');
      await within(dialog).findByRole('combobox', { name: 'Reason (required)' });

      await view.user.click(within(dialog).getByRole('button', { name: 'Reset authenticator' }));

      expect(within(dialog).getByRole('combobox', { name: 'Reason (required)' })).toHaveAttribute(
        'aria-invalid',
        'true',
      );
      expect(posts()).toHaveLength(0);
    },
  },
  error: {
    test: async () => {
      open(KEYS.everything, { [RECORD]: () => refusal(500, 'INTERNAL_ERROR') });

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'This profile could not be loaded.',
      );
    },
  },
  retry: {
    test: async () => {
      let answers = 0;
      const view = open(KEYS.everything, {
        [RECORD]: () => {
          answers += 1;
          return answers === 1 ? refusal(500, 'INTERNAL_ERROR') : json(200, withFactor, etag('v1'));
        },
      });

      await view.user.click(await screen.findByRole('button', { name: 'Try again' }));

      expect(await screen.findByRole('button', { name: 'Reset authenticator' })).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    test: async () => {
      const view = open(KEYS.everything, { [RESET]: () => refusal(409, 'STATE_CONFLICT') });
      await reset(view);

      expect(await screen.findByRole('button', { name: 'Reload the record' })).toBeVisible();
    },
  },
  success: {
    test: async () => {
      const view = open(KEYS.everything, {
        [RESET]: () => json(200, { sessions_terminated: 1, reenrolment_grant_issued: true }),
      });
      await reset(view);

      expect(await screen.findByRole('heading', { name: 'Authenticator reset' })).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      open(KEYS.approver);

      expect(await heading('You do not have access to this page')).toBeVisible();
    },
  },
});

describe('the reset of an authenticator: accessibility', () => {
  it('has no WCAG violations that can be checked without a layout engine, in its states', async () => {
    const view = open();
    await screen.findByRole('button', { name: 'Reset authenticator' });
    expect(await wcagViolations(view.container)).toEqual([]);
    await view.user.click(screen.getByRole('button', { name: 'Reset authenticator' }));
    expect(await wcagViolations(view.container)).toEqual([]);
    view.unmount();
    api.restore();

    const done = open(KEYS.everything, {
      [RESET]: () => json(200, { sessions_terminated: 1, reenrolment_grant_issued: true }),
    });
    await reset(done);
    await screen.findByRole('heading', { name: 'Authenticator reset' });
    expect(await wcagViolations(done.container)).toEqual([]);
  });
});
