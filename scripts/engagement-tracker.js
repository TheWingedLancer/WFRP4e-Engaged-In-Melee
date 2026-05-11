import { MODULE_ID, FLAGS, ENGAGED_STATUS_ID } from "./constants.js";

const SOCKET_NAMESPACE = `module.${MODULE_ID}`;

/**
 * Helper: check if we are the active GM (the one client that should perform
 * authoritative writes). Other GMs (if any are connected) and player clients
 * route writes through this client via socket.
 */
function isActiveGM() {
  return Boolean(
    game.user?.isGM &&
    game.users?.activeGM &&
    game.users.activeGM.id === game.user.id
  );
}

/**
 * Helper: check if there's an active GM available to receive socket messages.
 * If not, writes from non-GM clients have nowhere to go.
 */
function hasActiveGM() {
  return Boolean(game.users?.activeGM);
}

// ============================================================================
// SOCKET LAYER
// ============================================================================

/**
 * Register the GM-side socket listener. Called from main.js's ready hook.
 * Listens for engagement-tracker messages and applies the authoritative
 * mutation on behalf of player clients (who lack scene/actor write
 * permissions).
 *
 * Actions handled:
 *   - "setEngagedStatus":  toggle Engaged status effect on an actor
 *   - "engage":            add an engagement edge to the graph
 *   - "disengage":         remove an engagement edge (or all edges of a token)
 *   - "pruneStale":        round-based stale-engagement pruning
 *   - "pruneStaleByTime":  wall-clock stale-engagement pruning
 *   - "clear":             clear the entire engagement graph
 */
export function registerEngagedStatusSocket() {
  game.socket.on(SOCKET_NAMESPACE, async (msg) => {
    // Always log received messages for diagnostics
    console.log(`${MODULE_ID} | SOCKET RECEIVED on ${game.user.name} (isGM=${game.user.isGM}, isActiveGM=${isActiveGM()}):`, msg);

    if (!msg || !msg.action) return;
    // Only the active GM responds, so we don't double-apply when multiple GMs
    // are connected.
    if (!isActiveGM()) {
      console.log(`${MODULE_ID} | SOCKET ignored (not active GM): ${msg.action}`);
      return;
    }

    console.log(`${MODULE_ID} | SOCKET handling ${msg.action} as active GM`);

    try {
      switch (msg.action) {
        case "setEngagedStatus":
          await applyEngagedStatusLocally(msg.tokenId, msg.active);
          break;
        case "engage":
          await performEngageLocally(msg.sceneId, msg.tokenIdA, msg.tokenIdB, msg.round);
          break;
        case "disengage":
          await performDisengageLocally(msg.sceneId, msg.tokenIdA, msg.tokenIdB);
          break;
        case "pruneStale":
          await performPruneStaleLocally(msg.sceneId, msg.currentRound);
          break;
        case "pruneStaleByTime":
          await performPruneStaleByTimeLocally(msg.sceneId, msg.maxAgeSeconds);
          break;
        case "clear":
          await performClearLocally(msg.sceneId);
          break;
        case "setActorAdvantageDelta":
          await performActorAdvantageDeltaLocally(msg.tokenId, msg.delta);
          break;
        default:
          break;
      }
      console.log(`${MODULE_ID} | SOCKET completed ${msg.action}`);
    } catch (e) {
      console.error(`${MODULE_ID} | socket handler for ${msg.action} failed:`, e);
    }
  });
  console.log(`${MODULE_ID} | Socket listener registered on ${game.user.name} (namespace: ${SOCKET_NAMESPACE})`);
}

function getSceneById(sceneId) {
  return game.scenes?.get(sceneId) ?? null;
}

// ============================================================================
// STATUS EFFECT (ENGAGED) \u2014 authoritative mutation
// ============================================================================

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

async function setEngagedStatus(tokenId, active) {
  try {
    const token = canvas?.tokens?.get(tokenId);
    if (!token?.actor) return;

    if (token.actor.isOwner) {
      await applyEngagedStatusLocally(tokenId, active);
      return;
    }

    if (!hasActiveGM()) return;
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

// ============================================================================
// AUTHORITATIVE GRAPH MUTATIONS (run on the active GM client only)
// ============================================================================

function readGraph(scene) {
  const stored = scene.getFlag(MODULE_ID, FLAGS.ENGAGEMENTS);
  return stored ? foundry.utils.deepClone(stored) : {};
}

async function writeGraph(scene, graph) {
  await scene.unsetFlag(MODULE_ID, FLAGS.ENGAGEMENTS);
  if (!graph || Object.keys(graph).length === 0) return null;
  return scene.setFlag(MODULE_ID, FLAGS.ENGAGEMENTS, graph);
}

async function performEngageLocally(sceneId, tokenIdA, tokenIdB, round = 0) {
  if (tokenIdA === tokenIdB) return;
  const scene = getSceneById(sceneId);
  if (!scene) return;

  const graph = readGraph(scene);
  const stamp = { round, timestamp: Date.now() };
  if (!graph[tokenIdA]) graph[tokenIdA] = {};
  if (!graph[tokenIdB]) graph[tokenIdB] = {};
  graph[tokenIdA][tokenIdB] = stamp;
  graph[tokenIdB][tokenIdA] = stamp;
  await writeGraph(scene, graph);

  await applyEngagedStatusLocally(tokenIdA, true);
  await applyEngagedStatusLocally(tokenIdB, true);
}

async function performDisengageLocally(sceneId, tokenIdA, tokenIdB = null) {
  const scene = getSceneById(sceneId);
  if (!scene) return;

  const graph = readGraph(scene);
  const affectedIds = new Set([tokenIdA]);

  if (tokenIdB === null || tokenIdB === undefined) {
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
  await writeGraph(scene, graph);

  for (const id of affectedIds) {
    if (!graph[id] || Object.keys(graph[id]).length === 0) {
      await applyEngagedStatusLocally(id, false);
    }
  }
}

async function performPruneStaleLocally(sceneId, currentRound) {
  const scene = getSceneById(sceneId);
  if (!scene) return false;

  const graph = readGraph(scene);
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
    await writeGraph(scene, graph);
    for (const id of affectedIds) {
      if (!graph[id] || Object.keys(graph[id]).length === 0) {
        await applyEngagedStatusLocally(id, false);
      }
    }
  }
  return mutated;
}

async function performPruneStaleByTimeLocally(sceneId, maxAgeSeconds) {
  const scene = getSceneById(sceneId);
  if (!scene) return false;

  const graph = readGraph(scene);
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
    await writeGraph(scene, graph);
    for (const id of affectedIds) {
      if (!graph[id] || Object.keys(graph[id]).length === 0) {
        await applyEngagedStatusLocally(id, false);
      }
    }
  }
  return mutated;
}

async function performClearLocally(sceneId) {
  const scene = getSceneById(sceneId);
  if (!scene) return;

  const graph = readGraph(scene);
  for (const tokenId of Object.keys(graph)) {
    await applyEngagedStatusLocally(tokenId, false);
  }
  await scene.unsetFlag(MODULE_ID, FLAGS.ENGAGEMENTS);
}

/**
 * Apply a delta to a token's Advantage, clamped to >= 0. Called on the GM
 * client (which has write permission on any actor) or directly on an owner
 * client. Returns the new value, or null if the token couldn't be found.
 *
 * Used by the Dodge-Disengage and Flee flows when a player-driven client
 * needs to mutate Advantage on a GM-owned opponent (or vice versa): the
 * caller checks isOwner on the actor and routes through the socket if not.
 */
async function performActorAdvantageDeltaLocally(tokenId, delta) {
  const token = canvas.tokens?.get(tokenId);
  if (!token?.actor) {
    console.warn(`${MODULE_ID} | performActorAdvantageDeltaLocally: token ${tokenId} not found or has no actor`);
    return null;
  }
  const cur = Number(token.actor.system?.status?.advantage?.value ?? 0);
  const next = Math.max(0, cur + Number(delta || 0));
  try {
    await token.actor.update({ "system.status.advantage.value": next });
  } catch (e) {
    console.error(`${MODULE_ID} | failed to set Advantage on ${token.name}:`, e);
    return null;
  }
  return next;
}

/**
 * Public helper: adjust a token's Advantage by a delta. Runs locally if the
 * current client owns the actor; otherwise emits a socket message to the
 * active GM to perform the write.
 *
 * Returns void (fire-and-forget for the socket-routed case). Callers that
 * need the new value should either be GM-owners themselves or read it back
 * after a short delay.
 */
export async function applyActorAdvantageDelta(token, delta) {
  if (!token?.id) return;
  // Local write if we own the actor (covers GM and player-PC cases).
  if (token.actor?.isOwner) {
    await performActorAdvantageDeltaLocally(token.id, delta);
    return;
  }
  // Otherwise, route to the active GM via the existing socket namespace.
  console.log(`${MODULE_ID} | applyActorAdvantageDelta: emitting socket message to GM for ${token.name} delta=${delta}`);
  game.socket.emit(SOCKET_NAMESPACE, {
    action: "setActorAdvantageDelta",
    tokenId: token.id,
    delta: Number(delta || 0),
  });
}

// ============================================================================
// EngagementTracker \u2014 public API
// ============================================================================

/**
 * EngagementTracker manages the engagement graph for a scene.
 *
 * Reads work for any user. Writes route through the active GM via socket
 * when called from a non-GM client \u2014 player clients lack scene/actor
 * write permissions, so the GM client is the source of truth.
 */
export class EngagementTracker {
  constructor(scene) {
    if (!scene) throw new Error("EngagementTracker requires a Scene document");
    this.scene = scene;
  }

  _getGraph() {
    return readGraph(this.scene);
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

  async engage(tokenIdA, tokenIdB, round = 0) {
    if (tokenIdA === tokenIdB) return;
    if (isActiveGM()) {
      console.log(`${MODULE_ID} | engage: I am active GM, performing locally for ${tokenIdA} <-> ${tokenIdB}`);
      await performEngageLocally(this.scene.id, tokenIdA, tokenIdB, round);
      return;
    }
    if (!hasActiveGM()) {
      console.warn(`${MODULE_ID} | engage: NO ACTIVE GM, write skipped for ${tokenIdA} <-> ${tokenIdB}`);
      return;
    }
    console.log(`${MODULE_ID} | engage: emitting socket message to GM for ${tokenIdA} <-> ${tokenIdB} (sceneId=${this.scene.id})`);
    game.socket.emit(SOCKET_NAMESPACE, {
      action: "engage",
      sceneId: this.scene.id,
      tokenIdA,
      tokenIdB,
      round,
    });
    // The GM's authoritative handler will apply the Engaged status effect to
    // both tokens via performEngageLocally -> applyEngagedStatusLocally. We do
    // NOT optimistically apply here: that previously caused a race where the
    // GM client ran applyEngagedStatusLocally twice back-to-back for non-owned
    // actors (once via socket-routed setEngagedStatus, once via
    // performEngageLocally), resulting in duplicate Engaged status effects.
    // The socket round-trip is fast enough on Forge that the Engaged icon
    // appears within ~100ms — imperceptible in normal play.
  }

  async disengage(tokenIdA, tokenIdB = null) {
    if (isActiveGM()) {
      await performDisengageLocally(this.scene.id, tokenIdA, tokenIdB);
      return;
    }
    if (!hasActiveGM()) return;
    game.socket.emit(SOCKET_NAMESPACE, {
      action: "disengage",
      sceneId: this.scene.id,
      tokenIdA,
      tokenIdB,
    });
  }

  async pruneStale(currentRound) {
    if (isActiveGM()) {
      return performPruneStaleLocally(this.scene.id, currentRound);
    }
    if (!hasActiveGM()) return false;
    game.socket.emit(SOCKET_NAMESPACE, {
      action: "pruneStale",
      sceneId: this.scene.id,
      currentRound,
    });
    return false;
  }

  async pruneStaleByTime(maxAgeSeconds) {
    if (isActiveGM()) {
      return performPruneStaleByTimeLocally(this.scene.id, maxAgeSeconds);
    }
    if (!hasActiveGM()) return false;
    game.socket.emit(SOCKET_NAMESPACE, {
      action: "pruneStaleByTime",
      sceneId: this.scene.id,
      maxAgeSeconds,
    });
    return false;
  }

  async clear() {
    if (isActiveGM()) {
      return performClearLocally(this.scene.id);
    }
    if (!hasActiveGM()) return;
    game.socket.emit(SOCKET_NAMESPACE, {
      action: "clear",
      sceneId: this.scene.id,
    });
  }

  static current() {
    const scene = canvas?.scene ?? game.scenes?.viewed ?? game.scenes?.active;
    if (!scene) return null;
    return new EngagementTracker(scene);
  }
}
