import { focusManager } from '@tanstack/react-query';
import { act, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi } from '../../test-support/fake-api';
import {
  WORK_EVIDENCE_ID,
  disputeFixture,
  evidenceItemFixture,
  evidenceListFixture,
  failureFixture,
  opsHandshakeFixture,
  shortfallFixture,
} from '../../test-support/pickup-work-fixture';
import { renderWithProviders } from '../../test-support/render-providers';
import {
  STOP_EVIDENCE_PAGE_SIZE,
  useCollectionDisputes,
  useCollectionShortfalls,
  useHandshakesForOps,
  usePhotoAuthorization,
  usePickupFailures,
  useStopEvidence,
  type WorkListParams,
} from './use-pickup-work-queries';

/**
 * The reads of the screens of the door and the failure (S1.30) are the one place a request for each is made, so they are where a filter is kept off the wire unless it was given, where nothing is read
 * again on focus (every accepted request is activity), where nothing is kept once the screen lets go (the version an act takes is the one just read, and the authorization of a photo is a bearer
 * capability that only the open photo holds), and where a stop's evidence is read a page at a time. The screens' own use of them is tried in their page tests; this holds the reads alone.
 */
const STOP = '8d9e0f1a-2b3c-4d4e-8f5a-6b7c8d9e0f1a';
let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

const page = (items: unknown[]): Response => json(200, { items, next_page_token: null });
const queryOf = (index = 0): URLSearchParams =>
  new URL(
    api.requests.filter((request) => !request.url.includes('queue-summary'))[index]?.url ??
      'http://x/',
  ).searchParams;

function Probe<Result>({
  use,
  into,
}: {
  readonly use: () => Result;
  readonly into: (result: Result) => void;
}) {
  into(use());
  return null;
}

const LISTS = [
  ['usePickupFailures', '/pickup-failures', usePickupFailures, failureFixture()],
  ['useHandshakesForOps', '/handshakes-for-ops', useHandshakesForOps, opsHandshakeFixture()],
  [
    'useCollectionShortfalls',
    '/collection-shortfalls',
    useCollectionShortfalls,
    shortfallFixture(),
  ],
  ['useCollectionDisputes', '/collection-disputes', useCollectionDisputes, disputeFixture()],
] as const;

describe.each(LISTS)('%s', (_name, path, hook, item) => {
  const ask = async (params: WorkListParams) => {
    api = installFakeApi({ [`GET ${path}`]: () => page([item]) });
    const view = renderWithProviders(<Probe use={() => hook(params)} into={() => undefined} />, {
      signedIn: true,
    });
    await waitFor(() => {
      expect(api.requests.some((request) => request.url.includes(path))).toBe(true);
    });
    return view;
  };

  it('asks for no filter when none is given', async () => {
    await ask({});

    expect([...queryOf().keys()]).toEqual([]);
  });

  // Break caught: a filter sent when it was not given, or one that is not sent when it was: the page filters nothing, so a dropped parameter would pass for the whole list.
  it('asks for the filter, the hub and the page it is given, each as the contract names it', async () => {
    await ask({ open: false, hubId: '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d', pageToken: 'next-1' });

    expect(queryOf().get('open')).toBe('false');
    expect(queryOf().get('hub_id')).toBe('5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d');
    expect(queryOf().get('page_token')).toBe('next-1');
    expect(queryOf().getAll('open')).toHaveLength(1);
  });

  it('asks nothing while it is not enabled', async () => {
    api = installFakeApi({});
    renderWithProviders(<Probe use={() => hook({ enabled: false })} into={() => undefined} />, {
      signedIn: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(api.requests.filter((request) => request.url.includes(path))).toHaveLength(0);
  });

  // Break caught: a list read again when the window gets focus: every accepted request is activity, so a page that read on its own would hold a session open.
  it('is not read again when the window gets focus again', async () => {
    await ask({});

    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(api.requests.filter((request) => request.url.includes(path))).toHaveLength(1);
  });

  // Break caught: an answer kept once its screen is gone, so that the version of the next act, or the rows of another visit, are a stale read.
  it('keeps nothing once the screen lets go', async () => {
    const view = await ask({});
    await waitFor(() => {
      expect(
        view.queryClient.getQueryCache().findAll({ queryKey: ['pickup-work'] }).length,
      ).toBeGreaterThan(0);
    });

    view.unmount();

    await waitFor(() => {
      expect(view.queryClient.getQueryCache().findAll({ queryKey: ['pickup-work'] })).toHaveLength(
        0,
      );
    });
  });
});

describe('the evidence of a stop', () => {
  it('is asked for a page of the largest size the contract allows, with no purpose and no position', async () => {
    api = installFakeApi({
      [`GET /pickup-stops/${STOP}/evidence`]: () => json(200, evidenceListFixture()),
    });
    renderWithProviders(
      <Probe use={() => useStopEvidence(STOP, undefined)} into={() => undefined} />,
      { signedIn: true },
    );

    await waitFor(() => {
      expect(api.requests.some((request) => request.url.includes('/evidence'))).toBe(true);
    });
    expect(STOP_EVIDENCE_PAGE_SIZE).toBe(100);
    expect(queryOf().get('page_size')).toBe('100');
    expect(queryOf().has('purpose')).toBe(false);
    expect(queryOf().has('page_token')).toBe(false);
  });

  // Break caught: a purpose that is not sent (the list would not be narrowed), or a next page asked for by anything but the position the server gave.
  it('asks for the purpose it is given, and for the next page by the position the server gave and by nothing else', async () => {
    let result: ReturnType<typeof useStopEvidence> | undefined;
    api = installFakeApi({
      [`GET /pickup-stops/${STOP}/evidence`]: (request) =>
        new URL(request.url).searchParams.get('page_token') === 'p2'
          ? json(
              200,
              evidenceListFixture({ items: [evidenceItemFixture({ id: WORK_EVIDENCE_ID })] }),
            )
          : json(
              200,
              evidenceListFixture({
                items: [evidenceItemFixture({ id: '0c1d2e3f-4a5b-4c6d-8e7f-000000000002' })],
                next_page_token: 'p2',
              }),
            ),
    });
    renderWithProviders(
      <Probe
        use={() => useStopEvidence(STOP, 'PARCEL_PHOTO')}
        into={(value) => {
          result = value;
        }}
      />,
      { signedIn: true },
    );

    await waitFor(() => {
      expect(result?.data?.pages).toHaveLength(1);
    });
    expect(queryOf(0).get('purpose')).toBe('PARCEL_PHOTO');
    expect(result?.hasNextPage).toBe(true);
    await act(async () => {
      await result?.fetchNextPage();
    });

    await waitFor(() => {
      expect(result?.data?.pages).toHaveLength(2);
    });
    expect(queryOf(1).get('page_token')).toBe('p2');
    expect(queryOf(1).get('purpose')).toBe('PARCEL_PHOTO');
    expect(queryOf(1).get('page_size')).toBe('100');
    expect(result?.hasNextPage).toBe(false);
  });
});

describe('the authorization of a photo', () => {
  const authorization = {
    method: 'GET',
    url: 'https://store.example/evidence/abc?token=t',
    expires_at: '2026-11-04T09:36:00Z',
  };
  const ROUTE = `POST /evidence/${WORK_EVIDENCE_ID}/retrieval-authorization`;

  // Break caught: an authorization asked for before its photo is opened (a tile that asked would ask for every photo of the stop).
  it('is not asked for until the photo is opened', async () => {
    api = installFakeApi({});
    renderWithProviders(
      <Probe use={() => usePhotoAuthorization(WORK_EVIDENCE_ID, false)} into={() => undefined} />,
      {
        signedIn: true,
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      api.requests.filter((request) => request.url.includes('retrieval-authorization')),
    ).toHaveLength(0);
  });

  // Break caught: a bearer capability kept in memory once its photo is closed (it is held only while the photo is open), or one that is read again by itself.
  it('is asked for once, kept by nothing but the open photo, and dropped the moment it is closed', async () => {
    let result: ReturnType<typeof usePhotoAuthorization> | undefined;
    api = installFakeApi({ [ROUTE]: () => json(200, authorization) });
    const view = renderWithProviders(
      <Probe
        use={() => usePhotoAuthorization(WORK_EVIDENCE_ID, true)}
        into={(value) => {
          result = value;
        }}
      />,
      { signedIn: true },
    );

    await waitFor(() => {
      expect(result?.data?.url).toBe(authorization.url);
    });
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      api.requests.filter((request) => request.url.includes('retrieval-authorization')),
    ).toHaveLength(1);

    view.unmount();

    await waitFor(() => {
      expect(
        view.queryClient
          .getQueryCache()
          .findAll({ queryKey: ['pickup-work', 'photo-authorization'] }),
      ).toHaveLength(0);
    });
  });
});
