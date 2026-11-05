import { waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi } from '../../test-support/fake-api';
import { renderWithProviders } from '../../test-support/render-providers';
import { useManifests, type ManifestListParams } from './use-manifest-queries';

/**
 * The read of the manifest list (`listPickupManifests`, OB-S1-25) is the one place a request for it is made, so it is where a value the contract
 * would refuse is kept off the wire whoever asked: a state that is not one of the five, a day that does not exist, an empty text. The screen's own
 * reading of the address is tried in its page tests; this holds the read alone.
 */
const LIST = 'GET /pickup-manifests';
let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

function Probe(params: ManifestListParams) {
  useManifests(params);
  return null;
}

async function ask(params: ManifestListParams): Promise<URLSearchParams> {
  api = installFakeApi({ [LIST]: () => json(200, { items: [], next_page_token: null }) });
  renderWithProviders(<Probe {...params} />, { signedIn: true });
  await waitFor(() => {
    expect(api.requests).toHaveLength(1);
  });
  return new URL(api.requests[0]?.url ?? 'http://x/').searchParams;
}

describe('the read of the manifest list', () => {
  it('asks for no filter when none is given', async () => {
    expect([...(await ask({})).keys()]).toEqual([]);
  });

  it('asks for the state and the day it is given, and the page token with them', async () => {
    const query = await ask({
      state: 'IN_PROGRESS',
      serviceDate: '2026-11-04',
      pageToken: 'next-1',
    });

    expect(query.get('state')).toBe('IN_PROGRESS');
    expect(query.get('service_date')).toBe('2026-11-04');
    expect(query.get('page_token')).toBe('next-1');
  });

  // Break caught: a state the contract would refuse sent as it was given (another case, an empty text, a word it does not have).
  it.each(['draft', 'Draft', '', ' DRAFT', 'ASSIGNED'])(
    'leaves out the state %j',
    async (state) => {
      expect((await ask({ state: state as never })).has('state')).toBe(false);
    },
  );

  // Break caught: a day the contract would refuse sent as it was given.
  it.each(['2026-02-30', '', '2026-11-4', 'tomorrow', '2026-11-04T00:00:00Z', '0000-01-01'])(
    'leaves out the day %j',
    async (serviceDate) => {
      expect((await ask({ serviceDate })).has('service_date')).toBe(false);
    },
  );

  it('keeps the filter that is sound when the other is not', async () => {
    const query = await ask({ state: 'DRAFT', serviceDate: '2026-02-30' });

    expect(query.get('state')).toBe('DRAFT');
    expect(query.has('service_date')).toBe(false);
  });
});
