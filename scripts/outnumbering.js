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
 * Are two tokens allied? Allies share the same disposition sign.
 *  - FRIENDLY (1) and FRIENDLY (1) -> allies
 *  - HOSTILE (-1) and HOSTILE (-1) -> allies
 *  - NEUTRAL (0) is its own bucket; two NEUTRALs are allies, but a NEUTRAL
 *    is not allied with FRIENDLY or HOSTILE.
 *  - SECRET (-2) is treated as its own bucket too.
 *
 * NOTE: this means a HOSTILE goblin attacking another HOSTILE goblin would
 * still treat surrounding HOSTILE allies as helping. That's intentional —
 * disposition is about which "side" a token is on, and infighting between
 * hostiles is rare. The GM can resolve edge cases manually.
 */
export function areAllied(tokenA, tokenB) {
  if (!tokenA || !tokenB) return false;
  if (tokenA.id === tokenB.id) return true;
  return tokenA.document.disposition === tokenB.document.disposition;
}

/**
 * Is this token in fighting condition? Excludes Unconscious and Fleeing.
 * Per the user's design choice, Prone and Stunned still count as engaged
 * threats (they can still throw a punch from the floor).
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
  const attackerEngagements = tracker.getEngagementsFor(attackerToken.id);
  const defenderSide = [defenderToken];
  for (const otherId of attackerEngagements) {
    if (otherId === defenderToken.id) continue;
    const other = resolveToken(otherId);
    if (!other) continue;
    if (!areAllied(defenderToken, other)) continue;
    // The defender's side is allowed to include unconscious/fleeing tokens for
    // the purposes of REDUCING the attacker's outnumbering ratio? No — RAW
    // says outnumbering is about engaged characters, and an unconscious ally
    // doesn't help defend either. Filter consistently.
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
