import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import {
  manifestFixture,
  MANIFEST_ID,
  STOP_ONE_ID,
  stopFixture,
  summaryFixture,
} from '../../../test-support/manifest-fixture';
import { PICKUP_HUB_ID } from '../../../test-support/pickup-fixture';
import { evidenceListFixture, exceptionFixture } from '../../../test-support/pickup-work-fixture';
import { renderApp } from '../../../test-support/render-app';
import { etag, refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/manifests/{id}/stops/{stopId}/photo-exception` (`authoriseParcelPhotoException`; S1.30). The task form of the one act: let a stop's count through without parcel photos, with a required note.
 * **Offered only before the count**: a stop that is not arrived at, one already closed and one already let through are told in plain words, and a stop that has a count is refused by the server in words of
 * its own. The act is sent under a fresh `Idempotency-Key` and no version.
 */
const PATH = `/manifests/${MANIFEST_ID}/stops/${STOP_ONE_ID}/photo-exception`;
const STOP = `GET /pickup-stops/${STOP_ONE_ID}`;
const RUN = `GET /pickup-manifests/${MANIFEST_ID}`;
const EVIDENCE = `GET /pickup-stops/${STOP_ONE_ID}/evidence`;
const ACT = `POST /pickup-stops/${STOP_ONE_ID}/parcel-photo-exception`;
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OFFICER = ['pickup.read', 'pickup.handshake.override'];
const NOTE = 'The rider’s camera failed.';

let api: FakeApi;
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

const stopAnswer = (overrides: Record<string, unknown> = {}): Response =>
  json(
    200,
    stopFixture({
      state: 'ARRIVED',
      arrived_at: '2026-11-04T09:00:00Z',
      pickup_summary: summaryFixture('ACC-PR-7KQ2MZ'),
      ...overrides,
    }),
    etag('v1'),
  );

function open(
  handlers: Record<string, Handler> = {},
  keys: readonly string[] = OFFICER,
  stop: Handler = () => stopAnswer(),
  evidence: Handler = () =>
    json(
      200,
      evidenceListFixture({
        items: [],
        parcel_photos: { declared: 0, stored: 0, pending: 0, expired: 0 },
      }),
    ),
) {
  api = installFakeApi(
    staffApi(
      sessionWith(keys, {
        authorized_hubs: [{ id: PICKUP_HUB_ID, display_name: 'Accra Central' }],
      }),
      {
        [STOP]: stop,
        [RUN]: () => json(200, manifestFixture({ state: 'IN_PROGRESS' }), etag('v1')),
        [EVIDENCE]: evidence,
        ...handlers,
      },
    ),
  );
  return renderApp(PATH);
}

const sent = () =>
  api.requests.filter(
    (request) => request.method === 'POST' && request.url.includes('/parcel-photo-exception'),
  );
const alertSaying = async (text: string | RegExp): Promise<HTMLElement> => {
  await waitFor(() => {
    expect(screen.getByRole('alert')).toHaveTextContent(text);
  });
  return screen.getByRole('alert');
};

async function fillAndReview(user: UserEvent, note = NOTE): Promise<HTMLElement> {
  await user.type(await screen.findByRole('textbox', { name: /Note/ }), note);
  await user.click(screen.getByRole('button', { name: 'Let the count through' }));
  return screen.findByRole('alertdialog', {
    name: /Let the count of stop 1, ACC-PR-7KQ2MZ through without photos\?/,
  });
}

describe('the form', () => {
  it('asks for the note of a stop the rider has arrived at, and says what the act is', async () => {
    open();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Let a count through without photos' }),
    ).toBeVisible();
    expect(document.title).toBe('Let a count through without photos · Melarc Ops Portal');
    expect(
      await screen.findByText(/The rider counts this stop without photographing the parcels\./),
    ).toBeVisible();
    expect(screen.getByRole('textbox', { name: /Note/ })).toBeVisible();
    expect(screen.getByText('Stop 1, ACC-PR-7KQ2MZ.')).toBeVisible();
  });

  // Break caught: an exception sent without a note (the note is what says why a count had no photos).
  it('refuses a blank note at the field and sends nothing', async () => {
    const { user } = open();

    await user.click(await screen.findByRole('button', { name: 'Let the count through' }));

    expect(await screen.findByText('Write a note saying why.')).toBeVisible();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(sent()).toHaveLength(0);
  });

  // Break caught: an exception sent with a version (the operation declares none), without a key, under another name for the note, or without the confirmation that says it is not taken back.
  it('asks for a confirmation that says it is not taken back, then sends the note under a fresh key and no version', async () => {
    const { user } = open({ [ACT]: () => json(201, exceptionFixture({ note: NOTE })) });

    const dialog = within(await fillAndReview(user));
    expect(
      dialog.getByText(
        /recorded once, with your note and the moment, and it is never changed or removed/,
      ),
    ).toBeVisible();
    expect(sent()).toHaveLength(0);
    await user.click(dialog.getByRole('button', { name: 'Let the count through' }));

    await waitFor(() => {
      expect(sent()).toHaveLength(1);
    });
    const [act] = sent();
    expect(act?.headers.get('Idempotency-Key')).toMatch(KEY);
    expect(act?.headers.get('If-Match')).toBeNull();
    expect(await act?.clone().json()).toEqual({ note: NOTE });
    // The officer is taken to the stop's page, which says the count was let through.
    expect(
      await screen.findByText(
        'This stop’s count is let through without parcel photos. The rider can now count it.',
      ),
    ).toBeVisible();
    expect(await screen.findByRole('heading', { level: 1, name: 'Stop 1' })).toBeVisible();
  });

  // Break caught: a stop that already has a count told as a generic failure, so the officer retries what cannot work.
  it.each([
    ['collection_recorded', /already recorded the count at this stop/],
    ['exception_exists', /already been let through without photos/],
    ['stop_not_arrived', /has not arrived at this stop, or the stop is already closed/],
  ])('tells a refusal by %s in plain words, in the confirmation', async (rule, words) => {
    const { user } = open({ [ACT]: () => refusal(409, 'STATE_CONFLICT', { rule }) });

    const dialog = within(await fillAndReview(user));
    await user.click(dialog.getByRole('button', { name: 'Let the count through' }));

    expect(await dialog.findByText(words)).toBeVisible();
    expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
  });

  it('puts a note the server would not keep at the note, and never repeats its words', async () => {
    const { user } = open({
      [ACT]: () =>
        refusal(400, 'VALIDATION_FAILED', {
          violations: [{ in: 'body', pointer: '/note', rule: 'format' }],
        }),
    });

    const dialog = within(await fillAndReview(user, 'password=hunter2 in the note'));
    await user.click(dialog.getByRole('button', { name: 'Let the count through' }));

    expect(
      await dialog.findByText('Check the note marked below: it was not accepted as written.'),
    ).toBeVisible();
    expect(document.body.textContent).not.toContain('hunter2');
  });
});

describe('a stop the form is not for', () => {
  it('tells a stop the rider has not arrived at, or that is closed, and shows no form', async () => {
    open({}, OFFICER, () => stopAnswer({ state: 'COLLECTED' }));

    expect(
      await screen.findByText(/has not arrived at this stop, or the stop is already closed/),
    ).toBeVisible();
    expect(screen.queryByRole('textbox', { name: /Note/ })).toBeNull();
  });

  it('tells a stop that was let through already, and shows no form', async () => {
    open({}, OFFICER, undefined, () =>
      json(
        200,
        evidenceListFixture({
          items: [],
          parcel_photos: { declared: 0, stored: 0, pending: 0, expired: 0 },
          parcel_photo_exception: exceptionFixture(),
        }),
      ),
    );

    expect(
      await screen.findByText(/This stop has already been let through without photos/),
    ).toBeVisible();
    expect(screen.queryByRole('textbox', { name: /Note/ })).toBeNull();
  });

  it('tells a stop that does not exist as that', async () => {
    open({}, OFFICER, () => refusal(404, 'NOT_FOUND'));

    expect(await screen.findByRole('heading', { name: 'Stop not found' })).toBeVisible();
  });

  it('tells a stop of another hub as that', async () => {
    open({}, OFFICER, () => refusal(403, 'HUB_SCOPE_VIOLATION'));

    expect(await screen.findByText(/hub your account does not work in/)).toBeVisible();
  });
});

describeInterfaceStates('the photo exception form', {
  loading: {
    test: async () => {
      open({}, OFFICER, () => new Promise<Response>(() => undefined));
      expect(await screen.findByText('Loading the stop…')).toBeVisible();
    },
  },
  empty: {
    inapplicable:
      'The form is for one stop that exists: a stop that does not is a page of its own, and a stop it is not for is told in words.',
  },
  'validation error': {
    test: async () => {
      const { user } = open();
      await user.click(await screen.findByRole('button', { name: 'Let the count through' }));
      expect(await screen.findByText('Write a note saying why.')).toBeVisible();
    },
  },
  error: {
    test: async () => {
      open({}, OFFICER, () => refusal(500, 'INTERNAL_ERROR'));
      await alertSaying('This stop could not be loaded.');
      expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const { user } = open({}, OFFICER, () => {
        attempts += 1;
        return attempts === 1 ? refusal(503, 'SERVICE_UNAVAILABLE') : stopAnswer();
      });
      await alertSaying(/could not be loaded/);
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      expect(await screen.findByRole('textbox', { name: /Note/ })).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    test: async () => {
      const { user } = open({ [ACT]: () => refusal(409, 'STATE_CONFLICT') });
      const dialog = within(await fillAndReview(user));
      await user.click(dialog.getByRole('button', { name: 'Let the count through' }));
      expect(await dialog.findByText(/This stop changed after you opened it\./)).toBeVisible();
    },
  },
  success: {
    test: async () => {
      open();
      expect(await screen.findByRole('textbox', { name: /Note/ })).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      open({}, ['pickup.read']);
      expect(
        await screen.findByText(
          'Your account can’t work the handshakes, short counts and photo exceptions of a pickup. Ask an administrator for access.',
        ),
      ).toBeVisible();
    },
  },
});
