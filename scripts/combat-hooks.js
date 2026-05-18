import { MODULE_ID, EXCLUDED_CONDITIONS } from "./constants.js";
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

/**
 * Hook: createActiveEffect - immediately drop all engagement edges when a
 * token transitions to an incapacitating condition (dead, unconscious,
 * defeated). This clears the Engaged status icon at the moment of death
 * instead of waiting for the next move, which was the v0.1.26 behavior.
 *
 * Rationale: visually, an Engaged icon on a fighter whose only opponent
 * just hit the dirt is confusing. The math was already correct (the
 * EXCLUDED_CONDITIONS exclusion in outnumbering.js handles that), but the
 * UI lagged by one action. This hook closes that gap.
 *
 * Note on the reverse transition: nothing here re-establishes engagement
 * when an actor recovers from incapacitation. Engagement is established by
 * attacks (per Core p.159); if a healed orc wants to fight again, they
 * (or someone) need to swing. That's the correct rule, and matches our
 * design throughout.
 *
 * Active-GM gated to avoid duplicate graph writes across clients.
 */
export async function onCreateActiveEffect(effect) {
  try {
    if (!shouldHandleStateChange()) return;

    // Filter: only act on effects that bring an excluded condition with them.
    // Most ActiveEffects (weapon traits, talents, custom buffs) have an empty
    // or non-overlapping statuses set and should be ignored.
    const effectStatuses = effect.statuses;
    if (!(effectStatuses instanceof Set) || effectStatuses.size === 0) return;
    let triggers = false;
    for (const condId of EXCLUDED_CONDITIONS) {
      if (effectStatuses.has(condId)) {
        triggers = true;
        break;
      }
    }
    if (!triggers) return;

    // Find the actor this effect applies to. Effects can be on actors
    // directly or on items (which then propagate to the actor). We care
    // only about the actor case; item-effect-on-actor still surfaces as
    // an effect whose parent is the actor.
    const actor = effect.parent;
    if (!actor || actor.documentName !== "Actor") return;

    // Find the canvas token(s) for this actor on the current scene. Most
    // setups have one token per actor, but unlinked actors can have several;
    // we'd drop edges for whichever one(s) are present.
    const tokens = canvas.tokens?.placeables?.filter((t) => t.actor === actor) ?? [];
    if (tokens.length === 0) return; // Actor has no token on current scene

    const tracker = EngagementTracker.current();
    if (!tracker) return;

    for (const token of tokens) {
      const engaged = tracker.getEngagementsFor(token.id);
      if (engaged.length === 0) continue;
      await tracker.disengage(token.id);
      console.log(
        `${MODULE_ID} | createActiveEffect: ${token.name} became incapacitated; cleared ${engaged.length} engagement edge(s)`
      );
    }
  } catch (err) {
    console.error(`${MODULE_ID} | createActiveEffect hook error:`, err);
  }
}
