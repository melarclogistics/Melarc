import './loading.css';

/**
 * A decorative spinner. It carries no meaning of its own: the label next to it does, so it is hidden from assistive
 * technology. It takes the colour of the text around it, which keeps it visible in forced-colours mode.
 */
export function Spinner() {
  return <span className="ui-spinner" aria-hidden="true" />;
}
