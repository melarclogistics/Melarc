import type { ReactNode } from 'react';

import './card-facts.css';

/** One fact of a card: what it is, and its value. */
export interface CardFact {
  /** What the fact is, in one to three words: the name of the column it is in the table ("Hub", "Service date"). */
  readonly label: string;
  /** What it says. Text and badges, **no control**: the card's one hit target is the button the table stretches over it. */
  readonly value: ReactNode;
}

export interface CardFactsProps {
  readonly facts: readonly CardFact[];
  /** What leads the card, beside its heading's text or under it: usually the status badge. */
  readonly head?: ReactNode;
  /** A quiet line under the head: the sender of a request, the work email of a person. */
  readonly lead?: ReactNode;
}

/**
 * The facts of a card (COMPONENT_PATTERNS, *CardFacts*): what a row of a table is where the table is too narrow for its columns. **Every fact is a label and its value, side by side where the
 * card is wide enough for both and one over the other where it is not** (a card of 300px, a phone at 390px, has its label and its value on one line: the review of f6cf02b found a staff card 270px
 * tall because each of three facts stood under its label), told by the card's own width and no width of the screen. It draws no control and no heading (the table draws the card's heading, its
 * button and its act around it) and decides nothing of what the facts say.
 */
export function CardFacts({ facts, head, lead }: CardFactsProps) {
  return (
    <>
      {head === undefined ? null : <div className="ui-card-facts__head">{head}</div>}
      {lead === undefined ? null : <p className="ui-card-facts__lead">{lead}</p>}
      <dl className="ui-card-facts">
        {facts.map((fact, index) => (
          <div key={`${String(index)}-${fact.label}`} className="ui-card-facts__fact">
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
