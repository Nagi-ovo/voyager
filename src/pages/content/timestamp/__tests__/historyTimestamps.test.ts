import { afterEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import {
  HistoryTimestampStore,
  extractHistoryTurnIdentities,
  extractHistoryTurns,
  normalizeTurnText,
} from '../historyTimestamps';

const CID = 'c_26dfc929fd75fe3d';
const NATIVE_ID = '26dfc929fd75fe3d';
const localGetMock = chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>;
const localSetMock = chrome.storage.local.set as unknown as ReturnType<typeof vi.fn>;

/**
 * A turn mirroring the hNvQHb payload shape captured from a real
 * conversation load (2026-07): ids tuple, query wrap at [2][0][0], model
 * response candidates, metadata, and the `[seconds, nanos]` pair as a direct
 * child near the end.
 */
function makeTurn(
  userText: string,
  epochSec: number,
  nanos = 261_574_000,
  cid = CID,
  responseId = `r_${epochSec.toString(16).padStart(16, '0')}`,
): unknown[] {
  return [
    [cid, responseId],
    [cid, 'r_a23872877afd8022', 'rc_27a9438ecdf0a13d'],
    [[userText, null, null, null, [[]]], 2, null, 1, '56fdd199312815e2', null, null, null, false],
    [[['rc_b2d1629d6a044d8a', ['model answer text'], null, null, null, null, null, [2], 'zh']]],
    [null, null, null, null, null, null, null, null, null, '3.5 Flash Extended', null, null, 1, 2],
    [epochSec, nanos],
  ];
}

/** Wrap turns into the response envelope the observer bridges over. */
function makeEnvelope(turns: unknown[][]): string {
  const payload = JSON.stringify([turns, null, null, null]);
  const rows = JSON.stringify([
    ['wrb.fr', 'hNvQHb', payload, null, null, null, 'generic'],
    ['di', 265],
    ['af.httprm', 264, '-1206762670527833069', 51],
  ]);
  return `)]}'\n\n${rows.length}\n${rows}\n25\n[["e",4,null,null,226]]\n`;
}

let captureSequence = 0;

function postCapture(body: string, id = `test-capture:${++captureSequence}`): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { source: 'gv-history-observer', type: 'capture', payload: { id, body } },
      origin: window.location.origin,
      source: window as unknown as MessageEventSource,
    }),
  );
}

describe('extractHistoryTurns', () => {
  it('extracts per-turn timestamps from a conversation payload', () => {
    const payload = JSON.parse(
      JSON.stringify([
        [makeTurn('第一个问题', 1_783_370_737), makeTurn('第二个问题', 1_783_370_831)],
      ]),
    );
    const byCid = extractHistoryTurns(payload);

    expect(byCid.size).toBe(1);
    const turns = byCid.get(CID);
    expect(turns).toHaveLength(2);
    expect(turns?.[0]).toEqual({
      turnId: 's-000000006a4c13f1',
      userText: '第一个问题',
      timestampMs: 1_783_370_737_262,
    });
    expect(turns?.[1]).toEqual({
      turnId: 's-000000006a4c144f',
      userText: '第二个问题',
      timestampMs: 1_783_370_831_262,
    });
  });

  it('collapses whitespace in user text', () => {
    const byCid = extractHistoryTurns([[makeTurn('line one\n\n  line two', 1_783_370_737)]]);
    expect(byCid.get(CID)?.[0].userText).toBe('line one line two');
  });

  it('returns empty for non-array payloads', () => {
    expect(extractHistoryTurns(null).size).toBe(0);
    expect(extractHistoryTurns('x').size).toBe(0);
    expect(extractHistoryTurns([1, 2]).size).toBe(0);
  });

  it('skips turns without a plausible timestamp pair', () => {
    const turn = makeTurn('问题', 1_783_370_737);
    turn.pop(); // drop the [sec, nanos] pair
    expect(extractHistoryTurns([[turn]]).size).toBe(0);
  });

  it('skips turns without user text', () => {
    const turn = makeTurn('问题', 1_783_370_737);
    turn[2] = [[null], 2, null, 1];
    expect(extractHistoryTurns([[turn]]).size).toBe(0);
  });

  it('keeps ids in the ordered identity list when optional fields are missing', () => {
    const first = makeTurn('第一个问题', 1_783_370_737);
    const second = makeTurn('第二个问题', 1_783_370_831);
    first[2] = [[null], 2, null, 1];
    second.pop();

    expect(extractHistoryTurnIdentities([[first, second]]).get(CID)).toEqual([
      {
        turnId: 's-000000006a4c13f1',
        userText: null,
        timestampMs: 1_783_370_737_262,
      },
      {
        turnId: 's-000000006a4c144f',
        userText: '第二个问题',
        timestampMs: null,
      },
    ]);
  });

  it('rejects timestamp-shaped pairs outside the epoch sanity window', () => {
    // e.g. the [2] flag arrays and [1, 2] metadata must not be read as times
    const turn = makeTurn('问题', 1_783_370_737);
    turn[turn.length - 1] = [12345, 42];
    expect(extractHistoryTurns([[turn]]).size).toBe(0);
  });
});

describe('normalizeTurnText', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeTurnText('  a\n\tb  c ')).toBe('a b c');
  });
});

describe('HistoryTimestampStore', () => {
  let store: HistoryTimestampStore | null = null;

  afterEach(() => {
    store?.stop();
    store = null;
    localGetMock.mockReset();
    localSetMock.mockReset();
  });

  it('ingests bridged captures and exposes turns by native conversation id', () => {
    store = new HistoryTimestampStore();
    const onUpdate = vi.fn();
    void store.start();
    store.subscribe(onUpdate);

    postCapture(makeEnvelope([makeTurn('第一个问题', 1_783_370_737)]));

    expect(onUpdate).toHaveBeenCalledWith([CID]);
    expect(store.getTurns(NATIVE_ID)).toEqual([
      {
        turnId: 's-000000006a4c13f1',
        userText: '第一个问题',
        timestampMs: 1_783_370_737_262,
      },
    ]);
    expect(store.getLatestTurnTimestamp(NATIVE_ID)).toBe(1_783_370_737_262);
    expect(store.getTurns('unknown')).toBeNull();
    expect(store.getLatestTurnTimestamp('unknown')).toBeNull();
  });

  it('merges later captures and dedupes repeats without re-notifying', () => {
    store = new HistoryTimestampStore();
    const onUpdate = vi.fn();
    void store.start();
    store.subscribe(onUpdate);

    const body = makeEnvelope([makeTurn('第一个问题', 1_783_370_737)]);
    expect(store.getRevision(NATIVE_ID)).toBe(0);

    postCapture(body, 'capture-a');
    const firstRevision = store.getRevision(NATIVE_ID);
    expect(firstRevision).toBeGreaterThan(0);

    postCapture(
      makeEnvelope([makeTurn('这个响应使用了重复 ID，不应再次解析', 1_783_370_800)]),
      'capture-a',
    );
    postCapture(body, 'capture-a-repeat');
    expect(store.getRevision(NATIVE_ID)).toBe(firstRevision);

    postCapture(makeEnvelope([makeTurn('第二个问题', 1_783_370_831)]));

    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(store.getTurns(NATIVE_ID)).toHaveLength(2);
    expect(store.getRevision(NATIVE_ID)).toBeGreaterThan(firstRevision);
  });

  it('ignores foreign messages and malformed bodies', () => {
    store = new HistoryTimestampStore();
    const onUpdate = vi.fn();
    void store.start();
    store.subscribe(onUpdate);

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: 'someone-else', type: 'capture', payload: { body: 'x' } },
        origin: window.location.origin,
        source: window as unknown as MessageEventSource,
      }),
    );
    postCapture('not a batchexecute response');
    postCapture(')]}\'\n\n10\n[["wrb.fr","hNvQHb","not json",null,null,null,"generic"]]');

    expect(onUpdate).not.toHaveBeenCalled();
    expect(store.getTurns(NATIVE_ID)).toBeNull();
  });

  it('stops listening after dispose', () => {
    store = new HistoryTimestampStore();
    const onUpdate = vi.fn();
    void store.start();
    store.subscribe(onUpdate);
    store.stop();

    postCapture(makeEnvelope([makeTurn('第一个问题', 1_783_370_737)]));
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('keeps parsed data across UI subscriber replacement', () => {
    store = new HistoryTimestampStore();
    void store.start();
    const firstSubscriber = vi.fn();
    const unsubscribe = store.subscribe(firstSubscriber);

    postCapture(makeEnvelope([makeTurn('第一个问题', 1_783_370_737)]), 'capture-a');
    unsubscribe();

    const secondSubscriber = vi.fn();
    store.subscribe(secondSubscriber);
    expect(store.getTurns(NATIVE_ID)).toEqual([
      {
        turnId: 's-000000006a4c13f1',
        userText: '第一个问题',
        timestampMs: 1_783_370_737_262,
      },
    ]);

    postCapture(makeEnvelope([makeTurn('第二个问题', 1_783_370_831)]), 'capture-b');
    expect(firstSubscriber).toHaveBeenCalledTimes(1);
    expect(secondSubscriber).toHaveBeenCalledWith([CID]);
  });

  it('captures identity even when the legacy timestamp argument is false', () => {
    store = new HistoryTimestampStore();
    const postMessage = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
    const onUpdate = vi.fn();
    void store.start(false);
    store.subscribe(onUpdate);
    postMessage.mockClear();

    postCapture(makeEnvelope([makeTurn('仍应解析身份', 1_783_370_737)]), 'disabled-capture');

    expect(onUpdate).toHaveBeenCalledWith([CID]);
    expect(store.resolveCanonicalTurnId(NATIVE_ID, 'u-0')).toBe('s-000000006a4c13f1');
    expect(postMessage).toHaveBeenCalledWith(
      {
        source: 'gv-history-observer-cmd',
        type: 'ack',
        payload: { id: 'disabled-capture' },
      },
      window.location.origin,
    );
  });

  it('starts idempotently and ignores timestamp-toggle changes', () => {
    store = new HistoryTimestampStore();
    const addEventListener = vi.spyOn(window, 'addEventListener');
    void store.start();
    void store.start();

    const messageRegistrations = addEventListener.mock.calls.filter(([type]) => type === 'message');
    expect(messageRegistrations).toHaveLength(1);

    postCapture(makeEnvelope([makeTurn('第一个问题', 1_783_370_737)]), 'capture-a');
    expect(store.getTurns(NATIVE_ID)).not.toBeNull();
    const firstRevision = store.getRevision(NATIVE_ID);
    expect(firstRevision).toBeGreaterThan(0);

    store.setEnabled(false);
    expect(store.getTurns(NATIVE_ID)).not.toBeNull();
    expect(store.getRevision(NATIVE_ID)).toBe(firstRevision);
    expect(store.resolveCanonicalTurnId(NATIVE_ID, 'u-0')).toBe('s-000000006a4c13f1');
  });

  it('maps legacy positions through the complete server ordering, not a mounted tail', () => {
    store = new HistoryTimestampStore();
    void store.start();
    postCapture(
      makeEnvelope([
        makeTurn('first', 1_783_370_737),
        makeTurn('middle', 1_783_370_831),
        makeTurn('mounted tail', 1_783_370_900),
      ]),
      'full-ordering',
    );

    expect(store.getTurnIdAliases(NATIVE_ID, 's-000000006a4c1494')).toEqual([
      's-000000006a4c1494',
      'u-2',
    ]);
    expect(store.resolveCanonicalTurnId(NATIVE_ID, 'u-0')).toBe('s-000000006a4c13f1');
    expect(store.resolveCanonicalTurnId(NATIVE_ID, 'u-2')).toBe('s-000000006a4c1494');
    expect(store.resolveCanonicalTurnId(NATIVE_ID, 'u-3')).toBeNull();
  });

  it('hydrates the ordered aliases after a hard reload without a new hNvQHb response', async () => {
    const cached = {
      version: 1,
      conversations: {
        [CID]: {
          turnIds: ['s-1111111111111111', 's-2222222222222222'],
          updatedAt: 123,
        },
      },
    };
    localGetMock.mockResolvedValue({
      [StorageKeys.GV_TURN_IDENTITY_CACHE]: cached,
    });

    store = new HistoryTimestampStore();
    await store.start();

    expect(store.hasTurnIdentityMap(NATIVE_ID)).toBe(true);
    expect(store.resolveCanonicalTurnId(NATIVE_ID, 'u-0')).toBe('s-1111111111111111');
    expect(store.getTurnIdAliases(NATIVE_ID, 's-2222222222222222')).toEqual([
      's-2222222222222222',
      'u-1',
    ]);
  });

  it('persists only bounded response ids, never prompt text or response bodies', async () => {
    localGetMock.mockResolvedValue({});
    store = new HistoryTimestampStore();
    await store.start();

    postCapture(makeEnvelope([makeTurn('private prompt text', 1_783_370_737)]), 'persist-ids');
    await vi.waitFor(() => expect(chrome.storage.local.set).toHaveBeenCalled());

    const write = localSetMock.mock.calls.at(-1)?.[0];
    const serialized = JSON.stringify(write);
    expect(serialized).toContain('s-000000006a4c13f1');
    expect(serialized).not.toContain('private prompt text');
    expect(serialized).not.toContain('model answer text');
  });

  it('merges a live capture with other conversations still loading from cache', async () => {
    let resolveCache!: (value: Record<string, unknown>) => void;
    localGetMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCache = resolve;
        }),
    );
    store = new HistoryTimestampStore();
    const ready = store.start();

    postCapture(makeEnvelope([makeTurn('live conversation', 1_783_370_737)]), 'live-before-cache');
    expect(chrome.storage.local.set).not.toHaveBeenCalled();

    resolveCache({
      [StorageKeys.GV_TURN_IDENTITY_CACHE]: {
        version: 1,
        conversations: {
          c_aaaaaaaaaaaaaaaa: {
            turnIds: ['s-aaaaaaaaaaaaaaaa'],
            updatedAt: 100,
          },
        },
      },
    });
    await ready;
    await vi.waitFor(() => expect(chrome.storage.local.set).toHaveBeenCalled());

    const write = localSetMock.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
    const conversations = (
      write?.[StorageKeys.GV_TURN_IDENTITY_CACHE] as {
        conversations?: Record<string, unknown>;
      }
    )?.conversations;
    expect(Object.keys(conversations ?? {}).sort()).toEqual([CID, 'c_aaaaaaaaaaaaaaaa'].sort());
  });

  it('bounds parsed conversation history with an LRU', () => {
    store = new HistoryTimestampStore();
    void store.start();

    for (let index = 0; index < 17; index++) {
      const cid = `c_${String(index).padStart(16, '0')}`;
      postCapture(
        makeEnvelope([makeTurn(`问题 ${index}`, 1_783_370_737 + index, 0, cid)]),
        `capture-${index}`,
      );
    }

    expect(store.getTurns('0000000000000000')).toBeNull();
    expect(store.getRevision('0000000000000000')).toBe(0);
    expect(store.getTurns('0000000000000016')).toEqual([
      {
        turnId: 's-000000006a4c1401',
        userText: '问题 16',
        timestampMs: 1_783_370_753_000,
      },
    ]);
    expect(store.getRevision('0000000000000016')).toBeGreaterThan(0);
  });
});
