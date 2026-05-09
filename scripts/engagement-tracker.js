import { MODULE_ID, FLAGS, ENGAGED_STATUS_ID } from "./constants.js";

const SOCKET_NAMESPACE = `module.${MODULE_ID}`;

/**
 * Register the GM-side socket listener. Called from main.js's ready hook.
 * Listens for "setEngagedStatus" messages and applies the status change on
 * behalf of player clients who lack actor ownership.
 *
 * Player clients send: { action: "setEngagedStatus", tokenId, active }
 * GM client applies the toggle if it's the active GM.
 */
export function registerEngagedStatusSocket() {
  game.socket.on(SOCKET_NAMESPACE, async (msg) => {
    if (!msg || msg.action !== "setEngagedStatus") return;
    // Only the active GM should respond to avoid double-application when
    // multiple GM clients are connected.
    if (!game.user.isGM) return;
    if (!game.users.activeGM || game.users.activeGM.id !== game.user.id) return;
    await applyEngagedStatusLocally(msg.tokenId, msg.active);
  });
}

/**
 * Apply the Engaged status toggle directly. Caller is responsible for
 * permission checks; this just performs the mutation.
 */
async function applyEngagedStatusLocally(tokenId, active) {
  try {
    const token = canvas?.tokens?.get(tokenId);
    if (!token?.actor) return;
    const has = token.actor.statuses?.has(ENGAGED_STATUS_ID);
    if (active && has) return;
    if (!active && !has) return;
    if (typeof token.actor.toggleStatusEffect === "function") {
      await token.actor.toggleStatusEffect(ENGAGED_STATUS_ID, { active });
    }
  } catch (e) {
    try {
      if (game.settings.get(MODULE_ID, "debug")) {
        console.warn(`${MODULE_ID} | applyEngagedStatusLocally(${tokenId}, ${active}) failed:`, e);
      }
    } catch (_) {}
  }
}

/**
 * Helper: toggle the Engaged visual status effect on a token's actor.
 *
 * Routing: ActiveEffect mutations require actor ownership. Player clients
 * trying to apply Engaged to a GM-owned actor (Orc, NPC) would get a
 * permission error. We use a socket message to route the request to the
 * active GM, who has permission for everything.
 *
 * On the GM's own client, we apply directly (no socket round-trip needed).
 *
 * Errors are swallowed so a missing visual indicator never breaks the
 * engagement flow.
 */
async function setEngagedStatus(tokenId, active) {
  try {
    const token = canvas?.tokens?.get(tokenId);
    if (!token?.actor) return;

    // If this user owns the actor, apply directly (avoids socket round-trip).
    if (token.actor.isOwner) {
      await applyEngagedStatusLocally(tokenId, active);
      return;
    }

    // Otherwise, route the request to the active GM via socket.
    // The GM's socket listener (registerEngagedStatusSocket) handles it.
    if (!game.users.activeGM) {
      // No GM connected \u2014 nothing we can do. Silent fail.
      return;
    }
    game.socket.emit(SOCKET_NAMESPACE, {
      action: "setEngagedStatus",
      tokenId,
      active,
    });
  } catch (e) {
    try {
      if (game.settings.get(MODULE_ID, "debug")) {
        console.warn(`${MODULE_ID} | setEngagedStatus(${tokenId}, ${active}) failed:`, e);
      }
    } catch (_) {}
  }
}

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
   * Mark two tokens as engaged. Symmetric. Also applies the Engaged status
   * effect to both tokens for visual feedback.
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

    // Visual: both tokens are now engaged in melee.
    await setEngagedStatus(tokenIdA, true);
    await setEngagedStatus(tokenIdB, true);
  }

  /**
   * Remove an engagement. If `tokenIdB` is omitted, drop all edges touching
   * tokenIdA. Also removes the Engaged status effect from any token whose
   * last edge was just dropped.
   */
  async disengage(tokenIdA, tokenIdB = null) {
    const graph = this._getGraph();
    const affectedIds = new Set([tokenIdA]);
    if (tokenIdB === null) {
      for (const otherId of Object.keys(graph[tokenIdA] ?? {})) {
        affectedIds.add(otherId);
        if (graph[otherId]) delete graph[otherId][tokenIdA];
        if (graph[otherId] && Object.keys(graph[otherId]).length === 0) {
          delete graph[otherId];
        }
      }
      delete graph[tokenIdA];
    } else {
      affectedIds.add(tokenIdB);
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

    // Visual: remove Engaged status from any token whose last edge was dropped.
    for (const id of affectedIds) {
      if (!graph[id] || Object.keys(graph[id]).length === 0) {
        await setEngagedStatus(id, false);
      }
    }
  }

  /**
   * Round-based pruning. Per Core p.159: if a full Round passes without an
   * attack between two combatants, they're no longer Engaged.
   * Only affects engagements established with round > 0 (in combat).
   * Also removes the Engaged status from any token whose last edge was pruned.
   */
  async pruneStale(currentRound) {
    const graph = this._getGraph();
    let mutated = false;
    const cutoff = currentRound - 2;
    const affectedIds = new Set();

    for (const [tokenId, edges] of Object.entries(graph)) {
      for (const [otherId, stamp] of Object.entries(edges)) {
        if (stamp.round > 0 && stamp.round <= cutoff) {
          delete graph[tokenId][otherId];
          affectedIds.add(tokenId);
          affectedIds.add(otherId);
          mutated = true;
        }
      }
      if (Object.keys(graph[tokenId] ?? {}).length === 0) {
        delete graph[tokenId];
        mutated = true;
      }
    }

    if (mutated) {
      await this._setGraph(graph);
      for (const id of affectedIds) {
        if (!graph[id] || Object.keys(graph[id]).length === 0) {
          await setEngagedStatus(id, false);
        }
      }
    }
    return mutated;
  }

  /**
   * Wall-clock staleness pruning. Used for skirmish (out-of-combat)
   * engagements only. Triggered opportunistically before outnumbering
   * calculations rather than on a timer. Also removes the Engaged status
   * from any token whose last edge was pruned.
   */
  async pruneStaleByTime(maxAgeSeconds) {
    const graph = this._getGraph();
    let mutated = false;
    const cutoff = Date.now() - (maxAgeSeconds * 1000);
    const affectedIds = new Set();

    for (const [tokenId, edges] of Object.entries(graph)) {
      for (const [otherId, stamp] of Object.entries(edges)) {
        if (stamp.round === 0 && stamp.timestamp < cutoff) {
          delete graph[tokenId][otherId];
          affectedIds.add(tokenId);
          affectedIds.add(otherId);
          mutated = true;
        }
      }
      if (Object.keys(graph[tokenId] ?? {}).length === 0) {
        delete graph[tokenId];
        mutated = true;
      }
    }

    if (mutated) {
      await this._setGraph(graph);
      for (const id of affectedIds) {
        if (!graph[id] || Object.keys(graph[id]).length === 0) {
          await setEngagedStatus(id, false);
        }
      }
    }
    return mutated;
  }

  async clear() {
    // Best-effort: remove Engaged from all currently-engaged tokens before clearing.
    const graph = this._getGraph();
    for (const tokenId of Object.keys(graph)) {
      await setEngagedStatus(tokenId, false);
    }
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
