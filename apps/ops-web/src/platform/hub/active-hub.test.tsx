import { act, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useState, type ReactNode } from 'react';

import {
  ActiveHubProvider,
  useActiveHub,
  useHubChoice,
  useHubScope,
  type SessionHub,
} from './active-hub';

const ACCRA: SessionHub = { id: '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d', display_name: 'Accra Hub' };
const KUMASI: SessionHub = {
  id: '6c7d8e9f-0a12-4b3c-9d4e-5f6a7b8c9d0e',
  display_name: 'Kumasi Hub',
};
const TAMALE: SessionHub = {
  id: '7d8e9f0a-1b23-4c4d-8e5f-6a7b8c9d0e1f',
  display_name: 'Tamale Hub',
};

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

const within = (hubs: readonly SessionHub[]) =>
  function Wrapper({ children }: { readonly children: ReactNode }) {
    return <ActiveHubProvider hubs={hubs}>{children}</ActiveHubProvider>;
  };

function both(hubs: readonly SessionHub[]) {
  return renderHook(() => ({ active: useActiveHub(), choice: useHubChoice() }), {
    wrapper: within(hubs),
  });
}

describe('the hub the screens are narrowed to', () => {
  // Break caught: a session that starts on one hub: a person whose grant reaches two hubs would not see the other's work until they found
  // the switcher, and the counts of their menu would be half of what is waiting.
  it('starts at All hubs for a session that lists more than one hub', () => {
    const { result } = both([ACCRA, KUMASI]);

    expect(result.current.active).toBeUndefined();
    expect(result.current.choice.hasChoice).toBe(true);
  });

  // Break caught: a hub id sent for a session that has no choice (one hub: every request would carry a parameter that narrows nothing and
  // changes every read), or an id for a session that lists none.
  it.each([[[]], [[ACCRA]]] as const)(
    'is nothing to narrow for a session that lists %j: there is no choice to make',
    (hubs) => {
      const { result } = both(hubs);

      expect(result.current.active).toBeUndefined();
      expect(result.current.choice.hasChoice).toBe(false);

      act(() => {
        result.current.choice.choose(ACCRA.id);
      });

      expect(result.current.active).toBeUndefined();
    },
  );

  // Break caught: the choice not reaching the screens that read it: the hook that every screen asks is the only place the choice is read.
  it('is the hub that was chosen, and All hubs again when it is chosen', () => {
    const { result } = both([ACCRA, KUMASI, TAMALE]);

    act(() => {
      result.current.choice.choose(KUMASI.id);
    });
    expect(result.current.active).toBe(KUMASI.id);

    act(() => {
      result.current.choice.choose(TAMALE.id);
    });
    expect(result.current.active).toBe(TAMALE.id);

    act(() => {
      result.current.choice.choose(undefined);
    });
    expect(result.current.active).toBeUndefined();
  });

  // Break caught: a hub the session does not list taken as a choice: a screen narrowed to a hub whose work the session cannot see is a screen
  // that shows nothing and says nothing is wrong. (The server decides what a request reaches; the switcher offers only what the session lists.)
  it('ignores a hub the session does not list', () => {
    const { result } = both([ACCRA, KUMASI]);

    act(() => {
      result.current.choice.choose(TAMALE.id);
    });

    expect(result.current.active).toBeUndefined();
  });

  it('shows the hubs in the order the session lists them', () => {
    const { result } = both([KUMASI, ACCRA]);

    expect(result.current.choice.hubs.map((hub) => hub.display_name)).toEqual([
      'Kumasi Hub',
      'Accra Hub',
    ]);
  });

  // Break caught: the choice kept in the browser: the portal stores one thing, the choice of theme, and a hub is not it.
  it('is kept in memory and never in web storage', () => {
    const { result } = both([ACCRA, KUMASI]);

    act(() => {
      result.current.choice.choose(KUMASI.id);
    });

    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
    expect(document.cookie).toBe('');
  });

  // Break caught: the next person to sign in finding the previous person's hub chosen: the shell keys the provider by the session.
  it('starts again for a provider that is mounted anew, as a new session mounts it', () => {
    const first = render(
      <ActiveHubProvider key="one" hubs={[ACCRA, KUMASI]}>
        <Probe />
      </ActiveHubProvider>,
    );
    act(() => {
      first.getByRole('button', { name: 'Choose Kumasi' }).click();
    });
    expect(first.getByTestId('active').textContent).toBe(KUMASI.id);

    first.rerender(
      <ActiveHubProvider key="two" hubs={[ACCRA, KUMASI]}>
        <Probe />
      </ActiveHubProvider>,
    );

    expect(first.getByTestId('active').textContent).toBe('all');
  });

  // Break caught: a screen outside the shell (a page rendered alone, the showcase) failing for want of a provider: it is told nothing and
  // shows what it showed before.
  it('is nothing to narrow outside a provider', () => {
    const { result } = renderHook(() => useActiveHub());

    expect(result.current).toBeUndefined();
  });

  // Break caught: a list that changes under a choice (a hub removed from the session's list) leaving the screens narrowed to a hub the
  // session no longer has.
  it('goes back to All hubs when the chosen hub leaves the list', () => {
    const view = render(
      <ActiveHubProvider hubs={[ACCRA, KUMASI]}>
        <Probe />
      </ActiveHubProvider>,
    );
    act(() => {
      view.getByRole('button', { name: 'Choose Kumasi' }).click();
    });
    expect(view.getByTestId('active').textContent).toBe(KUMASI.id);

    view.rerender(
      <ActiveHubProvider hubs={[ACCRA, TAMALE]}>
        <Probe />
      </ActiveHubProvider>,
    );

    expect(view.getByTestId('active').textContent).toBe('all');
  });

  // Break caught (audit B6, 7 November 2026): a choice that outlives its session, so that the next person to sign in finds the previous person's hub; or
  // one that is thrown away by a remount (a provider keyed by the session remounts the application below it when the session is first read and
  // when it changes): a choice made under another scope is ignored, and the children stay mounted while the scope changes.
  it('ignores a choice made under another scope, and does not remount what is below it', () => {
    let mounts = 0;
    function Counting() {
      useState(() => {
        mounts += 1;
        return 0;
      });
      return <Probe />;
    }
    const view = render(
      <ActiveHubProvider scope="session-one" hubs={[ACCRA, KUMASI]}>
        <Counting />
      </ActiveHubProvider>,
    );
    act(() => {
      view.getByRole('button', { name: 'Choose Kumasi' }).click();
    });
    expect(view.getByTestId('active').textContent).toBe(KUMASI.id);

    view.rerender(
      <ActiveHubProvider scope="session-two" hubs={[ACCRA, KUMASI]}>
        <Counting />
      </ActiveHubProvider>,
    );

    expect(view.getByTestId('active').textContent).toBe('all');
    expect(mounts).toBe(1);
  });

  it('keeps the choice of a scope that does not change', () => {
    const view = render(
      <ActiveHubProvider scope="session-one" hubs={[ACCRA, KUMASI]}>
        <Probe />
      </ActiveHubProvider>,
    );
    act(() => {
      view.getByRole('button', { name: 'Choose Kumasi' }).click();
    });

    view.rerender(
      <ActiveHubProvider scope="session-one" hubs={[ACCRA, KUMASI]}>
        <Probe />
      </ActiveHubProvider>,
    );

    expect(view.getByTestId('active').textContent).toBe(KUMASI.id);
  });
});

describe('what a screen may know of the choice (audit B1, B9)', () => {
  // Break caught: a screen that has to read the whole choice (and so can change it) to say which hub it shows: the narrow hook gives the hub with its
  // name, and nothing that chooses.
  it('gives the hub the screens are narrowed to with its name, and nothing for All hubs', () => {
    const { result } = renderHook(() => ({ scope: useHubScope(), choice: useHubChoice() }), {
      wrapper: within([ACCRA, KUMASI]),
    });
    expect(result.current.scope.hub).toBeUndefined();

    act(() => {
      result.current.choice.choose(KUMASI.id);
    });

    expect(result.current.scope.hub).toEqual(KUMASI);
    expect(Object.keys(result.current.scope).toSorted()).toEqual(['hub', 'showAllHubs']);
  });

  // Break caught: a "Show all hubs" that does nothing, or that chooses another hub.
  it('takes the narrowing off with showAllHubs', () => {
    const { result } = renderHook(
      () => ({ scope: useHubScope(), active: useActiveHub(), choice: useHubChoice() }),
      { wrapper: within([ACCRA, KUMASI]) },
    );
    act(() => {
      result.current.choice.choose(KUMASI.id);
    });
    expect(result.current.active).toBe(KUMASI.id);

    act(() => {
      result.current.scope.showAllHubs();
    });

    expect(result.current.active).toBeUndefined();
    expect(result.current.scope.hub).toBeUndefined();
  });

  it('is nothing outside a provider', () => {
    const { result } = renderHook(() => useHubScope());

    expect(result.current.hub).toBeUndefined();
    expect(() => {
      result.current.showAllHubs();
    }).not.toThrow();
  });
});

function Probe() {
  const active = useActiveHub();
  const { choose } = useHubChoice();
  return (
    <>
      <p data-testid="active">{active ?? 'all'}</p>
      <button
        type="button"
        onClick={() => {
          choose(KUMASI.id);
        }}
      >
        Choose Kumasi
      </button>
    </>
  );
}
