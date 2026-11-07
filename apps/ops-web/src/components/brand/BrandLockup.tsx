import './brand-lockup.css';

/**
 * The symbol the Product Owner supplied, as served (the Ops Portal's favicon file, `public/favicon.svg`): used as the browser-tab icon and,
 * here, as the mark of the sidebar's rail and of the split screen (the brand README records both uses). Never recoloured, redrawn or cropped.
 */
const SYMBOL_URL = '/favicon.svg';

/**
 * The mark and the name of the product, side by side, for a surface on Ink (the sidebar's rail, the split screen's panel). The symbol is drawn
 * black and red and black is Ink, so it stands on a white tile; the name is plain text in the interface typeface, never a redrawing of the
 * wordmark (BRAND_FOUNDATION section 4.6). The mark is decorative: the text beside it says the same.
 */
export function BrandLockup() {
  return (
    <span className="ui-brand-lockup">
      <span className="ui-brand-lockup__mark">
        <img src={SYMBOL_URL} alt="" />
      </span>
      <span className="ui-brand-lockup__text">
        <span className="ui-brand-lockup__name">Melarc Logistics</span>
        <span className="ui-brand-lockup__app">Ops Portal</span>
      </span>
    </span>
  );
}
