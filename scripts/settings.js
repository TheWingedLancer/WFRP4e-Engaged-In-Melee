import { MODULE_ID, SETTINGS } from "./constants.js";

/**
 * Register module settings. Called from the init hook.
 */
export function registerSettings() {
  game.settings.register(MODULE_ID, SETTINGS.ENABLE_AUTO_TRACKING, {
    name: `${MODULE_ID}.settings.enableAutoTracking.name`,
    hint: `${MODULE_ID}.settings.enableAutoTracking.hint`,
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, SETTINGS.AUTO_DISENGAGE_DISTANCE, {
    name: `${MODULE_ID}.settings.autoDisengageDistance.name`,
    hint: `${MODULE_ID}.settings.autoDisengageDistance.hint`,
    scope: "world",
    config: true,
    type: Number,
    default: 2,
    range: { min: 1, max: 10, step: 1 },
  });

  game.settings.register(MODULE_ID, SETTINGS.DEBUG, {
    name: `${MODULE_ID}.settings.debug.name`,
    hint: `${MODULE_ID}.settings.debug.hint`,
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
  });
}
