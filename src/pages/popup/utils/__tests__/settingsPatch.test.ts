import { describe, expect, it, vi } from 'vitest';

import { applySettingsPatch } from '../settingsPatch';

interface Probe {
  flag: boolean;
  label: string;
}

describe('applySettingsPatch', () => {
  it('hands each present key to its setter and skips absent ones', () => {
    const setters = { flag: vi.fn(), label: vi.fn() };

    applySettingsPatch<Probe>(setters, { label: 'next' });

    expect(setters.label).toHaveBeenCalledWith('next');
    expect(setters.flag).not.toHaveBeenCalled();
  });

  it('treats an explicit undefined as absent', () => {
    const setters = { flag: vi.fn(), label: vi.fn() };

    applySettingsPatch<Probe>(setters, { flag: false, label: undefined });

    expect(setters.flag).toHaveBeenCalledWith(false);
    expect(setters.label).not.toHaveBeenCalled();
  });
});
