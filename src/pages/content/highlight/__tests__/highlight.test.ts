import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { accountIsolationService } from '@/core/services/AccountIsolationService';
import type {
  HighlightAccountScope,
  HighlightCreateInput,
  HighlightRecordV1,
  HighlightUpdatePatch,
} from '@/core/types/highlight';
import { isHighlightColor, normalizeHighlightColorPalette } from '@/core/types/highlight';

import { historyTimestampStore } from '../../timestamp/historyTimestamps';
import { buildHighlightAnchor, resolveHighlightAnchor } from '../anchor';
import { HighlightClient } from '../client';
import { collectHighlightTurns, findHighlightTurn, getHighlightSelectionContext } from '../dom';
import { HighlightManager } from '../manager';
import { installConversation, makeRecord, selectText } from './fixtures';

vi.mock('@/core/services/AccountIsolationService', () => ({
  detectAccountContextFromDocument: vi.fn(() => ({ routeUserId: '0', email: null })),
  accountIsolationService: {
    resolveAccountScope: vi.fn(async () => ({
      accountKey: 'route:0',
      accountId: 1,
      routeUserId: '0',
      emailHash: null,
    })),
  },
}));

class FakeHighlightClient extends HighlightClient {
  readonly listScopes: HighlightAccountScope[] = [];
  readonly createScopes: HighlightAccountScope[] = [];

  constructor(private listed: HighlightRecordV1[]) {
    super();
  }

  override async list(
    _scope: HighlightAccountScope,
    _conversationId: string,
  ): Promise<HighlightRecordV1[]> {
    this.listScopes.push(_scope);
    return this.listed;
  }

  override async create(
    _scope: HighlightAccountScope,
    input: HighlightCreateInput,
  ): Promise<HighlightRecordV1> {
    this.createScopes.push(_scope);
    const record = makeRecord(input.anchor, {
      conversationId: input.conversationId,
      conversationUrl: input.conversationUrl,
      conversationTitle: input.conversationTitle,
      turnId: input.turnId,
      role: input.role,
      color: input.color ?? 'yellow',
    });
    this.listed = [...this.listed, record];
    return record;
  }

  override async update(
    _scope: HighlightAccountScope,
    _conversationId: string,
    id: string,
    patch: HighlightUpdatePatch,
  ): Promise<HighlightRecordV1> {
    const current = this.listed.find((record) => record.id === id);
    if (!current) throw new Error('missing record');
    const updated = {
      ...current,
      ...patch,
      conversationTitle:
        patch.conversationTitle === null
          ? undefined
          : (patch.conversationTitle ?? current.conversationTitle),
      note: patch.note === null ? undefined : (patch.note ?? current.note),
    };
    this.listed = this.listed.map((record) => (record.id === id ? updated : record));
    return updated;
  }

  override async delete(
    _scope: HighlightAccountScope,
    _conversationId: string,
    id: string,
  ): Promise<void> {
    this.listed = this.listed.filter((record) => record.id !== id);
  }
}

describe('highlight anchors', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('accepts six-digit custom colors and rejects malformed values', () => {
    expect(isHighlightColor('#12Abef')).toBe(true);
    expect(isHighlightColor('#abc')).toBe(false);
    expect(isHighlightColor('red')).toBe(false);
  });

  it('keeps exactly five palette slots and migrates a legacy custom default', () => {
    expect(normalizeHighlightColorPalette(undefined, '#123456')).toEqual([
      '#123456',
      'green',
      'blue',
      'pink',
      '#c084fc',
    ]);
    expect(normalizeHighlightColorPalette(['#111111', '#222222'])).toEqual([
      '#111111',
      '#222222',
      'blue',
      'pink',
      '#c084fc',
    ]);
    expect(
      normalizeHighlightColorPalette([
        '#111111',
        '#222222',
        '#333333',
        '#444444',
        '#555555',
        '#666666',
      ]),
    ).toHaveLength(5);
  });

  it('builds a position and quote anchor from the model response', () => {
    const root = document.createElement('div');
    root.textContent = 'Prefix selected text suffix';
    document.body.appendChild(root);

    const anchor = buildHighlightAnchor(root, selectText(root, 'selected text'));

    expect(anchor).toMatchObject({
      quote: { exact: 'selected text', prefix: 'Prefix ', suffix: ' suffix' },
      position: { start: 7, end: 20 },
    });
    expect(anchor?.sourceTextHash).toBeTruthy();
  });

  it('falls back to quote context after the response moves', () => {
    const original = document.createElement('div');
    original.textContent = 'Before target after';
    document.body.appendChild(original);
    const anchor = buildHighlightAnchor(original, selectText(original, 'target'));
    if (!anchor) throw new Error('Expected anchor');

    const changed = document.createElement('div');
    changed.textContent = 'Inserted. Before target after';
    document.body.appendChild(changed);
    const resolved = resolveHighlightAnchor(changed, anchor);

    expect(resolved?.toString()).toBe('target');
  });

  it('does not resolve an ambiguous quote without distinguishing context', () => {
    const root = document.createElement('div');
    root.textContent = 'same same';
    document.body.appendChild(root);
    const anchor: HighlightRecordV1['anchor'] = {
      quote: { exact: 'same', prefix: '', suffix: '' },
      position: { start: 20, end: 24 },
      sourceTextHash: 'old',
    };

    expect(resolveHighlightAnchor(root, anchor)).toBeNull();
  });

  it('does not trust the old position when the response hash and context changed', () => {
    const root = document.createElement('div');
    root.textContent = 'New xx target yy';
    document.body.appendChild(root);
    const anchor: HighlightRecordV1['anchor'] = {
      quote: { exact: 'target', prefix: 'Old xx ', suffix: ' old suffix' },
      position: { start: 7, end: 13 },
      sourceTextHash: 'old-response-hash',
    };

    expect(resolveHighlightAnchor(root, anchor)).toBeNull();
  });
});

describe('highlight conversation DOM', () => {
  it('excludes Deep Research immersive nodes from turn pairing', () => {
    document.body.innerHTML = `
      <main>
        <div class="user-query-bubble-with-background">Real question</div>
        <model-response><message-content id="real-response">Real answer</message-content></model-response>
        <deep-research-immersive-panel>
          <div class="user-query-bubble-with-background">Report prompt</div>
          <model-response><message-content id="report-response">Report body</message-content></model-response>
        </deep-research-immersive-panel>
      </main>
    `;
    const report = document.getElementById('report-response');
    if (!(report instanceof HTMLElement)) throw new Error('Expected report response');

    expect(collectHighlightTurns()).toHaveLength(1);
    expect(getHighlightSelectionContext(selectText(report, 'Report body'))).toBeNull();
  });

  it('resolves a legacy highlight through the complete identity map', () => {
    history.replaceState({}, '', '/app/test');
    installConversation();
    const resolve = vi
      .spyOn(historyTimestampStore, 'resolveCanonicalTurnId')
      .mockImplementation((_conversationId, turnId) =>
        turnId === 'u-0' || turnId === 's-1111111111111111' ? 's-1111111111111111' : null,
      );

    expect(findHighlightTurn('u-0')?.turnId).toBe('s-1111111111111111');

    resolve.mockRestore();
  });

  it('does not create a highlight from a mounted positional fallback', () => {
    history.replaceState({}, '', '/app/test');
    const response = installConversation();
    document.querySelector('.conversation-container')?.removeAttribute('id');
    const resolve = vi
      .spyOn(historyTimestampStore, 'resolveCanonicalTurnId')
      .mockReturnValue('s-1111111111111111');

    expect(getHighlightSelectionContext(selectText(response, 'target'))).toBeNull();
    expect(resolve).not.toHaveBeenCalled();

    resolve.mockRestore();
  });
});

describe('HighlightManager rendering and navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, '', '/app/test');
  });

  afterEach(() => {
    document.body.innerHTML = '';
    document.getElementById('gv-highlight-style')?.remove();
  });

  it('renders persisted marks and an exact timeline tick', async () => {
    const response = installConversation();
    const anchor = buildHighlightAnchor(response, selectText(response, 'target'));
    if (!anchor) throw new Error('Expected anchor');
    const manager = new HighlightManager(new FakeHighlightClient([makeRecord(anchor)]));

    await manager.init();

    expect(document.querySelector('.gv-highlight-mark')?.textContent).toBe('target');
    expect(document.querySelector('.gv-highlight-timeline-tick')).toBeInstanceOf(HTMLButtonElement);
    expect(manager.navigateToHighlight('highlight-1', 'auto')).toBe('highlight');

    manager.destroy();
  });

  it('renders custom colors and can hide only the timeline markers', async () => {
    const response = installConversation();
    const anchor = buildHighlightAnchor(response, selectText(response, 'target'));
    if (!anchor) throw new Error('Expected anchor');
    const manager = new HighlightManager(
      new FakeHighlightClient([makeRecord(anchor, { color: '#123456' })]),
    );

    await manager.init();

    expect(document.querySelector<HTMLElement>('.gv-highlight-mark')?.style.backgroundColor).toBe(
      'rgba(18, 52, 86, 0.3)',
    );
    expect(
      document.querySelector<HTMLElement>('.gv-highlight-timeline-tick')?.style.backgroundColor,
    ).toBe('rgb(18, 52, 86)');

    manager.setTimelineMarkersEnabled(false);
    expect(document.querySelector('.gv-highlight-timeline-tick')).toBeNull();
    expect(document.querySelector('.gv-highlight-mark')?.textContent).toBe('target');

    manager.setTimelineMarkersEnabled(true);
    expect(document.querySelector('.gv-highlight-timeline-tick')).toBeInstanceOf(HTMLButtonElement);
    manager.destroy();
  });

  it('uses the five persistent palette slots when editing a highlight', async () => {
    const response = installConversation();
    const anchor = buildHighlightAnchor(response, selectText(response, 'target'));
    if (!anchor) throw new Error('Expected anchor');
    const manager = new HighlightManager(
      new FakeHighlightClient([makeRecord(anchor, { color: '#333333' })]),
    );
    manager.setColorPalette(['#111111', '#222222', '#333333', '#444444', '#555555']);
    await manager.init();

    document.querySelector<HTMLElement>('.gv-highlight-mark')?.click();
    const swatches = document.querySelectorAll<HTMLButtonElement>('.gv-highlight-swatch');
    expect(swatches).toHaveLength(5);
    expect(swatches[2].getAttribute('aria-pressed')).toBe('true');
    expect(swatches[4].style.backgroundColor).toBe('rgb(85, 85, 85)');
    manager.destroy();
  });

  it('saves editor changes through the scoped client and removes the annotation on delete', async () => {
    const response = installConversation();
    const anchor = buildHighlightAnchor(response, selectText(response, 'target'));
    if (!anchor) throw new Error('Expected anchor');
    const scope = {
      accountKey: 'email:editor-account',
      accountId: 2,
      routeUserId: '1',
      emailHash: 'editor-account',
    };
    vi.mocked(accountIsolationService.resolveAccountScope).mockResolvedValue(scope);
    const client = new FakeHighlightClient([makeRecord(anchor)]);
    const update = vi.spyOn(client, 'update');
    const remove = vi.spyOn(client, 'delete');
    const manager = new HighlightManager(client);
    await manager.init();

    const mark = document.querySelector<HTMLElement>('.gv-highlight-mark')!;
    mark.click();
    const note = document.querySelector<HTMLTextAreaElement>('.gv-highlight-note')!;
    note.value = 'Saved from the editor';
    document.querySelectorAll<HTMLButtonElement>('.gv-highlight-swatch')[1].click();
    document.querySelector<HTMLButtonElement>('.gv-highlight-popover-button-primary')!.click();
    await vi.waitFor(() => expect(document.querySelector('.gv-highlight-popover')).toBeNull());

    expect(update).toHaveBeenCalledExactlyOnceWith(
      { platform: 'gemini', accountKey: scope.accountKey, accountId: 2, routeUserId: '1' },
      'gemini:conv:test',
      'highlight-1',
      { note: 'Saved from the editor', color: 'green' },
    );
    expect(accountIsolationService.resolveAccountScope).toHaveBeenCalledTimes(2);
    expect(mark.classList).toContain('gv-highlight-mark-green');
    expect(document.querySelector('.gv-highlight-timeline-tick')?.classList).toContain(
      'gv-highlight-timeline-tick-green',
    );

    mark.click();
    expect(document.querySelector<HTMLTextAreaElement>('.gv-highlight-note')?.value).toBe(
      'Saved from the editor',
    );
    document.querySelector<HTMLButtonElement>('.gv-highlight-popover-button-danger')!.click();
    await vi.waitFor(() => expect(document.querySelector('.gv-highlight-mark')).toBeNull());

    expect(remove).toHaveBeenCalledExactlyOnceWith(
      { platform: 'gemini', accountKey: scope.accountKey, accountId: 2, routeUserId: '1' },
      'gemini:conv:test',
      'highlight-1',
    );
    expect(accountIsolationService.resolveAccountScope).toHaveBeenCalledTimes(3);
    expect(document.querySelector('.gv-highlight-popover')).toBeNull();
    expect(document.querySelector('.gv-highlight-timeline-tick')).toBeNull();
    expect(response.textContent).toBe('Alpha target Omega');
    manager.destroy();
  });

  it('does not show a timeline marker for a highlight inside hidden content', async () => {
    const response = installConversation();
    const anchor = buildHighlightAnchor(response, selectText(response, 'target'));
    if (!anchor) throw new Error('Expected anchor');
    const modelResponse = response.closest<HTMLElement>('model-response');
    if (!modelResponse) throw new Error('Expected model response');
    modelResponse.style.display = 'none';
    const manager = new HighlightManager(new FakeHighlightClient([makeRecord(anchor)]));

    await manager.init();

    expect(document.querySelector('.gv-highlight-mark')?.textContent).toBe('target');
    expect(document.querySelector('.gv-highlight-timeline-tick')).toBeNull();
    manager.destroy();
  });

  it('discards a stale account scope when the route changes during initialization', async () => {
    installConversation();
    window.history.replaceState(null, '', '/u/0/app/test');
    type ResolvedAccountScope = Awaited<
      ReturnType<typeof accountIsolationService.resolveAccountScope>
    >;
    let releaseFirstScope = (_scope: ResolvedAccountScope): void => {};
    const firstScopePromise = new Promise<ResolvedAccountScope>((resolve) => {
      releaseFirstScope = resolve;
    });
    vi.mocked(accountIsolationService.resolveAccountScope)
      .mockImplementationOnce(() => firstScopePromise)
      .mockResolvedValueOnce({
        accountKey: 'route:1',
        accountId: 2,
        routeUserId: '1',
        emailHash: null,
      });
    const client = new FakeHighlightClient([]);
    const manager = new HighlightManager(client);
    const initializing = manager.init();

    window.history.replaceState(null, '', '/u/1/app/test');
    releaseFirstScope({
      accountKey: 'route:0',
      accountId: 1,
      routeUserId: '0',
      emailHash: null,
    });
    await initializing;

    expect(client.listScopes).toHaveLength(1);
    expect(client.listScopes[0].routeUserId).toBe('1');
    manager.destroy();
  });

  it('refreshes a startup default scope before saving a new highlight', async () => {
    const response = installConversation();
    window.history.replaceState(null, '', '/app/test');
    vi.mocked(accountIsolationService.resolveAccountScope)
      .mockResolvedValueOnce({
        accountKey: 'default',
        accountId: 1,
        routeUserId: null,
        emailHash: null,
      })
      .mockResolvedValue({
        accountKey: 'email:resolved-account',
        accountId: 2,
        routeUserId: null,
        emailHash: 'resolved-account',
      });
    const client = new FakeHighlightClient([]);
    const manager = new HighlightManager(client);
    await manager.init();

    await expect(manager.createFromRange(selectText(response, 'target'))).resolves.toBe(true);

    expect(client.createScopes.at(-1)?.accountKey).toBe('email:resolved-account');
    expect(client.listScopes.at(-1)?.accountKey).toBe('email:resolved-account');
    manager.destroy();
  });

  it('moves timeline ticks when Timeline switches between classic and compact', async () => {
    const response = installConversation();
    const anchor = buildHighlightAnchor(response, selectText(response, 'target'));
    if (!anchor) throw new Error('Expected anchor');
    const manager = new HighlightManager(new FakeHighlightClient([makeRecord(anchor)]));
    await manager.init();
    const bar = document.querySelector<HTMLElement>('.gemini-timeline-bar');
    const track = document.querySelector<HTMLElement>('.timeline-track-content');
    if (!bar || !track) throw new Error('Expected timeline');
    expect(document.querySelector('.gv-highlight-timeline-tick')?.parentElement).toBe(track);

    bar.classList.add('timeline-style-compact');
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(document.querySelector('.gv-highlight-timeline-tick')?.parentElement).toBe(bar);

    bar.classList.remove('timeline-style-compact');
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(document.querySelector('.gv-highlight-timeline-tick')?.parentElement).toBe(track);

    manager.destroy();
  });

  it('reattaches markers when Timeline replaces its DOM and follows the replacement style', async () => {
    const response = installConversation();
    const anchor = buildHighlightAnchor(response, selectText(response, 'target'));
    if (!anchor) throw new Error('Expected anchor');
    const manager = new HighlightManager(new FakeHighlightClient([makeRecord(anchor)]));
    await manager.init();
    const oldBar = document.querySelector<HTMLElement>('.gemini-timeline-bar')!;
    const oldTick = oldBar.querySelector('.gv-highlight-timeline-tick')!;
    const replacement = document.createElement('div');
    replacement.className = 'gemini-timeline-bar';
    replacement.innerHTML = '<div class="timeline-track-content"></div>';
    oldBar.replaceWith(replacement);

    await vi.waitFor(() => {
      expect(replacement.querySelector('.gv-highlight-timeline-tick')?.parentElement).toBe(
        replacement.firstElementChild,
      );
    });
    expect(oldTick.isConnected).toBe(false);
    expect(replacement.querySelectorAll('.gv-highlight-timeline-tick')).toHaveLength(1);

    replacement.classList.add('timeline-style-compact');
    await vi.waitFor(() => {
      expect(replacement.querySelector('.gv-highlight-timeline-tick')?.parentElement).toBe(
        replacement,
      );
    });
    expect(replacement.querySelectorAll('.gv-highlight-timeline-tick')).toHaveLength(1);
    manager.destroy();
  });

  it('falls back to the owning turn when the quote cannot be resolved', async () => {
    const response = installConversation('Completely different response');
    const unresolved = makeRecord({
      quote: { exact: 'missing quote', prefix: 'before', suffix: 'after' },
      position: { start: 10, end: 23 },
      sourceTextHash: 'old-hash',
    });
    const user = document.querySelector<HTMLElement>('.user-query-bubble-with-background');
    if (!user) throw new Error('Expected user turn');
    user.scrollIntoView = vi.fn();
    const manager = new HighlightManager(new FakeHighlightClient([unresolved]));

    await manager.init();

    expect(document.querySelector('.gv-highlight-mark')).toBeNull();
    expect(manager.navigateToHighlight('highlight-1', 'auto')).toBe('turn');
    expect(user.scrollIntoView).toHaveBeenCalled();
    expect(response.textContent).toBe('Completely different response');

    manager.destroy();
  });

  it('removes a stale mark instead of highlighting changed response text', async () => {
    const response = installConversation();
    const anchor = buildHighlightAnchor(response, selectText(response, 'target'));
    if (!anchor) throw new Error('Expected anchor');
    const manager = new HighlightManager(new FakeHighlightClient([makeRecord(anchor)]));
    await manager.init();
    const mark = document.querySelector<HTMLElement>('.gv-highlight-mark');
    if (!mark) throw new Error('Expected rendered mark');

    mark.textContent = 'changed';
    await new Promise((resolve) => window.setTimeout(resolve, 180));

    expect(document.querySelector('.gv-highlight-mark')).toBeNull();
    expect(response.textContent).toBe('Alpha changed Omega');

    manager.destroy();
  });

  it('keeps retrying an exact hash after the owning turn appears first', async () => {
    const source = document.createElement('div');
    source.textContent = 'Before target after';
    document.body.appendChild(source);
    const anchor = buildHighlightAnchor(source, selectText(source, 'target'));
    if (!anchor) throw new Error('Expected anchor');
    const response = installConversation('Loading response');
    window.history.replaceState(null, '', '/app/test#gv-highlight-highlight-1');
    const manager = new HighlightManager(new FakeHighlightClient([makeRecord(anchor)]));

    await manager.init();
    expect(document.querySelector('.gv-highlight-mark')).toBeNull();
    response.textContent = 'Before target after';
    await new Promise((resolve) => window.setTimeout(resolve, 180));

    expect(document.querySelector('.gv-highlight-mark')?.textContent).toBe('target');
    expect(document.querySelector('.gv-highlight-mark')?.classList).toContain(
      'gv-highlight-active',
    );

    manager.destroy();
  });

  it('removes injected marks, ticks, listeners, and styles on cleanup', async () => {
    const response = installConversation();
    const anchor = buildHighlightAnchor(response, selectText(response, 'target'));
    if (!anchor) throw new Error('Expected anchor');
    const manager = new HighlightManager(new FakeHighlightClient([makeRecord(anchor)]));

    await manager.init();
    manager.destroy();

    expect(document.querySelector('.gv-highlight-mark')).toBeNull();
    expect(document.querySelector('.gv-highlight-timeline-tick')).toBeNull();
    expect(document.getElementById('gv-highlight-style')).toBeNull();
    expect(chrome.runtime.onMessage.removeListener).toHaveBeenCalled();
    expect(response.textContent).toBe('Alpha target Omega');
  });
});
