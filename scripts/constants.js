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
  /**
   * On a chat message: when true, hide the damage line/Apply Damage button
   * from the rendered card. Used for opposed Melee tests that defend a
   * Dodge-Disengage \u2014 RAW awards no damage on these, so the system's
   * default damage display is misleading.
   */
  SUPPRESS_DAMAGE_DISPLAY: "suppressDamageDisplay",
};

export const SETTINGS = {
  AUTO_DISENGAGE_DISTANCE: "autoDisengageDistance",
  ENABLE_AUTO_TRACKING: "enableAutoTracking",
  SKIRMISH_STALE_SECONDS: "skirmishStaleSeconds",
  DEBUG: "debug",
  ENABLE_MOVEMENT_TRIGGER: "enableMovementTrigger",
};

/**
 * Status effect id for the system's "Engaged" visual indicator.
 * Verified in WFRP4e 9.4.0: CONFIG.statusEffects has an entry with id "engaged".
 * This is a system-provided visual marker (not a RAW Condition from the
 * official list) used to show on tokens that they are currently engaged
 * in melee. We toggle this on/off as engagement edges are added/removed.
 */
export const ENGAGED_STATUS_ID = "engaged";

/**
 * Conditions that exclude an ally from contributing to the outnumbering count.
 *
 * Per WFRP4e Core p.168, a Broken character "cannot Test to rally from being
 * Broken if you are Engaged with an enemy" \u2014 explicitly confirming that
 * Broken/Fleeing characters CAN still be engaged with enemies. They're still
 * in the fight, occupying space, and forcing opponents to deal with them.
 * They just can't take normal Actions (their Move and Action must be used to
 * run away).
 *
 * Therefore only Unconscious tokens are excluded from outnumbering math:
 * an unconscious character is genuinely not participating in the fight.
 *
 * Condition IDs follow WFRP4e's convention (lowercase). Verify in the system
 * with: CONFIG.statusEffects.map(e => e.id)
 */
export const EXCLUDED_CONDITIONS = ["unconscious"];

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
