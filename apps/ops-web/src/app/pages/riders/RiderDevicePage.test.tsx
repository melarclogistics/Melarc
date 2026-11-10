import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionStore } from '../../../platform/session/session-context';
import type { SessionStore } from '../../../platform/session/session-store';
import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import { decodeRenderedSvg } from '../../../test-support/qr-decode';
import { reasonFixture } from '../../../test-support/reason-fixture';
import {
  ENROLMENT_FORMS,
  ENROLMENT_URI,
  enrolmentGrantFixture,
  RIDER_HUB_ID,
  RIDER_ID,
  riderDetailFixture,
  riderDeviceFixture,
  riderFixture,
  unboundRider,
} from '../../../test-support/rider-fixture';
import { renderApp } from '../../../test-support/render-app';
import { etag, refusal, sessionWith, staffApi } from '../../../test-support/staff-api';
import { cannotText } from '../../../platform/problem/capability-words';

/**
 * `/admin/riders/{id}/device` (`revokeRiderDevice`, `reregisterRiderDevice`; S0.60b; AC-SLICE-000-74, -108 and -112). Two acts, two keys. **Revoking** is the
 * report of a lost or stolen handset: a reason and a confirmation, no note, no version, and it is not made slower. **Replacing** takes a reason, how
 * the rider was verified in person and the version read, and ends with the same QR handoff as the first binding, with the same rule for the code.
 */
const RECORD = `GET /ops/riders/${RIDER_ID}`;
const REVOKE = `POST /ops/riders/${RIDER_ID}/device/revoke`;
const REREGISTER = `POST /ops/riders/${RIDER_ID}/device/reregister`;
const REASONS = 'GET /reason-definitions';
const REVOKER = ['dispatch.read', 'staff.device.revoke', 'settings.reason.read'];
const REPLACER = [...REVOKER, 'staff.device.reregister'];
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;
const QR_NAME = 'QR code for the rider’s handset';
const NOTE_NAME = 'How you verified the rider in person (required)';
const LIFETIME_MS = 5 * 60 * 1000;
/** What a code that has left the screen is told in: what the page did, and nothing about what the server holds. */
const LAPSED = /The QR code is no longer displayed\./;

const captured: { client: QueryClient | undefined; store: SessionStore | undefined } = {
  client: undefined,
  store: undefined,
};

function Probe() {
  captured.client = useQueryClient();
  captured.store = useSessionStore();
  return <h1 tabIndex={-1}>Probe</h1>;
}

const routes = [
  { path: 'probe', element: <Probe /> },
  { path: 'elsewhere', element: <h1 tabIndex={-1}>Elsewhere</h1> },
];

const reasons = () =>
  json(200, [
    reasonFixture({
      code: 'DEVICE_LOST',
      label: 'Device lost or stolen',
      permittedOperations: [{ operationId: 'revokeRiderDevice', branch: null }],
    }),
    reasonFixture({
      code: 'HANDSET_REPLACED',
      label: 'Handset replaced',
      permittedOperations: [{ operationId: 'reregisterRiderDevice', branch: null }],
    }),
  ]);

let api: FakeApi;
let consoleOutput: string[];

beforeEach(() => {
  consoleOutput = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleOutput.push(args.map((arg) => JSON.stringify(arg)).join(' '));
    });
  }
});

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** The page, opened as a signed-in session that holds `keys`, the way a person gets there: by an address, from another page. */
async function open(
  keys: readonly string[] = REVOKER,
  handlers: Record<string, Handler> = {},
  riderId = RIDER_ID,
) {
  api = installFakeApi(
    staffApi(
      sessionWith(keys, { authorized_hubs: [{ id: RIDER_HUB_ID, display_name: 'Accra Central' }] }),
      {
        [RECORD]: () => json(200, riderDetailFixture(), etag('v1')),
        [REASONS]: reasons,
        ...handlers,
      },
    ),
  );
  const view = renderApp('/probe', routes);
  await screen.findByRole('heading', { name: 'Probe' });
  await act(async () => {
    await view.router.navigate(`/admin/riders/${riderId}/device`);
  });
  return view;
}

const posts = () => api.requests.filter((request) => request.method === 'POST');
const reads = () =>
  api.requests.filter((request) => request.url.endsWith(`/ops/riders/${RIDER_ID}`));

function entriesOf(storage: Storage): [string, string | null][] {
  return Array.from({ length: storage.length }, (_, index) => {
    const key = storage.key(index) ?? '';
    return [key, storage.getItem(key)];
  });
}

/** Every place any of the forms of a value can be found, by name. */
function whereIs(...forms: string[]): string[] {
  const places: string[] = [];
  const holds = (text: string | null | undefined): boolean =>
    forms.some((form) => (text ?? '').includes(form));

  const queries = captured.client?.getQueryCache().getAll() ?? [];
  const mutations = captured.client?.getMutationCache().getAll() ?? [];
  if (holds(JSON.stringify(queries.map((query) => query.state)))) places.push('query cache');
  if (holds(JSON.stringify(mutations.map((mutation) => mutation.state)))) {
    places.push('mutation cache');
  }
  if (holds(JSON.stringify(entriesOf(localStorage)))) places.push('localStorage');
  if (holds(JSON.stringify(entriesOf(sessionStorage)))) places.push('sessionStorage');
  if (holds(document.cookie)) places.push('cookie');
  if (holds(location.href)) places.push('address');
  if (holds(JSON.stringify(history.state ?? null))) places.push('history state');
  if (holds(document.title)) places.push('title');
  if (consoleOutput.some((line) => holds(line))) places.push('console');
  const live = [...document.querySelectorAll<HTMLInputElement>('input, textarea')].some((field) =>
    holds(field.value),
  );
  if (holds(document.documentElement.outerHTML) || live) places.push('page');
  return places;
}

/** Opens the dialog of the report of a loss and chooses the reason of the loss. */
async function startRevoking(view: Awaited<ReturnType<typeof open>>) {
  await view.user.click(await screen.findByRole('button', { name: 'Revoke the device' }));
  const dialog = screen.getByRole('alertdialog', { name: 'Revoke this device?' });
  await view.user.selectOptions(
    await within(dialog).findByRole('combobox', { name: 'Reason (required)' }),
    'DEVICE_LOST',
  );
  return dialog;
}

/** Fills the replacement form: the reason and the note. */
async function fillReplacement(
  view: Awaited<ReturnType<typeof open>>,
  note = 'Checked the rider’s Ghana card in person.',
) {
  await view.user.selectOptions(
    await screen.findByRole('combobox', { name: 'Reason (required)' }),
    'HANDSET_REPLACED',
  );
  await view.user.click(screen.getByRole('textbox', { name: NOTE_NAME }));
  await view.user.paste(note);
}

describe('the device page: what it shows', () => {
  it('names the page, the rider and the device, and its one way back is the trail of its parents', async () => {
    await open();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Revoke or replace a device' }),
    ).toBeVisible();
    expect(document.title).toBe('Revoke or replace a device · Melarc Ops Portal');
    expect(await screen.findByText('For Kwame Mensah.')).toBeVisible();
    expect(screen.getByText('One active device.')).toBeVisible();
    // The roster, then the rider by name (Stage 4.5): a task has the breadcrumb of its parents and no link of its own beside it that says the same.
    const trail = within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
    expect(trail.getByRole('link', { name: 'Riders' })).toHaveAttribute('href', '/admin/riders');
    expect(trail.getByRole('link', { name: 'Kwame Mensah' })).toHaveAttribute(
      'href',
      `/admin/riders/${RIDER_ID}`,
    );
    expect(screen.queryByRole('link', { name: 'Back to the rider' })).toBeNull();
    // The two acts are two sections of the form, each under a heading of its own.
    expect(
      screen.getByRole('heading', { level: 2, name: 'Report a lost or stolen device' }),
    ).toBeVisible();
    expect(screen.getByRole('heading', { level: 2, name: 'Replace the handset' })).toBeVisible();
  });

  // Break caught (the PO's decision of 9 November 2026): paragraphs of rules above the content. What revoking does is told in the question of its dialog.
  it('has no paragraph that explains the revoke: it is told in the dialog', async () => {
    await open();
    await screen.findByRole('button', { name: 'Revoke the device' });

    expect(screen.queryByText(/No check of who is asking is made/)).toBeNull();
    expect(screen.queryByText(/A new handset is registered afterwards, in person/)).toBeNull();
  });

  // Break caught: a revoke offered for a rider with no active device, which would be reported as done.
  it('offers a revoke for a rider with an active device and says there is nothing to revoke otherwise', async () => {
    await open(REVOKER, {
      [RECORD]: () =>
        json(
          200,
          riderDetailFixture(riderFixture({ has_active_device: false }), [
            riderDeviceFixture({ status: 'REVOKED' }),
          ]),
          etag('v1'),
        ),
    });

    expect(await screen.findByText('This rider has no active device to revoke.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Revoke the device' })).toBeNull();
  });

  // Break caught: a PIN, a hash, a key or an attestation that a server should never send drawn on the page.
  it('draws nothing of a PIN, a hash, a key or an attestation, even when an answer carries one', async () => {
    await open(REVOKER, {
      [RECORD]: () =>
        json(
          200,
          {
            rider: { ...riderFixture(), pin_hash: '$argon2id$HASH' },
            devices: [
              { ...riderDeviceFixture(), public_key: 'MFkwKEY', attestation: 'ATTESTATION' },
            ],
          },
          etag('v1'),
        ),
    });

    await screen.findByText('For Kwame Mensah.');

    expect(document.body.textContent).not.toMatch(/HASH|KEY|ATTESTATION/);
  });

  it('is a page of its own for a rider outside the session’s hubs, for one that does not exist and for an address that is not an id', async () => {
    const view = await open(REVOKER, { [RECORD]: () => refusal(403, 'HUB_SCOPE_VIOLATION') });
    expect(await screen.findByText(/hub your session does not act in/)).toBeVisible();
    view.unmount();
    api.restore();

    const second = await open(REVOKER, { [RECORD]: () => refusal(404, 'NOT_FOUND') });
    expect(await screen.findByRole('heading', { level: 1, name: 'Rider not found' })).toBeVisible();
    second.unmount();
    api.restore();

    await open(REVOKER, {}, 'not-an-id');
    expect(await screen.findByRole('heading', { level: 1, name: 'Rider not found' })).toBeVisible();
    expect(reads()).toHaveLength(0);
  });
});

describe('the device page: reporting a lost or stolen device', () => {
  // Break caught (AC-SLICE-000-112): the report of a loss made slower by a note, a version or a verification it does not take.
  it('asks for a reason and no note, and sends the reason alone: no version, no key, no verification', async () => {
    const view = await open(REVOKER, { [REVOKE]: () => new Response(null, { status: 204 }) });
    await view.user.click(await screen.findByRole('button', { name: 'Revoke the device' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Revoke this device?' });
    expect(dialog).toHaveAccessibleDescription(/revoked now and their session ends/);
    await within(dialog).findByRole('combobox', { name: 'Reason (required)' });
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    const asked = new URL(
      api.requests.find((request) => request.url.includes('/reason-definitions'))?.url ??
        'http://x',
    );
    expect(asked.searchParams.get('operation')).toBe('revokeRiderDevice');

    await view.user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Reason (required)' }),
      'DEVICE_LOST',
    );
    await view.user.click(within(dialog).getByRole('button', { name: 'Revoke the device' }));

    await waitFor(() => {
      expect(posts()).toHaveLength(1);
    });
    const [sent] = posts();
    expect(await sent?.json()).toEqual({ reason_code: 'DEVICE_LOST' });
    expect(sent?.headers.has('If-Match')).toBe(false);
    expect(sent?.headers.has('Idempotency-Key')).toBe(false);
  });

  it('says the device is revoked and the session has ended, and reads the rider again', async () => {
    let count = 0;
    const view = await open(REVOKER, {
      [RECORD]: () => {
        count += 1;
        return count === 1
          ? json(200, riderDetailFixture(), etag('v1'))
          : json(
              200,
              riderDetailFixture(riderFixture({ has_active_device: false }), [
                riderDeviceFixture({ status: 'REVOKED' }),
              ]),
              etag('v2'),
            );
      },
      [REVOKE]: () => new Response(null, { status: 204 }),
    });
    await startRevoking(view);
    const dialog = screen.getByRole('alertdialog', { name: 'Revoke this device?' });

    await view.user.click(within(dialog).getByRole('button', { name: 'Revoke the device' }));

    expect(
      await screen.findByText('The device is revoked and the rider’s session has ended.'),
    ).toBeVisible();
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect(await screen.findByText('This rider has no active device to revoke.')).toBeVisible();
    expect(reads()).toHaveLength(2);
  });

  // Break caught: a revoke sent without a reason of the catalogue.
  it('does not send until a reason is chosen, and says so', async () => {
    const view = await open(REVOKER);
    await view.user.click(await screen.findByRole('button', { name: 'Revoke the device' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Revoke this device?' });
    await within(dialog).findByRole('combobox', { name: 'Reason (required)' });

    await view.user.click(within(dialog).getByRole('button', { name: 'Revoke the device' }));

    expect(await within(dialog).findByText('Choose a reason.')).toBeVisible();
    expect(posts()).toHaveLength(0);
  });

  it('can be cancelled without sending anything, and the focus returns to the button', async () => {
    const view = await open(REVOKER);
    await view.user.click(await screen.findByRole('button', { name: 'Revoke the device' }));

    await view.user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(posts()).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Revoke the device' })).toHaveFocus();
  });

  // Break caught: an answer that is not the 204 of the contract (a page of something else, a proxy's reply) taken for the report of a loss done.
  it('does not say the device is revoked for an answer that is not the 204 of the contract', async () => {
    const view = await open(REVOKER, { [REVOKE]: () => json(200, { surprise: true }) });
    await startRevoking(view);
    const dialog = screen.getByRole('alertdialog', { name: 'Revoke this device?' });

    await view.user.click(within(dialog).getByRole('button', { name: 'Revoke the device' }));

    expect(await screen.findByText(/could not confirm whether this was done/i)).toBeVisible();
    expect(
      screen.queryByText('The device is revoked and the rider’s session has ended.'),
    ).toBeNull();
  });

  // Break caught: a lost answer to a revoke told as done or as refused: the act may have been done, and sending it again is safe.
  it('says the outcome is not known when the answer is lost, and offers the record and a second try', async () => {
    let attempts = 0;
    const view = await open(REVOKER, {
      [REVOKE]: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new TypeError('Failed to fetch'))
          : Promise.resolve(new Response(null, { status: 204 }));
      },
    });
    await startRevoking(view);
    const dialog = screen.getByRole('alertdialog', { name: 'Revoke this device?' });
    await view.user.click(within(dialog).getByRole('button', { name: 'Revoke the device' }));

    expect(await screen.findByText(/could not confirm whether this was done/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Check the record' })).toBeVisible();

    await view.user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(
      await screen.findByText('The device is revoked and the rider’s session has ended.'),
    ).toBeVisible();
    expect(posts()).toHaveLength(2);
  });

  // Break caught: a refusal worded as the operation's general failure, which would hide what the officer can do about it.
  it.each([
    [403, 'PERMISSION_DENIED', /can’t revoke a rider’s device/],
    [403, 'HUB_SCOPE_VIOLATION', /hub your session does not act in/],
    [404, 'NOT_FOUND', /This rider could not be found\./],
    [403, 'CSRF_VALIDATION_FAILED', /The device could not be revoked\. Try again/],
  ])('words a %s %s for what it is, and keeps the dialog', async (status, code, words) => {
    const view = await open(REVOKER, { [REVOKE]: () => refusal(status, code) });
    await startRevoking(view);
    const dialog = screen.getByRole('alertdialog', { name: 'Revoke this device?' });

    await view.user.click(within(dialog).getByRole('button', { name: 'Revoke the device' }));

    expect(await within(dialog).findByText(words)).toBeVisible();
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
    expect(screen.getByRole('alertdialog', { name: 'Revoke this device?' })).toBeVisible();
  });
});

describe('the device page: replacing the handset', () => {
  // Break caught: a replacement offered to a session without the key of its own, or for a rider with nothing to replace.
  it('names the permission a replacement needs, and offers no form, to a session without it', async () => {
    await open(REVOKER);

    expect(await screen.findByText(cannotText('staff.device.reregister'))).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Show the QR code' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: NOTE_NAME })).toBeNull();
  });

  it('offers no form to a rider whose access has ended', async () => {
    await open(REPLACER, {
      [RECORD]: () =>
        json(200, riderDetailFixture(riderFixture({ status: 'OFFBOARDED' })), etag('v1')),
    });

    expect(
      await screen.findByText(
        'A replacement handset cannot be registered while this rider’s access has ended.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Show the QR code' })).toBeNull();
  });

  it('offers no form to a rider who has held no device, and points at the first binding for a session that may bind', async () => {
    await open([...REPLACER, 'staff.device.register'], {
      [RECORD]: () => json(200, riderDetailFixture(unboundRider(), []), etag('v1')),
    });

    expect(
      await screen.findByText(/This rider has held no device, so there is nothing to replace\./),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Register a first device.' })).toHaveAttribute(
      'href',
      `/admin/riders/${RIDER_ID}/device/register`,
    );
    expect(screen.queryByRole('button', { name: 'Show the QR code' })).toBeNull();
  });

  it('asks for a reason from its own catalogue and how the rider was verified, and says what happens', async () => {
    await open(REPLACER);

    const intro = await screen.findByText(
      /Do this in person, once you have verified who the rider is/,
    );
    expect(intro).toBeVisible();
    // Break caught (the PO's decision of 9 November 2026): a task form keeps at most two short sentences under its title, and the rest is told where the choice is made.
    expect(intro.textContent.split(/(?<=\.)\s+/)).toHaveLength(2);
    expect(screen.queryByText(/which makes its own key and asks for a new PIN/)).toBeNull();
    await screen.findByRole('combobox', { name: 'Reason (required)' });
    expect(screen.getByRole('textbox', { name: NOTE_NAME })).toBeVisible();
    expect(screen.getByText(/One line, up to 1000 characters/)).toBeVisible();
    // The one line that changes whether to act now, under the actions.
    expect(
      screen.getByText('Nothing changes for the old device until the new handset is registered.'),
    ).toBeVisible();
    const asked = new URL(
      api.requests.find((request) => request.url.includes('/reason-definitions'))?.url ??
        'http://x',
    );
    expect(asked.searchParams.get('operation')).toBe('reregisterRiderDevice');
  });

  // Break caught: a replacement sent without a reason, or without the verification the contract makes mandatory.
  it('does not send until both are given, says what is missing and moves the focus to the first', async () => {
    const view = await open(REPLACER);
    await screen.findByRole('combobox', { name: 'Reason (required)' });

    await view.user.click(screen.getByRole('button', { name: 'Show the QR code' }));

    expect(await screen.findByText('Choose a reason.')).toBeVisible();
    expect(screen.getByText('Say how you verified the rider’s identity in person.')).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Reason (required)' })).toHaveFocus();
    expect(posts()).toHaveLength(0);
  });

  // Break caught: a note of blanks taken for a verification.
  it('does not take blanks for a verification', async () => {
    const view = await open(REPLACER);
    await fillReplacement(view, '     ');

    await view.user.click(screen.getByRole('button', { name: 'Show the QR code' }));

    expect(
      await screen.findByText('Say how you verified the rider’s identity in person.'),
    ).toBeVisible();
    expect(posts()).toHaveLength(0);
  });

  // Break caught: the one-line rule of a note (the audit's) not applied to a field that can hold lines.
  it('does not take a note of more than one line, and tells the officer to remove the breaks', async () => {
    const view = await open(REPLACER);
    await fillReplacement(view, 'Checked the card.\nAnd the face.');

    await view.user.click(screen.getByRole('button', { name: 'Show the QR code' }));

    expect(
      await screen.findByText('The note must be one line. Remove the line breaks.'),
    ).toBeVisible();
    expect(posts()).toHaveLength(0);
  });

  it('does not take a note beyond the limit of the audit', async () => {
    const view = await open(REPLACER);
    await fillReplacement(view, 'a');
    fireEvent.change(screen.getByRole('textbox', { name: NOTE_NAME }), {
      target: { value: 'x'.repeat(1001) },
    });

    await view.user.click(screen.getByRole('button', { name: 'Show the QR code' }));

    expect(
      await screen.findByText('The note is too long. Use at most 1000 characters.'),
    ).toBeVisible();
    expect(posts()).toHaveLength(0);
  });

  it('limits the note to what the server accepts, as it is typed', async () => {
    await open(REPLACER);

    expect(await screen.findByRole('textbox', { name: NOTE_NAME })).toHaveAttribute(
      'maxlength',
      '1000',
    );
  });

  // Break caught (AC-SLICE-000-108): the replacement sent without the version read, with a key it does not take, or with the note as typed.
  it('sends the reason and the note with the version read, and no Idempotency-Key, and draws the code', async () => {
    const view = await open(REPLACER, {
      [REREGISTER]: () => json(200, enrolmentGrantFixture({}, LIFETIME_MS)),
    });
    await fillReplacement(view, '  Checked the rider’s Ghana card in person.  ');

    await view.user.click(screen.getByRole('button', { name: 'Show the QR code' }));

    const svg = await screen.findByRole('img', { name: QR_NAME });
    expect(decodeRenderedSvg(svg as unknown as SVGSVGElement)).toBe(ENROLMENT_URI);
    const [sent] = posts();
    expect(sent?.url).toContain(`/ops/riders/${RIDER_ID}/device/reregister`);
    expect(sent?.headers.get('If-Match')).toBe('"v1"');
    expect(sent?.headers.has('Idempotency-Key')).toBe(false);
    expect(await sent?.json()).toEqual({
      reason_code: 'HANDSET_REPLACED',
      verification_note: 'Checked the rider’s Ghana card in person.',
    });
  });

  // Break caught: the credential anywhere but the picture on the second page that draws it.
  it('keeps the code in the picture and nowhere else, and offers no way to copy it', async () => {
    const view = await open(REPLACER, {
      [REREGISTER]: () => json(200, enrolmentGrantFixture({}, LIFETIME_MS)),
    });
    await fillReplacement(view);
    await view.user.click(screen.getByRole('button', { name: 'Show the QR code' }));
    await screen.findByRole('img', { name: QR_NAME });

    expect(whereIs(...ENROLMENT_FORMS)).toEqual([]);
    const region = screen.getByRole('region', { name: 'Scan this code with the rider’s handset' });
    // The form that asked for it is gone, so focus is on the region, where a screen reader reads from its heading.
    expect(region).toHaveFocus();
    expect(
      within(region)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['The rider has scanned it', 'Make a new code']);
    expect(region.querySelectorAll('input, textarea, a, title, desc')).toHaveLength(0);
    for (const form of ENROLMENT_FORMS) {
      expect(consoleOutput.join('\n')).not.toContain(form);
    }
  });

  it('is gone at completion, at expiry, on navigation and when the page is hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = await open(REPLACER, {
      [REREGISTER]: () => json(200, enrolmentGrantFixture({}, LIFETIME_MS)),
    });
    await fillReplacement(view);
    await view.user.click(screen.getByRole('button', { name: 'Show the QR code' }));
    await screen.findByRole('img', { name: QR_NAME });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIFETIME_MS);
    });
    const news = await screen.findByText(LAPSED);
    expect(news).toBeVisible();
    // The page drops the code at its own limit, which is shorter than the grant's life: it may still stand at the server, so the words claim
    // nothing of the kind.
    expect(news).toHaveTextContent(
      'The QR code is no longer displayed. Make a new code when the rider is ready.',
    );
    expect(news.textContent).not.toMatch(/expired|can no longer be used|invalid|cancel/i);
    expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
    expect(whereIs(...ENROLMENT_FORMS)).toEqual([]);

    // A new code is a new command, with the same reason and note, and ends the lapsed one.
    await view.user.click(screen.getByRole('button', { name: 'Make a new code' }));
    await screen.findByRole('img', { name: QR_NAME });
    expect(posts()).toHaveLength(2);
    expect(await posts()[1]?.json()).toEqual(await posts()[0]?.json());

    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });
    await waitFor(() => {
      expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
    });
    expect(whereIs(...ENROLMENT_FORMS)).toEqual([]);
  });

  it('is gone on navigation, and the officer who has scanned it is taken back to the rider', async () => {
    const view = await open(REPLACER, {
      [REREGISTER]: () => json(200, enrolmentGrantFixture({}, LIFETIME_MS)),
    });
    await fillReplacement(view);
    await view.user.click(screen.getByRole('button', { name: 'Show the QR code' }));
    await screen.findByRole('img', { name: QR_NAME });

    await view.user.click(screen.getByRole('button', { name: 'The rider has scanned it' }));

    await waitFor(() => {
      expect(view.router.state.location.pathname).toBe(`/admin/riders/${RIDER_ID}`);
    });
    expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
    expect(whereIs(...ENROLMENT_FORMS)).toEqual([]);
  });

  // Break caught: a code asked for on one screen appearing on the next, or in a cache, after the officer has gone elsewhere.
  it('is shown and kept nowhere when its answer arrives after the officer has gone elsewhere', async () => {
    let release: (response: Response) => void = () => undefined;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const view = await open(REPLACER, { [REREGISTER]: () => gate });
    await fillReplacement(view);
    await view.user.click(screen.getByRole('button', { name: 'Show the QR code' }));
    await waitFor(() => {
      expect(posts()).toHaveLength(1);
    });
    await act(async () => {
      await view.router.navigate('/elsewhere');
    });
    expect(await screen.findByRole('heading', { name: 'Elsewhere' })).toBeVisible();

    release(json(200, enrolmentGrantFixture({}, LIFETIME_MS)));
    await act(async () => {
      await gate;
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
    expect(whereIs(...ENROLMENT_FORMS)).toEqual([]);
  });
});

describe('the device page: when the replacement is refused or in doubt', () => {
  async function submit(handler: Handler, extra: Record<string, Handler> = {}) {
    const view = await open(REPLACER, { [REREGISTER]: handler, ...extra });
    await fillReplacement(view);
    await view.user.click(screen.getByRole('button', { name: 'Show the QR code' }));
    return view;
  }

  // Break caught: a record that moved under the officer's hand being overwritten, or the way on being anything but reading it again.
  it('says the rider changed and reads the rider again, and the next code is asked for with the new version', async () => {
    let count = 0;
    let asked = 0;
    const view = await submit(
      () => {
        asked += 1;
        return asked === 1
          ? refusal(409, 'STATE_CONFLICT')
          : json(200, enrolmentGrantFixture({}, LIFETIME_MS));
      },
      {
        [RECORD]: () => {
          count += 1;
          return json(200, riderDetailFixture(), etag(count === 1 ? 'v1' : 'v2'));
        },
      },
    );

    expect(
      await screen.findByText(/A replacement cannot be registered for this rider as it stands/),
    ).toBeVisible();
    await view.user.click(screen.getByRole('button', { name: 'Reload the rider' }));
    await waitFor(() => {
      expect(reads()).toHaveLength(2);
    });
    await view.user.click(await screen.findByRole('button', { name: 'Show the QR code' }));

    expect(await screen.findByRole('img', { name: QR_NAME })).toBeVisible();
    expect(posts()[0]?.headers.get('If-Match')).toBe('"v1"');
    expect(posts()[1]?.headers.get('If-Match')).toBe('"v2"');
  });

  // Break caught: a lost answer to a replacement told as "nothing was changed", or the same request sent again without a key.
  it('says the outcome is not known when the answer is lost, offers only a look at the rider and says a new code ends the old', async () => {
    await submit(() => Promise.reject(new TypeError('Failed to fetch')));

    expect(
      await screen.findByText(
        'We could not confirm whether the code was made. Check the rider, then show a new code if you need one: a new code ends any earlier one, so only the latest can be scanned.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Check the rider' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
  });

  it('keeps what the officer wrote, locked, while the outcome is not known, and frees it after the look', async () => {
    const view = await submit(() => Promise.reject(new TypeError('Failed to fetch')));
    await screen.findByRole('button', { name: 'Check the rider' });

    expect(screen.getByRole('textbox', { name: NOTE_NAME })).toHaveAttribute('readonly');
    expect(screen.getByRole('textbox', { name: NOTE_NAME })).toHaveValue(
      'Checked the rider’s Ghana card in person.',
    );

    await view.user.click(screen.getByRole('button', { name: 'Check the rider' }));

    await waitFor(() => {
      expect(reads()).toHaveLength(2);
    });
    expect(await screen.findByRole('button', { name: 'Show the QR code' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: NOTE_NAME })).not.toHaveAttribute('readonly');
  });

  // Break caught: a refusal worded as the operation's general failure, which would hide what the officer can do about it.
  it.each([
    [403, 'PERMISSION_DENIED', /can’t register a replacement handset/],
    [
      403,
      'HUB_SCOPE_VIOLATION',
      /A replacement handset is registered only for a rider of your own hub\./,
    ],
    [404, 'NOT_FOUND', /This rider could not be found\./],
  ])('words a %s %s for what it is', async (status, code, words) => {
    await submit(() => refusal(status, code));

    expect(await screen.findByText(words)).toBeVisible();
    expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
  });

  // Break caught: a refused reason or note shown as a failure of the whole call instead of on its field.
  it('puts a refusal of the reason on the reason, and reads the catalogue again', async () => {
    await submit(() => refusal(422, 'REASON_NOT_ACTIVE'));

    expect(
      await screen.findByText('That reason can no longer be used for this. Choose another.'),
    ).toBeVisible();
    await waitFor(() => {
      expect(
        api.requests.filter((request) => request.url.includes('/reason-definitions')).length,
      ).toBeGreaterThanOrEqual(2);
    });
  });

  it('puts a refusal of the note on the note, in approved words', async () => {
    await submit(() =>
      refusal(400, 'VALIDATION_FAILED', {
        violations: [{ in: 'body', pointer: '/verification_note', rule: 'maxLength' }],
      }),
    );

    expect(
      await screen.findByText(
        'Say how you verified the rider’s identity in person, in one line. Leave out email addresses and telephone numbers.',
      ),
    ).toBeVisible();
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
  });

  it('lets the officer ask again after a refusal that is not about a field', async () => {
    let asked = 0;
    const view = await submit(() => {
      asked += 1;
      return asked === 1
        ? refusal(403, 'CSRF_VALIDATION_FAILED')
        : json(200, enrolmentGrantFixture({}, LIFETIME_MS));
    });
    await screen.findByText('The code could not be made. Nothing was changed.');

    await view.user.click(screen.getByRole('button', { name: 'Show the QR code' }));

    expect(await screen.findByRole('img', { name: QR_NAME })).toBeVisible();
  });
});

describe('the device page: a new replacement code asked for while a code is on the screen', () => {
  const SECOND_URI = `melarc-rider://enrol/v1#token=${'SecondEnrolmentToken'.padEnd(43, 'x')}&challenge=${'SecondEnrolmentChallenge'.padEnd(43, 'y')}`;
  const SECOND_FORMS = [SECOND_URI, encodeURIComponent(SECOND_URI)];
  const NOTE = 'Checked the rider’s Ghana card in person.';
  const lost = () => Promise.reject(new TypeError('Failed to fetch'));
  const second = () => json(200, enrolmentGrantFixture({ enrolment_uri: SECOND_URI }, LIFETIME_MS));

  /** The first ask is answered with the first code; each ask after it with the next of `then`, in order. */
  function firstThen(...then: readonly Handler[]): Handler {
    let asked = 0;
    return (request) => {
      asked += 1;
      if (asked === 1) return json(200, enrolmentGrantFixture({}, LIFETIME_MS));
      const next = then[asked - 2];
      if (next === undefined) throw new Error('The test did not expect another request');
      return next(request);
    };
  }

  /** A request that is on its way until the test lets the answer go or loses it. */
  function waiting() {
    let release: (response: Response) => void = () => undefined;
    let lose: () => void = () => undefined;
    const answer = new Promise<Response>((resolve, reject) => {
      release = resolve;
      lose = () => {
        reject(new TypeError('Failed to fetch'));
      };
    });
    return { answer: () => answer, release, lose };
  }

  /** The record, whose version is the number of times it has been read. */
  const versioned = () => {
    let read = 0;
    return () => {
      read += 1;
      return json(200, riderDetailFixture(), etag(`v${String(read)}`));
    };
  };

  /** The form filled and sent, and its code drawn: where the officer can ask for another. */
  async function replaced(handlers: Record<string, Handler>) {
    const view = await open(REPLACER, handlers);
    await fillReplacement(view, NOTE);
    await view.user.click(screen.getByRole('button', { name: 'Show the QR code' }));
    await screen.findByRole('img', { name: QR_NAME });
    return view;
  }

  const oneCodeDrawn = (uri: string) => {
    expect(screen.getAllByRole('img', { name: QR_NAME })).toHaveLength(1);
    expect(
      decodeRenderedSvg(screen.getByRole('img', { name: QR_NAME }) as unknown as SVGSVGElement),
    ).toBe(uri);
  };

  // Break caught: the earlier code left on the screen, with no news and no way out, when the answer to a new code is lost. The new code may have
  // been made and the earlier one ended, and the same request sent again (it takes no key) could make a second.
  it('takes the earlier code off the screen and offers only a look at the rider, with what was written kept and locked, when the answer is lost', async () => {
    const view = await replaced({ [REREGISTER]: firstThen(lost) });

    await view.user.click(screen.getByRole('button', { name: 'Make a new code' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We could not confirm whether the code was made. Check the rider, then show a new code if you need one: a new code ends any earlier one, so only the latest can be scanned.',
    );
    const check = screen.getByRole('button', { name: 'Check the rider' });
    expect(check).toBeVisible();
    expect(check).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Make a new code' })).toBeNull();
    expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
    expect(screen.getByText(/The earlier code is no longer shown\./)).toBeVisible();
    const note = screen.getByRole('textbox', { name: NOTE_NAME });
    expect(note).toHaveAttribute('readonly');
    expect(note).toHaveValue(NOTE);
    expect(whereIs(...ENROLMENT_FORMS)).toEqual([]);
    // Nothing is sent again by itself.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(posts()).toHaveLength(2);
  });

  // Break caught: the earlier code coming back when the officer looks at the rider (it may have been ended by the new one), or the next code
  // asked for with the version of the first read.
  it('does not bring the earlier code back when the officer checks the rider, and the next code is asked for with the version then read', async () => {
    const view = await replaced({ [REREGISTER]: firstThen(lost, second), [RECORD]: versioned() });
    await view.user.click(screen.getByRole('button', { name: 'Make a new code' }));

    await view.user.click(await screen.findByRole('button', { name: 'Check the rider' }));

    await waitFor(() => {
      expect(reads()).toHaveLength(2);
    });
    expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
    expect(whereIs(...ENROLMENT_FORMS)).toEqual([]);
    expect(screen.getByRole('textbox', { name: NOTE_NAME })).not.toHaveAttribute('readonly');
    await view.user.click(await screen.findByRole('button', { name: 'Show the QR code' }));
    await screen.findByRole('img', { name: QR_NAME });
    oneCodeDrawn(SECOND_URI);
    expect(posts()).toHaveLength(3);
    expect(posts()[1]?.headers.get('If-Match')).toBe('"v1"');
    expect(posts()[2]?.headers.get('If-Match')).toBe('"v2"');
    expect(await posts()[2]?.json()).toEqual({
      reason_code: 'HANDSET_REPLACED',
      verification_note: NOTE,
    });
  });

  // Break caught: a refusal of the new code that leaves the earlier one on the screen with nothing said, or the officer with no way on.
  it('says why a new code was refused, shows no code, and lets the officer ask again with the same reason and note', async () => {
    const view = await replaced({
      [REREGISTER]: firstThen(() => refusal(403, 'CSRF_VALIDATION_FAILED'), second),
    });

    await view.user.click(screen.getByRole('button', { name: 'Make a new code' }));

    expect(
      await screen.findByText('The code could not be made. Nothing was changed.'),
    ).toBeVisible();
    expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
    expect(screen.getByText(/The earlier code is no longer shown\./)).toBeVisible();
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);

    await view.user.click(screen.getByRole('button', { name: 'Show the QR code' }));

    await screen.findByRole('img', { name: QR_NAME });
    oneCodeDrawn(SECOND_URI);
    expect(await posts()[2]?.json()).toEqual(await posts()[1]?.json());
  });

  // Break caught: a conflict on the new code shown without the way on, or the next code asked for with the version that has just been refused.
  it('says the rider changed, and the next code is asked for with the version read after reloading', async () => {
    const view = await replaced({
      [REREGISTER]: firstThen(() => refusal(409, 'STATE_CONFLICT'), second),
      [RECORD]: versioned(),
    });

    await view.user.click(screen.getByRole('button', { name: 'Make a new code' }));

    expect(
      await screen.findByText(/A replacement cannot be registered for this rider as it stands/),
    ).toBeVisible();
    expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
    await view.user.click(screen.getByRole('button', { name: 'Reload the rider' }));
    await waitFor(() => {
      expect(reads()).toHaveLength(2);
    });
    await view.user.click(await screen.findByRole('button', { name: 'Show the QR code' }));

    await screen.findByRole('img', { name: QR_NAME });
    oneCodeDrawn(SECOND_URI);
    expect(posts()[1]?.headers.get('If-Match')).toBe('"v1"');
    expect(posts()[2]?.headers.get('If-Match')).toBe('"v2"');
  });

  // Break caught: the news of a failed new code lost behind the screen of a lapsed one, which has a button and no place for it.
  it.each([
    ['lost', lost, /We could not confirm whether the code was made/, 'Check the rider'],
    [
      'refused',
      () => refusal(403, 'CSRF_VALIDATION_FAILED'),
      /The code could not be made\. Nothing was changed\./,
      'Show the QR code',
    ],
  ])(
    'shows the news when the answer to a new code, asked for after the earlier one lapsed, is %s',
    async (_how, answer, news, wayOn) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const view = await replaced({ [REREGISTER]: firstThen(answer) });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LIFETIME_MS);
      });
      await screen.findByText(LAPSED);

      await view.user.click(screen.getByRole('button', { name: 'Make a new code' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(news);
      expect(screen.getByRole('button', { name: wayOn })).toBeVisible();
      expect(screen.queryByText(LAPSED)).toBeNull();
      expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
      // The lapsed screen has said the code is no longer displayed: it is not said again.
      expect(screen.queryByText(/The earlier code is no longer shown/)).toBeNull();
    },
  );

  // Break caught: the earlier code lapsing while the new one is asked for, which sent the page to the screen of a lapsed code (a button, no news, and
  // no way out of an outcome nobody knows), or the earlier code coming back once the officer has looked.
  it('neither hides the way out nor draws the earlier code again when its time ends while a new one is being made', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const pending = waiting();
    const view = await replaced({ [REREGISTER]: firstThen(pending.answer) });
    await view.user.click(screen.getByRole('button', { name: 'Make a new code' }));
    await waitFor(() => {
      expect(posts()).toHaveLength(2);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIFETIME_MS);
    });

    expect(screen.queryByText(LAPSED)).toBeNull();
    expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();

    pending.lose();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /We could not confirm whether the code was made/,
    );
    await view.user.click(screen.getByRole('button', { name: 'Check the rider' }));
    await screen.findByRole('button', { name: 'Show the QR code' });
    expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
    expect(screen.queryByText(LAPSED)).toBeNull();
    expect(whereIs(...ENROLMENT_FORMS)).toEqual([]);
  });

  // Break caught: two clicks making two requests for a new code, of which the second could end the first's; and the earlier code staying on the
  // screen until the request is sent, when it is the click that asks for the new one.
  it('sends one request for two clicks on Make a new code, and the earlier code is off the screen at once', async () => {
    const pending = waiting();
    await replaced({ [REREGISTER]: firstThen(pending.answer) });
    const renew = screen.getByRole('button', { name: 'Make a new code' });

    act(() => {
      renew.click();
      renew.click();
    });
    expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
    await waitFor(() => {
      expect(posts()).toHaveLength(2);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(posts()).toHaveLength(2);
    pending.release(second());
    await screen.findByRole('img', { name: QR_NAME });
    oneCodeDrawn(SECOND_URI);
  });

  // Break caught: the answer to a new code, which arrives late, drawing a code (or leaving one in a cache) on a screen the officer has left, a
  // session that has ended or a page that was hidden.
  it.each([
    [
      'the officer has gone to another page',
      async (view: Awaited<ReturnType<typeof replaced>>) => {
        await view.router.navigate('/elsewhere');
      },
    ],
    [
      'the address has changed under the same screen',
      async (view: Awaited<ReturnType<typeof replaced>>) => {
        await view.router.navigate(`/admin/riders/${RIDER_ID}/device?again=1`);
      },
    ],
    [
      'the session has ended',
      () => {
        captured.store?.end();
      },
    ],
    [
      'the page has been hidden',
      () => {
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      },
    ],
  ])(
    'shows and keeps no code when the answer to a new one arrives after %s',
    async (_what, happen) => {
      const pending = waiting();
      const view = await replaced({ [REREGISTER]: firstThen(pending.answer) });
      await view.user.click(screen.getByRole('button', { name: 'Make a new code' }));
      await waitFor(() => {
        expect(posts()).toHaveLength(2);
      });
      await act(async () => {
        await happen(view);
      });

      pending.release(second());
      await act(async () => {
        await pending.answer();
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      expect(screen.queryByRole('img', { name: QR_NAME })).toBeNull();
      expect(whereIs(...ENROLMENT_FORMS, ...SECOND_FORMS)).toEqual([]);
    },
  );
});

describeInterfaceStates('The device page', {
  loading: {
    test: async () => {
      let release: (response: Response) => void = () => undefined;
      const gate = new Promise<Response>((resolve) => {
        release = resolve;
      });
      await open(REVOKER, { [RECORD]: () => gate });
      expect(await screen.findByText('Loading the rider…')).toBeInTheDocument();
      // The way back is there while the rider is read: its entry in the trail has no name to say yet, and goes to the rider all the same.
      expect(
        within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('link', {
          name: 'The rider',
        }),
      ).toHaveAttribute('href', `/admin/riders/${RIDER_ID}`);
      await act(async () => {
        release(json(200, riderDetailFixture(), etag('v1')));
        await gate;
      });
      await screen.findByText('One active device.');
    },
  },
  empty: {
    test: async () => {
      await open(REVOKER, {
        [RECORD]: () =>
          json(
            200,
            riderDetailFixture(riderFixture({ has_active_device: false }), [
              riderDeviceFixture({ status: 'REVOKED' }),
            ]),
            etag('v1'),
          ),
      });
      expect(await screen.findByText('This rider has no active device to revoke.')).toBeVisible();
    },
  },
  'validation error': {
    test: async () => {
      const view = await open(REPLACER);
      await screen.findByRole('combobox', { name: 'Reason (required)' });
      await view.user.click(screen.getByRole('button', { name: 'Show the QR code' }));
      expect(await screen.findByText('Choose a reason.')).toBeVisible();
    },
  },
  error: {
    test: async () => {
      const view = await open(REVOKER, { [REVOKE]: () => refusal(403, 'HUB_SCOPE_VIOLATION') });
      await startRevoking(view);
      const dialog = screen.getByRole('alertdialog', { name: 'Revoke this device?' });
      await view.user.click(within(dialog).getByRole('button', { name: 'Revoke the device' }));
      expect(await within(dialog).findByText(/hub your session does not act in/)).toBeVisible();
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const view = await open(REVOKER, {
        [RECORD]: () => {
          attempts += 1;
          return attempts === 1
            ? refusal(503, 'SETTING_MISSING')
            : json(200, riderDetailFixture(), etag('v1'));
        },
      });
      await view.user.click(await screen.findByRole('button', { name: /Try again/ }));
      expect(await screen.findByText('One active device.')).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    test: async () => {
      const view = await open(REPLACER, { [REREGISTER]: () => refusal(409, 'STATE_CONFLICT') });
      await fillReplacement(view);
      await view.user.click(screen.getByRole('button', { name: 'Show the QR code' }));
      expect(
        await screen.findByText(/A replacement cannot be registered for this rider as it stands/),
      ).toBeVisible();
      expect(screen.getByRole('button', { name: 'Reload the rider' })).toBeVisible();
    },
  },
  success: {
    test: async () => {
      const view = await open(REVOKER, { [REVOKE]: () => new Response(null, { status: 204 }) });
      await startRevoking(view);
      const dialog = screen.getByRole('alertdialog', { name: 'Revoke this device?' });
      await view.user.click(within(dialog).getByRole('button', { name: 'Revoke the device' }));
      expect(
        await screen.findByText('The device is revoked and the rider’s session has ended.'),
      ).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      await open(['dispatch.read', 'staff.device.register']);
      expect(await screen.findByText(cannotText('staff.device.revoke'))).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Revoke the device' })).toBeNull();
    },
  },
});
