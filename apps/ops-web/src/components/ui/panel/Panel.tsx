import { useId, type ReactNode, type RefObject } from 'react';

import { Card, CardAction, CardContent, CardHeader, CardTitle } from '../../primitives/card';
import './panel.css';

export interface PanelProps {
  /** What the panel holds, in one to three words. Without a title and an action there is no header. */
  readonly title?: string;
  /** The level of the title, so that the page's outline stays in order. Default 2. */
  readonly headingLevel?: 2 | 3 | 4;
  /** An action of the panel, at the end of its header: a Button or a link. It needs a title beside it. */
  readonly action?: ReactNode;
  /**
   * The panel is a landmark region named by its title, for a section of a record that a person jumps to and works in, with acts of its own (the stops of a pickup run, the custody of its
   * parcels). Use it sparingly: every region is another stop for a screen reader. It needs a title to be named by.
   */
  readonly region?: boolean;
  /**
   * The title's element, for a screen that puts focus on it when what it was working with leaves the page (the stops, once the changes to their order are put aside). Giving it makes the
   * heading something focus can be sent to, and not a stop of the Tab key.
   */
  readonly headingRef?: RefObject<HTMLHeadingElement | null>;
  /** `panel` (12px) for a surface inside a page; `page` (16px) for the page's own card, the one that holds a queue or a record's body. Default `panel`. */
  readonly variant?: 'panel' | 'page';
  /** `none` for content that runs to the edges (a table). Default `default`: 20px, 24px on a page card. */
  readonly padding?: 'default' | 'none';
  readonly children: ReactNode;
}

const HEADING = { 2: 'h2', 3: 'h3', 4: 'h4' } as const;

/**
 * A surface of the record and queue templates (PRODUCT_DESIGN_DIRECTION section 6; COMPONENT_PATTERNS, *Panel and Card*): the Card primitive on the default
 * surface with the subtle border, 12px corners (16px for a page card), and no shadow, because a panel sits on the page and only what floats has one (DESIGN_SYSTEM
 * section 8). An optional header holds the title and one action. It says nothing of what it holds: the states of the content are the content's.
 */
export function Panel({
  title,
  headingLevel = 2,
  action,
  region = false,
  headingRef,
  variant = 'panel',
  padding = 'default',
  children,
}: PanelProps) {
  if (action !== undefined && title === undefined) {
    throw new Error('A panel with an action needs a title to put it beside.');
  }
  if (region && title === undefined)
    throw new Error('A panel that is a region needs a title to be named by.');
  const headingId = useId();
  const Heading = HEADING[headingLevel];
  return (
    <Card
      className="ui-panel"
      data-variant={variant}
      data-padding={padding}
      {...(region ? { role: 'region', 'aria-labelledby': headingId } : {})}
    >
      {title === undefined ? null : (
        <CardHeader className="ui-panel__header">
          <CardTitle className="ui-panel__title">
            <Heading
              id={region ? headingId : undefined}
              ref={headingRef}
              tabIndex={headingRef === undefined ? undefined : -1}
              className="ui-panel__heading"
            >
              {title}
            </Heading>
          </CardTitle>
          {action === undefined ? null : (
            <CardAction className="ui-panel__action">{action}</CardAction>
          )}
        </CardHeader>
      )}
      <CardContent className="ui-panel__body">{children}</CardContent>
    </Card>
  );
}
