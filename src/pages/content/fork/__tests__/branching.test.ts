import { describe, expect, it } from 'vitest';

import { buildBranchDisplayNodes, resolveForkPlan } from '../branching';
import type { ForkNode } from '../forkTypes';

function createNode(overrides: Partial<ForkNode> = {}): ForkNode {
  return {
    turnId: 'u-0',
    conversationId: 'conv-1',
    conversationUrl: 'https://gemini.google.com/app/conv-1',
    conversationTitle: 'Conversation 1',
    forkGroupId: 'group-1',
    forkIndex: 0,
    createdAt: 100,
    ...overrides,
  };
}

describe('resolveForkPlan', () => {
  it('should create new group when turn has no existing forks', () => {
    const plan = resolveForkPlan('conv-1', 'u-2', [], {}, () => 'new-group');
    expect(plan).toEqual({
      forkGroupId: 'new-group',
      sourceForkIndex: 0,
      nextForkIndex: 1,
    });
  });

  it('should reuse existing group and increment index', () => {
    const convNodes = [createNode({ turnId: 'u-0', forkGroupId: 'group-1', forkIndex: 0 })];
    const groups = {
      'group-1': [
        createNode({ conversationId: 'conv-1', forkIndex: 0 }),
        createNode({ conversationId: 'conv-2', forkIndex: 1 }),
      ],
    };

    const plan = resolveForkPlan('conv-1', 'u-0', convNodes, groups, () => 'new-group');
    expect(plan).toEqual({
      forkGroupId: 'group-1',
      sourceForkIndex: 0,
      nextForkIndex: 2,
    });
  });

  it('reuses a legacy fork only when the shared identity resolver proves its alias', () => {
    const serverId = 's-6060606060606060';
    const resolveTurnId = (turnId: string) => {
      if (turnId === 'u-60' || turnId === serverId) return serverId;
      return null;
    };
    const existing = createNode({ turnId: 'u-60', forkIndex: 0 });

    const plan = resolveForkPlan(
      'conv-1',
      serverId,
      [existing],
      { 'group-1': [existing] },
      () => 'new-group',
      resolveTurnId,
    );

    expect(plan).toEqual({
      forkGroupId: 'group-1',
      sourceForkIndex: 0,
      nextForkIndex: 1,
    });
  });
});

describe('buildBranchDisplayNodes', () => {
  it('should merge nodes from duplicate groups into a single 1..N sequence basis', () => {
    const groupA = [
      createNode({
        conversationId: 'conv-1',
        forkGroupId: 'group-a',
        forkIndex: 0,
        createdAt: 100,
      }),
      createNode({
        conversationId: 'conv-2',
        forkGroupId: 'group-a',
        forkIndex: 1,
        createdAt: 200,
      }),
    ];
    const groupB = [
      createNode({
        conversationId: 'conv-1',
        forkGroupId: 'group-b',
        forkIndex: 0,
        createdAt: 100,
      }),
      createNode({
        conversationId: 'conv-3',
        forkGroupId: 'group-b',
        forkIndex: 1,
        createdAt: 300,
      }),
    ];

    const nodes = buildBranchDisplayNodes([groupA, groupB]);
    expect(nodes.map((node) => node.conversationId)).toEqual(['conv-1', 'conv-2', 'conv-3']);
  });

  it('should keep linked branches even when turnId differs between conversations', () => {
    const group = [
      createNode({ conversationId: 'conv-1', turnId: 'u-5', forkIndex: 0 }),
      createNode({ conversationId: 'conv-2', turnId: 'u-0', forkIndex: 1 }),
    ];

    const nodes = buildBranchDisplayNodes([group]);
    expect(nodes.map((node) => node.conversationId)).toEqual(['conv-1', 'conv-2']);
  });
});
