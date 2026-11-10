import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { narrowRoom, restoreRoom } from '../../../test-support/narrow-room';

import { installFakeApi, json, type FakeApi } from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import { reasonFixture } from '../../../test-support/reason-fixture';
import { renderApp } from '../../../test-support/render-app';
import {
  bundlesAnswer,
  etag,
  KEYS,
  refusal,
  sessionWith,
  staffApi,
} from '../../../test-support/staff-api';
import {
  BUNDLE_ID,
  HUB_ID,
  MAKER_ID,
  PRIVILEGED_BUNDLE_ID,
  STAFF_ID,
  staffIdentityFixture,
  trustedBrowserFixture,
} from '../../../test-support/staff-fixture';
import { wcagViolations } from '../../../test-support/wcag';
import { cannotText } from '../../../platform/problem/capability-words';

let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
  restoreRoom();
});

const RECORD = `GET /staff-identities/${STAFF_ID}`;
const BUNDLES = 'GET /staff-role-bundles/assignable';
const APPROVE = `POST /staff-identities/${STAFF_ID}/approve`;
const REISSUE = `POST /ops/staff/${STAFF_ID}/credential/setup/reissue`;
const REASONS = 'GET /reason-definitions';
const BROWSERS = `GET /ops/staff/${STAFF_ID}/trusted-browsers`;
const REMOVE_BROWSERS = `POST /ops/staff/${STAFF_ID}/trusted-browsers/revoke`;
const DIAGNOSTIC = /Diagnostic text that must never reach a screen/;
const ME = '8a1d2c3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';

const pending = staffIdentityFixture();
const active = staffIdentityFixture({ status: 'ACTIVE', approved_by: ME });

const rejectReasons = () =>
  json(200, [
    reasonFixture({
      code: 'NOT_A_REAL_HIRE',
      label: 'Not a real hire',
      permittedOperations: [{ operationId: 'approveStaffIdentity', branch: 'APPROVAL_REJECTED' }],
    }),
  ]);
const reissueReasons = () =>
  json(200, [
    reasonFixture({
      code: 'EMAIL_LOST',
      label: 'The first email was lost',
      permittedOperations: [{ operationId: 'reissueStaffCredentialSetup', branch: null }],
    }),
  ]);

function open(
  keys: readonly string[] = KEYS.approver,
  handlers: Record<string, () => Response | Promise<Response>> = {},
  path = `/admin/staff/${STAFF_ID}`,
  principalId = ME,
) {
  api = installFakeApi(
    staffApi(
      sessionWith(keys, {
        principal_id: principalId,
        authorized_hubs: [{ id: HUB_ID, display_name: 'Accra Central' }],
      }),
      {
        [RECORD]: () => json(200, pending, etag('v1')),
        [BUNDLES]: bundlesAnswer,
        // The trusted browsers of an enrolled profile are read for a person who holds the key that ends standing access.
        [BROWSERS]: () => json(200, { items: [] }),
        ...handlers,
      },
    ),
  );
  return renderApp(path);
}

/** What the row of acts in the record's header holds, in the order they are drawn: the names of its buttons and links. `undefined` when no row is drawn. */
function headerActs(): string[] | undefined {
  const row = document.querySelector('.ui-record-header__actions');
  return row === null
    ? undefined
    : Array.from(row.querySelectorAll('a, button'), (each) => each.textContent);
}

const posts = () => api.requests.filter((request) => request.method === 'POST');
const reads = () =>
  api.requests.filter((request) => request.url.endsWith(`/staff-identities/${STAFF_ID}`));
const heading = (name: string) => screen.findByRole('heading', { level: 1, name });

describe('the profile: what it shows', () => {
  it('names the person as the page, with the title, and the email under it', async () => {
    open();

    // The first query of a file pays for the page's first render; a text query is the cheap way to wait for it.
    await screen.findByText('Kofi Boateng', { selector: 'h1' });
    expect(screen.getByRole('heading', { level: 1, name: 'Kofi Boateng' })).toBeVisible();
    expect(document.title).toBe('Kofi Boateng · Melarc Ops Portal');
    expect(screen.getByRole('link', { name: 'Back to staff' })).toHaveAttribute(
      'href',
      '/admin/staff',
    );
  });

  it('shows the facts of the profile in words', async () => {
    open();
    await heading('Kofi Boateng');
    await screen.findByText('Role');

    expect(screen.getByText('Work email').nextElementSibling).toHaveTextContent(
      'kofi.boateng@example.test',
    );
    expect(screen.getByText('Phone').nextElementSibling).toHaveTextContent('+233240000000');
    expect(screen.getByText('Role').nextElementSibling).toHaveTextContent('Ops Staff');
    expect(screen.getByText('Hub').nextElementSibling).toHaveTextContent('Accra Central');
  });

  // Break caught: an id or a stored value shown where a name or a word was owed.
  it('shows no id and no stored value', async () => {
    open();
    await heading('Kofi Boateng');

    expect(document.body.textContent).not.toContain(BUNDLE_ID);
    expect(document.body.textContent).not.toContain(HUB_ID);
    expect(document.body.textContent).not.toMatch(/PENDING_APPROVAL|NOT_ELIGIBLE|mfa_/);
  });

  it('says "Not given" for a phone number nobody gave, and "No hub" for no hub', async () => {
    open(KEYS.approver, {
      [RECORD]: () =>
        json(200, staffIdentityFixture({ phone: null, primary_hub_id: null }), etag('v1')),
    });
    await heading('Kofi Boateng');

    expect(screen.getByText('Phone').nextElementSibling).toHaveTextContent('Not given');
    expect(screen.getByText('Hub').nextElementSibling).toHaveTextContent('No hub');
  });

  it('leaves the role out when the session cannot read the roles, rather than showing "Another role"', async () => {
    open(KEYS.reader);
    await heading('Kofi Boateng');

    expect(screen.queryByText('Role')).toBeNull();
    expect(screen.queryByText('Another role')).toBeNull();
  });

  it.each([
    ['PENDING_APPROVAL', 'Waiting for approval', /cannot sign in until this profile is approved/],
    ['ACTIVE', 'Active', /approved and in use/],
    ['REJECTED', 'Rejected', /cannot be used, and its email address can be used for a new profile/],
    ['SUSPENDED', 'Suspended', /cannot sign in until the suspension is lifted/],
    ['OFFBOARDED', 'Offboarded', /closed and cannot be used/],
  ] as const)('says what a status of %s means', async (status, label, sentence) => {
    open(KEYS.reader, { [RECORD]: () => json(200, staffIdentityFixture({ status }), etag('v1')) });
    await heading('Kofi Boateng');

    expect(screen.getByText(label, { selector: '.ui-status-badge' })).toBeVisible();
    expect(screen.getByText(sentence)).toBeVisible();
  });

  it('shows the authenticator only for a profile that has or had one', async () => {
    const plain = open(KEYS.reader);
    await heading('Kofi Boateng');
    expect(screen.queryByText('Authenticator')).toBeNull();
    plain.unmount();
    api.restore();

    open(KEYS.reader, {
      [RECORD]: () =>
        json(
          200,
          staffIdentityFixture({ mfa_enrolled: true, mfa_reset_state: 'FACTOR_ACTIVE' }),
          etag('v1'),
        ),
    });
    await heading('Kofi Boateng');
    expect(screen.getByText('Authenticator').nextElementSibling).toHaveTextContent('Set up');
  });

  it('says an unfinished set-up is unfinished', async () => {
    open(KEYS.reader, {
      [RECORD]: () =>
        json(200, staffIdentityFixture({ mfa_reset_state: 'ENROLMENT_UNFINISHED' }), etag('v1')),
    });
    await heading('Kofi Boateng');

    expect(screen.getByText('Authenticator').nextElementSibling).toHaveTextContent(
      'Set-up not finished',
    );
  });

  // Break caught (ops-portal.md section 7: "the new credential and every link are never displayed"): a page with anywhere to show one.
  it('has no field, link or text that could show a credential, even if the server sent one', async () => {
    open(KEYS.everything, {
      [RECORD]: () =>
        json(
          200,
          { ...pending, password_hash: 'SECRET-HASH', setup_token: 'SECRET-TOKEN' },
          etag('v1'),
        ),
    });
    await heading('Kofi Boateng');

    expect(document.body.textContent).not.toContain('SECRET');
    expect(document.querySelector('input')).toBeNull();
    expect(document.querySelector('a[href*="token"]')).toBeNull();
  });
});

describe('the profile: the version it acts on', () => {
  it('reads the profile once and asks for nothing else of the server it does not need', async () => {
    open(KEYS.reader);
    await heading('Kofi Boateng');

    expect(reads()).toHaveLength(1);
    expect(api.requests.some((request) => request.url.includes('/reason-definitions'))).toBe(false);
  });

  // Break caught: a profile with no version being acted on, which would send an If-Match the server never gave.
  it('treats a profile with no version as an answer that is not the API’s', async () => {
    open(KEYS.approver, { [RECORD]: () => json(200, pending) });

    expect(await screen.findByText('This profile could not be loaded.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Approve profile' })).toBeNull();
  });

  // Break caught: the record of another person shown for this address.
  it('treats the profile of another person than the one asked for as an answer that is not the API’s', async () => {
    open(KEYS.approver, {
      [RECORD]: () =>
        json(200, staffIdentityFixture({ id: '99999999-2222-4333-8444-555555555555' }), etag('v1')),
    });

    expect(await screen.findByText('This profile could not be loaded.')).toBeVisible();
  });
});

describe('the profile: when it cannot be had', () => {
  it('says a profile that does not exist is not there, as a page of its own', async () => {
    open(KEYS.approver, { [RECORD]: () => refusal(404, 'NOT_FOUND') });

    expect(await heading('Profile not found')).toBeVisible();
    expect(
      screen.getByText(/could not be found\. It may have been removed, or the link may be wrong\./),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to staff' })).toBeVisible();
  });

  // Break caught: a profile in another hub and a profile that is not there told alike (ops-portal.md section 7: two full-page states).
  it('says a profile in a hub the session does not act in is outside its hubs, as a page of its own', async () => {
    open(KEYS.approver, { [RECORD]: () => refusal(403, 'HUB_SCOPE_VIOLATION') });

    expect(await heading('This is outside your hubs')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Profile not found' })).toBeNull();
  });

  it('names staff.read when the server refuses the key, as a page of its own', async () => {
    open(KEYS.approver, { [RECORD]: () => refusal(403, 'PERMISSION_DENIED') });

    expect(await heading('You do not have access to this page')).toBeVisible();
    expect(screen.getByText(cannotText('staff.read'))).toBeVisible();
  });

  // Break caught: an address that is not an id sent to the server.
  it('says a profile whose address is not an id is not there, without asking the server', async () => {
    open(KEYS.approver, {}, '/admin/staff/not-an-id');

    expect(await heading('Profile not found')).toBeVisible();
    expect(api.requests.filter((request) => request.url.includes('staff-identities'))).toHaveLength(
      0,
    );
  });

  it('says it could not load, in approved words, with a retry', async () => {
    let answers = 0;
    const view = open(KEYS.approver, {
      [RECORD]: () => {
        answers += 1;
        return answers === 1 ? refusal(500, 'INTERNAL_ERROR') : json(200, pending, etag('v1'));
      },
    });

    expect(await screen.findByText('This profile could not be loaded.')).toBeVisible();
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
    await view.user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await heading('Kofi Boateng')).toBeVisible();
  });
});

describe('the profile: where focus is', () => {
  // Break caught (found in a real browser): the heading replaced when the profile arrives, so that the focus the frame put on it falls to the
  // top of the document and a screen reader says nothing about the page that has just appeared. The record page template draws the person's name as its own heading (the
  // one that stood while the profile was read is gone), so the claim is that focus is on the heading that replaces it.
  it('puts focus on the heading that replaces the loading one when the profile arrives', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    open(KEYS.reader, {
      [RECORD]: async () => {
        await held;
        return json(200, pending, etag('v1'));
      },
    });
    const loading = await heading('Staff profile');
    // The frame puts focus on a page's heading when the address changes; here the page is the first one, so the test does the same.
    loading.focus();
    expect(loading).toHaveFocus();

    release();

    const named = await heading('Kofi Boateng');
    expect(named).toHaveFocus();
  });

  it('moves to the page that replaces it when the profile turns out not to be there', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    open(KEYS.reader, {
      [RECORD]: async () => {
        await held;
        return refusal(404, 'NOT_FOUND');
      },
    });
    await heading('Staff profile');

    release();

    expect(await heading('Profile not found')).toHaveFocus();
  });

  it('moves to the page of a profile outside the hubs, too', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    open(KEYS.reader, {
      [RECORD]: async () => {
        await held;
        return refusal(403, 'HUB_SCOPE_VIOLATION');
      },
    });
    await heading('Staff profile');

    release();

    expect(await heading('This is outside your hubs')).toHaveFocus();
  });
});

describe('the profile: who may decide', () => {
  it('offers to approve or reject a profile that waits, to a person who can decide on it', async () => {
    open();

    expect(await screen.findByRole('button', { name: 'Approve profile' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reject profile' })).toBeVisible();
  });

  // Break caught (11.6; the owner's decision of 25 October 2026): the maker kept from the buttons for their own work, so that a Platform
  // Admin has to ask a colleague. The session lists permission keys and no tiers, so the page cannot tell a Platform Admin from another
  // maker: it offers the acts, says plainly who may use them, and the server refuses anyone else (SELF_APPROVAL_FORBIDDEN, told below).
  it('offers the maker the acts on their own profile, and says that only a Platform Admin may use them', async () => {
    open(KEYS.approver, {}, undefined, MAKER_ID);

    // One short muted line under the acts, in the header (the Product Owner, 9 November 2026), and not a paragraph above the content.
    expect(
      await screen.findByText(
        'You created this profile. A Platform Admin can approve or reject a profile they made; anyone else needs a different person to.',
      ),
    ).toHaveClass('ui-record-header__note');
    expect(screen.getByRole('button', { name: 'Approve profile' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reject profile' })).toBeVisible();
  });

  it('does not tell a person who did not make the profile that they made it', async () => {
    open();

    await screen.findByRole('button', { name: 'Approve profile' });
    expect(screen.queryByText(/You created this profile/)).toBeNull();
  });

  it('names the permission, and offers no button, to a person who lacks it', async () => {
    open(KEYS.reader);
    await heading('Kofi Boateng');

    expect(screen.getByText(cannotText('staff.identity.approve'))).toHaveClass(
      'ui-record-header__note',
    );
    expect(screen.queryByRole('button', { name: 'Approve profile' })).toBeNull();
  });

  it('says a role that needs a Platform Admin needs one', async () => {
    open(KEYS.approver, {
      [RECORD]: () =>
        json(200, staffIdentityFixture({ role_bundle_id: PRIVILEGED_BUNDLE_ID }), etag('v1')),
    });

    expect(await screen.findByText('This role needs a Platform Admin to decide.')).toHaveClass(
      'ui-record-header__note',
    );
  });

  // Break caught (the Product Owner, 9 November 2026): two lines for one place, so that a person meets a paragraph of rules where one short line was asked for. A maker of a profile that
  // needs a Platform Admin is told both things in the one line.
  it('says both in one line when the person made a profile whose role needs a Platform Admin', async () => {
    open(
      KEYS.approver,
      {
        [RECORD]: () =>
          json(
            200,
            staffIdentityFixture({ role_bundle_id: PRIVILEGED_BUNDLE_ID, created_by: MAKER_ID }),
            etag('v1'),
          ),
      },
      undefined,
      MAKER_ID,
    );

    // The role says whether it needs a Platform Admin once the roles are read: the line has both sentences when they are.
    const line = await screen.findByText(/This role needs a Platform Admin to decide./);
    expect(line).toHaveClass('ui-record-header__note');
    expect(line).toHaveTextContent('You created this profile.');
    expect(document.querySelectorAll('.ui-record-header__note')).toHaveLength(1);
  });

  it('offers no decision on a profile that has been decided', async () => {
    open(KEYS.approver, { [RECORD]: () => json(200, active, etag('v2')) });
    await heading('Kofi Boateng');

    expect(screen.queryByRole('button', { name: 'Approve profile' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject profile' })).toBeNull();
  });

  // Break caught: a way to recover a credential offered by a page whose operation is not built (the recovery of a credential is not here).
  it('offers no recovery of a credential', async () => {
    open(KEYS.everything, { [RECORD]: () => json(200, active, etag('v2')) });
    await heading('Kofi Boateng');

    expect(screen.queryByRole('button', { name: /recover/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /recover/i })).toBeNull();
  });
});

describe('the profile: approving', () => {
  it('asks first, says what it means, and sends the version it read', async () => {
    let reads = 0;
    const view = open(KEYS.approver, {
      [RECORD]: () => {
        reads += 1;
        return reads === 1 ? json(200, pending, etag('v1')) : json(200, active, etag('v2'));
      },
      [APPROVE]: () => json(200, active, etag('v2')),
    });
    await view.user.click(await screen.findByRole('button', { name: 'Approve profile' }));

    const dialog = screen.getByRole('alertdialog', { name: 'Approve Kofi Boateng?' });
    expect(dialog).toHaveAccessibleDescription(
      /Kofi Boateng will be able to set a password and sign in as Ops Staff\. A setup link is sent to kofi\.boateng@example\.test\./,
    );
    expect(posts()).toHaveLength(0);
    await view.user.click(within(dialog).getByRole('button', { name: 'Approve profile' }));

    await waitFor(() => {
      expect(posts()).toHaveLength(1);
    });
    const [request] = posts();
    expect(request?.headers.get('If-Match')).toBe('"v1"');
    expect(request?.headers.has('Idempotency-Key')).toBe(false);
    expect(await request?.json()).toEqual({ approved: true });
  });

  it('closes the dialog, says it is done, shows the profile as it is now and puts focus on the news', async () => {
    let count = 0;
    const view = open(KEYS.approver, {
      [RECORD]: () => {
        count += 1;
        return count === 1 ? json(200, pending, etag('v1')) : json(200, active, etag('v2'));
      },
      [APPROVE]: () => json(200, active, etag('v2')),
    });
    await view.user.click(await screen.findByRole('button', { name: 'Approve profile' }));

    await view.user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Approve profile' }),
    );

    const notice = await screen.findByText(
      'Kofi Boateng is approved. A setup link is on its way to kofi.boateng@example.test.',
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => {
      expect(screen.getByText('Active', { selector: '.ui-status-badge' })).toBeVisible();
    });
    expect(screen.queryByRole('button', { name: 'Approve profile' })).toBeNull();
    expect(notice.closest('[tabindex="-1"]')).toHaveFocus();
  });

  it.each([
    [
      'SELF_APPROVAL_FORBIDDEN',
      422,
      'Only a Platform Admin can approve or reject a profile they made. Ask a different approver to decide this one.',
    ],
    [
      'INSUFFICIENT_AUTHORITY',
      403,
      'This role needs a higher authority to decide. Ask a Platform Admin.',
    ],
    [
      'PERMISSION_DENIED',
      403,
      'Your account can’t approve or reject profiles. Ask an administrator for access.',
    ],
    [
      'CREDENTIAL_DELIVERY_FAILED',
      422,
      'Nothing was changed. The message channel is not available yet, so the link could not be sent. You can try again once it is.',
    ],
  ])('tells %s in its own words and keeps the dialog', async (code, status, message) => {
    const view = open(KEYS.approver, { [APPROVE]: () => refusal(status, code) });
    await view.user.click(await screen.findByRole('button', { name: 'Approve profile' }));

    await view.user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Approve profile' }),
    );

    expect(await within(screen.getByRole('alertdialog')).findByRole('alert')).toHaveTextContent(
      message,
    );
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
  });

  // Break caught (ops-portal.md section 7, stale/conflict): a decision made on a record that moved, or a conflict that leaves the old record on screen.
  it('says the record changed, and reloads it', async () => {
    let count = 0;
    const view = open(KEYS.approver, {
      [RECORD]: () => {
        count += 1;
        return count === 1 ? json(200, pending, etag('v1')) : json(200, active, etag('v3'));
      },
      [APPROVE]: () => refusal(409, 'STATE_CONFLICT'),
    });
    await view.user.click(await screen.findByRole('button', { name: 'Approve profile' }));
    await view.user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Approve profile' }),
    );

    expect(
      await screen.findByText(
        /This profile changed after you opened it, perhaps because someone else has already decided it\./,
      ),
    ).toBeVisible();
    await view.user.click(screen.getByRole('button', { name: 'Reload the record' }));

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect(await screen.findByText('Active', { selector: '.ui-status-badge' })).toBeVisible();
    expect(reads()).toHaveLength(2);
  });

  it('says the outcome is not known when the answer is lost, and reads the record to find out', async () => {
    let count = 0;
    const view = open(KEYS.approver, {
      [RECORD]: () => {
        count += 1;
        return count === 1 ? json(200, pending, etag('v1')) : json(200, active, etag('v2'));
      },
      [APPROVE]: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await view.user.click(await screen.findByRole('button', { name: 'Approve profile' }));
    await view.user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Approve profile' }),
    );

    expect(await screen.findByText(/could not confirm whether this was done/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    await view.user.click(screen.getByRole('button', { name: 'Check the record' }));

    expect(await screen.findByText('Active', { selector: '.ui-status-badge' })).toBeVisible();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  // Break caught: an answer that is not a profile taken for the profile approved.
  it('does not say it is done for an answer that is not a profile', async () => {
    const view = open(KEYS.approver, { [APPROVE]: () => json(200, { surprise: true }) });
    await view.user.click(await screen.findByRole('button', { name: 'Approve profile' }));
    await view.user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Approve profile' }),
    );

    expect(await screen.findByText(/could not confirm whether this was done/i)).toBeVisible();
    // The notice of a profile approved: not the status line, which says a waiting profile "cannot sign in until this profile is approved".
    expect(screen.queryByText(/is approved\. A setup link is on its way/)).toBeNull();
  });

  it('can be cancelled without sending anything', async () => {
    const view = open();
    await view.user.click(await screen.findByRole('button', { name: 'Approve profile' }));

    await view.user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(posts()).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Approve profile' })).toHaveFocus();
  });
});

describe('the profile: rejecting', () => {
  async function reject(view: ReturnType<typeof open>) {
    await view.user.click(await screen.findByRole('button', { name: 'Reject profile' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Reject Kofi Boateng?' });
    await view.user.selectOptions(
      await within(dialog).findByRole('combobox', { name: 'Reason (required)' }),
      'NOT_A_REAL_HIRE',
    );
    await view.user.click(within(dialog).getByRole('button', { name: 'Reject profile' }));
  }

  it('asks for a reason from the catalogue of rejections only, and says rejecting is final', async () => {
    const view = open(KEYS.approver, { [REASONS]: rejectReasons });
    await view.user.click(await screen.findByRole('button', { name: 'Reject profile' }));

    const dialog = screen.getByRole('alertdialog', { name: 'Reject Kofi Boateng?' });
    expect(dialog).toHaveAccessibleDescription(
      /Rejecting is final\. Kofi Boateng cannot use this profile, and the email address can be used for a new one\./,
    );
    await within(dialog).findByRole('combobox', { name: 'Reason (required)' });
    const url = new URL(
      api.requests.find((request) => request.url.includes('/reason-definitions'))?.url ??
        'http://x',
    );
    expect(url.searchParams.get('operation')).toBe('approveStaffIdentity');
    expect(url.searchParams.get('branch')).toBe('APPROVAL_REJECTED');
  });

  it('sends the reason and the note with the version it read, and says the profile is rejected', async () => {
    let count = 0;
    const rejected = staffIdentityFixture({ status: 'REJECTED' });
    const view = open(KEYS.approver, {
      [REASONS]: rejectReasons,
      [RECORD]: () => {
        count += 1;
        return count === 1 ? json(200, pending, etag('v1')) : json(200, rejected, etag('v2'));
      },
      [APPROVE]: () => json(200, rejected, etag('v2')),
    });

    await reject(view);

    expect(await screen.findByText('The profile of Kofi Boateng is rejected.')).toBeVisible();
    const [request] = posts();
    expect(request?.headers.get('If-Match')).toBe('"v1"');
    expect(await request?.json()).toEqual({ approved: false, reason_code: 'NOT_A_REAL_HIRE' });
    expect(await screen.findByText('Rejected', { selector: '.ui-status-badge' })).toBeVisible();
  });

  // Break caught: the person's words dropped on their way to the audit event.
  it('sends the note as it was typed', async () => {
    const view = open(KEYS.approver, {
      [REASONS]: rejectReasons,
      [APPROVE]: () => json(200, staffIdentityFixture({ status: 'REJECTED' }), etag('v2')),
    });
    await view.user.click(await screen.findByRole('button', { name: 'Reject profile' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Reject Kofi Boateng?' });
    await view.user.selectOptions(
      await within(dialog).findByRole('combobox', { name: 'Reason (required)' }),
      'NOT_A_REAL_HIRE',
    );
    await view.user.click(within(dialog).getByRole('textbox', { name: 'Note' }));
    await view.user.paste('  Not on the hiring list.  ');
    await view.user.click(within(dialog).getByRole('button', { name: 'Reject profile' }));

    await waitFor(() => {
      expect(posts()).toHaveLength(1);
    });
    expect(await posts()[0]?.json()).toEqual({
      approved: false,
      reason_code: 'NOT_A_REAL_HIRE',
      note: '  Not on the hiring list.  ',
    });
  });

  it('offers no retry of a rejection that may have been done, only the record', async () => {
    const view = open(KEYS.approver, {
      [REASONS]: rejectReasons,
      [APPROVE]: () => Promise.reject(new TypeError('Failed to fetch')),
    });

    await reject(view);

    expect(await screen.findByRole('button', { name: 'Check the record' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

describe('the profile: sending a setup link again', () => {
  const grant = {
    id: 'd0000000-0000-4000-8000-000000000001',
    principal_type: 'STAFF',
    principal_id: STAFF_ID,
    purpose: 'STAFF_CREDENTIAL_SETUP',
    state: 'PENDING',
    issued_at: '2026-10-23T08:00:00Z',
    expires_at: '2026-10-23T08:30:00Z',
  };

  async function resend(view: ReturnType<typeof open>) {
    await view.user.click(await screen.findByRole('button', { name: 'Send a new setup link' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Send a new setup link?' });
    await view.user.selectOptions(
      await within(dialog).findByRole('combobox', { name: 'Reason (required)' }),
      'EMAIL_LOST',
    );
    await view.user.click(within(dialog).getByRole('button', { name: 'Send new link' }));
  }

  it('is offered for an active profile, to a person who can approve, and for no other', async () => {
    const view = open(KEYS.approver, { [RECORD]: () => json(200, active, etag('v2')) });
    expect(await screen.findByRole('button', { name: 'Send a new setup link' })).toBeVisible();
    view.unmount();
    api.restore();

    open(KEYS.approver);
    await heading('Kofi Boateng');
    expect(screen.queryByRole('button', { name: 'Send a new setup link' })).toBeNull();
  });

  it('is not offered to a person who cannot approve', async () => {
    open(KEYS.reader, { [RECORD]: () => json(200, active, etag('v2')) });
    await heading('Kofi Boateng');

    expect(screen.queryByRole('button', { name: 'Send a new setup link' })).toBeNull();
  });

  it('says what it does, asks for a reason of its own catalogue, and sends it with the version', async () => {
    const view = open(KEYS.approver, {
      [RECORD]: () => json(200, active, etag('v2')),
      [REASONS]: reissueReasons,
      [REISSUE]: () => json(200, grant),
    });
    await view.user.click(await screen.findByRole('button', { name: 'Send a new setup link' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Send a new setup link?' });
    expect(dialog).toHaveAccessibleDescription(
      /A new link is sent to kofi\.boateng@example\.test\. Any earlier link stops working\. Kofi Boateng still sets their own password\./,
    );
    await view.user.selectOptions(
      await within(dialog).findByRole('combobox', { name: 'Reason (required)' }),
      'EMAIL_LOST',
    );
    expect(within(dialog).getByRole('button', { name: 'Send new link' })).toHaveClass(
      'ui-button--primary',
    );
    await view.user.click(within(dialog).getByRole('button', { name: 'Send new link' }));

    await waitFor(() => {
      expect(posts()).toHaveLength(1);
    });
    const [request] = posts();
    expect(request?.headers.get('If-Match')).toBe('"v2"');
    expect(request?.headers.has('Idempotency-Key')).toBe(false);
    expect(await request?.json()).toEqual({ reason_code: 'EMAIL_LOST' });
    const url = new URL(
      api.requests.find((candidate) => candidate.url.includes('/reason-definitions'))?.url ??
        'http://x',
    );
    expect(url.searchParams.get('operation')).toBe('reissueStaffCredentialSetup');
  });

  it('sends the note as it was typed', async () => {
    const view = open(KEYS.approver, {
      [RECORD]: () => json(200, active, etag('v2')),
      [REASONS]: reissueReasons,
      [REISSUE]: () => json(200, grant),
    });
    await view.user.click(await screen.findByRole('button', { name: 'Send a new setup link' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Send a new setup link?' });
    await view.user.selectOptions(
      await within(dialog).findByRole('combobox', { name: 'Reason (required)' }),
      'EMAIL_LOST',
    );
    await view.user.click(within(dialog).getByRole('textbox', { name: 'Note' }));
    await view.user.paste('Spoke to them by phone.');
    await view.user.click(within(dialog).getByRole('button', { name: 'Send new link' }));

    await waitFor(() => {
      expect(posts()).toHaveLength(1);
    });
    expect(await posts()[0]?.json()).toEqual({
      reason_code: 'EMAIL_LOST',
      note: 'Spoke to them by phone.',
    });
  });

  it('says a link is on its way and when it lapses, and shows no link', async () => {
    const view = open(KEYS.approver, {
      [RECORD]: () => json(200, active, etag('v2')),
      [REASONS]: reissueReasons,
      [REISSUE]: () =>
        json(200, {
          ...grant,
          token: 'SECRET-TOKEN',
          link: 'https://example.test/#token=SECRET-TOKEN',
        }),
    });

    await resend(view);

    expect(
      await screen.findByText(
        'A new setup link is on its way to kofi.boateng@example.test. It works until 23 Oct, 08:30.',
      ),
    ).toBeVisible();
    expect(document.body.textContent).not.toContain('SECRET');
    expect(document.querySelector('a[href*="SECRET"]')).toBeNull();
  });

  it('explains a conflict as a person who already has a password, or a bootstrap administrator', async () => {
    const view = open(KEYS.approver, {
      [RECORD]: () => json(200, active, etag('v2')),
      [REASONS]: reissueReasons,
      [REISSUE]: () => refusal(409, 'STATE_CONFLICT'),
    });

    await resend(view);

    expect(
      await screen.findByText(
        /This person has already set a password, or is a bootstrap administrator/,
      ),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reload the record' })).toBeVisible();
  });

  // Break caught: an act offered where the contract refuses it (seen on the real API: a new setup link offered to an administrator who
  // had signed in). An authenticator that exists or is being set up belongs to a person who has a password, and a first setup link is
  // for a profile that has none.
  it('is not offered once an authenticator exists or is being set up', async () => {
    const view = open(KEYS.everything, {
      [RECORD]: () =>
        json(
          200,
          staffIdentityFixture({
            status: 'ACTIVE',
            mfa_enrolled: true,
            mfa_reset_state: 'FACTOR_ACTIVE',
          }),
          etag('v2'),
        ),
    });
    await screen.findByRole('link', { name: 'Reset authenticator' });
    expect(screen.queryByRole('button', { name: 'Send a new setup link' })).toBeNull();
    view.unmount();
    api.restore();

    open(KEYS.everything, {
      [RECORD]: () =>
        json(
          200,
          staffIdentityFixture({ status: 'ACTIVE', mfa_reset_state: 'ENROLMENT_UNFINISHED' }),
          etag('v2'),
        ),
    });
    await screen.findByRole('link', { name: 'Reset authenticator' });
    expect(screen.queryByRole('button', { name: 'Send a new setup link' })).toBeNull();
  });

  it('tells a failed delivery as nothing changed', async () => {
    const view = open(KEYS.approver, {
      [RECORD]: () => json(200, active, etag('v2')),
      [REASONS]: reissueReasons,
      [REISSUE]: () => refusal(422, 'CREDENTIAL_DELIVERY_FAILED'),
    });

    await resend(view);

    expect(
      await screen.findByText(/Nothing was changed\. The message channel is not available yet/),
    ).toBeVisible();
  });
});

describe('the profile: starting a password recovery (AC-SLICE-000-105)', () => {
  const RECOVER = `POST /ops/staff/${STAFF_ID}/credential/recover`;
  const RECOVERER = [...KEYS.everything, 'staff.credential.recover'];
  const recoveryReasons = () =>
    json(200, [
      reasonFixture({
        code: 'CREDENTIAL_RECOVERY_ASSISTANCE',
        label: 'Verified credential recovery assistance',
        permittedOperations: [{ operationId: 'recoverStaffCredential', branch: null }],
      }),
    ]);
  const request = {
    id: '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d',
    principal_type: 'STAFF',
    channel: 'EMAIL',
    state: 'PENDING',
    issued_at: '2026-10-23T08:00:00Z',
    expires_at: '2026-10-23T08:30:00Z',
    consumed_at: null,
    initiated_by: ME,
    coalesced: false,
  };

  async function recover(view: ReturnType<typeof open>) {
    await view.user.click(await screen.findByRole('button', { name: 'Start password recovery' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Start password recovery?' });
    await view.user.selectOptions(
      await within(dialog).findByRole('combobox', { name: 'Reason (required)' }),
      'CREDENTIAL_RECOVERY_ASSISTANCE',
    );
    await view.user.click(within(dialog).getByRole('button', { name: 'Send recovery link' }));
  }

  // Break caught: the act offered to a session without the key, or for a profile that keeps no password (pending, rejected, closed).
  it('is offered for an active or suspended profile, to a holder of staff.credential.recover, and for no other', async () => {
    for (const status of ['ACTIVE', 'SUSPENDED'] as const) {
      const view = open(RECOVERER, {
        [RECORD]: () => json(200, staffIdentityFixture({ status, approved_by: ME }), etag('v2')),
      });
      expect(await screen.findByRole('button', { name: 'Start password recovery' })).toBeVisible();
      view.unmount();
      api.restore();
    }
    for (const status of ['PENDING_APPROVAL', 'REJECTED', 'OFFBOARDED'] as const) {
      const view = open(RECOVERER, {
        [RECORD]: () =>
          json(
            200,
            staffIdentityFixture({
              status,
              ...(status === 'PENDING_APPROVAL' ? {} : { approved_by: ME }),
            }),
            etag('v2'),
          ),
      });
      await heading('Kofi Boateng');
      expect(screen.queryByRole('button', { name: 'Start password recovery' }), status).toBeNull();
      view.unmount();
      api.restore();
    }
    open(KEYS.everything, { [RECORD]: () => json(200, active, etag('v2')) });
    await heading('Kofi Boateng');
    expect(screen.queryByRole('button', { name: 'Start password recovery' })).toBeNull();
  });

  // Break caught: a recovery sent without a reason of its own catalogue, without the version read, or with an Idempotency-Key it does not take.
  it('says what it does, asks for a reason of its own catalogue, and sends it with the version', async () => {
    const view = open(RECOVERER, {
      [RECORD]: () => json(200, active, etag('v2')),
      [REASONS]: recoveryReasons,
      [RECOVER]: () => json(200, request),
    });
    await view.user.click(await screen.findByRole('button', { name: 'Start password recovery' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Start password recovery?' });
    expect(dialog).toHaveAccessibleDescription(
      /A link to set a new password is sent to kofi\.boateng@example\.test\./,
    );
    await view.user.selectOptions(
      await within(dialog).findByRole('combobox', { name: 'Reason (required)' }),
      'CREDENTIAL_RECOVERY_ASSISTANCE',
    );
    await view.user.click(within(dialog).getByRole('button', { name: 'Send recovery link' }));

    await waitFor(() => {
      expect(posts()).toHaveLength(1);
    });
    const [sent] = posts();
    expect(sent?.headers.get('If-Match')).toBe('"v2"');
    expect(sent?.headers.has('Idempotency-Key')).toBe(false);
    expect(await sent?.json()).toEqual({ reason_code: 'CREDENTIAL_RECOVERY_ASSISTANCE' });
    const url = new URL(
      api.requests.find((candidate) => candidate.url.includes('/reason-definitions'))?.url ??
        'http://x',
    );
    expect(url.searchParams.get('operation')).toBe('recoverStaffCredential');
  });

  // Break caught (AC-SLICE-000-105): the link, a token or a password shown to the administrator, or a coalesced call claiming a new message.
  it('says a link is on its way and when it lapses, shows no link, and says so when an earlier one still stands', async () => {
    const view = open(RECOVERER, {
      [RECORD]: () => json(200, active, etag('v2')),
      [REASONS]: recoveryReasons,
      [RECOVER]: () =>
        json(200, {
          ...request,
          token: 'SECRET-TOKEN',
          link: 'https://example.test/#token=SECRET-TOKEN',
        }),
    });

    await recover(view);

    expect(
      await screen.findByText(
        'A recovery link is on its way to kofi.boateng@example.test. It works until 23 Oct, 08:30.',
      ),
    ).toBeVisible();
    expect(document.body.textContent).not.toContain('SECRET');
    expect(document.querySelector('a[href*="SECRET"]')).toBeNull();
    view.unmount();
    api.restore();

    const again = open(RECOVERER, {
      [RECORD]: () => json(200, active, etag('v2')),
      [REASONS]: recoveryReasons,
      [RECOVER]: () => json(200, { ...request, initiated_by: null, coalesced: true }),
    });
    await recover(again);
    expect(
      await screen.findByText(
        'A recovery link sent to kofi.boateng@example.test a moment ago can still be used, so no new one was sent.',
      ),
    ).toBeVisible();
  });

  it('explains a conflict, and tells a failed delivery as nothing changed', async () => {
    const view = open(RECOVERER, {
      [RECORD]: () => json(200, active, etag('v2')),
      [REASONS]: recoveryReasons,
      [RECOVER]: () => refusal(409, 'STATE_CONFLICT'),
    });
    await recover(view);
    expect(
      await screen.findByText(
        /the person has not set a password yet \(send a setup link instead\)/,
      ),
    ).toBeVisible();
    view.unmount();
    api.restore();

    const failed = open(RECOVERER, {
      [RECORD]: () => json(200, active, etag('v2')),
      [REASONS]: recoveryReasons,
      [RECOVER]: () => refusal(422, 'CREDENTIAL_DELIVERY_FAILED'),
    });
    await recover(failed);
    expect(
      await screen.findByText(/Nothing was changed\. The message channel is not available yet/),
    ).toBeVisible();
  });
});

describe('the profile: the other things to do with it', () => {
  // Every key of the identity screens, and the one that starts a password recovery.
  const RECOVERER = [...KEYS.everything, 'staff.credential.recover'];
  const withFactor = staffIdentityFixture({
    status: 'ACTIVE',
    mfa_enrolled: true,
    mfa_reset_state: 'FACTOR_ACTIVE',
  });

  it('links to the reset of an authenticator for a profile that can have one reset, to a person who can reset', async () => {
    open(KEYS.everything, { [RECORD]: () => json(200, withFactor, etag('v2')) });

    expect(await screen.findByRole('link', { name: 'Reset authenticator' })).toHaveAttribute(
      'href',
      `/admin/staff/${STAFF_ID}/mfa/reset`,
    );
  });

  it('offers the reset of an unfinished set-up as well', async () => {
    open(KEYS.everything, {
      [RECORD]: () =>
        json(
          200,
          staffIdentityFixture({ status: 'ACTIVE', mfa_reset_state: 'ENROLMENT_UNFINISHED' }),
          etag('v2'),
        ),
    });

    expect(await screen.findByRole('link', { name: 'Reset authenticator' })).toBeVisible();
  });

  // Break caught (ops-portal.md section 7): the action offered for a profile it cannot be done to, or to a person who may not do it.
  it('does not offer the reset for a profile that cannot have one, or to a person who may not do it', async () => {
    const plain = open(KEYS.everything, { [RECORD]: () => json(200, active, etag('v2')) });
    await heading('Kofi Boateng');
    expect(screen.queryByRole('link', { name: 'Reset authenticator' })).toBeNull();
    plain.unmount();
    api.restore();

    open(KEYS.approver, { [RECORD]: () => json(200, withFactor, etag('v2')) });
    await heading('Kofi Boateng');
    expect(screen.queryByRole('link', { name: 'Reset authenticator' })).toBeNull();
  });

  it('links to the sessions of an active profile for a person who can end them', async () => {
    open(KEYS.approver, { [RECORD]: () => json(200, active, etag('v2')) });

    expect(await screen.findByRole('link', { name: 'See sessions' })).toHaveAttribute(
      'href',
      `/admin/sessions?principal_type=STAFF&principal_id=${STAFF_ID}`,
    );
  });

  // Break caught (Stage 4.4): the sessions as a panel of their own that holds one button-link, or as an act in the header. They are a page beside this one, so they are a plain link in the panel of what is related.
  it('puts the link to the sessions in the panel of what is related, as a link and not as a button', async () => {
    open(KEYS.approver, { [RECORD]: () => json(200, active, etag('v2')) });
    await heading('Kofi Boateng');

    const page = within(screen.getByRole('main'));
    const related = page
      .getByRole('heading', { level: 2, name: 'Related' })
      .closest('[data-slot="card"]');
    expect(related).not.toBeNull();
    const link = within(related as HTMLElement).getByRole('link', { name: 'See sessions' });
    expect(link).toHaveClass('ui-link');
    expect(link).not.toHaveClass('ui-button');
    // No panel of its own, named for the sessions.
    expect(page.queryByRole('heading', { name: 'Sessions' })).toBeNull();
  });

  it('does not offer the sessions of a profile that waits, or to a person who cannot end them', async () => {
    const waiting = open(KEYS.approver);
    await heading('Kofi Boateng');
    expect(screen.queryByRole('link', { name: 'See sessions' })).toBeNull();
    waiting.unmount();
    api.restore();

    open(KEYS.reader, { [RECORD]: () => json(200, active, etag('v2')) });
    await heading('Kofi Boateng');
    expect(screen.queryByRole('link', { name: 'See sessions' })).toBeNull();
  });

  // Break caught: a row of acts or a panel drawn empty for a profile there is nothing to do with.
  it('draws no act, and no panel of what is related, for a profile there is nothing to do with', async () => {
    open(KEYS.everything, {
      [RECORD]: () => json(200, staffIdentityFixture({ status: 'REJECTED' }), etag('v2')),
    });
    await heading('Kofi Boateng');

    // The page, not the menu beside it (which has a Sessions entry of its own).
    const page = within(screen.getByRole('main'));
    expect(page.queryByRole('heading', { name: 'Related' })).toBeNull();
    expect(page.queryByRole('heading', { name: 'Trusted browsers' })).toBeNull();
    expect(
      page.queryByRole('button', { name: /link|recovery|authenticator|browsers|approve|reject/i }),
    ).toBeNull();
    expect(page.queryByRole('link', { name: /sessions|authenticator/i })).toBeNull();
    // No row of acts at all: an empty one would leave a gap under the name.
    expect(headerActs()).toBeUndefined();
    // It could fail: the same page for an active profile of a person with an authenticator has each of them (the next tests).
    expect(page.getAllByRole('heading', { level: 2 }).map((each) => each.textContent)).toEqual([
      'Profile',
    ]);
  });

  // Break caught (Stage 4.4): the acts on the credentials in a panel that holds nothing but their buttons. Every act of the record is in its header, beside the name.
  it('puts the acts on the credentials in the header, beside the name, and keeps them out of the panels', async () => {
    open(RECOVERER, {
      [RECORD]: () =>
        json(
          200,
          staffIdentityFixture({
            status: 'ACTIVE',
            mfa_enrolled: true,
            mfa_reset_state: 'FACTOR_ACTIVE',
          }),
          etag('v2'),
        ),
    });
    await heading('Kofi Boateng');

    expect(headerActs()).toEqual(['Start password recovery', 'Reset authenticator']);

    // The panels hold what the person reads: the facts, the browsers they chose to be remembered at, and what is related. None is a panel of acts.
    const page = within(screen.getByRole('main'));
    expect(page.getAllByRole('heading', { level: 2 }).map((each) => each.textContent)).toEqual([
      'Profile',
      'Trusted browsers',
      'Related',
    ]);
    expect(page.queryByRole('heading', { name: 'Credentials' })).toBeNull();
    expect(page.getByRole('region', { name: 'Trusted browsers' })).toBeVisible();
  });

  it('puts the decision and the other acts of a profile that waits, and the acts of one that has no password, in the header too', async () => {
    const waiting = open(KEYS.everything);
    await heading('Kofi Boateng');
    expect(headerActs()).toEqual(['Approve profile', 'Reject profile']);
    waiting.unmount();
    api.restore();

    open(RECOVERER, { [RECORD]: () => json(200, active, etag('v2')) });
    await heading('Kofi Boateng');
    expect(headerActs()).toEqual(['Send a new setup link', 'Start password recovery']);
  });
});

describe('the profile: the record page', () => {
  // Break caught: a person's name drawn as an operational code, in the code face, which cannot wrap and reads as a code.
  it('draws the name as a name, with the status as a badge and what it means in a sentence under it', async () => {
    open(KEYS.reader);

    const name = await heading('Kofi Boateng');
    expect(name.querySelector('.ui-code')).toBeNull();
    expect(
      screen.getByText('Waiting for approval', { selector: '.ui-status-badge' }),
    ).toBeVisible();
    expect(screen.getByText(/cannot sign in until this profile is approved/)).toBeVisible();
  });

  it('keeps the facts of the profile in a panel of their own', async () => {
    open(KEYS.reader);
    await heading('Kofi Boateng');

    const facts = screen
      .getByRole('heading', { level: 2, name: 'Profile' })
      .closest('[data-slot="card"]');
    expect(facts).not.toBeNull();
    expect(within(facts as HTMLElement).getByText('Work email')).toBeVisible();
  });

  it('draws one level-one heading, the name', async () => {
    open(KEYS.everything);
    await heading('Kofi Boateng');

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});

describeInterfaceStates('The staff profile', {
  loading: {
    test: async () => {
      open(KEYS.approver, { [RECORD]: () => new Promise<Response>(() => undefined) });

      expect(await screen.findByRole('heading', { level: 1, name: 'Staff profile' })).toBeVisible();
      expect(await screen.findByText('Loading the profile…')).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Approve profile' })).toBeNull();
    },
  },
  empty: {
    inapplicable:
      'A profile is one record, not a list: it is there or it is not found, and not found is a page of its own, tested above.',
  },
  'validation error': {
    inapplicable:
      'The page has no field of its own; the reason and the note of an act are the dialog’s, tested with the dialog and above.',
  },
  error: {
    test: async () => {
      open(KEYS.approver, { [RECORD]: () => refusal(500, 'INTERNAL_ERROR') });

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'This profile could not be loaded.',
      );
    },
  },
  retry: {
    test: async () => {
      let answers = 0;
      const view = open(KEYS.approver, {
        [RECORD]: () => {
          answers += 1;
          return answers === 1 ? refusal(500, 'INTERNAL_ERROR') : json(200, pending, etag('v1'));
        },
      });

      await view.user.click(await screen.findByRole('button', { name: 'Try again' }));

      expect(await heading('Kofi Boateng')).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    test: async () => {
      const view = open(KEYS.approver, { [APPROVE]: () => refusal(409, 'STATE_CONFLICT') });
      await view.user.click(await screen.findByRole('button', { name: 'Approve profile' }));
      await view.user.click(
        within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Approve profile' }),
      );

      expect(await screen.findByRole('button', { name: 'Reload the record' })).toBeVisible();
    },
  },
  success: {
    test: async () => {
      open(KEYS.reader);

      expect(await heading('Kofi Boateng')).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      open(KEYS.maker);

      expect(await heading('You do not have access to this page')).toBeVisible();
    },
  },
});

describe('the profile: accessibility', () => {
  it('has no WCAG violations that can be checked without a layout engine, in its states', async () => {
    const view = open(KEYS.everything);
    await heading('Kofi Boateng');
    expect(await wcagViolations(view.container)).toEqual([]);
    await view.user.click(screen.getByRole('button', { name: 'Approve profile' }));
    expect(await wcagViolations(view.container)).toEqual([]);
    view.unmount();
    api.restore();

    const missing = open(KEYS.approver, { [RECORD]: () => refusal(404, 'NOT_FOUND') });
    await heading('Profile not found');
    expect(await wcagViolations(missing.container)).toEqual([]);
  });
});

describe('the profile: the trusted browsers of the person (staff-authentication.md section 5.8, AC-SLICE-000-137)', () => {
  const enrolled = staffIdentityFixture({
    status: 'ACTIVE',
    mfa_enrolled: true,
    mfa_reset_state: 'FACTOR_ACTIVE',
  });
  const chrome = trustedBrowserFixture();
  const safari = trustedBrowserFixture({
    id: 'd1000000-0000-4000-8000-000000000002',
    label: 'Safari on macOS',
    last_used_at: '2026-10-24T07:30:00.000Z',
  });
  const revokeReasons = () =>
    json(200, [
      reasonFixture({
        code: 'DEVICE_LOST',
        label: 'The device was lost',
        permittedOperations: [{ operationId: 'revokeSession', branch: null }],
      }),
    ]);

  // Break caught: a section shown for a person with no authenticator (who cannot have asked to be remembered), or to one without the key.
  it('is shown for an active profile with an authenticator, to a person who holds the key that ends standing access', async () => {
    open(KEYS.approver, { [RECORD]: () => json(200, enrolled, etag('v2')) });

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Trusted browsers' }),
    ).toBeVisible();
  });

  it.each([
    ['a profile with no authenticator', KEYS.approver, active],
    ['a person without the key', KEYS.reader, enrolled],
  ])('is not shown for %s, and asks the server nothing', async (_name, keys, record) => {
    open(keys, { [RECORD]: () => json(200, record, etag('v2')) });
    await heading('Kofi Boateng');

    expect(screen.queryByRole('heading', { name: 'Trusted browsers' })).toBeNull();
    expect(api.requests.some((request) => request.url.endsWith('/trusted-browsers'))).toBe(false);
  });

  // Break caught: a credential, a hash or a factor drawn, or a browser marked as the one asking in an administrator's list.
  it('lists what each is called and when it was added, last used and ends, and nothing that could sign anyone in', async () => {
    const view = open(KEYS.approver, {
      [RECORD]: () => json(200, enrolled, etag('v2')),
      [BROWSERS]: () =>
        json(200, {
          items: [{ ...chrome, token: 'SENTINEL-CREDENTIAL', token_hash: 'SENTINEL-HASH' }, safari],
        }),
    });

    const table = await screen.findByRole('table', { name: 'Trusted browsers of Kofi Boateng' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(table).toHaveTextContent('Chrome on Windows');
    expect(table).toHaveTextContent('Safari on macOS');
    expect(table).toHaveTextContent('Not used yet');
    expect(table).toHaveTextContent('24 Oct, 07:30');
    expect(table).not.toHaveTextContent('This browser');
    expect(view.container.textContent).not.toContain('SENTINEL');
  });

  // Break caught (the security review of run 5, Stage 5.1): the same panel drawn as cards in a narrow room, where no check looked for a credential. The whole markup is read.
  it('draws no credential in the cards of a narrow room, in any text or attribute', async () => {
    narrowRoom();
    const view = open(KEYS.approver, {
      [RECORD]: () => json(200, enrolled, etag('v2')),
      [BROWSERS]: () =>
        json(200, {
          items: [
            {
              ...chrome,
              token: 'SENTINEL-CREDENTIAL',
              token_hash: 'SENTINEL-HASH',
              factor_id: 'SENTINEL-FACTOR',
            },
            safari,
          ],
        }),
    });

    const list = await screen.findByRole('list', { name: 'Trusted browsers of Kofi Boateng' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(view.container.innerHTML).not.toContain('SENTINEL');
  });

  it('says so when there is none, and offers no removal', async () => {
    open(KEYS.approver, { [RECORD]: () => json(200, enrolled, etag('v2')) });

    expect(
      await screen.findByText('Kofi Boateng has no browser that skips the code.'),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Remove all trusted browsers' })).toBeNull();
  });

  // Break caught: a Senior Ops user (who holds the key and not the tier) shown a list, or an unexplained failure.
  it('tells a refusal of the tier in words, in place of the list', async () => {
    open(KEYS.approver, {
      [RECORD]: () => json(200, enrolled, etag('v2')),
      [BROWSERS]: () => refusal(403, 'INSUFFICIENT_AUTHORITY'),
    });

    expect((await screen.findAllByText(/higher authority/i)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('table', { name: /Trusted browsers/ })).toBeNull();
  });

  async function removeAll(view: ReturnType<typeof open>) {
    await view.user.click(
      await screen.findByRole('button', { name: 'Remove all trusted browsers' }),
    );
    const dialog = screen.getByRole('alertdialog', {
      name: 'Remove the trusted browsers of Kofi Boateng?',
    });
    await view.user.selectOptions(
      await within(dialog).findByRole('combobox', { name: 'Reason (required)' }),
      'DEVICE_LOST',
    );
    await view.user.click(within(dialog).getByRole('button', { name: 'Remove trusted browsers' }));
  }

  // Break caught: a removal with no reason, one that offers the reasons of another operation, one that sends a version it does not take, or
  // one that does not say that the sessions stay open.
  it('asks for a reason of the session-revocation domain, says what it does, and sends the reason alone', async () => {
    const view = open(KEYS.approver, {
      [RECORD]: () => json(200, enrolled, etag('v2')),
      [BROWSERS]: () => json(200, { items: [chrome, safari] }),
      [REASONS]: revokeReasons,
      [REMOVE_BROWSERS]: () => json(200, { revoked: 2 }),
    });
    await view.user.click(
      await screen.findByRole('button', { name: 'Remove all trusted browsers' }),
    );
    const dialog = screen.getByRole('alertdialog', {
      name: 'Remove the trusted browsers of Kofi Boateng?',
    });
    expect(dialog).toHaveAccessibleDescription(
      /Every browser Kofi Boateng has chosen to remember will ask for an authenticator code at its next sign-in\. Their open sessions stay open/,
    );
    await view.user.selectOptions(
      await within(dialog).findByRole('combobox', { name: 'Reason (required)' }),
      'DEVICE_LOST',
    );
    await view.user.click(within(dialog).getByRole('textbox', { name: 'Note' }));
    await view.user.paste('Reported lost by the team lead.');
    await view.user.click(within(dialog).getByRole('button', { name: 'Remove trusted browsers' }));

    await waitFor(() => {
      expect(posts()).toHaveLength(1);
    });
    const [request] = posts();
    expect(request?.headers.has('If-Match')).toBe(false);
    // The act takes a key (audit G03 of 26 October 2026): "every valid browser" is not a fixed set, so a retry must be the same request.
    expect(request?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await request?.json()).toEqual({
      reason_code: 'DEVICE_LOST',
      note: 'Reported lost by the team lead.',
    });
    const reasonsAsked = new URL(
      api.requests.find((candidate) => candidate.url.includes('/reason-definitions'))?.url ??
        'http://x',
    );
    expect(reasonsAsked.searchParams.get('operation')).toBe('revokeSession');
    expect(await screen.findByText('2 trusted browsers removed.')).toBeVisible();
  });

  it('says it plainly when there was nothing left to remove', async () => {
    const view = open(KEYS.approver, {
      [RECORD]: () => json(200, enrolled, etag('v2')),
      [BROWSERS]: () => json(200, { items: [chrome] }),
      [REASONS]: revokeReasons,
      [REMOVE_BROWSERS]: () => json(200, { revoked: 0 }),
    });

    await removeAll(view);

    expect(
      await screen.findByText('Kofi Boateng had no trusted browser left to remove.'),
    ).toBeVisible();
  });

  // Break caught (G03 of the audit of 26 October 2026): the answer is lost, the person is remembered on a new browser, and the retry removes it
  // too. A retry is the same request under the same key, so the server replays the first count; a removal started again is a new request
  // under a new key, and says what it is.
  it('offers a retry after a lost answer and sends it under the same key, with the same reason', async () => {
    let attempts = 0;
    const view = open(KEYS.approver, {
      [RECORD]: () => json(200, enrolled, etag('v2')),
      [BROWSERS]: () => json(200, { items: [chrome] }),
      [REASONS]: revokeReasons,
      [REMOVE_BROWSERS]: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new TypeError('Failed to fetch'))
          : json(200, { revoked: 1 });
      },
    });
    await removeAll(view);
    const dialog = screen.getByRole('alertdialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'We could not confirm whether this was done. You can try again: if it was already done, it is not done twice.',
    );

    await view.user.click(within(dialog).getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('1 trusted browser removed.')).toBeVisible();
    expect(posts()).toHaveLength(2);
    const [first, second] = posts();
    expect(second?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(second?.headers.get('Idempotency-Key')).toBe(first?.headers.get('Idempotency-Key'));
    expect(await second?.json()).toEqual(await first?.json());
  });

  // Break caught: checking the record after a lost answer keeping the key, so that the next removal is taken for the one that was lost.
  it('sends a removal begun again after the record was checked under a key of its own', async () => {
    let attempts = 0;
    const view = open(KEYS.approver, {
      [RECORD]: () => json(200, enrolled, etag('v2')),
      [BROWSERS]: () => json(200, { items: [chrome] }),
      [REASONS]: revokeReasons,
      [REMOVE_BROWSERS]: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new TypeError('Failed to fetch'))
          : json(200, { revoked: 0 });
      },
    });
    await removeAll(view);
    const dialog = screen.getByRole('alertdialog');
    await view.user.click(await within(dialog).findByRole('button', { name: 'Check the record' }));
    await removeAll(view);

    await waitFor(() => {
      expect(posts()).toHaveLength(2);
    });
    const [first, second] = posts();
    expect(second?.headers.get('Idempotency-Key')).not.toBe(first?.headers.get('Idempotency-Key'));
  });

  // Break caught: a refusal worded for sessions ("cannot end this person's sessions") when it is the trusted browsers that were refused.
  it('words a refusal for the trusted browsers and not for sessions', async () => {
    const view = open(KEYS.approver, {
      [RECORD]: () => json(200, enrolled, etag('v2')),
      [BROWSERS]: () => json(200, { items: [chrome] }),
      [REASONS]: revokeReasons,
      [REMOVE_BROWSERS]: () => refusal(403, 'INSUFFICIENT_AUTHORITY'),
    });

    await removeAll(view);

    const dialog = screen.getByRole('alertdialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Your session cannot remove this person’s trusted browsers. They are removed by a Platform Admin.',
    );
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
  });
});
