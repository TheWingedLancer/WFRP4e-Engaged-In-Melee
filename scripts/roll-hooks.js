import { MODULE_ID, FLAGS, SETTINGS } from "./constants.js";
import { EngagementTracker } from "./engagement-tracker.js";
import { calculateOutnumbering } from "./outnumbering.js";

/**
 * Roll lifecycle hooks for WFRP4e 9.x on Foundry V13.
 *
 * EMPIRICAL FINDINGS (from instrumentation against the live system):
 *   - WFRP4e fires NO `pre*` hooks. Only post-roll: rollWeaponTest, rollTest,
 *     rollCastTest, rollPrayerTest, rollChannelTest, rollTraitTest, plus
 *     opposedTestResult and applyDamage.
 *   - Modifying `test.result.SL` AFTER the roll is wrong: it can flip a
 *     success/failure but cannot change Critical/Fumble status, because
 *     Critical/Fumble is determined by `roll <= modifiedTarget` AT THE
 *     SYSTEM LEVEL using the dialog's modifier value, before our hook fires.
 *   - The Attack/Weapon dialog is `WeaponDialog`, an ApplicationV2 instance
 *     with a `fields.modifier` property. WFRP4e's own modifiers (Charging,
 *     weapon Qualities, dialog scripts from Talents) all write to this field
 *     during dialog rendering. When the user submits, the modifier becomes
 *     part of the test target, and the system computes Critical/Fumble
 *     correctly.
 *
 * STRATEGY:
 *   1. Hook `renderWeaponDialog` (V13 fires this for AppV2 dialogs).
 *   2. If the dialog is for a melee attack with a target, calculate the
 *      outnumbering bonus from the current engagement state.
 *   3. Write the bonus into `dialog.fields.modifier` AND
 *      `dialog.context.fields.modifier` (the rendered template reads context).
 *   4. Update the rendered input element's value so the user sees it.
 *   5. After the roll, the existing `wfrp4e:rollWeaponTest` hook records the
 *      engagement edge and stamps the chat message with the breakdown.
 *
 * SEMANTICS NOTE: We add to whatever modifier the dialog already has rather
 * than overwriting. Dialog scripts from Talents may have already added their
 * own modifiers; we should add the +20/+40 on top, not stomp them.
 *
 * IDEMPOTENCE: renderWeaponDialog can fire multiple times for the same
 * dialog instance (e.g. when the user toggles a modifier checkbox, the
 * dialog re-renders). To avoid double-applying our bonus, we stamp a flag
 * on the dialog instance the first time we apply it and skip on subsequent
 * renders unless the engagement state has changed.
 */

// Symbol used to mark a dialog as "we've already applied our bonus to it"
const APPLIED_MARKER = Symbol.for(`${MODULE_ID}.applied`);

/**
 * Resolve the attacker token from the dialog instance.
 * Dialog has `.actor` and `.token` getters/properties.
 */
function getAttackerTokenFromDialog(dialog) {
  // Try the dialog's token first
  const tokenDoc = dialog.token ?? dialog.data?.token;
  if (tokenDoc) {
    const t = resolveTokenFromMaybeActor(tokenDoc);
    if (t) return t;
  }
  // Fall back to actor's active token
  const actor = dialog.actor ?? dialog.data?.actor;
  if (!actor) return null;
  return resolveTokenFromMaybeActor(actor);
}

/**
 * Determine if a dialog is for a melee attack against a token. If so, return
 * the target Token (placeable). Otherwise null.
 *
 * Accepts both WeaponDialog (item.type === "weapon") and TraitDialog
 * (item.type === "trait") — creatures attack via traits like Hooves, Bite,
 * Claws, which behave identically to weapons for engagement purposes.
 */
function getMeleeTargetFromDialog(dialog) {
  const item = dialog.item ?? dialog.data?.item ?? dialog.weapon ?? dialog.trait;
  if (!item) return null;
  if (item.type !== "weapon" && item.type !== "trait") return null;

  // Attack type check (tolerate both bare-string and {value:string} shapes)
  const sys = item.system ?? {};
  const attackTypeRaw = sys.attackType;
  const attackType = (attackTypeRaw && typeof attackTypeRaw === "object")
    ? attackTypeRaw.value
    : attackTypeRaw;
  if (attackType === "ranged") return null;
  if (attackType && attackType !== "melee") return null;

  // For weapons we have a weaponGroup fallback if attackType is missing.
  // Traits don't have weaponGroup; if a trait has no attackType we
  // conservatively skip (most combat traits do declare attackType).
  if (!attackType && item.type === "weapon") {
    const groupRaw = sys.weaponGroup;
    const group = (groupRaw && typeof groupRaw === "object")
      ? groupRaw.value
      : groupRaw;
    const meleeGroups = new Set([
      "basic", "cavalry", "fencing", "brawling", "flail",
      "parry", "polearm", "twohanded",
    ]);
    if (!group || !meleeGroups.has(String(group).toLowerCase())) return null;
  } else if (!attackType && item.type === "trait") {
    // Trait without attackType: skip rather than guess
    return null;
  }

  // Resolve the target. WFRP4e is inconsistent about whether `targets`
  // contains Token placeables, TokenDocuments, or Actor instances depending
  // on hook timing. Empirically:
  //   - WeaponDialog.targets / TraitDialog.targets -> Array<Token>  (placeable)
  //   - test.targets (post-roll) -> Array<ActorWFRP4e>
  //   - userTargets fallback    -> Set<Token>
  // We accept all three.
  const targets = dialog.targets;
  let targetDoc = null;
  if (Array.isArray(targets) && targets.length > 0) {
    targetDoc = targets[0];
  } else if (targets instanceof Set && targets.size > 0) {
    targetDoc = targets.values().next().value;
  }
  if (!targetDoc) {
    const userTargets = game.user?.targets;
    if (userTargets instanceof Set && userTargets.size > 0) {
      targetDoc = userTargets.values().next().value;
    }
  }
  if (!targetDoc) return null;

  return resolveTokenFromMaybeActor(targetDoc);
}

/**
 * Take a thing that might be a Token placeable, a TokenDocument, or an
 * Actor, and return the corresponding Token placeable on the current canvas.
 * Returns null if no token can be found.
 *
 * This exists because WFRP4e's hooks pass different shapes depending on
 * timing:
 *   - Dialog hooks pass Token placeables in `dialog.targets`
 *   - Post-roll hooks pass Actor instances in `test.targets`
 *   - Foundry's user.targets is a Set of Token placeables
 *
 * For Actor inputs we use getActiveTokens()[0] to find the token on the
 * current scene. If multiple tokens exist for the same actor, we pick the
 * first one — at the table, this corresponds to "the token the player just
 * targeted," which in single-token-per-actor setups (the common case) is
 * always correct.
 */
function resolveTokenFromMaybeActor(thing) {
  if (!thing) return null;

  // Token placeable: has both id and a center, and is what we want directly
  if (thing.center && thing.document) return thing;

  // TokenDocument: has .object pointing at the placeable
  if (thing.object) return thing.object;

  // Actor: has getActiveTokens()
  if (typeof thing.getActiveTokens === "function") {
    const tokens = thing.getActiveTokens();
    if (tokens.length > 0) return tokens[0];
  }

  // Last resort: maybe `thing.id` is actually a token id
  if (thing.id) {
    const t = canvas.tokens?.get(thing.id);
    if (t) return t;
  }

  return null;
}

/**
 * Hook: renderWeaponDialog
 *
 * Apply the Outnumbering bonus to the dialog's modifier field BEFORE the
 * user submits the roll. This means the system itself rolls against the
 * modified target, and Critical/Fumble status is determined correctly.
 */
export function onRenderWeaponDialog(dialog, html, data) {
  try {
    if (!dialog) return;

    const tracker = EngagementTracker.current();
    if (!tracker) {
      if (game.settings.get(MODULE_ID, SETTINGS.DEBUG)) {
        console.log(`${MODULE_ID} | renderWeaponDialog: no scene tracker`);
      }
      return;
    }

    const attacker = getAttackerTokenFromDialog(dialog);
    const target = getMeleeTargetFromDialog(dialog);
    if (!attacker || !target) {
      if (game.settings.get(MODULE_ID, SETTINGS.DEBUG)) {
        console.log(`${MODULE_ID} | renderWeaponDialog: not a melee-vs-target attack (attacker=${attacker?.name}, target=${target?.name})`);
      }
      return;
    }

    // Opportunistic time-based pruning of skirmish engagements
    const staleAgeSeconds = game.settings.get(MODULE_ID, SETTINGS.SKIRMISH_STALE_SECONDS);
    if (staleAgeSeconds > 0) {
      // Don't await - fire and forget. The bonus calculation below uses the
      // current synchronous read of the graph, which is fine because the
      // pruning only removes stale edges (couldn't have given a bonus anyway).
      tracker.pruneStaleByTime(staleAgeSeconds);
    }

    // Calculate outnumbering bonus from current engagement state.
    const result = calculateOutnumbering(attacker, target, tracker);

    // Idempotence guard: if we already applied to this dialog instance, don't
    // double-apply on a subsequent re-render (e.g. user toggled a checkbox).
    // The marker stores the previously-applied bonus so we can adjust if the
    // engagement state changed between renders.
    const previouslyApplied = dialog[APPLIED_MARKER] ?? 0;

    if (result.bonus === previouslyApplied) {
      if (game.settings.get(MODULE_ID, SETTINGS.DEBUG)) {
        console.log(`${MODULE_ID} | renderWeaponDialog: bonus unchanged (${result.bonus}); skipping`);
      }
      return;
    }

    // Adjust the modifier: subtract any previous application, add the new bonus.
    const delta = result.bonus - previouslyApplied;
    if (!dialog.fields) {
      console.warn(`${MODULE_ID} | dialog.fields is missing; cannot apply outnumbering`);
      return;
    }

    dialog.fields.modifier = (Number(dialog.fields.modifier) || 0) + delta;
    if (dialog.context?.fields) {
      dialog.context.fields.modifier = dialog.fields.modifier;
    }
    dialog[APPLIED_MARKER] = result.bonus;

    // Update the rendered input element so the user sees the new value.
    // V13 ApplicationV2 passes the rendered HTMLElement as the second hook arg.
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (root) {
      const input = root.querySelector('input[name="modifier"], input[data-name="modifier"]');
      if (input) {
        input.value = String(dialog.fields.modifier);
      }
    }

    // Stash the breakdown so we can surface it on the chat card after the roll.
    if (result.bonus !== 0) {
      const pending = globalThis[`__${MODULE_ID}_pending`] ?? new Map();
      globalThis[`__${MODULE_ID}_pending`] = pending;
      pending.set(attacker.actor?.id ?? attacker.id, {
        bonus: result.bonus,
        ratio: result.ratio,
        attackerSideCount: result.attackerSideCount,
        defenderSideCount: result.defenderSideCount,
        attackerName: attacker.name,
        defenderName: target.name,
        _timestamp: Date.now(),
      });
    }

    if (game.settings.get(MODULE_ID, SETTINGS.DEBUG)) {
      console.log(`${MODULE_ID} | renderWeaponDialog: ${attacker.name} -> ${target.name}: outnumbering ${result.ratio} bonus +${result.bonus} (delta ${delta >= 0 ? '+' : ''}${delta}); dialog.fields.modifier now ${dialog.fields.modifier}`);
    }
  } catch (err) {
    console.error(`${MODULE_ID} | renderWeaponDialog hook error:`, err);
  }
}

/**
 * Hook: wfrp4e:rollWeaponTest
 *
 * Fires AFTER the weapon attack has resolved. We use it to:
 *   1. Record the attacker<->target engagement edge (Core p.159).
 *   2. Tag the resulting chat message with the outnumbering breakdown for
 *      display, if a breakdown was stashed during dialog rendering.
 *
 * NOTE: We do NOT modify the test result here. The bonus was already applied
 * via the dialog's modifier field, so the system's own logic produced the
 * correct SL, Critical/Fumble status, and damage.
 */
export async function onRollMeleeTest(test, hookName = "rollWeaponTest") {
  try {
    const tracker = EngagementTracker.current();
    if (!tracker) return;

    // Identify attacker and target from the test object.
    let attacker = test.token ? resolveTokenFromMaybeActor(test.token) : null;
    if (!attacker && test.actor) attacker = resolveTokenFromMaybeActor(test.actor);

    // Accept both weapon and trait items. Trait attacks (Hooves, Bite, etc.)
    // are how creatures including mounts establish engagement.
    const item = test.item ?? test.weapon ?? test.trait;
    if (!item) return;
    if (item.type !== "weapon" && item.type !== "trait") return;
    const sys = item.system ?? {};
    const attackTypeRaw = sys.attackType;
    const attackType = (attackTypeRaw && typeof attackTypeRaw === "object")
      ? attackTypeRaw.value
      : attackTypeRaw;
    if (attackType === "ranged") return;
    // For traits, require explicit melee attackType — don't infer
    if (item.type === "trait" && attackType !== "melee") return;

    let targetDoc = null;
    const targets = test.targets;
    if (Array.isArray(targets) && targets.length > 0) targetDoc = targets[0];
    else if (targets instanceof Set && targets.size > 0) targetDoc = targets.values().next().value;
    const target = resolveTokenFromMaybeActor(targetDoc);

    if (!attacker || !target) {
      if (game.settings.get(MODULE_ID, SETTINGS.DEBUG)) {
        console.log(`${MODULE_ID} | ${hookName}: missing attacker (${attacker?.name}) or target (${target?.name})`);
      }
      return;
    }

    // Record the engagement edge.
    const round = game.combat?.round ?? 0;
    await tracker.engage(attacker.id, target.id, round);

    if (game.settings.get(MODULE_ID, SETTINGS.DEBUG)) {
      console.log(`${MODULE_ID} | ${hookName}: engaged ${attacker.name} <-> ${target.name} (round ${round}, item type ${item.type})`);
    }
  } catch (err) {
    console.error(`${MODULE_ID} | ${hookName} hook error:`, err);
  }
}

/**
 * Hook: createChatMessage
 *
 * If the dialog hook stashed a breakdown for this attacker, copy it onto
 * the resulting chat message as a flag so the renderChatMessageHTML hook
 * can decorate the card.
 */
export async function onCreateChatMessage(message) {
  try {
    const pending = globalThis[`__${MODULE_ID}_pending`];
    if (!pending || pending.size === 0) return;

    const speakerActorId = message.speaker?.actor;
    if (!speakerActorId) return;

    const breakdown = pending.get(speakerActorId);
    if (!breakdown) return;

    if (Date.now() - breakdown._timestamp > 5000) {
      pending.delete(speakerActorId);
      return;
    }

    const cleanBreakdown = { ...breakdown };
    delete cleanBreakdown._timestamp;

    if (game.user.isGM) {
      await message.setFlag(MODULE_ID, FLAGS.OUTNUMBERING_INFO, cleanBreakdown);
    }
    pending.delete(speakerActorId);
  } catch (err) {
    console.error(`${MODULE_ID} | createChatMessage hook error:`, err);
  }
}

/**
 * Hook: renderChatMessageHTML
 *
 * Decorate the chat card with the outnumbering breakdown if our flag is set.
 */
export function onRenderChatMessage(message, html) {
  try {
    const info = message.getFlag(MODULE_ID, FLAGS.OUTNUMBERING_INFO);
    if (!info) return;

    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root) return;
    if (root.querySelector(`.${MODULE_ID}-breakdown`)) return;

    const panel = document.createElement("div");
    panel.classList.add(`${MODULE_ID}-breakdown`);
    panel.innerHTML = `
      <div class="outnumbering-header">
        <i class="fas fa-users"></i>
        ${game.i18n.format(`${MODULE_ID}.chat.header`, { bonus: info.bonus })}
      </div>
      <div class="outnumbering-detail">
        ${game.i18n.format(`${MODULE_ID}.chat.detail`, {
          attacker: info.attackerName,
          defender: info.defenderName,
          ratio: info.ratio,
          attackerCount: info.attackerSideCount,
          defenderCount: info.defenderSideCount,
        })}
      </div>
    `;

    const content = root.querySelector(".message-content") ?? root;
    content.appendChild(panel);
  } catch (err) {
    console.error(`${MODULE_ID} | renderChatMessage hook error:`, err);
  }
}
