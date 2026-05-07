import { MODULE_ID, SETTINGS } from "./constants.js";
import { EngagementTracker } from "./engagement-tracker.js";
import { getEngagementThreshold } from "./reach.js";

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
