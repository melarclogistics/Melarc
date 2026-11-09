import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { Panel } from './Panel';

describe('Panel', () => {
  // Break caught: a header drawn for a panel that has no title or action, an empty heading that assistive technology still reaches.
  it('has a header only when it has a title', () => {
    const { container, rerender } = render(<Panel>The facts.</Panel>);
    expect(container.querySelector('.ui-panel__header')).toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();

    rerender(<Panel title="Pickup">The facts.</Panel>);
    expect(screen.getByRole('heading', { level: 2, name: 'Pickup' })).toBeInTheDocument();
  });

  // Break caught (the review of 499399c): a heading that focus cannot be sent to, so that a screen that puts the person back where they were working (the stops, once the changes to their
  // order are put aside) has nowhere to put them; and a heading that every panel makes a stop of the Tab key.
  it('lets focus be sent to its heading when it is given the ref, and makes no Tab stop of it', () => {
    const ref = createRef<HTMLHeadingElement>();
    const { rerender } = render(<Panel title="Stops">The stops.</Panel>);
    expect(screen.getByRole('heading', { name: 'Stops' })).not.toHaveAttribute('tabindex');

    rerender(
      <Panel title="Stops" headingRef={ref}>
        The stops.
      </Panel>,
    );
    const heading = screen.getByRole('heading', { name: 'Stops' });
    expect(ref.current).toBe(heading);
    expect(heading).toHaveAttribute('tabindex', '-1');
    ref.current?.focus();
    expect(heading).toHaveFocus();
  });

  // Break caught: a section a person works in that is no landmark, so that a screen reader cannot jump to it; and a landmark that every panel makes of itself.
  it('is a region named by its title only when it is asked to be, and says so when it has no title to be named by', () => {
    const { rerender } = render(<Panel title="Stops">The stops.</Panel>);
    expect(screen.queryByRole('region')).toBeNull();

    rerender(
      <Panel title="Stops" region>
        The stops.
      </Panel>,
    );
    expect(screen.getByRole('region', { name: 'Stops' })).toBeInTheDocument();

    const failure = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Panel region>The stops.</Panel>)).toThrow(/needs a title/);
    failure.mockRestore();
  });

  // Break caught: a title fixed at one level, which breaks the page's outline when the panel sits under another heading.
  it('puts its title at the level the page asks for', () => {
    render(
      <Panel title="Pickup" headingLevel={3}>
        The facts.
      </Panel>,
    );

    expect(screen.getByRole('heading', { level: 3, name: 'Pickup' })).toBeInTheDocument();
  });

  // Break caught: the action drawn before the title, or outside the header (the reading order and the grid of the header would say it acts on nothing).
  it('draws the action beside the title, after it', () => {
    const { container } = render(
      <Panel title="Pickup" action={<button type="button">Edit</button>}>
        The facts.
      </Panel>,
    );

    const header = container.querySelector('.ui-panel__header');
    const order = [...(header?.querySelectorAll('h2, button') ?? [])].map((node) => node.tagName);
    expect(order).toEqual(['H2', 'BUTTON']);
  });

  // Break caught: an action with no title beside it, which would sit alone at the top of a panel with nothing to say what it acts on.
  it('throws for an action with no title', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() =>
      render(<Panel action={<button type="button">Edit</button>}>The facts.</Panel>),
    ).toThrow(/needs a title/);
    quiet.mockRestore();
  });

  // Break caught: the page card drawn as a plain panel (12px) or the other way round, which the variant is the only difference of.
  it('is a panel unless it is the page card, and says so for the stylesheet', () => {
    const { container, rerender } = render(<Panel>The facts.</Panel>);
    expect(container.querySelector('.ui-panel')).toHaveAttribute('data-variant', 'panel');

    rerender(<Panel variant="page">The facts.</Panel>);
    expect(container.querySelector('.ui-panel')).toHaveAttribute('data-variant', 'page');
  });

  // Break caught: a panel that is a surface of its own and not the Card primitive (the registry's surface, drawn through the tokens).
  it('is the Card primitive', () => {
    const { container } = render(<Panel>The facts.</Panel>);

    expect(container.querySelector('[data-slot="card"]')).toHaveClass('ui-panel');
  });

  // Break caught: a heading out of order or a name missing from the action, any structure a rule of WCAG 2.2 can see without a layout engine.
  it('has no WCAG violations that can be checked without a layout engine', async () => {
    const { container } = render(
      <Panel title="Pickup" action={<button type="button">Edit</button>} variant="page">
        <p>The facts.</p>
      </Panel>,
    );

    expect(await wcagViolations(container)).toEqual([]);
  });
});
