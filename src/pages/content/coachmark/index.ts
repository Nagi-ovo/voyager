/**
 * Reusable one-time feature coachmark.
 *
 * A "product-tour" primitive for content scripts: dim the page, optionally
 * reveal a preview of the feature, then float an anchored bubble next to it with
 * a one-line intro and (optionally) an inline toggle the user can flip right
 * there. Shows at most once per user — every coachmark has a stable `id` and the
 * seen ids live in one synced array (`StorageKeys.COACHMARKS_SEEN`).
 *
 * It owns none of the feature it introduces: callers pass strings (already
 * localized), an anchor resolver, and an optional toggle handler. This keeps it
 * trivial to add the same guided intro to any future feature — build a tiny
 * consumer that mounts a preview and calls {@link showCoachmark}.
 *
 * Visual style mirrors the existing `gv-pm-*` body-appended popover (anchored,
 * arrow, explicit close / Escape to exit) and the nudge cards' rAF `--show`
 * entrance, so it feels native to the rest of the extension.
 */
import browser from 'webextension-polyfill';

import { StorageKeys } from '@/core/types/common';

export type CoachmarkResult = 'confirmed' | 'enabled' | 'advanced' | 'dismissed' | 'skipped';

export interface CoachmarkProgress {
  current: number;
  total: number;
}

export interface CoachmarkSequenceStep {
  /** Stable id used to remove already-seen steps before calculating progress. */
  id: string;
  /** Feature-specific availability check, without mounting any guide UI. */
  isEligible?: () => boolean | Promise<boolean>;
  /** Show this step with its position among the remaining eligible steps. */
  show: (progress: CoachmarkProgress) => CoachmarkResult | Promise<CoachmarkResult>;
}

export interface CoachmarkToggle {
  label: string;
  /** Initial switch state (usually the feature's current enabled value). */
  initial: boolean;
  /** Called whenever the user flips the switch. May persist the setting. */
  onChange: (on: boolean) => void | Promise<void>;
}

export interface CoachmarkReveal {
  /** Mount and return the preview element (appended to the page by the caller). */
  mount: () => HTMLElement;
  /** Let the user operate controls inside the revealed element while the guide stays open. */
  interactive?: boolean;
  /**
   * Undo every side effect from mount. Receives null when mount failed before
   * returning an element, so partial setup can still be rolled back.
   */
  unmount: (el: HTMLElement | null, result: CoachmarkResult) => void;
}

export interface CoachmarkConfig {
  /** Stable id — the once-per-user tracking key. */
  id: string;
  /** Resolve the element the bubble points at (called after `reveal` mounts). */
  anchor: () => HTMLElement | null;
  /** Optional feature preview revealed (animated in) before the bubble. */
  reveal?: CoachmarkReveal;
  title?: string;
  body: string;
  /** Inline SVG / emoji markup shown before the title. */
  icon?: string;
  toggle?: CoachmarkToggle;
  /** Text of the secondary "dismiss" affordance. Omit to hide it. */
  dismissLabel?: string;
  /** Label used before the final step in a sequence. */
  nextLabel?: string;
  /** Accessible label for the top-right close button. */
  closeLabel?: string;
  /** Position in the active onboarding sequence. */
  progress?: CoachmarkProgress;
  /** Preferred side; auto-flips to stay on screen. Default 'top'. */
  placement?: 'top' | 'bottom';
  /** Dim the page behind the coachmark. Default true. */
  scrim?: boolean;
  /** Move focus into the coachmark on open and restore it on close. Default true. */
  focusOnOpen?: boolean;
  /** Set false to always show (ignores + does not record seen state). */
  once?: boolean;
  /**
   * Abort to close the coachmark from outside (e.g. the owning feature is
   * being torn down). Settles as 'skipped' WITHOUT recording seen state, so
   * an interrupted guide shows again next time.
   */
  signal?: AbortSignal;
}

const SEEN_KEY = StorageKeys.COACHMARKS_SEEN;
const ARROW_GAP = 14; // px between the anchor and the bubble
const ANIM_MS = 220; // keep in sync with the CSS transition

let activeId: string | null = null; // guard against stacking two coachmarks

// ── Seen-state (shared array, synced) ───────────────────────────────────────

async function readSeen(): Promise<string[]> {
  try {
    const got = (await browser.storage.sync.get({ [SEEN_KEY]: [] })) as Record<string, unknown>;
    const v = got[SEEN_KEY];
    return Array.isArray(v) ? (v.filter((x) => typeof x === 'string') as string[]) : [];
  } catch {
    return [];
  }
}

export async function hasSeenCoachmark(id: string): Promise<boolean> {
  return (await readSeen()).includes(id);
}

export async function markCoachmarkSeen(id: string): Promise<void> {
  try {
    const seen = await readSeen();
    if (seen.includes(id)) return;
    await browser.storage.sync.set({ [SEEN_KEY]: [...seen, id] });
  } catch {
    /* non-critical */
  }
}

/** Clear a coachmark's seen state (for debugging / "show me again"). */
export async function resetCoachmark(id: string): Promise<void> {
  try {
    const seen = await readSeen();
    await browser.storage.sync.set({ [SEEN_KEY]: seen.filter((x) => x !== id) });
  } catch {
    /* non-critical */
  }
}

export async function runCoachmarkSequence(
  steps: CoachmarkSequenceStep[],
): Promise<CoachmarkResult> {
  const pending: CoachmarkSequenceStep[] = [];

  for (const step of steps) {
    try {
      if (await hasSeenCoachmark(step.id)) continue;
      if (step.isEligible && !(await step.isEligible())) continue;
      pending.push(step);
    } catch {
      /* non-critical */
    }
  }

  let lastResult: CoachmarkResult = 'skipped';
  for (let index = 0; index < pending.length; index += 1) {
    try {
      const result = await pending[index].show({ current: index + 1, total: pending.length });
      if (result === 'dismissed') return result;
      if (result !== 'skipped') lastResult = result;
    } catch {
      /* non-critical; continue to the next available guide */
    }
  }
  return lastResult;
}

// ── DOM helpers ─────────────────────────────────────────────────────────────

function buildSwitch(toggle: CoachmarkToggle, onFlip: (on: boolean) => void): HTMLElement {
  const row = document.createElement('label');
  row.className = 'gv-coach-toggle';

  const text = document.createElement('span');
  text.className = 'gv-coach-toggle-label';
  text.textContent = toggle.label;

  const sw = document.createElement('button');
  sw.type = 'button';
  sw.className = 'gv-coach-switch';
  sw.setAttribute('role', 'switch');
  let on = toggle.initial;
  const reflect = () => sw.setAttribute('aria-checked', on ? 'true' : 'false');
  reflect();
  const knob = document.createElement('span');
  knob.className = 'gv-coach-knob';
  sw.appendChild(knob);
  sw.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    on = !on;
    reflect();
    onFlip(on);
  });

  row.appendChild(text);
  row.appendChild(sw);
  return row;
}

/** Place the bubble next to the anchor, flipping side to stay on screen. */
function positionBubble(bubble: HTMLElement, anchor: HTMLElement, prefer: 'top' | 'bottom'): void {
  const a = anchor.getBoundingClientRect();
  const bw = bubble.offsetWidth;
  const bh = bubble.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let side = prefer;
  if (side === 'top' && a.top - bh - ARROW_GAP < 8) side = 'bottom';
  if (side === 'bottom' && a.bottom + bh + ARROW_GAP > vh - 8) side = 'top';

  const anchorCenterX = a.left + a.width / 2;
  let left = anchorCenterX - bw / 2;
  left = Math.max(8, Math.min(vw - bw - 8, left));
  const top = side === 'top' ? a.top - bh - ARROW_GAP : a.bottom + ARROW_GAP;

  bubble.style.left = `${Math.round(left)}px`;
  bubble.style.top = `${Math.round(Math.max(8, top))}px`;
  bubble.setAttribute('data-side', side);

  // Point the arrow at the anchor's centre, clamped within the bubble.
  const arrowX = Math.max(16, Math.min(bw - 16, anchorCenterX - left));
  bubble.style.setProperty('--gv-coach-arrow-x', `${Math.round(arrowX)}px`);
}

// ── Engine ──────────────────────────────────────────────────────────────────

export async function showCoachmark(cfg: CoachmarkConfig): Promise<CoachmarkResult> {
  const once = cfg.once !== false;
  const focusOnOpen = cfg.focusOnOpen !== false;
  if (activeId || cfg.signal?.aborted) return 'skipped';
  if (once && (await hasSeenCoachmark(cfg.id))) return 'skipped';
  if (cfg.signal?.aborted) return 'skipped';

  // Reveal the preview first so the anchor exists and the eye is drawn to it.
  let revealEl: HTMLElement | null = null;
  let revealMountFailed = false;
  if (cfg.reveal) {
    try {
      revealEl = cfg.reveal.mount();
      revealEl.classList.add('gv-coach-reveal');
      if (cfg.reveal.interactive) revealEl.classList.add('gv-coach-reveal-interactive');
      requestAnimationFrame(() => revealEl?.classList.add('--show'));
    } catch {
      revealMountFailed = true;
      try {
        cfg.reveal.unmount(null, 'skipped');
      } catch {
        /* cleanup is best-effort */
      }
      revealEl = null;
    }
  }

  const anchor = cfg.anchor() ?? revealEl;
  if (!anchor || !anchor.isConnected) {
    if (cfg.reveal && !revealMountFailed) {
      try {
        cfg.reveal.unmount(revealEl, 'skipped');
      } catch {
        /* cleanup is best-effort */
      }
    }
    return 'skipped';
  }

  activeId = cfg.id;
  const previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const scrim =
    cfg.scrim === false
      ? null
      : Object.assign(document.createElement('div'), { className: 'gv-coach-scrim' });
  if (scrim) document.body.appendChild(scrim);

  const bubble = document.createElement('div');
  bubble.className = 'gv-coach';
  bubble.setAttribute('role', 'dialog');
  const accessibleId = `gv-coach-${cfg.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'gv-coach-close';
  close.setAttribute('aria-label', cfg.closeLabel || 'Close');
  close.innerHTML =
    '<svg viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="m256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z"/></svg>';
  bubble.appendChild(close);

  if (cfg.title || cfg.icon) {
    const head = document.createElement('div');
    head.className = 'gv-coach-head';
    if (cfg.icon) {
      const ic = document.createElement('span');
      ic.className = 'gv-coach-icon';
      ic.innerHTML = cfg.icon;
      head.appendChild(ic);
    }
    if (cfg.title) {
      const ti = document.createElement('span');
      ti.className = 'gv-coach-title';
      ti.id = `${accessibleId}-title`;
      ti.textContent = cfg.title;
      head.appendChild(ti);
      bubble.setAttribute('aria-labelledby', ti.id);
    }
    bubble.appendChild(head);
  }

  const body = document.createElement('p');
  body.className = 'gv-coach-body';
  body.id = `${accessibleId}-body`;
  body.textContent = cfg.body;
  bubble.appendChild(body);
  if (cfg.title) bubble.setAttribute('aria-describedby', body.id);
  else bubble.setAttribute('aria-label', cfg.body);

  const arrow = document.createElement('span');
  arrow.className = 'gv-coach-arrow';
  bubble.appendChild(arrow);

  const placement = cfg.placement ?? 'top';
  document.body.appendChild(bubble);
  positionBubble(bubble, anchor, placement);
  requestAnimationFrame(() => {
    if (scrim) scrim.classList.add('--show');
    bubble.classList.add('--show');
  });
  // Re-place once the reveal + bubble entrance animations settle.
  window.setTimeout(() => {
    if (bubble.isConnected && anchor.isConnected) positionBubble(bubble, anchor, placement);
  }, ANIM_MS + 40);

  return new Promise<CoachmarkResult>((resolve) => {
    let settled = false;
    let toggleOn = cfg.toggle?.initial === true;

    const onAbort = () => settle('skipped', false, false);

    const settle = (result: CoachmarkResult, restoreFocus: boolean, recordSeen = true) => {
      if (settled) return;
      settled = true;
      if (once && recordSeen) void markCoachmarkSeen(cfg.id);
      cfg.signal?.removeEventListener('abort', onAbort);
      window.removeEventListener('click', onOutside, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onReflow);
      bubble.classList.remove('--show');
      scrim?.classList.remove('--show');
      revealEl?.classList.remove('--show');
      window.setTimeout(() => {
        try {
          bubble.remove();
        } catch {
          /* gone */
        }
        try {
          scrim?.remove();
        } catch {
          /* gone */
        }
        if (cfg.reveal) {
          try {
            cfg.reveal?.unmount(revealEl, result);
          } catch {
            /* gone */
          }
        }
        if (restoreFocus && focusOnOpen && previouslyFocused?.isConnected) {
          try {
            previouslyFocused.focus({ preventScroll: true });
          } catch {
            previouslyFocused.focus();
          }
        }
        if (activeId === cfg.id) activeId = null;
        resolve(result);
      }, ANIM_MS);
    };

    const onOutside = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null;
      if (
        target &&
        (target.closest('.gv-coach') || target === revealEl || revealEl?.contains(target))
      )
        return;
      // Keep accidental page clicks from dismissing the guide or triggering
      // unrelated controls. Explicit buttons, Escape, and interactive reveals
      // remain available.
      ev.preventDefault();
      ev.stopPropagation();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        ev.preventDefault();
        settle('dismissed', true);
      }
    };
    const onReflow = () => {
      if (!settled && anchor.isConnected) positionBubble(bubble, anchor, cfg.placement ?? 'top');
    };

    close.addEventListener('click', (e) => {
      e.stopPropagation();
      settle('dismissed', true);
    });

    if (cfg.toggle) {
      const handleFlip = (on: boolean) => {
        toggleOn = on;
        void Promise.resolve(cfg.toggle?.onChange(on)).catch(() => {});
        bubble.classList.toggle('gv-coach-enabled', on);
      };
      bubble.insertBefore(buildSwitch(cfg.toggle, handleFlip), arrow);
      bubble.classList.toggle('gv-coach-enabled', toggleOn);
    }

    if (cfg.dismissLabel) {
      const footer = document.createElement('div');
      footer.className = 'gv-coach-footer';

      if (cfg.progress) {
        const progress = document.createElement('span');
        progress.className = 'gv-coach-progress';
        progress.textContent = `${cfg.progress.current}/${cfg.progress.total}`;
        progress.setAttribute('aria-label', `${cfg.progress.current} / ${cfg.progress.total}`);
        footer.appendChild(progress);
      }

      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'gv-coach-dismiss';
      dismiss.textContent =
        cfg.progress && cfg.progress.current < cfg.progress.total
          ? (cfg.nextLabel ?? cfg.dismissLabel)
          : cfg.dismissLabel;
      dismiss.addEventListener('click', (e) => {
        e.stopPropagation();
        settle(toggleOn ? 'enabled' : 'confirmed', true);
      });
      footer.appendChild(dismiss);
      bubble.insertBefore(footer, arrow);
    }

    // External teardown: settle without recording seen state. Re-check the
    // flag after registering — an abort that landed during the async seen
    // lookup would otherwise be missed.
    cfg.signal?.addEventListener('abort', onAbort);
    if (cfg.signal?.aborted) {
      onAbort();
      return;
    }

    // Defer outside-click binding a tick so the opening interaction can't close it.
    window.setTimeout(() => {
      if (settled) return;
      window.addEventListener('click', onOutside, true);
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('resize', onReflow);
      if (focusOnOpen) {
        const initialFocus = bubble.querySelector<HTMLElement>('.gv-coach-dismiss') ?? close;
        initialFocus.focus({ preventScroll: true });
      }
    }, 0);
  });
}
