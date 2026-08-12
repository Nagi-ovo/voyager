import type { ExtractedContent } from '@/features/export/services/DOMContentExtractor';
import type { ChatTurn } from '@/features/export/types/export';
import type { SiteAdapter } from '@/features/plugins/types';

import type { ChatGptTurnContainer, ChatGptTurnRole, ExportSelectionOptions } from '../type';

/**
 * Platform boundary for the shared conversation export pipeline.
 *
 * Platform modules translate host DOM into this contract. Shared export
 * services must not branch on a host name or depend on host-specific selectors.
 */
export interface ExportPlatformAdapter {
  readonly site: SiteAdapter;

  getUserSelectors: () => string[];
  getAssistantSelectors: () => string[];
  getConversationRootCandidates: () => string[];
  extractConversationTitle: () => string;
  extractConversationIdFromUrl: () => string | null;
  shouldPreloadHistory: () => boolean;
  resolveConversationRoot: (userSelectors: string[], doc: Document) => HTMLElement;
  extractUserImage: (element: HTMLElement) => NodeListOf<HTMLImageElement>;
  extractUserText: (
    textLines: NodeListOf<HTMLElement>,
    textParts: string[],
    element: HTMLElement,
  ) => void;
  getUserAttachmentCandidates: (element: HTMLElement) => HTMLElement[] | undefined;
  extractAssistantImage: (
    child: Element,
    htmlParts: string[],
    textParts: string[],
    flags: Pick<ExtractedContent, 'hasImages' | 'hasFormulas' | 'hasTables' | 'hasCode'>,
    tagName?: string,
    DEBUG?: boolean,
    processedImageSrcs?: Set<string>,
  ) => boolean | undefined;
  extractFormula: (
    child: Element,
    flags: Pick<ExtractedContent, 'hasImages' | 'hasFormulas' | 'hasTables' | 'hasCode'>,
    htmlParts: string[],
    textParts: string[],
    DEBUG: boolean,
  ) => boolean | undefined;
  extractCodeBlock: (
    child: Element,
    htmlParts: string[],
    textParts: string[],
    flags: Pick<ExtractedContent, 'hasImages' | 'hasFormulas' | 'hasTables' | 'hasCode'>,
    tagName?: string,
    DEBUG?: boolean,
  ) => boolean | undefined;
  extractInlineFormula: (
    el: Element,
    htmlParts: string[],
    textParts: string[],
  ) => boolean | undefined;

  collectTurnContainers?: () => ChatGptTurnContainer[];
  buildTurnsForSelection?: (
    selectedMessageIds: ReadonlySet<string>,
    options?: ExportSelectionOptions,
  ) => Promise<ChatTurn[]>;
  resolveSelectionRoles?: (
    selectedMessageIds: ReadonlySet<string>,
    options?: ExportSelectionOptions,
  ) => Promise<ReadonlyMap<string, ChatGptTurnRole>>;
}
