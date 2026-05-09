/**
 * Disengage and Flee flow controllers.
 *
 * Both flows are initiated from a Token HUD button (see token-hud.js). They
 * use the WFRP4e system's standard test-setup methods (setupSkill,
 * setupWeapon, setupTrait, setupCharacteristic) so the GM and players get
 * the normal roll dialogs with all standard fields editable. The module
 * automatically applies consequences (edge drops, Advantage adjustments,
 * conditions) based on the rolled outcomes.
 *
 * RAW references: Core p.165 (Disengaging, Fleeing).
 *
 * Test object usage notes (verified empirically against WFRP4e 9.4.0):
 *   - setupX returns a Test instance with `roll = false` baked in. We must
 *     explicitly call `await test.roll()` to actually evaluate.
 *   - test.roll() handles its own chat-card posting; do NOT call sendToChat.
 *   - On cancel, setupX resolves to `undefined` (because _setupTest returns
 *     early when setupData is falsy from the dialog).
 *   - After test.roll(), test.data.result has SL (string), baseSL (number),
 *     outcome ("success"|"failure"), damage (number), hitloc.result (string).
 */

import { MODULE_ID, SETTINGS } from "./constants.js";
import { EngagementTracker } from "./engagement-tracker.js";

/**
 * Minimal HTML-escape for display strings. Foundry's esc
 * exists in some versions but is not reliable across V12/V13, so we ship our
 * own to avoid the dependency.
 */
function esc(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Find melee-capable items (weapons and combat traits) on an actor.
 * Returns array of items grouped by type.
 */
function getMeleeItems(actor) {
  const items = [];
  for (const item of actor.items) {
    const sys = item.system ?? {};
    const attackType = (sys.attackType && typeof sys.attackType === "object")
      ? sys.attackType.value
      : sys.attackType;

    if (item.type === "weapon" && attackType === "melee") {
      items.push({ item, label: `${item.name} (Weapon)`, kind: "weapon" });
    } else if (item.type === "trait" && attackType === "melee") {
      items.push({ item, label: `${item.name} (Trait)`, kind: "trait" });
    }
  }
  return items;
}

/**
 * Pick which weapon/trait an opponent uses. If only one melee item exists,
 * return it directly. Otherwise prompt the GM.
 *
 * Returns { item, kind } or null on cancel.
 */
async function pickOpponentWeapon(opponent, contextLabel = "") {
  const meleeItems = getMeleeItems(opponent.actor);
  if (meleeItems.length === 0) {
    ui.notifications.warn(
      `${opponent.name} has no melee weapons or traits to attack with.`
    );
    return null;
  }
  if (meleeItems.length === 1) return meleeItems[0];

  // Multiple choices — show a picker.
  const optionsHtml = meleeItems
    .map(
      (m, i) =>
        `<option value="${i}">${esc(m.label)}</option>`
    )
    .join("");
  const content = `
    <p>Which weapon or trait should ${esc(opponent.name)} use${contextLabel ? " " + contextLabel : ""}?</p>
    <select name="pick" style="width: 100%;">${optionsHtml}</select>
  `;

  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: `Select ${opponent.name}'s weapon` },
    content,
    buttons: [
      {
        action: "ok",
        label: "Use",
        default: true,
        callback: (event, button) => {
          const idx = parseInt(button.form.elements.pick.value, 10);
          return meleeItems[idx] ?? null;
        },
      },
      { action: "cancel", label: "Cancel", callback: () => null },
    ],
    rejectClose: false,
  });
  return result ?? null;
}

/**
 * Get the live opponent actor's Advantage value, or 0 if missing.
 */
function getAdvantage(token) {
  return Number(token?.actor?.system?.status?.advantage?.value ?? 0);
}

/**
 * Adjust an actor's Advantage by a delta (can be negative). Returns the new
 * value. Uses the same actor.update path the system uses internally.
 */
async function adjustAdvantage(token, delta) {
  const cur = getAdvantage(token);
  const next = Math.max(0, cur + delta);
  await token.actor.update({ "system.status.advantage.value": next });
  return next;
}

/**
 * Set an actor's Advantage to an exact value.
 */
async function setAdvantage(token, value) {
  await token.actor.update({ "system.status.advantage.value": Math.max(0, value) });
}

// ============================================================================
// DISENGAGE FLOW
// ============================================================================

/**
 * Entry point: open the Disengage decision dialog. Called by the Token HUD
 * button.
 */
export async function openDisengageDialog(token) {
  const tracker = EngagementTracker.current();
  if (!tracker) {
    ui.notifications.warn("No engagement tracker available.");
    return;
  }

  const engagedIds = tracker.getEngagementsFor(token.id);
  if (engagedIds.length === 0) {
    ui.notifications.info(`${token.name} is not engaged with anyone.`);
    return;
  }

  const opponents = engagedIds
    .map((id) => canvas.tokens.get(id))
    .filter(Boolean);
  if (opponents.length === 0) {
    // Stale engagements only — clean up and exit.
    await tracker.disengage(token.id);
    return;
  }

  const myAdv = getAdvantage(token);
  const oppTotal = opponents.reduce((sum, t) => sum + getAdvantage(t), 0);
  const canDropAdv = myAdv > oppTotal;

  const oppList = opponents
    .map((o) => `${esc(o.name)} (${getAdvantage(o)} Adv)`)
    .join(", ");

  const content = `
    <div style="line-height: 1.5;">
      <p><strong>${esc(token.name)}</strong> is engaged with: ${oppList}.</p>
      <p>Your Advantage: <strong>${myAdv}</strong> &nbsp; | &nbsp; Opponents total: <strong>${oppTotal}</strong></p>
      ${canDropAdv
        ? `<p style="color: var(--color-text-light-success, green);">You may drop your Advantage to disengage freely (Core p.165).</p>`
        : `<p style="color: var(--color-text-light-warning, #b30);">You cannot drop Advantage to disengage \u2014 your opponents have equal or greater Advantage. Roll Dodge instead.</p>`}
    </div>
  `;

  const buttons = [];

  if (canDropAdv) {
    buttons.push({
      action: "drop",
      label: `Drop Advantage (-${myAdv})`,
      callback: () => "drop",
    });
  }

  buttons.push({
    action: "dodge",
    label: "Roll Opposed Dodge",
    callback: () => "dodge",
  });

  buttons.push({
    action: "cancel",
    label: "Cancel",
    callback: () => "cancel",
  });

  const choice = await foundry.applications.api.DialogV2.wait({
    window: { title: `${token.name} \u2014 Disengage` },
    content,
    buttons,
    rejectClose: false,
  });

  if (choice === "drop") {
    await handleDropAdvantageDisengage(token, opponents, myAdv);
  } else if (choice === "dodge") {
    await handleDodgeDisengage(token, opponents);
  }
  // "cancel" or close: do nothing
}

/**
 * Drop-Advantage path: zero out Advantage, drop all engagement edges, post
 * a chat summary. Per RAW: "If you choose to drop your Advantage to 0, you
 * can move away from your opponents without penalty."
 */
async function handleDropAdvantageDisengage(token, opponents, advSpent) {
  const tracker = EngagementTracker.current();
  if (!tracker) return;

  await setAdvantage(token, 0);
  for (const opp of opponents) {
    await tracker.disengage(token.id, opp.id);
  }

  const oppNames = opponents.map((o) => o.name).join(", ");
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ token: token.document }),
    content: `
      <div class="${MODULE_ID}-chat-panel">
        <p><strong>${esc(token.name)} disengaged.</strong></p>
        <p>Spent ${advSpent} Advantage to break away from ${esc(oppNames)}.</p>
      </div>
    `,
  });

  if (game.settings.get(MODULE_ID, SETTINGS.DEBUG)) {
    console.log(
      `${MODULE_ID} | Drop-Advantage Disengage: ${token.name} dropped ${advSpent} Adv, edges removed for ${opponents.length} opponents.`
    );
  }
}

/**
 * Dodge path: per opponent, run an Opposed Dodge (PC) vs Melee (opponent)
 * test pair. PC must beat ALL opponents to fully escape and gain +1 Adv.
 * Per RAW (strict reading): "If you succeed, you gain +1 Advantage" \u2014
 * singular success. "Each opponent defeating you gains +1 Advantage" \u2014
 * partial success allowed for individual edges.
 */
async function handleDodgeDisengage(token, opponents) {
  const tracker = EngagementTracker.current();
  if (!tracker) return;

  const wonAgainst = [];
  const lostAgainst = [];
  let aborted = false;

  for (const opp of opponents) {
    // Step 1: PC's Dodge skill test.
    const dodgeTest = await token.actor.setupSkill("Dodge", {
      appendTitle: ` \u2014 Disengage vs ${opp.name}`,
    });
    if (!dodgeTest) {
      aborted = true;
      break;
    }
    await dodgeTest.roll();

    // Step 2: Opponent's Melee weapon/trait test.
    const pick = await pickOpponentWeapon(opp, "to defend against the Disengage");
    if (!pick) {
      aborted = true;
      break;
    }
    const setupFn = pick.kind === "weapon" ? "setupWeapon" : "setupTrait";
    const meleeTest = await opp.actor[setupFn](pick.item, {
      appendTitle: ` \u2014 Defending vs ${token.name}'s Disengage`,
    });
    if (!meleeTest) {
      aborted = true;
      break;
    }
    await meleeTest.roll();

    // Step 3: Compare numeric SL. Higher wins. Tie goes to the defender
    // (opponent) per standard opposed-test convention.
    const dodgeSL = Number(dodgeTest.data.result.baseSL ?? 0);
    const meleeSL = Number(meleeTest.data.result.baseSL ?? 0);

    if (dodgeSL > meleeSL) {
      wonAgainst.push(opp);
      await tracker.disengage(token.id, opp.id);
    } else {
      lostAgainst.push(opp);
      await adjustAdvantage(opp, +1);
    }
  }

  if (aborted) {
    ui.notifications.info("Disengage cancelled.");
    return;
  }

  // Step 4: full success grants +1 Advantage to PC.
  const fullSuccess = lostAgainst.length === 0 && wonAgainst.length === opponents.length;
  if (fullSuccess) {
    await adjustAdvantage(token, +1);
  }

  // Post chat summary.
  const wonStr = wonAgainst.map((t) => esc(t.name)).join(", ");
  const lostStr = lostAgainst.map((t) => esc(t.name)).join(", ");
  let summaryHtml = `
    <div class="${MODULE_ID}-chat-panel">
      <p><strong>${esc(token.name)} \u2014 Opposed Dodge Disengage</strong></p>
  `;
  if (fullSuccess) {
    summaryHtml += `<p style="color: var(--color-text-light-success, green);">\u2705 Escaped from all opponents. Gained +1 Advantage.</p>`;
    summaryHtml += `<p>Beat: ${wonStr}</p>`;
  } else if (wonAgainst.length > 0) {
    summaryHtml += `<p>Partial success: dropped engagement with ${wonStr}, but failed to escape ${lostStr}.</p>`;
    summaryHtml += `<p style="font-size: 0.9em; opacity: 0.85;">Each opponent who beat the Dodge gained +1 Advantage.</p>`;
  } else {
    summaryHtml += `<p style="color: var(--color-text-light-warning, #b30);">\u274c Failed to escape any opponents.</p>`;
    summaryHtml += `<p>Lost to: ${lostStr}. Each gained +1 Advantage.</p>`;
  }
  summaryHtml += `</div>`;

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ token: token.document }),
    content: summaryHtml,
  });

  if (game.settings.get(MODULE_ID, SETTINGS.DEBUG)) {
    console.log(
      `${MODULE_ID} | Dodge Disengage: ${token.name} won ${wonAgainst.length}, lost ${lostAgainst.length}, fullSuccess=${fullSuccess}`
    );
  }
}

// ============================================================================
// FLEE FLOW
// ============================================================================

/**
 * Entry point: open the Flee confirmation dialog. Called by the Token HUD
 * button.
 *
 * Per RAW (Core p.165):
 *   "If you flee, your opponent immediately gains 1 Advantage and may
 *   attempt 1 free attack. The free attack is an unopposed Melee Test using
 *   whatever weapon is currently held, using the SL scored to Damage you as
 *   normal. As you are throwing caution to the wind, your opponent gains
 *   +20 to hit you. If you are hit, your opponent gains +1 Advantage, and
 *   you must enact a Challenging (+0) Cool Test: if failed, gain a Broken
 *   Condition, and a further +1 Broken condition per SL below 0."
 */
export async function openFleeDialog(token) {
  const tracker = EngagementTracker.current();
  if (!tracker) {
    ui.notifications.warn("No engagement tracker available.");
    return;
  }

  const engagedIds = tracker.getEngagementsFor(token.id);
  const opponents = engagedIds
    .map((id) => canvas.tokens.get(id))
    .filter(Boolean);

  if (opponents.length === 0) {
    // No engaged opponents \u2014 still apply Fleeing condition (e.g. for
    // self-imposed Cool failure) but skip free attacks.
    return handleUnopposedFlee(token);
  }

  const oppNames = opponents.map((o) => esc(o.name)).join(", ");
  const content = `
    <div style="line-height: 1.5;">
      <p><strong>${esc(token.name)}</strong> will flee from: ${oppNames}.</p>
      <p>Each opponent will:</p>
      <ul>
        <li>Immediately gain +1 Advantage</li>
        <li>Make a free Melee attack at <strong>+20 to hit</strong></li>
        <li>If hit: deal damage, gain another +1 Advantage, and force you to roll Cool (Challenging)</li>
        <li>If Cool fails: you gain Broken (1 + SL below 0)</li>
      </ul>
      <p style="color: var(--color-text-light-warning, #b30);"><strong>Continue?</strong></p>
    </div>
  `;

  const proceed = await foundry.applications.api.DialogV2.wait({
    window: { title: `${token.name} \u2014 Flee from combat` },
    content,
    buttons: [
      {
        action: "flee",
        label: "Flee!",
        default: true,
        callback: () => true,
      },
      { action: "cancel", label: "Cancel", callback: () => false },
    ],
    rejectClose: false,
  });

  if (!proceed) return;

  await runFleeFreeAttacks(token, opponents);
}

/**
 * For each opponent in sequence: +1 Adv, free attack (+20), on hit apply
 * damage and trigger Cool test (Challenging), on Cool fail apply Broken.
 * Then apply Fleeing condition and drop all edges.
 */
async function runFleeFreeAttacks(token, opponents) {
  const tracker = EngagementTracker.current();
  if (!tracker) return;

  const summary = [];

  for (const opp of opponents) {
    const lineParts = [`<strong>${esc(opp.name)}:</strong>`];

    // Step 1: +1 Advantage immediately (per RAW, "your opponent immediately
    // gains 1 Advantage").
    await adjustAdvantage(opp, +1);
    lineParts.push("+1 Advantage");

    // Step 2: pick weapon and trigger free attack at +20.
    const pick = await pickOpponentWeapon(opp, "for the free attack");
    if (!pick) {
      lineParts.push("(no melee weapon \u2014 skipped attack)");
      summary.push(lineParts.join(" \u2014 "));
      continue;
    }

    const setupFn = pick.kind === "weapon" ? "setupWeapon" : "setupTrait";
    const test = await opp.actor[setupFn](pick.item, {
      appendTitle: ` \u2014 Free Attack vs Fleeing ${token.name}`,
      fields: { modifier: 20 },
    });
    if (!test) {
      lineParts.push("(attack cancelled)");
      summary.push(lineParts.join(" \u2014 "));
      continue;
    }
    await test.roll();

    // Step 3: read result. Note: even if the player didn't see +20 in the
    // dialog (depending on whether `fields` actually pre-populated), we
    // still drive consequences from whatever they rolled.
    const outcome = test.data.result.outcome;
    const baseSL = Number(test.data.result.baseSL ?? 0);
    const damage = Number(test.data.result.damage ?? 0);
    const loc = test.data.result.hitloc?.result ?? "body";

    if (outcome !== "success") {
      lineParts.push(`attack missed (SL ${test.data.result.SL ?? baseSL})`);
      summary.push(lineParts.join(" \u2014 "));
      continue;
    }

    lineParts.push(`hit for ${damage} dmg (${loc}, SL ${test.data.result.SL ?? baseSL})`);

    // Step 4: apply damage.
    if (damage > 0) {
      await token.actor.applyBasicDamage(damage, {
        damageType: game.wfrp4e.config.DAMAGE_TYPE.NORMAL,
        loc,
      });
    }

    // Step 5: +1 more Advantage to opponent (RAW: "If you are hit, your
    // opponent gains +1 Advantage").
    await adjustAdvantage(opp, +1);
    lineParts.push("+1 more Adv on hit");

    // Step 6: Challenging Cool test for the fleer.
    const coolTest = await token.actor.setupCharacteristic("cl", {
      appendTitle: ` \u2014 Cool vs ${opp.name}'s free attack`,
      fields: { difficulty: "challenging" },
    });
    if (!coolTest) {
      lineParts.push("(Cool test cancelled)");
      summary.push(lineParts.join(" \u2014 "));
      continue;
    }
    await coolTest.roll();

    if (coolTest.data.result.outcome === "failure") {
      const coolSL = Number(coolTest.data.result.baseSL ?? 0);
      const slBelowZero = Math.abs(Math.min(0, coolSL));
      const brokenCount = 1 + slBelowZero;
      await token.actor.addCondition("broken", brokenCount);
      lineParts.push(`Cool failed (SL ${coolSL}) \u2192 Broken +${brokenCount}`);
    } else {
      lineParts.push("Cool held");
    }

    summary.push(lineParts.join(" \u2014 "));
  }

  // After all free attacks: apply Fleeing condition and drop all edges.
  await token.actor.addCondition("fleeing");
  for (const opp of opponents) {
    await tracker.disengage(token.id, opp.id);
  }

  // Post a single summary chat card.
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ token: token.document }),
    content: `
      <div class="${MODULE_ID}-chat-panel">
        <p><strong>${esc(token.name)} fled!</strong></p>
        <ul style="margin-top: 0.4em;">
          ${summary.map((s) => `<li>${s}</li>`).join("")}
        </ul>
        <p style="font-size: 0.9em; opacity: 0.85;">Fleeing condition applied. Move directly away using your Run movement.</p>
      </div>
    `,
  });

  if (game.settings.get(MODULE_ID, SETTINGS.DEBUG)) {
    console.log(`${MODULE_ID} | Flee complete: ${token.name} from ${opponents.length} opponents.`);
  }
}

/**
 * Edge case: token tries to Flee with no engaged opponents. Just apply the
 * Fleeing condition (RAW says Fleeing can be involuntary too). No free
 * attacks happen.
 */
async function handleUnopposedFlee(token) {
  await token.actor.addCondition("fleeing");
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ token: token.document }),
    content: `
      <div class="${MODULE_ID}-chat-panel">
        <p><strong>${esc(token.name)} fled.</strong></p>
        <p>Fleeing condition applied (no engaged opponents).</p>
      </div>
    `,
  });
}
