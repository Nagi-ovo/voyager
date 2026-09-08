import type { ConversationReference, Folder } from '@/core/types/folder';

const ROOT_CONVERSATIONS_ID = '__root_conversations__';

/**
 * Build a folder path string like "Parent / Child / Grandchild"
 */
function buildFolderPath(folderId: string, foldersById: Map<string, Folder>): string {
  const parts: string[] = [];
  let current = foldersById.get(folderId);
  while (current) {
    parts.unshift(current.name);
    current = current.parentId ? foldersById.get(current.parentId) : undefined;
  }
  return parts.join(' / ');
}

/**
 * Map language code to a human-readable language name for prompt instructions
 */
function getLanguageName(lang: string): string {
  const map: Record<string, string> = {
    en: 'English',
    zh: '中文',
    zh_TW: '繁體中文',
    ja: '日本語',
    ko: '한국어',
    ar: 'العربية',
    es: 'Español',
    fr: 'Français',
    pt: 'Português',
    ru: 'Русский',
  };
  return map[lang] || 'English';
}

/**
 * Format all conversations and folder structure as a prompt for AI organization.
 *
 * Key design: the output JSON should only contain INCREMENTAL changes —
 * new folders + new conversation-to-folder assignments for currently unfiled
 * conversations. Existing folders/conversations must NOT be re-emitted, so
 * a "Merge" import won't touch the user's carefully curated structure.
 */
export function formatFolderStructurePrompt(
  sidebarConversations: Array<{ id: string; title: string; url: string }>,
  folderData: { folders: Folder[]; folderContents: Record<string, ConversationReference[]> },
  language: string,
): string {
  const lines: string[] = [];
  const langName = getLanguageName(language);

  // Build folder lookup
  const foldersById = new Map<string, Folder>();
  for (const folder of folderData.folders) {
    foldersById.set(folder.id, folder);
  }

  // Collect IDs of conversations already in folders
  const organizedIds = new Set<string>();
  for (const [folderId, convs] of Object.entries(folderData.folderContents)) {
    if (folderId === ROOT_CONVERSATIONS_ID) continue;
    for (const conv of convs) {
      organizedIds.add(conv.conversationId);
    }
  }

  // Section 1: Existing folder names (reference only, no conversations listed)
  const sortedFolders = [...folderData.folders].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return (a.sortIndex ?? 0) - (b.sortIndex ?? 0);
  });

  if (sortedFolders.length > 0) {
    lines.push('## Existing Folders (DO NOT re-create or modify)');
    lines.push('');
    for (const folder of sortedFolders) {
      const path = buildFolderPath(folder.id, foldersById);
      const convCount = (folderData.folderContents[folder.id] || []).length;
      lines.push(`- ${path}  (id: ${folder.id}, ${convCount} conversations)`);
    }
    lines.push('');
  }

  // Section 2: Unfiled conversations — these are the ones to organize
  const unfiledConvs = sidebarConversations.filter((c) => !organizedIds.has(c.id));
  if (unfiledConvs.length > 0) {
    lines.push('## Unfiled Conversations (to be organized)');
    lines.push('');
    for (const conv of unfiledConvs) {
      lines.push(`- [${conv.id}] ${conv.title} | ${conv.url}`);
    }
    lines.push('');
  }

  // Section 3: Instructions
  lines.push('## Instructions');
  lines.push('');
  lines.push(`Please respond in **${langName}** (folder names, explanations, etc.).`);
  lines.push('');
  lines.push('Organize the **unfiled conversations** above into folders. Rules:');
  lines.push('');
  lines.push(
    '1. **Do NOT re-output existing folders or their conversations.** The result will be merged (not replaced), so anything you output will be added on top of the current structure.',
  );
  lines.push(
    "2. You MAY place an unfiled conversation into an **existing folder** — just reference that folder's id in `folderContents`.",
  );
  lines.push(
    '3. You MAY create **new folders** as needed. Use a short random hex string (8 chars) as the folder id. Name them in ' +
      langName +
      '.',
  );
  lines.push(
    "4. New folders can be nested under existing folders by setting `parentId` to the existing folder's id.",
  );
  lines.push(
    '5. Each conversation must keep its original `conversationId` and `url` exactly as shown above.',
  );
  lines.push(
    '6. Only output the **incremental** JSON — new folders + new conversation assignments.',
  );
  lines.push('');
  lines.push('Output format (paste-ready for Gemini Voyager import):');
  lines.push('');
  lines.push('```json');
  lines.push('{');
  lines.push('  "format": "gemini-voyager.folders.v1",');
  lines.push(`  "exportedAt": "${new Date().toISOString()}",`);
  lines.push('  "version": "1.3.3",');
  lines.push('  "data": {');
  lines.push('    "folders": [');
  lines.push('      // ONLY new folders here (omit existing ones)');
  lines.push('      {');
  lines.push('        "id": "<8-char-hex>",');
  lines.push(`        "name": "<folder name in ${langName}>",`);
  lines.push('        "parentId": null,');
  lines.push('        "isExpanded": true,');
  lines.push('        "createdAt": <unix-ms>,');
  lines.push('        "updatedAt": <unix-ms>');
  lines.push('      }');
  lines.push('    ],');
  lines.push('    "folderContents": {');
  lines.push('      // Can reference EXISTING folder ids or NEW folder ids');
  lines.push('      "<folder-id>": [');
  lines.push('        {');
  lines.push('          "conversationId": "<id from unfiled list>",');
  lines.push('          "title": "<title>",');
  lines.push('          "url": "<url>",');
  lines.push('          "addedAt": <unix-ms>');
  lines.push('        }');
  lines.push('      ]');
  lines.push('    }');
  lines.push('  }');
  lines.push('}');
  lines.push('```');

  return lines.join('\n');
}
