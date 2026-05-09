import { MODULE_ID } from "./constants.js";
import { registerSettings } from "./settings.js";
import { EngagementTracker } from "./engagement-tracker.js";
import { calculateOutnumbering } from "./outnumbering.js";
import {
  onRenderWeaponDialog,
  onRollMeleeTest,
  onCreateChatMessage,
  onRenderChatMessage,
} from "./roll-hooks.js";
import { onCombatRound, onDeleteCombat, onDeleteToken } from "./combat-hooks.js";
import { onUpdateToken, onPreUpdateToken } from "./movement-hooks.js";
import { onRenderTokenHUD } from "./token-hud.js";
import { openDisengageDialog, openFleeDialog, openMovementTriggerDialog } from "./disengage-flee.js";
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
    onRollMeleeTest,
    onCreateChatMessage,
    onRenderChatMessage,
    onCombatRound,
    onDeleteCombat,
    onDeleteToken,
    onUpdateToken,
    onPreUpdateToken,
    onRenderTokenHUD,
    openDisengageDialog,
    openFleeDialog,
    openMovementTriggerDialog,
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

// PRE-ROLL: Inject outnumbering bonus into the WeaponDialog and TraitDialog
// before the user submits. This is the only mechanism that allows the bonus
// to affect Critical/Fumble determination correctly per RAW (Core p.159-161).
// Traits are how creatures (mounts, monsters) attack; same dialog shape and
// fields.modifier as WeaponDialog.
Hooks.on("renderWeaponDialog", onRenderWeaponDialog);
Hooks.on("renderTraitDialog", onRenderWeaponDialog);

// POST-ROLL: Record the engagement edge. Both weapon and trait attacks
// establish engagement; we use the same handler with a different label.
Hooks.on("wfrp4e:rollWeaponTest", (test) => onRollMeleeTest(test, "rollWeaponTest"));
Hooks.on("wfrp4e:rollTraitTest", (test) => onRollMeleeTest(test, "rollTraitTest"));

// Chat message lifecycle: attach breakdown flag, then render the panel.
Hooks.on("createChatMessage", onCreateChatMessage);
Hooks.on("renderChatMessageHTML", onRenderChatMessage);

// Combat lifecycle.
Hooks.on("combatRound", onCombatRound);
Hooks.on("deleteCombat", onDeleteCombat);
Hooks.on("deleteToken", onDeleteToken);

// Movement-based auto-disengage.
Hooks.on("updateToken", onUpdateToken);

// Movement-trigger dialog: intercept moves that would leave engagement reach.
// Returns false to cancel the move, then opens a dialog asynchronously.
Hooks.on("preUpdateToken", onPreUpdateToken);

// Manual disengage button.
Hooks.on("renderTokenHUD", onRenderTokenHUD);
