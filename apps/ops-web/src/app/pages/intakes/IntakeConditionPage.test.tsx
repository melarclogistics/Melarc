import { webcrypto } from 'node:crypto';

import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import {
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
import { renderApp } from '../../../test-support/render-app';
import { etag, refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/intakes/{id}/condition` (`recordIntakeCondition`, with `createEvidence` and `completeEvidenceUpload`; S1.35). The task form of what the receiver found, apart from the count. It is offered only for an
 * intake that has been counted, whose itemising has not begun and whose condition is not recorded yet; a condition is chosen and never defaulted; `DAMAGED` and `TAMPERED` need a stored photo of this intake,
 * which the form uploads and cites; the form does not send while a photo is on its way.
 */
const PATH = `/intakes/${INTAKE_ID}/condition`;
const GET = `GET /hub-intakes/${INTAKE_ID}`;
const ACT = `POST /hub-intakes/${INTAKE_ID}/condition`;
const CREATE = 'POST /evidence';
const PUT = 'PUT /object-store/photo-1';
const COMPLETE = `POST /evidence/${INTAKE_EVIDENCE_ONE}/complete`;
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECEIVER = ['hub.read', 'hub.intake.count'];

let api: FakeApi;
beforeEach(() => {
  // jsdom has no `crypto.subtle`; every browser the portal runs in has it.
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
    purpose: 'CONDITION',
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
    expires_at: '2026-11-14T10:15:00Z',
  },
});

function open(
  intake: object = shortCountFixture(),
  handlers: Record<string, Handler> = {},
  keys: readonly string[] = RECEIVER,
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
  api.requests.filter((request) => request.method === 'POST' && request.url.endsWith('/condition'));
const photo = () =>
  new File([new Uint8Array([1, 2, 3, 4])], 'crushed.jpg', {
    type: 'image/jpeg',
    lastModified: Date.parse('2026-11-01T08:30:00Z'),
  });

async function choose(user: UserEvent, label: RegExp): Promise<void> {
  await user.click(await screen.findByRole('radio', { name: label }));
}
async function review(user: UserEvent): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: 'Review' }));
  return screen.findByRole('alertdialog');
}
async function addPhoto(user: UserEvent): Promise<void> {
  await user.upload(screen.getByLabelText(/Photos of what you found/), photo());
  await screen.findByText('Stored');
}

describe('the form', () => {
  it('asks what the receiver found, with no condition chosen and no photo field until one needs it', async () => {
    open();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Record the condition' }),
    ).toBeVisible();
    expect(
      await screen.findByText(/Intake ACC-IN-7KQ2MZ. What you found when you received the parcels/),
    ).toBeVisible();
    expect(
      screen.getByText('Independent of the count: a count that matches can still be damaged.'),
    ).toBeVisible();
    for (const radio of screen.getAllByRole('radio')) expect(radio).not.toBeChecked();
    expect(
      screen.getAllByRole('radio').map((radio) => radio.getAttribute('aria-label') ?? ''),
    ).toHaveLength(4);
    expect(
      screen.getByLabelText(/Photos of what you found/, { selector: 'input' }).closest('[hidden]'),
    ).not.toBeNull();
  });

  // Break caught: a condition sent when none was chosen (an inertia answer), or a damaged intake recorded with no photo.
  it('asks for a condition, and for a photo of damage and tampering, at the field, and sends nothing', async () => {
    const { user } = open();

    await user.click(await screen.findByRole('button', { name: 'Review' }));
    expect(await screen.findByText('Choose what you found.')).toBeVisible();
    expect(screen.queryByRole('alertdialog')).toBeNull();

    await choose(user, /Damaged/);
    await user.click(screen.getByRole('button', { name: 'Review' }));
    expect(await screen.findByText('Add at least one photo of what you found.')).toBeVisible();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(acts()).toHaveLength(0);

    await choose(user, /Tampered with/);
    await user.click(screen.getByRole('button', { name: 'Review' }));
    expect(await screen.findByText('Add at least one photo of what you found.')).toBeVisible();
  });

  // Break caught: the evidence of a damage uploaded for another purpose, the version of the read lost, the photo not cited, or a key that is not fresh.
  it('uploads the photo for this intake, cites it, and sends the condition under a fresh key and the version read', async () => {
    const recorded = shortCountFixture({
      condition: 'DAMAGED',
      condition_findings: [findingFixture()],
    });
    const { user } = open(shortCountFixture(), {
      [ACT]: () => {
        // The record the officer is taken to reads the intake again.
        api.on(GET, () => json(200, recorded, etag('v4')));
        return json(200, recorded, etag('v4'));
      },
    });
    await choose(user, /Damaged/);
    await user.type(screen.getByRole('textbox', { name: /Note/ }), 'Two cartons crushed.');
    await addPhoto(user);

    const declaration = api.requests.find(
      (request) => request.method === 'POST' && request.url.endsWith('/evidence'),
    );
    expect(await declaration?.clone().json()).toMatchObject({
      owner_type: 'PICKUP_INTAKE',
      owner_id: INTAKE_ID,
      purpose: 'CONDITION',
      content_type: 'image/jpeg',
      byte_size: 4,
    });
    expect(api.requests.some((request) => request.method === 'PUT')).toBe(true);

    const dialog = within(await review(user));
    expect(
      dialog.getByText(/the intake goes to a senior officer’s review\. No count changes\./),
    ).toBeVisible();
    expect(acts()).toHaveLength(0);
    await user.click(dialog.getByRole('button', { name: 'Record the condition' }));

    await waitFor(() => {
      expect(acts()).toHaveLength(1);
    });
    const [act] = acts();
    expect(act?.headers.get('Idempotency-Key')).toMatch(KEY);
    expect(act?.headers.get('If-Match')).toBe('"v3"');
    expect(await act?.clone().json()).toEqual({
      condition: 'DAMAGED',
      note: 'Two cartons crushed.',
      evidence_ids: [INTAKE_EVIDENCE_ONE],
    });
    expect(await screen.findByText('The condition is recorded.')).toBeVisible();
  });

  // Break caught: a form that sends while a photo is still on its way, so that the evidence it was told to attach is left out.
  it('does not send while a photo is on its way', async () => {
    let release: (() => void) | undefined;
    const { user } = open(shortCountFixture(), {
      [PUT]: () =>
        new Promise<Response>((resolve) => {
          release = () => {
            resolve(new Response(null, { status: 200 }));
          };
        }),
    });
    await choose(user, /Damaged/);
    await user.upload(screen.getByLabelText(/Photos of what you found/), photo());
    await screen.findByText('Sending');

    await user.click(screen.getByRole('button', { name: 'Review' }));
    expect(
      await screen.findByText('Wait until every photo has been sent, or leave it out.'),
    ).toBeVisible();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    release?.();
    await screen.findByText('Stored');
  });

  it('sends a condition that needs no photo with none, and OK with no evidence at all', async () => {
    const { user } = open(shortCountFixture(), {
      [ACT]: () => json(200, shortCountFixture(), etag('v4')),
    });
    await choose(user, /Good condition/);

    const dialog = within(await review(user));
    expect(
      dialog.getByText(
        /This records that you found nothing wrong\. It changes nothing else, and a condition is recorded once\./,
      ),
    ).toBeVisible();
    await user.click(dialog.getByRole('button', { name: 'Record the condition' }));
    await waitFor(() => {
      expect(acts()).toHaveLength(1);
    });
    expect(await acts()[0]?.clone().json()).toEqual({ condition: 'OK' });
  });

  // Break caught: a failed photo shown in the server's words or the store's address, or one that cannot be tried again.
  it('tells a photo the store declined in plain words, never the address, and tries it again', async () => {
    let attempts = 0;
    const { user } = open(shortCountFixture(), {
      [PUT]: () => {
        attempts += 1;
        return attempts === 1
          ? new Response('no', { status: 403 })
          : new Response(null, { status: 200 });
      },
    });
    await choose(user, /Damaged/);
    await user.upload(screen.getByLabelText(/Photos of what you found/), photo());

    expect(
      await screen.findByText(
        'The store declined this photo. Choose it again, or try another file.',
      ),
    ).toBeVisible();
    expect(document.body.textContent).not.toContain('store.example');
    expect(document.body.textContent).not.toContain('bearer-capability');
    await user.click(screen.getByRole('button', { name: 'Try crushed.jpg again' }));
    expect(await screen.findByText('Stored')).toBeVisible();
  });

  it('puts a missing photo, told by the server, at the photos', async () => {
    const { user } = open(shortCountFixture(), { [ACT]: () => refusal(422, 'REASON_REQUIRED') });
    await choose(user, /Damaged/);
    await addPhoto(user);

    const dialog = within(await review(user));
    await user.click(dialog.getByRole('button', { name: 'Record the condition' }));

    expect(
      await dialog.findByText(
        'Damaged and tampered need a photo of what you found. Add at least one photo.',
      ),
    ).toBeVisible();
    expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
  });

  it.each([
    [
      'condition_already_recorded',
      /A condition has already been recorded for this intake\. It is recorded once\./,
    ],
    ['itemization_started', /Itemising this intake has begun/],
    [
      'intake_not_counted',
      /This intake has not been counted yet\. A condition is recorded after the count\./,
    ],
    ['stale', /This intake changed after you opened it, so the condition was not recorded/],
  ])('tells a refusal by %s in plain words, in the confirmation', async (rule, words) => {
    const { user } = open(shortCountFixture(), {
      [ACT]: () => refusal(409, 'STATE_CONFLICT', { rule }),
    });
    await choose(user, /Good condition/);

    const dialog = within(await review(user));
    await user.click(dialog.getByRole('button', { name: 'Record the condition' }));

    expect(await dialog.findByText(words)).toBeVisible();
    expect(dialog.getByRole('button', { name: 'Reload the record' })).toBeVisible();
  });
});

describe('an intake the form is not for', () => {
  it('tells an intake that has not been counted, and offers the count to its key', async () => {
    open(preCountFixture());

    expect(
      await screen.findByText(
        'This intake has not been counted yet. A condition is recorded after the count.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Count the parcels' })).toHaveAttribute(
      'href',
      `/intakes/${INTAKE_ID}/count`,
    );
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('tells an intake whose condition is recorded already, and one whose itemising has begun, and shows no form', async () => {
    open(shortCountFixture({ condition_findings: [findingFixture()] }));
    expect(
      await screen.findByText(
        /A condition has already been recorded for this intake\. It is recorded once\./,
      ),
    ).toBeVisible();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('tells an intake being itemised', async () => {
    open(postCountFixture({ state: 'ITEMIZING' }));
    expect(await screen.findByText(/Itemising this intake has begun/)).toBeVisible();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('refuses a session without the key of the count, in plain words', async () => {
    open(shortCountFixture(), {}, ['hub.read']);
    expect(
      await screen.findByText(
        'Your account can’t count the parcels received at a hub. Ask an administrator for access.',
      ),
    ).toBeVisible();
  });
});

describeInterfaceStates('the condition form', {
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
      expect(await screen.findByText('Choose what you found.')).toBeVisible();
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
      const { user } = open(shortCountFixture(), {
        [ACT]: () => Promise.reject(new TypeError('Failed to fetch')),
      });
      await choose(user, /Good condition/);
      const dialog = within(await review(user));
      await user.click(dialog.getByRole('button', { name: 'Record the condition' }));
      expect(await dialog.findByText(/We could not confirm whether this was done/)).toBeVisible();
      expect(dialog.getByRole('button', { name: 'Try again' })).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    test: async () => {
      const { user } = open(shortCountFixture(), {
        [ACT]: () => refusal(409, 'STATE_CONFLICT', { rule: 'stale' }),
      });
      await choose(user, /Good condition/);
      const dialog = within(await review(user));
      await user.click(dialog.getByRole('button', { name: 'Record the condition' }));
      expect(await dialog.findByText(/changed after you opened it/)).toBeVisible();
    },
  },
  success: {
    test: async () => {
      const { user } = open(shortCountFixture(), {
        [ACT]: () => json(200, shortCountFixture(), etag('v4')),
      });
      await choose(user, /Good condition/);
      const dialog = within(await review(user));
      await user.click(dialog.getByRole('button', { name: 'Record the condition' }));
      expect(await screen.findByText('The condition is recorded.')).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      open(shortCountFixture(), { [GET]: () => refusal(403, 'PERMISSION_DENIED') });
      expect(
        await screen.findByText(
          'Your account can’t see hub intakes. Ask an administrator for access.',
        ),
      ).toBeVisible();
    },
  },
});
