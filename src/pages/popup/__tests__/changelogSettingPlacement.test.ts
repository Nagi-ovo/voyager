import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('changelog notification setting placement', () => {
  it('keeps the NEW badge preference inside General Options', () => {
    const popupSource = readFileSync(resolve(process.cwd(), 'src/pages/popup/Popup.tsx'), 'utf8');
    const generalStart = popupSource.indexOf('{/* General Options */}');
    const generalEnd = popupSource.indexOf('{/* Image Refinement Options */}', generalStart);
    const generalSection = popupSource.slice(generalStart, generalEnd);

    expect(generalStart).toBeGreaterThan(-1);
    expect(generalEnd).toBeGreaterThan(generalStart);
    expect(generalSection).toContain('id="changelog-notify-badge"');
    expect(generalSection).toContain("t('changelog_badge_mode_hint')");
    expect(popupSource.match(/id="changelog-notify-badge"/g)).toHaveLength(1);
  });
});
