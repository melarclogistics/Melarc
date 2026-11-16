import { Icon } from '../icon/Icon';
import './connection-banner.css';
import { useOnlineStatus } from './use-online-status';

/** What a person at the hub floor is told when the connection is gone: that what they do now is not saved, which is the one thing they need to know before they type a count into a tablet. */
export const CONNECTION_LOST_WORDS = 'No connection. What you do now is not saved.';

export interface ConnectionBannerProps {
  /**
   * The page has seen a request fail for the network (the browser could not reach the server) and has not seen one get through since. The browser may still say it is online (a captive portal, a signal that carries
   * nothing), so the page says it; the banner stays while either says the connection is gone.
   */
  readonly requestFailed?: boolean;
  /** The page's own words, where it can say what is not saved ("No connection. The count you are entering is not saved."). Left out, the words above. */
  readonly words?: string;
}

/**
 * The connection banner (COMPONENT_PATTERNS, *ConnectionBanner*): a line of the page that says **what a person does now is not saved** while the browser says it is offline or the page says a request failed for the
 * network, and goes when the connection is back, and only then: **there is no way to dismiss it**, because the one thing it says is what a person must not go on typing past. It is a **polite status region that is
 * in the page before it has anything to say**, so that what it says is announced (a region that is added to the page with its words in it is not announced reliably), with an icon beside the words and never
 * instead of them. It never blocks the page: it is a line of the page and not a layer over it, takes no focus and makes nothing inert. It is generic and routes nothing: the page draws it where it wants it.
 */
export function ConnectionBanner({
  requestFailed = false,
  words = CONNECTION_LOST_WORDS,
}: ConnectionBannerProps) {
  const online = useOnlineStatus();
  return (
    <div className="ui-connection-banner" role="status" aria-live="polite">
      {online && !requestFailed ? null : (
        <p className="ui-connection-banner__message">
          <Icon name="offline" />
          <span>{words}</span>
        </p>
      )}
    </div>
  );
}
