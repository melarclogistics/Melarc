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

/** One variant or one state, named, in a frame of its own. `width` narrows the frame, to show how the component behaves in a narrow room. */
export function Specimen({
  label,
  width,
  children,
}: {
  readonly label: string;
  readonly width?: string;
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
      <div className="showcase-kit-specimen__body">{children}</div>
    </figure>
  );
}
