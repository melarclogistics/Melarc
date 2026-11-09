import { useQuery } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@melarc/api-client/browser';

import { useApiClient } from '../../../platform/api/api-client';
import { answerOf, OperationFailure } from '../../../platform/api/api-response';
import { StaleSessionError } from '../../../platform/session/session-boundary';
import { errorResponse, installFakeApi, json, type FakeApi } from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import { reasonFixture } from '../../../test-support/reason-fixture';
import { renderWithProviders } from '../../../test-support/render-providers';
import { wcagViolations } from '../../../test-support/wcag';
import { EmptyState } from '../empty-state/EmptyState';
import { Skeleton } from '../skeleton/Skeleton';
import { ReadState, type ReadQuery } from './ReadState';
import { cannotText } from '../../../platform/problem/capability-words';

let api: FakeApi;

beforeEach(() => {
  api = installFakeApi();
});

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

const LIST = '/reason-definitions';
const DIAGNOSTIC = /Diagnostic text that must never reach a screen/;

/** A real read through the real client: the reason catalogue is a bare array, which is the shape most lists will have. */
function Reasons() {
  const client = useApiClient();
  const query = useQuery({
    queryKey: ['read-state-demo'],
    queryFn: async () =>
      answerOf(
        await client.GET('/reason-definitions', {
          params: { query: { operation: 'revokeSession' } },
        }),
      ).data,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return (
    <ReadState
      query={query}
      operation="listReasonDefinitions"
      permission="settings.reason.read"
      loadingLabel="Loading the reasons…"
      skeleton={<Skeleton lines={3} />}
      isEmpty={(data) => data.length === 0}
      empty={
        <EmptyState kind="none" heading="No reasons">
          No reason is configured for this action.
        </EmptyState>
      }
    >
      {(data) => (
        <ul aria-label="Reasons">
          {data.map((reason) => (
            <li key={reason.code}>{reason.label}</li>
          ))}
        </ul>
      )}
    </ReadState>
  );
}

const reasons = (...labels: string[]) =>
  labels.map((label, index) => reasonFixture({ code: `DEMO_${String(index)}`, label }));

/** An answer the test holds back until it says so, so the loading state can be looked at. */
function gate() {
  let release: () => void = () => undefined;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { open, release };
}

describeInterfaceStates('ReadState', {
  loading: {
    test: async () => {
      const held = gate();
      api.on(`GET ${LIST}`, async () => {
        await held.open;
        return json(200, reasons('Demo reason one'));
      });
      const { container } = renderWithProviders(<Reasons />);

      expect(screen.getByRole('status')).toHaveTextContent('Loading the reasons…');
      expect(container.querySelector('.ui-skeleton')).toHaveAttribute('aria-hidden', 'true');
      expect(screen.queryByRole('list')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();

      await act(async () => {
        held.release();
        await held.open;
      });
      expect(await screen.findByRole('list', { name: 'Reasons' })).toBeVisible();
    },
  },
  empty: {
    test: async () => {
      api.on(`GET ${LIST}`, () => json(200, []));
      renderWithProviders(<Reasons />);

      expect(await screen.findByRole('heading', { name: 'No reasons' })).toBeVisible();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByRole('list')).toBeNull();
    },
  },
  'validation error': {
    inapplicable:
      'A read has no input to validate; the form that filters it owns the validation error, and the filter’s own tests cover it.',
  },
  error: {
    test: async () => {
      api.on(`GET ${LIST}`, () => errorResponse(500, 'INTERNAL_ERROR'));
      renderWithProviders(<Reasons />);

      const alert = await screen.findByRole('alert');
      expect(alert).toBeVisible();
      expect(alert).toHaveTextContent('The reasons could not be loaded.');
      expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
      expect(screen.queryByRole('list')).toBeNull();
    },
  },
  retry: {
    test: async () => {
      let answers = 0;
      api.on(`GET ${LIST}`, () => {
        answers += 1;
        return answers === 1
          ? errorResponse(503, 'SETTING_MISSING')
          : json(200, reasons('Demo reason one'));
      });
      const { user } = renderWithProviders(<Reasons />);

      const alert = await screen.findByRole('alert');
      // Break caught: the retry being part of the error, so that the words and the control cannot be told apart by a screen reader,
      // or being absent from it.
      const retry = screen.getByRole('button', { name: 'Try again' });
      expect(alert).not.toContainElement(retry);
      await user.click(retry);

      expect(await screen.findByRole('list', { name: 'Reasons' })).toBeVisible();
      expect(answers).toBe(2);
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    inapplicable:
      'A read changes nothing, so it has no version to conflict on; an answer that arrives for a session that has gone is refused as a StaleSessionError, which has its own test below.',
  },
  success: {
    test: async () => {
      api.on(`GET ${LIST}`, () => json(200, reasons('Demo reason one', 'Demo reason two')));
      renderWithProviders(<Reasons />);

      const list = await screen.findByRole('list', { name: 'Reasons' });
      expect(
        within(list)
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual(['Demo reason one', 'Demo reason two']);
      expect(screen.queryByRole('status')).toBeNull();
    },
  },
  'permission-restricted': {
    test: async () => {
      api.on(`GET ${LIST}`, () => errorResponse(403, 'PERMISSION_DENIED'));
      renderWithProviders(<Reasons />);

      expect(await screen.findByText(cannotText('settings.reason.read'))).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
      expect(screen.queryByRole('list')).toBeNull();
      expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
    },
  },
});

describe('ReadState: the other refusals', () => {
  it('names the hubs when the record is outside them, and offers no retry', async () => {
    api.on(`GET ${LIST}`, () => errorResponse(403, 'HUB_SCOPE_VIOLATION'));
    renderWithProviders(<Reasons />);

    expect(await screen.findByText('This is outside your hubs')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  // Break caught: asking again for a record that is not there, which changes nothing and trains the person to click.
  it('says a missing record is missing, and offers no retry', async () => {
    api.on(`GET ${LIST}`, () => errorResponse(404, 'NOT_FOUND'));
    renderWithProviders(<Reasons />);

    expect(await screen.findByText('This record could not be found.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('treats a request that got no answer as an error to retry', async () => {
    api.on(`GET ${LIST}`, () => Promise.reject(new TypeError('Failed to fetch')));
    renderWithProviders(<Reasons />);

    expect(await screen.findByRole('button', { name: 'Try again' })).toBeVisible();
    expect(document.body.textContent).not.toContain('Failed to fetch');
  });

  // Break caught: the request id lost, so that a person cannot tell Operations which request failed.
  it('shows the reference of a failed request for the person to quote', async () => {
    api.on(`GET ${LIST}`, () => errorResponse(500, 'INTERNAL_ERROR'));
    renderWithProviders(<Reasons />);

    expect(await screen.findByText(/req-test-1/)).toBeVisible();
  });

  // Break caught: a screen that shows an error for a session that has ended, behind the sign-in the boundary is taking the person to.
  it('shows no error for a session that has ended: the boundary ends it and the guard takes the person away', async () => {
    api.on(`GET ${LIST}`, () => errorResponse(401, 'SESSION_INVALID'));
    renderWithProviders(<Reasons />, { signedIn: true });

    // The end of a session empties the cache and cancels what is in flight, so this read never reports its failure: the page shows what
    // it showed (the loading words) until the guard above it navigates, which this harness has no router to do.
    await waitFor(() => {
      expect(api.requests).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
    expect(document.body.textContent).not.toMatch(/SESSION_|did not|try again/i);
  });

  it('shows nothing when the read itself reports that the session ended', () => {
    const query: ReadQuery<string[]> = {
      status: 'error',
      data: undefined,
      error: new OperationFailure(
        new ApiError({ kind: 'http', status: 401, code: 'SESSION_INVALID' }),
        [],
      ),
      refetch: () => Promise.resolve(),
      isFetching: false,
    };
    const { container } = renderWithProviders(
      <ReadState query={query} isEmpty={() => false} empty={null}>
        {() => <p>content</p>}
      </ReadState>,
    );

    // Nothing at all: not an empty alert box, which reads as nothing and still draws a red rectangle.
    expect(container.textContent).toBe('');
    expect(container.querySelector('.ui-alert')).toBeNull();
    expect(container.firstElementChild?.childElementCount).toBe(0);
  });

  it('shows nothing for a stale answer', () => {
    const query: ReadQuery<string[]> = {
      status: 'error',
      data: undefined,
      error: new StaleSessionError(),
      refetch: () => Promise.resolve(),
      isFetching: false,
    };
    const { container } = renderWithProviders(
      <ReadState query={query} isEmpty={() => false} empty={null}>
        {() => <p>content</p>}
      </ReadState>,
    );

    expect(container.textContent).toBe('');
    expect(container.querySelector('.ui-alert')).toBeNull();
    expect(container.firstElementChild?.childElementCount).toBe(0);
  });

  // Break caught: focus dropped to the top of the document when the retry button, which was under it, goes away.
  it('keeps focus on the place when a retry replaces the error', async () => {
    let answers = 0;
    api.on(`GET ${LIST}`, () => {
      answers += 1;
      return answers === 1
        ? errorResponse(500, 'INTERNAL_ERROR')
        : json(200, reasons('Demo reason one'));
    });
    const { user, container } = renderWithProviders(<Reasons />);
    await screen.findByRole('alert');

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('list', { name: 'Reasons' });

    expect(document.activeElement).not.toBe(document.body);
    expect(container.contains(document.activeElement)).toBe(true);
  });

  it('shows the error and not the data of an earlier answer when a refresh fails', () => {
    const query: ReadQuery<string[]> = {
      status: 'error',
      data: ['old'],
      error: new TypeError('Failed to fetch'),
      refetch: () => Promise.resolve(),
      isFetching: false,
    };
    renderWithProviders(
      <ReadState query={query} isEmpty={() => false} empty={null}>
        {(data) => <p>{data.join()}</p>}
      </ReadState>,
    );

    expect(screen.queryByText('old')).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  it('has no WCAG 2.1 A or AA violations that can be checked without a layout engine in any of its states', async () => {
    api.on(`GET ${LIST}`, () => errorResponse(500, 'INTERNAL_ERROR'));
    const failing = renderWithProviders(<Reasons />);
    await screen.findByRole('alert');
    expect(await wcagViolations(failing.container)).toEqual([]);
    failing.unmount();

    api.on(`GET ${LIST}`, () => errorResponse(403, 'PERMISSION_DENIED'));
    const refused = renderWithProviders(<Reasons />);
    await screen.findByText(cannotText('settings.reason.read'));
    expect(await wcagViolations(refused.container)).toEqual([]);
    refused.unmount();

    const held = gate();
    api.on(`GET ${LIST}`, async () => {
      await held.open;
      return json(200, []);
    });
    const loading = renderWithProviders(<Reasons />);
    expect(await wcagViolations(loading.container)).toEqual([]);
    await act(async () => {
      held.release();
      await held.open;
    });
    await screen.findByRole('heading', { name: 'No reasons' });
    expect(await wcagViolations(loading.container)).toEqual([]);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A screen may offer a way out of a failure that asking again is not (`recovery`): the first page of a queue whose saved page the server will
 * not open. It stands under the failure's message, for a failure only.
 */
describe('ReadState: a way out that a retry is not', () => {
  const failed = (error: unknown): ReadQuery<string[]> => ({
    status: 'error',
    data: undefined,
    error,
    refetch: () => Promise.resolve(),
    isFetching: false,
  });
  const refused = new OperationFailure(
    new ApiError({ kind: 'http', status: 400, code: 'VALIDATION_FAILED' }),
    [],
  );
  const recovery = <button type="button">Back to the start</button>;

  function draw(query: ReadQuery<string[]>) {
    return renderWithProviders(
      <ReadState
        query={query}
        isEmpty={(data) => data.length === 0}
        empty={<p>nothing</p>}
        permission="pickup.read"
        recovery={recovery}
      >
        {(data) => <p>{data.join()}</p>}
      </ReadState>,
    );
  }

  it('is drawn under the message of a failure that offers no retry', () => {
    draw(failed(refused));

    const alert = screen.getByRole('alert');
    const button = screen.getByRole('button', { name: 'Back to the start' });
    expect(alert.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('is drawn after the retry of a failure that offers one', () => {
    draw(failed(new TypeError('Failed to fetch')));

    const retry = screen.getByRole('button', { name: 'Try again' });
    const button = screen.getByRole('button', { name: 'Back to the start' });
    expect(retry.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // Break caught: a way out drawn in every state, so that a queue would offer its first page beside rows, a message of nothing or a spinner.
  const states: [string, ReadQuery<string[]>][] = [
    ['loading', { ...failed(null), status: 'pending', isFetching: true }],
    ['read', { ...failed(null), status: 'success', data: ['Demo row'] }],
    ['empty', { ...failed(null), status: 'success', data: [] }],
  ];
  it.each(states)('is not drawn while the read is %s', (_what, query) => {
    draw(query);

    expect(screen.queryByRole('button', { name: 'Back to the start' })).toBeNull();
  });

  it('is not drawn for a refusal of authority, which no way out of the queue would mend', () => {
    draw(
      failed(
        new OperationFailure(
          new ApiError({ kind: 'http', status: 403, code: 'PERMISSION_DENIED' }),
          [],
        ),
      ),
    );

    expect(screen.getByText(cannotText('pickup.read'))).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Back to the start' })).toBeNull();
  });

  it('is not asked for by a screen that gives none: a failure is drawn as it always was', () => {
    renderWithProviders(
      <ReadState query={failed(refused)} isEmpty={() => false} empty={null}>
        {() => <p>content</p>}
      </ReadState>,
    );

    expect(screen.getByRole('alert')).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
