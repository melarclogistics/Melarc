import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi } from '../../test-support/fake-api';
import { RIDER_ID, riderFixture } from '../../test-support/rider-fixture';
import { renderWithProviders } from '../../test-support/render-providers';
import { etag, sessionWith, staffApi } from '../../test-support/staff-api';
import { useRiderName } from './use-rider-queries';

let api: FakeApi;
afterEach(() => {
  api.restore();
});

function Name({ label }: { readonly label: string }) {
  const name = useRiderName(RIDER_ID);
  return (
    <p>
      {label}: {name.data ?? '-'}
    </p>
  );
}

/** A roster that says a different name each time it is asked, and counts the asking. */
function roster() {
  const state = { reads: 0 };
  api = installFakeApi(
    staffApi(sessionWith(['dispatch.read']), {
      [`GET /ops/riders/${RIDER_ID}`]: () => {
        state.reads += 1;
        return json(
          200,
          { rider: riderFixture({ full_name: `Name ${String(state.reads)}` }), devices: [] },
          etag('v1'),
        );
      },
    }),
  );
  return state;
}

describe('useRiderName: kept while a page that names the rider is mounted, and read again on the next visit (run 7, Stage 2.4)', () => {
  // Break caught: a name read for every component that names the rider (sixteen reads in the minute of a journey, the review of f6cf02b): one that mounts later, while the page stays, is told
  // the name the page read and reads nothing.
  it('is read once, however many components name the rider, one that mounts later among them', async () => {
    const state = roster();
    const view = renderWithProviders(<Name label="facts" />);
    expect(await screen.findByText('facts: Name 1')).toBeVisible();

    view.rerenderUi(
      <>
        <Name label="facts" />
        <Name label="question" />
      </>,
    );

    expect(await screen.findByText('question: Name 1')).toBeVisible();
    expect(state.reads).toBe(1);
  });

  // Break caught (the Product Owner's review of 198e5be): a name kept for the session on a key shared by every page, so that a rider renamed since the last visit was named as before. It is let
  // go of when the last component that names the rider goes, and the next visit reads it again.
  it('is let go of when nothing names the rider any more, and read again by the next visit', async () => {
    const state = roster();
    const view = renderWithProviders(<Name label="facts" />);
    expect(await screen.findByText('facts: Name 1')).toBeVisible();

    view.rerenderUi(<p>Another page</p>);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      view.queryClient.getQueryCache().find({ queryKey: ['riders', 'name', RIDER_ID] }),
    ).toBeUndefined();

    view.rerenderUi(<Name label="facts" />);
    expect(await screen.findByText('facts: Name 2')).toBeVisible();
    expect(state.reads).toBe(2);
  });

  // Break caught: the entry let go of while another component still names the rider (a dialog closing while the page's facts stay).
  it('is kept while one of two components that name the rider is still mounted', async () => {
    const state = roster();
    const view = renderWithProviders(
      <>
        <Name label="facts" />
        <Name label="question" />
      </>,
    );
    expect(await screen.findByText('facts: Name 1')).toBeVisible();

    view.rerenderUi(<Name label="facts" />);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.getByText('facts: Name 1')).toBeVisible();
    expect(state.reads).toBe(1);
  });
});
