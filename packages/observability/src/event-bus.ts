export type EventFilter<T> = (event: T) => boolean;
export type EventHandler<T> = (event: T) => void;

export interface EventBus<T> {
  publish(event: T): void;
  subscribe(handler: EventHandler<T>, filter?: EventFilter<T>): () => void;
}

export function createEventBus<T>(): EventBus<T> {
  const subs = new Set<{
    handler: EventHandler<T>;
    filter?: EventFilter<T> | undefined;
  }>();

  return {
    publish(event: T): void {
      for (const sub of subs) {
        if (sub.filter && !sub.filter(event)) continue;
        try {
          sub.handler(event);
        } catch {
          // isolate subscriber errors
        }
      }
    },

    subscribe(handler: EventHandler<T>, filter?: EventFilter<T>): () => void {
      const entry = { handler, filter };
      subs.add(entry);
      return () => {
        subs.delete(entry);
      };
    },
  };
}
