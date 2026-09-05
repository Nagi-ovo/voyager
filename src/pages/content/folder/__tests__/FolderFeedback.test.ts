import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FolderFeedback } from '../FolderFeedback';

vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => key,
  getTranslationSyncUnsafe: (key: string) =>
    key === 'batch_delete_in_progress' ? 'Deleting {current}/{total}' : key,
}));

describe('FolderFeedback', () => {
  let feedback: FolderFeedback;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
    feedback = new FolderFeedback();
  });

  afterEach(() => {
    feedback.destroy();
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('shows truncated titles after the hover delay and supports forced folder context', () => {
    const title = document.createElement('span');
    document.body.appendChild(title);
    Object.defineProperties(title, { scrollWidth: { value: 80 }, clientWidth: { value: 80 } });

    feedback.showTooltip(title, 'A complete title');
    vi.advanceTimersByTime(200);
    expect(document.querySelector('.gv-tooltip.show')).toBeNull();

    feedback.showTooltip(title, 'Folder / Nested', true);
    vi.advanceTimersByTime(199);
    expect(document.querySelector('.gv-tooltip.show')).toBeNull();
    vi.advanceTimersByTime(1);
    expect(document.querySelector('.gv-tooltip.show')?.textContent).toBe('Folder / Nested');
  });

  it('cancels a pending tooltip when its anchor loses hover', () => {
    const title = document.createElement('span');
    feedback.showTooltip(title, 'Hidden title', true);
    feedback.hideTooltip();
    vi.advanceTimersByTime(1000);
    expect(document.querySelector('.gv-tooltip.show')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps warning messages visible while shorter action toasts finish their animation', () => {
    feedback.showNotification('Saved', 'success');
    feedback.showNotificationByLevel('Storage warning', 'warning');
    vi.advanceTimersByTime(10);
    expect(document.querySelector('.gv-notification-success.show')?.textContent).toBe('Saved');
    vi.advanceTimersByTime(2990);
    expect(document.querySelector('.gv-notification-success.show')).toBeNull();
    expect(document.body.textContent).toContain('Saved');
    vi.advanceTimersByTime(300);
    expect(document.body.textContent).not.toContain('Saved');
    expect(document.body.textContent).toContain('Storage warning');
    vi.advanceTimersByTime(3700);
    expect(document.body.textContent).not.toContain('Storage warning');
  });

  it('replaces batch progress and disposes every pending feedback surface on destruction', () => {
    feedback.showBatchDeleteProgress(1, 3);
    feedback.updateBatchDeleteProgress(2, 3);
    expect(document.querySelector('.gv-batch-delete-progress')?.textContent).toBe('Deleting 2/3');
    feedback.showBatchDeleteProgress(1, 4);
    expect(document.querySelectorAll('.gv-batch-delete-progress')).toHaveLength(1);
    feedback.showNotification('Pending');
    feedback.showDataLossNotification();
    feedback.showTooltip(document.createElement('span'), 'Pending title', true);

    feedback.destroy();
    expect(document.body.childElementCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    feedback.showNotification('Late completion');
    feedback.showBatchDeleteProgress(4, 4);
    vi.runAllTimers();
    expect(document.body.childElementCount).toBe(0);
  });
});
