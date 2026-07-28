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
