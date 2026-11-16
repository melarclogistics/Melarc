import { focusManager } from '@tanstack/react-query';
import { act, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi } from '../../test-support/fake-api';
import {
  EVIDENCE_LIMITS,
  OTHER_RUN_ID,
  PLANTED_BLIND_NUMBER,
  RUN_ID,
  blindVendorFixture,
  missingParcelFixture,
  photoVendorFixture,
  runFixture,
  runPage,
  runSummaryFixture,
} from '../../test-support/receiving-fixture';
import { renderWithProviders } from '../../test-support/render-providers';
import {
  LOOKUP_MIN,
  useEvidenceLimits,
  useMissingParcels,
  useReceivingRun,
  useReceivingRuns,
} from './use-receiving-queries';

/**
 * The reads of the receiving screens of a run are the one place a request for each is made, so they are where a filter is kept off the wire unless it was given (the page filters nothing), where a lookup
 * shorter than the server takes is never sent, where nothing is read again on focus (every accepted request is activity), where nothing is kept once the screen lets go, and where an answer that is not the
 * run asked about, or that leaks a blind-count vendor's number, is a failure and not a page.
 */
let api: FakeApi;
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

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

const requestsTo = (path: string) =>
  api.requests.filter((request) => new URL(request.url).pathname === `/api/v1${path}`);
const queryOf = (path: string) => new URL(requestsTo(path)[0]?.url ?? 'http://x/').searchParams;

describe('the queue by run', () => {
  const ask = async (params: Parameters<typeof useReceivingRuns>[0]) => {
    api = installFakeApi({
      'GET /receiving-runs': () => json(200, runPage([runSummaryFixture()])),
    });
    const view = renderWithProviders(
      <Probe use={() => useReceivingRuns(params)} into={() => undefined} />,
      { signedIn: true },
    );
    await waitFor(() => {
      expect(requestsTo('/receiving-runs')).toHaveLength(1);
    });
    return view;
  };

  it('asks for no filter when none is given', async () => {
    await ask({});
    expect([...queryOf('/receiving-runs').keys()]).toEqual([]);
  });

  // Break caught: a filter that is not sent, or sent twice: the page filters nothing, so a dropped parameter would pass for the whole queue.
  it('asks for the view, the hub, the lookup and the page it is given, each once and as the contract names it', async () => {
    await ask({ view: 'needs_decision', hubId: 'hub-1', q: '  kente  ', pageToken: 'next-1' });
    const query = queryOf('/receiving-runs');
    expect(query.get('view')).toBe('needs_decision');
    expect(query.get('hub_id')).toBe('hub-1');
    expect(query.get('q')).toBe('kente');
    expect(query.get('page_token')).toBe('next-1');
    for (const name of ['view', 'hub_id', 'q', 'page_token']) {
      expect(query.getAll(name)).toHaveLength(1);
    }
  });

  // Break caught: a lookup of one character sent: the server refuses it as VALIDATION_FAILED, so the page would show a failure for a person who has only begun to type.
  it('never sends a lookup shorter than the server takes, or longer', async () => {
    expect(LOOKUP_MIN).toBe(2);
    await ask({ q: 'k' });
    expect(queryOf('/receiving-runs').has('q')).toBe(false);
    api.restore();
    await ask({ q: 'x'.repeat(65) });
    expect(queryOf('/receiving-runs').has('q')).toBe(false);
  });

  it('is not read again when the window gets focus again, and keeps nothing once the screen lets go', async () => {
    const view = await ask({});
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(requestsTo('/receiving-runs')).toHaveLength(1);
    view.unmount();
    await waitFor(() => {
      expect(
        view.queryClient.getQueryCache().findAll({ queryKey: ['hub-receiving'] }),
      ).toHaveLength(0);
    });
  });

  it('asks nothing while it is not enabled', async () => {
    api = installFakeApi({});
    renderWithProviders(
      <Probe use={() => useReceivingRuns({ enabled: false })} into={() => undefined} />,
      {
        signedIn: true,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(requestsTo('/receiving-runs')).toHaveLength(0);
  });
});

describe('a run’s page', () => {
  const read = async (answer: () => Response, id = RUN_ID) => {
    api = installFakeApi({ [`GET /receiving-runs/${id}`]: answer });
    let result: ReturnType<typeof useReceivingRun> | undefined;
    renderWithProviders(
      <Probe
        use={() => useReceivingRun(id)}
        into={(value) => {
          result = value;
        }}
      />,
      { signedIn: true },
    );
    await waitFor(() => {
      expect(result?.isFetching).toBe(false);
    });
    return result;
  };

  it('is read for the run asked about, with a token for each vendor and none in a header', async () => {
    const result = await read(() => json(200, runFixture([photoVendorFixture(2)])));
    expect(result?.data?.vendors[0]?.intake_etag).toBe('"kente-1"');
  });

  // Break caught: another run’s page shown as the one asked about.
  it('fails as an answer that is not the API’s when it is another run’s page', async () => {
    const result = await read(() => json(200, runFixture([photoVendorFixture(2)])), OTHER_RUN_ID);
    expect(result?.isError).toBe(true);
    expect(result?.data).toBeUndefined();
  });

  // Break caught: a blind-count vendor’s number drawn because the page read it: the shape refuses the whole answer.
  it('fails as an answer that is not the API’s when a blind-count vendor carries the rider’s number', async () => {
    const result = await read(() =>
      json(200, runFixture([blindVendorFixture({ parcels_expected: PLANTED_BLIND_NUMBER })])),
    );
    expect(result?.isError).toBe(true);
    expect(JSON.stringify(result?.error)).not.toContain(String(PLANTED_BLIND_NUMBER));
  });
});

describe('the missing list and the limits of evidence', () => {
  it('asks for the view and the hub it is given', async () => {
    api = installFakeApi({
      'GET /missing-parcels': () => json(200, runPage([missingParcelFixture(1)])),
    });
    renderWithProviders(
      <Probe
        use={() => useMissingParcels({ view: 'vendor_to_tell', hubId: 'hub-1' })}
        into={() => undefined}
      />,
      { signedIn: true },
    );
    await waitFor(() => {
      expect(requestsTo('/missing-parcels')).toHaveLength(1);
    });
    expect(queryOf('/missing-parcels').get('view')).toBe('vendor_to_tell');
    expect(queryOf('/missing-parcels').get('hub_id')).toBe('hub-1');
  });

  // Break caught: the limits read again for every upload: they are configuration, read once for the page, and a failed read is not a guessed limit.
  it('reads the limits once for the page and keeps them', async () => {
    api = installFakeApi({ 'GET /evidence-limits': () => json(200, EVIDENCE_LIMITS) });
    let results: ReturnType<typeof useEvidenceLimits>[] = [];
    function Twice() {
      results = [useEvidenceLimits(), useEvidenceLimits()];
      return null;
    }
    renderWithProviders(<Twice />, { signedIn: true });
    await waitFor(() => {
      expect(results[0]?.data?.max_byte_size).toBe(EVIDENCE_LIMITS.max_byte_size);
    });
    expect(requestsTo('/evidence-limits')).toHaveLength(1);
  });

  it('fails, and guesses no limit, when the answer is not the limits', async () => {
    api = installFakeApi({
      'GET /evidence-limits': () => json(200, { allowed_content_types: [] }),
    });
    let result: ReturnType<typeof useEvidenceLimits> | undefined;
    renderWithProviders(
      <Probe
        use={() => useEvidenceLimits()}
        into={(value) => {
          result = value;
        }}
      />,
      { signedIn: true },
    );
    await waitFor(() => {
      expect(result?.isError).toBe(true);
    });
    expect(result?.data).toBeUndefined();
  });
});
