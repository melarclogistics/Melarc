import type { ReactNode } from 'react';

import './timeline.css';

/** One step of a timeline: what it is, what is known of it, and whether it is the one the page is about. */
export interface TimelineEntry {
  /** Tells two steps apart; unique in a timeline. */
  readonly key: string;
  /** The step, in a few words. It may hold a link to the step's own page. */
  readonly title: ReactNode;
  /** What is known of the step, in a line or two: its state, its date. */
  readonly details?: ReactNode;
  /** The step the page is about. At most one is. */
  readonly current?: boolean;
}

export interface TimelineProps {
  /** What the steps are, in a few words. It names the list for assistive technology. */
  readonly label: string;
  /** The steps, oldest first. The order is the caller's: the timeline sorts nothing. */
  readonly entries: readonly TimelineEntry[];
  /** The words that mark the current step to the eye, beside its title ("This request"). The list says it to assistive technology too. */
  readonly currentLabel: string;
}

/** What is wrong with a timeline that cannot be drawn truthfully. These are defects of the page, so drawing one throws. */
function defect({ label, entries }: TimelineProps): string | undefined {
  const keys = new Set<string>();
  for (const entry of entries) {
    if (keys.has(entry.key))
      return `Two steps of the timeline "${label}" have the key "${entry.key}".`;
    keys.add(entry.key);
  }
  if (entries.filter((entry) => entry.current === true).length > 1) {
    return `The timeline "${label}" has more than one current step.`;
  }
  return undefined;
}

/**
 * A sequence of steps in the order they happened (the attempt chain of a pickup request: each reschedule a new request linked to the one it
 * replaced). An ordered list named by its label, so a screen reader says how many steps there are and where each one is; the step the page is
 * about is `aria-current="step"` and is marked to the eye in words and by a filled marker, never by colour alone. The markers and the rule
 * between them are decoration. It is static: it takes no focus of its own, and a link in a step is a stop for the keyboard in the list's
 * order. What a step says is the caller's; the timeline knows nothing of requests or states.
 */
export function Timeline(props: TimelineProps) {
  const { label, entries, currentLabel } = props;
  const problem = defect(props);
  if (problem !== undefined) throw new Error(problem);

  return (
    <ol className="ui-timeline" aria-label={label}>
      {entries.map((entry) => {
        const current = entry.current === true;
        return (
          <li
            key={entry.key}
            className={
              current ? 'ui-timeline__step ui-timeline__step--current' : 'ui-timeline__step'
            }
            aria-current={current ? 'step' : undefined}
          >
            <span className="ui-timeline__marker" aria-hidden="true" />
            <div className="ui-timeline__body">
              <p className="ui-timeline__title">
                {entry.title}
                {current ? (
                  <>
                    {' '}
                    <span className="ui-timeline__current">{currentLabel}</span>
                  </>
                ) : null}
              </p>
              {entry.details === undefined ? null : (
                <div className="ui-timeline__details">{entry.details}</div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
