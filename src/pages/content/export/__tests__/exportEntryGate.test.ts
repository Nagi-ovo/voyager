import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startExportEntryGate } from '../exportEntryGate';

describe('startExportEntryGate', () => {
  let eligible: boolean;
  let routeListener: (() => void) | null;
  const mount = vi.fn();
  const unmount = vi.fn();
  const stopRouteWatch = vi.fn();
  const watchRoute = (listener: () => void): (() => void) => {
    routeListener = listener;
    return stopRouteWatch;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    eligible = false;
    routeListener = null;
    mount.mockClear();
    unmount.mockClear();
    stopRouteWatch.mockClear();
    document.body.innerHTML = '';
  });

  let stopGate: (() => void) | null = null;

  afterEach(() => {
    // A gate left running would keep observing document.body into the next test.
    stopGate?.();
    stopGate = null;
    vi.useRealTimers();
  });

  const start = (): (() => void) => {
    stopGate = startExportEntryGate({
      isEligible: () => eligible,
      mount,
      unmount,
      watchRoute,
      root: document.body,
      settleMs: 50,
    });
    return stopGate;
  };

  it('mounts only once the route reaches a conversation and unmounts when it leaves', () => {
    const stop = start();
    expect(mount).not.toHaveBeenCalled();

    eligible = true;
    routeListener?.();
    expect(mount).toHaveBeenCalledTimes(1);
    // A second notification while still eligible does not remount.
    routeListener?.();
    expect(mount).toHaveBeenCalledTimes(1);

    eligible = false;
    routeListener?.();
    expect(unmount).toHaveBeenCalledTimes(1);
    stop();
    expect(unmount).toHaveBeenCalledTimes(1);
    expect(stopRouteWatch).toHaveBeenCalledTimes(1);
  });

  it('notices a conversation that renders without a route change', async () => {
    start();
    eligible = true;
    document.body.appendChild(document.createElement('div'));
    document.body.appendChild(document.createElement('div'));
    await vi.advanceTimersByTimeAsync(0);
    expect(mount).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60);
    // One settle window per burst of mutations.
    expect(mount).toHaveBeenCalledTimes(1);
  });

  it('unmounts whatever is mounted on teardown and ignores later signals', async () => {
    eligible = true;
    const stop = start();
    expect(mount).toHaveBeenCalledTimes(1);
    stop();
    expect(unmount).toHaveBeenCalledTimes(1);

    eligible = false;
    routeListener?.();
    document.body.appendChild(document.createElement('div'));
    await vi.advanceTimersByTimeAsync(100);
    expect(unmount).toHaveBeenCalledTimes(1);
    expect(mount).toHaveBeenCalledTimes(1);
  });
});
