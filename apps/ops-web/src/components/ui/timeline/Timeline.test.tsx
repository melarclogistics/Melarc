import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Link } from '../link/Link';
import { Timeline, type TimelineEntry } from './Timeline';

afterEach(() => {
  vi.restoreAllMocks();
});

const ENTRIES: readonly TimelineEntry[] = [
  { key: 'a', title: <Link to="/demo/a">Demo step one</Link>, details: 'Demo detail one' },
  { key: 'b', title: 'Demo step two', details: <p>Demo detail two</p>, current: true },
  { key: 'c', title: <Link to="/demo/c">Demo step three</Link> },
];

/** The timeline in a router, because its steps hold links, as the attempt chain's do. */
function renderTimeline(entries: readonly TimelineEntry[] = ENTRIES) {
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <>
            <button type="button">Before</button>
            <Timeline label="Demo steps" entries={entries} currentLabel="(the demo step shown)" />
            <button type="button">After</button>
          </>
        ),
      },
    ],
    { initialEntries: ['/'] },
  );
  return render(<RouterProvider router={router} />);
}

describe('Timeline: what it is', () => {
  it('is an ordered list named by its label, with one item for each step, in the order given', () => {
    renderTimeline();

    const list = screen.getByRole('list', { name: 'Demo steps' });
    expect(list.tagName).toBe('OL');
    const steps = within(list).getAllByRole('listitem');
    expect(steps.map((step) => step.textContent)).toEqual([
      'Demo step oneDemo detail one',
      'Demo step two (the demo step shown)Demo detail two',
      'Demo step three',
    ]);
  });

  // Break caught: the step the page is about told only by a filled marker, which neither a screen reader nor a person who cannot see the
  // colour can read.
  it('marks the current step for assistive technology and in words', () => {
    renderTimeline();

    const steps = screen.getAllByRole('listitem');
    expect(steps[1]).toHaveAttribute('aria-current', 'step');
    expect(steps[0]).not.toHaveAttribute('aria-current');
    expect(steps[2]).not.toHaveAttribute('aria-current');
    expect(within(steps[1] ?? document.body).getByText('(the demo step shown)')).toBeVisible();
  });

  // Break caught: "Latest" drawn on every history (the order already says it), or an empty tag left behind when a page gives no words.
  it('draws no words for the current step when it is given none, and still marks it for assistive technology', () => {
    const { container } = render(
      <Timeline
        label="Demo steps"
        entries={[
          { key: 'a', title: 'Demo step one' },
          { key: 'b', title: 'Demo step two', current: true },
        ]}
      />,
    );

    const steps = within(screen.getByRole('list', { name: 'Demo steps' })).getAllByRole('listitem');
    expect(steps[1]).toHaveAttribute('aria-current', 'step');
    expect(steps[1]).toHaveTextContent(/^Demo step two$/);
    expect(container.querySelector('.ui-timeline__current')).toBeNull();
  });

  // Break caught: the words of the current step run into the title ("Booked Latest"): they are their own element, which the stylesheet sets apart.
  it('keeps the words of the current step in an element of their own, after the title', () => {
    renderTimeline();

    const words = screen.getByText('(the demo step shown)');
    expect(words.className).toBe('ui-timeline__current');
    expect(words.parentElement).toHaveTextContent(/^Demo step two \(the demo step shown\)$/);
  });

  it('keeps its markers out of what is read', () => {
    const { container } = renderTimeline();

    for (const marker of container.querySelectorAll('.ui-timeline__marker')) {
      expect(marker).toHaveAttribute('aria-hidden', 'true');
    }
  });

  // Break caught: a chain that a page drew with one step twice, or with two steps each claiming to be this one.
  it('refuses two steps with one key, and two current steps', () => {
    // React reports the error it is about to throw; the test is about the throw. No router here: a router would catch it for its error page.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const drawn = (entries: readonly TimelineEntry[]) => () =>
      render(<Timeline label="Demo steps" entries={entries} currentLabel="(shown)" />);

    expect(
      drawn([
        { key: 'x', title: 'One' },
        { key: 'x', title: 'Again' },
      ]),
    ).toThrow(/key "x"/);
    expect(
      drawn([
        { key: 'x', title: 'One', current: true },
        { key: 'y', title: 'Two', current: true },
      ]),
    ).toThrow(/more than one current step/);
  });
});

describe('Timeline: by keyboard', () => {
  // It takes no focus of its own: Tab goes from what is before it to each link of its steps, in their order, and on.
  it('lets Tab reach the links of its steps in their order, and nothing else of it', async () => {
    const user = userEvent.setup();
    renderTimeline();

    await user.tab();
    expect(screen.getByRole('button', { name: 'Before' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('link', { name: 'Demo step one' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('link', { name: 'Demo step three' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });

  it('follows a step’s link with Enter', async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [
        {
          path: '/',
          element: <Timeline label="Demo steps" entries={ENTRIES} currentLabel="(shown)" />,
        },
        { path: '/demo/:step', element: <p>Demo step page</p> },
      ],
      { initialEntries: ['/'] },
    );
    render(<RouterProvider router={router} />);

    await user.tab();
    await user.keyboard('{Enter}');

    expect(await screen.findByText('Demo step page')).toBeVisible();
    expect(router.state.location.pathname).toBe('/demo/a');
  });
});
