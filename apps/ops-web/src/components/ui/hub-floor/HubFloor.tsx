import type { ReactNode } from 'react';

import './hub-floor.css';

export interface HubFloorProps {
  /** A page of a hub-floor task: its header, its views, its lookup, its rows and its form. */
  readonly children: ReactNode;
}

/**
 * The hub floor's scope (DESIGN_SYSTEM sections 11 and 12; COMPONENT_PATTERNS, *The hub floor's sizes*): **the page that is a hub-floor task asks for the floor, and what is drawn inside it is drawn at the
 * touch height** (`--control-height-lg`, 56px). A button, a radio group and a checkbox take it by their own `size="lg"`; the parts of a page that the page does not draw itself (the links of its header, the
 * views of its queue, its lookup and its Filter button, the code of a row) take it from here, so that a thumb finds each of them. It adds one block and no behaviour, and nothing outside it changes.
 */
export function HubFloor({ children }: HubFloorProps) {
  return <div className="ui-hub-floor">{children}</div>;
}
