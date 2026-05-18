import { EXCLUDED_CONDITIONS, OUTNUMBERING_BONUSES } from "./constants.js";

/**
 * Outnumbering calculation per WFRP4e Core p.161:
 *   "If you out-number an opponent 2 to 1, you gain a bonus of +20 to hit your
 *    opponent in melee combat. If you outnumber an enemy by 3 to 1, you get an
 *    even larger bonus of +40 to hit."
 *
 * The ratio is determined by Engaged participants (Core p.161, last paragraph
 * of Outnumbering: "Outnumbering is generally determined by how many Characters
 * are Engaged with each other").
 *
 * Algorithm: when attacker A targets defender D --
 *   1. Side A = {A} ∪ (allies of A engaged with D)
 *   2. Side D = {D} ∪ (allies of D engaged with A)
 *   3. Filter both sides for fighting-condition tokens.
 *   4. Ratio = |Side A| / |Side D|. Apply the highest matching bonus.
 *
 * Allies are determined by token disposition (matching positive/negative sign).
 */

/**
 * Are two tokens allied?
 *
 * The Outnumbering rule (Core p.161) cares about which tokens belong to
 * which "side" of a melee. Two tokens are allies if any of:
 *
 *   1. Direct disposition match. Both FRIENDLY, both HOSTILE, etc.
 *   2. Direct mount relationship. A rider and their mount are allies.
 *   3. Transitive via mount. If A is the mount of someone whose disposition
 *      matches B, then A and B are allies — A inherits its rider's "side."
 *
 * The transitive rule is what makes a NEUTRAL warhorse count as a FRIENDLY
 * combatant when ridden by a FRIENDLY PC. Without it, the warhorse would
 * fail the disposition match and be skipped from outnumbering.
 *
 * IMPORTANT: the transitive rule only fires when one token is actually IN a
 * mount relationship. Two random NEUTRAL tokens that happen to share
 * disposition with a mount somewhere on the canvas don't become allies —
 * the transitive rule needs A or B to BE the mount/rider, not just match it.
 */
export function areAllied(tokenA, tokenB) {
  if (!tokenA || !tokenB) return false;
  if (tokenA.id === tokenB.id) return true;

  // Direct disposition match
  if (tokenA.document.disposition === tokenB.document.disposition) return true;

  // Direct mount relationship (one rides the other)
  if (isMountOf(tokenA, tokenB)) return true;
  if (isMountOf(tokenB, tokenA)) return true;

  // Transitive: if A is a mount, treat A as having the disposition of any
  // of its riders. Symmetric for B.
  //
  // NOTE: we only inherit "upward" — a mount inherits its rider's allyships
  // (because the mount IS part of the rider's combatant unit). We do NOT
  // inherit "downward" — a rider doesn't gain allyships from their mount's
  // disposition. That asymmetry matters: a FRIENDLY PC riding a NEUTRAL
  // warhorse should not become allied with random NEUTRAL bystanders.
  const ridersOfA = getRiders(tokenA);
  for (const riderA of ridersOfA) {
    if (riderA.document.disposition === tokenB.document.disposition) return true;
  }
  const ridersOfB = getRiders(tokenB);
  for (const riderB of ridersOfB) {
    if (riderB.document.disposition === tokenA.document.disposition) return true;
  }

  return false;
}

/**
 * Get all tokens currently riding `mountToken`. Returns Token placeables.
 */
function getRiders(mountToken) {
  if (!mountToken) return [];
  const ids = mountToken.document?.flags?.Rideable?.RidersFlag;
  if (!Array.isArray(ids)) return [];
  return ids.map(id => canvas.tokens?.get(id)).filter(Boolean);
}

/**
 * Get the mount that `riderToken` is currently riding. Returns Token placeable
 * or null.
 */
function getMount(riderToken) {
  if (!riderToken) return null;
  // Check Rideable PreviousIDFlag
  const mountTokenId = riderToken.document?.flags?.Rideable?.PreviousIDFlag;
  if (mountTokenId) {
    const t = canvas.tokens?.get(mountTokenId);
    if (t) return t;
  }
  // Check WFRP4e native mount.id (this is an actor id, not a token id)
  const mountActorId = riderToken.actor?.system?.status?.mount?.id
    ?? riderToken.actor?.system?.status?.mount;
  if (mountActorId) {
    // Find any token with that actor on the canvas
    for (const t of canvas.tokens?.placeables ?? []) {
      if (t.actor?.id === mountActorId) return t;
    }
  }
  return null;
}

/**
 * Is `mountToken` the mount of `riderToken`? Checks both WFRP4e's native
 * mount data and the Rideable module's flags. Returns true if either says yes.
 */
export function isMountOf(mountToken, riderToken) {
  if (!mountToken || !riderToken) return false;

  // WFRP4e native: rider's actor.system.status.mount.id == mount's actor id
  const riderMountActorId = riderToken.actor?.system?.status?.mount?.id
    ?? riderToken.actor?.system?.status?.mount;
  if (riderMountActorId && mountToken.actor?.id === riderMountActorId) return true;

  // Rideable module — note the capital R on the namespace
  const mountFlags = mountToken.document?.flags?.Rideable;
  if (mountFlags) {
    const riders = mountFlags.RidersFlag;
    if (Array.isArray(riders) && riders.includes(riderToken.id)) return true;
  }

  // Inverse direction
  const riderFlags = riderToken.document?.flags?.Rideable;
  if (riderFlags) {
    if (riderFlags.PreviousIDFlag === mountToken.id) return true;
  }

  return false;
}

/**
 * Is this token in fighting condition? Excludes tokens whose status set
 * contains any condition ID in EXCLUDED_CONDITIONS (currently unconscious,
 * dead, defeated). Per Core p.168, Broken/Fleeing characters can still be
 * engaged with enemies and DO count for outnumbering \u2014 they're still
 * occupying space and forcing opponents to deal with them. Prone and Stunned
 * also count as engaged threats (they can still throw a punch from the floor).
 *
 * WFRP4e stores conditions on actor.effects with statuses set. We check both
 * actor.statuses (V12+ canonical location) and effect.statuses for safety.
 */
export function isInFightingCondition(token) {
  if (!token?.actor) return false;

  // V12+: actor.statuses is a Set of active condition IDs.
  const statuses = token.actor.statuses;
  if (statuses instanceof Set) {
    for (const condId of EXCLUDED_CONDITIONS) {
      if (statuses.has(condId)) return false;
    }
    return true;
  }

  // Fallback: scan effects for status IDs.
  for (const effect of token.actor.effects ?? []) {
    const effectStatuses = effect.statuses ?? new Set();
    for (const condId of EXCLUDED_CONDITIONS) {
      if (effectStatuses.has(condId)) return false;
    }
  }
  return true;
}

/**
 * Resolve a token ID against the current scene. Returns the Token (placeable)
 * or null if not on canvas.
 */
function resolveToken(tokenId) {
  return canvas.tokens?.get(tokenId) ?? null;
}

/**
 * Compute the outnumbering bonus for an attack from `attackerToken` against
 * `defenderToken`, using the current engagement tracker.
 *
 * Returns:
 *   {
 *     bonus: number,           // 0, 20, or 40
 *     attackerSideCount: number,
 *     defenderSideCount: number,
 *     ratio: string,           // e.g. "2:1", "3:1", "1:1"
 *     attackerSideTokens: Token[],
 *     defenderSideTokens: Token[],
 *   }
 */
export function calculateOutnumbering(attackerToken, defenderToken, tracker) {
  const result = {
    bonus: 0,
    attackerSideCount: 1,
    defenderSideCount: 1,
    ratio: "1:1",
    attackerSideTokens: [attackerToken].filter(Boolean),
    defenderSideTokens: [defenderToken].filter(Boolean),
  };

  if (!attackerToken || !defenderToken || !tracker) return result;

  // Side A: attacker + their allies engaged with the defender.
  const defenderEngagements = tracker.getEngagementsFor(defenderToken.id);
  const attackerSide = [attackerToken];
  for (const otherId of defenderEngagements) {
    if (otherId === attackerToken.id) continue;
    const other = resolveToken(otherId);
    if (!other) continue;
    if (!areAllied(attackerToken, other)) continue;
    if (!isInFightingCondition(other)) continue;
    attackerSide.push(other);
  }

  // Side D: defender + their allies engaged with the attacker.
  // This treats physically-intertwined melees as one fight: if the attacker
  // is engaged with multiple enemies, all of those enemies (and any of the
  // defender's allies among them) count on the defender's side.
  const attackerEngagements = tracker.getEngagementsFor(attackerToken.id);
  const defenderSide = [defenderToken];
  for (const otherId of attackerEngagements) {
    if (otherId === defenderToken.id) continue;
    const other = resolveToken(otherId);
    if (!other) continue;
    if (!areAllied(defenderToken, other)) continue;
    if (!isInFightingCondition(other)) continue;
    defenderSide.push(other);
  }

  // Defender themselves must be checked too — if they're unconscious, the
  // attack auto-hits per the Helpless Targets rule (Core p.162) and
  // outnumbering is moot. We still report the count truthfully.
  const defenderFit = isInFightingCondition(defenderToken);

  result.attackerSideCount = attackerSide.length;
  result.defenderSideCount = defenderFit ? defenderSide.length : Math.max(0, defenderSide.length - 1);
  result.attackerSideTokens = attackerSide;
  result.defenderSideTokens = defenderSide;
  result.ratio = `${result.attackerSideCount}:${Math.max(1, result.defenderSideCount)}`;

  if (result.defenderSideCount <= 0) return result;

  // Apply the highest threshold met.
  const ratio = result.attackerSideCount / result.defenderSideCount;
  for (const { ratio: threshold, bonus } of OUTNUMBERING_BONUSES) {
    if (ratio >= threshold) {
      result.bonus = bonus;
      break;
    }
  }

  return result;
}
