/**
 * Constants for wfrp4e-engaged-in-melee.
 *
 * The engagement state is stored as a flag on the active Combat document. This
 * means: (a) it persists across reloads, (b) it syncs to all clients via
 * Foundry's normal document update mechanism, and (c) it cleans itself up when
 * combat ends.
 */
export const MODULE_ID = "wfrp4e-engaged-in-melee";

export const FLAGS = {
  /** Map of tokenId -> { engagedWith: string[], lastAttackRound: number } */
  ENGAGEMENTS: "engagements",
  /** On a chat message: the outnumbering breakdown for transparency */
  OUTNUMBERING_INFO: "outnumberingInfo",
};

export const SETTINGS = {
  AUTO_DISENGAGE_DISTANCE: "autoDisengageDistance",
  ENABLE_AUTO_TRACKING: "enableAutoTracking",
  DEBUG: "debug",
};

/**
 * Conditions that exclude an ally from contributing to the outnumbering count.
 * Per the user's design choice: Unconscious and Fleeing only. A Prone or
 * Stunned ally is still flailing about enough to be a threat.
 *
 * Condition IDs follow WFRP4e's convention (lowercase). Verify in the system
 * with: CONFIG.statusEffects.map(e => e.id)
 */
export const EXCLUDED_CONDITIONS = ["unconscious", "fleeing"];

/**
 * Thresholds for the RAW Outnumbering bonus (Core p.161).
 *  - 2:1 ratio -> +20
 *  - 3:1 ratio -> +40
 * The ratio is (attacker's side engaged with target) : (target's side engaged with attacker).
 */
export const OUTNUMBERING_BONUSES = [
  { ratio: 3, bonus: 40 },
  { ratio: 2, bonus: 20 },
];
