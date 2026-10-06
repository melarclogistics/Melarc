import type { ComponentPropsWithoutRef } from 'react';

import { Spinner } from '../loading/Spinner';
import './button.css';

export type ButtonVariant = 'primary' | 'secondary';

export interface ButtonProps extends Omit<
  ComponentPropsWithoutRef<'button'>,
  'type' | 'className' | 'style'
> {
  /** Always stated: a button inside a form submits it unless it says it does not. */
  readonly type: 'button' | 'submit' | 'reset';
  /** `primary` is the main action of a surface, `secondary` an alternate (DESIGN_SYSTEM section 16). */
  readonly variant?: ButtonVariant;
  /**
   * An action is under way. The button stays focusable and keeps its label, but it ignores activation, so the work is
   * not started twice. Do not show success while this is true (COMPONENT_PATTERNS section 4.9).
   */
  readonly loading?: boolean;
}

/**
 * The initial Button (COMPONENT_PATTERNS section 4): native `<button>` semantics, medium size. `tertiary` and `danger`
 * and the other sizes are built when a screen first needs them.
 */
export function Button({
  type,
  variant = 'primary',
  loading = false,
  onClick,
  children,
  'aria-busy': ariaBusy,
  'aria-disabled': ariaDisabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={`ui-button ui-button--${variant}`}
      // While loading the button says it is busy and inert, whatever the caller set; otherwise the caller's state stands.
      aria-busy={loading ? true : ariaBusy}
      // Not the native `disabled`: that would take the button out of the keyboard order while it is busy.
      aria-disabled={loading ? true : ariaDisabled}
      onClick={(event) => {
        if (loading) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}
