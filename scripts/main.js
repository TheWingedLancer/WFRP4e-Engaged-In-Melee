import { MODULE_ID } from "./constants.js";
import { registerSettings } from "./settings.js";
import { EngagementTracker } from "./engagement-tracker.js";
import { calculateOutnumbering } from "./outnumbering.js";
import {
  onRenderWeaponDialog,
  onRollWeaponTest,
  onCreateChatMessage,
  onRenderChatMessage,
} from "./roll-hooks.js";
import { onCombatRound, onDeleteCombat, onDeleteToken } from "./combat-hooks.js";
import { onUpdateToken } from "./movement-hooks.js";
import { onRenderTokenHUD } from "./token-hud.js";
import { getTokenEngagementReach, getEngagementThreshold } from "./reach.js";

/**
 * ESM import preflight - verifies every named import resolves at module load
 * time so docblock truncation or circular import bugs surface immediately
 * rather than at first attack.
 */
function preflightImports() {
  const imports = {
    EngagementTracker,
    calculateOutnumbering,
    onRenderWeaponDialog,
    onRollWeaponTest,
    onCreateChatMessage,
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
    if (ref === undefined || ref === null) broken.push(name);
  }
  if (broken.length > 0) {
    const msg = `${MODULE_ID} | ESM IMPORT FAILURE: ${broken.join(", ")} resolved to undefined.`;
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

// PRE-ROLL: Inject outnumbering bonus into the WeaponDialog before the user
// submits. This is the only mechanism that allows the bonus to affect
// Critical/Fumble determination correctly per RAW (Core p.159-161).
Hooks.on("renderWeaponDialog", onRenderWeaponDialog);

// POST-ROLL: Record the engagement edge.
Hooks.on("wfrp4e:rollWeaponTest", onRollWeaponTest);

// Chat message lifecycle: attach breakdown flag, then render the panel.
Hooks.on("createChatMessage", onCreateChatMessage);
Hooks.on("renderChatMessageHTML", onRenderChatMessage);

// Combat lifecycle.
Hooks.on("combatRound", onCombatRound);
Hooks.on("deleteCombat", onDeleteCombat);
Hooks.on("deleteToken", onDeleteToken);

// Movement-based auto-disengage.
Hooks.on("updateToken", onUpdateToken);

// Manual disengage button.
Hooks.on("renderTokenHUD", onRenderTokenHUD);
