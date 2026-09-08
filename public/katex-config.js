/**
 * KaTeX Configuration Override Script
 * This script runs in the page context (not content script context)
 * to suppress KaTeX strict mode warnings for Unicode text in math mode
 */

(function () {
  'use strict';

  // Monkey patch console.warn to suppress specific KaTeX warnings
  const originalWarn = console.warn;
  console.warn = function (...args) {
    const message = args[0];

    // Suppress KaTeX Unicode warnings
    if (
      typeof message === 'string' &&
      (message.includes('unicodeTextInMathMode') ||
        message.includes('LaTeX-incompatible input and strict mode') ||
        message.includes("KaTeX doesn't work in quirks mode") ||
        message.includes('No ID or name found in config'))
    ) {
      // Silently ignore these warnings
      return;
    }

    // Pass through all other warnings
    return originalWarn.apply(console, args);
  };
})();
