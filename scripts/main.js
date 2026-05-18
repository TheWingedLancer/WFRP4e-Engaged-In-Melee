/**
 * Module entry point.
 *
 * This file is intentionally small. It does three things:
 *
 *   1. PREFLIGHT: verify every named import resolves at module load time
 *      (preflightImports). Catches docblock truncation, circular import
 *      bugs, and missing exports immediately on world load rather than at
 *      first attack \u2014 saves a lot of debugging time.
 *
 *   2. LIFECYCLE: register the init/ready hooks. Settings registration and
 *      CONFIG.queries registration happen in init; socket listener and the
 *      public API surface go up in ready.
 *
 *   3. HOOK WIRING: connect every Foundry/system hook to its handler in the
 *      appropriate file. The handlers themselves live elsewhere; this file
 *      just plumbs them in.
 *
 * For the bigger picture \u2014 the engagement model, the three pure
 * services, the socket layer, the Disengage/Flee flows \u2014 see
 * ARCHITECTURE.md at the repo root.
 *
 * File-level responsibilities (brief recap):
 *   - constants.js          IDs, flags, settings keys, condition exclusions
 *   - settings.js           Foundry settings registration
 *   - engagement-tracker.js Graph storage, GM-authoritative socket layer,
 *                           advantage-write helper
 *   - outnumbering.js       The math, plus areAllied (disposition + mounts)
 *   - reach.js              Weapon reach in yards; symmetric and asymmetric
 *                           threshold functions
 *   - roll-hooks.js         Pre-roll bonus injection, post-roll engagement
 *                           recording, chat breakdown panel, damage suppression
 *   - movement-hooks.js     preUpdateToken (dialog trigger) and updateToken
 *                           (auto-disengage)
 *   - combat-hooks.js       Round-based pruning, combat end, token deletion,
 *                           incapacitation-triggered edge clearing
 *   - token-hud.js          Disengage and Flee buttons
 *   - disengage-flee.js     Disengage decision, Flee free-attack loop,
 *                           movement-trigger dialog
 *   - opponent-defense.js   CONFIG.queries routing of opponent-side
 *                           weapon-pick + roll dialogs to opponent's owner
 */
import { MODULE_ID } from "./constants.js";
import { registerSettings } from "./settings.js";
import { EngagementTracker, registerEngagedStatusSocket } from "./engagement-tracker.js";
import { calculateOutnumbering } from "./outnumbering.js";
import {
  onRenderWeaponDialog,
  onRollMeleeTest,
  onCreateChatMessage,
  onRenderChatMessage,
} from "./roll-hooks.js";
import { onCombatRound, onDeleteCombat, onDeleteToken, onCreateActiveEffect } from "./combat-hooks.js";
import { onUpdateToken, onPreUpdateToken } from "./movement-hooks.js";
import { onRenderTokenHUD } from "./token-hud.js";
import { openDisengageDialog, openFleeDialog, openMovementTriggerDialog } from "./disengage-flee.js";
import { getTokenEngagementReach, getEngagementThreshold, getMoverInterceptThreshold } from "./reach.js";
import { registerOpponentDefenseQuery } from "./opponent-defense.js";

/**
 * ESM import preflight - verifies every named import resolves at module load
 * time so docblock truncation or circular import bugs surface immediately
 * rather than at first attack.
 */
function preflightImports() {
  const imports = {
    EngagementTracker,
    registerEngagedStatusSocket,
    calculateOutnumbering,
    onRenderWeaponDialog,
    onRollMeleeTest,
    onCreateChatMessage,
    onRenderChatMessage,
    onCombatRound,
    onDeleteCombat,
    onDeleteToken,
    onCreateActiveEffect,
    onUpdateToken,
    onPreUpdateToken,
    onRenderTokenHUD,
    openDisengageDialog,
    openFleeDialog,
    openMovementTriggerDialog,
    registerSettings,
    getTokenEngagementReach,
    getEngagementThreshold,
    getMoverInterceptThreshold,
    registerOpponentDefenseQuery,
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
  // CONFIG.queries entries should be in place before any client tries to
  // invoke a query against this user, so register during init.
  registerOpponentDefenseQuery();
});

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | Ready`);

  // Register socket listener for cross-client status effect application.
  // Player clients send status-toggle requests to the GM via this socket.
  registerEngagedStatusSocket();

  const moduleData = game.modules.get(MODULE_ID);
  if (moduleData) {
    moduleData.api = {
      EngagementTracker,
      calculateOutnumbering,
      getTokenEngagementReach,
      getEngagementThreshold,
      getMoverInterceptThreshold,
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
Hooks.on("createActiveEffect", onCreateActiveEffect);

// Movement-based auto-disengage.
Hooks.on("updateToken", onUpdateToken);

// Movement-trigger dialog: intercept moves that would leave engagement reach.
// Returns false to cancel the move, then opens a dialog asynchronously.
Hooks.on("preUpdateToken", onPreUpdateToken);

// Manual disengage button.
Hooks.on("renderTokenHUD", onRenderTokenHUD);
