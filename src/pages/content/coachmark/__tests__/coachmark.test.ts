import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  hasSeenCoachmark,
  markCoachmarkSeen,
  resetCoachmark,
  runCoachmarkSequence,
  showCoachmark,
} from '../index';

// In-memory sync storage so the seen-set logic is deterministic.
const store: Record<string, unknown> = {};
vi.mock('webextension-polyfill', () => ({
  default: {
    storage: {
      sync: {
        get: vi.fn(async (defaults?: Record<string, unknown>) => {
          const out: Record<string, unknown> = { ...defaults };
          for (const k of Object.keys(out)) if (k in store) out[k] = store[k];
          return out;
        }),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          Object.assign(store, obj);
        }),
      },
    },
  },
}));

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  document.body.innerHTML = '';
});

describe('coachmark seen-state', () => {
  it('marks and reads seen ids in a shared array', async () => {
    expect(await hasSeenCoachmark('a')).toBe(false);
    await markCoachmarkSeen('a');
    await markCoachmarkSeen('a'); // idempotent
    expect(await hasSeenCoachmark('a')).toBe(true);
    expect(await hasSeenCoachmark('b')).toBe(false);
    expect(store['gvCoachmarksSeen']).toEqual(['a']);
  });

  it('resetCoachmark clears a single id', async () => {
    await markCoachmarkSeen('a');
    await markCoachmarkSeen('b');
    await resetCoachmark('a');
    expect(await hasSeenCoachmark('a')).toBe(false);
    expect(await hasSeenCoachmark('b')).toBe(true);
  });
});

describe('runCoachmarkSequence', () => {
  it('filters seen and ineligible steps, then shows the rest in order with progress', async () => {
    await markCoachmarkSeen('timeline');
    const calls: Array<string | { current: number; total: number }> = [];

    const result = await runCoachmarkSequence([
      {
        id: 'timeline',
        show: () => {
          calls.push('timeline');
          return 'confirmed';
        },
      },
      {
        id: 'usage',
        isEligible: () => false,
        show: () => {
          calls.push('usage');
          return 'confirmed';
        },
      },
      {
        id: 'folder-search',
        show: (progress) => {
          calls.push('folder-search', progress);
          return 'confirmed';
        },
      },
      {
        id: 'conversation-sort',
        show: (progress) => {
          calls.push('conversation-sort', progress);
          return 'enabled';
        },
      },
    ]);

    expect(calls).toEqual([
      'folder-search',
      { current: 1, total: 2 },
      'conversation-sort',
      { current: 2, total: 2 },
    ]);
    expect(result).toBe('enabled');
  });

  it('stops the current tour when a guide is explicitly dismissed', async () => {
    const second = vi.fn(() => 'confirmed' as const);
    const result = await runCoachmarkSequence([
      { id: 'first', show: () => 'dismissed' },
      { id: 'second', show: second },
    ]);

    expect(second).not.toHaveBeenCalled();
    expect(result).toBe('dismissed');
  });

  it('advances through multiple real coachmarks without a page refresh', async () => {
    const firstAnchor = document.createElement('div');
    const secondAnchor = document.createElement('div');
    document.body.append(firstAnchor, secondAnchor);

    const tour = runCoachmarkSequence([
      {
        id: 'real-first',
        show: (progress) =>
          showCoachmark({
            id: 'real-first',
            anchor: () => firstAnchor,
            body: 'first',
            progress,
            nextLabel: 'Next',
            dismissLabel: 'Done',
          }),
      },
      {
        id: 'real-second',
        show: (progress) =>
          showCoachmark({
            id: 'real-second',
            anchor: () => secondAnchor,
            body: 'second',
            progress,
            nextLabel: 'Next',
            dismissLabel: 'Done',
          }),
      },
    ]);

    await vi.waitFor(() => {
      expect(document.querySelector('.gv-coach-progress')?.textContent).toBe('1/2');
      expect(document.querySelector('.gv-coach-dismiss')?.textContent).toBe('Next');
    });
    (document.querySelector('.gv-coach-dismiss') as HTMLElement).click();

    await vi.waitFor(() => {
      expect(document.querySelector('.gv-coach-progress')?.textContent).toBe('2/2');
      expect(document.querySelector('.gv-coach-dismiss')?.textContent).toBe('Done');
    });
    (document.querySelector('.gv-coach-dismiss') as HTMLElement).click();

    expect(await tour).toBe('confirmed');
    expect(await hasSeenCoachmark('real-first')).toBe(true);
    expect(await hasSeenCoachmark('real-second')).toBe(true);
  });

  it('keeps the current guide open when the page is clicked', async () => {
    const firstAnchor = document.createElement('div');
    const secondAnchor = document.createElement('div');
    const pageButton = document.createElement('button');
    document.body.append(firstAnchor, secondAnchor, pageButton);

    const tour = runCoachmarkSequence([
      {
        id: 'outside-first',
        show: (progress) =>
          showCoachmark({
            id: 'outside-first',
            anchor: () => firstAnchor,
            body: 'first',
            progress,
            nextLabel: 'Next',
            dismissLabel: 'Done',
          }),
      },
      {
        id: 'outside-second',
        show: (progress) =>
          showCoachmark({
            id: 'outside-second',
            anchor: () => secondAnchor,
            body: 'second',
            progress,
            nextLabel: 'Next',
            dismissLabel: 'Done',
          }),
      },
    ]);

    await vi.waitFor(() => {
      expect(document.querySelector('.gv-coach-body')?.textContent).toBe('first');
    });
    pageButton.click();

    expect(document.querySelector('.gv-coach-body')?.textContent).toBe('first');
    expect(document.querySelector('.gv-coach-progress')?.textContent).toBe('1/2');
    expect(await hasSeenCoachmark('outside-first')).toBe(false);

    (document.querySelector('.gv-coach-dismiss') as HTMLElement).click();

    await vi.waitFor(() => {
      expect(document.querySelector('.gv-coach-body')?.textContent).toBe('second');
      expect(document.querySelector('.gv-coach-progress')?.textContent).toBe('2/2');
    });
    (document.querySelector('.gv-coach-dismiss') as HTMLElement).click();

    expect(await tour).toBe('confirmed');
    expect(await hasSeenCoachmark('outside-first')).toBe(true);
    expect(await hasSeenCoachmark('outside-second')).toBe(true);
  });
});

describe('showCoachmark', () => {
  it('skips (no DOM) when already seen', async () => {
    await markCoachmarkSeen('seen-one');
    const anchor = document.createElement('div');
    document.body.appendChild(anchor);

    const res = await showCoachmark({ id: 'seen-one', anchor: () => anchor, body: 'hi' });

    expect(res).toBe('skipped');
    expect(document.querySelector('.gv-coach')).toBeNull();
  });

  it('skips a missing anchor without leaving DOM or marking the guide as seen', async () => {
    const result = await showCoachmark({
      id: 'missing-anchor',
      anchor: () => null,
      body: 'intro',
    });

    expect(result).toBe('skipped');
    expect(document.querySelector('.gv-coach')).toBeNull();
    expect(document.querySelector('.gv-coach-scrim')).toBeNull();
    expect(await hasSeenCoachmark('missing-anchor')).toBe(false);
  });

  it('an aborted signal closes the guide as skipped WITHOUT marking it seen', async () => {
    const anchor = document.createElement('div');
    document.body.appendChild(anchor);
    const controller = new AbortController();

    const pending = showCoachmark({
      id: 'abortable',
      anchor: () => anchor,
      body: 'intro',
      signal: controller.signal,
    });
    await flush();
    expect(document.querySelector('.gv-coach')).not.toBeNull();

    controller.abort();
    const result = await pending;

    expect(result).toBe('skipped');
    expect(await hasSeenCoachmark('abortable')).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(document.querySelector('.gv-coach')).toBeNull();
  });

  it('an already-aborted signal skips before any DOM is created', async () => {
    const anchor = document.createElement('div');
    document.body.appendChild(anchor);
    const controller = new AbortController();
    controller.abort();

    const result = await showCoachmark({
      id: 'pre-aborted',
      anchor: () => anchor,
      body: 'intro',
      signal: controller.signal,
    });

    expect(result).toBe('skipped');
    expect(document.querySelector('.gv-coach')).toBeNull();
    expect(await hasSeenCoachmark('pre-aborted')).toBe(false);
  });

  it('keeps the guide open while switching and confirms the selected state with Done', async () => {
    const anchor = document.createElement('div');
    document.body.appendChild(anchor);
    const onChange = vi.fn();

    const p = showCoachmark({
      id: 'enable-me',
      anchor: () => anchor,
      body: 'intro',
      toggle: { label: 'on', initial: false, onChange },
      dismissLabel: 'Done',
    });
    await flush();
    await flush();

    const sw = document.querySelector('.gv-coach-switch') as HTMLElement;
    expect(sw).toBeTruthy();
    expect(sw.getAttribute('aria-checked')).toBe('false');
    sw.click();
    expect(onChange).toHaveBeenCalledWith(true);
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('.gv-coach')).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 1050));
    expect(document.querySelector('.gv-coach')).toBeTruthy();

    (document.querySelector('.gv-coach-dismiss') as HTMLElement).click();

    const res = await p;
    expect(res).toBe('enabled');
    expect(await hasSeenCoachmark('enable-me')).toBe(true);
    expect(document.querySelector('.gv-coach')).toBeNull(); // torn down
  });

  it('shows sequence progress and uses Next before the final step', async () => {
    const anchor = document.createElement('div');
    document.body.appendChild(anchor);

    const pending = showCoachmark({
      id: 'sequence-step',
      anchor: () => anchor,
      body: 'intro',
      progress: { current: 1, total: 3 },
      nextLabel: 'Next',
      dismissLabel: 'Done',
    });
    await flush();
    await flush();

    expect(document.querySelector('.gv-coach-progress')?.textContent).toBe('1/3');
    const action = document.querySelector<HTMLButtonElement>('.gv-coach-dismiss');
    expect(action?.textContent).toBe('Next');
    action?.click();

    expect(await pending).toBe('confirmed');
  });

  it('blocks page clicks while keeping the guide visible', async () => {
    const anchor = document.createElement('div');
    const pageButton = document.createElement('button');
    const onPageClick = vi.fn();
    pageButton.addEventListener('click', onPageClick);
    document.body.append(anchor, pageButton);

    const p = showCoachmark({ id: 'page-stays-live', anchor: () => anchor, body: 'intro' });
    await flush();
    await flush();

    pageButton.click();

    expect(onPageClick).not.toHaveBeenCalled();
    expect(document.querySelector('.gv-coach')).toBeTruthy();
    expect(await hasSeenCoachmark('page-stays-live')).toBe(false);

    (document.querySelector('.gv-coach-close') as HTMLElement).click();
    expect(await p).toBe('dismissed');
  });

  it('resolves "dismissed" when the close button is clicked, and marks seen', async () => {
    const anchor = document.createElement('div');
    document.body.appendChild(anchor);

    const p = showCoachmark({
      id: 'dismiss-me',
      anchor: () => anchor,
      body: 'intro',
      dismissLabel: 'Done',
    });
    await flush();

    (document.querySelector('.gv-coach-close') as HTMLElement).click();

    const res = await p;
    expect(res).toBe('dismissed');
    expect(await hasSeenCoachmark('dismiss-me')).toBe(true);
  });

  it('reveals a preview element and unmounts it on close', async () => {
    const p = showCoachmark({
      id: 'with-preview',
      anchor: () => null, // fall back to the revealed element as the anchor
      reveal: {
        mount: () => {
          const el = document.createElement('div');
          el.className = 'prev';
          document.body.appendChild(el);
          return el;
        },
        unmount: (el) => el?.remove(),
      },
      body: 'intro',
    });
    await flush();
    expect(document.querySelector('.prev')).toBeTruthy();
    expect(document.querySelector('.gv-coach')).toBeTruthy();

    (document.querySelector('.gv-coach-close') as HTMLElement).click();
    await p;
    expect(document.querySelector('.prev')).toBeNull();
  });

  it('keeps the guide open while the user operates an interactive reveal', async () => {
    const onSelect = vi.fn();
    const pending = showCoachmark({
      id: 'interactive-preview',
      anchor: () => null,
      reveal: {
        interactive: true,
        mount: () => {
          const row = document.createElement('div');
          row.className = 'interactive-row';
          const option = document.createElement('button');
          option.className = 'interactive-option';
          option.addEventListener('click', onSelect);
          row.appendChild(option);
          document.body.appendChild(row);
          return row;
        },
        unmount: (element) => element?.remove(),
      },
      body: 'Choose freely',
      dismissLabel: 'Done',
    });
    await flush();
    await flush();

    const row = document.querySelector('.interactive-row');
    expect(row?.classList.contains('gv-coach-reveal-interactive')).toBe(true);
    (document.querySelector('.interactive-option') as HTMLElement).click();

    expect(onSelect).toHaveBeenCalledOnce();
    expect(document.querySelector('.gv-coach')).toBeTruthy();

    (document.querySelector('.gv-coach-dismiss') as HTMLElement).click();
    expect(await pending).toBe('confirmed');
  });

  it('rolls back partial reveal setup when mount throws', async () => {
    const cleanup = vi.fn((el: HTMLElement | null) => {
      expect(el).toBeNull();
      document.querySelector('.partial-preview')?.remove();
    });

    const result = await showCoachmark({
      id: 'partial-preview',
      anchor: () => null,
      reveal: {
        mount: () => {
          const partial = document.createElement('div');
          partial.className = 'partial-preview';
          document.body.appendChild(partial);
          throw new Error('preview failed after setup');
        },
        unmount: cleanup,
      },
      body: 'intro',
    });

    expect(result).toBe('skipped');
    expect(cleanup).toHaveBeenCalledOnce();
    expect(document.querySelector('.partial-preview')).toBeNull();
  });

  it('labels the dialog, focuses its action by default, and restores focus after close', async () => {
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    anchor.focus();

    const pending = showCoachmark({
      id: 'accessible-guide',
      anchor: () => anchor,
      title: 'New feature',
      body: 'Feature explanation',
      dismissLabel: 'Done',
      closeLabel: 'Close guide',
    });
    await flush();
    await flush();

    const dialog = document.querySelector<HTMLElement>('.gv-coach');
    const title = document.querySelector<HTMLElement>('.gv-coach-title');
    const body = document.querySelector<HTMLElement>('.gv-coach-body');
    const done = document.querySelector<HTMLElement>('.gv-coach-dismiss');
    const close = document.querySelector<HTMLButtonElement>('.gv-coach-close');

    expect(dialog?.getAttribute('aria-labelledby')).toBe(title?.id);
    expect(dialog?.getAttribute('aria-describedby')).toBe(body?.id);
    expect(close?.getAttribute('aria-label')).toBe('Close guide');
    expect(document.activeElement).toBe(done);

    close?.click();
    await pending;
    expect(document.activeElement).toBe(anchor);
  });

  it('leaves page focus untouched on open and cleanup when focusOnOpen is false', async () => {
    const composer = document.createElement('textarea');
    const nextFocus = document.createElement('button');
    document.body.append(composer, nextFocus);
    composer.focus();

    const pending = showCoachmark({
      id: 'non-focusing-guide',
      anchor: () => composer,
      body: 'Feature explanation',
      dismissLabel: 'Done',
      focusOnOpen: false,
    });
    await flush();
    await flush();

    expect(document.activeElement).toBe(composer);

    nextFocus.focus();
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );

    expect(await pending).toBe('dismissed');
    expect(document.activeElement).toBe(nextFocus);
  });

  it('does not show twice when once is left default (second call skips)', async () => {
    const anchor = document.createElement('div');
    document.body.appendChild(anchor);

    const p1 = showCoachmark({ id: 'once-only', anchor: () => anchor, body: 'intro' });
    await flush();
    (document.querySelector('.gv-coach-close') as HTMLElement).click();
    await p1;

    const res2 = await showCoachmark({ id: 'once-only', anchor: () => anchor, body: 'intro' });
    expect(res2).toBe('skipped');
  });
});
