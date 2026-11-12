import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { SearchButton } from './SearchButton';

describe('the search of the top bar', () => {
  // Break caught: a control with no words for what can be searched for, or whose name includes the key hint (read aloud as part of the name).
  it('says what can be searched for, and shows the key without making it part of the name', () => {
    render(<SearchButton onOpen={() => undefined} shortcut="Ctrl K" />);

    const button = screen.getByRole('button', { name: 'Search a code, name or phone' });
    expect(button).toHaveTextContent('Search a code, name or phoneCtrl K');
    expect(button.querySelector('kbd')).toHaveAttribute('aria-hidden', 'true');
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Control+K Meta+K');
    expect(button).toHaveAttribute('aria-haspopup', 'dialog');
  });

  it('shows the key hint of the platform it is given', () => {
    render(<SearchButton onOpen={() => undefined} shortcut="⌘K" />);

    expect(screen.getByText('⌘K')).toBeInTheDocument();
  });

  // Break caught: opening on focus (WCAG 3.2.1, a change of context when a control receives focus): a person tabbing across the top bar would
  // open the palette by passing it. It opens when it is activated: a click, Enter or Space.
  it('opens when it is pressed, and not when it merely receives focus', async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(<SearchButton onOpen={onOpen} shortcut="Ctrl K" />);

    await user.tab();
    expect(screen.getByRole('button')).toHaveFocus();
    expect(onOpen).not.toHaveBeenCalled();

    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    await user.click(screen.getByRole('button'));
    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  it('has no WCAG violations that can be checked without a layout engine', async () => {
    const { container } = render(<SearchButton onOpen={() => undefined} shortcut="Ctrl K" />);

    expect(await wcagViolations(container)).toEqual([]);
  });
});
