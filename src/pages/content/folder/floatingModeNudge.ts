import { getTranslationSyncUnsafe } from '@/utils/i18n';

export const FLOATING_MODE_NUDGE_CLASS = 'gv-floating-mode-nudge';

type ShouldShowArgs = {
  nudgeShown: boolean;
  floatingAlreadyOpen: boolean;
};

export function shouldShowFloatingModeNudge({
  nudgeShown,
  floatingAlreadyOpen,
}: ShouldShowArgs): boolean {
  if (nudgeShown) return false;
  if (floatingAlreadyOpen) return false;
  return true;
}

export type FloatingModeNudgeI18nKeys = {
  title: string;
  body: string;
  enable: string;
  dismiss: string;
};

const DEFAULT_I18N_KEYS: FloatingModeNudgeI18nKeys = {
  title: 'floatingModeNudgeTitle',
  body: 'floatingModeNudgeBody',
  enable: 'floatingModeNudgeEnable',
  dismiss: 'floatingModeNudgeDismiss',
};

type MountArgs = {
  onEnable: () => void;
  onDismiss: () => void;
  variantClass?: string;
  i18nKeys?: Partial<FloatingModeNudgeI18nKeys>;
};

export function mountFloatingModeNudge({
  onEnable,
  onDismiss,
  variantClass,
  i18nKeys,
}: MountArgs): HTMLElement | null {
  if (document.querySelector(`.${FLOATING_MODE_NUDGE_CLASS}`)) return null;

  const t = (key: string) => getTranslationSyncUnsafe(key);
  const keys: FloatingModeNudgeI18nKeys = { ...DEFAULT_I18N_KEYS, ...i18nKeys };

  const card = document.createElement('div');
  card.className = variantClass
    ? `${FLOATING_MODE_NUDGE_CLASS} ${variantClass}`
    : FLOATING_MODE_NUDGE_CLASS;
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-live', 'polite');

  const title = document.createElement('div');
  title.className = `${FLOATING_MODE_NUDGE_CLASS}__title`;
  title.textContent = t(keys.title);

  const body = document.createElement('div');
  body.className = `${FLOATING_MODE_NUDGE_CLASS}__body`;
  body.textContent = t(keys.body);

  const actions = document.createElement('div');
  actions.className = `${FLOATING_MODE_NUDGE_CLASS}__actions`;

  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.className = `${FLOATING_MODE_NUDGE_CLASS}__btn ${FLOATING_MODE_NUDGE_CLASS}__btn--secondary`;
  dismissBtn.textContent = t(keys.dismiss);

  const enableBtn = document.createElement('button');
  enableBtn.type = 'button';
  enableBtn.className = `${FLOATING_MODE_NUDGE_CLASS}__btn ${FLOATING_MODE_NUDGE_CLASS}__btn--primary`;
  enableBtn.textContent = t(keys.enable);

  actions.appendChild(dismissBtn);
  actions.appendChild(enableBtn);

  card.appendChild(title);
  card.appendChild(body);
  card.appendChild(actions);

  const cleanup = () => {
    card.remove();
  };

  dismissBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    cleanup();
    onDismiss();
  });
  enableBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    cleanup();
    onEnable();
  });

  document.body.appendChild(card);
  requestAnimationFrame(() => card.classList.add(`${FLOATING_MODE_NUDGE_CLASS}--show`));
  return card;
}

export function unmountFloatingModeNudge(): void {
  const existing = document.querySelector(`.${FLOATING_MODE_NUDGE_CLASS}`);
  if (existing) existing.remove();
}
