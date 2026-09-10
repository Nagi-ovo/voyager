/** Keep the HUD near its configured composer without attaching it to the page body. */
export function getVimComposerMount(
  input: HTMLElement | null,
  configuredSelector: string | null,
): HTMLElement | null {
  if (!input) return null;
  if (input.matches('#prompt-textarea[contenteditable="true"]')) return input.closest('form');
  if (input.matches('[data-testid="chat-input"][contenteditable="true"]')) {
    return input.closest('fieldset');
  }
  if (!configuredSelector) return null;
  try {
    if (!input.matches(configuredSelector)) return null;
  } catch {
    return null;
  }
  const parent = input.parentElement;
  return parent &&
    parent !== input.ownerDocument.body &&
    parent !== input.ownerDocument.documentElement
    ? parent
    : null;
}
