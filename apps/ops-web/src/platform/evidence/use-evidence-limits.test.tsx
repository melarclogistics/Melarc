import { act, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { errorResponse, installFakeApi, json, type FakeApi } from '../../test-support/fake-api';
import { renderWithProviders } from '../../test-support/render-providers';
import type { EvidenceLimitsView } from './evidence-limits';
import { useEvidenceLimits } from './use-evidence-limits';

/**
 * The limits of a file of evidence are the platform's configuration, read once for the session by whoever draws a file chooser (`getEvidenceLimits`, OB-S1-110), so that a file above the size limit is refused
 * before it is read whole. **A read that fails gives no limit and the portal guesses none**: the platform still refuses what it will not take.
 */
let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

const BODY = { allowed_content_types: ['image/jpeg', 'image/png'], max_byte_size: 10_485_760 };
const requestsForLimits = () =>
  api.requests.filter((request) => new URL(request.url).pathname.endsWith('/evidence-limits'));

function Probe({ into }: { readonly into: (limits: EvidenceLimitsView | undefined) => void }) {
  into(useEvidenceLimits().data);
  return null;
}

describe('useEvidenceLimits', () => {
  // Break caught: a read for every file chooser on the page (a run page draws one for each vendor), each a request of the session's, or limits that are read again on every focus.
  it('reads the limits once for the whole session and gives the same ones to every chooser', async () => {
    api = installFakeApi({ 'GET /evidence-limits': () => json(200, BODY) });
    const seen: (EvidenceLimitsView | undefined)[] = [];
    const view = renderWithProviders(
      <>
        <Probe into={(limits) => seen.push(limits)} />
        <Probe into={(limits) => seen.push(limits)} />
      </>,
      { signedIn: true },
    );

    await waitFor(() => {
      expect(seen.at(-1)).toEqual({
        allowedTypes: ['image/jpeg', 'image/png'],
        maxBytes: 10_485_760,
      });
    });
    // A chooser drawn later, and the window taking focus again, ask nothing more.
    view.rerenderUi(
      <>
        <Probe into={(limits) => seen.push(limits)} />
        <Probe into={(limits) => seen.push(limits)} />
        <Probe into={(limits) => seen.push(limits)} />
      </>,
    );
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });

    expect(requestsForLimits()).toHaveLength(1);
  });

  // Break caught: a limit invented when the read failed (10 MB "because that is what it was"), which would refuse files the platform takes or wave through files it will not.
  it.each([
    [
      'the platform could not read its own settings',
      () => errorResponse(503, 'SERVICE_UNAVAILABLE'),
    ],
    ['it answered with a body that is not the limits', () => json(200, { max_byte_size: 10 })],
  ])('gives no limits when %s', async (_name, answer) => {
    api = installFakeApi({ 'GET /evidence-limits': answer });
    const seen: (EvidenceLimitsView | undefined)[] = [];
    renderWithProviders(<Probe into={(limits) => seen.push(limits)} />, { signedIn: true });

    await waitFor(() => {
      expect(requestsForLimits()).toHaveLength(1);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(seen.every((limits) => limits === undefined)).toBe(true);
    // And it is not asked again and again: the next attempt is the person's, on the next form.
    expect(requestsForLimits()).toHaveLength(1);
  });
});
