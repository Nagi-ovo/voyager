import { type VoyagerBuildTarget, getVoyagerBuildTarget } from '@/core/utils/browser';
import { PLUGIN_ENGINE_VERSION } from '@/features/plugins/constants';
import type { PluginSettingValue, PluginSettings, SettingsSchema } from '@/features/plugins/types';

export const VOYAGER_DIAGNOSTICS_FORMAT = 'gemini-voyager.plugin-diagnostics.v1' as const;
export const VOYAGER_DIAGNOSTICS_FILENAME = 'voyager-diagnostics.json';

export type DiagnosticPluginSource =
  | 'builtin'
  | 'bundled-catalog'
  | 'host-catalog'
  | 'local'
  | 'marketplace'
  | 'unknown';

export type DiagnosticSite =
  | 'aistudio'
  | 'chatgpt'
  | 'claude'
  | 'custom'
  | 'deepseek'
  | 'gemini'
  | 'grok'
  | 'kimi'
  | 'midjourney'
  | 'notebooklm'
  | 'qwen'
  | 'unknown';

export interface DiagnosticPluginInput {
  enabled: boolean;
  id: string;
  source: DiagnosticPluginSource;
  version: string;
  settings?: PluginSettings;
  settingsSchema?: SettingsSchema;
}

export interface DiagnosticPlugin {
  enabled: boolean;
  id: string;
  source: DiagnosticPluginSource;
  version: string;
  settings: Record<string, PluginSettingValue | '<redacted>'>;
}

export interface VoyagerDiagnosticsPayload {
  format: typeof VOYAGER_DIAGNOSTICS_FORMAT;
  generatedAt: string;
  extension: {
    version: string;
    buildTarget: VoyagerBuildTarget;
  };
  environment: {
    browser: 'chrome' | 'edge' | 'firefox' | 'safari' | 'unknown';
    browserVersion: string | null;
    os: 'android' | 'chromeos' | 'ios' | 'linux' | 'macos' | 'windows' | 'unknown';
    activeSite: DiagnosticSite;
  };
  pluginEngine: {
    version: string;
  };
  plugins: {
    availableCount: number;
    items: DiagnosticPlugin[];
    redactedCount: number;
  };
  privacy: {
    redactedPluginSettingCount: number;
    omittedData: string[];
  };
}

export interface BuildVoyagerDiagnosticsOptions {
  activeUrl?: string;
  buildTarget?: VoyagerBuildTarget;
  extensionVersion?: string;
  now?: Date;
  platform?: string;
  plugins?: readonly DiagnosticPluginInput[];
  userAgent?: string;
}

export function diagnosticPluginSourceFromId(sourceId: string | undefined): DiagnosticPluginSource {
  switch (sourceId) {
    case 'builtin':
    case 'bundled-catalog':
    case 'host-catalog':
    case 'local':
    case 'marketplace':
      return sourceId;
    default:
      return 'unknown';
  }
}

const SENSITIVE_DIAGNOSTIC_TEXT_PATTERNS = [
  /https?:\/\//i,
  /(?:^|\s)[\w.+-]+@[\w.-]+\.[a-z]{2,}(?:\s|$)/i,
  /\/(?:Users|home)\/[^\s]+/i,
  /[a-z]:\\Users\\[^\s]+/i,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
  /\bBearer\s+\S+/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bAIza[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bya29\.[A-Za-z0-9_-]{20,}\b/,
];

function shouldRedactDiagnosticText(value: string): boolean {
  return (
    value.length > 256 || SENSITIVE_DIAGNOSTIC_TEXT_PATTERNS.some((pattern) => pattern.test(value))
  );
}

function sanitizeSettingValue(
  value: unknown,
  type: SettingsSchema[string]['type'],
  options: SettingsSchema[string]['options'],
): PluginSettingValue | '<redacted>' {
  if (type === 'boolean') return typeof value === 'boolean' ? value : '<redacted>';
  if (type === 'number') {
    return typeof value === 'number' && Number.isFinite(value) ? value : '<redacted>';
  }
  if (typeof value !== 'string' || shouldRedactDiagnosticText(value)) return '<redacted>';
  if (type === 'color' && !/^#[0-9a-f]{3,8}$/i.test(value)) return '<redacted>';
  if (type === 'select' && !options?.some((option) => option.value === value)) {
    return '<redacted>';
  }
  return value;
}

function sanitizePluginSettings(plugin: DiagnosticPluginInput): {
  settings: DiagnosticPlugin['settings'];
  redactedCount: number;
} {
  const settings: DiagnosticPlugin['settings'] = {};
  let redactedCount = 0;
  const schemaEntries = Object.entries(plugin.settingsSchema ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  for (const [key, field] of schemaEntries) {
    if (!/^[a-z][a-z0-9._-]{0,63}$/i.test(key) || shouldRedactDiagnosticText(key)) {
      redactedCount += 1;
      continue;
    }
    const currentValue = plugin.settings?.[key] ?? field.default;
    const value = sanitizeSettingValue(currentValue, field.type, field.options);
    settings[key] = value;
    if (value === '<redacted>') redactedCount += 1;
  }

  return { settings, redactedCount };
}

function summarizePlugins(
  value: readonly DiagnosticPluginInput[] | undefined,
): Pick<VoyagerDiagnosticsPayload, 'plugins' | 'privacy'> {
  const plugins = value ?? [];
  let redactedPluginSettingCount = 0;
  const safePlugins = plugins.flatMap((plugin): DiagnosticPlugin[] => {
    if (
      typeof plugin.enabled !== 'boolean' ||
      !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(plugin.id) ||
      shouldRedactDiagnosticText(plugin.id) ||
      !/^[a-z0-9][a-z0-9.+_-]{0,63}$/i.test(plugin.version)
    ) {
      return [];
    }
    const { settings, redactedCount } = sanitizePluginSettings(plugin);
    redactedPluginSettingCount += redactedCount;
    return [
      {
        id: plugin.id,
        version: plugin.version,
        source: diagnosticPluginSourceFromId(plugin.source),
        enabled: plugin.enabled,
        settings,
      },
    ];
  });
  const items = Array.from(new Map(safePlugins.map((plugin) => [plugin.id, plugin])).values())
    .slice(0, 100)
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    plugins: {
      availableCount: plugins.length,
      items,
      redactedCount: plugins.length - items.length,
    },
    privacy: {
      redactedPluginSettingCount,
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
  };
}

function detectBrowser(userAgent: string): VoyagerDiagnosticsPayload['environment']['browser'] {
  if (/\bEdg(?:A|iOS)?\//i.test(userAgent)) return 'edge';
  if (/\bFirefox\//i.test(userAgent) || /\bFxiOS\//i.test(userAgent)) return 'firefox';
  if (/\b(?:Chrome|CriOS)\//i.test(userAgent)) return 'chrome';
  if (/\bSafari\//i.test(userAgent) && /\bVersion\//i.test(userAgent)) return 'safari';
  return 'unknown';
}

function detectBrowserVersion(userAgent: string): string | null {
  const browser = detectBrowser(userAgent);
  const patterns: Record<typeof browser, RegExp | null> = {
    chrome: /\b(?:Chrome|CriOS)\/([\d.]+)/i,
    edge: /\bEdg(?:A|iOS)?\/([\d.]+)/i,
    firefox: /\b(?:Firefox|FxiOS)\/([\d.]+)/i,
    safari: /\bVersion\/([\d.]+)/i,
    unknown: null,
  };
  return patterns[browser]?.exec(userAgent)?.[1] ?? null;
}

function detectOperatingSystem(
  userAgent: string,
  platform: string,
): VoyagerDiagnosticsPayload['environment']['os'] {
  const source = `${userAgent} ${platform}`;
  if (/Android/i.test(source)) return 'android';
  if (/CrOS/i.test(source)) return 'chromeos';
  if (/iPhone|iPad|iPod/i.test(source)) return 'ios';
  if (/Windows/i.test(source)) return 'windows';
  if (/Macintosh|MacIntel|Mac OS X/i.test(source)) return 'macos';
  if (/Linux/i.test(source)) return 'linux';
  return 'unknown';
}

function resolveDiagnosticSite(activeUrl: string): DiagnosticSite {
  if (!activeUrl) return 'unknown';
  try {
    const url = new URL(activeUrl);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    if (hostname === 'gemini.google.com') return 'gemini';
    if (hostname === 'aistudio.google.com') return 'aistudio';
    if (hostname === 'chatgpt.com' || hostname === 'chat.openai.com') return 'chatgpt';
    if (hostname === 'claude.ai') return 'claude';
    if (hostname === 'deepseek.com' || hostname.endsWith('.deepseek.com')) return 'deepseek';
    if (hostname === 'qwen.ai' || hostname.endsWith('.qwen.ai')) return 'qwen';
    if (hostname === 'kimi.com' || hostname.endsWith('.kimi.com')) return 'kimi';
    if (hostname === 'notebooklm.google.com') return 'notebooklm';
    if (hostname === 'midjourney.com' || hostname.endsWith('.midjourney.com')) {
      return 'midjourney';
    }
    if (hostname === 'grok.com' || (hostname === 'x.com' && url.pathname.startsWith('/i/grok'))) {
      return 'grok';
    }
    return url.protocol === 'http:' || url.protocol === 'https:' ? 'custom' : 'unknown';
  } catch {
    return 'unknown';
  }
}

function getExtensionVersion(): string {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return 'unknown';
  }
}

export function buildVoyagerDiagnostics(
  options: BuildVoyagerDiagnosticsOptions = {},
): VoyagerDiagnosticsPayload {
  const userAgent =
    options.userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent);
  const platform = options.platform ?? (typeof navigator === 'undefined' ? '' : navigator.platform);
  const { plugins, privacy } = summarizePlugins(options.plugins);

  return {
    format: VOYAGER_DIAGNOSTICS_FORMAT,
    generatedAt: (options.now ?? new Date()).toISOString(),
    extension: {
      version: options.extensionVersion ?? getExtensionVersion(),
      buildTarget: options.buildTarget ?? getVoyagerBuildTarget(),
    },
    environment: {
      browser: detectBrowser(userAgent),
      browserVersion: detectBrowserVersion(userAgent),
      os: detectOperatingSystem(userAgent, platform),
      activeSite: resolveDiagnosticSite(options.activeUrl ?? ''),
    },
    pluginEngine: { version: PLUGIN_ENGINE_VERSION },
    plugins,
    privacy,
  };
}

export function serializeVoyagerDiagnostics(payload: VoyagerDiagnosticsPayload): string {
  return JSON.stringify(payload, null, 2);
}

export function formatVoyagerDiagnosticsMarkdown(payload: VoyagerDiagnosticsPayload): string {
  return `### Voyager diagnostics\n\n\`\`\`json\n${serializeVoyagerDiagnostics(payload)}\n\`\`\``;
}

export async function copyVoyagerDiagnosticsMarkdown(
  payload: VoyagerDiagnosticsPayload,
): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
  await navigator.clipboard.writeText(formatVoyagerDiagnosticsMarkdown(payload));
}

export function downloadVoyagerDiagnostics(payload: VoyagerDiagnosticsPayload): void {
  const blob = new Blob([serializeVoyagerDiagnostics(payload)], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = VOYAGER_DIAGNOSTICS_FILENAME;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
