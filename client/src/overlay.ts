/**
 * overlay.ts — shared modal behaviour for Hiroba's dialog overlays.
 *
 * The five panels (invite, members, server settings, audio settings, screen
 * permission) all claim `aria-modal="true"`, so they owe the user what a modal
 * promises:
 *   - Escape closes, and so does a click on the backdrop outside the card.
 *   - Tab stays inside the card; the page behind it leaves the tab order.
 *   - Focus moves into the card on open and returns to the opener on close.
 *
 * Each panel keeps its own show/hide function — they carry panel-specific
 * cleanup (closing a custom select, clearing an error line) that does not
 * belong here. So this watches the `hidden` attribute instead of wrapping
 * them: every existing call site gains the behaviour without being rerouted.
 */

// ---------------------------------------------------------------------------
// Module state — the open overlays, innermost last
// ---------------------------------------------------------------------------

type Entry = {
  el: HTMLElement;
  /** The `role="dialog"` card; the backdrop is everything outside it. */
  card: HTMLElement;
  onClose: () => void;
  /** Where focus goes when this panel closes. */
  opener: HTMLElement | null;
};

const stack: Entry[] = [];

/** WebKit does not focus a <button> on click, so `activeElement` is usually
 *  <body> by the time a panel opens. The element last pressed is the honest
 *  opener to hand focus back to. */
let lastPressed: HTMLElement | null = null;

let docBound = false;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),' +
  ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Give an overlay the modal contract described above. `onClose` is the panel's
 * own hide function, so Escape and backdrop clicks run exactly the same
 * cleanup as the Close button.
 */
export function bindOverlayDismiss(el: HTMLElement, onClose: () => void): void {
  const card = el.querySelector<HTMLElement>('[role="dialog"]') ?? el;
  bindDocument();

  el.addEventListener("click", (e) => {
    if (e.target === el) onClose(); // backdrop, not the card
  });

  new MutationObserver(() => {
    if (el.hasAttribute("hidden")) pop(el);
    else push(el, card, onClose);
  }).observe(el, { attributes: true, attributeFilter: ["hidden"] });

  if (!el.hasAttribute("hidden")) push(el, card, onClose);
}

// ---------------------------------------------------------------------------
// Open / close bookkeeping
// ---------------------------------------------------------------------------

function push(el: HTMLElement, card: HTMLElement, onClose: () => void): void {
  if (stack.some((e) => e.el === el)) return;
  stack.push({ el, card, onClose, opener: findOpener(el) });
  applyInert();
  // A caller may have aimed focus at a specific field already (server settings
  // opens on the URL the user must fix); only fall back to the first control.
  if (!card.contains(document.activeElement)) focusables(card)[0]?.focus();
}

function pop(el: HTMLElement): void {
  const i = stack.findIndex((e) => e.el === el);
  if (i === -1) return;
  const [entry] = stack.splice(i, 1);
  applyInert();
  // Reclaim focus only if we still hold it: showJoin() and showSpace() hide
  // panels while deliberately landing the caret somewhere else.
  const ae = document.activeElement;
  const ours = ae === null || ae === document.body || entry.card.contains(ae);
  const opener = entry.opener;
  if (ours && opener?.isConnected && !opener.closest("[hidden]")) opener.focus();
}

function findOpener(el: HTMLElement): HTMLElement | null {
  const ae = document.activeElement;
  if (ae instanceof HTMLElement && ae !== document.body && !el.contains(ae)) return ae;
  if (lastPressed?.isConnected && !el.contains(lastPressed)) return lastPressed;
  return null;
}

/** Take the page behind the innermost panel out of the tab order (and out of
 *  reach of a screen reader's virtual cursor). `inert` is ignored by older
 *  WebViews, where the Tab trap below is the fallback. */
function applyInert(): void {
  const top = stack[stack.length - 1]?.el;
  for (const node of document.body.children) {
    if (!(node instanceof HTMLElement)) continue;
    // Live regions keep announcing behind a modal — a toast that fires while a
    // panel is open is exactly the kind the user needs to hear.
    node.toggleAttribute("inert", top !== undefined && node !== top && !node.hasAttribute("aria-live"));
  }
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

function bindDocument(): void {
  if (docBound) return;
  docBound = true;

  document.addEventListener(
    "pointerdown",
    (e) => {
      const t = e.target;
      lastPressed =
        t instanceof HTMLElement ? t.closest<HTMLElement>('button, a[href], [tabindex]') : null;
    },
    true,
  );

  // Capture, so the check below sees an open select's list before the select's
  // own Escape handler has closed it — otherwise one Escape would close both.
  document.addEventListener(
    "keydown",
    (e) => {
      const top = stack[stack.length - 1];
      if (!top) return;
      if (e.key === "Escape") {
        // An open custom select owns Escape first; the panel stays put.
        if (top.card.querySelector('.cselect-trigger[aria-expanded="true"]')) return;
        e.preventDefault();
        top.onClose();
      } else if (e.key === "Tab") {
        trapTab(top.card, e);
      }
    },
    true,
  );
}

/** Wrap Tab / Shift+Tab around the card's own controls. */
function trapTab(card: HTMLElement, e: KeyboardEvent): void {
  const items = focusables(card);
  if (items.length === 0) {
    e.preventDefault();
    return;
  }
  const ae = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const at = ae ? items.indexOf(ae) : -1;

  // Focus can sit on something untabbable inside the card: an open select's
  // list, which the select closes on this same Tab. Carry on from where it
  // sits rather than snapping to the card's edge.
  if (at === -1 && ae && card.contains(ae)) {
    const following = (n: HTMLElement) =>
      (ae.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    const next = e.shiftKey
      ? items.filter((n) => !following(n)).pop()
      : items.find(following);
    if (next) {
      e.preventDefault();
      next.focus();
      return;
    }
  }

  const edge = e.shiftKey ? 0 : items.length - 1;
  if (at !== -1 && at !== edge) return; // room left inside the card; let Tab move
  e.preventDefault();
  items[e.shiftKey ? items.length - 1 : 0].focus();
}

/** The card's focusable controls in tab order, skipping anything hidden — a
 *  collapsed select list, a result block that has not been revealed yet. */
function focusables(card: HTMLElement): HTMLElement[] {
  return [...card.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (n) => !n.closest("[hidden]") && n.getClientRects().length > 0,
  );
}
