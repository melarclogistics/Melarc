import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { POPOVER_OFFSET_PX, Popover } from './Popover';

describe('Popover', () => {
  // Break caught: the offset changed from Melarc's 8px, which every popover would then draw.
  it('has Melarc defaults: 8px from what opens it', () => {
    expect(POPOVER_OFFSET_PX).toBe(8);
  });

  // Break caught: a popover with no name (a dialog a screen reader meets as "dialog"), or one that does not open from its trigger.
  it('opens from its trigger as a dialog with a name', async () => {
    const user = userEvent.setup();
    render(
      <Popover trigger={<button type="button">Filter</button>} label="Choose a filter">
        <p>Service date</p>
      </Popover>,
    );

    await user.click(screen.getByRole('button', { name: 'Filter' }));

    expect(screen.getByRole('dialog', { name: 'Choose a filter' })).toHaveTextContent(
      'Service date',
    );
  });

  // Break caught: Escape that leaves the popover open, or focus lost to the page when it closes.
  it('closes with Escape and gives focus back to what opened it', async () => {
    const user = userEvent.setup();
    render(
      <Popover trigger={<button type="button">Filter</button>} label="Choose a filter">
        <button type="button">Inside</button>
      </Popover>,
    );

    await user.click(screen.getByRole('button', { name: 'Filter' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Filter' })).toHaveFocus();
  });

  // Break caught: the props the date field and the filter bar need from the primitive dropped (the element to draw into, a reference to the content, the focus on opening), so that
  // they could not move onto this component.
  it('keeps the container, the reference to the content and the focus on opening', async () => {
    const user = userEvent.setup();
    const host = document.createElement('div');
    document.body.append(host);
    const contentRef = createRef<HTMLDivElement>();
    const onOpenAutoFocus = vi.fn((event: Event) => {
      event.preventDefault();
    });
    render(
      <Popover
        trigger={<button type="button">Filter</button>}
        label="Choose a date"
        container={host}
        contentRef={contentRef}
        onOpenAutoFocus={onOpenAutoFocus}
        align="end"
      >
        <button type="button">Inside</button>
      </Popover>,
    );

    await user.click(screen.getByRole('button', { name: 'Filter' }));

    expect(host).toContainElement(screen.getByRole('dialog', { name: 'Choose a date' }));
    expect(contentRef.current).toBe(screen.getByRole('dialog'));
    expect(onOpenAutoFocus).toHaveBeenCalledTimes(1);
    host.remove();
  });

  // Break caught: controlled use that does not follow the page (a popover that opens itself when the page says it is closed).
  it('follows the page when it is controlled', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <Popover
        trigger={<button type="button">Filter</button>}
        label="Choose a filter"
        open={false}
        onOpenChange={onOpenChange}
      >
        <p>Inside</p>
      </Popover>,
    );

    await user.click(screen.getByRole('button', { name: 'Filter' }));

    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // Break caught: a name, a role or a relationship the automated checks see is wrong with the popover open.
  it('has no automated WCAG violation, open', async () => {
    const user = userEvent.setup();
    render(
      <Popover trigger={<button type="button">Filter</button>} label="Choose a filter">
        <label>
          Service date <input type="text" />
        </label>
      </Popover>,
    );

    await user.click(screen.getByRole('button', { name: 'Filter' }));

    expect(await wcagViolations(document.body)).toEqual([]);
  });
});
