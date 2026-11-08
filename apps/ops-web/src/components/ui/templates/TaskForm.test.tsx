import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { Button } from '../button/Button';
import { dismissToast, Toaster } from '../toast/Toast';
import {
  announceTaskDone,
  TaskForm,
  TaskFormSection,
  TaskFormWide,
  type TaskFormProps,
} from './TaskForm';

// jsdom has no pointer capture, which Sonner takes when a button of a toast is pressed.
beforeAll(() => {
  for (const name of ['setPointerCapture', 'releasePointerCapture'] as const) {
    if (typeof Element.prototype[name] !== 'function') Element.prototype[name] = () => undefined;
  }
});

afterEach(() => {
  act(() => {
    dismissToast();
  });
});

function props(overrides: Partial<TaskFormProps> = {}): TaskFormProps {
  return {
    header: { title: 'Book a pickup' },
    onSubmit: (event) => {
      event.preventDefault();
    },
    actions: <Button type="submit">Book the pickup</Button>,
    children: (
      <>
        <TaskFormSection title="The sender" description="Who the pickup is for.">
          <label>
            Name
            <input name="name" />
          </label>
          <TaskFormWide>
            <label>
              Landmark
              <input name="landmark" />
            </label>
          </TaskFormWide>
        </TaskFormSection>
        <TaskFormSection title="What is collected">
          <label>
            Packages
            <input name="packages" />
          </label>
        </TaskFormSection>
      </>
    ),
    ...overrides,
  };
}

function renderForm(overrides: Partial<TaskFormProps> = {}) {
  return render(
    <MemoryRouter>
      <TaskForm {...props(overrides)} />
    </MemoryRouter>,
  );
}

describe('TaskForm', () => {
  // Break caught: sections that are not headed, in the order the page gave them, or a form that checks fields by itself and shows the browser's own bubbles.
  it('draws the sections in order, each under its own heading, in a form that does not validate itself', () => {
    const { container } = renderForm();

    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual(['The sender', 'What is collected']);
    expect(screen.getByRole('heading', { level: 1, name: 'Book a pickup' })).toBeVisible();
    expect(screen.getByText('Who the pickup is for.')).toBeVisible();
    expect(container.querySelector('form')).toHaveAttribute('novalidate');
    expect(container.querySelector('.ui-task-form__wide')).toContainElement(
      screen.getByLabelText('Landmark'),
    );
  });

  // Break caught: a submit that does not reach the page (which checks, tells each field and sends), or that is not marked busy while it is sent.
  it('hands the submit to the page and says it is busy while it is sent', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => {
      event.preventDefault();
    });
    const { container, rerender } = renderForm({ onSubmit });
    expect(container.querySelector('form')).not.toHaveAttribute('aria-busy');

    await user.click(screen.getByRole('button', { name: 'Book the pickup' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);

    rerender(
      <MemoryRouter>
        <TaskForm {...props({ busy: true })} />
      </MemoryRouter>,
    );
    expect(container.querySelector('form')).toHaveAttribute('aria-busy', 'true');
  });

  // Break caught: a summary that the page cannot put beside the sections, or one that is not a named region.
  it('draws the summary in a named region beside the sections', () => {
    renderForm({
      summary: { title: 'What the server states', children: <p>An estimate, not a price.</p> },
    });

    const rail = screen.getByRole('complementary', { name: 'What the server states' });
    expect(within(rail).getByText('An estimate, not a price.')).toBeVisible();
  });

  // Break caught: a review that loses what was entered (the sections unmounted), one that is a second form, or one with no way back.
  it('shows the review in place of the sections, keeps the sections, and goes back', async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const { container } = renderForm({
      review: { active: true, onBack, children: <p>One pickup will be booked.</p> },
    });

    expect(screen.getByRole('heading', { level: 2, name: 'Review' })).toBeVisible();
    expect(screen.getByText('One pickup will be booked.')).toBeVisible();
    expect(container.querySelector('.ui-task-form__sections')).toHaveAttribute('hidden');
    // The fields are still in the page, with what was typed.
    expect(container.querySelector('input[name="name"]')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Go back and change' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  // Break caught: no warning for a reload or a closed tab while the form holds what was typed, or one that stays after the task was sent.
  it('asks the browser to warn before the page is left, only while something is unsaved', () => {
    const { rerender } = renderForm({ dirty: true });
    const leaving = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);

    rerender(
      <MemoryRouter>
        <TaskForm {...props({ dirty: false })} />
      </MemoryRouter>,
    );
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
  });

  // Break caught: a link that takes the person away from unsaved work without a word, or a question whose safe answer is not first and not the one that stays.
  it('asks before the application leaves an unsaved form, and the safe answer is to stay', async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [
        {
          path: '/',
          element: (
            <>
              <a href="/elsewhere">Elsewhere</a>
              <TaskForm {...props({ dirty: true })} />
            </>
          ),
        },
        { path: '/elsewhere', element: <p>Another page.</p> },
      ],
      { initialEntries: ['/'] },
    );
    render(<RouterProvider router={router} />);

    await router.navigate('/elsewhere');
    const question = await screen.findByRole('alertdialog', { name: 'Leave this page?' });
    expect(within(question).getByRole('button', { name: 'Stay here' })).toHaveFocus();
    expect(router.state.location.pathname).toBe('/');

    await user.click(within(question).getByRole('button', { name: 'Stay here' }));
    expect(router.state.location.pathname).toBe('/');

    await act(async () => {
      await router.navigate('/elsewhere');
    });
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Leave the page',
      }),
    );
    expect(router.state.location.pathname).toBe('/elsewhere');
  });

  // Break caught: a success that is only words, one whose action says anything but Open, or one with no way to do another.
  /** One toast of a task done, with its two acts: each test raises its own and presses one, so that nothing waits on another toast having left. */
  async function raiseDone(message: string) {
    const open = vi.fn();
    const another = vi.fn();
    render(<Toaster />);
    act(() => {
      announceTaskDone({ message, open, another: { label: 'Book another', onClick: another } });
    });
    const toast = (await screen.findByText(message)).closest<HTMLElement>('.ui-toast');
    if (toast === null) throw new Error('The message is not in a toast.');
    return { toast, open, another };
  }

  // Break caught: a success that is only words, or one whose first act is not Open.
  it('announces success as a toast whose first act is Open', async () => {
    const user = userEvent.setup();
    const { toast, open, another } = await raiseDone('ACC-PR-7KQ2MZ is booked.');

    await user.click(within(toast).getByRole('button', { name: 'Open' }));

    expect(open).toHaveBeenCalledTimes(1);
    expect(another).not.toHaveBeenCalled();
  });

  // Break caught: a success with no way to do another.
  it('announces success as a toast with a way to do another', async () => {
    const user = userEvent.setup();
    const { toast, open, another } = await raiseDone('ACC-PR-4HT9WD is booked.');

    await user.click(within(toast).getByRole('button', { name: 'Book another' }));

    expect(another).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });

  // Break caught: a composition that fails a WCAG 2.2 rule with the rail, the review and the alerts present.
  it('has no accessibility violation', async () => {
    const { container } = renderForm({
      alerts: <p role="status">Saved a moment ago.</p>,
      summary: { children: <p>An estimate, not a price.</p> },
    });

    expect(await wcagViolations(container)).toEqual([]);
  });
});
