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
import { UNCLAIMED_FOCUS_SELECTOR } from './unclaimed-focus';
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

  // Break caught (run 7, Stage 2.1): a page that must tell focus nobody chose from focus an officer did choose reads this mark and nothing else, so a heading of the panel that is
  // also tabindex -1 is no longer taken for nobody's. The mark is on the wrapper, in every state, and on nothing inside it.
  it('marks its wrapper as a place focus lands on by a script or by a press inside it, and nothing it holds', async () => {
    api.on(`GET ${LIST}`, () => json(200, reasons('Demo reason one')));
    const { container } = renderWithProviders(<Reasons />);
    const wrapper = container.querySelector('.ui-read-state');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.matches(UNCLAIMED_FOCUS_SELECTOR)).toBe(true);

    const list = await screen.findByRole('list', { name: 'Reasons' });
    expect(wrapper?.matches(UNCLAIMED_FOCUS_SELECTOR)).toBe(true);
    expect(container.querySelectorAll(UNCLAIMED_FOCUS_SELECTOR)).toHaveLength(1);
    expect(list.matches(UNCLAIMED_FOCUS_SELECTOR)).toBe(false);
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

/**
 * Run G2, OB-S1-169 item 10 (the Product Owner's decision of 24 November 2026, D-S7-16): a read that was drawn and is asked for again, and fails
 * the way a retry could mend (no answer, a fault, a rate limit), **keeps the page and everything typed into it** and tells the failure in one
 * line with *Try again*. What the page replaced before was lost with it: an officer who went to the vendor's messages for a phone number and
 * came back to a refresh that failed found an error where the form had been.
 */
describe('ReadState: a read that fails again keeps the page it has', () => {
  const failedAgain = (error: unknown, data: string[] = ['old']): ReadQuery<string[]> => ({
    status: 'error',
    data,
    error,
    refetch: () => Promise.resolve(),
    isFetching: false,
  });
  const forbidden = (code: string, status = 403) =>
    new OperationFailure(new ApiError({ kind: 'http', status, code }), []);

  function draw(query: ReadQuery<string[]>) {
    return renderWithProviders(
      <ReadState
        query={query}
        isEmpty={(data) => data.length === 0}
        empty={<p>nothing</p>}
        permission="pickup.read"
      >
        {(data) => <p>{data.join()}</p>}
      </ReadState>,
    );
  }

  it('keeps what was read and says, in a line, that it could not be refreshed, with Try again beside it', () => {
    draw(failedAgain(new TypeError('Failed to fetch')));

    expect(screen.getByText('old')).toBeVisible();
    const line = screen.getByRole('alert');
    expect(line).toHaveTextContent(/could not be refreshed/i);
    expect(line).toHaveTextContent(/read earlier/i);
    // The retry is a control beside the line, as it is beside the error (COMPONENT_PATTERNS section 33.1).
    const retry = screen.getByRole('button', { name: 'Try again' });
    expect(line).not.toContainElement(retry);
    expect(document.body.textContent).not.toContain('Failed to fetch');
  });

  it('keeps the page, with the wait the API asked for, when the read was too fast', () => {
    draw(failedAgain(forbidden('RATE_LIMITED', 429)));

    expect(screen.getByText('old')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(/going a little fast/i);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  // Break caught (the stop's photo dialog, found by the whole suite): a link asked for again because the picture it gave would not load, whose renewal failed, drawn as the old link's picture with "what you see may be out of
  // date", when the old link is the very thing that failed. A read whose earlier answer is no use says so (`keepOnFailure`), and its failure is told in its own words, as it always was.
  it('replaces the page when the screen says its earlier answer is no use once a new one could not be had', () => {
    renderWithProviders(
      <ReadState
        query={failedAgain(new TypeError('Failed to fetch'))}
        isEmpty={() => false}
        empty={null}
        keepOnFailure={false}
      >
        {(data) => <p>{data.join()}</p>}
      </ReadState>,
    );

    expect(screen.queryByText('old')).toBeNull();
    expect(screen.queryByText(/could not be refreshed/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  it('keeps the nothing it was showing, with the same line', () => {
    draw(failedAgain(new TypeError('Failed to fetch'), []));

    expect(screen.getByText('nothing')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(/could not be refreshed/i);
  });

  // Break caught: keeping the page for every failure. A record that is gone, or one the account may no longer read, is not what was drawn:
  // the page that was kept would be a page of something the person can no longer have.
  it.each([
    ['a record that is not there any more', forbidden('NOT_FOUND', 404), /could not be found/i],
    ['a record outside the hubs now', forbidden('HUB_SCOPE_VIOLATION'), /outside your hubs/i],
  ])('replaces the page for %s, as it always did', (_what, error, words) => {
    draw(failedAgain(error));

    expect(screen.queryByText('old')).toBeNull();
    expect(screen.getByText(words)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('replaces the page for a refusal of authority, which keeping the page would only hide', () => {
    draw(failedAgain(forbidden('PERMISSION_DENIED')));

    expect(screen.queryByText('old')).toBeNull();
    expect(screen.getByText(cannotText('pickup.read'))).toBeVisible();
  });

  it('shows nothing, as before, when the refresh ended the session', () => {
    const { container } = draw(failedAgain(forbidden('SESSION_INVALID', 401)));

    expect(container.textContent).toBe('');
    expect(container.querySelector('.ui-alert')).toBeNull();
  });

  // Break caught: the line drawn for a read that did not fail, or for one that has no data yet (that one is the error, as before).
  it('draws no line while the read is fine or has nothing yet', () => {
    draw({ ...failedAgain(null), status: 'success', error: null });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('has the page as its one place for focus, and marks it once', () => {
    const { container } = draw(failedAgain(new TypeError('Failed to fetch')));

    expect(container.querySelectorAll(UNCLAIMED_FOCUS_SELECTOR)).toHaveLength(1);
  });

  function Entries() {
    const client = useApiClient();
    const query = useQuery({
      queryKey: ['read-state-entries'],
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
        isEmpty={(data) => data.length === 0}
        empty={null}
      >
        {(data) => (
          <form>
            <label>
              Why
              <input name="why" />
            </label>
            <ul aria-label="Reasons">
              {data.map((reason) => (
                <li key={reason.code}>{reason.label}</li>
              ))}
            </ul>
            <button type="button" onClick={() => void query.refetch()}>
              Read again
            </button>
          </form>
        )}
      </ReadState>
    );
  }

  // The whole point of the change, through the real client: what the person typed is in the same field after the failed refresh, after the
  // retry that mends it, and the page is not drawn again in between (a field that was drawn again would be empty, or would keep its text by luck).
  it('keeps what was typed, in the same field, through a refresh that fails and the retry that mends it', async () => {
    let answers = 0;
    api.on(`GET ${LIST}`, () => {
      answers += 1;
      return answers === 2
        ? errorResponse(500, 'INTERNAL_ERROR')
        : json(200, reasons('Demo reason one'));
    });
    const { user } = renderWithProviders(<Entries />);
    const field = await screen.findByLabelText('Why');
    await user.type(field, 'the label is torn, the phone is on the other side');

    await user.click(screen.getByRole('button', { name: 'Read again' }));
    const line = await screen.findByRole('alert');
    expect(line).toHaveTextContent(/could not be refreshed/i);
    expect(screen.getByLabelText('Why')).toBe(field);
    expect(field).toHaveValue('the label is torn, the phone is on the other side');
    expect(screen.getByRole('list', { name: 'Reasons' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
    expect(answers).toBe(3);
    expect(screen.getByLabelText('Why')).toBe(field);
    expect(field).toHaveValue('the label is torn, the phone is on the other side');
    // The button that was pressed went with the line: focus is not dropped to the top of the document.
    expect(document.activeElement).not.toBe(document.body);
  });

  it('asks again from the line, and the line says it is asking while it does', async () => {
    let answers = 0;
    const second = gate();
    api.on(`GET ${LIST}`, async () => {
      answers += 1;
      if (answers === 2) return errorResponse(500, 'INTERNAL_ERROR');
      if (answers === 3) await second.open;
      return json(200, reasons('Demo reason one'));
    });
    const { user } = renderWithProviders(<Entries />);
    await screen.findByLabelText('Why');
    await user.click(screen.getByRole('button', { name: 'Read again' }));
    await screen.findByRole('alert');

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Try again' })).toHaveAttribute(
        'aria-busy',
        'true',
      );
    });
    expect(screen.getByLabelText('Why')).toBeVisible();
    await act(async () => {
      second.release();
      await second.open;
    });
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it('has no WCAG 2.1 A or AA violations that can be checked without a layout engine with the line drawn', async () => {
    const { container } = draw(failedAgain(new TypeError('Failed to fetch')));

    expect(await wcagViolations(container)).toEqual([]);
  });
});
