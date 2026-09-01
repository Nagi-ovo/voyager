type Fingerprint = {
  signature: string;
  count: number;
};

function hashString(input: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function normalizeText(text: string | null): string {
  try {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return '';
  }
}

function filterTopLevel(elements: Element[], selector: string): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const el of elements) {
    const parent = el.parentElement;
    if (parent && parent.closest(selector)) continue;
    out.push(el as HTMLElement);
  }
  return out;
}

export function computeConversationFingerprint(
  root: ParentNode,
  selectors: string[],
  maxSamples: number,
): Fingerprint {
  const selector = selectors.join(',');
  if (!selector) return { signature: '', count: 0 };
  const nodes = Array.from(root.querySelectorAll(selector));
  const topLevel = filterTopLevel(nodes, selector);
  const texts: string[] = [];
  for (let i = 0; i < topLevel.length && texts.length < maxSamples; i++) {
    const t = normalizeText(topLevel[i]?.textContent ?? '');
    if (t) texts.push(t);
  }
  const signature = hashString(texts.join('|'));
  return { signature, count: topLevel.length };
}

export type WaitForConversationChangeOptions = {
  timeoutMs: number;
  idleMs: number;
  minWaitMs: number;
  pollIntervalMs: number;
  maxSamples: number;
};

export type WaitForConversationChangeResult = {
  changed: boolean;
  fingerprint: Fingerprint;
};

const DEFAULT_OPTIONS: WaitForConversationChangeOptions = {
  timeoutMs: 20000,
  idleMs: 320,
  minWaitMs: 600,
  pollIntervalMs: 80,
  maxSamples: 10,
};

export async function waitForConversationFingerprintChangeOrTimeout(
  root: ParentNode,
  selectors: string[],
  before: Fingerprint,
  options?: Partial<WaitForConversationChangeOptions>,
): Promise<WaitForConversationChangeResult> {
  const opt: WaitForConversationChangeOptions = { ...DEFAULT_OPTIONS, ...options };
  const selector = selectors.join(',');

  const start = Date.now();
  let lastMutationAt = Date.now();
  let sawMutation = false;
  let lastFingerprint = before;
  let stableSince: number | null = null;

  const observer =
    selector && root instanceof Node
      ? new MutationObserver(() => {
          sawMutation = true;
          lastMutationAt = Date.now();
        })
      : null;

  if (observer) {
    try {
      observer.observe(root, { childList: true, subtree: true, characterData: true });
    } catch {
      // ignore
    }
  }

  const cleanup = () => {
    try {
      observer?.disconnect();
    } catch {
      // ignore
    }
  };

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });

  try {
    while (Date.now() - start < opt.timeoutMs) {
      await sleep(opt.pollIntervalMs);

      const fp = computeConversationFingerprint(root, selectors, opt.maxSamples);
      const changed = fp.signature !== before.signature || fp.count !== before.count;

      if (fp.signature !== lastFingerprint.signature || fp.count !== lastFingerprint.count) {
        lastFingerprint = fp;
        stableSince = null;
      } else if (stableSince === null) {
        stableSince = Date.now();
      }

      const metMinWait = Date.now() - start >= opt.minWaitMs;
      const stableEnough = stableSince !== null && Date.now() - stableSince >= opt.idleMs;

      // No change vs "before": once the fingerprint stays stable for an idle window, proceed quickly.
      if (!changed) {
        if (metMinWait && stableEnough) {
          cleanup();
          return { changed: false, fingerprint: fp };
        }
        continue;
      }

      const idleEnough = Date.now() - lastMutationAt >= opt.idleMs;
      if ((sawMutation && idleEnough) || stableEnough) {
        cleanup();
        return { changed: true, fingerprint: fp };
      }
    }

    cleanup();
    return {
      changed: false,
      fingerprint: computeConversationFingerprint(root, selectors, opt.maxSamples),
    };
  } finally {
    cleanup();
  }
}
