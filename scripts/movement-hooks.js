import { MODULE_ID, SETTINGS } from "./constants.js";
import { EngagementTracker } from "./engagement-tracker.js";
import { getEngagementThreshold, getMoverInterceptThreshold } from "./reach.js";
import { openMovementTriggerDialog } from "./disengage-flee.js";

/**
 * Auto-disengage on movement.
 *
 * If a token moves to a position that is further than the engagement
 * threshold (the MAX of both combatants' weapon reaches) from any of its
 * engaged opponents, the edge to that opponent is dropped.
 *
 * Reach is determined by the longest-reach equipped melee weapon each token
 * carries. Per WFRP4e Core p.297:
 *   - Default reach (Personal through Long) = 2 yards
 *   - Very Long weapons (spear, lance) = 4 yards
 *   - Massive weapons (pike) = 6 yards
 *
 * Engagement is mutual: a halberdier with a Long weapon (default 2 yards)
 * fighting a pikeman with Massive (6 yards) is still engaged at up to 6
 * yards, because the pikeman can still threaten the halberdier even though
 * the halberdier can't reach back. The threshold uses MAX, not MIN.
 *
 * The user-configurable `autoDisengageDistance` setting now acts as a MINIMUM
 * floor for the threshold — useful if a GM wants to be more permissive than
 * the strict reach values would suggest, or for unusual table conventions.
 *
 * Hook: updateToken (V13). Fires on every position update including small
 * nudges. We gate on the active GM so only one client mutates state.
 */

/**
 * Compute distance in grid units between two token positions. We measure
 * between token centers using the V13 grid measurement API.
 */
function distanceBetween(tokenA, tokenB) {
  if (!tokenA || !tokenB || !canvas?.grid) return Infinity;
  const path = canvas.grid.measurePath([tokenA.center, tokenB.center]);
  // measurePath returns { distance, cost, ...} where distance is in scene units.
  return path?.distance ?? Infinity;
}

/**
 * Get the post-update token position. The updateToken hook fires *before* the
 * placeable's position is updated, so we compute from the changes object.
 */
function getProjectedToken(tokenDoc, changes) {
  const token = canvas.tokens?.get(tokenDoc.id);
  if (!token) return null;

  // If x/y didn't change, just return the live token.
  if (changes.x === undefined && changes.y === undefined) return token;

  // Build a synthetic object with the projected center. Token centers depend
  // on width/height (in grid squares), so we use the document's effective
  // dimensions from the changes (or fall back to current).
  const newX = changes.x ?? tokenDoc.x;
  const newY = changes.y ?? tokenDoc.y;
  const w = (changes.width ?? tokenDoc.width) * canvas.grid.sizeX;
  const h = (changes.height ?? tokenDoc.height) * canvas.grid.sizeY;
  return {
    id: tokenDoc.id,
    center: { x: newX + w / 2, y: newY + h / 2 },
  };
}

/**
 * Hook: updateToken — auto-disengage on movement.
 *
 * In V13, this hook fires AFTER the document has been updated, but the
 * Token placeable's visual `.center` may not have refreshed yet when the
 * hook fires synchronously. So we compute distance from the DOCUMENT's
 * new x/y (via getProjectedToken), not from `placeable.center`.
 *
 * V13 also fires updateToken for non-position events (movement history
 * clears, animation state, etc.) — we filter those out by requiring an
 * actual x or y change in `changes`.
 */
export async function onUpdateToken(tokenDoc, changes) {
  try {
    if (!game.user.isGM) return;
    if (!game.users.activeGM || game.users.activeGM.id !== game.user.id) return;
    if (!game.settings.get(MODULE_ID, SETTINGS.ENABLE_AUTO_TRACKING)) return;
    if (changes.x === undefined && changes.y === undefined) return;

    const tracker = EngagementTracker.current();
    if (!tracker) return;

    const engaged = tracker.getEngagementsFor(tokenDoc.id);
    if (engaged.length === 0) return;

    // Use the document's NEW position to compute the projected center,
    // because the placeable's visual `.center` may be stale at this point.
    const movedToken = canvas.tokens?.get(tokenDoc.id);
    if (!movedToken) return;
    const projected = getProjectedToken(tokenDoc, changes);
    if (!projected) return;

    const floorThreshold = game.settings.get(MODULE_ID, SETTINGS.AUTO_DISENGAGE_DISTANCE);

    if (game.settings.get(MODULE_ID, SETTINGS.DEBUG)) {
      console.log(`${MODULE_ID} | updateToken: ${movedToken.name} moved to projected center (${projected.center.x}, ${projected.center.y}); checking ${engaged.length} engagement(s)`);
    }

    for (const otherId of engaged) {
      const otherToken = canvas.tokens?.get(otherId);
      if (!otherToken) {
        // Other token isn't on this scene anymore — drop the edge.
        await tracker.disengage(tokenDoc.id, otherId);
        continue;
      }
      // Use the longer of the two combatants' weapon reaches, or the floor.
      const reachThreshold = getEngagementThreshold(movedToken, otherToken);
      const threshold = Math.max(reachThreshold, floorThreshold);
      // Distance computed from PROJECTED position (post-update doc state) to
      // the other token's current center.
      const dist = canvas.grid.measurePath([projected.center, otherToken.center])?.distance ?? Infinity;
      if (game.settings.get(MODULE_ID, SETTINGS.DEBUG)) {
        console.log(`${MODULE_ID} |   vs ${otherToken.name}: distance ${dist.toFixed(1)}yd, threshold ${threshold}yd, would disengage: ${dist > threshold}`);
      }
      if (dist > threshold) {
        await tracker.disengage(tokenDoc.id, otherId);
        if (game.settings.get(MODULE_ID, SETTINGS.DEBUG)) {
          console.log(`${MODULE_ID} | Auto-disengaged ${movedToken.name} from ${otherToken.name} (distance ${dist.toFixed(1)} > threshold ${threshold} [reach ${reachThreshold}, floor ${floorThreshold}])`);
        }
      }
    }
  } catch (err) {
    console.error(`${MODULE_ID} | updateToken hook error:`, err);
  }
}

/**
 * Hook: preUpdateToken \u2014 movement-trigger dialog.
 *
 * Fires BEFORE a token position update is committed. If the token is engaged
 * and the proposed move would leave at least one opponent's reach, we cancel
 * the move (return false) and asynchronously open a dialog letting the
 * player choose how to handle the disengagement (Drop Advantage, Roll Dodge,
 * Flee, or Cancel). The dialog flow re-issues the move with a bypass flag
 * after the player makes their choice.
 *
 * Skipped when:
 *   - Setting `enableMovementTrigger` is OFF
 *   - The update has the bypass flag set (set when we replay after dialog)
 *   - The token is not engaged with anyone
 *   - No proposed change to x/y (e.g., update changing other fields)
 *
 * NOTE: We do NOT skip GM-moved tokens. When a GM drags an engaged enemy
 * (Orc retreating from Tristan, etc.) the dialog should still appear because
 * that engagement should be resolved properly. If a GM wants to do scene
 * setup or unobstructed repositioning, they can temporarily disable the
 * `enableMovementTrigger` setting.
 *
 * Returning `false` cancels the update; Foundry handles the snap-back
 * automatically.
 */
export function onPreUpdateToken(tokenDoc, changes, options, userId) {
  try {
    const debug = game.settings.get(MODULE_ID, SETTINGS.DEBUG);

    // Only react to ACTUAL position changes. WFRP4e's attack resolution
    // updates token documents during animation/effect lifecycle and may
    // include x/y in the change set even when the values are unchanged. We
    // must compare the new value to the current document value, not just
    // check for presence in `changes`.
    if (changes.x === undefined && changes.y === undefined) return;
    const newX = changes.x ?? tokenDoc.x;
    const newY = changes.y ?? tokenDoc.y;
    if (newX === tokenDoc.x && newY === tokenDoc.y) {
      if (game.settings.get(MODULE_ID, SETTINGS.DEBUG)) {
        console.log(
          `${MODULE_ID} | preUpdateToken: ${tokenDoc.name} change includes x/y but values unchanged (no real movement); allowing`
        );
      }
      return;
    }

    if (debug) {
      console.log(
        `${MODULE_ID} | preUpdateToken FIRED for ${tokenDoc.name}: x=${changes.x ?? "(unchanged)"}, y=${changes.y ?? "(unchanged)"}, userId=${userId}, bypass=${options?.bypassEngagementCheck}`
      );
    }

    // Setting check
    if (!game.settings.get(MODULE_ID, SETTINGS.ENABLE_MOVEMENT_TRIGGER)) {
      if (debug) console.log(`${MODULE_ID} | preUpdateToken: setting disabled, allowing move`);
      return;
    }

    // Bypass flag from our own replay
    if (options?.bypassEngagementCheck) {
      if (debug) console.log(`${MODULE_ID} | preUpdateToken: bypass flag set, allowing move`);
      return;
    }

    const tracker = EngagementTracker.current();
    if (!tracker) {
      if (debug) console.log(`${MODULE_ID} | preUpdateToken: no tracker, allowing move`);
      return;
    }

    const engaged = tracker.getEngagementsFor(tokenDoc.id);
    if (engaged.length === 0) {
      if (debug) console.log(`${MODULE_ID} | preUpdateToken: ${tokenDoc.name} not engaged, allowing move`);
      return;
    }

    if (debug) {
      console.log(`${MODULE_ID} | preUpdateToken: ${tokenDoc.name} engaged with ${engaged.length} token(s); checking reach`);
    }

    // Compute the projected position and check per-opponent reach.
    const movedToken = canvas.tokens?.get(tokenDoc.id);
    if (!movedToken) return;
    const projected = getProjectedToken(tokenDoc, changes);
    if (!projected) return;

    const floorThreshold = game.settings.get(MODULE_ID, SETTINGS.AUTO_DISENGAGE_DISTANCE);
    const leavingOpponents = [];
    const stayingOpponents = [];

    for (const otherId of engaged) {
      const otherToken = canvas.tokens?.get(otherId);
      if (!otherToken) continue; // stale edge \u2014 will be cleaned up later
      // Use the OPPONENT's reach only (not max of both). The opponent can
      // only intercept the move if their weapon can reach the mover \u2014 a
      // dagger-wielder cannot stop a pike-wielder from stepping back, even
      // if the engagement was originally formed by the pike at long range.
      // The auto-disengage check in onUpdateToken still uses the symmetric
      // MAX threshold for dropping the edge, which is correct: engagement
      // ends when neither party can threaten the other.
      const reachThreshold = getMoverInterceptThreshold(movedToken, otherToken);
      const threshold = Math.max(reachThreshold, floorThreshold);
      const dist = canvas.grid.measurePath([projected.center, otherToken.center])?.distance ?? Infinity;
      if (dist > threshold) {
        leavingOpponents.push(otherToken);
      } else {
        stayingOpponents.push(otherToken);
      }
    }

    if (leavingOpponents.length === 0) {
      // Move stays within everyone's reach \u2014 allow it.
      return;
    }

    // Cancel the move. We'll replay it via tokenDoc.update with bypass flag
    // after the dialog resolves.
    if (game.settings.get(MODULE_ID, SETTINGS.DEBUG)) {
      console.log(
        `${MODULE_ID} | preUpdateToken: ${movedToken.name} attempting to leave reach of ${leavingOpponents.length} opponent(s); intercepting`
      );
    }

    // Capture the intended destination so the dialog flow can replay it.
    const targetX = changes.x ?? tokenDoc.x;
    const targetY = changes.y ?? tokenDoc.y;

    // Launch the dialog asynchronously \u2014 we cannot await inside this
    // synchronous hook. The dialog flow handles replaying the move with the
    // bypass flag after the player chooses.
    openMovementTriggerDialog(movedToken, leavingOpponents, stayingOpponents, {
      targetX,
      targetY,
    }).catch((err) => {
      console.error(`${MODULE_ID} | movement-trigger dialog error:`, err);
    });

    return false; // cancel the update
  } catch (err) {
    console.error(`${MODULE_ID} | preUpdateToken hook error:`, err);
    // On error, fall through and allow the move \u2014 don't lock the player out.
  }
}
