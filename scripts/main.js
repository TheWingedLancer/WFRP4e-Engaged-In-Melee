import { MODULE_ID } from "./constants.js";
import { registerSettings } from "./settings.js";
import { EngagementTracker } from "./engagement-tracker.js";
import { calculateOutnumbering } from "./outnumbering.js";
import { onPreRollTest, onRollTest, onRenderChatMessage } from "./roll-hooks.js";
import { onCombatRound, onDeleteCombat, onDeleteToken } from "./combat-hooks.js";
import { onUpdateToken } from "./movement-hooks.js";
import { onRenderTokenHUD } from "./token-hud.js";
import { getTokenEngagementReach, getEngagementThreshold } from "./reach.js";

/**
 * ESM import preflight: every named import above is verified to resolve to a
 * function or class. If any resolve to undefined we know there's a docblock
 * truncation or circular import in the bundle. This pattern was lifted from
 * wfrp4e-combat-simulator where the same class of bug bit us on Forge.
 *
 * The preflight runs at module load time (before any hook fires) so failures
 * surface in the console immediately on Foundry startup rather than on first
 * combat.
 */
function preflightImports() {
  const imports = {
    EngagementTracker,
    calculateOutnumbering,
    onPreRollTest,
    onRollTest,
    onRenderChatMessage,
    onCombatRound,
    onDeleteCombat,
    onDeleteToken,
    onUpdateToken,
    onRenderTokenHUD,
    registerSettings,
    getTokenEngagementReach,
    getEngagementThreshold,
  };
  const broken = [];
  for (const [name, ref] of Object.entries(imports)) {
    if (ref === undefined || ref === null) {
      broken.push(name);
    }
  }
  if (broken.length > 0) {
    const msg = `${MODULE_ID} | ESM IMPORT FAILURE: ${broken.join(", ")} resolved to undefined. Check for docblock truncation or circular imports.`;
    console.error(msg);
    ui.notifications?.error(msg, { permanent: true });
    return false;
  }
  return true;
}

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing`);
  if (!preflightImports()) return;
  registerSettings();
});

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | Ready`);

  // Expose the tracker on the module API for macros and debugging.
  const moduleData = game.modules.get(MODULE_ID);
  if (moduleData) {
    moduleData.api = {
      EngagementTracker,
      calculateOutnumbering,
      getTokenEngagementReach,
      getEngagementThreshold,
      getCurrentTracker: () => EngagementTracker.current(),
    };
  }
});

// WFRP4e roll hooks
Hooks.on("wfrp4e:preRollTest", onPreRollTest);
Hooks.on("wfrp4e:rollTest", onRollTest);

// Chat card decoration. V13 uses renderChatMessageHTML; older systems use
// renderChatMessage. We register both — only one will fire in any given
// version, the other is a no-op.
Hooks.on("renderChatMessageHTML", onRenderChatMessage);
Hooks.on("renderChatMessage", onRenderChatMessage);

// Combat lifecycle
Hooks.on("combatRound", onCombatRound);
Hooks.on("deleteCombat", onDeleteCombat);
Hooks.on("deleteToken", onDeleteToken);

// Movement-based auto-disengage
Hooks.on("updateToken", onUpdateToken);

// Manual disengage button
Hooks.on("renderTokenHUD", onRenderTokenHUD);
