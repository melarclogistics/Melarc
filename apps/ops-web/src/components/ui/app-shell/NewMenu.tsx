import { Link } from 'react-router';

import { Button } from '../../primitives/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../primitives/dropdown-menu';
import { Icon } from '../icon/Icon';
import type { IconName } from '../icon/icons';
import './top-bar.css';

export interface CreateAction {
  readonly to: string;
  readonly label: string;
  readonly icon: IconName;
}

/**
 * The New menu of the top bar (surfaces/ops-portal.md section 4): a crimson button with a plus that lists every action that creates something. It is
 * the one crimson button of the portal (`action.new` tokens), and the primary action of a page stays Ink. An action is a link to its own page, which
 * keeps its own route and its own key: the menu offers what the session holds the key of and nothing else, and draws no count. A session that may
 * create nothing is given no button and no empty menu.
 */
export function NewMenu({
  actions,
  onCloseAutoFocus,
}: {
  readonly actions: readonly CreateAction[];
  /** What happens to focus when the menu closes: back to the button, unless the person has gone to a page, whose heading has focus. */
  readonly onCloseAutoFocus?: (event: Event) => void;
}) {
  if (actions.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="brand" size="sm" className="ui-new">
          <Icon name="plus" size="sm" />
          New
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="ui-menu"
        {...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus })}
      >
        {actions.map((action) => (
          <DropdownMenuItem key={action.to} asChild>
            <Link to={action.to}>
              <Icon name={action.icon} size="sm" />
              {action.label}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
