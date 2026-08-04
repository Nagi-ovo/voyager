import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('settings search clear control', () => {
  it('hides the native Chromium cancel button while keeping the accessible custom control', () => {
    const popupSource = readFileSync(resolve(process.cwd(), 'src/pages/popup/Popup.tsx'), 'utf8');
    const searchStart = popupSource.indexOf('<input\n              type="search"');
    const searchEnd = popupSource.indexOf('</button>', searchStart);
    const searchControls = popupSource.slice(searchStart, searchEnd);

    expect(searchStart).toBeGreaterThan(-1);
    expect(searchEnd).toBeGreaterThan(searchStart);
    expect(searchControls).toContain('value={settingsSearchQuery}');
    expect(searchControls).toContain('[&::-webkit-search-cancel-button]:hidden');
    expect(searchControls).toContain("onClick={() => updateSettingsSearchQuery('')}");
    expect(searchControls).toContain("aria-label={t('popupSettingsSearchClear')}");
    expect(searchControls).toContain("title={t('popupSettingsSearchClear')}");
  });
});
