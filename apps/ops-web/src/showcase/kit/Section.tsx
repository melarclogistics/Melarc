import { useId, type ReactNode } from 'react';

/** A component of the kit: its name as a heading, a line of what the page shows of it, and its specimens. */
export function KitSection({
  title,
  note,
  children,
}: {
  readonly title: string;
  readonly note?: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="showcase-kit-section" aria-labelledby={`kit-${title.replaceAll(' ', '-')}`}>
      <h3 id={`kit-${title.replaceAll(' ', '-')}`} className="showcase-kit-section__title">
        {title}
      </h3>
      {note === undefined ? null : <p className="showcase-kit-section__note">{note}</p>}
      <div className="showcase-kit-section__specimens">{children}</div>
    </section>
  );
}

/**
 * One variant or one state, named, in a frame of its own. `width` narrows the frame, to show how the component behaves in a narrow room. `edge` takes the padding from the frame's sides, for a component that is
 * shown in the room a screen gives it and not in the room that a page framed twice and a frame of its own leave (a grid of photos: 324px at 390px, as in a receiving screen, and not 292px). What is drawn
 * beside it in the frame keeps its own space (`showcase-kit-specimen__note`).
 */
export function Specimen({
  label,
  width,
  edge = false,
  children,
}: {
  readonly label: string;
  readonly width?: string;
  readonly edge?: boolean;
  readonly children: ReactNode;
}) {
  const captionId = useId();
  return (
    <figure
      className="showcase-kit-specimen"
      aria-labelledby={captionId}
      style={width === undefined ? undefined : { maxWidth: width }}
    >
      <figcaption id={captionId} className="showcase-kit-specimen__label">
        {label}
      </figcaption>
      <div
        className={`showcase-kit-specimen__body${edge ? ' showcase-kit-specimen__body--edge' : ''}`}
      >
        {children}
      </div>
    </figure>
  );
}

/**
 * A table of the primitive in a box that scrolls sideways and takes focus, named: a table wider than its room (a phone, text at 200%) must be reachable from the keyboard
 * (WCAG 2.1.1; task R5.2, M9). The primitive's own box is made not to scroll (`showcase-kit-scroll` in kit.css), as the DataTable does, so that this is the one box.
 */
export function ScrollRegion({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="showcase-kit-scroll" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}
