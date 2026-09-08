(function () {
  'use strict';
  if (window.__gvPreventAutoScrollInstalled) return;
  window.__gvPreventAutoScrollInstalled = true;

  const BRIDGE_ID = 'gv-prevent-auto-scroll-bridge';
  const CHAT_SCROLL_SELECTOR = [
    '#chat-history',
    'infinite-scroller.chat-history',
    '.chat-history-scroll-container',
    'chat-window',
    'chat-window-content',
    '.conversation-container',
  ].join(', ');
  const SIDEBAR_SELECTOR = [
    'bard-sidenav',
    'side-navigation-content',
    '[data-test-id="overflow-container"]',
    '[data-test-id="all-conversations"]',
    'expandable-section[data-test-id="chats-expandable-section"]',
    '[data-test-id="conversation"]',
    '.gv-folder-container',
    '.gv-gems-inline-list',
  ].join(', ');
  // Let Gemini restore the latest turn after load / conversation switches (#741).
  const INITIAL_NATIVE_SCROLL_ALLOW_MS = 8000;
  const ROUTE_NATIVE_SCROLL_ALLOW_MS = 4000;
  // Ignore route-driven re-allow briefly after submit so Enter-while-reading stays blocked.
  const SUBMIT_ROUTE_GRACE_MS = 5000;
  const SEND_BUTTON_TEXT_RE =
    /\b(send|submit|run|update)\b|发送|提交|傳送|送出|送信|전송|enviar|envoyer|senden|отправ|إرسال|运行|執行|実行|실행|更新/i;

  let nativeScrollAllowedUntil = Date.now() + INITIAL_NATIVE_SCROLL_ALLOW_MS;
  let lastSubmitIntentAt = 0;
  let lastUrl = location.href;

  function isEnabled() {
    const bridge = document.getElementById(BRIDGE_ID);
    return bridge && bridge.dataset.enabled === 'true';
  }

  function isCtrlEnterSendEnabled() {
    const bridge = document.getElementById(BRIDGE_ID);
    return bridge && bridge.dataset.ctrlEnterSend === 'true';
  }

  function allowNativeScrollFor(durationMs) {
    const now = Date.now();
    if (now - lastSubmitIntentAt < SUBMIT_ROUTE_GRACE_MS) return;
    nativeScrollAllowedUntil = Math.max(nativeScrollAllowedUntil, now + durationMs);
  }

  function cancelNativeScrollAllow() {
    if (!isEnabled()) return;
    nativeScrollAllowedUntil = 0;
  }

  function markSubmitIntent() {
    if (!isEnabled()) return;
    lastSubmitIntentAt = Date.now();
    // Block immediately: do not wait out a lingering restore-allow window.
    nativeScrollAllowedUntil = 0;
  }

  /**
   * When enabled, block downward chat auto-scroll except during short restore
   * windows after load / route change. Actual blocks still require isScrolledUp.
   */
  function shouldBlockAutoScroll() {
    return isEnabled() && Date.now() >= nativeScrollAllowedUntil;
  }

  function isSidebarElement(el) {
    return el instanceof Element && Boolean(el.closest(SIDEBAR_SELECTOR));
  }

  function isChatScrollElement(el) {
    if (el === window) return true;
    if (!(el instanceof Element)) return false;
    if (isSidebarElement(el)) return false;
    return Boolean(el.matches(CHAT_SCROLL_SELECTOR) || el.closest(CHAT_SCROLL_SELECTOR));
  }

  function handlePossibleRouteChange() {
    setTimeout(() => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      allowNativeScrollFor(ROUTE_NATIVE_SCROLL_ALLOW_MS);
    }, 0);
  }

  function wrapHistoryMethod(name) {
    const original = history[name];
    if (typeof original !== 'function') return;
    history[name] = function (...args) {
      const result = original.apply(this, args);
      handlePossibleRouteChange();
      return result;
    };
  }

  function isEditableTarget(target) {
    if (!(target instanceof Element)) return false;
    const editable = target.closest('textarea, input, [contenteditable], [role="textbox"]');
    if (!editable) return false;
    const contentEditable = editable.getAttribute('contenteditable');
    return !contentEditable || contentEditable.toLowerCase() !== 'false';
  }

  function closestButton(target) {
    if (!(target instanceof Element)) return null;
    return target.closest('button, [role="button"]');
  }

  function isLikelySendButton(button) {
    if (!button) return false;
    const text = [
      button.getAttribute('aria-label'),
      button.getAttribute('title'),
      button.getAttribute('data-tooltip'),
      button.getAttribute('data-test-id'),
      button.textContent,
    ]
      .filter(Boolean)
      .join(' ');

    if (SEND_BUTTON_TEXT_RE.test(text)) return true;

    const icon = button.querySelector(
      'mat-icon[fonticon], .material-icons, .material-symbols-rounded',
    );
    const iconName = icon?.getAttribute('fonticon') || icon?.textContent?.trim();
    return iconName === 'send' || iconName === 'play_arrow';
  }

  function handleUserScrollIntent(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (isSidebarElement(target)) return;
    // Wheel/touch over nested message text still counts as chat reading intent.
    if (
      !target.closest(CHAT_SCROLL_SELECTOR) &&
      target !== document.documentElement &&
      target !== document.body
    ) {
      return;
    }
    cancelNativeScrollAllow();
  }

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.isComposing) return;
      if (isCtrlEnterSendEnabled() && !event.ctrlKey && !event.metaKey) return;
      if (isEditableTarget(event.target)) markSubmitIntent();
    },
    true,
  );

  document.addEventListener(
    'click',
    (event) => {
      const button = closestButton(event.target);
      if (isLikelySendButton(button)) markSubmitIntent();
    },
    true,
  );

  // User reading earlier turns: cancel any restore-allow window so delayed
  // Gemini scroll-to-bottom cannot yank them after the conversation settles.
  document.addEventListener('wheel', handleUserScrollIntent, { capture: true, passive: true });
  document.addEventListener('touchmove', handleUserScrollIntent, { capture: true, passive: true });

  wrapHistoryMethod('pushState');
  wrapHistoryMethod('replaceState');
  window.addEventListener('popstate', handlePossibleRouteChange, true);
  window.addEventListener('hashchange', handlePossibleRouteChange, true);
  window.addEventListener(
    'pageshow',
    () => allowNativeScrollFor(INITIAL_NATIVE_SCROLL_ALLOW_MS),
    true,
  );

  function getScrollTop(el) {
    if (el === window) return document.documentElement.scrollTop || document.body.scrollTop;
    return el.scrollTop;
  }

  function getScrollHeight(el) {
    if (el === window) return document.documentElement.scrollHeight || document.body.scrollHeight;
    return el.scrollHeight;
  }

  function getClientHeight(el) {
    if (el === window) return document.documentElement.clientHeight || window.innerHeight;
    return el.clientHeight;
  }

  function isScrolledUp(el) {
    const st = getScrollTop(el);
    const sh = getScrollHeight(el);
    const ch = getClientHeight(el);
    // If not scrollable or very small
    if (sh <= ch + 10) return false;
    return sh - st - ch > 150;
  }

  function isScrollingDownTo(el, args) {
    if (args.length === 0) return false;
    let targetY = undefined;
    if (args.length === 1 && args[0] && typeof args[0] === 'object') {
      if ('top' in args[0]) targetY = args[0].top;
    } else if (args.length >= 2) {
      targetY = args[1];
    }

    if (targetY === undefined) return false;
    const currentScrollTop = getScrollTop(el);
    return targetY > currentScrollTop;
  }

  function isScrollingDownBy(args) {
    if (args.length === 0) return false;
    if (args.length === 1 && args[0] && typeof args[0] === 'object') {
      return args[0].top > 0;
    } else if (args.length >= 2) {
      return args[1] > 0;
    }
    return false;
  }

  function shouldBlockScrollTo(el, args) {
    if (!shouldBlockAutoScroll()) return false;
    if (!isChatScrollElement(el)) return false;
    if (isScrolledUp(el) && isScrollingDownTo(el, args)) {
      return true;
    }
    return false;
  }

  function shouldBlockScrollBy(el, args) {
    if (!shouldBlockAutoScroll()) return false;
    if (!isChatScrollElement(el)) return false;
    if (isScrolledUp(el) && isScrollingDownBy(args)) {
      return true;
    }
    return false;
  }

  const originalWindowScrollTo = window.scrollTo;
  window.scrollTo = function (...args) {
    if (shouldBlockScrollTo(window, args)) return;
    return originalWindowScrollTo.apply(this, args);
  };

  const originalWindowScrollBy = window.scrollBy;
  window.scrollBy = function (...args) {
    if (shouldBlockScrollBy(window, args)) return;
    return originalWindowScrollBy.apply(this, args);
  };

  function collectVerticalScrollPositions(target) {
    const positions = [];
    let ancestor = target.parentElement;
    while (ancestor) {
      if (isSidebarElement(ancestor)) break;
      if (isChatScrollElement(ancestor) && ancestor.scrollHeight > ancestor.clientHeight) {
        positions.push({ el: ancestor, top: getScrollTop(ancestor) });
      }
      ancestor = ancestor.parentElement;
    }
    positions.push({ el: window, top: getScrollTop(window) });
    return positions;
  }

  function restoreVerticalScrollPositions(positions) {
    for (const { el, top } of positions) {
      if (el === window) {
        originalWindowScrollTo.call(window, window.scrollX, top);
      } else {
        el.scrollTop = top;
      }
    }
  }

  const originalElementScrollTo = Element.prototype.scrollTo;
  Element.prototype.scrollTo = function (...args) {
    if (shouldBlockScrollTo(this, args)) return;
    return originalElementScrollTo.apply(this, args);
  };

  const originalElementScrollBy = Element.prototype.scrollBy;
  Element.prototype.scrollBy = function (...args) {
    if (shouldBlockScrollBy(this, args)) return;
    return originalElementScrollBy.apply(this, args);
  };

  const originalScrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (...args) {
    if (shouldBlockAutoScroll() && isChatScrollElement(this)) {
      let ancestor = this.parentElement;
      let blocked = false;
      while (ancestor) {
        if (isSidebarElement(ancestor)) break;
        if (ancestor.scrollHeight > ancestor.clientHeight) {
          if (!isChatScrollElement(ancestor)) {
            if (ancestor === document.body || ancestor === document.documentElement) {
              ancestor = null;
            }
            break;
          }
          if (isScrolledUp(ancestor)) {
            const rect = this.getBoundingClientRect();
            if (rect.top > (window.innerHeight || document.documentElement.clientHeight)) {
              blocked = true;
            } else if (rect.bottom > ancestor.getBoundingClientRect().bottom) {
              blocked = true;
            }
            break;
          }
        }
        ancestor = ancestor.parentElement;
      }
      if (!ancestor && isScrolledUp(window)) {
        const rect = this.getBoundingClientRect();
        if (rect.top > (window.innerHeight || document.documentElement.clientHeight)) {
          blocked = true;
        }
      }

      if (blocked) {
        const positions = collectVerticalScrollPositions(this);
        try {
          return originalScrollIntoView.apply(this, args);
        } finally {
          restoreVerticalScrollPositions(positions);
        }
      }
    }
    return originalScrollIntoView.apply(this, args);
  };

  const originalScrollTopDescriptor = Object.getOwnPropertyDescriptor(
    Element.prototype,
    'scrollTop',
  );
  if (
    originalScrollTopDescriptor?.configurable &&
    typeof originalScrollTopDescriptor.get === 'function' &&
    typeof originalScrollTopDescriptor.set === 'function'
  ) {
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: originalScrollTopDescriptor.configurable,
      enumerable: originalScrollTopDescriptor.enumerable,
      get: originalScrollTopDescriptor.get,
      set: function (value) {
        if (shouldBlockAutoScroll() && isChatScrollElement(this) && isScrolledUp(this)) {
          const currentVal = originalScrollTopDescriptor.get.call(this);
          if (value > currentVal) {
            return;
          }
        }
        return originalScrollTopDescriptor.set.call(this, value);
      },
    });
  }
})();
