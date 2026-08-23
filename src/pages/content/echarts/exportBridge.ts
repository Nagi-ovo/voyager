export interface EChartsDataUrlResult {
  handled: boolean;
  dataUrl: string | null;
}

const dataUrlProviders = new WeakMap<HTMLElement, () => string | null>();

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

/** Register the synchronous bridge used by export without coupling it to ECharts. */
export const provideEChartsDataUrl = (
  container: HTMLElement,
  getDataUrl: () => string | null,
): (() => void) => {
  dataUrlProviders.set(container, getDataUrl);
  return () => {
    if (dataUrlProviders.get(container) === getDataUrl) dataUrlProviders.delete(container);
  };
};
