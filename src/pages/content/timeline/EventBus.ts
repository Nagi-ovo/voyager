type StarredEvent = 'starred:added' | 'starred:removed';
type StarredChange = { conversationId: string; turnId: string };
type Listener = (change: StarredChange) => void;

/** Same-page star updates; extension storage handles cross-page notifications. */
class EventBus {
  private readonly listeners = new Map<StarredEvent, Set<Listener>>();

  on(event: StarredEvent, listener: Listener): () => void {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this.listeners.get(event);
      current?.delete(listener);
      if (current?.size === 0) this.listeners.delete(event);
    };
  }

  emit(event: StarredEvent, change: StarredChange): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        listener(change);
      } catch (error) {
        console.error(`[EventBus] Error in ${event} listener:`, error);
      }
    }
  }
}

export const eventBus = new EventBus();
