import { describe, expect, it } from 'vitest';
import { LruList } from '../src/lru.js';
import { Store, ENTRY_OVERHEAD_BYTES } from '../src/store.js';
import { makeHarness } from './helpers/harness.js';

describe('LruList', () => {
  it('tracks recency order with pushFront and moveToFront', () => {
    const list = new LruList<string>();
    const a = list.pushFront('a');
    list.pushFront('b');
    const c = list.pushFront('c');
    expect(list.toArray()).toEqual(['c', 'b', 'a']);
    expect(list.mostRecent).toBe('c');
    expect(list.leastRecent).toBe('a');

    list.moveToFront(a);
    expect(list.toArray()).toEqual(['a', 'c', 'b']);
    expect(list.leastRecent).toBe('b');

    list.moveToFront(a); // already at front: no-op
    expect(list.toArray()).toEqual(['a', 'c', 'b']);
    expect(list.size).toBe(3);

    list.moveToFront(c); // middle node
    expect(list.toArray()).toEqual(['c', 'a', 'b']);
  });

  it('removes nodes from head, middle, and tail', () => {
    const list = new LruList<string>();
    const a = list.pushFront('a');
    const b = list.pushFront('b');
    const c = list.pushFront('c'); // order: c b a

    list.remove(b);
    expect(list.toArray()).toEqual(['c', 'a']);
    list.remove(c);
    expect(list.toArray()).toEqual(['a']);
    list.remove(a);
    expect(list.toArray()).toEqual([]);
    expect(list.size).toBe(0);
    expect(list.mostRecent).toBeUndefined();
    expect(list.leastRecent).toBeUndefined();
  });

  it('ignores removing a node twice', () => {
    const list = new LruList<string>();
    const a = list.pushFront('a');
    list.pushFront('b');
    list.remove(a);
    list.remove(a);
    expect(list.size).toBe(1);
    expect(list.toArray()).toEqual(['b']);
  });

  it('clear empties the list', () => {
    const list = new LruList<number>();
    list.pushFront(1);
    list.pushFront(2);
    list.clear();
    expect(list.size).toBe(0);
    expect(list.toArray()).toEqual([]);
  });

  it('handles a single-element list', () => {
    const list = new LruList<string>();
    const only = list.pushFront('x');
    list.moveToFront(only);
    expect(list.toArray()).toEqual(['x']);
    list.remove(only);
    expect(list.toArray()).toEqual([]);
  });
});

describe('Store LRU eviction', () => {
  // Every key below is 2 bytes and every value 4 bytes, so each entry costs
  // exactly ENTRY_OVERHEAD_BYTES + 6 and the limits are easy to reason about.
  const entryCost = ENTRY_OVERHEAD_BYTES + 6;
  const value = (): Buffer => Buffer.from('aaaa');

  function storeWithCapacity(entries: number): Store {
    return new Store({ maxmemory: entryCost * entries, clock: () => 0 });
  }

  it('tracks approximate memory usage across writes and deletes', () => {
    const store = new Store({ clock: () => 0 });
    expect(store.usedMemory).toBe(0);
    store.set('k1', value());
    expect(store.usedMemory).toBe(entryCost);
    store.set('k1', Buffer.from('aaaaaaaa')); // grow value by 4 bytes
    expect(store.usedMemory).toBe(entryCost + 4);
    store.set('k1', Buffer.from('aa')); // shrink by 6
    expect(store.usedMemory).toBe(entryCost - 2);
    store.delete('k1');
    expect(store.usedMemory).toBe(0);
  });

  it('evicts the least recently used key when over the limit', () => {
    const store = storeWithCapacity(3);
    store.set('k1', value());
    store.set('k2', value());
    store.set('k3', value());
    expect(store.size()).toBe(3);

    store.set('k4', value()); // k1 is oldest
    expect(store.has('k1')).toBe(false);
    expect(store.has('k2')).toBe(true);
    expect(store.has('k3')).toBe(true);
    expect(store.has('k4')).toBe(true);
    expect(store.evictedKeyCount).toBe(1);
    expect(store.usedMemory).toBeLessThanOrEqual(entryCost * 3);
  });

  it('a read refreshes recency and changes the eviction victim', () => {
    const store = storeWithCapacity(3);
    store.set('k1', value());
    store.set('k2', value());
    store.set('k3', value());

    store.get('k1'); // k1 becomes most recent; k2 is now the LRU key
    store.set('k4', value());

    expect(store.has('k1')).toBe(true);
    expect(store.has('k2')).toBe(false);
    expect(store.recencyOrder()).toEqual(['k4', 'k1', 'k3']);
  });

  it('an overwrite refreshes recency', () => {
    const store = storeWithCapacity(3);
    store.set('k1', value());
    store.set('k2', value());
    store.set('k3', value());
    store.set('k1', value()); // rewrite k1: k2 becomes LRU
    store.set('k4', value());
    expect(store.has('k2')).toBe(false);
    expect(store.has('k1')).toBe(true);
  });

  it('evicts as many keys as needed for one large write', () => {
    const store = storeWithCapacity(3);
    store.set('k1', value());
    store.set('k2', value());
    store.set('k3', value());
    // Twice the size of a normal entry: two old keys must go.
    store.set('kX', Buffer.alloc(ENTRY_OVERHEAD_BYTES + 10));
    expect(store.has('k1')).toBe(false);
    expect(store.has('k2')).toBe(false);
    expect(store.has('k3')).toBe(true);
    expect(store.has('kX')).toBe(true);
    expect(store.evictedKeyCount).toBe(2);
  });

  it('a single entry larger than maxmemory empties the store', () => {
    const store = new Store({ maxmemory: 100, clock: () => 0 });
    store.set('k1', Buffer.from('aa'));
    store.set('big', Buffer.alloc(500));
    expect(store.size()).toBe(0);
    expect(store.usedMemory).toBe(0);
    expect(store.evictedKeyCount).toBe(2);
  });

  it('never evicts when maxmemory is 0', () => {
    const store = new Store({ clock: () => 0 });
    for (let i = 0; i < 1000; i++) store.set(`key:${i}`, value());
    expect(store.size()).toBe(1000);
    expect(store.evictedKeyCount).toBe(0);
  });

  it('reports evictions through onEvict', () => {
    const store = storeWithCapacity(2);
    const evicted: string[] = [];
    store.onEvict = (key) => evicted.push(key);
    store.set('k1', value());
    store.set('k2', value());
    store.set('k3', value());
    store.set('k4', value());
    expect(evicted).toEqual(['k1', 'k2']);
  });

  it('eviction works end to end through SET and GET commands', () => {
    const { run } = makeHarness({ maxmemory: entryCost * 2 });
    expect(run('SET', 'k1', 'aaaa')).toBe('OK');
    expect(run('SET', 'k2', 'aaaa')).toBe('OK');
    expect(run('GET', 'k1')).toBe('aaaa'); // touch k1: k2 becomes the victim
    expect(run('SET', 'k3', 'aaaa')).toBe('OK');
    expect(run('GET', 'k2')).toBeNull();
    expect(run('GET', 'k1')).toBe('aaaa');
    expect(run('INFO', 'stats')).toContain('evicted_keys:1');
  });
});
