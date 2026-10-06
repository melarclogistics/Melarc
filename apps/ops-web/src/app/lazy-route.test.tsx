import { act, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderApp } from '../test-support/render-app';
import { wcagViolations } from '../test-support/wcag';

/** A page whose code arrives only when the test lets it, as a route loaded on demand does. */
function lazyPage() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const route = {
    path: 'later',
    lazy: async () => {
      await gate;
      return { Component: () => <h1 tabIndex={-1}>The page that loaded</h1> };
    },
  };
  return { route, release };
}

describe('a page whose code loads on demand', () => {
  // Break caught: a blank page, and a router warning about a missing fallback, while the code of the first page is
  // still on its way. The frame stays, and a polite status says what is happening.
  it('shows a loading status inside the frame, then the page', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { route, release } = lazyPage();
    renderApp('/later', [route]);

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Loading the page…');
    expect(screen.getByRole('banner')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toBeInTheDocument();
    expect(warn).not.toHaveBeenCalled();

    await act(async () => {
      release();
      await Promise.resolve();
    });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'The page that loaded' }),
    ).toBeVisible();
    expect(screen.queryByRole('status')).toBeNull();
    warn.mockRestore();
  });

  it('has no WCAG violations that can be checked without a layout engine while it loads', async () => {
    const { route } = lazyPage();
    const { container } = renderApp('/later', [route]);

    await screen.findByRole('status');
    expect(await wcagViolations(container)).toEqual([]);
  });
});
