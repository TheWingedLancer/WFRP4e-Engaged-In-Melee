/**
 * Reach resolver.
 *
 * Per WFRP4e Core p.297, weapon reach categories map to engagement distances:
 *
 *   Personal     -> 2 yards (default)
 *   Very Short   -> 2 yards
 *   Short        -> 2 yards
 *   Average      -> 2 yards
 *   Long         -> 2 yards
 *   Very Long    -> 4 yards
 *   Massive      -> 6 yards
 *
 * Only Very Long and Massive weapons extend engagement beyond the default. The
 * pacing reasoning: Long weapons (halberds, zweihänders) are unambiguously
 * "in melee distance" — they get no extra reach yardage, just the in-fighting
 * benefits described in the optional rules.
 *
 * Engagement is mutual once established, and a moving combatant only
 * disengages when they exceed BOTH their own reach AND their opponent's reach.
 * A spear-wielder facing a goblin still threatens the goblin at 4 yards even
 * though the goblin (with its dagger) can no longer threaten back.
 *
 * Implementation note on weapon storage in WFRP4e: actors hold weapons as
 * items of type "weapon", with system.reach.value as a string key (e.g.
 * "average", "vLong", "vshort"). The system stores reach value strings using
 * mixed conventions across versions, so we normalize aggressively. The
 * authoritative list is at game.wfrp4e.config.weaponReaches but we don't
 * depend on it being present at module load time.
 *
 * "Equipped" means the weapon has system.equipped.value === true (or the
 * older system.equipped === true). For Foundry V11+ on WFRP4e 9.x the new
 * shape applies; we tolerate both.
 */

const REACH_YARDS = {
  personal: 2,
  vshort: 2,
  short: 2,
  average: 2,
  long: 2,
  vlong: 4,
  massive: 6,
};

const DEFAULT_REACH_YARDS = 2;

/**
 * Normalize a reach key from any of the variants WFRP4e has used.
 * Returns the canonical lowercase key, or null if unrecognized.
 */
function normalizeReachKey(raw) {
  if (!raw) return null;
  const k = String(raw).toLowerCase().replace(/[\s_-]+/g, "");
  // Map common aliases
  const aliases = {
    personal: "personal",
    veryshort: "vshort",
    vshort: "vshort",
    short: "short",
    average: "average",
    medium: "average", // fencing weapons sometimes list "Medium"
    long: "long",
    verylong: "vlong",
    vlong: "vlong",
    massive: "massive",
  };
  return aliases[k] ?? null;
}

/**
 * Get the reach in yards for a given normalized reach key.
 */
export function reachKeyToYards(key) {
  const normalized = normalizeReachKey(key);
  if (!normalized) return DEFAULT_REACH_YARDS;
  return REACH_YARDS[normalized] ?? DEFAULT_REACH_YARDS;
}

/**
 * Is this item an equipped melee weapon?
 *
 * "Melee" is determined by the absence of a ranged attackType. WFRP4e items
 * use system.attackType = "melee" | "ranged"; if missing, fall back to
 * checking weaponGroup against known melee groups.
 */
function isEquippedMeleeWeapon(item) {
  if (!item || item.type !== "weapon") return false;

  const sys = item.system ?? {};

  // Equipped check (handle both old and new shapes)
  const equipped = sys.equipped?.value ?? sys.equipped;
  if (!equipped) return false;

  // Melee check
  const attackType = sys.attackType?.value ?? sys.attackType;
  if (attackType === "ranged") return false;
  if (attackType === "melee") return true;

  // Fallback by weapon group
  const group = sys.weaponGroup?.value ?? sys.weaponGroup;
  const meleeGroups = new Set([
    "basic", "cavalry", "fencing", "brawling", "flail",
    "parry", "polearm", "twohanded",
  ]);
  if (group && meleeGroups.has(String(group).toLowerCase())) return true;

  // If we still can't tell, exclude — better to use default reach than to
  // accidentally treat a bow as a 2-yard weapon (it's not, it's ranged).
  return false;
}

/**
 * Get the engagement reach in yards for a token, based on the longest-reach
 * equipped melee weapon they carry. If they have nothing equipped (or only
 * ranged weapons), returns the Personal default of 2 yards.
 *
 * For creatures with the Weapon trait or other innate attacks, this currently
 * returns the default. A future enhancement could read creature traits.
 */
export function getTokenEngagementReach(token) {
  if (!token?.actor) return DEFAULT_REACH_YARDS;

  let maxYards = DEFAULT_REACH_YARDS;
  const items = token.actor.items ?? [];
  for (const item of items) {
    if (!isEquippedMeleeWeapon(item)) continue;
    const reachKey = item.system?.reach?.value ?? item.system?.reach;
    const yards = reachKeyToYards(reachKey);
    if (yards > maxYards) maxYards = yards;
  }
  return maxYards;
}

/**
 * Compute the auto-disengage threshold for a pair of tokens. Two tokens
 * remain engaged as long as either one can still threaten the other with
 * their currently-equipped weapon — so the threshold is the MAX of both
 * tokens' reaches.
 *
 * Used for the silent auto-disengage check (post-move): the engagement edge
 * persists as long as either party could plausibly reach the other.
 */
export function getEngagementThreshold(tokenA, tokenB) {
  const reachA = getTokenEngagementReach(tokenA);
  const reachB = getTokenEngagementReach(tokenB);
  return Math.max(reachA, reachB);
}

/**
 * Compute the threshold at which a MOVER leaves an OPPONENT's intercept
 * range. This is asymmetric: it returns ONLY the opponent's reach, because
 * the opponent can only intercept (force a Disengage test) if their weapon
 * can reach the mover.
 *
 * Per WFRP4e Core p.165 Disengage rules: "If you choose to move away from a
 * foe engaged with you..." — the action is about leaving a foe's *threat*,
 * which depends on the foe's weapon, not the mover's. A pike-wielder
 * stepping back from a dagger-wielder can move freely (the dagger cannot
 * reach them at any distance > 2yd); a dagger-wielder stepping back from a
 * pike-wielder must Disengage (the pike still threatens them at up to 6yd).
 *
 * Concrete case: Igor (Pike, 6yd reach) is engaged with Orc 1 (Hand Weapon,
 * 2yd reach). They are at 6yd center-to-center. Igor moves to 8yd. From
 * Orc 1's perspective, Igor was always outside Orc 1's 2yd reach \u2014 Orc 1
 * cannot prevent the move. NO Disengage dialog fires.
 *
 * Used by onPreUpdateToken to decide whether to fire the dialog.
 */
export function getMoverInterceptThreshold(mover, opponent) {
  return getTokenEngagementReach(opponent);
}

// Exposed for testing
export const _internal = {
  REACH_YARDS,
  DEFAULT_REACH_YARDS,
  normalizeReachKey,
  isEquippedMeleeWeapon,
};
