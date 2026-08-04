/**
 * Watermark Remover - Content Script Integration
 *
 * This module is based on gemini-watermark-remover by journey-ad (Jad),
 * itself based on GeminiWatermarkTool by AllenK (Kwyshell).
 * Original: https://github.com/journey-ad/gemini-watermark-remover/blob/main/src/userscript/index.js
 * License: MIT - Copyright (c) 2025 Jad; Copyright (c) 2024 AllenK (Kwyshell)
 * Full retained notice: see /THIRD_PARTY_NOTICES.md
 *
 * Automatically detects and removes watermarks from Gemini-generated images on the page.
 *
 * The fetch interceptor (running in MAIN world) handles download requests:
 * - Intercepts download requests and modifies URL to get original size
 * - Sends image data to this content script for watermark removal
 * - Returns processed image to complete the download
 */
import { isExtensionContextInvalidatedError } from '@/core/utils/extensionContext';
import { fetchImageViaExtensionRuntime } from '@/core/utils/runtimeImageFetch';
import { WATERMARK_STORAGE_KEYS, resolveWatermarkSettings } from '@/core/utils/watermarkSettings';
import { getTranslationSync } from '@/utils/i18n';
import type { TranslationKey } from '@/utils/translations';

import { DOWNLOAD_ICON_SELECTOR, findNativeDownloadButton } from './downloadButton';
import {
  IMAGE_HEALTH_SAMPLE_SIZE,
  type ImageHealthFingerprint,
  createImageHealthFingerprint,
  detectCorruptedGeminiDownload,
} from './imageHealthDetector';
import { type StatusToastManager, createStatusToastManager } from './statusToast';
import { WatermarkEngine } from './watermarkEngine';

let engine: WatermarkEngine | null = null;
let enginePromise: Promise<WatermarkEngine> | null = null;
const processingQueue = new Set<HTMLImageElement>();
const previewFingerprintsByImage = new WeakMap<
  HTMLImageElement,
  { sourceSrc: string; fingerprint: ImageHealthFingerprint }
>();
const previewFingerprintsByIntent = new Map<string, Promise<ImageHealthFingerprint | null>>();
let lifecycleGeneration = 0;
let downloadRemovalEnabled = false;
let previewRemovalEnabled = false;

// Observers are kept at module scope so they can be disconnected on teardown
// and so re-running startWatermarkRemover() can't stack duplicate observers.
// Two of these watch document.body (subtree + attributes), so leaking them is
// permanent page-wide overhead.
let previewObserver: MutationObserver | null = null;
let indicatorObserver: MutationObserver | null = null;
let bridgeObserver: MutationObserver | null = null;
let statusObserver: MutationObserver | null = null;
const pendingDebounceTimeouts = new Set<ReturnType<typeof setTimeout>>();

/**
 * Debounce function to limit execution frequency
 */
const debounce = <T extends (...args: unknown[]) => void>(func: T, wait: number): T => {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  return ((...args: unknown[]) => {
    if (timeout) {
      clearTimeout(timeout);
      pendingDebounceTimeouts.delete(timeout);
    }
    timeout = setTimeout(() => {
      if (timeout) pendingDebounceTimeouts.delete(timeout);
      timeout = null;
      func(...args);
    }, wait);
    pendingDebounceTimeouts.add(timeout);
  }) as T;
};

/**
 * Fetch image via background script to bypass CORS
 * The background script has host_permissions that allow cross-origin requests
 */
const fetchImageViaBackground = async (url: string): Promise<HTMLImageElement> => {
  const response = await fetchImageViaExtensionRuntime(url);
  if (!response) throw new Error('Failed to fetch image');

  return await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode image'));
    // Set crossOrigin before src to prevent canvas tainting in Firefox.
    img.crossOrigin = 'anonymous';
    img.src = `data:${response.contentType};base64,${response.base64}`;
  });
};

/**
 * Convert canvas to blob
 */
const canvasToBlob = (canvas: HTMLCanvasElement, type = 'image/png'): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Failed to convert canvas to blob'));
    }, type);
  });

/**
 * Convert canvas to base64 data URL
 */
const canvasToDataURL = (canvas: HTMLCanvasElement, type = 'image/png'): string =>
  canvas.toDataURL(type);

/**
 * Check if an image element is a valid Gemini-generated image
 */
const isValidGeminiImage = (img: HTMLImageElement): boolean =>
  img.closest('generated-image,.generated-image-container') !== null;

const captureImageFingerprint = (
  image: CanvasImageSource & { naturalWidth?: number; naturalHeight?: number },
): ImageHealthFingerprint | null => {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = IMAGE_HEALTH_SAMPLE_SIZE;
    canvas.height = IMAGE_HEALTH_SAMPLE_SIZE;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;

    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    return createImageHealthFingerprint(
      imageData.data,
      canvas.width,
      canvas.height,
      image.naturalWidth || canvas.width,
      image.naturalHeight || canvas.height,
    );
  } catch {
    // A tainted cross-origin preview cannot be sampled safely. In that case we
    // skip the warning instead of risking a false positive.
    return null;
  }
};

const findPreviewImageForDownloadButton = (button: HTMLButtonElement): HTMLImageElement | null => {
  const generatedImage = button.closest('generated-image,.generated-image-container');
  const inlineImage = generatedImage?.querySelector<HTMLImageElement>('img');
  if (inlineImage) return inlineImage;

  const dialog = button.closest('expansion-dialog,[role="dialog"],.cdk-overlay-pane');
  return (
    dialog?.querySelector<HTMLImageElement>(
      'generated-image img, img[src^="blob:"], img[src*="googleusercontent.com"]',
    ) ?? null
  );
};

const capturePreviewFingerprint = async (
  button: HTMLButtonElement,
): Promise<ImageHealthFingerprint | null> => {
  const image = findPreviewImageForDownloadButton(button);
  if (!image) return null;
  const cached = previewFingerprintsByImage.get(image);
  const isCurrentSource = cached?.sourceSrc === image.src;
  const isProcessedFromCachedSource =
    image.dataset.watermarkProcessed === 'true' &&
    image.dataset.processedUrl === image.src &&
    cached?.sourceSrc === image.dataset.watermarkOriginalSrc;
  if (cached && (isCurrentSource || isProcessedFromCachedSource)) return cached.fingerprint;

  const fingerprint = captureImageFingerprint(image);
  if (fingerprint) {
    previewFingerprintsByImage.set(image, { sourceSrc: image.src, fingerprint });
    return fingerprint;
  }

  // Gemini preview images normally come from googleusercontent.com without a
  // crossorigin attribute. Drawing those DOM images taints the canvas, so
  // pixel readback above fails even though the image is visibly loaded. Reuse
  // the extension-runtime fetch path to obtain an origin-clean copy while the
  // native download intent remains synchronous.
  const sourceSrc = image.src;
  if (!/^https?:/i.test(sourceSrc)) return null;
  try {
    const cleanImage = await fetchImageViaBackground(sourceSrc);
    const fetchedFingerprint = captureImageFingerprint(cleanImage);
    if (fetchedFingerprint && image.src === sourceSrc) {
      previewFingerprintsByImage.set(image, {
        sourceSrc,
        fingerprint: fetchedFingerprint,
      });
    }
    return fetchedFingerprint;
  } catch (error) {
    console.warn('[Gemini Voyager] Failed to capture preview fingerprint:', error);
    return null;
  }
};

/**
 * Find all Gemini-generated images on the page
 */
const findGeminiImages = (): HTMLImageElement[] =>
  [...document.querySelectorAll<HTMLImageElement>('img[src*="googleusercontent.com"]')].filter(
    (img) => isValidGeminiImage(img) && img.dataset.watermarkProcessed !== 'true',
  );

/**
 * Clear preview bookkeeping without restoring the current image source.
 * Gemini can reuse an existing <img> for a later generated image, so stale
 * processed markers must not prevent the replacement source from being handled
 * after preview removal is re-enabled.
 */
const clearPreviewImageState = (): void => {
  document
    .querySelectorAll<HTMLImageElement>(
      'img[data-watermark-processed], img[data-watermark-original-src]',
    )
    .forEach((img) => {
      delete img.dataset.watermarkProcessed;
      delete img.dataset.watermarkOriginalSrc;
      delete img.dataset.processedUrl;
    });
};

/**
 * Replace image URL size parameter to get full resolution
 */
const replaceWithNormalSize = (src: string): string => {
  // Use normal size image to fit watermark
  return src.replace(/=[swh]\d+(?:-[wh]\d+)*/, '=s0');
};

/**
 * Attach the 🍌 badge to a download button. The badge lives INSIDE the button
 * because Gemini wraps it in `<gem-icon-button>` which has `overflow: hidden`,
 * so any negative offset overhanging the wrapper would be clipped.
 */
function attachIndicatorToButton(nativeButton: HTMLButtonElement): void {
  // Idempotency: don't add a second indicator to the same button.
  if (nativeButton.querySelector('.nanobanana-indicator')) return;

  const indicator = document.createElement('span');
  indicator.className = 'nanobanana-indicator';
  indicator.textContent = '🍌';
  indicator.title =
    chrome.i18n.getMessage('nanobananaDownloadTooltip') ||
    'Image Refinement: Downloads will be processed automatically';

  Object.assign(indicator.style, {
    position: 'absolute',
    top: '2px',
    right: '2px',
    fontSize: '11px',
    lineHeight: '1',
    pointerEvents: 'none', // Let clicks pass through to the native button
    zIndex: '10',
    filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.45))',
  });

  // mdc-icon-button is `position: relative` by default; guard against future
  // Gemini changes that might flip it to static.
  if (getComputedStyle(nativeButton).position === 'static') {
    nativeButton.style.position = 'relative';
  }
  nativeButton.appendChild(indicator);
}

/**
 * Add a visual indicator (🍌) to the native download button via the
 * preview-image path. Looks up the button through the generated-image
 * container; for the lightbox/expansion-dialog path, see
 * decorateDownloadButtons() which walks every `<download-generated-image-button>`
 * host (toolbar AND lightbox).
 */
function addDownloadIndicator(imgElement: HTMLImageElement): void {
  const container = imgElement.closest('generated-image,.generated-image-container');
  if (!container) return;

  const nativeDownloadIcon = container.querySelector(DOWNLOAD_ICON_SELECTOR);
  const nativeButton = nativeDownloadIcon?.closest('button');
  if (!nativeButton) return;

  attachIndicatorToButton(nativeButton as HTMLButtonElement);
}

/**
 * Process a single image to remove watermark (for preview images)
 */
async function processImage(imgElement: HTMLImageElement): Promise<void> {
  if (!engine || processingQueue.has(imgElement)) return;

  const generation = lifecycleGeneration;
  let stale = false;
  const isStale = (): boolean => {
    stale = generation !== lifecycleGeneration || !previewRemovalEnabled;
    return stale;
  };

  processingQueue.add(imgElement);
  imgElement.dataset.watermarkProcessed = 'processing';

  const originalSrc = imgElement.src;
  try {
    const originalPreviewFingerprint = captureImageFingerprint(imgElement);
    if (originalPreviewFingerprint) {
      previewFingerprintsByImage.set(imgElement, {
        sourceSrc: originalSrc,
        fingerprint: originalPreviewFingerprint,
      });
    }

    // Fetch full resolution image via background script (bypasses CORS)
    const normalSizeSrc = replaceWithNormalSize(originalSrc);
    const normalSizeImg = await fetchImageViaBackground(normalSizeSrc);
    if (isStale()) return;

    // Process image to remove watermark
    const processedCanvas = await engine.removeWatermarkFromImage(normalSizeImg);
    if (isStale()) return;
    const processedBlob = await canvasToBlob(processedCanvas);
    if (isStale()) return;

    // Replace image source with processed blob URL
    const processedUrl = URL.createObjectURL(processedBlob);
    imgElement.dataset.watermarkOriginalSrc = originalSrc;
    imgElement.src = processedUrl;
    imgElement.dataset.watermarkProcessed = 'true';
    imgElement.dataset.processedUrl = processedUrl; // Store for reference

    console.log('[Gemini Voyager] Watermark removed from preview image');

    if (downloadRemovalEnabled) {
      addDownloadIndicator(imgElement);
    }
  } catch (error) {
    if (isStale()) return;
    console.warn('[Gemini Voyager] Failed to process image for watermark removal:', error);
    imgElement.dataset.watermarkProcessed = 'failed';
  } finally {
    processingQueue.delete(imgElement);
    if (stale) {
      if (imgElement.dataset.watermarkProcessed === 'processing') {
        delete imgElement.dataset.watermarkProcessed;
      }
      // A full restart can invalidate this task while leaving preview removal
      // enabled (for example, when only the download toggle changed). Retry
      // after releasing the queue slot so the latest lifecycle owns the write.
      if (previewRemovalEnabled && imgElement.isConnected && isValidGeminiImage(imgElement)) {
        void processImage(imgElement);
      }
    }
  }
}

/**
 * Process all Gemini-generated images on the page (preview path)
 */
const processAllImages = (): void => {
  const images = findGeminiImages();
  images.forEach(processImage);

  if (downloadRemovalEnabled) {
    // Re-run the indicator pass so blob-src previews and late-loading native
    // buttons still pick up the 🍌 badge (idempotent).
    decorateDownloadButtons();
  }
};

/**
 * Add the 🍌 indicator to every Gemini-generated image's download button.
 *
 * Walks `<download-generated-image-button>` hosts directly instead of going
 * through the img element. This covers:
 *  1. The in-message toolbar (host lives inside `<generated-image>`)
 *  2. The lightbox / `<expansion-dialog>` rendered into `cdk-overlay-container`
 *     — same custom element, but NOT inside any `generated-image` container.
 *
 * Also independent of the img src (blob: vs googleusercontent.com).
 */
export const decorateDownloadButtons = (): void => {
  const hosts = document.querySelectorAll<HTMLElement>('download-generated-image-button');
  hosts.forEach((host) => {
    const button = host.querySelector<HTMLButtonElement>('button');
    if (button) attachIndicatorToButton(button);
  });
};

/**
 * Setup MutationObserver to watch for new images and run the preview pipeline.
 */
const setupMutationObserver = (): void => {
  if (previewObserver) return;
  const debouncedProcess = debounce(processAllImages, 100);
  previewObserver = new MutationObserver(debouncedProcess);
  previewObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true, // Watch for attribute changes (like native buttons appearing)
    attributeFilter: ['class', 'src'],
  });
  console.log('[Gemini Voyager] Watermark remover MutationObserver active');
};

/**
 * Lighter MutationObserver that skips the canvas pipeline and only decorates
 * download buttons. It also covers the engine-loading window before the full
 * preview observer can take over.
 */
const setupIndicatorObserver = (): void => {
  if (indicatorObserver) return;
  const debouncedDecorate = debounce(decorateDownloadButtons, 100);
  indicatorObserver = new MutationObserver(debouncedDecorate);
  indicatorObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'src'],
  });
  console.log('[Gemini Voyager] Watermark download-indicator observer active');
};
/**
 * DOM-based communication bridge ID (must match fetchInterceptor.js)
 * CustomEvents don't cross world boundaries in Firefox, so we use a hidden DOM element
 */
const GV_BRIDGE_ID = 'gv-watermark-bridge';

function getBridgeElement(): HTMLElement {
  let bridge = document.getElementById(GV_BRIDGE_ID);
  if (!bridge) {
    bridge = document.createElement('div');
    bridge.id = GV_BRIDGE_ID;
    bridge.style.display = 'none';
    document.documentElement.appendChild(bridge);
  }
  return bridge;
}

/**
 * Notify the MAIN world fetch interceptor about watermark remover state
 * Uses DOM element to communicate across worlds (works in Firefox)
 */
function notifyFetchInterceptor(enabled: boolean): void {
  const bridge = getBridgeElement();
  bridge.dataset.enabled = String(enabled);
}

/**
 * Setup DOM-based bridge to handle image processing requests from MAIN world
 * Uses MutationObserver to watch for requests in the bridge element
 */
function setupFetchInterceptorBridge(): void {
  if (bridgeObserver) return;
  const bridge = getBridgeElement();

  // Watch for requests from MAIN world via MutationObserver
  bridgeObserver = new MutationObserver(async () => {
    const requestData = bridge.dataset.request;
    if (requestData) {
      bridge.removeAttribute('data-request');
      try {
        const { requestId, base64, mode, intentToken } = JSON.parse(requestData);
        if (mode === 'inspect') {
          await inspectImageRequest(intentToken, base64, bridge);
        } else {
          await processImageRequest(requestId, base64, bridge, intentToken);
        }
      } catch (e) {
        console.error('[Gemini Voyager] Failed to parse request:', e);
      }
    }
  });

  bridgeObserver.observe(bridge, { attributes: true, attributeFilter: ['data-request'] });
  console.log('[Gemini Voyager] Fetch interceptor bridge ready');
}

const loadBridgeImage = async (base64: string): Promise<HTMLImageElement> => {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Failed to load image'));
    img.crossOrigin = 'anonymous';
    img.src = base64;
  });
  return img;
};

async function inspectImageRequest(
  intentToken: string | undefined,
  base64: string,
  bridge: HTMLElement,
): Promise<void> {
  if (!intentToken) return;
  const previewFingerprintPromise = previewFingerprintsByIntent.get(intentToken);
  previewFingerprintsByIntent.delete(intentToken);
  if (!previewFingerprintPromise) return;

  try {
    const previewFingerprint = await previewFingerprintPromise;
    if (!previewFingerprint) return;
    const image = await loadBridgeImage(base64);
    const downloadFingerprint = captureImageFingerprint(image);
    if (!downloadFingerprint) return;

    const result = detectCorruptedGeminiDownload(previewFingerprint, downloadFingerprint);
    if (result.corrupted) {
      bridge.dataset.status = JSON.stringify({
        type: 'GOOGLE_IMAGE_CORRUPTED',
        timestamp: Date.now(),
        intentToken,
        reason: result.reason,
      });
    }
  } catch (error) {
    console.warn('[Gemini Voyager] Failed to inspect downloaded image:', error);
  }
}

/**
 * Process an image request from the fetch interceptor
 */
async function processImageRequest(
  requestId: string,
  base64: string,
  bridge: HTMLElement,
  intentToken?: string,
): Promise<void> {
  // Engine init is async (loads two PNG assets). The bridge observer is
  // installed BEFORE the await on engine creation, so requests can land here
  // before the engine is ready — queue on enginePromise instead of failing
  // fast (otherwise users who click download right after the content script
  // re-injects, e.g. after a /u/0/ → /u/1/ account switch, see the toast
  // stuck for ~30s while the MAIN-world interceptor times out).
  if (!engine && enginePromise) {
    try {
      await enginePromise;
    } catch {
      // engine init failed — fall through to the "not initialized" path
    }
  }
  if (!engine) {
    bridge.dataset.response = JSON.stringify({
      requestId,
      error: 'Watermark engine not initialized',
    });
    return;
  }

  try {
    const img = await loadBridgeImage(base64);
    const previewFingerprintPromise = intentToken
      ? previewFingerprintsByIntent.get(intentToken)
      : undefined;
    if (intentToken) previewFingerprintsByIntent.delete(intentToken);
    const previewFingerprint = previewFingerprintPromise ? await previewFingerprintPromise : null;
    const downloadFingerprint = previewFingerprint ? captureImageFingerprint(img) : null;
    const healthResult =
      previewFingerprint && downloadFingerprint
        ? detectCorruptedGeminiDownload(previewFingerprint, downloadFingerprint)
        : null;

    // Process image to remove watermark
    const processedCanvas = await engine.removeWatermarkFromImage(img);
    const processedDataUrl = canvasToDataURL(processedCanvas);

    // Send response via bridge element
    bridge.dataset.response = JSON.stringify({
      requestId,
      base64: processedDataUrl,
      corrupted: healthResult?.corrupted === true,
    });
  } catch (error) {
    console.error('[Gemini Voyager] Failed to process image:', error);
    bridge.dataset.response = JSON.stringify({ requestId, error: String(error) });
  }
}

/**
 * Read the latest settings and configure the watermark runtime.
 * Reconfiguration tears down preview work every time, but keeps an unchanged
 * download runtime alive so an in-flight native download cannot lose its
 * bridge request, intent, or feedback sequence.
 */
async function configureWatermarkRemover(reconfigure: boolean): Promise<void> {
  const generation = ++lifecycleGeneration;

  try {
    // Initialize bridge element first (so it exists when fetch interceptor loads)
    getBridgeElement();

    // Resolve the two split flags (with legacy fallback)
    const result = await chrome.storage?.sync?.get([...WATERMARK_STORAGE_KEYS]);
    const { download: downloadEnabled, preview: previewEnabled } = resolveWatermarkSettings(
      result ?? null,
    );
    if (generation !== lifecycleGeneration) return;

    if (reconfigure) {
      teardownWatermarkRemover(downloadRemovalEnabled && downloadEnabled);
    }

    downloadRemovalEnabled = downloadEnabled;
    previewRemovalEnabled = previewEnabled;
    notifyFetchInterceptor(downloadEnabled);

    // Download health inspection is independent of watermark removal. Keep
    // the click intent, bridge, and warning listener alive even when both
    // removal modes are off; Gemini's native response stays untouched.
    setupStatusListener();
    setupDownloadButtonTracking();
    setupFetchInterceptorBridge();

    if (!downloadEnabled && !previewEnabled) {
      console.log('[Gemini Voyager] Watermark remover is disabled');
      return;
    }

    console.log(
      `[Gemini Voyager] Initializing watermark remover (download=${downloadEnabled}, preview=${previewEnabled})`,
    );

    if (downloadEnabled) {
      // The indicator is only a readiness cue; downloads already queue through
      // the bridge while the engine assets load. Show it immediately and watch
      // for buttons Gemini mounts during that loading window.
      decorateDownloadButtons();
      setupIndicatorObserver();
    }

    if (!enginePromise) {
      enginePromise = WatermarkEngine.create();
    }
    const initializedEngine = engine ?? (await enginePromise);
    if (generation !== lifecycleGeneration) return;
    engine = initializedEngine;

    if (previewEnabled) {
      // The preview observer also decorates late-loading download buttons, so
      // retire the temporary indicator-only observer before switching modes.
      indicatorObserver?.disconnect();
      indicatorObserver = null;

      // Heavy path: replace each image's src with a watermark-stripped blob.
      // The 🍌 indicator is attached as part of processImage().
      processAllImages();
      setupMutationObserver();
    }

    console.log('[Gemini Voyager] Watermark remover ready');
  } catch (error) {
    if (!engine) enginePromise = null;
    if (generation !== lifecycleGeneration) return;
    if (isExtensionContextInvalidatedError(error)) {
      return;
    }
    console.error('[Gemini Voyager] Watermark remover initialization failed:', error);
  }
}

/**
 * Start the watermark remover.
 */
export function startWatermarkRemover(): Promise<void> {
  return configureWatermarkRemover(false);
}

/**
 * Re-read storage and apply the latest watermark mode to the current page.
 * The shared generation guard makes rapid restarts
 * latest-wins even while the engine is still loading.
 */
export async function restartWatermarkRemover(): Promise<void> {
  await configureWatermarkRemover(true);
}

/**
 * Tear down preview work and, unless it is unchanged and still enabled, the
 * download runtime. Keeping download state is what makes preview-only toggles
 * safe while a native download is already in progress.
 */
function teardownWatermarkRemover(preserveDownloadRuntime: boolean): void {
  const keepDownloadRuntime = preserveDownloadRuntime && downloadRemovalEnabled;
  previewRemovalEnabled = false;

  for (const observer of [previewObserver, indicatorObserver]) {
    observer?.disconnect();
  }
  previewObserver = null;
  indicatorObserver = null;
  for (const timeout of pendingDebounceTimeouts) clearTimeout(timeout);
  pendingDebounceTimeouts.clear();
  clearPreviewImageState();

  if (keepDownloadRuntime) return;

  downloadRemovalEnabled = false;
  bridgeObserver?.disconnect();
  statusObserver?.disconnect();
  bridgeObserver = null;
  statusObserver = null;
  clearActiveDownloadSequence();

  // Tell the MAIN-world fetch interceptor watermark mutation is off. It may
  // still clone a user-initiated native download for the read-only health check.
  // Only if the bridge already exists — don't create one just to disable it
  // (stop runs on every page's beforeunload, including where it never started).
  const existingBridge = document.getElementById(GV_BRIDGE_ID);
  if (existingBridge) {
    existingBridge.dataset.enabled = 'false';
    existingBridge.removeAttribute('data-download-intent-expires-at');
    existingBridge.removeAttribute('data-download-intent-token');
  }

  document
    .querySelectorAll<HTMLElement>('.nanobanana-indicator')
    .forEach((indicator) => indicator.remove());

  // Remove the global download-button tracking listeners.
  if (downloadCaptureHandler) {
    document.removeEventListener('pointerdown', downloadCaptureHandler, true);
    document.removeEventListener('click', downloadCaptureHandler, true);
    downloadCaptureHandler = null;
  }
  downloadTrackingReady = false;
}

/**
 * Fully tear down the watermark remover. Safe to call when nothing was started.
 * Wired into the content-script beforeunload teardown so document observers,
 * the MAIN-world bridge, and global listeners cannot outlive the page.
 */
export function stopWatermarkRemover(): void {
  lifecycleGeneration += 1;
  teardownWatermarkRemover(false);
}

let statusToastManager: StatusToastManager | null = null;
let downloadTrackingReady = false;
let downloadCaptureHandler: ((event: Event) => void) | null = null;
let lastImmediateToastAt = 0;
let sequenceCounter = 0;

const LARGE_WARNING_AUTO_DISMISS_MS = 8000;
const PROCESSING_FALLBACK_AUTO_DISMISS_MS = 35000;
// Gemini can spend more than 10s walking the download chain on slow networks
// before the final rd-gg/rd-gg-dl image request appears.
const DOWNLOAD_INTENT_TTL_MS = 60000;

type DownloadToastSequence = {
  id: number;
  token: string;
  downloadToastId: string | null;
  warningToastId: string | null;
  processingToastId: string | null;
  processingTimer: ReturnType<typeof setTimeout> | null;
};

let activeSequence: DownloadToastSequence | null = null;

function clearActiveDownloadSequence(): void {
  if (!activeSequence) return;

  previewFingerprintsByIntent.delete(activeSequence.token);

  if (activeSequence.processingTimer) {
    clearTimeout(activeSequence.processingTimer);
  }

  if (statusToastManager) {
    for (const toastId of [
      activeSequence.downloadToastId,
      activeSequence.warningToastId,
      activeSequence.processingToastId,
    ]) {
      if (toastId) statusToastManager.removeToast(toastId);
    }
  }

  activeSequence = null;
}

const getStatusToastManager = (): StatusToastManager => {
  if (!statusToastManager) {
    statusToastManager = createStatusToastManager({ maxToasts: 4, anchorTtlMs: 30000 });
  }
  return statusToastManager;
};

const t = (key: TranslationKey, fallback: string): string => {
  const value = getTranslationSync(key);
  return value === key ? fallback : value;
};

function markDownloadIntent(token: string): void {
  const bridge = getBridgeElement();
  bridge.dataset.downloadIntentExpiresAt = String(Date.now() + DOWNLOAD_INTENT_TTL_MS);
  bridge.dataset.downloadIntentToken = token;
}

function beginDownloadSequence(button: HTMLButtonElement): void {
  const now = Date.now();
  if (now - lastImmediateToastAt < 300 && activeSequence) {
    markDownloadIntent(activeSequence.token);
    return;
  }
  lastImmediateToastAt = now;

  if (activeSequence?.processingTimer) {
    clearTimeout(activeSequence.processingTimer);
  }
  if (activeSequence) previewFingerprintsByIntent.delete(activeSequence.token);

  const sequenceId = ++sequenceCounter;
  const token = `gv_download_${now}_${sequenceId}`;
  previewFingerprintsByIntent.set(token, capturePreviewFingerprint(button));
  markDownloadIntent(token);
  const manager = getStatusToastManager();
  manager.setAnchorElement(button);
  let downloadToastId: string | null = null;
  let processingTimer: ReturnType<typeof setTimeout> | null = null;

  if (downloadRemovalEnabled) {
    const downloadMessage = t('downloadingOriginal', '正在下载原始图片');
    const processingMessage = t('downloadProcessing', '正在处理水印中');
    downloadToastId = manager.addToast(downloadMessage, 'info', {
      pending: true,
      autoDismissMs: 3000,
    });

    processingTimer = setTimeout(() => {
      if (!activeSequence || activeSequence.id !== sequenceId) return;
      if (activeSequence.downloadToastId) {
        manager.removeToast(activeSequence.downloadToastId);
        activeSequence.downloadToastId = null;
      }
      if (!activeSequence.processingToastId) {
        activeSequence.processingToastId = manager.addToast(processingMessage, 'info', {
          pending: true,
          autoDismissMs: PROCESSING_FALLBACK_AUTO_DISMISS_MS,
        });
      }
    }, 3000);
  }

  activeSequence = {
    id: sequenceId,
    token,
    downloadToastId,
    warningToastId: null,
    processingToastId: null,
    processingTimer,
  };
}

function setupDownloadButtonTracking(): void {
  if (downloadTrackingReady) return;
  downloadTrackingReady = true;

  downloadCaptureHandler = (event: Event): void => {
    const button = findNativeDownloadButton(event.target);
    if (!button) return;

    beginDownloadSequence(button);
  };

  document.addEventListener('pointerdown', downloadCaptureHandler, true);
  document.addEventListener('click', downloadCaptureHandler, true);
}

/**
 * Setup listener for status events from fetchInterceptor
 */
function setupStatusListener(): void {
  if (statusObserver) return;
  const bridge = getBridgeElement();
  const manager = getStatusToastManager();
  const downloadMessage = t('downloadingOriginal', '正在下载原始图片');
  const downloadLargeMessage = t('downloadingOriginalLarge', '正在下载原始图片（大文件）');
  const warningMessage = t('downloadLargeWarning', '大文件警告');
  const processingMessage = t('downloadProcessing', '正在处理水印中');
  const successMessage = t('downloadSuccess', '正在下载');
  const errorPrefix = t('downloadError', '失败');
  const corruptedMessage = t(
    'googleImageCorrupted',
    'Google 返回的原图已损坏（并非 Voyager 导致）；下载结果可能模糊或内容缺失',
  );

  const finalizeSequence = (level: 'success' | 'warning' | 'error', message: string): void => {
    const autoDismissMs = level === 'success' ? 2500 : level === 'warning' ? 10000 : 4000;
    if (activeSequence?.processingTimer) {
      clearTimeout(activeSequence.processingTimer);
      activeSequence.processingTimer = null;
    }
    if (activeSequence?.warningToastId) {
      manager.removeToast(activeSequence.warningToastId);
      activeSequence.warningToastId = null;
    }
    if (activeSequence?.downloadToastId) {
      manager.removeToast(activeSequence.downloadToastId);
      activeSequence.downloadToastId = null;
    }

    if (
      activeSequence?.processingToastId &&
      manager.updateToast(activeSequence.processingToastId, message, level, {
        autoDismissMs,
        markFinal: true,
      })
    ) {
      return;
    }

    if (
      !manager.updateLatestPending(message, level, {
        autoDismissMs,
        markFinal: true,
      })
    ) {
      manager.addToast(message, level, {
        autoDismissMs,
      });
    }
  };

  const handleStatus = (statusData: string): void => {
    console.log('[Gemini Voyager] Status data received:', statusData);
    if (!statusData) return;

    try {
      const { type, message, intentToken } = JSON.parse(statusData);
      bridge.removeAttribute('data-status');
      if (!activeSequence || intentToken !== activeSequence.token) return;

      switch (type) {
        case 'DOWNLOADING':
          // Step 1: Downloading original image
          if (activeSequence) {
            if (activeSequence.warningToastId) {
              manager.removeToast(activeSequence.warningToastId);
              activeSequence.warningToastId = null;
            }
            if (!activeSequence.downloadToastId) {
              activeSequence.downloadToastId = manager.addToast(downloadMessage, 'info', {
                pending: true,
                autoDismissMs: 3000,
              });
            }
          }
          break;
        case 'DOWNLOADING_LARGE':
          // Step 1 with large file warning
          if (activeSequence) {
            if (!activeSequence.downloadToastId) {
              activeSequence.downloadToastId = manager.addToast(downloadLargeMessage, 'info', {
                pending: true,
                autoDismissMs: 3000,
              });
            } else {
              manager.updateToast(activeSequence.downloadToastId, downloadLargeMessage, 'info');
            }
            if (!activeSequence.warningToastId) {
              activeSequence.warningToastId = manager.addToast(warningMessage, 'warning', {
                autoDismissMs: LARGE_WARNING_AUTO_DISMISS_MS,
              });
            }
          }
          break;
        case 'PROCESSING':
          // Step 2: Processing watermark
          if (activeSequence?.processingToastId) {
            manager.updateToast(activeSequence.processingToastId, processingMessage, 'info');
            break;
          }
          if (!activeSequence?.processingTimer) {
            const processingToastId = manager.addToast(processingMessage, 'info', {
              pending: true,
              autoDismissMs: PROCESSING_FALLBACK_AUTO_DISMISS_MS,
            });
            if (activeSequence) activeSequence.processingToastId = processingToastId;
          }
          break;
        case 'SUCCESS':
          // Step 3: Done, auto-dismiss after 2s
          finalizeSequence('success', successMessage);
          break;
        case 'ERROR':
          finalizeSequence('error', `${errorPrefix}: ${message}`);
          break;
        case 'GOOGLE_IMAGE_CORRUPTED':
          finalizeSequence('warning', corruptedMessage);
          break;
      }
    } catch (e) {
      console.error('[Gemini Voyager] Failed to parse status:', e);
    }
  };

  statusObserver = new MutationObserver(() => {
    const statusData = bridge.dataset.status;
    if (!statusData) return;
    handleStatus(statusData);
  });

  statusObserver.observe(bridge, { attributes: true, attributeFilter: ['data-status'] });
  if (bridge.dataset.status) {
    handleStatus(bridge.dataset.status);
  }
}
