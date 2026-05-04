import { MODULE_ID, FLAGS } from "./constants.js";

/**
 * EngagementTracker
 *
 * Manages the per-Combat engagement graph. Two tokens are "Engaged" (Core p.159)
 * when they have attacked each other in melee and the relationship has not yet
 * gone stale (no attack between them for a full Round).
 *
 * Storage model: the engagement graph is persisted as a flag on the active
 * Combat document. This gives us free serialization, cross-client sync, and
 * automatic cleanup at combat end. We never mutate the flag in place — every
 * change is a setFlag() call so other clients see it.
 *
 * The graph itself is a symmetric map:
 *   { [tokenId]: { engagedWith: string[], lastAttackRound: number } }
 *
 * `lastAttackRound` is the most recent round in which an attack occurred
 * between this token and ANY of its engaged opponents. We track it per-token
 * rather than per-edge to keep the data structure flat; the staleness check
 * (see pruneStale) re-derives per-edge information when needed.
 *
 * Actually, we DO need per-edge timing for correctness. If A attacks B in
 * round 1, then A attacks C in round 3, the A-B engagement should have gone
 * stale at the start of round 3 even though A's lastAttackRound is now 3.
 * So we store edges as: { [tokenId]: { [otherId]: lastAttackRound } }
 */
export class EngagementTracker {
  constructor(combat) {
    if (!combat) throw new Error("EngagementTracker requires a Combat document");
    this.combat = combat;
  }

  /**
   * Get the raw engagement graph from combat flags. Returns a fresh object
   * every call — never mutate in place.
   */
  _getGraph() {
    const stored = this.combat.getFlag(MODULE_ID, FLAGS.ENGAGEMENTS);
    return stored ? foundry.utils.deepClone(stored) : {};
  }

  /**
   * Persist the graph back to combat flags. Awaitable.
   */
  async _setGraph(graph) {
    return this.combat.setFlag(MODULE_ID, FLAGS.ENGAGEMENTS, graph);
  }

  /**
   * Get the set of token IDs currently engaged with `tokenId`.
   * Returns an empty array if the token has no engagements.
   */
  getEngagementsFor(tokenId) {
    const graph = this._getGraph();
    const node = graph[tokenId];
    if (!node) return [];
    return Object.keys(node);
  }

  /**
   * Are these two tokens engaged?
   */
  areEngaged(tokenIdA, tokenIdB) {
    const graph = this._getGraph();
    return Boolean(graph[tokenIdA]?.[tokenIdB]);
  }

  /**
   * Mark two tokens as engaged. Called when an attack is resolved between them.
   * Symmetric: both directions of the edge are stamped with the current round.
   */
  async engage(tokenIdA, tokenIdB, round) {
    if (tokenIdA === tokenIdB) return;
    const graph = this._getGraph();
    if (!graph[tokenIdA]) graph[tokenIdA] = {};
    if (!graph[tokenIdB]) graph[tokenIdB] = {};
    graph[tokenIdA][tokenIdB] = round;
    graph[tokenIdB][tokenIdA] = round;
    await this._setGraph(graph);
  }

  /**
   * Remove an engagement edge. Used by the Disengage button and auto-disengage.
   * If `tokenIdB` is omitted, remove ALL edges touching tokenIdA.
   */
  async disengage(tokenIdA, tokenIdB = null) {
    const graph = this._getGraph();
    if (tokenIdB === null) {
      // Drop all edges touching A
      for (const otherId of Object.keys(graph[tokenIdA] ?? {})) {
        if (graph[otherId]) delete graph[otherId][tokenIdA];
        if (graph[otherId] && Object.keys(graph[otherId]).length === 0) {
          delete graph[otherId];
        }
      }
      delete graph[tokenIdA];
    } else {
      if (graph[tokenIdA]) {
        delete graph[tokenIdA][tokenIdB];
        if (Object.keys(graph[tokenIdA]).length === 0) delete graph[tokenIdA];
      }
      if (graph[tokenIdB]) {
        delete graph[tokenIdB][tokenIdA];
        if (Object.keys(graph[tokenIdB]).length === 0) delete graph[tokenIdB];
      }
    }
    await this._setGraph(graph);
  }

  /**
   * Prune engagements that have gone stale. Per Core p.159: "If you don't
   * attack each other for a full Round, you are no longer Engaged."
   *
   * Interpretation: if the engagement was last refreshed in round N, then
   * round N+1 passes without a refresh, the engagement breaks at the end of
   * round N+1 / start of round N+2. So at the start of round R, drop any edge
   * with lastAttackRound <= R - 2.
   *
   * Called from the combatRound hook (start of new round).
   */
  async pruneStale(currentRound) {
    const graph = this._getGraph();
    let mutated = false;
    const cutoff = currentRound - 2; // edges with lastAttack <= cutoff are dead

    for (const [tokenId, edges] of Object.entries(graph)) {
      for (const [otherId, lastRound] of Object.entries(edges)) {
        if (lastRound <= cutoff) {
          delete graph[tokenId][otherId];
          mutated = true;
        }
      }
      if (Object.keys(graph[tokenId]).length === 0) {
        delete graph[tokenId];
        mutated = true;
      }
    }

    if (mutated) await this._setGraph(graph);
    return mutated;
  }

  /**
   * Clear all engagement state. Called on combat end.
   */
  async clear() {
    return this.combat.unsetFlag(MODULE_ID, FLAGS.ENGAGEMENTS);
  }

  /**
   * Get the active EngagementTracker for the current scene's active combat,
   * or null if no combat is active. Convenience helper.
   */
  static current() {
    const combat = game.combat;
    if (!combat?.started) return null;
    return new EngagementTracker(combat);
  }
}
