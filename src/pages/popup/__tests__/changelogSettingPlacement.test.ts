import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => readFileSync(resolve(process.cwd(), relative), 'utf8');

describe('changelog notification setting placement', () => {
  it('keeps the NEW badge preference inside General Options', () => {
    const popupSource = read('src/pages/popup/Popup.tsx');
    const generalStart = popupSource.indexOf('{/* General Options */}');
    const generalEnd = popupSource.indexOf('{/* Image Refinement Options */}', generalStart);
    const generalSection = popupSource.slice(generalStart, generalEnd);

    expect(generalStart).toBeGreaterThan(-1);
    expect(generalEnd).toBeGreaterThan(generalStart);
    // The section body is the extracted card; the badge row must live there
    // and nowhere else in the popup.
    expect(generalSection).toContain('<GeneralSettingsCard');
    expect(generalSection).toContain('changelogBadgeMode');

    const cardSource = read('src/pages/popup/components/GeneralSettingsCard.tsx');
    expect(cardSource).toContain("'changelog-notify-badge'");
    expect(cardSource).toContain("'changelog_badge_mode_hint'");
    expect(popupSource).not.toContain('changelog-notify-badge');
  });
});
