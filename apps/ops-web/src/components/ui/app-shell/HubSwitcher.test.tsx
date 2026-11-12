import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { HubSwitcher, type HubSwitcherProps } from './HubSwitcher';

const ACCRA = { id: '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d', name: 'Accra Hub' };
const KUMASI = { id: '6c7d8e9f-0a12-4b3c-9d4e-5f6a7b8c9d0e', name: 'Kumasi Hub' };

function renderSwitcher(props: Partial<HubSwitcherProps> = {}) {
  const onChoose = vi.fn();
  const view = render(
    <HubSwitcher
      hubs={[ACCRA, KUMASI]}
      activeHubId={undefined}
      hasChoice
      onChoose={onChoose}
      {...props}
    />,
  );
  return { ...view, onChoose, user: userEvent.setup() };
}

describe('the hub switcher', () => {
  // Break caught: a switcher drawn for a session that lists no hub: a control that offers nothing, or a hub invented for it.
  it('draws nothing for a session that lists no hub', () => {
    const { container } = renderSwitcher({ hubs: [], hasChoice: false });

    expect(container).toBeEmptyDOMElement();
  });

  // Break caught: a menu offered to a session that has one hub (a control that does nothing, which a keyboard user must still pass), or the
  // name of the hub not drawn.
  it('draws the name of the one hub of a session that has one, with no button and no menu', () => {
    renderSwitcher({ hubs: [ACCRA], hasChoice: false });

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Accra Hub')).toBeVisible();
    // Said to a screen reader as a hub: the name alone would be a label with no meaning.
    expect(screen.getByText('Hub:')).toBeInTheDocument();
  });

  // Break caught: the mark of the active hub, a 6px crimson square, missing, or announced as if it were content.
  it('has the crimson square beside the name, hidden from assistive technology', () => {
    const { container } = renderSwitcher();

    const square = container.querySelector('.ui-hub__square');
    expect(square).toHaveAttribute('aria-hidden', 'true');
    expect(square?.textContent).toBe('');
  });

  // Break caught: a session that lists several hubs starting on one of them: it starts on All hubs, which is what a screen shows when told nothing.
  it('is a button that says All hubs when no hub is chosen, and says it as a hub to a screen reader', () => {
    renderSwitcher();

    const button = screen.getByRole('button', { name: 'Hub: All hubs' });
    expect(button).toHaveTextContent('All hubs');
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
  });

  it('names the hub that is chosen', () => {
    renderSwitcher({ activeHubId: KUMASI.id });

    expect(screen.getByRole('button', { name: 'Hub: Kumasi Hub' })).toHaveTextContent('Kumasi Hub');
  });

  // Break caught: a menu without All hubs, or without a hub the session lists, or one that does not say which is chosen.
  it('lists All hubs and each hub of the session, and says which is chosen', async () => {
    const { user } = renderSwitcher({ activeHubId: KUMASI.id });

    await user.click(screen.getByRole('button', { name: 'Hub: Kumasi Hub' }));

    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items.map((item) => item.textContent)).toEqual(['All hubs', 'Accra Hub', 'Kumasi Hub']);
    expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
      'true',
    ]);
  });

  // Break caught: the choice not told to whoever holds it, or All hubs told as a hub's id.
  it('tells which hub was chosen, and nothing when All hubs was', async () => {
    const { user, onChoose } = renderSwitcher();

    await user.click(screen.getByRole('button', { name: 'Hub: All hubs' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Accra Hub' }));
    expect(onChoose).toHaveBeenLastCalledWith(ACCRA.id);

    await user.click(screen.getByRole('button', { name: 'Hub: All hubs' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'All hubs' }));
    expect(onChoose).toHaveBeenLastCalledWith(undefined);
  });

  it('is operated from the keyboard: Enter opens it, the arrows move, Enter chooses, Escape closes', async () => {
    const { user, onChoose } = renderSwitcher();
    screen.getByRole('button', { name: 'Hub: All hubs' }).focus();

    await user.keyboard('{Enter}');
    expect(await screen.findByRole('menu')).toBeVisible();
    // Opened by the key, the menu has its first item, All hubs, under focus: two steps down is the last hub.
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onChoose).toHaveBeenCalledWith(KUMASI.id);

    await user.keyboard('{Enter}');
    await screen.findByRole('menu');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: 'Hub: All hubs' })).toHaveFocus();
  });

  it('has no WCAG violations that can be checked without a layout engine, closed and open', async () => {
    const { container, user } = renderSwitcher();
    expect(await wcagViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Hub: All hubs' }));
    await screen.findByRole('menu');
    expect(await wcagViolations(document.body)).toEqual([]);
  });
});

describe('the hub switcher’s chevron (task R5.2, M16)', () => {
  // Break caught: the pair of up-and-down chevrons that says "choose from a list" for a control that opens a menu below it: a dropdown's chevron is one, pointing down.
  it('is a single chevron pointing down, that is drawn for the eye alone', () => {
    renderSwitcher();

    const trigger = screen.getByRole('button', { name: 'Hub: All hubs' });
    const icon = trigger.querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon?.getAttribute('class')).toContain('lucide-chevron-down');
    expect(icon?.getAttribute('class')).not.toContain('chevrons-up-down');
  });
});
