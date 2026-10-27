import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { Button } from '../button/Button';
import { Field } from '../field/Field';
import { Input } from '../input/Input';
import { fieldText, useSubmission, type SubmissionResult } from './use-submission';

/** A form like the ones the screens build: two required fields, its own errors, and work that takes as long as the test says. */
function DemoForm({
  work,
}: {
  readonly work: (values: { first: string; second: string }) => Promise<SubmissionResult>;
}) {
  const [errors, setErrors] = useState<{ first?: string; second?: string }>({});
  const submission = useSubmission(async (form) => {
    const values = { first: fieldText(form, 'first'), second: fieldText(form, 'second') };
    const next = {
      ...(values.first === '' ? { first: 'Enter the first value.' } : {}),
      ...(values.second === '' ? { second: 'Enter the second value.' } : {}),
    };
    setErrors(next);
    if (Object.keys(next).length > 0) return 'invalid';
    return work(values);
  });

  return (
    <form {...submission.formProps} aria-label="Demo">
      <Field label="First" required error={errors.first}>
        <Input name="first" />
      </Field>
      <Field label="Second" required error={errors.second}>
        <Input name="second" />
      </Field>
      <Button type="submit" loading={submission.pending}>
        Save
      </Button>
    </form>
  );
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('useSubmission: invalid input', () => {
  // Break caught: a failed submit that leaves focus on the button, so a screen reader user never hears which field is
  // wrong (DESIGN_SYSTEM 14: focus goes to the first invalid field, which reads its error once).
  it('puts focus on the first invalid field, which reads its error', async () => {
    const user = userEvent.setup();
    render(<DemoForm work={() => Promise.resolve('accepted')} />);

    await user.click(screen.getByRole('button', { name: 'Save' }));

    const first = screen.getByRole('textbox', { name: 'First (required)' });
    await waitFor(() => {
      expect(first).toHaveFocus();
    });
    expect(first).toHaveAttribute('aria-invalid', 'true');
    expect(first).toHaveAccessibleDescription('Enter the first value.');
  });

  it('puts focus on the later field when the earlier one is valid', async () => {
    const user = userEvent.setup();
    render(<DemoForm work={() => Promise.resolve('accepted')} />);
    await user.type(screen.getByRole('textbox', { name: 'First (required)' }), 'a');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Second (required)' })).toHaveFocus();
    });
  });

  // Break caught: the work running with input the form itself refused, which sends a request the person was told is wrong.
  it('does not run the work while the input is invalid', async () => {
    const user = userEvent.setup();
    const work = vi.fn(() => Promise.resolve<SubmissionResult>('accepted'));
    render(<DemoForm work={work} />);

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(work).not.toHaveBeenCalled();
  });

  // Break caught: focus moving only the first time. Each failed submit sends focus to the first invalid field again.
  it('moves focus again on each failed submit', async () => {
    const user = userEvent.setup();
    render(<DemoForm work={() => Promise.resolve('accepted')} />);
    const button = screen.getByRole('button', { name: 'Save' });

    await user.click(button);
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'First (required)' })).toHaveFocus();
    });
    await user.click(button);

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'First (required)' })).toHaveFocus();
    });
    expect(button).not.toHaveFocus();
  });

  // Break caught: the browser's own validation bubbles replacing the form's accessible errors.
  it('turns the browser’s own validation off, so the form’s errors are the ones shown', () => {
    render(<DemoForm work={() => Promise.resolve('accepted')} />);

    expect(screen.getByRole('form', { name: 'Demo' })).toHaveAttribute('novalidate');
  });
});

describe('useSubmission: pending and duplicate submits', () => {
  // Break caught: a double click, or Enter pressed twice, sending the work twice: two sign-ins, two commands.
  it('runs the work once however many times it is submitted while it is under way', async () => {
    const user = userEvent.setup();
    const pending = deferred<SubmissionResult>();
    const work = vi.fn(() => pending.promise);
    render(<DemoForm work={work} />);
    await user.type(screen.getByRole('textbox', { name: 'First (required)' }), 'a');
    await user.type(screen.getByRole('textbox', { name: 'Second (required)' }), 'b{Enter}');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.keyboard('{Enter}');
    await user.dblClick(screen.getByRole('button', { name: 'Save' }));

    expect(work).toHaveBeenCalledOnce();
    await act(async () => {
      pending.resolve('accepted');
      await pending.promise;
    });
  });

  // Break caught: the guard being the button's state alone. Enter in a text field submits the form without clicking
  // the button, and React state is not updated between two events in the same tick.
  it('ignores a second submit in the same tick, before the screen has re-rendered', async () => {
    const pending = deferred<SubmissionResult>();
    const work = vi.fn(() => pending.promise);
    render(<DemoForm work={work} />);
    const form = screen.getByRole('form', { name: 'Demo' });
    screen.getByRole<HTMLInputElement>('textbox', { name: 'First (required)' }).value = 'a';
    screen.getByRole<HTMLInputElement>('textbox', { name: 'Second (required)' }).value = 'b';

    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(work).toHaveBeenCalledOnce();
    await act(async () => {
      pending.resolve('accepted');
      await pending.promise;
    });
  });

  // Break caught: a pending state that is not shown, or not said: the person cannot tell the click was taken.
  it('shows the button busy while the work is under way, and the form busy to assistive technology', async () => {
    const user = userEvent.setup();
    const pending = deferred<SubmissionResult>();
    render(<DemoForm work={() => pending.promise} />);
    await user.type(screen.getByRole('textbox', { name: 'First (required)' }), 'a');
    await user.type(screen.getByRole('textbox', { name: 'Second (required)' }), 'b');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('form', { name: 'Demo' })).toHaveAttribute('aria-busy', 'true');
    await act(async () => {
      pending.resolve('accepted');
      await pending.promise;
    });
    await waitFor(() => {
      expect(button).not.toHaveAttribute('aria-busy', 'true');
    });
    expect(screen.getByRole('form', { name: 'Demo' })).not.toHaveAttribute('aria-busy', 'true');
  });

  // Break caught: a form stuck pending for good after a failure, which the person can only leave by reloading.
  it('can be submitted again once the work is over, whatever it answered', async () => {
    const user = userEvent.setup();
    const work = vi.fn(() => Promise.resolve<SubmissionResult>('failed'));
    render(<DemoForm work={work} />);
    await user.type(screen.getByRole('textbox', { name: 'First (required)' }), 'a');
    await user.type(screen.getByRole('textbox', { name: 'Second (required)' }), 'b');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save' })).not.toHaveAttribute('aria-busy', 'true');
    });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(work).toHaveBeenCalledTimes(2);
  });

  // Break caught: work that throws leaving the form pending for good, or the error swallowed. The failure is reported as
  // an uncaught error, which monitoring sees (`reportError`), and the form is usable again.
  it('clears the pending state when the work throws, and reports the error rather than swallowing it', async () => {
    const report = vi.fn();
    vi.stubGlobal('reportError', report);
    try {
      const user = userEvent.setup();
      const failure = new Error('the work broke');
      render(<DemoForm work={() => Promise.reject(failure)} />);
      await user.type(screen.getByRole('textbox', { name: 'First (required)' }), 'a');
      await user.type(screen.getByRole('textbox', { name: 'Second (required)' }), 'b');

      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => {
        expect(report).toHaveBeenCalledWith(failure);
      });
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Save' })).not.toHaveAttribute(
          'aria-busy',
          'true',
        );
      });
      expect(screen.getByRole('form', { name: 'Demo' })).not.toHaveAttribute('aria-busy', 'true');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('prevents the browser’s own submit, which would reload the page', async () => {
    render(<DemoForm work={() => Promise.resolve('accepted')} />);
    const form = screen.getByRole('form', { name: 'Demo' });
    const event = new Event('submit', { bubbles: true, cancelable: true });

    form.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    await act(async () => {
      await Promise.resolve();
    });
  });
});

describe('useSubmission: after the component has gone', () => {
  // Break caught: state set on a form that left the page while its work was under way, or a focus move into a page the
  // person has navigated to.
  it('does nothing when the form is unmounted before the work ends', async () => {
    const user = userEvent.setup();
    const pending = deferred<SubmissionResult>();
    const { unmount } = render(<DemoForm work={() => pending.promise} />);
    await user.type(screen.getByRole('textbox', { name: 'First (required)' }), 'a');
    await user.type(screen.getByRole('textbox', { name: 'Second (required)' }), 'b');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    unmount();
    await act(async () => {
      pending.resolve('invalid');
      await pending.promise;
    });

    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('a form built on the hook', () => {
  it('has no WCAG 2.1 A or AA violations that can be checked without a layout engine', async () => {
    const user = userEvent.setup();
    const { container } = render(<DemoForm work={() => Promise.resolve('accepted')} />);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'First (required)' })).toHaveFocus();
    });

    expect(await wcagViolations(container)).toEqual([]);
  });
});
