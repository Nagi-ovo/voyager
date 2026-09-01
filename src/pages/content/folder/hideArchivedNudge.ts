import { getTranslationSyncUnsafe } from '@/utils/i18n';

export const NUDGE_CLASS = 'gv-hide-archived-nudge';

type ShouldShowArgs = {
  nudgeShown: boolean;
  hideArchivedAlreadyOn: boolean;
};

export function shouldShowHideArchivedNudge({
  nudgeShown,
  hideArchivedAlreadyOn,
}: ShouldShowArgs): boolean {
  if (nudgeShown) return false;
  if (hideArchivedAlreadyOn) return false;
  return true;
}

export type NudgeI18nKeys = {
  title: string;
  body: string;
  enable: string;
  dismiss: string;
  footnote: string;
};

const DEFAULT_I18N_KEYS: NudgeI18nKeys = {
  title: 'hideArchivedNudgeTitle',
  body: 'hideArchivedNudgeBody',
  enable: 'hideArchivedNudgeEnable',
  dismiss: 'hideArchivedNudgeDismiss',
  footnote: 'hideArchivedNudgeFootnote',
};

type MountArgs = {
  container: HTMLElement;
  onEnable: () => void;
  onDismiss: () => void;
  /** Extra classes for platform-scoped styling (e.g. `gv-hide-archived-nudge--aistudio`). */
  variantClass?: string;
  /** Override i18n keys — defaults to the Gemini copy. AI Studio passes its own keys. */
  i18nKeys?: Partial<NudgeI18nKeys>;
};

export function mountHideArchivedNudge({
  container,
  onEnable,
  onDismiss,
  variantClass,
  i18nKeys,
}: MountArgs): void {
  if (container.querySelector(`.${NUDGE_CLASS}`)) return;

  const t = (key: string) => getTranslationSyncUnsafe(key);
  const keys: NudgeI18nKeys = { ...DEFAULT_I18N_KEYS, ...i18nKeys };

  const card = document.createElement('div');
  card.className = variantClass ? `${NUDGE_CLASS} ${variantClass}` : NUDGE_CLASS;
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-live', 'polite');

  const title = document.createElement('div');
  title.className = `${NUDGE_CLASS}__title`;
  title.textContent = t(keys.title);

  const body = document.createElement('div');
  body.className = `${NUDGE_CLASS}__body`;
  body.textContent = t(keys.body);

  const actions = document.createElement('div');
  actions.className = `${NUDGE_CLASS}__actions`;

  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.className = `${NUDGE_CLASS}__btn ${NUDGE_CLASS}__btn--secondary`;
  dismissBtn.textContent = t(keys.dismiss);

  const enableBtn = document.createElement('button');
  enableBtn.type = 'button';
  enableBtn.className = `${NUDGE_CLASS}__btn ${NUDGE_CLASS}__btn--primary`;
  enableBtn.textContent = t(keys.enable);

  actions.appendChild(dismissBtn);
  actions.appendChild(enableBtn);

  const footnote = document.createElement('div');
  footnote.className = `${NUDGE_CLASS}__footnote`;
  footnote.textContent = t(keys.footnote);

  card.appendChild(title);
  card.appendChild(body);
  card.appendChild(actions);
  card.appendChild(footnote);

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

  const header = container.querySelector('.gv-folder-header');
  if (header && header.nextSibling) {
    container.insertBefore(card, header.nextSibling);
  } else {
    container.appendChild(card);
  }

  requestAnimationFrame(() => card.classList.add(`${NUDGE_CLASS}--show`));
}

export function unmountHideArchivedNudge(container: HTMLElement): void {
  const existing = container.querySelector(`.${NUDGE_CLASS}`);
  if (existing) existing.remove();
}
