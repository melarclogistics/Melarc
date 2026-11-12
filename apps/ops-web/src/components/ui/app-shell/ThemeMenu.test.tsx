import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { ThemeMenu } from './ThemeMenu';
import type { ThemeValue } from './theme-options';

function renderMenu(choice: ThemeValue = 'system') {
  const onChoose = vi.fn();
  const view = render(<ThemeMenu choice={choice} onChoose={onChoose} />);
  return { ...view, onChoose, user: userEvent.setup() };
}

describe('the theme control', () => {
  // Break caught: a control that does not say which theme is chosen (an icon alone), or says the wrong one.
  it.each([
    ['system', 'Theme: System'],
    ['light', 'Theme: Light'],
    ['dark', 'Theme: Dark'],
  ] as const)('is named for the choice, %s', (choice, name) => {
    renderMenu(choice);

    expect(screen.getByRole('button', { name })).toHaveAttribute('aria-haspopup', 'menu');
  });

  // Break caught: a choice missing (System is the default, and Light and Dark are the person's own), or the chosen one not marked.
  it('offers System, Light and Dark, and marks the one that is chosen', async () => {
    const { user } = renderMenu('light');

    await user.click(screen.getByRole('button', { name: 'Theme: Light' }));

    const items = within(await screen.findByRole('menu')).getAllByRole('menuitemradio');
    expect(items.map((item) => item.textContent)).toEqual(['System', 'Light', 'Dark']);
    expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
    ]);
  });

  it('tells which theme was chosen', async () => {
    const { user, onChoose } = renderMenu();

    await user.click(screen.getByRole('button', { name: 'Theme: System' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Dark' }));

    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith('dark');
  });

  it('has no WCAG violations that can be checked without a layout engine, closed and open', async () => {
    const { container, user } = renderMenu();
    expect(await wcagViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Theme: System' }));
    await screen.findByRole('menu');
    expect(await wcagViolations(document.body)).toEqual([]);
  });
});
