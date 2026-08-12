export type ChatGptTurnRole = 'user' | 'assistant' | 'unknown';

export interface ChatGptTurnContainer {
  /** ChatGPT 虚拟列表顶层容器的稳定 UUID。 */
  id: string;

  /** 在完整顶层容器列表中的语义顺序，从 0 开始。 */
  sequence: number;

  /** 当前容器中已挂载内容推断出的角色。 */
  role: ChatGptTurnRole;

  /** 顶层 [data-turn-id-container] 容器。 */
  container: HTMLElement;
}

export interface ExportSelectionOptions {
  /** Cancels virtual-list scrolling when the plugin is disabled or the user cancels. */
  readonly signal?: AbortSignal;

  /** Route captured before collection; changing conversations invalidates the export. */
  readonly expectedUrl?: string;
}
