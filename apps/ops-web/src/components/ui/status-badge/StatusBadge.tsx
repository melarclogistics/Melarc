import './status-badge.css';

/** The five status tones of the design system (DESIGN_SYSTEM section 4.4). */
export const STATUS_TONES = ['success', 'warning', 'danger', 'info', 'neutral'] as const;

export type StatusTone = (typeof STATUS_TONES)[number];

/** How one value of a domain enum is shown: a tone, and the words. The words are what carry it; the tone supports them. */
export interface StatusPresentation {
  readonly tone: StatusTone;
  readonly label: string;
}

/**
 * The presentation of every value of a domain enum. It is typed over the **whole** enum, so a value the contract adds is a compile error
 * where the mapping is written until someone decides how it looks, instead of a grey badge in production. The mapping belongs to the
 * feature that knows the domain (COMPONENT_PATTERNS section 18); this component knows no value of any.
 */
export type StatusMap<Value extends string> = Readonly<Record<Value, StatusPresentation>>;

export interface StatusBadgeProps<Value extends string> {
  /** The value to show. It is a string, not `Value`, because what arrives from a server is a string until it is checked. */
  readonly status: string;
  readonly map: StatusMap<Value>;
  /** What to call a value the mapping does not know. It is shown neutral, and the value itself is never shown. */
  readonly unknownLabel?: string;
}

/**
 * A status as a small badge: words in a tone (COMPONENT_PATTERNS section 18). A value the mapping does not have (a newer server, a
 * mapping not yet updated) is shown neutral as "Unknown status", never as the raw value and never in a colour that means something.
 * The lookup finds own properties only, so `constructor` and `__proto__` are unknown values like any other.
 */
export function StatusBadge<Value extends string>({
  status,
  map,
  unknownLabel = 'Unknown status',
}: StatusBadgeProps<Value>) {
  const presentation: StatusPresentation = Object.hasOwn(map, status)
    ? map[status as Value]
    : { tone: 'neutral', label: unknownLabel };
  return (
    <span className={`ui-status-badge ui-status-badge--${presentation.tone}`}>
      {presentation.label}
    </span>
  );
}
