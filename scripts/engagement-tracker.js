import { MODULE_ID, FLAGS } from "./constants.js";

/**
 * EngagementTracker
 *
 * Manages the engagement graph for the current scene. Two tokens are
 * "Engaged" (Core p.159) when they have attacked each other in melee and the
 * relationship has not yet gone stale (no attack between them for a full
 * Round, or - when no Combat Tracker is running - for the configured
 * staleness window in real seconds).
 *
 * STORAGE MODEL: The engagement graph is persisted as a flag on the active
 * Scene document. This means:
 *
 *   - Engagement state survives page reloads.
 *   - It syncs to all clients via Foundry's normal document update mechanism.
 *   - It works whether or not the Combat Tracker is running. WFRP4e tables
 *     frequently run "skirmishes" without a formal Combat document, and the
 *     module should support that.
 *   - State is per-scene, which is what we want: tokens on different scenes
 *     can't be in the same melee.
 *
 * The graph is a symmetric edge map:
 *   {
 *     [tokenId]: {
 *       [otherTokenId]: { round: number, timestamp: number }
 *     }
 *   }
 *
 * `round` is the Combat round when the engagement was established (or 0 if
 * outside Combat). `timestamp` is the Date.now() of the establishment, used
 * for wall-clock staleness when there's no Combat to provide round numbers.
 */
export class EngagementTracker {
  constructor(scene) {
    if (!scene) throw new Error("EngagementTracker requires a Scene document");
    this.scene = scene;
  }

  _getGraph() {
    const stored = this.scene.getFlag(MODULE_ID, FLAGS.ENGAGEMENTS);
    return stored ? foundry.utils.deepClone(stored) : {};
  }

  /**
   * Persist the graph to scene flags.
   *
   * IMPORTANT — Foundry setFlag semantics: setFlag uses mergeObject, which
   * means new keys are added and existing keys are overwritten, but keys
   * that are MISSING from the new value are NOT removed from the stored
   * flag. So if you `delete graph[a][b]` and then call setFlag, the stored
   * flag still has `[a][b]` from the previous write.
   *
   * To get true replacement semantics we unsetFlag first (clearing the old
   * value entirely) and then setFlag with the new graph. This is two writes
   * instead of one, but it's the only way to make deletions stick.
   *
   * If the new graph is empty, we just unsetFlag and skip the setFlag write.
   */
  async _setGraph(graph) {
    await this.scene.unsetFlag(MODULE_ID, FLAGS.ENGAGEMENTS);
    if (!graph || Object.keys(graph).length === 0) return null;
    return this.scene.setFlag(MODULE_ID, FLAGS.ENGAGEMENTS, graph);
  }

  getEngagementsFor(tokenId) {
    const graph = this._getGraph();
    const node = graph[tokenId];
    if (!node) return [];
    return Object.keys(node);
  }

  areEngaged(tokenIdA, tokenIdB) {
    const graph = this._getGraph();
    return Boolean(graph[tokenIdA]?.[tokenIdB]);
  }

  /**
   * Mark two tokens as engaged. Symmetric.
   */
  async engage(tokenIdA, tokenIdB, round = 0) {
    if (tokenIdA === tokenIdB) return;
    const graph = this._getGraph();
    const stamp = { round, timestamp: Date.now() };
    if (!graph[tokenIdA]) graph[tokenIdA] = {};
    if (!graph[tokenIdB]) graph[tokenIdB] = {};
    graph[tokenIdA][tokenIdB] = stamp;
    graph[tokenIdB][tokenIdA] = stamp;
    await this._setGraph(graph);
  }

  /**
   * Remove an engagement. If `tokenIdB` is omitted, drop all edges touching
   * tokenIdA.
   */
  async disengage(tokenIdA, tokenIdB = null) {
    const graph = this._getGraph();
    if (tokenIdB === null) {
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
   * Round-based pruning. Per Core p.159: if a full Round passes without an
   * attack between two combatants, they're no longer Engaged.
   * Only affects engagements established with round > 0 (in combat).
   */
  async pruneStale(currentRound) {
    const graph = this._getGraph();
    let mutated = false;
    const cutoff = currentRound - 2;

    for (const [tokenId, edges] of Object.entries(graph)) {
      for (const [otherId, stamp] of Object.entries(edges)) {
        if (stamp.round > 0 && stamp.round <= cutoff) {
          delete graph[tokenId][otherId];
          mutated = true;
        }
      }
      if (Object.keys(graph[tokenId] ?? {}).length === 0) {
        delete graph[tokenId];
        mutated = true;
      }
    }

    if (mutated) await this._setGraph(graph);
    return mutated;
  }

  /**
   * Wall-clock staleness pruning. Used for skirmish (out-of-combat)
   * engagements only. Triggered opportunistically before outnumbering
   * calculations rather than on a timer.
   */
  async pruneStaleByTime(maxAgeSeconds) {
    const graph = this._getGraph();
    let mutated = false;
    const cutoff = Date.now() - (maxAgeSeconds * 1000);

    for (const [tokenId, edges] of Object.entries(graph)) {
      for (const [otherId, stamp] of Object.entries(edges)) {
        if (stamp.round === 0 && stamp.timestamp < cutoff) {
          delete graph[tokenId][otherId];
          mutated = true;
        }
      }
      if (Object.keys(graph[tokenId] ?? {}).length === 0) {
        delete graph[tokenId];
        mutated = true;
      }
    }

    if (mutated) await this._setGraph(graph);
    return mutated;
  }

  async clear() {
    return this.scene.unsetFlag(MODULE_ID, FLAGS.ENGAGEMENTS);
  }

  /**
   * Get the active tracker for the currently viewed scene.
   */
  static current() {
    const scene = canvas?.scene ?? game.scenes?.viewed ?? game.scenes?.active;
    if (!scene) return null;
    return new EngagementTracker(scene);
  }
}
