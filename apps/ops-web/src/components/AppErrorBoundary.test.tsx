import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../test-support/wcag';
import { AppErrorBoundary } from './AppErrorBoundary';

const fault = { present: true };

function Bomb() {
  if (fault.present) throw new Error('db password=hunter2 host=db.internal');
  return <p>Working page</p>;
}

beforeEach(() => {
  fault.present = true;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AppErrorBoundary', () => {
  // Break caught: a boundary that hides working content, or announces an error when nothing failed.
  it('shows its children when nothing fails', () => {
    fault.present = false;
    render(
      <AppErrorBoundary>
        <Bomb />
      </AppErrorBoundary>,
    );

    expect(screen.getByText('Working page')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // Break caught: a blank page when something outside any route throws, or the error text (which can
  // carry credentials) put in front of the user (surfaces/ops-portal.md §8).
  it('replaces a failed tree with an announced, generic message in a main landmark', () => {
    render(
      <AppErrorBoundary>
        <Bomb />
      </AppErrorBoundary>,
    );

    const alert = screen.getByRole('alert');
    expect(
      within(alert).getByRole('heading', { level: 1, name: 'Something went wrong' }),
    ).toBeVisible();
    expect(screen.getByRole('main')).toContainElement(alert);
    expect(screen.queryByText('Working page')).toBeNull();
    expect(document.body.textContent).not.toMatch(/hunter2|password|db\.internal/);
  });

  // Break caught: a crashed application that can only be recovered by reloading the browser.
  it('runs its children again when Try again is pressed, and recovers if the fault has gone', async () => {
    const user = userEvent.setup();
    render(
      <AppErrorBoundary>
        <Bomb />
      </AppErrorBoundary>,
    );

    fault.present = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.getByText('Working page')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the message again, not a blank page, when the retry fails too', async () => {
    const user = userEvent.setup();
    render(
      <AppErrorBoundary>
        <Bomb />
      </AppErrorBoundary>,
    );

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  it('has no WCAG 2.1 A or AA violations that can be checked without a layout engine', async () => {
    const { container } = render(
      <AppErrorBoundary>
        <Bomb />
      </AppErrorBoundary>,
    );

    expect(await wcagViolations(container)).toEqual([]);
  });
});
