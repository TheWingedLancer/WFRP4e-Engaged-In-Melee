import { MODULE_ID } from "./constants.js";
import { EngagementTracker } from "./engagement-tracker.js";

/**
 * Combat lifecycle hooks for engagement state management.
 *
 * Engagement state lives on the scene (not the Combat document) so it works
 * for both formal Combat-Tracker fights and informal skirmishes. The
 * combatRound hook just provides a convenient signal for round-based
 * pruning per Core p.159; out-of-combat skirmish engagements are pruned by
 * wall-clock time instead (see roll-hooks.js).
 */

/**
 * Helper: only the active GM should mutate state, to avoid races.
 */
function shouldHandleStateChange() {
  if (!game.user.isGM) return false;
  if (!game.users.activeGM) return true; // No active GM check available; proceed
  return game.users.activeGM.id === game.user.id;
}

/**
 * Hook: combatRound - prune engagements that went a full round without an
 * attack, per Core p.159.
 */
export async function onCombatRound(combat, updateData, updateOptions) {
  try {
    if (!shouldHandleStateChange()) return;
    if (!combat?.started) return;

    const tracker = EngagementTracker.current();
    if (!tracker) return;

    const newRound = updateData.round ?? combat.round;
    const pruned = await tracker.pruneStale(newRound);
    if (pruned) {
      console.log(`${MODULE_ID} | Pruned stale engagements at start of round ${newRound}`);
    }
  } catch (err) {
    console.error(`${MODULE_ID} | combatRound hook error:`, err);
  }
}

/**
 * Hook: deleteCombat - clear in-combat engagements when combat ends. Skirmish
 * (round=0) engagements are preserved since they're managed by wall-clock TTL.
 *
 * Actually: when combat ends, the simplest expectation is that all engagements
 * clear. A round=0 engagement only existed because there was no combat at the
 * time; if combat just ended, those weren't in play. So clear everything.
 */
export async function onDeleteCombat(combat) {
  try {
    if (!shouldHandleStateChange()) return;
    const tracker = EngagementTracker.current();
    if (!tracker) return;
    await tracker.clear();
    console.log(`${MODULE_ID} | Combat ended; engagement state cleared.`);
  } catch (err) {
    console.error(`${MODULE_ID} | deleteCombat hook error:`, err);
  }
}

/**
 * Hook: deleteToken - drop all engagements involving a deleted token.
 */
export async function onDeleteToken(tokenDoc) {
  try {
    if (!shouldHandleStateChange()) return;

    const tracker = EngagementTracker.current();
    if (!tracker) return;
    const engaged = tracker.getEngagementsFor(tokenDoc.id);
    if (engaged.length === 0) return;
    await tracker.disengage(tokenDoc.id);
    console.log(`${MODULE_ID} | Cleared engagements for deleted token ${tokenDoc.id}`);
  } catch (err) {
    console.error(`${MODULE_ID} | deleteToken hook error:`, err);
  }
}
