import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import { PICKUP_HUB_ID } from '../../../test-support/pickup-fixture';
import {
  WORK_OFFICER_ID,
  WORK_STOP_ID,
  handshakeFixture,
  opsHandshakeFixture,
} from '../../../test-support/pickup-work-fixture';
import { renderApp } from '../../../test-support/render-app';
import { refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/handshakes` (`listHandshakesForOps`; S1.30). The handshakes that need Ops, oldest first, in three views (*Needs Ops*, the ones Ops settled, *All*). A row says why it needs Ops, the counters beside the
 * limits the platform holds, and for one Ops settled that an officer did and when. **No code and no digest is ever on the page, and neither is the note of an override.** Two acts, each with a mandatory
 * note and neither taking a version: *Override* and *Resolve by hand* (a second key).
 */
const LIST = 'GET /handshakes-for-ops';
const OVERRIDE = `POST /pickup-stops/${WORK_STOP_ID}/handshake/ops-override`;
const RESOLVE = `POST /pickup-stops/${WORK_STOP_ID}/handshake/resolve`;
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const OFFICER = ['pickup.read', 'pickup.handshake.override'];
const SENIOR = [...OFFICER, 'pickup.handshake.resolve'];

const needsOps = opsHandshakeFixture();
const exhausted = opsHandshakeFixture({
  id: '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d',
  pickup_stop_id: '7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e',
  pickup_request_id: '8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e1f',
  request_code: 'ACC-PR-9XM4TQ',
  sender_name: 'Kente Traders',
  state: 'EXHAUSTED',
  routed_because: 'ATTEMPTS_EXHAUSTED',
  attempts: 5,
  attempt_limit: null,
  fallback_sends: 3,
});

const page = (items: unknown[], next: string | null = null): Response =>
  json(200, { items, next_page_token: next });

let api: FakeApi;
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

function open(
  handler: Handler = () => page([needsOps, exhausted]),
  keys: readonly string[] = SENIOR,
  handlers: Record<string, Handler> = {},
  path = '/handshakes',
) {
  api = installFakeApi(
    staffApi(
      sessionWith(keys, {
        authorized_hubs: [{ id: PICKUP_HUB_ID, display_name: 'Accra Central' }],
      }),
      { [LIST]: handler, ...handlers },
    ),
  );
  return renderApp(path);
}

const table = async (): Promise<HTMLElement> => {
  const found = await screen.findByRole('table', { name: 'Handshakes that need Ops' });
  await waitFor(() => {
    expect(found).not.toHaveAttribute('aria-busy', 'true');
  });
  return found;
};
const alertSaying = async (text: string | RegExp): Promise<HTMLElement> => {
  await waitFor(() => {
    expect(screen.getByRole('alert')).toHaveTextContent(text);
  });
  return screen.getByRole('alert');
};
const asked = () =>
  api.requests.filter((request) => new URL(request.url).pathname === '/api/v1/handshakes-for-ops');
const queryOf = () => new URL(asked().at(-1)?.url ?? 'http://x/').searchParams;
const sent = (route: string) =>
  api.requests.filter(
    (request) =>
      `${request.method} ${new URL(request.url).pathname.replace(/^\/api\/v1/, '')}` === route,
  );

async function openRow(user: UserEvent, code = 'ACC-PR-7KQ2MZ', sender = 'Demo Fabrics Ltd') {
  await table();
  await user.click(screen.getByRole('button', { name: `Open ${code}, ${sender}` }));
  // The panel slides and fades in: what is read in it is read once it has arrived and is not part way (the opacity of a panel that has just opened is not yet one).
  const region = await screen.findByRole('region', { name: `Details of ${code}` });
  await waitFor(() => {
    expect(region).toBeVisible();
  });
  return region;
}

describe('the handshakes: what the list shows', () => {
  it('shows each handshake by its pickup, why it needs Ops and the counters beside their limits', async () => {
    open();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Handshakes that need Ops' }),
    ).toBeVisible();
    expect(document.title).toBe('Handshakes that need Ops · Melarc Ops Portal');
    const first = within((await screen.findByText('ACC-PR-7KQ2MZ')).closest('tr') as HTMLElement);
    expect(first.getByText('Code ran out')).toBeVisible();
    expect(first.getByText('The code ran out before the vendor entered it.')).toBeVisible();
    expect(first.getByText('Attempts: 0 of 5')).toBeVisible();
    expect(first.getByText('Text messages: 0 of 3')).toBeVisible();
    expect(first.getByText('Rider arrived')).toBeVisible();
    expect(first.getByText('Accra Central')).toBeVisible();
  });

  // Break caught: a limit the platform has no usable value for filled in with a default, which would read as the platform's own.
  it('says a limit it has no value for is not known, and never fills in a default', async () => {
    open();

    const second = within((await screen.findByText('ACC-PR-9XM4TQ')).closest('tr') as HTMLElement);
    expect(second.getByText('The vendor used up the attempts to enter it.')).toBeVisible();
    expect(second.getByText('Attempts: 5 (the limit is not known)')).toBeVisible();
    expect(second.getByText('Text messages: 3 of 3')).toBeVisible();
  });

  // Break caught: a code or a digest on the page, or the note of an override, carried from an answer that had them.
  it('draws no code, no digest and no note of an override, whatever the answer carries', async () => {
    open(() =>
      page([
        {
          ...needsOps,
          code: '483920',
          code_digest: 'sha256:abcdef',
          verification_note: 'Called the vendor on a number I know.',
        },
      ]),
    );
    await table();

    expect(document.body.textContent).not.toContain('483920');
    expect(document.body.textContent).not.toContain('sha256');
    expect(document.body.textContent).not.toContain('Called the vendor');
  });

  it('tells a handshake that Ops settled by who and when, and by how', async () => {
    const settled = opsHandshakeFixture({
      state: 'MANUALLY_RESOLVED',
      routed_because: null,
      channel: 'OPS_OVERRIDE',
      confirmed_at: '2026-11-04T10:00:00Z',
      authorised_by: WORK_OFFICER_ID,
    });
    const { user } = open(() => page([settled]), SENIOR, {}, '/handshakes?view=settled');
    const panel = within(await openRow(user));

    expect(queryOf().get('open')).toBe('false');
    expect(panel.getAllByText(/Another member of staff settled it on /).length).toBeGreaterThan(0);
    expect(panel.getByText('Ops established the collection as an exception.')).toBeVisible();
    expect(panel.queryByRole('button', { name: 'Override' })).toBeNull();
    expect(panel.queryByRole('button', { name: 'Resolve by hand' })).toBeNull();
  });

  it('asks the server for the views and filters nothing itself', async () => {
    const { user } = open();
    await table();
    expect(queryOf().get('open')).toBe('true');

    await user.click(screen.getByRole('tab', { name: 'All' }));

    await waitFor(() => {
      expect(queryOf().has('open')).toBe(false);
    });
  });
});

describe('the acts on a handshake', () => {
  it('offers the override to a holder of its key and the resolution only to one who holds its own', async () => {
    const { user } = open(undefined, SENIOR);
    const panel = within(await openRow(user));

    expect(await panel.findByRole('button', { name: 'Override' })).toBeVisible();
    expect(panel.getByRole('button', { name: 'Resolve by hand' })).toBeVisible();
  });

  // Break caught: the resolution offered to a session that does not hold its key (the server refuses, but a refusal drawn as a dead end misrepresents the policy).
  it('offers no resolution by hand to a session without its key, and says who decides it', async () => {
    const { user } = open(undefined, OFFICER);
    const panel = within(await openRow(user));

    expect(await panel.findByRole('button', { name: 'Override' })).toBeVisible();
    expect(panel.queryByRole('button', { name: 'Resolve by hand' })).toBeNull();
    expect(
      panel.getByText('A senior officer decides whether it is resolved by hand.'),
    ).toBeVisible();
  });

  it('offers no resolution by hand for a code that is still live, whatever the key', async () => {
    const live = opsHandshakeFixture({
      state: 'CODE_DELIVERED',
      routed_because: 'FALLBACK_LIMIT_REACHED',
    });
    const { user } = open(() => page([live]), SENIOR);
    const panel = within(await openRow(user));

    expect(await panel.findByRole('button', { name: 'Override' })).toBeVisible();
    expect(panel.queryByRole('button', { name: 'Resolve by hand' })).toBeNull();
  });

  it('offers no act for a stop that is no longer at the door', async () => {
    const { user } = open(() => page([opsHandshakeFixture({ stop_state: 'COLLECTED' })]), SENIOR);
    const panel = within(await openRow(user));

    expect(
      await panel.findByText(
        'The stop is no longer at the door, so there is nothing left to settle here.',
      ),
    ).toBeVisible();
    expect(panel.queryByRole('button', { name: 'Override' })).toBeNull();
  });

  // Break caught: an override sent with a version (the operation declares none), with no key, with the note under another name, or without a note.
  it('overrides with a note under a fresh key and no version, and reads the list again', async () => {
    const { user } = open(undefined, SENIOR, { [OVERRIDE]: () => json(200, handshakeFixture()) });
    const panel = within(await openRow(user));

    await user.click(await panel.findByRole('button', { name: 'Override' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Override this handshake?' });
    await user.click(within(dialog).getByRole('button', { name: 'Override the handshake' }));
    expect(await within(dialog).findByText('Write a note saying why.')).toBeVisible();
    expect(sent(OVERRIDE)).toHaveLength(0);
    await user.type(
      within(dialog).getByRole('textbox', { name: /How you verified the vendor/ }),
      'Called the owner back on the number the office holds',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Override the handshake' }));

    expect(
      await screen.findByText(
        'The handshake of ACC-PR-7KQ2MZ is overridden: Ops established the collection as an exception.',
      ),
    ).toBeVisible();
    const [act] = sent(OVERRIDE);
    expect(act?.headers.get('Idempotency-Key')).toMatch(KEY);
    expect(act?.headers.get('If-Match')).toBeNull();
    expect(await act?.clone().json()).toEqual({
      verification_note: 'Called the owner back on the number the office holds',
    });
    await waitFor(() => {
      expect(asked().length).toBeGreaterThanOrEqual(2);
    });
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: /^Details of / })).toBeNull();
    });
  });

  it('resolves by hand with a note under a fresh key and no version', async () => {
    const { user } = open(undefined, SENIOR, {
      [RESOLVE]: () => json(200, handshakeFixture({ channel: null })),
    });
    const panel = within(await openRow(user));

    await user.click(await panel.findByRole('button', { name: 'Resolve by hand' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Resolve this handshake by hand?' });
    await user.type(
      within(dialog).getByRole('textbox', { name: /How the collection was established/ }),
      'Vendor confirmed at the door',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Resolve the handshake' }));

    expect(
      await screen.findByText(/is resolved by hand: the stop is closed as the count says/),
    ).toBeVisible();
    const [act] = sent(RESOLVE);
    expect(act?.headers.get('Idempotency-Key')).toMatch(KEY);
    expect(act?.headers.get('If-Match')).toBeNull();
    expect(await act?.clone().json()).toEqual({ note: 'Vendor confirmed at the door' });
  });

  // Break caught: a stop that was never counted told as a generic failure, so the officer retries what cannot work.
  it('tells a stop that was never counted in plain words, at the dialog', async () => {
    const { user } = open(undefined, SENIOR, {
      [OVERRIDE]: () => refusal(422, 'COLLECTION_NOT_RECORDED'),
    });
    const panel = within(await openRow(user));

    await user.click(await panel.findByRole('button', { name: 'Override' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Override this handshake?' });
    await user.type(
      within(dialog).getByRole('textbox', { name: /How you verified the vendor/ }),
      'Called back',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Override the handshake' }));

    expect(
      await within(dialog).findByText(/has not recorded a count at this stop yet/),
    ).toBeVisible();
    expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
  });

  // Break caught: a live code told as "this changed, reload", so the officer reloads what cannot work.
  it('tells a code that is still live as that, and what to do', async () => {
    const { user } = open(undefined, SENIOR, {
      [RESOLVE]: () => refusal(409, 'STATE_CONFLICT', { rule: 'code_live' }),
    });
    const panel = within(await openRow(user));

    await user.click(await panel.findByRole('button', { name: 'Resolve by hand' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Resolve this handshake by hand?' });
    await user.type(
      within(dialog).getByRole('textbox', { name: /How the collection was established/ }),
      'Checked',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Resolve the handshake' }));

    expect(
      await within(dialog).findByText(/code of this handshake has not run out yet/),
    ).toBeVisible();
  });
});

describeInterfaceStates('the handshakes list', {
  loading: {
    test: async () => {
      open(() => new Promise<Response>(() => undefined));
      expect(await screen.findByText('Loading handshakes')).toBeVisible();
    },
  },
  empty: {
    test: async () => {
      open(() => page([]));
      expect(await screen.findByRole('heading', { name: 'No handshakes yet' })).toBeVisible();
      expect(screen.getByText(/Nothing needs Ops\./)).toBeVisible();
    },
  },
  'validation error': {
    test: async () => {
      open(() =>
        refusal(400, 'VALIDATION_FAILED', {
          violations: [{ in: 'query', pointer: '/open', rule: 'type' }],
        }),
      );
      await alertSaying('That filter was not accepted. Choose one of the views of the list.');
    },
  },
  error: {
    test: async () => {
      open(() => refusal(500, 'INTERNAL_ERROR'));
      await alertSaying('The handshakes could not be loaded.');
      expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const { user } = open(() => {
        attempts += 1;
        return attempts === 1 ? refusal(503, 'SERVICE_UNAVAILABLE') : page([needsOps]);
      });
      await alertSaying(/could not be loaded/);
      await user.click(screen.getByRole('button', { name: 'Retry' }));
      expect(await screen.findByText('ACC-PR-7KQ2MZ')).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    test: async () => {
      // A handshake that changed under the officer is told in plain words in the act's dialog, and the list is read again.
      const { user } = open(undefined, SENIOR, {
        [OVERRIDE]: () => refusal(409, 'STATE_CONFLICT', { rule: 'handshake_closed' }),
      });
      const panel = within(await openRow(user));
      await user.click(await panel.findByRole('button', { name: 'Override' }));
      const dialog = screen.getByRole('alertdialog', { name: 'Override this handshake?' });
      await user.type(
        within(dialog).getByRole('textbox', { name: /How you verified the vendor/ }),
        'Called back',
      );
      await user.click(within(dialog).getByRole('button', { name: 'Override the handshake' }));
      expect(await within(dialog).findByText(/already ended/)).toBeVisible();
    },
  },
  success: {
    test: async () => {
      open();
      expect(await screen.findByText('ACC-PR-7KQ2MZ')).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      open(() => refusal(403, 'PERMISSION_DENIED'));
      await alertSaying(
        'Your account can’t work the handshakes, short counts and photo exceptions of a pickup. Ask an administrator for access.',
      );
    },
  },
});
