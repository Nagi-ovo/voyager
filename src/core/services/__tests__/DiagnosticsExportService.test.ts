import { afterEach, describe, expect, it, vi } from 'vitest';

import { PLUGIN_ENGINE_VERSION } from '@/features/plugins/constants';

import {
  VOYAGER_DIAGNOSTICS_FILENAME,
  type VoyagerDiagnosticsPayload,
  buildVoyagerDiagnostics,
  copyVoyagerDiagnosticsMarkdown,
  diagnosticPluginSourceFromId,
  downloadVoyagerDiagnostics,
  formatVoyagerDiagnosticsMarkdown,
  serializeVoyagerDiagnostics,
} from '../DiagnosticsExportService';

function fixturePayload(): VoyagerDiagnosticsPayload {
  return {
    format: 'gemini-voyager.plugin-diagnostics.v1',
    generatedAt: '2026-07-29T12:00:00.000Z',
    extension: { version: '1.6.0', buildTarget: 'chrome' },
    environment: {
      browser: 'chrome',
      browserVersion: '150.0.0.0',
      os: 'macos',
      activeSite: 'claude',
    },
    pluginEngine: { version: PLUGIN_ENGINE_VERSION },
    plugins: { availableCount: 0, items: [], redactedCount: 0 },
    privacy: { redactedPluginSettingCount: 0, omittedData: [] },
  };
}

describe('DiagnosticsExportService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds a stable plugin diagnostics schema with declared settings only', () => {
    const payload = buildVoyagerDiagnostics({
      activeUrl: 'https://claude.ai/chat/private-conversation-id',
      buildTarget: 'chrome',
      extensionVersion: '1.6.0',
      now: new Date('2026-07-29T12:00:00.000Z'),
      platform: 'MacIntel',
      plugins: [
        {
          id: 'voyager.z-plugin',
          version: '2.0.0',
          source: 'marketplace',
          enabled: false,
        },
        {
          id: 'voyager.a-plugin',
          version: '1.2.3',
          source: 'bundled-catalog',
          enabled: true,
          settingsSchema: {
            width: { type: 'number', label: 'Width', default: 80 },
            compact: { type: 'boolean', label: 'Compact', default: false },
          },
          settings: { width: 92, undeclaredSecret: 'must-not-export' },
        },
      ],
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/150.0.7871.184 Safari/537.36',
    });

    expect(payload).toEqual({
      format: 'gemini-voyager.plugin-diagnostics.v1',
      generatedAt: '2026-07-29T12:00:00.000Z',
      extension: { version: '1.6.0', buildTarget: 'chrome' },
      environment: {
        browser: 'chrome',
        browserVersion: '150.0.7871.184',
        os: 'macos',
        activeSite: 'claude',
      },
      pluginEngine: { version: PLUGIN_ENGINE_VERSION },
      plugins: {
        availableCount: 2,
        items: [
          {
            id: 'voyager.a-plugin',
            version: '1.2.3',
            source: 'bundled-catalog',
            enabled: true,
            settings: { compact: false, width: 92 },
          },
          {
            id: 'voyager.z-plugin',
            version: '2.0.0',
            source: 'marketplace',
            enabled: false,
            settings: {},
          },
        ],
        redactedCount: 0,
      },
      privacy: {
        redactedPluginSettingCount: 0,
        omittedData: [
          'account-identifiers',
          'authentication-credentials',
          'conversation-content-and-urls',
          'folder-content',
          'private-marketplace-urls',
          'prompt-content',
          'undeclared-plugin-settings',
          'usage-caches',
        ],
      },
    });
    expect(serializeVoyagerDiagnostics(payload)).not.toContain('must-not-export');
    expect(serializeVoyagerDiagnostics(payload)).not.toContain('private-conversation-id');
  });

  it('redacts sensitive declared values and unsafe plugin metadata', () => {
    const privateToken = `sk-${'a'.repeat(32)}`;
    const payload = buildVoyagerDiagnostics({
      activeUrl: 'https://private.example.com/secret/path',
      plugins: [
        {
          id: 'voyager.safe',
          version: '1.0.0',
          source: 'local',
          enabled: true,
          settingsSchema: {
            token: { type: 'string', label: 'Token', default: '' },
            theme: {
              type: 'select',
              label: 'Theme',
              default: 'light',
              options: [
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ],
            },
          },
          settings: { token: privateToken, theme: 'private-choice' },
        },
        {
          id: 'person@example.com',
          version: 'secret',
          source: 'marketplace',
          enabled: true,
        },
      ],
    });

    expect(payload.environment.activeSite).toBe('custom');
    expect(payload.plugins).toEqual({
      availableCount: 2,
      items: [
        {
          id: 'voyager.safe',
          version: '1.0.0',
          source: 'local',
          enabled: true,
          settings: { theme: '<redacted>', token: '<redacted>' },
        },
      ],
      redactedCount: 1,
    });
    expect(payload.privacy.redactedPluginSettingCount).toBe(2);
    const serialized = serializeVoyagerDiagnostics(payload);
    expect(serialized).not.toContain(privateToken);
    expect(serialized).not.toContain('person@example.com');
    expect(serialized).not.toContain('private.example.com');
  });

  it('normalizes source identifiers without exposing arbitrary source data', () => {
    expect(diagnosticPluginSourceFromId('builtin')).toBe('builtin');
    expect(diagnosticPluginSourceFromId('marketplace')).toBe('marketplace');
    expect(diagnosticPluginSourceFromId('https://private.example/catalog.json')).toBe('unknown');
  });

  it('formats and copies GitHub-ready Markdown', async () => {
    const payload = fixturePayload();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    await copyVoyagerDiagnosticsMarkdown(payload);

    const markdown = formatVoyagerDiagnosticsMarkdown(payload);
    expect(markdown).toMatch(/^### Voyager diagnostics\n\n```json\n/);
    expect(markdown).toContain('"format": "gemini-voyager.plugin-diagnostics.v1"');
    expect(markdown).toMatch(/\n```$/);
    expect(writeText).toHaveBeenCalledWith(markdown);
  });

  it('downloads JSON with the stable diagnostics filename', () => {
    const createObjectURL = vi.fn().mockReturnValue('blob:diagnostics');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    downloadVoyagerDiagnostics(fixturePayload());

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect((click.mock.instances[0] as HTMLAnchorElement).download).toBe(
      VOYAGER_DIAGNOSTICS_FILENAME,
    );
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:diagnostics');
  });
});
