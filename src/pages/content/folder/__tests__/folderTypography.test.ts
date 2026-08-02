import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('folder sidebar typography', () => {
  it('locks Gemini folder text to native sidebar sizing without affecting AI Studio', () => {
    const css = readFileSync(resolve(process.cwd(), 'public/contentStyle.css'), 'utf8');
    const titleBlock =
      css.match(
        /\.gv-folder-container:not\(\.gv-aistudio\) \.gv-folder-header \.title\s*{([\s\S]*?)}/,
      )?.[1] ?? '';
    const itemTextBlock =
      css.match(
        /\.gv-folder-container:not\(\.gv-aistudio\) \.gv-folder-name,\s*\.gv-folder-container:not\(\.gv-aistudio\) \.gv-conversation-title\s*{([\s\S]*?)}/,
      )?.[1] ?? '';
    const aiStudioNameBlock = css.match(/\.gv-aistudio \.gv-folder-name\s*{([\s\S]*?)}/)?.[1] ?? '';
    const aiStudioConversationBlock =
      css.match(/\.gv-aistudio \.gv-conversation-title\s*{([\s\S]*?)}/g)?.at(-1) ?? '';

    // Section title matches Gemini's native expandable-section title (gds-body-s).
    expect(titleBlock).toContain('font-size: 13px;');
    expect(titleBlock).toContain('line-height: 17px;');
    expect(itemTextBlock).toContain('font-size: 14px;');
    expect(itemTextBlock).toContain('line-height: 20px;');
    expect(aiStudioNameBlock).toContain('font-size: 12px;');
    expect(aiStudioConversationBlock).toContain('font-size: 12px;');
  });

  it('keeps Activity headings and rows on the shared native section axis', () => {
    const css = readFileSync(resolve(process.cwd(), 'public/contentStyle.css'), 'utf8');
    const containerBlock = css.match(/\.gv-folder-container\s*{([\s\S]*?)}/)?.[1] ?? '';
    const headerBlock = css.match(/\.gv-folder-header\s*{([\s\S]*?)}/)?.[1] ?? '';
    const activityListBlock = css.match(/\.gv-folder-activity-list\s*{([\s\S]*?)}/)?.[1] ?? '';
    const activityHeadingBlock =
      css.match(/\.gv-folder-activity-heading\s*{([\s\S]*?)}/)?.[1] ?? '';
    const activityItemBlock = css.match(/\.gv-folder-activity-item\s*{([\s\S]*?)}/)?.[1] ?? '';
    const starredActivityBlock =
      css.match(/\.gv-folder-activity-item\.gv-starred\s*{([\s\S]*?)}/)?.[1] ?? '';
    const selectedActivityBlock =
      css.match(/\.gv-folder-activity-item\.gv-folder-conversation-selected\s*{([\s\S]*?)}/)?.[1] ??
      '';

    expect(containerBlock).toContain('--gv-folder-section-gutter: 14px;');
    expect(containerBlock).toContain('--gv-folder-list-edge: 4px;');
    expect(headerBlock).toContain('padding-inline-start: var(--gv-folder-section-gutter);');
    expect(activityListBlock).toContain('padding-inline: var(--gv-folder-list-edge);');
    expect(activityHeadingBlock).toContain('padding-inline: var(--gv-folder-activity-row-inset);');
    expect(activityItemBlock).toContain('padding-inline: var(--gv-folder-activity-row-inset);');
    expect(starredActivityBlock).toContain('background: transparent;');
    expect(selectedActivityBlock).not.toContain('linear-gradient');
  });
});
