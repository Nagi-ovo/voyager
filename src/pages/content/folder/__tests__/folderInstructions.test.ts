import { describe, expect, it } from 'vitest';

import type { FolderId } from '@/core/types/common';
import type { FolderData } from '@/core/types/folder';
import { FolderImportExportService } from '@/features/folder/services/FolderImportExportService';

describe('FolderImportExportService — instructions round-trip', () => {
  it('preserves instructions through export', () => {
    const data: FolderData = {
      folders: [
        {
          id: 'f1' as FolderId,
          name: 'Coding',
          parentId: null,
          isExpanded: true,
          createdAt: 1000,
          updatedAt: 1000,
          instructions: 'Use TypeScript always.',
        },
      ],
      folderContents: {},
    };

    const payload = FolderImportExportService.exportToPayload(data);
    expect(payload.data.folders[0].instructions).toBe('Use TypeScript always.');
  });

  it('gracefully handles folders without instructions (older payloads)', () => {
    const data: FolderData = {
      folders: [
        {
          id: 'f2' as FolderId,
          name: 'Misc',
          parentId: null,
          isExpanded: true,
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
      folderContents: {},
    };

    const payload = FolderImportExportService.exportToPayload(data);
    expect(payload.data.folders[0].instructions).toBeUndefined();
  });
});

describe('FolderImportExportService — pasted AI organize output', () => {
  it('parses JSON from a Gemini markdown code block', () => {
    const text = `Sure, here is the importable plan:

\`\`\`json
{
  "format": "gemini-voyager.folders.v1",
  "exportedAt": "2026-06-18T00:00:00.000Z",
  "data": {
    "folders": [],
    "folderContents": {}
  }
}
\`\`\`
`;

    const parsed = FolderImportExportService.parseJSONText(text);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(FolderImportExportService.validatePayload(parsed.data).success).toBe(true);
  });
});
