import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ForkNodesService } from '../ForkNodesService';
import type { ForkNode, ForkNodesData } from '../forkTypes';

function createForkNode(overrides: Partial<ForkNode> = {}): ForkNode {
  return {
    turnId: 'u-0',
    conversationId: 'conv1',
    conversationUrl: 'https://gemini.google.com/app/conv1',
    conversationTitle: 'Test Conversation',
    forkGroupId: 'fork-group-1',
    forkIndex: 0,
    createdAt: 1000,
    ...overrides,
  };
}

describe('ForkNodesService', () => {
  let sendMessageMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    sendMessageMock = vi.fn();
    chrome.runtime.sendMessage = sendMessageMock as unknown as typeof chrome.runtime.sendMessage;
    Object.defineProperty(chrome.runtime, 'lastError', { value: null, configurable: true });
  });

  describe('addForkNode', () => {
    it('sends gv.fork.add and returns whether the node was added', async () => {
      const node = createForkNode();

      sendMessageMock.mockImplementation(
        (_message: unknown, callback: (response: unknown) => void) => {
          callback({ ok: true, added: true });
        },
      );

      const result = await ForkNodesService.addForkNode(node);

      expect(result).toBe(true);
      expect(sendMessageMock).toHaveBeenCalledWith(
        { type: 'gv.fork.add', payload: node },
        expect.any(Function),
      );
    });

    it('returns false when the node was not added', async () => {
      const node = createForkNode();

      sendMessageMock.mockImplementation(
        (_message: unknown, callback: (response: unknown) => void) => {
          callback({ ok: true, added: false });
        },
      );

      const result = await ForkNodesService.addForkNode(node);

      expect(result).toBe(false);
    });

    it('should reject on runtime error', async () => {
      const node = createForkNode();

      sendMessageMock.mockImplementation(
        (_message: unknown, callback: (response: unknown) => void) => {
          Object.defineProperty(chrome.runtime, 'lastError', {
            value: { message: 'Extension context invalidated' },
            configurable: true,
          });
          callback(undefined);
        },
      );

      await expect(ForkNodesService.addForkNode(node)).rejects.toThrow(
        'Extension context invalidated',
      );

      // Restore
      Object.defineProperty(chrome.runtime, 'lastError', {
        value: null,
        configurable: true,
      });
    });
  });

  describe('removeForkNode', () => {
    it('sends gv.fork.remove and returns whether the node was removed', async () => {
      sendMessageMock.mockImplementation(
        (_message: unknown, callback: (response: unknown) => void) => {
          callback({ ok: true, removed: true });
        },
      );

      const result = await ForkNodesService.removeForkNode('conv1', 'u-0', 'fork-group-1');

      expect(result).toBe(true);
      expect(sendMessageMock).toHaveBeenCalledWith(
        {
          type: 'gv.fork.remove',
          payload: { conversationId: 'conv1', turnId: 'u-0', forkGroupId: 'fork-group-1' },
        },
        expect.any(Function),
      );
    });
  });

  describe('getAllForkNodes', () => {
    it('should return all fork nodes data', async () => {
      const mockData: ForkNodesData = {
        nodes: {
          conv1: [createForkNode()],
        },
        groups: {
          'fork-group-1': ['conv1:u-0'],
        },
      };

      sendMessageMock.mockImplementation(
        (_message: unknown, callback: (response: unknown) => void) => {
          callback({ ok: true, data: mockData });
        },
      );

      const result = await ForkNodesService.getAllForkNodes();

      expect(result).toEqual(mockData);
      expect(sendMessageMock).toHaveBeenCalledWith(
        { type: 'gv.fork.getAll', payload: undefined },
        expect.any(Function),
      );
    });
  });

  describe('getForConversation', () => {
    it('should return fork nodes for a specific conversation', async () => {
      const nodes = [createForkNode()];

      sendMessageMock.mockImplementation(
        (_message: unknown, callback: (response: unknown) => void) => {
          callback({ ok: true, nodes });
        },
      );

      const result = await ForkNodesService.getForConversation('conv1');

      expect(result).toEqual(nodes);
      expect(sendMessageMock).toHaveBeenCalledWith(
        { type: 'gv.fork.getForConversation', payload: { conversationId: 'conv1' } },
        expect.any(Function),
      );
    });
  });

  describe('getGroup', () => {
    it('should return all nodes in a fork group', async () => {
      const nodes = [
        createForkNode({ forkIndex: 0 }),
        createForkNode({ conversationId: 'conv2', forkIndex: 1 }),
      ];

      sendMessageMock.mockImplementation(
        (_message: unknown, callback: (response: unknown) => void) => {
          callback({ ok: true, nodes });
        },
      );

      const result = await ForkNodesService.getGroup('fork-group-1');

      expect(result).toEqual(nodes);
      expect(sendMessageMock).toHaveBeenCalledWith(
        { type: 'gv.fork.getGroup', payload: { forkGroupId: 'fork-group-1' } },
        expect.any(Function),
      );
    });
  });

  describe('error handling', () => {
    it('should reject when response is not ok', async () => {
      sendMessageMock.mockImplementation(
        (_message: unknown, callback: (response: unknown) => void) => {
          callback({ ok: false, error: 'Storage full' });
        },
      );

      await expect(ForkNodesService.getAllForkNodes()).rejects.toThrow('Storage full');
    });

    it('should reject with unknown error when no error message provided', async () => {
      sendMessageMock.mockImplementation(
        (_message: unknown, callback: (response: unknown) => void) => {
          callback({ ok: false });
        },
      );

      await expect(ForkNodesService.getAllForkNodes()).rejects.toThrow('Unknown error');
    });
  });
});
