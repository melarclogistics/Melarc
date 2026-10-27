import type { ComponentPropsWithoutRef, Ref } from 'react';

import { Icon, type IconSize } from '../icon/Icon';
import type { IconName } from '../icon/icons';
import { Spinner } from '../loading/Spinner';
import './icon-button.css';

export type IconButtonVariant = 'bare' | 'inverse';

export interface IconButtonProps extends Omit<
  ComponentPropsWithoutRef<'button'>,
  'type' | 'className' | 'style' | 'children' | 'aria-label' | 'aria-labelledby' | 'title'
> {
  /** Always stated, as for a Button: a button inside a form submits it unless it says it does not. */
  readonly type: 'button' | 'submit' | 'reset';
  readonly icon: IconName;
  /** The button element, for a caller that moves focus to it (React 19: a ref is a prop). */
  readonly ref?: Ref<HTMLButtonElement>;
  /**
   * What the control does, in words: its accessible name, and the text a pointer user sees as a tooltip. Required, because an
   * icon-only control has no other name (DESIGN_SYSTEM section 24; COMPONENT_PATTERNS section 22). It names the act, not the picture
   * ("Show password", not "Eye").
   */
  readonly label: string;
  /** `bare` on a light surface; `inverse` on Ink (the authenticated shell). Default `bare`. */
  readonly variant?: IconButtonVariant;
  readonly size?: IconSize;
  /** An action is under way: the button stays focusable and keeps its name, but ignores activation (as `Button`). */
  readonly loading?: boolean;
}

/**
 * The icon-only button (COMPONENT_PATTERNS section 22): a native `<button>` that is named by `label` and drawn with one icon of the
 * family. It is at least 2rem square (the small control height, above the 24px target minimum of WCAG 2.2), has the same focus ring as every
 * control (the inverse recipe on Ink), and keeps its state in the name or in `aria-expanded`/`aria-pressed` passed to it, never in the picture
 * alone. The `title` repeats the name for a pointer user who cannot tell what the picture means; it is not the name.
 */
export function IconButton({
  type,
  icon,
  label,
  variant = 'bare',
  size = 'md',
  loading = false,
  onClick,
  'aria-busy': ariaBusy,
  'aria-disabled': ariaDisabled,
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={`ui-icon-button ui-icon-button--${variant}`}
      aria-label={label}
      title={label}
      aria-busy={loading ? true : ariaBusy}
      aria-disabled={loading ? true : ariaDisabled}
      onClick={(event) => {
        if (loading) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    >
      {loading ? <Spinner /> : <Icon name={icon} size={size} />}
    </button>
  );
}
