import { Spinner } from './Spinner';

export interface LoadingIndicatorProps {
  /** What is happening, in words. It is what a screen reader says. */
  readonly label?: string;
  /** Leave the spinner out for inline loading text. */
  readonly spinner?: boolean;
}

/**
 * The initial loading indicator (COMPONENT_PATTERNS section 10): a spinner and inline text, or the text alone. It says
 * that work is in progress and never anything that sounds like completion. It is a polite status region, which assistive
 * technology can announce; a region that is already in the page, with its text, when the page is first read is not
 * announced reliably, so the words are always on screen as well. Skeletons are built when a page first needs one.
 */
export function LoadingIndicator({ label = 'Loading…', spinner = true }: LoadingIndicatorProps) {
  return (
    <span className="ui-loading" role="status">
      {spinner ? <Spinner /> : null}
      <span>{label}</span>
    </span>
  );
}
