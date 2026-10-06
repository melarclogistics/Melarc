import type { components, paths } from '@melarc/api-client';
import { createBrowserApiClient, type BrowserApiClient } from '@melarc/api-client/browser';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { AppProviders } from '../../app/providers';
import { ApiClientProvider, useApiClient } from './api-client';

const ID = '0190d7c2-7a3e-7c1e-9d2a-3f4b5c6d7e8f';

/** Reports the API client the component can see each time it renders. */
function Probe({ onClient }: { readonly onClient: (client: BrowserApiClient) => void }) {
  onClient(useApiClient());
  return null;
}

function clearCookie(name: string): void {
  document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearCookie('melarc_csrf');
});

describe('ApiClientProvider', () => {
  // Break caught: features finding no API client, which would send them to build their own, each with its own
  // idea of credentials and origin.
  it('gives its descendants the browser API client', () => {
    const seen: BrowserApiClient[] = [];

    render(
      <ApiClientProvider>
        <Probe onClient={(client) => seen.push(client)} />
      </ApiClientProvider>,
    );

    expect(seen).toHaveLength(1);
    expect(typeof seen[0]?.GET).toBe('function');
  });

  // Break caught: a new client built on every render, which would drop anything registered on it.
  it('keeps one client for as long as it stays mounted', () => {
    const seen: BrowserApiClient[] = [];
    // A new element each time: re-rendering the very same element object would make React skip the work.
    const tree = () => (
      <ApiClientProvider>
        <Probe onClient={(client) => seen.push(client)} />
      </ApiClientProvider>
    );
    const { rerender } = render(tree());

    rerender(tree());

    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);
  });

  // Break caught: a client shared between application instances.
  it('creates a separate client for each application instance', () => {
    const seen: BrowserApiClient[] = [];

    for (let instance = 0; instance < 2; instance += 1) {
      const { unmount } = render(
        <ApiClientProvider>
          <Probe onClient={(client) => seen.push(client)} />
        </ApiClientProvider>,
      );
      unmount();
    }

    expect(seen[1]).not.toBe(seen[0]);
  });

  // Break caught: a hook that returns undefined outside the provider, so a feature fails later with a
  // message that does not say what is missing.
  it('tells a feature rendered outside it what is missing', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => render(<Probe onClient={() => undefined} />)).toThrow(
        'useApiClient must be used inside an ApiClientProvider.',
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('the API client the application provides', () => {
  /** The client as `AppProviders` provides it, so the application's own wiring is what is under test. */
  function applicationClient(): BrowserApiClient {
    const seen: BrowserApiClient[] = [];
    render(
      <AppProviders>
        <Probe onClient={(client) => seen.push(client)} />
      </AppProviders>,
    );
    const client = seen[0];
    if (client === undefined) throw new Error('AppProviders provided no API client.');
    return client;
  }

  // Break caught: the application wired to some other client, or to none. This is the real transport,
  // reading the real (jsdom) cookie jar and sending through the global fetch: the same-origin /api/v1 base,
  // the session cookie left to the browser, the CSRF cookie echoed on a state-changing request, and no
  // Bearer credential.
  it('sends a state-changing request to this origin with the CSRF cookie echoed', async () => {
    document.cookie = 'melarc_csrf=tok_from_the_cookie; path=/';
    const sent: Request[] = [];
    vi.stubGlobal('fetch', (request: Request) => {
      sent.push(request);
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    await applicationClient().POST('/pickup-requests/{id}/confirm', {
      params: { path: { id: ID }, header: { 'If-Match': '"3"' } },
    });

    const [request] = sent;
    expect(sent).toHaveLength(1);
    expect(request?.url).toBe(`${window.location.origin}/api/v1/pickup-requests/${ID}/confirm`);
    expect(request?.credentials).toBe('same-origin');
    expect(request?.headers.get('X-CSRF-Token')).toBe('tok_from_the_cookie');
    expect(request?.headers.get('If-Match')).toBe('"3"');
    expect(request?.headers.has('Authorization')).toBe(false);
  });

  // Break caught: the application's client refusing to be used before sign-in, when there is no cookie.
  it('sends a request before sign-in, with no token to echo', async () => {
    const sent: Request[] = [];
    vi.stubGlobal('fetch', (request: Request) => {
      sent.push(request);
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    await applicationClient().DELETE('/auth/session');

    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers.has('X-CSRF-Token')).toBe(false);
  });

  // Break caught: a client that Ops builds with the transport's guard switched off, by passing it another base.
  // A call cannot carry a base URL at all, so the call below is a type error without the cast; what it asks
  // for is refused before anything is sent.
  it('still refuses to leave the /api/v1 of this origin', async () => {
    const send = vi.fn();
    vi.stubGlobal('fetch', send);

    await expect(
      applicationClient().GET('/pickup-requests/{id}', {
        params: { path: { id: ID } },
        baseUrl: 'https://api.melarc.example/v1',
      } as never),
    ).rejects.toThrow('Refusing the call option baseUrl');
    expect(send).not.toHaveBeenCalled();
  });
});

type WireMoney = components['schemas']['Money'];

/**
 * Compile-time proof that Ops consumes the contract's own types instead of a copy: these are the
 * generated shapes, so a value the contract forbids is a type error, and `pnpm typecheck` fails if this
 * one stops being an error. It is exported so that it is part of the checked program and never run: it
 * proves nothing at run time, and the test below does not pretend that it does.
 */
export function wireTypeProofs(): WireMoney[] {
  // @ts-expect-error the contract's only currency is GHS.
  const wrongCurrency: WireMoney = { amount_minor: 1, currency: 'USD' };
  return [{ amount_minor: 2550, currency: 'GHS' }, wrongCurrency];
}

describe('the wire types', () => {
  // Break caught (by `pnpm typecheck`, which compiles this file; at run time the type assertions are no-ops):
  // the types Ops gets from the package entry point drifting from the contract, or Ops being given a client
  // that is not typed by the contract's paths. A widened currency, a number that became a string, a client
  // that accepts a path the contract does not have, or one that offers a verb for a path that has none,
  // each make an assertion below a type error.
  it('are the types of the contract, and type the client Ops is given', () => {
    expectTypeOf<WireMoney['currency']>().toEqualTypeOf<'GHS'>();
    expectTypeOf<WireMoney['amount_minor']>().toEqualTypeOf<number>();

    type PostPath = Parameters<BrowserApiClient['POST']>[0];
    type GetPath = Parameters<BrowserApiClient['GET']>[0];
    expectTypeOf<PostPath>().toExtend<keyof paths>();
    expectTypeOf<'/pickup-requests/{id}/confirm'>().toExtend<PostPath>();
    expectTypeOf<'/pickup-requests/{id}/confirm'>().not.toExtend<GetPath>();
    expectTypeOf<'/pickup-requests/{id}'>().toExtend<GetPath>();
    expectTypeOf<'/not-in-the-contract'>().not.toExtend<PostPath>();
    expectTypeOf<'/not-in-the-contract'>().not.toExtend<GetPath>();
  });

  // Break caught: the entry point handing Ops something other than the restricted client: a method that lets a
  // feature add middleware or swap the sender (`use`, `eject`), or one that can be changed after it was made.
  it('come with a client that has the HTTP verbs and nothing more, and cannot be changed', () => {
    const client = createBrowserApiClient({ origin: window.location.origin });

    expect(Object.keys(client).toSorted()).toEqual([
      'DELETE',
      'GET',
      'HEAD',
      'OPTIONS',
      'PATCH',
      'POST',
      'PUT',
      'TRACE',
      'request',
    ]);
    expect(Object.isFrozen(client)).toBe(true);
  });
});
