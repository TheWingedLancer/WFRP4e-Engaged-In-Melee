/**
 * Module settings for wfrp4e-engaged-in-melee.
 *
 * All five settings are registered here, called from main.js's init hook
 * (settings must be registered before the ready hook so they're available
 * everywhere the module reads them).
 *
 * User-facing names and hints come from lang/en.json via the localization
 * keys. Developer-facing descriptions of each setting's effect are in the
 * JSDoc blocks attached to each registration below.
 */
import { MODULE_ID, SETTINGS } from "./constants.js";

/**
 * Register module settings. Called from the init hook in main.js.
 */
export function registerSettings() {
  /**
   * ENABLE_AUTO_TRACKING (world, bool, default true)
   *
   * Master toggle for the module's automated engagement tracking. When
   * disabled:
   *   - The post-roll engagement hook (onRollMeleeTest) skips recording
   *     engagement edges, so attacks no longer establish engagement.
   *   - The updateToken hook skips its auto-disengage check, so moving out
   *     of reach no longer drops edges.
   *
   * The outnumbering bonus, the Disengage/Flee dialogs, and the manual
   * Token HUD buttons still work \u2014 they just operate on whatever the
   * engagement graph already contains. Useful for GMs who want to set
   * engagement state manually via macros.
   */
  game.settings.register(MODULE_ID, SETTINGS.ENABLE_AUTO_TRACKING, {
    name: `${MODULE_ID}.settings.enableAutoTracking.name`,
    hint: `${MODULE_ID}.settings.enableAutoTracking.hint`,
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  /**
   * AUTO_DISENGAGE_DISTANCE (world, int, default 2yd)
   *
   * Floor (in yards) for both the auto-disengage threshold (in onUpdateToken)
   * and the movement-trigger dialog threshold (in onPreUpdateToken). The
   * effective threshold is max(weaponReach, this).
   *
   * Default 2 means: at minimum, engagement persists until tokens are at
   * least 2yd apart (one grid square in a 2yd-per-square scene). This
   * prevents engagement from yo-yoing on micro-moves between adjacent
   * tokens with 2yd-reach hand weapons.
   *
   * Set higher to be more permissive (e.g., 4yd = engagement persists out
   * to spear range regardless of weapons). Set to 1 to use weapon reach
   * exclusively.
   */
  game.settings.register(MODULE_ID, SETTINGS.AUTO_DISENGAGE_DISTANCE, {
    name: `${MODULE_ID}.settings.autoDisengageDistance.name`,
    hint: `${MODULE_ID}.settings.autoDisengageDistance.hint`,
    scope: "world",
    config: true,
    type: Number,
    default: 2,
    range: { min: 1, max: 10, step: 1 },
  });

  /**
   * SKIRMISH_STALE_SECONDS (world, int, default 60s)
   *
   * Wall-clock TTL for skirmish (out-of-combat) engagement edges. When no
   * Combat is running, engagements are stored with round=0 and pruned by
   * elapsed time instead of round count. The pruner runs opportunistically
   * (on next attack involving any of the participants).
   *
   * Default 60s balances "the fight ended, drop the edges" against "we're
   * mid-narration, keep the context." Set to 0 to disable time-based
   * pruning entirely (skirmish edges persist until manually cleared or
   * the scene is changed).
   */
  game.settings.register(MODULE_ID, SETTINGS.SKIRMISH_STALE_SECONDS, {
    name: `${MODULE_ID}.settings.skirmishStaleSeconds.name`,
    hint: `${MODULE_ID}.settings.skirmishStaleSeconds.hint`,
    scope: "world",
    config: true,
    type: Number,
    default: 60,
    range: { min: 0, max: 600, step: 30 },
  });

  /**
   * ENABLE_MOVEMENT_TRIGGER (world, bool, default true)
   *
   * Controls whether preUpdateToken intercepts moves that would leave an
   * opponent's reach. When disabled, players can freely drag their tokens
   * around without the Disengage decision dialog firing \u2014 useful for
   * GMs who prefer to handle disengagement entirely via the Token HUD
   * button, or who are repositioning tokens out-of-combat for scene setup.
   *
   * Does NOT affect the post-move auto-disengage in onUpdateToken: even
   * with this off, walking out of reach still drops the engagement edge.
   * It just doesn't pause for a dialog first.
   */
  game.settings.register(MODULE_ID, SETTINGS.ENABLE_MOVEMENT_TRIGGER, {
    name: `${MODULE_ID}.settings.enableMovementTrigger.name`,
    hint: `${MODULE_ID}.settings.enableMovementTrigger.hint`,
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  /**
   * DEBUG (client, bool, default false)
   *
   * Per-client verbose console logging. When enabled, the movement hooks,
   * outnumbering calculator, and a few other paths emit detailed diagnostic
   * lines (reach calculations, projected distances, side-by-side ally
   * resolution). Off by default to keep ordinary play quiet.
   *
   * Scoped "client" so the GM and individual players can enable it
   * independently when diagnosing an issue without spamming each other's
   * consoles.
   */
  game.settings.register(MODULE_ID, SETTINGS.DEBUG, {
    name: `${MODULE_ID}.settings.debug.name`,
    hint: `${MODULE_ID}.settings.debug.hint`,
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
  });
}
