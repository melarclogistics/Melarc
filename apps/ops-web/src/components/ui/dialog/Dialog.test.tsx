import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pressWithoutFocus } from '../../../test-support/press';
import { wcagViolations } from '../../../test-support/wcag';
import { Button } from '../button/Button';
import { Dialog, DialogActions, type DialogProps } from './Dialog';

afterEach(() => {
  vi.restoreAllMocks();
});

interface HarnessProps {
  /** Escape and a native close ask this; leave it out for a dialog that cannot be dismissed. */
  readonly dismiss?: () => void;
  readonly role?: DialogProps['role'];
  readonly description?: string;
  readonly initiallyOpen?: boolean;
  /** What is drawn inside the button that opens it: a person's press lands on this, not on the button itself. */
  readonly trigger?: ReactNode;
}

/** A page with a button that opens a dialog, which is how a person meets one: focus has to come back to the button. */
function Harness({
  dismiss,
  role,
  description,
  initiallyOpen = false,
  trigger: inner = 'Open the demo dialog',
}: HarnessProps) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        {inner}
      </button>
      <Dialog
        open={open}
        title="Demo dialog"
        {...(description === undefined ? {} : { description })}
        {...(role === undefined ? {} : { role })}
        {...(dismiss === undefined
          ? {}
          : {
              onRequestClose: () => {
                dismiss();
                setOpen(false);
              },
            })}
      >
        <label>
          Demo field
          <input type="text" />
        </label>
        <DialogActions>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setOpen(false);
            }}
          >
            Close the demo dialog
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

function renderHarness(props: HarnessProps = {}) {
  const view = render(<Harness {...props} />);
  return { ...view, user: userEvent.setup() };
}

const trigger = () => screen.getByRole('button', { name: 'Open the demo dialog' });

describe('Dialog: opening', () => {
  // Break caught: a dialog drawn in the page and never opened as a modal, which leaves the page behind it reachable by keyboard and
  // by screen reader. `showModal()` is what makes the rest of the page inert in a browser.
  it('opens as a modal dialog, and only when it is asked to', async () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
    const { user } = renderHarness();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(showModal).not.toHaveBeenCalled();

    await user.click(trigger());

    expect(showModal).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog', { name: 'Demo dialog' })).toBeVisible();
  });

  // Break caught: a dialog with no name, which a screen reader announces as an unnamed dialog.
  it('is named by its title, and described by what it says about itself', async () => {
    const { user } = renderHarness({ description: 'This only exists in the demo.' });
    await user.click(trigger());

    const dialog = screen.getByRole('dialog', { name: 'Demo dialog' });
    expect(dialog).toHaveAccessibleDescription('This only exists in the demo.');
    expect(screen.getByRole('heading', { level: 2, name: 'Demo dialog' })).toBeVisible();
  });

  it('is an alert dialog when it says so, and a dialog when it does not', async () => {
    const plain = renderHarness();
    await plain.user.click(trigger());
    expect(screen.getByRole('dialog', { name: 'Demo dialog' })).toBeVisible();
    plain.unmount();

    const alert = renderHarness({ role: 'alertdialog', description: 'A consequence.' });
    await alert.user.click(trigger());
    expect(screen.getByRole('alertdialog', { name: 'Demo dialog' })).toBeVisible();
  });

  it('puts focus inside it, on the first control, when it opens', async () => {
    const { user } = renderHarness();
    await user.click(trigger());

    expect(screen.getByRole('textbox', { name: 'Demo field' })).toHaveFocus();
  });

  it('puts focus on the control that says it should have it', async () => {
    function Marked() {
      return (
        <Dialog open title="Marked dialog">
          <input type="text" aria-label="First" />
          <button type="button" data-initial-focus>
            The safe one
          </button>
        </Dialog>
      );
    }
    render(<Marked />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'The safe one' })).toHaveFocus();
    });
  });

  // Break caught: the content of a closed dialog staying in the page, with the person's last input in it, for the next time.
  it('has none of its content in the page while it is closed, so a dialog opened again starts clean', async () => {
    const { user } = renderHarness();
    await user.click(trigger());
    await user.type(screen.getByRole('textbox', { name: 'Demo field' }), 'typed last time');
    await user.click(screen.getByRole('button', { name: 'Close the demo dialog' }));

    expect(screen.queryByRole('textbox', { name: 'Demo field' })).toBeNull();

    await user.click(trigger());
    expect(screen.getByRole('textbox', { name: 'Demo field' })).toHaveValue('');
  });

  it('can be opened again after it was closed', async () => {
    const { user } = renderHarness({ dismiss: vi.fn() });
    for (let round = 0; round < 3; round += 1) {
      await user.click(trigger());
      expect(screen.getByRole('dialog', { name: 'Demo dialog' })).toBeVisible();
      await user.keyboard('{Escape}');
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
    }
  });

  it('opens on the first render when it is asked to', () => {
    renderHarness({ initiallyOpen: true });

    expect(screen.getByRole('dialog', { name: 'Demo dialog' })).toBeVisible();
  });
});

describe('Dialog: leaving it', () => {
  // Break caught: Escape doing nothing, or closing the dialog without telling the page, so that the page believes it is open.
  it('asks to close on Escape, and the page closes it', async () => {
    const dismiss = vi.fn();
    const { user } = renderHarness({ dismiss });
    await user.click(trigger());

    await user.keyboard('{Escape}');

    expect(dismiss).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  // Break caught: a dialog the page did not ask to close going away, such as one that holds a command whose outcome is unknown.
  it('stays open on Escape when it cannot be dismissed', async () => {
    const { user } = renderHarness();
    await user.click(trigger());

    await user.keyboard('{Escape}');

    expect(screen.getByRole('dialog', { name: 'Demo dialog' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Demo field' })).toHaveFocus();
  });

  // Break caught: a stray click on the backdrop discarding what a person typed, or hiding a state they must see. The backdrop is the
  // <dialog> element itself in the DOM, so a click on it is a click on the backdrop.
  it('is not closed by a click on the backdrop', async () => {
    const dismiss = vi.fn();
    const { user } = renderHarness({ dismiss });
    await user.click(trigger());

    await user.click(screen.getByRole('dialog', { name: 'Demo dialog' }));

    expect(dismiss).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Demo dialog' })).toBeVisible();
  });

  // Break caught: focus dropped to the top of the document when a dialog closes, which makes a keyboard user start the page again.
  it('gives focus back to what opened it', async () => {
    const { user } = renderHarness({ dismiss: vi.fn() });
    trigger().focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog', { name: 'Demo dialog' })).toBeVisible();

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(trigger()).toHaveFocus();
    });
  });

  it('gives focus back when the page closes it, not only when Escape does', async () => {
    const { user } = renderHarness();
    trigger().focus();
    await user.keyboard('{Enter}');

    await user.click(screen.getByRole('button', { name: 'Close the demo dialog' }));

    await waitFor(() => {
      expect(trigger()).toHaveFocus();
    });
  });

  // Break caught (Safari, decision of 10 November 2026): WebKit gives no focus to a button that a pointer pressed, so what had focus when the dialog opened was the
  // body, and focus had nowhere to go back to: the person who used a mouse or a finger was left at the top of the page. The dialog remembers the control that was
  // pressed, and the press may land on something inside it (an icon, a span).
  it('gives focus back to the control that was pressed, in an engine that gives a pressed button no focus', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        dismiss={() => undefined}
        trigger={<span data-testid="inside-the-button">Open the demo dialog</span>}
      />,
    );
    pressWithoutFocus(screen.getByTestId('inside-the-button'));
    expect(screen.getByRole('dialog', { name: 'Demo dialog' })).toBeVisible();
    expect(trigger()).not.toHaveFocus();

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(trigger()).toHaveFocus();
    });
  });

  // Break caught: the press outliving the keyboard. A person who pressed a button with the mouse and then went on by keyboard, to a control of their own and a shortcut that
  // opens a dialog, gets focus back on the control they were on, and not on the button they pressed some time ago.
  it('goes back to the focused control when the keyboard opened it, whatever was pressed before', async () => {
    function Shortcut() {
      const [open, setOpen] = useState(false);
      useEffect(() => {
        const onKey = (event: KeyboardEvent): void => {
          if (event.key === 'k' && event.ctrlKey) setOpen(true);
        };
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('keydown', onKey);
        };
      }, []);
      return (
        <>
          <button type="button">Pressed first</button>
          <button type="button">Reached by keyboard</button>
          <Dialog
            open={open}
            title="Opened by a shortcut"
            onRequestClose={() => {
              setOpen(false);
            }}
          >
            <input type="text" aria-label="Inside" />
          </Dialog>
        </>
      );
    }
    const user = userEvent.setup();
    render(<Shortcut />);
    pressWithoutFocus(screen.getByRole('button', { name: 'Pressed first' }));
    screen.getByRole('button', { name: 'Reached by keyboard' }).focus();

    await user.keyboard('{Control>}k{/Control}');
    expect(screen.getByRole('dialog', { name: 'Opened by a shortcut' })).toBeVisible();
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Reached by keyboard' })).toHaveFocus();
    });
  });

  // Break caught (run 7, Stage 2.4; the Product Owner's review of 198e5be): the press remembered until a key is pressed, so a dialog that something other than a press opens later (a timer, a
  // route, a message from the server) gave focus back to a control pressed to open an earlier one. A press belongs to the dialog that took it; this one goes back to where the person is.
  it('goes back to the focused control, and not to the one that opened an earlier dialog, when something that was no press opens it', async () => {
    let openLater: () => void = () => undefined;
    let closeNow: () => void = () => undefined;
    function Timed() {
      const [open, setOpen] = useState(false);
      openLater = () => {
        setOpen(true);
      };
      closeNow = () => {
        setOpen(false);
      };
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setOpen(true);
            }}
          >
            Pressed once
          </button>
          <button type="button">Where the person is</button>
          <Dialog
            open={open}
            title="Opened twice"
            onRequestClose={() => {
              setOpen(false);
            }}
          >
            <input type="text" aria-label="Inside" />
          </Dialog>
        </>
      );
    }
    const user = userEvent.setup();
    render(<Timed />);
    pressWithoutFocus(screen.getByRole('button', { name: 'Pressed once' }));
    expect(screen.getByRole('dialog', { name: 'Opened twice' })).toBeVisible();
    // The page closes it (no key, no press), and focus is back on the control that opened it.
    act(() => {
      closeNow();
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Pressed once' })).toHaveFocus();
    });

    screen.getByRole('button', { name: 'Where the person is' }).focus();
    act(() => {
      openLater();
    });
    expect(screen.getByRole('dialog', { name: 'Opened twice' })).toBeVisible();
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Where the person is' })).toHaveFocus();
    });
  });

  it('does not fail when what opened it has gone by the time it closes', async () => {
    function Vanishing() {
      const [shown, setShown] = useState(true);
      const [open, setOpen] = useState(false);
      return (
        <>
          {shown ? (
            <button
              type="button"
              onClick={() => {
                setOpen(true);
              }}
            >
              Opens and then goes
            </button>
          ) : null}
          <Dialog open={open} title="Vanishing" onRequestClose={() => undefined}>
            <button
              type="button"
              onClick={() => {
                setShown(false);
                setOpen(false);
              }}
            >
              Remove the opener and close
            </button>
          </Dialog>
        </>
      );
    }
    const user = userEvent.setup();
    render(<Vanishing />);
    screen.getByRole('button', { name: 'Opens and then goes' }).focus();
    await user.keyboard('{Enter}');

    await user.click(screen.getByRole('button', { name: 'Remove the opener and close' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Opens and then goes' })).toBeNull();
  });

  it('closes when the page it is on goes away', async () => {
    const close = vi.spyOn(HTMLDialogElement.prototype, 'close');
    const { user, unmount } = renderHarness();
    await user.click(trigger());

    unmount();

    expect(close).toHaveBeenCalled();
  });
});

describe('Dialog: in the development build', () => {
  // Break caught: the strict mode of the development build runs an effect, undoes it and runs it again. The dialog closes itself on the
  // undo, and the browser reports that close after the dialog was opened again; read as the browser's own close it dismissed a dialog
  // nobody had touched (found by the browser test, in the development server).
  it('is not dismissed by the close it made itself when effects run twice', async () => {
    const dismiss = vi.fn();
    render(
      <StrictMode>
        <Harness initiallyOpen dismiss={dismiss} />
      </StrictMode>,
    );

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(dismiss).not.toHaveBeenCalled();
    expect(screen.getByRole<HTMLDialogElement>('dialog', { name: 'Demo dialog' }).open).toBe(true);
  });
});

describe('Dialog: closed behind the page’s back', () => {
  // Break caught: the browser closing a dialog (the second Escape of a Chrome page the person has not touched is not cancelable) and
  // the page still believing it is open. The page is told, and decides.
  it('tells the page when the browser closed it', async () => {
    const dismiss = vi.fn();
    const { user } = renderHarness({ dismiss });
    await user.click(trigger());

    act(() => {
      screen.getByRole<HTMLDialogElement>('dialog', { name: 'Demo dialog' }).close();
    });

    await waitFor(() => {
      expect(dismiss).toHaveBeenCalledTimes(1);
    });
  });

  // Break caught: a dialog that must stay (an unknown outcome is on it) disappearing because the browser closed it.
  it('opens again when the browser closed a dialog that cannot be dismissed', async () => {
    const { user } = renderHarness();
    await user.click(trigger());

    act(() => {
      screen.getByRole<HTMLDialogElement>('dialog', { name: 'Demo dialog' }).close();
    });

    await waitFor(() => {
      expect(screen.getByRole<HTMLDialogElement>('dialog', { name: 'Demo dialog' }).open).toBe(
        true,
      );
    });
  });
});

describe('Dialog: accessibility', () => {
  it('has no WCAG 2.1 A or AA violations that can be checked without a layout engine', async () => {
    const { user, container } = renderHarness({ description: 'This only exists in the demo.' });
    await user.click(trigger());

    expect(await wcagViolations(container)).toEqual([]);
  });

  it('has none as an alert dialog either', async () => {
    const { user, container } = renderHarness({
      role: 'alertdialog',
      description: 'A consequence in words.',
    });
    await user.click(trigger());

    expect(await wcagViolations(container)).toEqual([]);
  });
});
