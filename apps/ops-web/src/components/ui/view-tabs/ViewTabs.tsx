import type { ReactNode } from 'react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../primitives/tabs';
import './view-tabs.css';

/** One named view of a queue. */
export interface ViewTab {
  /** Tells the view from the others; what `onValueChange` gives back. Unique in a list. */
  readonly id: string;
  /** What the view is, in one to three words: "Needs decision". */
  readonly label: string;
  /**
   * How many the server stated for this view. Leave it out while it is loading or when none was stated: a count that was not given is not drawn, and is
   * never drawn as 0. A 0 that was read is drawn (quietly), because a view with nothing in it is an answer.
   */
  readonly count?: number;
  /** The view cannot be chosen now. A view the person may not use at all is not passed in: hiding is presentation, and the server decides. */
  readonly disabled?: boolean;
}

export interface ViewTabsProps {
  /** Names the list of views: "Views of the pickup queue". */
  readonly label: string;
  readonly tabs: readonly ViewTab[];
  /** The id of the current view. The page holds it (usually in the address): the tabs only ask for a change. */
  readonly value: string;
  readonly onValueChange: (id: string) => void;
  /** What the current view shows (the queue's filters and table). It is the tab panel: the tabs and their panel are tied to each other. */
  readonly children?: ReactNode;
}

const NUMBER = new Intl.NumberFormat('en-GB');

/**
 * The views of a queue as tabs with counts (PRODUCT_DESIGN_DIRECTION section 6.1; COMPONENT_PATTERNS, *ViewTabs*): the Tabs primitive (Radix UI) with an
 * Ink pill for the current view's count and an underline of 2px that grows in over `motion.normal` (a transition of the stylesheet on the tokens, off under
 * reduced motion). The keys are the primitive's, with **manual activation** (task R5.2, M12): Tab enters the list at the current view, the arrows and Home and End move
 * focus only, and Enter or Space chooses (a choice asks the server for a view, so an arrow that merely passes over a tab must not). A current view that is not one of the views (an
 * address that names a view that no longer exists) draws the first view that can be chosen, and asks for nothing: the page decides whether to correct its address.
 * The counts are the server's, drawn as they are given.
 */
export function ViewTabs({ label, tabs, value, onValueChange, children }: ViewTabsProps) {
  const duplicate = tabs.find(
    (tab, index) => tabs.findIndex((other) => other.id === tab.id) !== index,
  );
  if (duplicate !== undefined) {
    throw new Error(`Two views of "${label}" have the id "${duplicate.id}".`);
  }
  const current = tabs.some((tab) => tab.id === value)
    ? value
    : (tabs.find((tab) => tab.disabled !== true)?.id ?? tabs[0]?.id ?? value);
  return (
    <Tabs
      value={current}
      onValueChange={onValueChange}
      activationMode="manual"
      className="ui-view-tabs"
    >
      <div className="ui-view-tabs__scroll">
        <TabsList aria-label={label} className="ui-view-tabs__list">
          {tabs.map((tab) => (
            <TabsTrigger
              key={tab.id}
              value={tab.id}
              disabled={tab.disabled === true}
              className="ui-view-tabs__tab"
            >
              <span>{tab.label}</span>
              {tab.count === undefined ? null : (
                <span
                  className="ui-view-tabs__count"
                  data-current={tab.id === current ? 'true' : undefined}
                  data-quiet={tab.count === 0 ? 'true' : undefined}
                >
                  {NUMBER.format(tab.count)}
                </span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <TabsContent value={current} className="ui-view-tabs__panel">
        {children}
      </TabsContent>
    </Tabs>
  );
}
