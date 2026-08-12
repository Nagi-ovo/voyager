import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isPersistentExportToolbarMounted,
  mountPersistentExportToolbar,
} from '../persistentExportToolbar';

afterEach(() => {
  document.querySelectorAll('.gv-persistent-export-toolbar').forEach((n) => n.remove());
  document.body
    .querySelectorAll('[data-test-id="upgrade-button"], top-bar-actions')
    .forEach((n) => n.remove());
  vi.restoreAllMocks();
});

function mockRect(element: Element, rect: Partial<DOMRect>): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: rect.left ?? 0,
      y: rect.top ?? 0,
      top: rect.top ?? 0,
      left: rect.left ?? 0,
      right: rect.right ?? 0,
      bottom: rect.bottom ?? 0,
      width: rect.width ?? 0,
      height: rect.height ?? 0,
      toJSON: () => ({}),
    }),
  });
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

describe('persistentExportToolbar', () => {
  it('mounts a top-right export button with label and tooltip', () => {
    const onClick = vi.fn();
    const handle = mountPersistentExportToolbar({
      label: 'Export',
      tooltip: 'Export chat history',
      onClick,
    });
    expect(isPersistentExportToolbarMounted()).toBe(true);
    expect(handle.root.classList.contains('gv-persistent-export-toolbar')).toBe(true);
    expect(handle.button.getAttribute('aria-label')).toBe('Export chat history');
    expect(handle.button.title).toBe('Export chat history');
    expect(handle.button.textContent).toContain('Export');
  });

  it('invokes onClick when the button is clicked', () => {
    const onClick = vi.fn();
    const handle = mountPersistentExportToolbar({
      label: 'Export',
      tooltip: 'Export chat history',
      onClick,
    });
    handle.button.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate-mount; second call updates text on existing instance', () => {
    const firstClick = vi.fn();
    const secondClick = vi.fn();
    const first = mountPersistentExportToolbar({
      label: 'Export',
      tooltip: 'Export chat history',
      onClick: firstClick,
    });
    const second = mountPersistentExportToolbar({
      label: '导出',
      tooltip: '导出对话历史',
      onClick: secondClick,
    });
    expect(document.querySelectorAll('.gv-persistent-export-toolbar').length).toBe(1);
    expect(second.root).toBe(first.root);
    expect(first.button.getAttribute('aria-label')).toBe('导出对话历史');
    expect(first.button.textContent).toContain('导出');
    second.button.click();
    expect(firstClick).not.toHaveBeenCalled();
    expect(secondClick).toHaveBeenCalledOnce();

    first.remove();
    expect(isPersistentExportToolbarMounted()).toBe(true);
    second.remove();
    expect(isPersistentExportToolbarMounted()).toBe(false);
  });

  it('keeps ChatGPT toolbar avoidance and dark-mode styles', () => {
    const css = readFileSync(resolve(process.cwd(), 'public/contentStyle.css'), 'utf8');
    const platformRule = css.match(
      /\.gv-persistent-export-toolbar\[data-gv-platform='chatgpt'\]\s*\{([^}]*)\}/,
    )?.[1];

    expect(platformRule).toContain('top: 50px');
    expect(platformRule).not.toContain('right:');
    expect(css).toContain('html.dark .gv-persistent-export-btn,');
    expect(css).toContain('html.dark .gv-persistent-export-btn:hover,');
  });

  it('setText updates label/tooltip after language change', () => {
    const handle = mountPersistentExportToolbar({
      label: 'Export',
      tooltip: 'Export chat history',
      onClick: vi.fn(),
    });
    handle.setText('Exporter', 'Exporter la conversation');
    expect(handle.button.title).toBe('Exporter la conversation');
    expect(handle.button.getAttribute('aria-label')).toBe('Exporter la conversation');
    expect(handle.button.textContent).toContain('Exporter');
  });

  it('keeps the default right offset when no top-right controls are present', async () => {
    const handle = mountPersistentExportToolbar({
      label: 'Export',
      tooltip: 'Export chat history',
      onClick: vi.fn(),
    });

    await nextFrame();

    expect(handle.root.style.getPropertyValue('--gv-persistent-export-right')).toBe('84px');
  });

  it('moves left to avoid Gemini top-right upgrade controls', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1280);
    const upgradeButton = document.createElement('button');
    upgradeButton.setAttribute('data-test-id', 'upgrade-button');
    mockRect(upgradeButton, {
      top: 8,
      bottom: 44,
      left: 960,
      right: 1130,
      width: 170,
      height: 36,
    });
    document.body.appendChild(upgradeButton);

    const handle = mountPersistentExportToolbar({
      label: 'Export',
      tooltip: 'Export chat history',
      onClick: vi.fn(),
    });

    await nextFrame();

    expect(handle.root.style.getPropertyValue('--gv-persistent-export-right')).toBe('332px');
  });

  it('updates avoidance when Gemini renders top-right controls after mount', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1280);
    const handle = mountPersistentExportToolbar({
      label: 'Export',
      tooltip: 'Export chat history',
      onClick: vi.fn(),
    });
    await nextFrame();
    expect(handle.root.style.getPropertyValue('--gv-persistent-export-right')).toBe('84px');

    const topBarActions = document.createElement('top-bar-actions');
    mockRect(topBarActions, {
      top: 0,
      bottom: 56,
      left: 920,
      right: 1260,
      width: 340,
      height: 56,
    });
    document.body.appendChild(topBarActions);
    await Promise.resolve();
    await nextFrame();

    expect(handle.root.style.getPropertyValue('--gv-persistent-export-right')).toBe('372px');
  });

  it('ignores full-width top-bar containers so the toolbar stays top-right', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1280);
    const topBarActions = document.createElement('top-bar-actions');
    mockRect(topBarActions, {
      top: 0,
      bottom: 56,
      left: 0,
      right: 1280,
      width: 1280,
      height: 56,
    });
    document.body.appendChild(topBarActions);

    const handle = mountPersistentExportToolbar({
      label: 'Export',
      tooltip: 'Export chat history',
      onClick: vi.fn(),
    });

    await nextFrame();

    expect(handle.root.style.getPropertyValue('--gv-persistent-export-right')).toBe('84px');
  });
});
