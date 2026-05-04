import { MODULE_ID, FLAGS, SETTINGS } from "./constants.js";
import { EngagementTracker } from "./engagement-tracker.js";
import { calculateOutnumbering } from "./outnumbering.js";

/**
 * WFRP4e fires two hooks of interest for us:
 *
 *   wfrp4e:preRollTest  - after the test dialog closes but before the dice
 *                         resolve. test.preData is mutable here. This is where
 *                         we inject the +20/+40 outnumbering modifier.
 *
 *   wfrp4e:rollTest     - after the roll has been evaluated. This is where we
 *                         look at the result and, if it was a melee attack,
 *                         mark attacker and target as Engaged.
 *
 * Both hooks pass a `test` object. The shape varies slightly by test type but
 * the relevant fields are:
 *   test.actor          - the rolling Actor
 *   test.token          - the TokenDocument of the roller (may be undefined
 *                         for unlinked actors with no scene presence)
 *   test.targets        - Set of TokenDocuments being targeted
 *   test.item           - the weapon Item, if a weapon test
 *   test.preData        - mutable test data including modifier and slBonus
 *   test.context        - extra context including weapon details
 *
 * To detect "is this a melee attack" we check:
 *   test.preData.skillName matches a Melee skill, OR
 *   test.item exists and has an attack type of "melee", OR
 *   test instanceof game.wfrp4e.rolls.WeaponTest with a melee weapon
 *
 * Different WFRP4e versions have shuffled this around, so we use a defensive
 * check that tolerates all known shapes.
 */

/**
 * Determine if a test is a melee attack against another token.
 * Returns the target Token (placeable) if so, null otherwise.
 */
function getMeleeAttackTarget(test) {
  if (!test) return null;

  // Must be a weapon-style test with an item.
  const item = test.item;
  if (!item) {
    // Could still be a Melee skill test without a specific weapon — check
    // skill name.
    const skillName = test.preData?.skillName ?? test.data?.preData?.skillName;
    if (!skillName || !skillName.toLowerCase().includes("melee")) return null;
  } else {
    // Item present: must be a weapon, and must be melee.
    const itemType = item.type;
    if (itemType !== "weapon") return null;
    const attackType = item.system?.attackType ?? item.attackType;
    if (attackType && attackType !== "melee") return null;
  }

  // Resolve the first target. WFRP4e tests typically have exactly one target;
  // if multiple, we use the first (the GM can call out edge cases).
  const targets = test.targets ?? test.context?.targets ?? game.user.targets;
  let targetDoc = null;
  if (targets) {
    if (targets instanceof Set) {
      targetDoc = targets.values().next().value;
    } else if (Array.isArray(targets) && targets.length > 0) {
      targetDoc = targets[0];
    }
  }
  if (!targetDoc) return null;

  // Targets may be Token (placeable) or TokenDocument depending on call site.
  const targetToken = targetDoc.object ?? canvas.tokens?.get(targetDoc.id);
  return targetToken ?? null;
}

/**
 * Resolve the attacker Token from a test.
 */
function getAttackerToken(test) {
  // Prefer test.token (TokenDocument), fall back to actor's active token.
  const tokenDoc = test.token ?? test.data?.token;
  if (tokenDoc) {
    return tokenDoc.object ?? canvas.tokens?.get(tokenDoc.id) ?? null;
  }
  const actor = test.actor ?? test.data?.actor;
  if (!actor) return null;
  return actor.getActiveTokens()[0] ?? null;
}

/**
 * Hook: wfrp4e:preRollTest
 *
 * Inject the outnumbering bonus into the test before it rolls. We add to
 * test.preData.testModifier (the unified +N/-N to-hit modifier WFRP4e uses).
 *
 * We also stash the breakdown on the test so the rollTest hook can write it
 * to the chat card flags for display.
 */
export function onPreRollTest(test) {
  try {
    const tracker = EngagementTracker.current();
    if (!tracker) return;

    const attacker = getAttackerToken(test);
    const target = getMeleeAttackTarget(test);
    if (!attacker || !target) return;

    const result = calculateOutnumbering(attacker, target, tracker);
    if (result.bonus === 0) {
      // Still record the breakdown (1:1 or worse) so the card can show "no
      // outnumbering bonus applied" if you want; we'll skip the flag to keep
      // chat cards clean unless there's actually a bonus.
      return;
    }

    // Inject the modifier. WFRP4e's testModifier is added to the success chance.
    const preData = test.preData ?? test.data?.preData;
    if (!preData) {
      console.warn(`${MODULE_ID} | preRollTest fired but test.preData is missing; cannot apply bonus`);
      return;
    }
    preData.testModifier = (preData.testModifier ?? 0) + result.bonus;

    // Stash the breakdown for the post-roll hook to write into the chat card.
    test[`_${MODULE_ID}_breakdown`] = {
      bonus: result.bonus,
      ratio: result.ratio,
      attackerSideCount: result.attackerSideCount,
      defenderSideCount: result.defenderSideCount,
      attackerName: attacker.name,
      defenderName: target.name,
    };

    if (game.settings.get(MODULE_ID, SETTINGS.DEBUG)) {
      console.log(`${MODULE_ID} | Applied +${result.bonus} outnumbering (${result.ratio}) to ${attacker.name} vs ${target.name}`);
    }
  } catch (err) {
    console.error(`${MODULE_ID} | preRollTest hook error:`, err);
  }
}

/**
 * Hook: wfrp4e:rollTest
 *
 * After the test resolves, do two things:
 *   1. Mark attacker and defender as Engaged (the act of attacking establishes
 *      engagement per Core p.159, regardless of hit/miss).
 *   2. If we stashed an outnumbering breakdown in preRoll, write it to the
 *      chat card flags so the renderChatMessage hook can display it.
 */
export async function onRollTest(test) {
  try {
    const tracker = EngagementTracker.current();
    if (!tracker) return;

    const attacker = getAttackerToken(test);
    const target = getMeleeAttackTarget(test);
    if (!attacker || !target) return;

    const round = game.combat?.round ?? 1;
    await tracker.engage(attacker.id, target.id, round);

    // If preRoll stashed a breakdown, attach it to the message that this test
    // is producing. WFRP4e creates the message from test.context.messageId
    // after this hook returns, so we set a marker on test.preData that the
    // message-render hook will read. Alternatively, find the most recent
    // message from this user and flag it.
    const breakdown = test[`_${MODULE_ID}_breakdown`];
    if (breakdown) {
      test._chatMessageOptions = test._chatMessageOptions ?? {};
      foundry.utils.setProperty(
        test._chatMessageOptions,
        `flags.${MODULE_ID}.${FLAGS.OUTNUMBERING_INFO}`,
        breakdown
      );
    }
  } catch (err) {
    console.error(`${MODULE_ID} | rollTest hook error:`, err);
  }
}

/**
 * Hook: renderChatMessageHTML (V13) / renderChatMessage (V12 fallback)
 *
 * If a chat message has our outnumbering flag, append a small breakdown panel
 * to the message body so players can see why the bonus was applied.
 */
export function onRenderChatMessage(message, html) {
  try {
    const info = message.getFlag(MODULE_ID, FLAGS.OUTNUMBERING_INFO);
    if (!info) return;

    const root = html instanceof HTMLElement ? html : html[0];
    if (!root) return;

    // Don't double-render if Foundry re-renders the message.
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

    // WFRP4e cards typically have a .message-content div; append after it.
    const content = root.querySelector(".message-content") ?? root;
    content.appendChild(panel);
  } catch (err) {
    console.error(`${MODULE_ID} | renderChatMessage hook error:`, err);
  }
}
