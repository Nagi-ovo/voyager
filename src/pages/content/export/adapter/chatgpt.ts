import { DOMContentExtractor } from '@/features/export/services/DOMContentExtractor';
import type { ChatTurn, ExportHandler } from '@/features/export/types/export';

import {
  computeConversationFingerprint,
  waitForConversationFingerprintChangeOrTimeout,
} from '../topNodePreload';
import type { ChatGptTurnContainer, ChatGptTurnRole } from './type';

const TURN_CONTAINER_SELECTOR = '[data-turn-id-container]';
const USER_MESSAGE_SELECTOR = '[data-message-author-role="user"]';
const ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"]';
const IMAGEGEN_SELECTOR = '[class*="group/imagegen-image"]';

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
    if (!id) continue;

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
export async function materializeChatGptTurnContainer(
  turn: ChatGptTurnContainer,
): Promise<ChatGptTurnContainer> {
  turn.container.scrollIntoView({
    block: 'center',
    behavior: 'auto',
  });

  // 等待角色确定
  const contentSelectors = [USER_MESSAGE_SELECTOR, ASSISTANT_MESSAGE_SELECTOR, IMAGEGEN_SELECTOR];

  const before = computeConversationFingerprint(turn.container, contentSelectors, 10);

  await waitForConversationFingerprintChangeOrTimeout(turn.container, contentSelectors, before, {
    minWaitMs: 200,
    idleMs: 250,
    pollIntervalMs: 80,
    timeoutMs: 3000,
    maxSamples: 10,
  });

  return {
    ...turn,
    // DOM stabilization may have replaced the inner message subtree, so read
    // the role again from the final rendered state rather than retaining a
    // potentially stale pre-stabilization value.
    role: resolveTurnRole(turn.container),
  };
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
  exportHandler: ExportHandler,
): Promise<ChatTurn[]> {
  // querySelectorAll returns ChatGPT's retained virtual-list order. Filtering
  // this registry, rather than sorting visual coordinates, prevents image cards
  // and independently positioned DOM wrappers from changing export order.
  const selectedContainers = chatgptCollectTurnContainers().filter((turn) =>
    selectedContainerIds.has(turn.id),
  );

  const turns: ChatTurn[] = [];
  let pendingUser: ChatTurn | null = null;

  for (const turn of selectedContainers) {
    const materialized = await materializeChatGptTurnContainer(turn);
    const { container, role } = materialized;

    if (role === 'user') {
      // A second user message closes an earlier selected user-only turn.
      if (pendingUser) {
        turns.push(pendingUser);
      }

      const userElement = container.querySelector<HTMLElement>(USER_MESSAGE_SELECTOR);
      if (!userElement) {
        // The virtualized node did not finish mounting before the timeout. Do
        // not invent content or bind it to another message; keep processing
        // the remaining selected IDs.
        pendingUser = null;
        continue;
      }

      const userContent = DOMContentExtractor.extractUserContent(userElement, exportHandler);
      pendingUser = {
        user: userContent.text,
        assistant: '',
        starred: false,
        attachments: userContent.attachments,
        omitEmptySections: true,
        userContent,
      };
      continue;
    }

    if (role === 'assistant') {
      // Image-generation replies can be identified by IMAGEGEN_SELECTOR before
      // ChatGPT exposes a conventional assistant root. In that case the top
      // container remains the correct extraction root: it contains the image
      // card and belongs to exactly this stable virtual-list item.
      const assistantElement =
        container.querySelector<HTMLElement>(ASSISTANT_MESSAGE_SELECTOR) ?? container;
      const assistantContent = DOMContentExtractor.extractAssistantContent(
        assistantElement,
        exportHandler,
      );

      if (pendingUser) {
        pendingUser.assistant = assistantContent.text;
        pendingUser.assistantContent = assistantContent;
        turns.push(pendingUser);
        pendingUser = null;
      } else {
        // The user selected only this assistant reply, or its paired user was
        // not selected. Export it as an intentionally assistant-only turn.
        turns.push({
          user: '',
          assistant: assistantContent.text,
          starred: false,
          omitEmptySections: true,
          assistantContent,
        });
      }
    }
  }

  // Preserve a selected user message even when its assistant reply was not
  // selected or was unavailable during this export.
  if (pendingUser) {
    turns.push(pendingUser);
  }

  return turns;
}
