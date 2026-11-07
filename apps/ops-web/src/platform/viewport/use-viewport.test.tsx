import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { stubViewport } from '../../test-support/viewport';
import { currentViewport, useViewport } from './use-viewport';

function Size() {
  return <p>{useViewport()}</p>;
}

let stub: ReturnType<typeof stubViewport> | undefined;
afterEach(() => {
  stub?.restore();
  stub = undefined;
});

describe('the size of the window as the shell tells it', () => {
  // Break caught: a window that cannot be asked (a test with no layout engine, a server render) taken for a phone, which would put every
  // component test and the first paint into the sheet.
  it('is wide where the window cannot be asked', () => {
    expect(currentViewport()).toBe('wide');

    render(<Size />);

    expect(screen.getByText('wide')).toBeVisible();
  });

  // Break caught: a limit moved by a pixel, so that the sidebar is a sheet at 768px where the page (the stylesheet) already draws the wider layout,
  // or the rail at 1280px where it is to be the full sidebar.
  it.each([
    [390, 'narrow'],
    [767, 'narrow'],
    [768, 'medium'],
    [1279, 'medium'],
    [1280, 'wide'],
    [1440, 'wide'],
  ] as const)('tells a window of %s px to be %s', (width, told) => {
    stub = stubViewport(width);

    expect(currentViewport()).toBe(told);
    render(<Size />);
    expect(screen.getByText(told)).toBeVisible();
  });

  // Break caught: the hook's limit and the stylesheets' drifting apart, which no browser test of one width would show: the top bar would draw the
  // button of a sheet at a width where the sidebar is docked, or neither.
  it('has the limit of the narrow size that the frame and the top bar have', () => {
    const source = (path: string): string =>
      readFileSync(resolve(import.meta.dirname, path), 'utf8');
    const hook = source('./use-viewport.ts');
    expect(hook).toContain('(max-width: 47.9375rem)');
    expect(source('../../styles/base.css')).toContain('@media (max-width: 47.9375rem)');
    expect(source('../../components/ui/app-shell/top-bar.css')).toContain(
      '@media (max-width: 47.9375rem)',
    );
  });

  // Break caught: a size read once at the first render, so that a window that is resized, zoomed or turned keeps the sidebar it opened with.
  it('follows the window as it is resized, both ways', () => {
    stub = stubViewport('wide');
    render(<Size />);
    expect(screen.getByText('wide')).toBeVisible();

    act(() => {
      stub?.resize('narrow');
    });
    expect(screen.getByText('narrow')).toBeVisible();

    act(() => {
      stub?.resize('medium');
    });
    expect(screen.getByText('medium')).toBeVisible();

    act(() => {
      stub?.resize('wide');
    });
    expect(screen.getByText('wide')).toBeVisible();
  });

  // Break caught: the listeners of a component that has gone left on the window, which are called for ever.
  it('stops listening when the component has gone', () => {
    stub = stubViewport('wide');
    const view = render(<Size />);
    view.unmount();

    // No listener is left to call: resizing the window after the unmount does not throw and changes nothing on the page.
    expect(() => {
      act(() => {
        stub?.resize('narrow');
      });
    }).not.toThrow();
    expect(screen.queryByText('narrow')).toBeNull();
  });
});
