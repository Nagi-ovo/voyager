/** Selectors and semantic fallbacks shared by send-related content features. */
export const SEND_BUTTON_SELECTORS = [
  '.update-button',
  'button[aria-label*="Send"]',
  'button[aria-label*="send"]',
  'button[aria-label*="Run"]',
  'button[aria-label*="run"]',
  'button[data-tooltip*="Send"]',
  'button[data-tooltip*="send"]',
  'button[data-tooltip*="Run"]',
  'button[data-tooltip*="run"]',
  'button[mattooltip*="Run"]',
  'button[mattooltip*="run"]',
  'button[data-testid*="send"]',
  'button[data-testid*="submit"]',
  'button mat-icon[fonticon="send"]',
  'button mat-icon[fonticon="play_arrow"]',
  '[data-send-button]',
  '.send-button',
  'button[aria-label*="Update"]',
  'button[aria-label*="Save"]',
  'button[aria-label*="更新"]',
] as const;

const ACTION_BUTTON_LABEL_ATTRIBUTES = [
  'aria-label',
  'data-tooltip',
  'mattooltip',
  'title',
] as const;

const ACTION_BUTTON_LABEL_PATTERN =
  /\b(send|submit|run|update|save|confirm)\b|发送|提交|傳送|送出|送信|전송|enviar|envoyer|senden|отправ|إرسال|运行|執行|実行|실행|更新|保存|修改/i;

const UPDATE_BUTTON_LABEL_PATTERN =
  /\b(update|save|confirm)\b|更新|保存|actualizar|guardar|mettre à jour|enregistrer|atualizar|salvar|обновить|сохранить|更新する|保存する|업데이트|저장|تحديث|حفظ/i;

const SEND_COMPOSER_SELECTORS = [
  'form',
  '.text-input-field',
  '.input-area',
  'ms-prompt-input-wrapper',
  'ms-prompt-input',
  'ms-chat-turn-input',
  'chat-message',
] as const;

const SEND_INPUT_SELECTOR =
  '[data-testid="chat-input"][contenteditable="true"], #prompt-textarea[contenteditable="true"], ' +
  'rich-textarea [contenteditable="true"], [contenteditable="true"][role="textbox"], ' +
  '[contenteditable="true"], textarea';

function getButtonLabel(button: HTMLButtonElement): string {
  const labels = ACTION_BUTTON_LABEL_ATTRIBUTES.map((attribute) => button.getAttribute(attribute));
  labels.push(button.textContent);
  return labels.filter(Boolean).join(' ');
}

function hasSendActionIcon(button: HTMLButtonElement): boolean {
  const icon = button.querySelector<HTMLElement>('.material-symbols-outlined, mat-icon');
  const iconName = (icon?.getAttribute('fonticon') || icon?.textContent || '').trim().toLowerCase();
  return iconName === 'send' || iconName === 'play_arrow';
}

/** Recognizes selector-based, localized-label, and icon-only send/action buttons. */
export function isSendActionButton(button: HTMLButtonElement): boolean {
  const matchesKnownSelector = SEND_BUTTON_SELECTORS.some((selector) => {
    try {
      return button.matches(selector) || Boolean(button.querySelector(selector));
    } catch {
      return false;
    }
  });
  return (
    matchesKnownSelector ||
    ACTION_BUTTON_LABEL_PATTERN.test(getButtonLabel(button)) ||
    hasSendActionIcon(button)
  );
}

/** Resolves a click target (including an icon child) to a recognized action button. */
export function findClosestSendActionButton(target: Element): HTMLButtonElement | null {
  const button = target.closest('button');
  return button instanceof HTMLButtonElement && isSendActionButton(button) ? button : null;
}

/** Distinguishes an edit submission from the initial Edit action. */
export function isUpdateActionButton(button: HTMLButtonElement): boolean {
  return (
    button.matches('.update-button') || UPDATE_BUTTON_LABEL_PATTERN.test(getButtonLabel(button))
  );
}

/** Finds the editable input owned by a recognized send/update button. */
export function findInputForSendActionButton(button: HTMLButtonElement): HTMLElement | null {
  let ancestor = button.parentElement;
  while (ancestor && ancestor !== document.body) {
    if (SEND_COMPOSER_SELECTORS.some((selector) => ancestor?.matches(selector))) {
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        ancestor.contains(active) &&
        active.matches(SEND_INPUT_SELECTOR)
      ) {
        return active;
      }
      const input = ancestor.querySelector<HTMLElement>(SEND_INPUT_SELECTOR);
      if (input) return input;
    }
    ancestor = ancestor.parentElement;
  }
  return null;
}

/** Mirrors Gemini send-key semantics, including Voyager's Ctrl+Enter mode. */
export function isSendKeyboardEvent(event: KeyboardEvent, ctrlEnterSendEnabled: boolean): boolean {
  if (event.key !== 'Enter' || event.isComposing) return false;
  const hasCtrlModifier = event.ctrlKey || event.metaKey;
  if (ctrlEnterSendEnabled) return hasCtrlModifier;
  return !event.shiftKey || hasCtrlModifier;
}
