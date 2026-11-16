import { screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi } from '../../../test-support/fake-api';
import { renderWithProviders } from '../../../test-support/render-providers';
import { EvidencePhotoDialog } from './EvidencePhotoDialog';

/**
 * The dialog that opens one photo, on its own: the renewal of a link that arrives with seconds to live is asked for **once**, also in the development build, which runs every effect twice (`StrictMode`, `main.tsx`).
 * The behaviour of the picture that would not load is held with the pages that open a photo (`StopPage.test.tsx`, `IntakePage.test.tsx`).
 */
const EVIDENCE_ID = '0c1d2e3f-4a5b-4c6d-8e7f-000000000001';
const ROUTE = `POST /evidence/${EVIDENCE_ID}/retrieval-authorization`;

let api: FakeApi;
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

const asked = (): number =>
  api.requests.filter((request) => request.url.endsWith('/retrieval-authorization')).length;

describe('the one new link of an opening', () => {
  // Break caught: a link about to run out replaced twice (an effect that runs twice asking each time), so that a photo opened in the development build costs three requests and not two.
  it('is asked for once when a link that arrives with seconds to live is replaced, though the effect runs twice', async () => {
    let issued = 0;
    api = installFakeApi({
      [ROUTE]: () => {
        issued += 1;
        return json(200, {
          method: 'GET',
          url: `https://store.example/evidence/photo?link=${String(issued)}`,
          expires_at: new Date(Date.now() + (issued === 1 ? 4_000 : 5 * 60_000)).toISOString(),
        });
      },
    });
    renderWithProviders(
      <StrictMode>
        <EvidencePhotoDialog
          evidenceId={EVIDENCE_ID}
          label="Parcel photo 1"
          of="stop"
          onClose={() => undefined}
        />
      </StrictMode>,
      { signedIn: true },
    );

    const picture = await screen.findByRole('img', { name: /^Parcel photo 1/ });
    expect(picture).toHaveAttribute('src', 'https://store.example/evidence/photo?link=2');
    await waitFor(() => {
      expect(asked()).toBe(2);
    });
  });
});
