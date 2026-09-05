export type DotElement = HTMLButtonElement & {
  dataset: DOMStringMap & {
    targetTurnId?: string;
    markerIndex?: string;
  };
};

export type MarkerLevel = 1 | 2 | 3;

export interface PreviewMarkerData {
  readonly id: string;
  readonly summary: string;
  readonly index: number;
  readonly starred: boolean;
}

/** A mounted turn; timeline DOM belongs to TimelineView. */
export interface TimelineMarker {
  id: string;
  element: HTMLElement;
  summary: string;
  assistantSummary: string;
  baseN: number;
  starred: boolean;
}

export type SyncSettingsListener = (
  changes: Record<string, { newValue: unknown }>,
  area: string,
) => void;

export type ExtGlobal = typeof globalThis & {
  chrome?: {
    storage?: {
      sync?: {
        get(k: Record<string, unknown>, cb: (items: Record<string, unknown>) => void): void;
        set?(items: Record<string, unknown>): void;
      };
      onChanged?: {
        addListener(cb: SyncSettingsListener): void;
        removeListener?(cb: SyncSettingsListener): void;
      };
    };
    runtime?: { lastError?: { message: string } };
  };
  browser?: {
    storage?: {
      sync?: {
        get(k: Record<string, unknown>): Promise<Record<string, unknown>>;
        set?(items: Record<string, unknown>): void;
      };
      onChanged?: {
        addListener(cb: SyncSettingsListener): void;
        removeListener?(cb: SyncSettingsListener): void;
      };
    };
  };
};

export interface TimelinePositionData {
  version?: number;
  topPercent?: number;
  leftPercent?: number;
  top?: number;
  left?: number;
}
