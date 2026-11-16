import { Link as RouterLink, type LinkProps as RouterLinkProps } from 'react-router';

import type { ButtonSize, ButtonVariant } from './Button';
import './button.css';

export interface ButtonLinkProps extends Omit<RouterLinkProps, 'className' | 'style'> {
  /** `primary` is the main action of a surface and `secondary` an alternate. A link never does harm, so it has no `danger`. */
  readonly variant?: Exclude<ButtonVariant, 'danger'>;
  /** `lg` for a hub-floor task (the 56 px target of the button, by the token): asked for by the screen, never by the component. */
  readonly size?: ButtonSize;
}

/**
 * A link drawn as a button (COMPONENT_PATTERNS section 4): for going somewhere that is the main thing a surface offers, such as "Add a staff
 * profile". It is an anchor with an address and navigates without reloading the page; an act that changes something is a `Button`, and
 * navigation that is not the point of a surface is a `Link`. It shares the button's recipes, so it has the same size, colours and focus.
 */
export function ButtonLink({ variant = 'primary', size = 'md', ...rest }: ButtonLinkProps) {
  return (
    <RouterLink
      {...rest}
      className={`ui-button ui-button--${variant}${size === 'lg' ? ' ui-button--lg' : ''}`}
    />
  );
}
