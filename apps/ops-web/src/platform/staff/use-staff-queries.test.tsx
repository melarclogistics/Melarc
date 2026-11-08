import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi } from '../../test-support/fake-api';
import { renderWithProviders } from '../../test-support/render-providers';
import { bundlesAnswer, etag, staffPage } from '../../test-support/staff-api';
import {
  sessionRecordFixture,
  STAFF_ID,
  staffIdentityFixture,
} from '../../test-support/staff-fixture';
import {
  useAssignableBundles,
  useSessionRecords,
  useStaffIdentity,
  useStaffList,
} from './use-staff-queries';

let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

/** One screen that asks for every read, so that what the reads do between them is what is seen. */
function Everything() {
  const list = useStaffList({ status: 'PENDING_APPROVAL' });
  const person = useStaffIdentity(STAFF_ID);
  const sessions = useSessionRecords('STAFF', STAFF_ID);
  const bundles = useAssignableBundles();
  const ready = [list, person, sessions, bundles].every((query) => query.status === 'success');
  return <p>{ready ? 'Everything is read' : 'Reading'}</p>;
}

function open() {
  api = installFakeApi({
    'GET /staff-identities': () => staffPage([staffIdentityFixture()]),
    [`GET /staff-identities/${STAFF_ID}`]: () => json(200, staffIdentityFixture(), etag('v1')),
    'GET /auth/sessions': () => json(200, { items: [sessionRecordFixture()] }),
    'GET /staff-role-bundles/assignable': bundlesAnswer,
  });
  return renderWithProviders(<Everything />, { signedIn: true });
}

describe('the reads of the identity screens', () => {
  // Break caught: a page that reads again whenever the window is focused, which keeps a session alive that its owner has walked away from
  // (every request the API accepts counts as activity) and moves the version a person is about to act on.
  it('are not read again when the window is focused or the page becomes visible', async () => {
    open();
    await screen.findByText('Everything is read');
    const before = api.requests.length;

    // What Query listens to: the page becoming visible again (the event bubbles from the document to the window), and the connection coming
    // back after it was lost.
    act(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
      window.dispatchEvent(new Event('offline'));
      window.dispatchEvent(new Event('online'));
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(api.requests).toHaveLength(before);
  });

  // Break caught: a profile, a list or a session kept after the screen lets go of it: the next visit would show the last answer first, with
  // the version of the last read, and a person's data would stay in memory for the next person on the browser.
  it('are not kept once the screen lets go of them, except the list of roles, which is configuration', async () => {
    const view = open();
    await screen.findByText('Everything is read');

    view.unmount();

    await waitFor(() => {
      expect(
        view.queryClient.getQueryCache().findAll({ queryKey: ['staff', 'list'] }),
      ).toHaveLength(0);
    });
    expect(
      view.queryClient.getQueryCache().findAll({ queryKey: ['staff', 'identity'] }),
    ).toHaveLength(0);
    expect(view.queryClient.getQueryCache().findAll({ queryKey: ['sessions'] })).toHaveLength(0);
    expect(
      view.queryClient.getQueryCache().findAll({ queryKey: ['staff', 'assignable-bundles'] }),
    ).toHaveLength(1);
  });
});
