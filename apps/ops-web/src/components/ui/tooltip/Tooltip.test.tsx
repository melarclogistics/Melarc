import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { TOOLTIP_DELAY_MS, TOOLTIP_OFFSET_PX, Tooltip } from './Tooltip';

describe('Tooltip', () => {
  // Break caught: the delay or the offset changed from Melarc's (300ms, 8px), which every screen would then draw.
  it('has Melarc defaults: 300ms and 8px', () => {
    expect(TOOLTIP_DELAY_MS).toBe(300);
    expect(TOOLTIP_OFFSET_PX).toBe(8);
  });

  // Break caught: a tooltip that is there at once under the pointer (it flickers over everything the pointer crosses), or never.
  it('appears under the pointer after a wait, not at once', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Open the record">
        <button type="button">Open</button>
      </Tooltip>,
    );

    await user.hover(screen.getByRole('button', { name: 'Open' }));
    expect(screen.queryByRole('tooltip')).toBeNull();

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Open the record');
  });

  // Break caught: a keyboard user who never gets the words (the tooltip only on hover), or who waits for them.
  it('appears at once on keyboard focus, and goes with Escape', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Open the record">
        <button type="button">Open</button>
      </Tooltip>,
    );

    await user.tab();

    expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Open the record');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  // Break caught: the words replacing the name of what they are on, so that the control has no name of its own, or the tooltip hiding the trigger's own name.
  it('leaves the name of what it is on as it was, and describes it by the words', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Open the record in full">
        <button type="button">Open</button>
      </Tooltip>,
    );

    await user.tab();
    await screen.findByRole('tooltip');

    expect(screen.getByRole('button', { name: 'Open' })).toHaveAccessibleDescription(
      'Open the record in full',
    );
  });
});
