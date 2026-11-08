import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { MOTION_FALLBACK } from '../motion/motion-tokens';
import { SidePanel, type SidePanelProps } from './SidePanel';

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'matchMedia');
});

/** A screen of the width a person has: `matches` says whether a media query is true of it. */
function setScreen(matches: (query: string) => boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: matches(query),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

const TABLET = (query: string): boolean => query.includes('max-width: 48rem');
const REDUCED_AND_WIDE = (query: string): boolean => query.includes('prefers-reduced-motion');

/** A page with two rows that open the panel, as a queue does: the panel is told nothing of the rows but a way back. */
function Page({
  onClose,
  initial = null,
  props,
  body,
}: {
  onClose?: () => void;
  initial?: string | null;
  props?: Partial<SidePanelProps>;
  body?: ReactNode;
}) {
  const [code, setCode] = useState<string | null>(initial);
  return (
    <MemoryRouter>
      <button
        type="button"
        onClick={() => {
          setCode('ACC-PR-7KQ2MZ');
        }}
      >
        Row one
      </button>
      <button
        type="button"
        onClick={() => {
          setCode('ACC-PR-4HT9WD');
        }}
      >
        Row two
      </button>
      <SidePanel
        open={code !== null}
        code={code ?? ''}
        fullPage={{ to: `/pickup-requests/${code ?? ''}` }}
        onClose={() => {
          setCode(null);
          onClose?.();
        }}
        {...props}
      >
        {body ?? <p>The summary of {code}.</p>}
      </SidePanel>
    </MemoryRouter>
  );
}

describe('SidePanel, beside the list', () => {
  // Break caught: a closed panel left in the page, where it is focusable and read by assistive technology though nobody opened it.
  it('draws nothing while it is closed', () => {
    render(<Page />);

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // Break caught: a panel with no name (the code), one that claims to take over the page (modal), or one that hides the summary from the keyboard.
  // (It asks for less motion for the reason the test below gives: `toBeVisible` reads the opacity of the entrance's first frame.)
  it('is a dialog named by the code that does not take over the page, with the summary in it', async () => {
    setScreen(REDUCED_AND_WIDE);
    const user = userEvent.setup();
    render(<Page />);

    await user.click(screen.getByRole('button', { name: 'Row one' }));

    const panel = await screen.findByRole('dialog', { name: 'ACC-PR-7KQ2MZ' });
    expect(panel).toHaveAttribute('aria-modal', 'false');
    expect(within(panel).getByText('The summary of ACC-PR-7KQ2MZ.')).toBeVisible();
    expect(within(panel).getByRole('region', { name: 'Details of ACC-PR-7KQ2MZ' })).toHaveAttribute(
      'tabindex',
      '0',
    );
    // The list stays in the page and in reach: the panel is beside it.
    expect(screen.getByRole('button', { name: 'Row two' })).toBeEnabled();
  });

  // Break caught: focus left on the row (behind the panel, where a keyboard user does not know the panel is), or sent to the page.
  it('moves focus to its heading when it opens', async () => {
    const user = userEvent.setup();
    render(<Page />);

    await user.click(screen.getByRole('button', { name: 'Row one' }));

    expect(await screen.findByRole('heading', { level: 2, name: 'ACC-PR-7KQ2MZ' })).toHaveFocus();
  });

  // Break caught: focus lost to the page when the panel closes, which sends a keyboard user back to the top of a queue of fifty rows.
  it('gives focus back to the row it was opened from, by Escape and by its button', async () => {
    const user = userEvent.setup();
    render(<Page />);
    const row = screen.getByRole('button', { name: 'Row one' });

    await user.click(row);
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(row).toHaveFocus();

    await user.click(row);
    await user.click(await screen.findByRole('button', { name: 'Close the panel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(row).toHaveFocus();
  });

  // Break caught: a row opened after another leaving the panel with the first one's focus: the heading must take focus for the new record, and the way
  // back is to the row that opened it last.
  it('moves focus to the new heading when another record takes the panel, and goes back to that row', async () => {
    const user = userEvent.setup();
    render(<Page />);

    await user.click(screen.getByRole('button', { name: 'Row one' }));
    await screen.findByRole('heading', { name: 'ACC-PR-7KQ2MZ' });
    await user.click(screen.getByRole('button', { name: 'Row two' }));

    expect(await screen.findByRole('heading', { name: 'ACC-PR-4HT9WD' })).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(screen.getByRole('button', { name: 'Row two' })).toHaveFocus();
  });

  // Break caught: the way back lost when the page says where it is: the page's own answer wins over what had focus.
  it('goes back to the control the page names, when it names one', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Elsewhere</button>
        <Page props={{ returnFocusTo: () => screen.getByRole('button', { name: 'Elsewhere' }) }} />
      </>,
    );

    await user.click(screen.getByRole('button', { name: 'Row one' }));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Elsewhere' })).toHaveFocus();
    });
  });

  // Break caught: Escape pressed in a menu inside the panel closing the panel as well as the menu.
  it('does not close for an Escape that something inside it has already taken', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Page
        onClose={onClose}
        initial="ACC-PR-7KQ2MZ"
        body={
          <input
            aria-label="Note"
            onKeyDown={(event) => {
              if (event.key === 'Escape') event.preventDefault();
            }}
          />
        }
      />,
    );

    await user.click(await screen.findByRole('textbox', { name: 'Note' }));
    await user.keyboard('{Escape}');

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  // Break caught: "Open full page" missing, or going to another record than the one in the panel.
  it('links to the whole record', async () => {
    render(<Page initial="ACC-PR-7KQ2MZ" />);

    expect(await screen.findByRole('link', { name: 'Open full page' })).toHaveAttribute(
      'href',
      '/pickup-requests/ACC-PR-7KQ2MZ',
    );
  });

  // Break caught: the heading showing the status or the link when the page gave none: nothing is drawn for what was not given.
  // The test is not about the entrance, so it asks for less motion: with the entrance on, the panel fades in from opacity 0 over 280 ms and `toBeVisible`
  // reads that opacity, so an assertion made before the first frame failed whenever the whole file ran slowly.
  it('draws the status and the link only when it is given them', async () => {
    setScreen(REDUCED_AND_WIDE);
    const { rerender } = render(
      <MemoryRouter>
        <SidePanel open code="ACC-PR-7KQ2MZ" onClose={vi.fn()}>
          <p>Summary.</p>
        </SidePanel>
      </MemoryRouter>,
    );
    await screen.findByRole('dialog');
    expect(screen.queryByRole('link', { name: 'Open full page' })).toBeNull();
    expect(document.querySelector('.ui-side-panel__status')).toBeNull();

    rerender(
      <MemoryRouter>
        <SidePanel
          open
          code="ACC-PR-7KQ2MZ"
          status={<span>Confirmed</span>}
          fullPage={{ to: '/x' }}
          onClose={vi.fn()}
        >
          <p>Summary.</p>
        </SidePanel>
      </MemoryRouter>,
    );
    expect(screen.getByText('Confirmed')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open full page' })).toBeVisible();
  });

  // Break caught: a dialog with no name, a region with no label or a heading out of order, any structure a rule of WCAG 2.2 can see without a layout engine.
  it('has no WCAG violations that can be checked without a layout engine', async () => {
    render(<Page initial="ACC-PR-7KQ2MZ" />);
    await screen.findByRole('dialog');

    expect(await wcagViolations(document.body)).toEqual([]);
  });

  // Break caught: a panel that slides under reduced motion: with the preference set it must be there at once and gone at once.
  it('opens and closes without waiting for an animation when the person asked for less motion', async () => {
    setScreen(REDUCED_AND_WIDE);
    const user = userEvent.setup();
    render(<Page />);

    await user.click(screen.getByRole('button', { name: 'Row one' }));
    expect(await screen.findByRole('dialog')).toBeVisible();
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});

describe('SidePanel, as a sheet at 768px and below', () => {
  // Break caught: the wide layout on a tablet, or the sheet on a desk: the screen decides.
  it('is a modal dialog that fills the screen when the screen is 768px wide or less', async () => {
    setScreen(TABLET);
    const user = userEvent.setup();
    render(<Page />);

    await user.click(screen.getByRole('button', { name: 'Row one' }));

    const sheet = await screen.findByRole('dialog', { name: 'ACC-PR-7KQ2MZ' });
    expect(sheet).toHaveClass('ui-side-sheet');
    expect(sheet).not.toHaveAttribute('aria-modal', 'false');
    expect(document.querySelector('.ui-side-panel')).toBeNull();
  });

  // Break caught: focus left on the row behind the sheet when it opens, or lost to the page when it closes (the sheet has no trigger, so the row is the way back).
  it('moves focus to the heading when it opens, and Escape closes it and gives focus back to the row', async () => {
    setScreen(TABLET);
    const user = userEvent.setup();
    render(<Page />);
    const row = screen.getByRole('button', { name: 'Row one' });

    await user.click(row);
    expect(await screen.findByRole('heading', { name: 'ACC-PR-7KQ2MZ' })).toHaveFocus();
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(row).toHaveFocus();
  });

  // Break caught: a sheet that is not modal, so that a keyboard or a screen reader can still reach the list behind it.
  it('has the page behind it out of reach while it is open', async () => {
    setScreen(TABLET);
    const user = userEvent.setup();
    render(<Page />);

    await user.click(screen.getByRole('button', { name: 'Row one' }));
    await screen.findByRole('dialog');

    expect(screen.queryByRole('button', { name: 'Row two' })).toBeNull();
  });

  // Break caught: a sheet with no name or no title, any structure a rule of WCAG 2.2 can see without a layout engine.
  it('has no WCAG violations that can be checked without a layout engine', async () => {
    setScreen(TABLET);
    render(<Page initial="ACC-PR-7KQ2MZ" />);
    await screen.findByRole('dialog');

    expect(await wcagViolations(document.body)).toEqual([]);
  });
});

// ---- SidePanel: focus is given back only from inside, and the reduced-motion test bound to the token (task R5.2, M7 and M14) ----
function ClosedByThePage() {
  const [open, setOpen] = useState(false);
  return (
    <MemoryRouter>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Row one
      </button>
      <button
        type="button"
        onClick={() => {
          setOpen(false);
        }}
      >
        Apply a filter
      </button>
      <SidePanel
        open={open}
        code="ACC-PR-7KQ2MZ"
        onClose={() => {
          setOpen(false);
        }}
      >
        <p>The summary.</p>
      </SidePanel>
    </MemoryRouter>
  );
}

describe('SidePanel: focus after a close that the page made (task R5.2, M7)', () => {
  // Break caught: the panel closed by the page (a filter applied, a control used) while the person is on another control: focus pulled back to the row, away from where
  // they are working. The row has it back only when it was in the panel (Escape, its close button) or nowhere.
  it('leaves focus where the person is when the page closes it', async () => {
    const user = userEvent.setup();
    render(<ClosedByThePage />);
    await user.click(screen.getByRole('button', { name: 'Row one' }));
    await screen.findByRole('dialog');

    await user.click(screen.getByRole('button', { name: 'Apply a filter' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(screen.getByRole('button', { name: 'Apply a filter' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Row one' })).not.toHaveFocus();
  });

  it('still gives focus back to the row when the person was in the panel', async () => {
    const user = userEvent.setup();
    render(<ClosedByThePage />);
    const row = screen.getByRole('button', { name: 'Row one' });
    await user.click(row);
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(row).toHaveFocus();
  });
});

describe('SidePanel: motion bound to the token (task R5.2, M14)', () => {
  // Break caught: a panel that animates under reduced motion and a test that cannot tell: it waited a second (the default of `waitFor`) for a panel whose exit is 280ms,
  // so a panel that DID animate passed it. Now it must be gone within half of `motion.slow`, and the control shows the same wait does not pass for a panel that animates.
  it('is gone within half of motion.slow when the person asked for less motion', async () => {
    setScreen(REDUCED_AND_WIDE);
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole('button', { name: 'Row one' }));
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');

    await waitFor(
      () => {
        expect(screen.queryByRole('dialog')).toBeNull();
      },
      { timeout: MOTION_FALLBACK.duration.slow / 2, interval: 5 },
    );
  });

  it('is still there at half of motion.slow when motion is welcome (the control of the test above)', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole('button', { name: 'Row one' }));
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');
    await new Promise<void>((resolve) => {
      setTimeout(resolve, MOTION_FALLBACK.duration.slow / 4);
    });

    expect(screen.queryByRole('dialog')).not.toBeNull();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});
