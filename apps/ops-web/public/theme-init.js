/* global document, localStorage */
/*
 * Applies the person's stored choice of theme before the page is first painted (redesign step R4; PRODUCT_DESIGN_DIRECTION section 7).
 *
 * It is a classic script in the head of index.html: a classic script blocks the parser and runs before anything is painted, a module script is
 * deferred (the page could paint once in the system theme first), and an inline script is refused by the content-security policy (script-src
 * 'self', never relaxed). It reads the one key that src/platform/theme/theme-choice.ts writes (test/theme-init.test.ts holds the two together)
 * and does nothing else: `system` is no stored value, so a person who follows their system has nothing to apply, and the attribute is then left
 * off, as tokens.css reads it. Storage that cannot be read (a private window, blocked site data) leaves the page in the system theme.
 */
(function () {
  try {
    var choice = localStorage.getItem('melarc-theme');
    if (choice === 'light' || choice === 'dark') {
      document.documentElement.setAttribute('data-theme', choice);
    }
  } catch {
    // The page follows the system setting.
  }
})();
