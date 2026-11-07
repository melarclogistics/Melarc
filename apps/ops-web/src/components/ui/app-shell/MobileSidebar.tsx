import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '../../primitives/sheet';
import { IconButton } from '../icon-button/IconButton';
import { Sidebar } from './Sidebar';
import type { SidebarAccount, SidebarGroup } from './sidebar-types';
import './sidebar.css';

export interface MobileSidebarProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly groups: readonly SidebarGroup[];
  readonly account: SidebarAccount;
  /**
   * What happens to focus when the sheet has closed. By default it goes back to what opened the sheet; the shell stops that when the sheet closed
   * because the person went to another page, where the frame has already moved focus to the page's heading.
   */
  readonly onCloseAutoFocus?: (event: Event) => void;
}

/**
 * The sidebar on a narrow screen (under 48rem): the same sidebar, as the content of a sheet that slides in from the left (redesign step R4; the top
 * bar's menu button opens it). The sheet is a modal dialog named "Main menu": focus goes in and is kept in, Escape, the scrim and the button that
 * says "Close menu" close it, and the page behind it is out of reach (hidden from assistive technology, and not to be clicked). It carries no toggle
 * of the rail: it is always the full sidebar. **It closes at the click on an entry** (audit B7, 7 November 2026), and not only when the page has changed
 * (the shell also closes it then, which covers a navigation by any other way): so it is gone as the person acts, also for the entry of the page they are on and
 * for a page that is still loading.
 */
export function MobileSidebar({
  open,
  onOpenChange,
  groups,
  account,
  onCloseAutoFocus,
}: MobileSidebarProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        showCloseButton={false}
        className="ui-mobile-sidebar"
        {...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus })}
      >
        <SheetTitle className="sr-only">Main menu</SheetTitle>
        <SheetDescription className="sr-only">
          The pages of the Ops Portal that you may open.
        </SheetDescription>
        <Sidebar
          placement="sheet"
          rail={false}
          groups={groups}
          account={account}
          onNavigate={() => {
            onOpenChange(false);
          }}
          closeControl={
            <SheetClose asChild>
              <IconButton type="button" variant="inverse" icon="close" label="Close menu" />
            </SheetClose>
          }
        />
      </SheetContent>
    </Sheet>
  );
}
