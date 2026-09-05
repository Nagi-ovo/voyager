/**
 * ForkNodesService - communicates with background script for fork node persistence
 * Follows the same pattern as StarredMessagesService
 */
import type { ForkNode, ForkNodesData } from './forkTypes';

async function sendMessage<T>(type: string, payload?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({ type, payload }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response?.ok) {
          resolve(response as T);
        } else {
          reject(new Error(response?.error || 'Unknown error'));
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

export class ForkNodesService {
  static async addForkNode(node: ForkNode): Promise<boolean> {
    const response = await sendMessage<{ ok: boolean; added: boolean }>('gv.fork.add', node);

    return response.added;
  }

  static async removeForkNode(
    conversationId: string,
    turnId: string,
    forkGroupId: string,
  ): Promise<boolean> {
    const response = await sendMessage<{ ok: boolean; removed: boolean }>('gv.fork.remove', {
      conversationId,
      turnId,
      forkGroupId,
    });

    return response.removed;
  }

  static async getAllForkNodes(): Promise<ForkNodesData> {
    const response = await sendMessage<{ ok: boolean; data: ForkNodesData }>('gv.fork.getAll');
    return response.data;
  }

  static async getForConversation(conversationId: string): Promise<ForkNode[]> {
    const response = await sendMessage<{ ok: boolean; nodes: ForkNode[] }>(
      'gv.fork.getForConversation',
      { conversationId },
    );
    return response.nodes;
  }

  static async getGroup(forkGroupId: string): Promise<ForkNode[]> {
    const response = await sendMessage<{ ok: boolean; nodes: ForkNode[] }>('gv.fork.getGroup', {
      forkGroupId,
    });
    return response.nodes;
  }
}
