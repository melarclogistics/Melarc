import { Link as RouterLink, type LinkProps as RouterLinkProps } from 'react-router';

import './link.css';

export type LinkProps = Omit<RouterLinkProps, 'className' | 'style'>;

/**
 * The default Link (COMPONENT_PATTERNS section 5): a thin primitive over the router's link, so it is a real anchor
 * with an address and navigates without reloading the page. Use it for navigation; an action that changes something
 * is a Button. The `inverse` and `subtle` variants are built when a screen first needs them.
 */
export function Link(props: LinkProps) {
  return <RouterLink {...props} className="ui-link" />;
}
