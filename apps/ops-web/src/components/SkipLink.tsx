/**
 * The first tab stop on every page: it lets a keyboard user jump past the header to the main content.
 * Hidden until it has focus (see base.css). Focus is moved explicitly, because a hash link inside a
 * client-side router does not reliably move it.
 */
export function SkipLink({ targetId }: { readonly targetId: string }) {
  return (
    <a
      className="skip-link"
      href={`#${targetId}`}
      onClick={(event) => {
        event.preventDefault();
        document.getElementById(targetId)?.focus();
      }}
    >
      Skip to main content
    </a>
  );
}
