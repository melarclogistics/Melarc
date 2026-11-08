import { BrandLockup } from '../brand/BrandLockup';
import './auth-art.css';

/**
 * The imagery half of the split screen (COMPONENT_PATTERNS section 12.7; DESIGN_SYSTEM section 13.1): a photograph, edge to edge, over a band of
 * Ink that carries the mark and the name of the product. It is decorative and hidden from assistive technology as a whole: the form beside it
 * says everything that matters, and the photograph is never the only carrier of meaning. With no photograph it is the band's Ink alone, which
 * is the brand and not a picture of something that is not there.
 */
export function AuthArt({ src }: { readonly src: string | undefined }) {
  return (
    <div className="ui-auth-art" aria-hidden="true">
      <div className="ui-auth-art__picture">
        {/* Lazy, so that a screen too narrow to draw the panel (it is not laid out) never fetches the photograph: a phone would pay for a picture it
            cannot see. On a wide screen the panel is in view from the first paint and the picture loads at once. */}
        {src === undefined ? null : <img src={src} alt="" loading="lazy" decoding="async" />}
      </div>
      <div className="ui-auth-art__brand">
        <BrandLockup />
      </div>
    </div>
  );
}
