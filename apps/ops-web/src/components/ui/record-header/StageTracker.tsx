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
  /** The stage the record is at now: the server's fact, passed as given. The ones before it are done and the ones after it are not reached. */
  readonly currentId: string;
}

/**
 * Where a record stands on its way (PRODUCT_DESIGN_DIRECTION section 6.2; COMPONENT_PATTERNS, *RecordHeader and StageTracker*): segmented bars with labels. The
 * stages before the current one are drawn in the secondary text colour, the current one in the brand crimson with a small square beside its label, and the
 * ones after it in the border colour. The state is also told in words for whoever hears the page, so colour is never alone. It decides nothing about
 * which stage a record is at.
 */
export function StageTracker({ label, stages, currentId }: StageTrackerProps) {
  const current = stages.findIndex((stage) => stage.id === currentId);
  if (current === -1) {
    throw new Error(`The current stage "${currentId}" is not one of the stages of "${label}".`);
  }
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
          const state = index < current ? 'done' : index === current ? 'current' : 'future';
          return (
            <li
              key={stage.id}
              className="ui-stage-tracker__stage"
              data-state={state}
              aria-current={state === 'current' ? 'step' : undefined}
            >
              <span className="ui-stage-tracker__bar" aria-hidden="true" />
              <span className="ui-stage-tracker__label">
                <VisuallyHidden>
                  {state === 'done'
                    ? 'Done: '
                    : state === 'current'
                      ? 'Current stage: '
                      : 'Not reached: '}
                </VisuallyHidden>
                {stage.label}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
