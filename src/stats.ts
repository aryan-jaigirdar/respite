/**
 * Server-level counters surfaced by INFO. Expiration and eviction counts live
 * on the Store, next to the code paths that produce them.
 */
export class ServerStats {
  /** Connections accepted since startup. */
  totalConnections = 0;
  /** Commands executed since startup (AOF replay excluded). */
  commandsProcessed = 0;
  /** Read lookups that found a live key. */
  keyspaceHits = 0;
  /** Read lookups that found nothing. */
  keyspaceMisses = 0;
}
