import { VisuallyHidden } from '../visually-hidden/VisuallyHidden';
import './stage-tracker.css';

/** One stage of the way a record goes. */
export interface Stage {
  /** Tells the stage from the others. Unique in a tracker. */
  readonly id: string;
  /** What the stage is, in one to three words: "Confirmed". */
  readonly label: string;
}

export interface StageTrackerProps {
  /** Names the tracker: "Progress of the pickup request". */
  readonly label: string;
  /** The stages in the order the record goes through them. */
  readonly stages: readonly Stage[];
  /**
   * The stage the record is at now: the server's fact, passed as given. The ones before it are done and the ones after it are not reached. A stage that is **not one of
   * `stages`** (a state the page does not know yet) is drawn as unknown, never as done or not reached: see `unknownLabel` (task R5.2, M12).
   */
  readonly currentId: string;
  /** What is said when the current stage is not one of the stages: the words, never the server's raw value. Default "Unknown stage". */
  readonly unknownLabel?: string;
}

/**
 * Where a record stands on its way (PRODUCT_DESIGN_DIRECTION section 6.2; COMPONENT_PATTERNS, *RecordHeader and StageTracker*): segmented bars with labels. The
 * stages before the current one are drawn in the secondary text colour, the current one in the brand crimson with a small square beside its label, and the
 * ones after it in the border colour. The state is also told in words for whoever hears the page, so colour is never alone. It decides nothing about
 * which stage a record is at, and degrades as `StatusBadge` does on a state it does not know: every bar neutral, no stage current, none called done or not reached, and
 * "Unknown stage" said under them (never the raw value).
 */
export function StageTracker({
  label,
  stages,
  currentId,
  unknownLabel = 'Unknown stage',
}: StageTrackerProps) {
  const current = stages.findIndex((stage) => stage.id === currentId);
  const known = current !== -1;
  const duplicate = stages.find(
    (stage, index) => stages.findIndex((other) => other.id === stage.id) !== index,
  );
  if (duplicate !== undefined) {
    throw new Error(`Two stages of "${label}" have the id "${duplicate.id}".`);
  }
  return (
    // The frame is what the stages are laid out by: they stack when the room they are in is narrow (a panel on a wide screen), not only when the window is.
    <div className="ui-stage-tracker__frame">
      <ol className="ui-stage-tracker" aria-label={label} role="list">
        {stages.map((stage, index) => {
          const state = !known
            ? 'unknown'
            : index < current
              ? 'done'
              : index === current
                ? 'current'
                : 'future';
          return (
            <li
              key={stage.id}
              className="ui-stage-tracker__stage"
              data-state={state}
              aria-current={state === 'current' ? 'step' : undefined}
            >
              <span className="ui-stage-tracker__bar" aria-hidden="true" />
              <span className="ui-stage-tracker__label">
                {state === 'unknown' ? null : (
                  <VisuallyHidden>
                    {state === 'done'
                      ? 'Done: '
                      : state === 'current'
                        ? 'Current stage: '
                        : 'Not reached: '}
                  </VisuallyHidden>
                )}
                {stage.label}
              </span>
            </li>
          );
        })}
      </ol>
      {known ? null : <p className="ui-stage-tracker__unknown">{unknownLabel}</p>}
    </div>
  );
}
