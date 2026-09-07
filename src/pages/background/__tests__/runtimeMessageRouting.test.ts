import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  MAX_RUNTIME_IMAGE_BYTES,
  isAllowedRuntimeImageBody,
  parseAllowedRuntimeImageUrl,
} from '@/core/utils/runtimeImageFetch';
import {
  CHATGPT_HANDOFF_CANCEL_EXPIRY_MESSAGE,
  CHATGPT_HANDOFF_GET_TAB_ID_MESSAGE,
  CHATGPT_HANDOFF_SCHEDULE_EXPIRY_MESSAGE,
} from '@/features/plugins/builtin/chatgptTemporaryHandoff/storage';
import {
  PLUGIN_CATALOG_REFRESH_MESSAGE,
  PLUGIN_CONTENT_SCRIPT_SYNC_MESSAGE,
} from '@/features/plugins/runtime/messages';

import {
  isAllowedSyncContentSender,
  isHandledBackgroundRuntimeMessage,
} from '../runtimeMessageRouting';

describe('background runtime message routing', () => {
  it('keeps the async channel open only for exact handled message types', () => {
    expect(isHandledBackgroundRuntimeMessage({ type: 'gv.account.resolve' })).toBe(true);
    expect(isHandledBackgroundRuntimeMessage({ type: 'gv.highlight.list' })).toBe(true);
    expect(isHandledBackgroundRuntimeMessage({ type: 'gv.sync.upload' })).toBe(true);
    expect(isHandledBackgroundRuntimeMessage({ type: PLUGIN_CONTENT_SCRIPT_SYNC_MESSAGE })).toBe(
      true,
    );
    expect(isHandledBackgroundRuntimeMessage({ type: PLUGIN_CATALOG_REFRESH_MESSAGE })).toBe(true);
    expect(
      isHandledBackgroundRuntimeMessage({ type: CHATGPT_HANDOFF_SCHEDULE_EXPIRY_MESSAGE }),
    ).toBe(true);
    expect(isHandledBackgroundRuntimeMessage({ type: CHATGPT_HANDOFF_CANCEL_EXPIRY_MESSAGE })).toBe(
      true,
    );
    expect(isHandledBackgroundRuntimeMessage({ type: CHATGPT_HANDOFF_GET_TAB_ID_MESSAGE })).toBe(
      true,
    );

    expect(isHandledBackgroundRuntimeMessage({ type: 'gv.highlight.unknown' })).toBe(false);
    expect(isHandledBackgroundRuntimeMessage({ type: 'gv.storageQuota.ready' })).toBe(false);
    expect(isHandledBackgroundRuntimeMessage({ type: 'gv.unhandled' })).toBe(false);
    expect(isHandledBackgroundRuntimeMessage(null)).toBe(false);
  });

  it('routes explicit plugin registration repair through the serialized background sync', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/pages/background/index.ts'), 'utf8');
    const repairBranch =
      source.match(
        /if \(message\?\.type === PLUGIN_CONTENT_SCRIPT_SYNC_MESSAGE\) \{[\s\S]*?\n\s*\}/,
      )?.[0] ?? '';

    expect(repairBranch).toContain('await syncPluginContentScripts()');
    expect(repairBranch).toContain('sendResponse({ ok: true })');
  });

  it('routes remote plugin catalog checks through the single background refresher', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/pages/background/index.ts'), 'utf8');
    const branch =
      source.match(
        /if \(message\?\.type === PLUGIN_CATALOG_REFRESH_MESSAGE\) \{[\s\S]*?\n {6}\}/,
      )?.[0] ?? '';

    expect(branch).toContain('parseHostCatalogRefreshPayload(message.payload)');
    expect(branch).toContain(
      'hostCatalogRefresher.refresh(request.host, { force: request.force })',
    );
    expect(source.match(/new HostCatalogRefresher\(/g)?.length).toBe(1);
  });

  it('uploads the complete prompt union even when duplicate names remain', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/pages/background/index.ts'), 'utf8');
    const pushBranch =
      source.match(
        /case 'gv\.sync\.pushPromptsMerge': \{[\s\S]*?case 'gv\.sync\.getState': \{/,
      )?.[0] ?? '';

    expect(pushBranch).toContain('googleDriveSyncService.uploadPromptsOnly');
    expect(pushBranch).toContain('nameConflicts: getPromptNameConflictIds(localPrompts).size');
    expect(pushBranch).not.toContain('if (merged.data.nameConflicts > 0)');
    expect(pushBranch).not.toContain('skipped: true');
  });

  it('keeps privileged runtime operations behind their security boundaries', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/pages/background/index.ts'), 'utf8');
    const captureBranch =
      source.match(
        /if \(message\?\.type === 'gv\.generatedUi\.captureVisibleTab'\) \{[\s\S]*?if \(message\?\.type === 'gv\.account\.resolve'\) \{/,
      )?.[0] ?? '';
    const uploadBranch =
      source.match(/case 'gv\.sync\.upload': \{[\s\S]*?case 'gv\.sync\.download': \{/)?.[0] ?? '';
    const imageHandler =
      source.match(/async function handleRuntimeImageMessage\([\s\S]*?\n\}/)?.[0] ?? '';

    expect(captureBranch).toContain('chrome.tabs.query({ active: true, windowId })');
    expect(captureBranch).toContain('sender_not_active');

    expect(uploadBranch).toContain('loadAuthoritativeSyncPayload');
    expect(uploadBranch).not.toMatch(/const \{\s*folders,\s*prompts,/);

    expect(imageHandler).toContain('parseAllowedRuntimeImageUrl');
    expect(imageHandler).toContain('isAllowedRuntimeImageBody');
    expect(imageHandler).toContain('MAX_RUNTIME_IMAGE_BYTES');
  });

  it('renders AI Studio folder names as text instead of HTML', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/pages/content/folder/aistudio.ts'),
      'utf8',
    );
    const folderDropItem =
      source.match(
        /const createFolderDropItem = \(folder: Folder, isSubfolder: boolean\) => \{[\s\S]*?\/\/ Bind drop events/,
      )?.[0] ?? '';

    expect(folderDropItem).not.toContain('folderItem.innerHTML');
    expect(folderDropItem).toContain('document.createTextNode(folder.name)');
  });

  it('allows only bounded images from media hosts or the sender origin', () => {
    expect(
      parseAllowedRuntimeImageUrl(
        'https://lh3.googleusercontent.com/private/image.png',
        'https://gemini.google.com/app',
      )?.hostname,
    ).toBe('lh3.googleusercontent.com');
    expect(
      parseAllowedRuntimeImageUrl(
        'https://gemini.google.com/local/image.png',
        'https://gemini.google.com/app',
      )?.pathname,
    ).toBe('/local/image.png');

    expect(
      parseAllowedRuntimeImageUrl(
        'https://evil-googleusercontent.com/private',
        'https://gemini.google.com/app',
      ),
    ).toBeNull();
    expect(
      parseAllowedRuntimeImageUrl(
        'http://lh3.googleusercontent.com/private',
        'https://gemini.google.com/app',
      ),
    ).toBeNull();
    expect(
      parseAllowedRuntimeImageUrl(
        'https://accounts.google.com/private',
        'https://gemini.google.com/app',
      ),
    ).toBeNull();

    expect(isAllowedRuntimeImageBody('image/png', MAX_RUNTIME_IMAGE_BYTES)).toBe(true);
    expect(isAllowedRuntimeImageBody('text/html', 100)).toBe(false);
    expect(isAllowedRuntimeImageBody('image/png', MAX_RUNTIME_IMAGE_BYTES + 1)).toBe(false);
  });

  it('accepts sync content messages only from the matching product host', () => {
    expect(isAllowedSyncContentSender('https://gemini.google.com/app', 'gemini')).toBe(true);
    expect(isAllowedSyncContentSender('https://business.gemini.google/app', 'gemini')).toBe(true);
    expect(isAllowedSyncContentSender('https://aistudio.google.com/app', 'aistudio')).toBe(true);
    expect(isAllowedSyncContentSender('https://aistudio.google.cn/app', 'aistudio')).toBe(true);

    expect(isAllowedSyncContentSender('https://example.com/app', 'gemini')).toBe(false);
    expect(isAllowedSyncContentSender('https://gemini.google.com/app', 'aistudio')).toBe(false);
    expect(isAllowedSyncContentSender('http://gemini.google.com/app', 'gemini')).toBe(false);
  });
});
