import type { Ref } from 'react';

import { Icon } from '../icon/Icon';
import './top-bar.css';

/**
 * The search of the top bar (surfaces/ops-portal.md section 4): a control that looks like a field, says what can be searched for, and shows the key
 * that opens the palette. **It is a button and not a field**: opening a dialog when a control merely receives focus is a change of context on
 * focus (WCAG 3.2.1, level A), and a person who tabs across the top bar would open the palette by passing it. Clicking it, or pressing Enter or Space
 * on it, opens the palette, which is what focusing a field with a pointer would do. On a narrow screen only the icon is drawn; the words stay in the
 * name of the button.
 */
export function SearchButton({
  onOpen,
  shortcut,
  ref,
}: {
  readonly onOpen: () => void;
  /** The key hint, `Ctrl K` or `⌘K` for the platform. */
  readonly shortcut: string;
  readonly ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      type="button"
      className="ui-search"
      aria-haspopup="dialog"
      aria-keyshortcuts="Control+K Meta+K"
      onClick={onOpen}
    >
      <Icon name="search" size="sm" />
      <span className="ui-search__text">Search a code, name or phone</span>
      {/* The key is told to assistive technology by `aria-keyshortcuts`; read as well it would be part of the name of the button. */}
      <kbd className="ui-search__key" aria-hidden="true">
        {shortcut}
      </kbd>
    </button>
  );
}
