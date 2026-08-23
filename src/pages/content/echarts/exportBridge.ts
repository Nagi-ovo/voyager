export interface EChartsDataUrlResult {
  handled: boolean;
  dataUrl: string | null;
}

const dataUrlProviders = new WeakMap<HTMLElement, () => string | null>();
const ownerContainers = new WeakMap<HTMLElement, HTMLElement>();

/** Request a composited PNG from the live ECharts instance, when available. */
export const requestEChartsDataUrl = (container: HTMLElement): EChartsDataUrlResult => {
  const provider = dataUrlProviders.get(container);
  if (!provider) return { handled: false, dataUrl: null };
  try {
    return { handled: true, dataUrl: provider() };
  } catch {
    return { handled: true, dataUrl: null };
  }
};

/** Resolve a chart container even while fullscreen has moved it outside its wrapper. */
export const resolveEChartsExportContainer = (owner: HTMLElement): HTMLElement | null =>
  ownerContainers.get(owner) ??
  (owner.matches('.gv-echarts-diagram')
    ? owner
    : owner.querySelector<HTMLElement>('.gv-echarts-diagram'));

/** Register the synchronous bridge used by export without coupling it to ECharts. */
export const provideEChartsDataUrl = (
  container: HTMLElement,
  getDataUrl: () => string | null,
  owner: HTMLElement = container,
): (() => void) => {
  dataUrlProviders.set(container, getDataUrl);
  ownerContainers.set(owner, container);
  return () => {
    if (dataUrlProviders.get(container) === getDataUrl) dataUrlProviders.delete(container);
    if (ownerContainers.get(owner) === container) ownerContainers.delete(owner);
  };
};
