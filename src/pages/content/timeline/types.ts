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
