import { MODULE_ID } from "./constants.js";
import { EngagementTracker } from "./engagement-tracker.js";

/**
 * Combat lifecycle hooks for engagement state management.
 *
 * The "if you don't attack each other for a full Round, you are no longer
 * Engaged" rule (Core p.159) is implemented at the start of each new round
 * via the combatRound hook. See EngagementTracker.pruneStale for the timing
 * logic.
 */

/**
 * Hook: combatRound
 *
 * Fired when the round counter advances. We prune engagements that have gone
 * stale. Foundry fires combatRound on all clients but only the GM should
 * mutate the combat document — so we gate on isFirstGM() to avoid races.
 */
export async function onCombatRound(combat, updateData, updateOptions) {
  try {
    if (!game.user.isGM) return;
    if (!game.users.activeGM || game.users.activeGM.id !== game.user.id) return;
    if (!combat?.started) return;

    const tracker = new EngagementTracker(combat);
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
 * Hook: deleteCombat
 *
 * Combat ended (or was deleted). The flag dies with the combat document, so
 * there's actually nothing to clean up — but we log for clarity.
 */
export function onDeleteCombat(combat) {
  console.log(`${MODULE_ID} | Combat ended; engagement state cleared with combat document.`);
}

/**
 * Hook: deleteToken
 *
 * If a token is removed from the scene mid-combat, drop all its engagements.
 * This catches the "killed monster" case as well as scene changes.
 */
export async function onDeleteToken(tokenDoc) {
  try {
    if (!game.user.isGM) return;
    if (!game.users.activeGM || game.users.activeGM.id !== game.user.id) return;

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
