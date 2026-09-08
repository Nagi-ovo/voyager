import { useCallback, useEffect, useRef, useState } from 'react';

import browser from 'webextension-polyfill';

import {
  type AccountPlatform,
  detectAccountPlatformFromUrl,
} from '@/core/services/AccountIsolationService';

/** The inspected tab can be supplied by an embedded popup or resolved from the active window. */
export function useActivePopupTab(sourceTabId?: number) {
  const [activeUrl, setActiveUrl] = useState('');
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [activeAccountPlatform, setActiveAccountPlatform] = useState<AccountPlatform>('gemini');
  const [activeTabContextLoaded, setActiveTabContextLoaded] = useState(false);
  const requestVersion = useRef(0);

  const refreshActiveTabContext = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      let tab =
        typeof sourceTabId === 'number'
          ? await browser.tabs.get(sourceTabId).catch(() => null)
          : null;
      tab ??= (await browser.tabs.query({ active: true, currentWindow: true }))[0] ?? null;
      if (version !== requestVersion.current) return;
      const url = tab?.url || '';
      setActiveUrl(url);
      setActiveTabId(typeof tab?.id === 'number' ? tab.id : null);
      setActiveAccountPlatform(detectAccountPlatformFromUrl(url));
    } catch {
      // Keep the previous context when tab inspection fails.
    } finally {
      if (version === requestVersion.current) setActiveTabContextLoaded(true);
    }
  }, [sourceTabId]);

  useEffect(() => {
    void refreshActiveTabContext();
    return () => {
      requestVersion.current += 1;
    };
  }, [refreshActiveTabContext]);

  return {
    activeUrl,
    activeTabId,
    activeAccountPlatform,
    activeTabContextLoaded,
    refreshActiveTabContext,
  };
}
