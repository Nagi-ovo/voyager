import {
  DOMContentExtractor,
  type ExtractedContent,
} from '@/features/export/services/DOMContentExtractor';
import type { ChatTurn } from '@/features/export/types/export';

import { computeConversationFingerprint } from '../topNodePreload';
import type { ChatGptTurnContainer, ChatGptTurnRole, ExportSelectionOptions } from './type';

const TURN_CONTAINER_SELECTOR = '[data-turn-id-container]';
const NON_TURN_CONTAINER_IDS = new Set(['client-created-root']);
const USER_MESSAGE_SELECTOR = '[data-message-author-role="user"]';
const ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"]';
const IMAGEGEN_SELECTOR = '[class*="group/imagegen-image"]';
const STOP_GENERATING_SELECTOR = [
  '[data-testid="stop-button"]',
  'button[aria-label*="stop generating" i]',
  'button[aria-label*="停止生成"]',
].join(',');
const STREAMING_TURN_SELECTOR = [
  '[data-message-streaming="true"]',
  '[data-is-streaming="true"]',
  '.result-streaming',
].join(',');
const MATERIALIZATION_TIMEOUT_MS = 3000;
const MATERIALIZATION_POLL_MS = 80;
const MATERIALIZATION_IDLE_MS = 240;
const MATERIALIZATION_REPOSITION_MS = 160;

function resolveTurnRole(container: HTMLElement): ChatGptTurnRole {
  if (container.querySelector(USER_MESSAGE_SELECTOR)) {
    return 'user';
  }

  if (
    container.querySelector(ASSISTANT_MESSAGE_SELECTOR) ||
    container.querySelector(IMAGEGEN_SELECTOR)
  ) {
    return 'assistant';
  }

  return 'unknown';
}

function mergeExtractedContent(
  primary: ExtractedContent,
  supplemental: ExtractedContent,
): ExtractedContent {
  return {
    text: [primary.text, supplemental.text].filter(Boolean).join('\n\n'),
    html: [primary.html, supplemental.html].filter(Boolean).join('\n'),
    attachments: [...primary.attachments, ...supplemental.attachments],
    hasImages: primary.hasImages || supplemental.hasImages,
    hasFormulas: primary.hasFormulas || supplemental.hasFormulas,
    hasTables: primary.hasTables || supplemental.hasTables,
    hasCode: primary.hasCode || supplemental.hasCode,
  };
}

function extractSiblingGeneratedImages(
  container: HTMLElement,
  assistantElement: HTMLElement,
): ExtractedContent | null {
  const siblingImages = Array.from(
    container.querySelectorAll<HTMLImageElement>(`${IMAGEGEN_SELECTOR} img`),
  ).filter((image) => !assistantElement.contains(image));
  if (siblingImages.length === 0) return null;

  // ChatGPT can render generated-image cards beside (rather than inside) the
  // conventional assistant root. Extract only cloned image nodes so card
  // controls such as Edit/Share cannot leak into the exported response.
  const imageRoot = document.createElement('div');
  siblingImages.forEach((image) => imageRoot.appendChild(image.cloneNode(true)));
  return DOMContentExtractor.extractAssistantContent(imageRoot);
}

/**
 * 读取 ChatGPT 虚拟列表保留的顶层对话容器。
 *
 * 容器属性提供稳定身份和完整 DOM 顺序；内部消息 DOM 可能在离开视口时卸载，
 * 因而 role 可暂时为 unknown。
 */
export function chatgptCollectTurnContainers(root: ParentNode = document): ChatGptTurnContainer[] {
  const turnsById = new Map<string, ChatGptTurnContainer>();

  for (const container of root.querySelectorAll<HTMLElement>(TURN_CONTAINER_SELECTOR)) {
    const id = container.getAttribute('data-turn-id-container')?.trim();
    if (!id || NON_TURN_CONTAINER_IDS.has(id)) continue;

    const role = resolveTurnRole(container);
    const existing = turnsById.get(id);
    if (!existing) {
      // The first occurrence establishes ChatGPT's virtual-list order.
      turnsById.set(id, {
        id,
        sequence: turnsById.size,
        role,
        container,
      });
      continue;
    }

    // ChatGPT can briefly retain a duplicate container during virtual-list
    // reconciliation. Both nodes carry the same stable turn ID and represent
    // one message, so never emit a second record. Prefer the copy with mounted
    // content when the first occurrence is currently only an empty shell.
    if (existing.role === 'unknown' && role !== 'unknown') {
      turnsById.set(id, { ...existing, role, container });
    }
  }

  return Array.from(turnsById.values());
}

/*
  物化单条，确定角色
 */
function normalizedConversationUrl(url = location.href): string {
  const parsed = new URL(url, location.href);
  return `${parsed.origin}${parsed.pathname}${parsed.search}`;
}

function abortError(): DOMException {
  return new DOMException('ChatGPT export cancelled', 'AbortError');
}

function assertSelectionActive(options: ExportSelectionOptions): void {
  if (options.signal?.aborted) throw abortError();
  if (
    options.expectedUrl &&
    normalizedConversationUrl(options.expectedUrl) !== normalizedConversationUrl()
  ) {
    throw new Error('chatgpt_export_conversation_changed');
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(done, ms);
    function done(): void {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }
    function cancel(): void {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(abortError());
    }
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

function findTurnContainer(id: string): ChatGptTurnContainer | null {
  return chatgptCollectTurnContainers().find((turn) => turn.id === id) ?? null;
}

function hasUsableGeneratedImage(container: HTMLElement): boolean {
  const imageGenRoot = container.querySelector(IMAGEGEN_SELECTOR);
  if (!imageGenRoot) return false;

  return Array.from(imageGenRoot.querySelectorAll<HTMLImageElement>('img')).some((image) => {
    const src = (image.getAttribute('src') || image.src || '').trim();
    return src.length > 0 && src !== 'about:blank';
  });
}

function hasMountedContent(turn: ChatGptTurnContainer): boolean {
  if (turn.container.querySelector(IMAGEGEN_SELECTOR)) {
    // Image-generation cards mount their Edit/Share controls before the image.
    // Those labels are not exportable response content, so wait for a usable
    // image URL instead of snapshotting the placeholder card.
    if (hasUsableGeneratedImage(turn.container)) return true;
    const assistantRoot = turn.container.querySelector<HTMLElement>(ASSISTANT_MESSAGE_SELECTOR);
    return assistantRoot ? hasConventionalMountedContent(assistantRoot) : false;
  }

  const root =
    turn.role === 'user'
      ? turn.container.querySelector<HTMLElement>(USER_MESSAGE_SELECTOR)
      : turn.container.querySelector<HTMLElement>(ASSISTANT_MESSAGE_SELECTOR);
  return root ? hasConventionalMountedContent(root) : false;
}

function hasConventionalMountedContent(root: HTMLElement): boolean {
  return (
    (root.textContent?.trim().length ?? 0) > 0 ||
    root.querySelector('img, svg, canvas, pre, table, [data-math-source], [role="math"]') != null
  );
}

function isGeneratingTurn(turn: ChatGptTurnContainer): boolean {
  if (
    turn.container.matches(STREAMING_TURN_SELECTOR) ||
    turn.container.querySelector(STREAMING_TURN_SELECTOR)
  ) {
    return true;
  }
  if (!document.querySelector(STOP_GENERATING_SELECTOR)) return false;
  const ordered = chatgptCollectTurnContainers();
  return ordered.at(-1)?.id === turn.id && turn.role === 'assistant';
}

/**
 * Materialize a virtualized ChatGPT turn. Already-mounted, completed turns use
 * a zero-wait fast path; empty shells wait for a positive role/content signal.
 */
export async function materializeChatGptTurnContainer(
  turn: ChatGptTurnContainer,
  options: ExportSelectionOptions = {},
): Promise<ChatGptTurnContainer> {
  assertSelectionActive(options);
  let current = findTurnContainer(turn.id) ?? turn;
  current = { ...current, role: resolveTurnRole(current.container) };
  if (current.role !== 'unknown' && hasMountedContent(current) && !isGeneratingTurn(current)) {
    return current;
  }

  current.container.scrollIntoView({ block: 'center', behavior: 'auto' });

  const contentSelectors = [USER_MESSAGE_SELECTOR, ASSISTANT_MESSAGE_SELECTOR, IMAGEGEN_SELECTOR];
  const startedAt = Date.now();
  let lastPositionAt = startedAt;
  let stableSignature = '';
  let stableSince = 0;

  while (Date.now() - startedAt < MATERIALIZATION_TIMEOUT_MS) {
    assertSelectionActive(options);
    const latest = findTurnContainer(turn.id);
    if (latest) current = { ...latest, role: resolveTurnRole(latest.container) };

    const hasContent = current.role !== 'unknown' && hasMountedContent(current);
    if (!hasContent && Date.now() - lastPositionAt >= MATERIALIZATION_REPOSITION_MS) {
      const rect = current.container.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) {
        // ChatGPT reconciles estimated shell heights after nearby turns mount.
        // That layout shift can move the requested shell back out of view even
        // though the first scrollIntoView call succeeded, so re-anchor it.
        current.container.scrollIntoView({ block: 'center', behavior: 'auto' });
        lastPositionAt = Date.now();
      }
    }

    if (hasContent && !isGeneratingTurn(current)) {
      const fingerprint = computeConversationFingerprint(current.container, contentSelectors, 10);
      const signature = `${fingerprint.signature}:${fingerprint.count}`;
      if (signature !== stableSignature) {
        stableSignature = signature;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= MATERIALIZATION_IDLE_MS) {
        return current;
      }
    } else {
      stableSignature = '';
      stableSince = 0;
    }

    await wait(MATERIALIZATION_POLL_MS, options.signal);
  }

  if (isGeneratingTurn(current)) throw new Error('chatgpt_export_response_still_generating');
  throw new Error(`chatgpt_export_message_unavailable:${turn.id}`);
}

function resolveSelectedContainers(
  selectedContainerIds: ReadonlySet<string>,
): ChatGptTurnContainer[] {
  const allContainers = chatgptCollectTurnContainers();
  const knownIds = new Set(allContainers.map((turn) => turn.id));
  const missingIds = Array.from(selectedContainerIds).filter((id) => !knownIds.has(id));
  if (missingIds.length > 0) {
    throw new Error(`chatgpt_export_messages_missing:${missingIds.join(',')}`);
  }
  return allContainers.filter((turn) => selectedContainerIds.has(turn.id));
}

type ScrollSnapshot = {
  readonly element: HTMLElement;
  readonly top: number;
  readonly left: number;
};

function captureScrollState(container: HTMLElement | undefined): {
  readonly elements: ScrollSnapshot[];
  readonly windowX: number;
  readonly windowY: number;
} {
  const elements: ScrollSnapshot[] = [];
  for (let current = container?.parentElement ?? null; current; current = current.parentElement) {
    if (current.scrollHeight > current.clientHeight || current.scrollWidth > current.clientWidth) {
      elements.push({ element: current, top: current.scrollTop, left: current.scrollLeft });
    }
  }
  return { elements, windowX: window.scrollX, windowY: window.scrollY };
}

function restoreScrollState(snapshot: ReturnType<typeof captureScrollState>): void {
  for (const { element, top, left } of snapshot.elements) {
    element.scrollTop = top;
    element.scrollLeft = left;
  }
  try {
    window.scrollTo(snapshot.windowX, snapshot.windowY);
  } catch {
    // jsdom and locked-down pages may not implement scrolling.
  }
}

export async function resolveChatGptSelectionRoles(
  selectedContainerIds: ReadonlySet<string>,
  options: ExportSelectionOptions = {},
): Promise<ReadonlyMap<string, ChatGptTurnRole>> {
  assertSelectionActive(options);
  const selectedContainers = resolveSelectedContainers(selectedContainerIds);
  const scrollState = captureScrollState(selectedContainers[0]?.container);
  const roles = new Map<string, ChatGptTurnRole>();
  try {
    for (const turn of selectedContainers) {
      assertSelectionActive(options);
      const resolved =
        turn.role === 'unknown' ? await materializeChatGptTurnContainer(turn, options) : turn;
      if (resolved.role === 'unknown') {
        throw new Error(`chatgpt_export_role_unavailable:${turn.id}`);
      }
      roles.set(turn.id, resolved.role);
    }
    return roles;
  } finally {
    restoreScrollState(scrollState);
  }
}

/**
 * Builds export-ready ChatTurn records for selected ChatGPT message containers.
 *
 * ChatGPT keeps every `[data-turn-id-container]` element as an ordered virtual
 * list item, but unloads its inner message DOM outside the viewport. The
 * selected container IDs are therefore the stable selection and ordering source.
 * For each selected ID we:
 *
 * 1. look it up in a fresh container registry, preserving the conversation order;
 * 2. scroll it into view and wait for ChatGPT to mount and settle its content;
 * 3. immediately use DOMContentExtractor to persist rich text/HTML before the
 *    next scroll can cause ChatGPT to unload this message again;
 * 4. merge adjacent selected user and assistant messages into the existing
 *    platform-neutral ChatTurn shape consumed by all export formats.
 *
 * A selected assistant without its user message deliberately becomes an
 * assistant-only ChatTurn. This preserves the user's message-level selection
 * rather than silently attaching it to an unselected prompt.
 */
export async function buildChatGptTurnsForSelection(
  selectedContainerIds: ReadonlySet<string>,
  options: ExportSelectionOptions = {},
): Promise<ChatTurn[]> {
  // querySelectorAll returns ChatGPT's retained virtual-list order. Filtering
  // this registry, rather than sorting visual coordinates, prevents image cards
  // and independently positioned DOM wrappers from changing export order.
  assertSelectionActive(options);
  const selectedContainers = resolveSelectedContainers(selectedContainerIds);
  const scrollState = captureScrollState(selectedContainers[0]?.container);

  const turns: ChatTurn[] = [];
  let pendingUser: { readonly turn: ChatTurn; readonly sequence: number } | null = null;
  const extractedIds = new Set<string>();

  try {
    for (const turn of selectedContainers) {
      assertSelectionActive(options);
      const materialized = await materializeChatGptTurnContainer(turn, options);
      const { container, role } = materialized;
      const sequence = turn.sequence;

      if (role === 'user') {
        // A second user message closes an earlier selected user-only turn.
        if (pendingUser) turns.push(pendingUser.turn);

        const userElement = container.querySelector<HTMLElement>(USER_MESSAGE_SELECTOR);
        if (!userElement) throw new Error(`chatgpt_export_message_unavailable:${turn.id}`);

        const userContent = DOMContentExtractor.extractUserContent(userElement);
        if (!userContent.text && !userContent.html && userContent.attachments.length === 0) {
          throw new Error(`chatgpt_export_message_empty:${turn.id}`);
        }
        pendingUser = {
          sequence,
          turn: {
            user: userContent.text,
            assistant: '',
            starred: false,
            attachments: userContent.attachments,
            omitEmptySections: true,
            userContent,
          },
        };
        extractedIds.add(turn.id);
        continue;
      }

      if (role === 'assistant') {
        const assistantElement =
          container.querySelector<HTMLElement>(ASSISTANT_MESSAGE_SELECTOR) ?? container;
        let assistantContent = DOMContentExtractor.extractAssistantContent(assistantElement);
        const siblingImageContent = extractSiblingGeneratedImages(container, assistantElement);
        if (siblingImageContent) {
          assistantContent = mergeExtractedContent(assistantContent, siblingImageContent);
        }
        if (!assistantContent.text && !assistantContent.html) {
          throw new Error(`chatgpt_export_message_empty:${turn.id}`);
        }

        if (pendingUser?.sequence === sequence - 1) {
          pendingUser.turn.assistant = assistantContent.text;
          pendingUser.turn.assistantContent = assistantContent;
          turns.push(pendingUser.turn);
          pendingUser = null;
        } else {
          if (pendingUser) {
            turns.push(pendingUser.turn);
            pendingUser = null;
          }
          turns.push({
            user: '',
            assistant: assistantContent.text,
            starred: false,
            omitEmptySections: true,
            assistantContent,
          });
        }
        extractedIds.add(turn.id);
        continue;
      }

      throw new Error(`chatgpt_export_role_unavailable:${turn.id}`);
    }

    if (pendingUser) turns.push(pendingUser.turn);
    if (extractedIds.size !== selectedContainerIds.size) {
      throw new Error('chatgpt_export_incomplete_selection');
    }

    return turns;
  } finally {
    restoreScrollState(scrollState);
  }
}
