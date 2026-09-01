export type ResponseActionCopyImageOptions = {
  label: string;
  tooltip: string;
  onClick: (button: HTMLElement) => void;
};

const COPY_BUTTON_TEST_ID = 'copy-button';
const MORE_BUTTON_TEST_ID = 'more-menu-button';
const COPY_IMAGE_BUTTON_TEST_ID = 'gv-copy-image-button';
const COPY_ICON_NAME = 'content_copy';
const COPY_BUTTON_ARIA_PATTERNS = [/^copy\b/i, /复制/];
const ACTION_BUTTON_SELECTOR = 'button, gem-icon-button, [role="button"]';
const COPY_ICON_SELECTOR =
  'mat-icon[fonticon="content_copy"], mat-icon[data-mat-icon-name="content_copy"]';
// The exact set of containers Gemini uses for the per-response action bar.
// We MUST scope copy-button searches to one of these — walking past it (e.g.,
// up to `document.body`) accidentally finds disabled template/hidden copy
// buttons that belong to a totally different button family (stock Material
// `mdc-icon-button` instead of Gemini's `gem-button-*`), producing a button
// that's the wrong size, mis-centered, and inherits `pointer-events: none`.
const ACTION_BAR_SELECTOR =
  'message-actions, .message-actions, .actions-container-v2, .buttons-container-v2';
// Preferred clone sources when the action bar has no copy-button (e.g.,
// image-generation responses). Sibling buttons in the same bar share Gemini's
// `gem-button-*` sizing/centering, so the cloned button visually matches.
const SIBLING_CLONE_SOURCE_TEST_IDS = [
  'share-button',
  'thumb-up-button',
  'regenerate-button',
  'thumb-down-button',
];
const ACTION_ROOT_SELECTOR = [
  'message-actions',
  '.message-actions',
  '.actions-container-v2',
  '.buttons-container-v2',
  '[data-test-id="copy-button"]',
  '[data-test-id="more-menu-button"]',
  ACTION_BUTTON_SELECTOR,
  'mat-icon',
].join(', ');
const ASSISTANT_SCOPE_SELECTOR = [
  '[data-message-author-role="assistant"]',
  '[data-message-author-role="model"]',
  'article[data-author="assistant"]',
  'article[data-turn="assistant"]',
  'article[data-turn="model"]',
  '.model-response',
  'model-response',
  '.response-container',
  '.presented-response-container',
].join(', ');

type BoundCopyImageButton = HTMLElement & {
  __gvCopyImageHandler?: (event: Event) => void;
};

function updateButtonLabelAndTooltip(
  button: HTMLElement,
  label: string,
  tooltip: string,
): HTMLElement {
  const interactive = button.matches('button')
    ? button
    : ((button.querySelector(ACTION_BUTTON_SELECTOR) as HTMLElement | null) ?? button);

  interactive.setAttribute('aria-label', tooltip);
  interactive.title = tooltip;
  interactive.removeAttribute('aria-describedby');
  button.setAttribute('aria-label', tooltip);
  button.title = tooltip;
  button.setAttribute('data-gv-copy-image-label', label);

  return interactive;
}

// The native Copy button we clone may itself be disabled at the moment we
// clone (e.g., mid-stream, before the reply finishes). Image-generation
// replies don't even have a copy-button; we fall back to cloning the
// share-image button, which on this page actually carries Material's
// `mat-mdc-button-disabled` class. The class alone sets `pointer-events: none`
// via Material CSS, so clearing only the `disabled`/`aria-disabled` attributes
// isn't enough — the button still swallows clicks (we see only a ripple, no
// handler runs) and renders dim. Strip every disabled marker Material uses.
const DISABLED_CLASSES = [
  'mat-mdc-button-disabled',
  'mdc-icon-button--disabled',
  'mat-mdc-icon-button-disabled',
  'mdc-button--disabled',
  'cdk-disabled',
  // Gemini's own gem-button family uses its own disabled marker (e.g., the
  // share-button on image responses carries it); clear it too so a cloned
  // sibling-button stays clickable.
  'gem-button-disabled',
];

function ensureButtonEnabled(button: HTMLElement, interactive: HTMLElement): void {
  for (const el of [button, interactive]) {
    el.removeAttribute('disabled');
    el.setAttribute('aria-disabled', 'false');
    if (el instanceof HTMLButtonElement) el.disabled = false;
    for (const cls of DISABLED_CLASSES) el.classList.remove(cls);
    // Defensive: a stray inline `pointer-events:none` left over from a
    // template clone would also block clicks.
    if (el.style.pointerEvents === 'none') el.style.pointerEvents = '';
  }
}

// Material Symbols "image" path (viewBox: 0 -960 960 960). Inline SVG is the
// only reliable approach for this button: the cloned native Copy icon uses
// Gemini's `lumi-symbols` font, which has no `image` glyph; switching the font
// family to Google Symbols doesn't help because that font isn't loaded on
// Gemini's page — the browser falls back to a system font and renders the
// literal letters "image", which is the broken-icon symptom from #711.
const COPY_IMAGE_SVG_PATH =
  'M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm0-80h560v-560H200v560Zm40-80h480L570-480 450-320l-90-120-120 160Zm-40 80v-560 560Z';
const LUMI_ICON_CLASS_PATTERN = /^lm-icon-|^lumi-/;

function updateButtonIcon(button: HTMLElement): void {
  const icon = button.querySelector('mat-icon');
  if (!(icon instanceof HTMLElement)) return;

  // Strip everything that would otherwise pull in Gemini's icon font (which
  // doesn't have the `image` glyph) and replace the content with an inline
  // SVG that inherits the surrounding `currentColor`. We deliberately do NOT
  // change mat-icon's display/vertical-align — the cloned sibling's existing
  // `gem-icon` parent already flex-centers the icon at the right size; adding
  // our own centering hacks fights that and shifts the SVG off-center.
  icon.removeAttribute('fonticon');
  icon.removeAttribute('data-mat-icon-name');
  icon.removeAttribute('data-mat-icon-namespace');
  icon.removeAttribute('data-mat-icon-type');
  Array.from(icon.classList)
    .filter((cls) => LUMI_ICON_CLASS_PATTERN.test(cls) || cls === 'mat-ligature-font')
    .forEach((cls) => icon.classList.remove(cls));
  icon.classList.add('gv-copy-image-icon');
  icon.style.fontFamily = '';
  // Standard Material practice: icons inside an icon-button should be
  // click-through so the button itself receives every click uniformly. Without
  // this, clicks on the SVG's painted area (the icon glyph) hit the SVG/icon
  // and — for reasons that vary between gem-icon-button variants — sometimes
  // get swallowed before reaching our click handler on the button. Clicks on
  // the padding around the icon still work via the touch-target overlay; the
  // user-visible symptom is "click works on the edge of the circle but not on
  // the icon itself". Setting pointer-events:none on mat-icon (and the SVG)
  // makes every pixel inside the button equally clickable.
  icon.style.pointerEvents = 'none';
  icon.setAttribute('aria-hidden', 'true');
  // SVG fills mat-icon's full box and is centered by mat-icon's parent
  // (`gem-icon` inline-flex container). `display:block` removes the inline
  // baseline gap that would otherwise nudge the glyph down a pixel.
  // `pointer-events:none` mirrors the parent — defense-in-depth in case a
  // theme override re-enables them on mat-icon.
  icon.innerHTML = `<svg viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true" focusable="false" style="width: 100%; height: 100%; display: block; pointer-events: none;"><path d="${COPY_IMAGE_SVG_PATH}"/></svg>`;
}

function findButtonByTestId(container: HTMLElement, testId: string): HTMLElement | null {
  const escaped =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(testId) : testId;
  return (container.querySelector(`[data-test-id="${escaped}"]`) as HTMLElement | null) ?? null;
}

function findCopyButtonInContainer(container: HTMLElement): HTMLElement | null {
  // Legacy: test-id="copy-button"
  const byTestId = findButtonByTestId(container, COPY_BUTTON_TEST_ID);
  if (byTestId) return byTestId;

  // gem UI: button has no test-id, identify by mat-icon[fonticon="content_copy"]
  // and aria-label starting with "Copy" (English) / 含 "复制" (Chinese) — we still
  // try other locales by checking icon first and only filter aria as a sanity check.
  const iconCandidates = Array.from(container.querySelectorAll<HTMLElement>(COPY_ICON_SELECTOR));
  if (iconCandidates.length === 0) {
    iconCandidates.push(
      ...Array.from(container.querySelectorAll<HTMLElement>('mat-icon')).filter(
        (icon) => icon.textContent?.trim() === COPY_ICON_NAME,
      ),
    );
  }

  for (const icon of iconCandidates) {
    const el = icon.closest(ACTION_BUTTON_SELECTOR) as HTMLElement | null;
    if (!el || !container.contains(el)) continue;
    const aria = el.getAttribute('aria-label') || '';
    // Skip if aria-label looks unrelated (defensive — most copy buttons match the patterns)
    if (aria && !COPY_BUTTON_ARIA_PATTERNS.some((re) => re.test(aria))) continue;
    return el;
  }
  return null;
}

function findActionContainerFromMoreButton(moreButton: HTMLElement): HTMLElement | null {
  if (!moreButton.closest(ASSISTANT_SCOPE_SELECTOR)) return null;
  // Stop at the immediate action bar that owns this more-button. Do NOT walk
  // farther looking for a copy-button — image responses don't have one in the
  // bar, and the broader DOM contains hidden/template copy buttons that have
  // the wrong styling (see SIBLING_CLONE_SOURCE_TEST_IDS for why).
  return moreButton.closest(ACTION_BAR_SELECTOR) as HTMLElement | null;
}

function isButtonUsable(el: HTMLElement): boolean {
  if (el instanceof HTMLButtonElement && el.disabled) return false;
  if (el.getAttribute('aria-disabled') === 'true') return false;
  // We deliberately don't gate on geometry — on-hover sibling buttons may be
  // size-0 between hovers, but their style classes (which is all we care
  // about) are still correct to clone.
  return true;
}

function findCloneSource(container: HTMLElement, moreButton: HTMLElement): HTMLElement {
  // Preferred: a real copy-button in the same bar (text-response path —
  // perfect style match).
  const copy = findCopyButtonInContainer(container);
  if (copy && isButtonUsable(copy)) return copy;

  // Fallback: any sibling action button. They all share the same
  // `gem-button-*` size/centering, so the cloned button stays visually
  // consistent with the bar.
  for (const testId of SIBLING_CLONE_SOURCE_TEST_IDS) {
    const el = findButtonByTestId(container, testId);
    if (el && el !== moreButton && isButtonUsable(el)) return el;
  }

  // Last resort: the more-button itself. Always present (we needed it to find
  // the container in the first place) but its tooltip wraps differently and
  // its icon container has slightly different padding — accept the cosmetic
  // mismatch over not injecting at all.
  return moreButton;
}

function bindButtonClick(
  button: HTMLElement,
  interactive: HTMLElement,
  onClick: (button: HTMLElement) => void,
): void {
  const typed = button as BoundCopyImageButton;
  if (typed.__gvCopyImageHandler) {
    interactive.removeEventListener('click', typed.__gvCopyImageHandler);
  }

  const handler = (event: Event) => {
    try {
      event.preventDefault();
    } catch {}
    try {
      event.stopPropagation();
    } catch {}
    onClick(button);
  };

  typed.__gvCopyImageHandler = handler;
  interactive.addEventListener('click', handler);
}

function isAssistantActionContainer(container: HTMLElement): boolean {
  return !!container.closest(ASSISTANT_SCOPE_SELECTOR);
}

function mayContainAssistantActionRoot(root: ParentNode): boolean {
  if (!(root instanceof HTMLElement)) return true;
  if (root.closest(ASSISTANT_SCOPE_SELECTOR)) return true;
  return !!root.querySelector(ASSISTANT_SCOPE_SELECTOR);
}

function shouldProbeDirectActionRoot(root: HTMLElement): boolean {
  if (!root.closest(ASSISTANT_SCOPE_SELECTOR)) return false;
  return !!(root.matches(ACTION_ROOT_SELECTOR) || root.closest(ACTION_ROOT_SELECTOR));
}

function ensureButtonPosition(
  container: HTMLElement,
  copyImageButton: HTMLElement,
  moreButton: HTMLElement,
): void {
  if (!moreButton.parentElement) {
    if (!container.contains(copyImageButton)) container.appendChild(copyImageButton);
    return;
  }

  if (copyImageButton !== moreButton.previousElementSibling) {
    moreButton.parentElement.insertBefore(copyImageButton, moreButton);
  }
}

function injectIntoActionContainer(
  container: HTMLElement,
  options: ResponseActionCopyImageOptions,
): HTMLElement | null {
  if (!isAssistantActionContainer(container)) return null;

  const moreButton = findButtonByTestId(container, MORE_BUTTON_TEST_ID);
  if (!(moreButton instanceof HTMLElement)) return null;

  const existing = findButtonByTestId(container, COPY_IMAGE_BUTTON_TEST_ID);
  if (existing) {
    const interactive = updateButtonLabelAndTooltip(existing, options.label, options.tooltip);
    ensureButtonEnabled(existing, interactive);
    updateButtonIcon(existing);
    bindButtonClick(existing, interactive, options.onClick);
    ensureButtonPosition(container, existing, moreButton);
    return existing;
  }

  const cloneSource = findCloneSource(container, moreButton);
  const cloned = cloneSource.cloneNode(true) as HTMLElement;
  cloned.setAttribute('data-test-id', COPY_IMAGE_BUTTON_TEST_ID);
  cloned.removeAttribute('id');
  // Strip telemetry / framework identifiers tied to the source action
  // (jslog/jscontroller etc.) so click telemetry isn't attributed to the
  // source button.
  ['jslog', 'jscontroller', 'jsaction', 'jsname', 'aria-describedby'].forEach((attr) =>
    cloned.removeAttribute(attr),
  );

  const interactive = updateButtonLabelAndTooltip(cloned, options.label, options.tooltip);
  ensureButtonEnabled(cloned, interactive);
  updateButtonIcon(cloned);
  bindButtonClick(cloned, interactive, options.onClick);

  ensureButtonPosition(container, cloned, moreButton);
  return cloned;
}

export function injectResponseActionCopyImageButtons(
  root: ParentNode,
  options: ResponseActionCopyImageOptions,
): HTMLElement[] {
  if (!mayContainAssistantActionRoot(root)) return [];

  const moreButtons: HTMLElement[] = [];
  if (root instanceof HTMLElement && root.getAttribute('data-test-id') === MORE_BUTTON_TEST_ID) {
    moreButtons.push(root);
  }
  moreButtons.push(
    ...Array.from(root.querySelectorAll<HTMLElement>(`[data-test-id="${MORE_BUTTON_TEST_ID}"]`)),
  );

  if (
    moreButtons.length === 0 &&
    root instanceof HTMLElement &&
    shouldProbeDirectActionRoot(root)
  ) {
    const directContainer = findActionContainerFromMoreButton(root);
    if (directContainer) {
      const maybeInjected = injectIntoActionContainer(directContainer, options);
      return maybeInjected ? [maybeInjected] : [];
    }
  }

  const visitedContainers = new Set<HTMLElement>();
  const injected: HTMLElement[] = [];

  for (const moreButton of moreButtons) {
    const container = findActionContainerFromMoreButton(moreButton);
    if (!container || visitedContainers.has(container)) continue;
    visitedContainers.add(container);
    const maybeInjected = injectIntoActionContainer(container, options);
    if (maybeInjected) injected.push(maybeInjected);
  }

  return injected;
}
