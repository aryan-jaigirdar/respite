/**
 * Intrusive doubly-linked list used to track key recency.
 *
 * The store keeps one node per key inside its entry record, giving O(1)
 * insert, touch (move to front), and removal, and O(1) access to the least
 * recently used key at the tail. Nothing here allocates beyond the node
 * itself.
 */

export class LruNode<T> {
  prev: LruNode<T> | null = null;
  next: LruNode<T> | null = null;

  constructor(readonly value: T) {}
}

export class LruList<T> {
  private head: LruNode<T> | null = null; // most recently used
  private tail: LruNode<T> | null = null; // least recently used
  private count = 0;

  get size(): number {
    return this.count;
  }

  get mostRecent(): T | undefined {
    return this.head?.value;
  }

  get leastRecent(): T | undefined {
    return this.tail?.value;
  }

  /** Inserts a new value at the most-recently-used end. */
  pushFront(value: T): LruNode<T> {
    const node = new LruNode(value);
    this.attachFront(node);
    return node;
  }

  /** Marks a node as most recently used. O(1). */
  moveToFront(node: LruNode<T>): void {
    if (this.head === node) return;
    this.detach(node);
    this.attachFront(node);
  }

  /** Unlinks a node. Safe to call on a node that was already removed. */
  remove(node: LruNode<T>): void {
    this.detach(node);
  }

  clear(): void {
    this.head = null;
    this.tail = null;
    this.count = 0;
  }

  /** Values from most to least recently used. Intended for tests/debugging. */
  toArray(): T[] {
    const values: T[] = [];
    for (let node = this.head; node !== null; node = node.next) {
      values.push(node.value);
    }
    return values;
  }

  private attachFront(node: LruNode<T>): void {
    node.prev = null;
    node.next = this.head;
    if (this.head !== null) this.head.prev = node;
    this.head = node;
    if (this.tail === null) this.tail = node;
    this.count += 1;
  }

  private detach(node: LruNode<T>): void {
    if (node.prev !== null) {
      node.prev.next = node.next;
    } else if (this.head === node) {
      this.head = node.next;
    } else {
      return; // not in the list
    }
    if (node.next !== null) {
      node.next.prev = node.prev;
    } else {
      this.tail = node.prev;
    }
    node.prev = null;
    node.next = null;
    this.count -= 1;
  }
}
