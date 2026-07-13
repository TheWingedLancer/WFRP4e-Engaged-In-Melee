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
    // engagement state changed between renders. (Note: the system may also
    // re-baseline modifier when the user toggles Charging \u2014 we detect that
    // case below and re-apply the bonus.)

    // Build the tooltip text per the user's preferred phrasing. We keep this
    // text-only (no value parameter to add()) because the system's tooltip
    // formatter would append the value as " (+40)" at the END of the line,
    // and we want the value embedded in the middle: "outnumbering 3:1 (+40):".
    function buildTooltipReason(bonusValue) {
      const sideA = result.attackerSideTokens?.map(t => t?.name ?? "?").join(", ") ?? attacker.name;
      const sideD = result.defenderSideTokens?.map(t => t?.name ?? "?").join(", ") ?? target.name;
      const sideACount = result.attackerSideCount ?? 1;
      const sideDCount = result.defenderSideCount ?? 1;
      const sideAWithYou = sideA.replace(attacker.name, "You");
      const ratioText = result.ratio ?? `${sideACount}:${Math.max(1, sideDCount)}`;
      const sign = bonusValue >= 0 ? "+" : "";
      let reason = `Bonus for outnumbering opponent ${ratioText} (${sign}${bonusValue}): ${sideAWithYou} (${sideACount}) vs Enemy: ${sideD} (${sideDCount}).`;
      // Combat Master transparency (option a): explain the inflated count.
      const cm = result.combatMaster;
      if (cm && cm.total > 0) {
        const who = cm.contributors
          .map((c) => `${c.name.replace(attacker.name, "You")} (${c.level})`)
          .join(", ");
        const sideLabel = cm.side === "attacker" ? "your side" : "the enemy side";
        reason += ` Includes +${cm.total} from Combat Master on ${sideLabel}: ${who}.`;
      }
      return reason;
    }

    // Patch the rendered modifier tooltip in the DOM.
    //
    // v0.1.23 \u2014 DOM-direct approach. Prior versions called into
    // dialog.tooltips._modifier.list and dialog.tooltips._formatTooltip() to
    // participate in the system's tooltip-list machinery. Empirically, this
    // proved unreliable across rounds: a freshly-opened WeaponDialog
    // instance sometimes inherited stale list contents from a previous
    // dialog (the system's BaseDialogTooltips object reuses _modifier state
    // in ways we couldn't predict), and our edits to list were either
    // overwritten or applied to a different object than what got rendered.
    //
    // The fix: stop touching dialog.tooltips entirely. Read the current
    // data-tooltip attribute from the DOM (which is what the system has
    // already finalized), strip any prior outnumbering entry we wrote on
    // a previous render, append a fresh entry, write back. Deferred via
    // setTimeout(0) so any synchronous post-render setAttribute the
    // system does happens FIRST and we land on top of it.
    //
    // Tooltip text we write is matched by the literal HTML pattern
    // `<p>&#8226; Bonus for outnumbering ... </p>` so re-render cleanup is
    // a simple string operation.
    function applyOutnumberingTooltip(rootEl, bonusValue) {
      try {
        if (!rootEl) return;
        const stripOursRe = /<p>\s*(?:&#8226;|\u2022|\u00b7)\s*Bonus for outnumbering[^<]*<\/p>/gi;
        const reasonText = bonusValue === 0 ? null : buildTooltipReason(bonusValue);
        const ourLine = reasonText ? `<p>&#8226; ${reasonText}</p>` : null;

        // Defer so the system's render-finish work (which may write
        // data-tooltip attributes for other contributors like Charging or
        // weapon qualities) lands first. We then read and amend.
        setTimeout(() => {
          try {
            const modInput = rootEl.querySelector('input[name="modifier"]');
            if (!modInput) return;
            const formFields = modInput.closest('.form-fields');
            const formGroup = modInput.closest('.form-group');

            // Strategy: write to BOTH the input and the form-fields/form-group
            // surfaces. The hover area can be either depending on dialog
            // version, and writing to both ensures the tooltip surfaces
            // regardless of which one the cursor lands on. We preserve any
            // existing tooltip content from system contributors.
            for (const el of [modInput, formFields, formGroup].filter(Boolean)) {
              const existing = (el.getAttribute('data-tooltip') ?? '').replace(stripOursRe, '');
              const combined = ourLine && existing.trim() ? existing + ourLine : (ourLine || existing);
              if (combined) {
                el.setAttribute('data-tooltip', combined);
              } else {
                el.removeAttribute('data-tooltip');
              }
            }
          } catch (e) {
            console.warn(`${MODULE_ID} | tooltip DOM patch (deferred) failed:`, e);
          }
        }, 0);
      } catch (e) {
        console.warn(`${MODULE_ID} | tooltip DOM patch failed:`, e);
      }
    }

    const root = html instanceof HTMLElement ? html : html?.[0];

    // System re-baseline detection: when the user toggles Charging (or other
    // dialog options), the WFRP4e system re-runs its dialog setup, which
    // resets dialog.fields.modifier to its base value (typically 0). Our
    // APPLIED_MARKER persists on the dialog instance across these re-renders,
    // but the modifier value no longer reflects our contribution.
    //
    // Detect this case: if we previously applied a non-zero bonus but the
    // current modifier value is less than that, the system has re-baselined
    // and we need to re-apply our bonus from scratch.
    const previouslyApplied = dialog[APPLIED_MARKER] ?? 0;
    const currentModifier = Number(dialog.fields.modifier) || 0;
    const systemRebaselined = previouslyApplied > 0 && currentModifier < previouslyApplied;
    if (systemRebaselined) {
      // Reset our marker so the delta computation below treats this as fresh.
      dialog[APPLIED_MARKER] = 0;
      if (game.settings.get(MODULE_ID, SETTINGS.DEBUG)) {
        console.log(
          `${MODULE_ID} | renderWeaponDialog: detected system rebaseline (had applied +${previouslyApplied}, modifier now ${currentModifier}); re-applying bonus`
        );
      }
    }
    const effectivePreviouslyApplied = systemRebaselined ? 0 : previouslyApplied;

    if (result.bonus === effectivePreviouslyApplied) {
      // No bonus-value change, but the DOM may have been re-rendered.
      // Re-apply our tooltip line.
      applyOutnumberingTooltip(root, result.bonus);
      if (game.settings.get(MODULE_ID, SETTINGS.DEBUG)) {
        console.log(`${MODULE_ID} | renderWeaponDialog: bonus unchanged (${result.bonus}); tooltip refreshed`);
      }
      return;
    }

    // Adjust the modifier: subtract any previous application, add the new bonus.
    const delta = result.bonus - effectivePreviouslyApplied;
    if (!dialog.fields) {
      console.warn(`${MODULE_ID} | dialog.fields is missing; cannot apply outnumbering`);
      return;
    }

    dialog.fields.modifier = (Number(dialog.fields.modifier) || 0) + delta;
    if (dialog.context?.fields) {
      dialog.context.fields.modifier = dialog.fields.modifier;
    }
    dialog[APPLIED_MARKER] = result.bonus;

    // Patch the tooltip DOM with the regenerated tooltip HTML.
    applyOutnumberingTooltip(root, result.bonus);

    // Update the rendered input element so the user sees the new modifier value.
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
        combatMaster: result.combatMaster
          ? {
              side: result.combatMaster.side,
              total: result.combatMaster.total,
              contributors: result.combatMaster.contributors,
            }
          : null,
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
 * Hook: preCreateChatMessage
 *
 * If the dialog hook stashed a breakdown for this attacker, write it onto the
 * pending chat message as a flag BEFORE the message is created, using
 * updateSource (synchronous). This is the critical difference from the old
 * createChatMessage approach: setting the flag post-creation via setFlag is
 * async and triggers a SECOND render \u2014 the first renderChatMessageHTML fires
 * before the flag lands (no panel), and the later re-render that has the flag
 * often appends to a replaced/detached node, so the panel never appears. By
 * mutating the pending document's source here, the flag is baked in before the
 * first render, so renderChatMessageHTML sees it on the very first pass.
 *
 * preCreateChatMessage fires only on the initiating client, which is also the
 * client that populated the stash during dialog render \u2014 so the stash entry
 * is local and available here. Foundry then syncs the flag (now part of the
 * created document) to all other clients automatically.
 *
 * Signature: (document, data, options, userId). We mutate `document` via
 * updateSource; we do not return false (that would cancel message creation).
 *
 * @param {ChatMessage} message  the pending chat message document
 */
export function onPreCreateChatMessage(message) {
  try {
    const speakerActorId = message.speaker?.actor;
    const speakerTokenId = message.speaker?.token;

    // Suppress-damage marker for Dodge-Disengage defense rolls. Keyed by token
    // id (stable across linked/synthetic actors, matches message.speaker.token).
    // Writing via updateSource here (pre-create) means the first render already
    // sees the flag, so the damage UI is hidden on the first pass.
    if (speakerTokenId) {
      const suppressStash = globalThis[`__${MODULE_ID}_suppressDamage`];
      if (suppressStash && suppressStash.has(speakerTokenId)) {
        const entry = suppressStash.get(speakerTokenId);
        if (Date.now() - entry._timestamp <= 5000) {
          try {
            message.updateSource({
              [`flags.${MODULE_ID}.${FLAGS.SUPPRESS_DAMAGE_DISPLAY}`]: true,
            });
          } catch (err) {
            console.warn(`${MODULE_ID} | could not set suppress-damage flag on pending message:`, err);
          }
        }
        suppressStash.delete(speakerTokenId);
      }
    }

    const pending = globalThis[`__${MODULE_ID}_pending`];
    if (!pending || pending.size === 0) return;

    if (!speakerActorId) return;

    const breakdown = pending.get(speakerActorId);
    if (!breakdown) return;

    if (Date.now() - breakdown._timestamp > 5000) {
      pending.delete(speakerActorId);
      return;
    }

    const cleanBreakdown = { ...breakdown };
    delete cleanBreakdown._timestamp;

    // Write the outnumbering breakdown into the pending document's source.
    // No isGM gate: the message author owns the pending document and can
    // mutate its source before creation regardless of GM status. Foundry
    // syncs the resulting flag to all clients.
    try {
      message.updateSource({
        [`flags.${MODULE_ID}.${FLAGS.OUTNUMBERING_INFO}`]: cleanBreakdown,
      });
    } catch (err) {
      console.warn(`${MODULE_ID} | could not set outnumbering flag on pending message:`, err);
    }
    pending.delete(speakerActorId);
  } catch (err) {
    console.error(`${MODULE_ID} | preCreateChatMessage hook error:`, err);
  }
}

/**
 * Hook: renderChatMessageHTML
 *
 * Decorate the chat card with the outnumbering breakdown if our flag is set.
 */
export function onRenderChatMessage(message, html) {
  try {
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root) return;

    // Suppress-damage handling for Dodge-Disengage opposed Melee tests.
    // RAW (Core p.165) awards no damage on these \u2014 only Advantage shifts.
    // The system's default chat card includes Damage / Hit Location / Apply
    // Damage button which would mislead the GM into thinking damage is owed.
    // We hide the damage-related DOM and add a clarifying note.
    const suppressDamage = message.getFlag(MODULE_ID, FLAGS.SUPPRESS_DAMAGE_DISPLAY);
    if (suppressDamage && !root.classList.contains(`${MODULE_ID}-damage-suppressed`)) {
      root.classList.add(`${MODULE_ID}-damage-suppressed`);

      // Multiple targeting strategies because the WFRP4e weapon card has
      // varied across versions. We hide any element that is plainly a damage
      // row, the Apply Damage button, or the Hit Location row (which is also
      // moot when no damage is applied).
      const damageSelectors = [
        ".damage-row",
        ".damage",
        ".apply-damage",
        "[data-action='applyDamage']",
        "[data-button='applyDamage']",
        ".chat-button.apply-damage",
        ".dice-damage",
      ];
      for (const sel of damageSelectors) {
        for (const el of root.querySelectorAll(sel)) {
          el.style.display = "none";
        }
      }

      // Text-based fallback: WFRP4e's weapon card structure (verified in
      // 9.4.0) puts these as <p> rows containing a <strong>Label:</strong>
      // followed by the value. We walk leaf-ish elements and check the
      // initial label text. We also look for "<strong>Damage</strong>" or
      // similar inline labels.
      const content = root.querySelector(".message-content") ?? root;
      const damageLabelRe = /^(damage|hit\s*location|qualities)\b/i;
      const rowSelectors = ["p", "div", "li", "span"];
      for (const sel of rowSelectors) {
        for (const child of Array.from(content.querySelectorAll(sel))) {
          // Skip our own elements and large containers.
          if (child.classList.contains(`${MODULE_ID}-defense-note`)) continue;
          if (child.classList.contains(`${MODULE_ID}-breakdown`)) continue;
          if (child.children.length > 6) continue;

          // First try the leading text of the element (handles
          // "Damage: 13" plain text).
          const firstText = child.textContent?.trim() ?? "";
          if (damageLabelRe.test(firstText)) {
            child.style.display = "none";
            continue;
          }

          // Then try inline labels: <strong>Damage:</strong>...
          const label = child.querySelector("strong, b, .label");
          if (label) {
            const labelText = label.textContent?.trim() ?? "";
            if (damageLabelRe.test(labelText)) {
              child.style.display = "none";
            }
          }
        }
      }

      // Add a clarifying note so the GM knows why the damage section is gone.
      if (!root.querySelector(`.${MODULE_ID}-defense-note`)) {
        const note = document.createElement("div");
        note.classList.add(`${MODULE_ID}-defense-note`);
        note.style.fontSize = "0.85em";
        note.style.opacity = "0.85";
        note.style.marginTop = "0.4em";
        note.style.fontStyle = "italic";
        note.textContent = "Disengage defense \u2014 no damage applied (Core p.165).";
        content.appendChild(note);
      }
    }

    const info = message.getFlag(MODULE_ID, FLAGS.OUTNUMBERING_INFO);
    if (!info) return;
    if (root.querySelector(`.${MODULE_ID}-breakdown`)) return;

    const panel = document.createElement("div");
    panel.classList.add(`${MODULE_ID}-breakdown`);
    let panelHtml = `
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
    if (info.combatMaster && info.combatMaster.total > 0) {
      const cm = info.combatMaster;
      const who = (cm.contributors ?? [])
        .map((c) => `${c.name} (${c.level})`)
        .join(", ");
      const sideLabel = cm.side === "attacker" ? info.attackerName : info.defenderName;
      panelHtml += `
        <div class="outnumbering-detail" style="font-style: italic; opacity: 0.9;">
          +${cm.total} from Combat Master on ${sideLabel}'s side: ${who}
        </div>
      `;
    }
    panel.innerHTML = panelHtml;

    const content = root.querySelector(".message-content") ?? root;
    content.appendChild(panel);
  } catch (err) {
    console.error(`${MODULE_ID} | renderChatMessage hook error:`, err);
  }
}
