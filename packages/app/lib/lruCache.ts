/** Small insertion-ordered LRU; `onEvict` runs for entries dropped by capacity. */
export class LruCache<V> {
  private map = new Map<string, V>();

  constructor(
    private capacity: number,
    private onEvict?: (key: string, value: V) => void,
  ) {}

  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as string;
      const evicted = this.map.get(oldest) as V;
      this.map.delete(oldest);
      this.onEvict?.(oldest, evicted);
    }
  }

  get size(): number {
    return this.map.size;
  }
}
