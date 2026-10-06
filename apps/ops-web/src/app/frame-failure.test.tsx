import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderApp } from '../test-support/render-app';
import { wcagViolations } from '../test-support/wcag';

const fault = vi.hoisted(() => ({ present: true }));

// The frame is what every page sits in, and nothing a test can render inside it can make it fail.
// Making one of its own parts throw is the only way to reach the failure of the frame itself.
vi.mock('../components/SkipLink', () => ({
  SkipLink: () => {
    if (fault.present) {
      throw new Error('connect failed postgres://melarc:hunter2@db.internal/melarc token=abc123');
    }
    return null;
  },
}));

beforeEach(() => {
  fault.present = true;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a failure of the frame itself', () => {
  // Break caught: the router library's own error screen, which prints the error message and its stack
  // to the user. The Ops Portal specification (surfaces/ops-portal.md §8) says the diagnostic message
  // is never shown, whatever failed.
  it('shows the generic message in a main landmark, never the library screen or the error text', async () => {
    renderApp();

    const alert = await screen.findByRole('alert');
    expect(
      within(alert).getByRole('heading', { level: 1, name: 'Something went wrong' }),
    ).toBeVisible();
    expect(screen.getByRole('main')).toContainElement(alert);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(document.body.textContent).not.toMatch(
      /hunter2|postgres|abc123|connect failed|Unexpected Application Error|developer/i,
    );
  });

  // Break caught: a crashed frame that can only be recovered by reloading the browser.
  it('renders the frame again when Try again is pressed and the fault has gone', async () => {
    const { user } = renderApp();
    const retry = await screen.findByRole('button', { name: 'Try again' });

    fault.present = false;
    await user.click(retry);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Melarc Ops Portal' }),
    ).toBeVisible();
    expect(screen.getByRole('banner')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('has no WCAG 2.1 A or AA violations that can be checked without a layout engine', async () => {
    const { container } = renderApp();

    await screen.findByRole('alert');
    expect(await wcagViolations(container)).toEqual([]);
  });
});
