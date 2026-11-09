import './status-badge.css';

/**
 * The five status pairs of the design system (DESIGN_SYSTEM section 4.4, the R2 values): what is **waiting** for someone, what **succeeded**, what is only
 * **info**, what is **neutral** and what went wrong (**danger**). Each is a foreground, a soft background and a border, and a badge adds a 6px dot in the
 * foreground: the words carry the meaning and the dot and colour support them.
 */
export const STATUS_PAIRS = ['waiting', 'success', 'info', 'neutral', 'danger'] as const;

export type StatusPair = (typeof STATUS_PAIRS)[number];

/**
 * The tones a mapping names. They are the five pairs by the names the screens' mappings have always used (`warning` is the pair that this table calls `waiting`; the
 * tokens keep that name too), so no screen has to change for the badge to draw the new look. `pairOf` says which pair a tone is.
 */
export const STATUS_TONES = ['success', 'warning', 'danger', 'info', 'neutral'] as const;

export type StatusTone = (typeof STATUS_TONES)[number];

/** The pair that a tone draws: every tone is one of the five, and `warning` is `waiting`. */
export function pairOf(tone: StatusTone | StatusPair): StatusPair {
  return tone === 'warning' ? 'waiting' : tone;
}

/** How one value of a domain enum is shown: a tone, and the words. The words are what carry it; the tone supports them. */
export interface StatusPresentation {
  readonly tone: StatusTone | StatusPair;
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
  /**
   * The badge may wrap at its words in a table cell, in a narrow column ("Waiting for / confirmation"), instead of making the column as wide as the longest state. A badge in a table keeps to one
   * line unless it says so (the review of 499399c: a page no longer reaches into the badge to say it).
   */
  readonly wraps?: boolean;
}

/**
 * A status as a small badge: a 6px dot and the words, in one of the five pairs (COMPONENT_PATTERNS section 18). The states of the whole application are in one table (`src/app/status/status-table.ts`). A value the mapping does not have (a newer server, a
 * mapping not yet updated) is shown neutral as "Unknown status", never as the raw value and never in a colour that means something.
 * The lookup finds own properties only, so `constructor` and `__proto__` are unknown values like any other.
 */
export function StatusBadge<Value extends string>({
  status,
  map,
  unknownLabel = 'Unknown status',
  wraps = false,
}: StatusBadgeProps<Value>) {
  const presentation: StatusPresentation = Object.hasOwn(map, status)
    ? map[status as Value]
    : { tone: 'neutral', label: unknownLabel };
  return (
    <span
      className={`ui-status-badge ui-status-badge--${pairOf(presentation.tone)}${wraps ? ' ui-status-badge--wraps' : ''}`}
    >
      <span className="ui-status-badge__dot" aria-hidden="true" />
      {presentation.label}
    </span>
  );
}
