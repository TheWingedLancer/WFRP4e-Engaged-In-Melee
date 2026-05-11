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
import { requestOpponentDefense } from "./opponent-defense.js";

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
 *
 * Args:
 *   token: the disengaging actor's token
 *   opponents: tokens to roll against
 *   options.movementBlocked: when true, the chat card calls out that the
 *     attempted move was blocked because the Dodge wasn't fully successful.
 *     Used by the movement-trigger flow but not by the Token-HUD flow (which
 *     has no pending move to block).
 */
async function handleDodgeDisengage(token, opponents, { movementBlocked = false } = {}) {
  const tracker = EngagementTracker.current();
  if (!tracker) return { aborted: true };

  const wonAgainst = [];
  const lostAgainst = [];
  let aborted = false;

  for (const opp of opponents) {
    // Step 1: PC's Dodge skill test \u2014 runs on whichever client owns the
    // disengaging actor. If the GM clicked Disengage on a player-owned token
    // (rare but possible), the Dodge dialog appears on the GM's client.
    // Standard Foundry permission semantics handle this: setupSkill on a
    // token's actor opens the dialog where it's called.
    const dodgeTest = await token.actor.setupSkill("Dodge", {
      appendTitle: ` \u2014 Disengage vs ${opp.name}`,
    });
    if (!dodgeTest) {
      aborted = true;
      break;
    }
    await dodgeTest.roll();

    // Step 2: Opponent's Melee weapon/trait test \u2014 routed through the
    // opponent-defense module so the picker and roll dialog appear on the
    // OPPONENT's owner client (not the flow-driving client). For unowned
    // NPCs, the test runs locally as before.
    const oppResult = await requestOpponentDefense(opp, {
      mode: "defense",
      contextLabel: "to defend against the Disengage",
      appendTitle: ` \u2014 Defending vs ${token.name}'s Disengage`,
    });
    if (oppResult.aborted) {
      aborted = true;
      break;
    }

    // Step 3: Compare numeric SL. Higher wins. Tie goes to the defender
    // (opponent) per standard opposed-test convention.
    const dodgeSL = Number(dodgeTest.data.result.baseSL ?? 0);
    const meleeSL = Number(oppResult.baseSL ?? 0);

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
    return { aborted: true };
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
    if (movementBlocked) {
      summaryHtml += `<p style="color: var(--color-text-light-warning, #b30); font-size: 0.9em;">Move blocked \u2014 you didn't fully escape. Use <strong>Flee</strong> on your next attempt to leave anyway (at the cost of free attacks).</p>`;
    }
  } else {
    summaryHtml += `<p style="color: var(--color-text-light-warning, #b30);">\u274c Failed to escape any opponents.</p>`;
    summaryHtml += `<p>Lost to: ${lostStr}. Each gained +1 Advantage.</p>`;
    if (movementBlocked) {
      summaryHtml += `<p style="color: var(--color-text-light-warning, #b30); font-size: 0.9em;">Move blocked. Use <strong>Flee</strong> on your next attempt to leave anyway (at the cost of free attacks).</p>`;
    }
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

  return { aborted: false, wonAgainst, lostAgainst, fullSuccess };
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

    // Step 2: opponent's free attack at +20 \u2014 routed through the
    // opponent-defense module so the picker and roll dialog appear on the
    // OPPONENT's owner client. For unowned NPCs, runs locally as before.
    const oppResult = await requestOpponentDefense(opp, {
      mode: "freeAttack",
      contextLabel: "for the free attack",
      appendTitle: ` \u2014 Free Attack vs Fleeing ${token.name}`,
    });
    if (oppResult.aborted) {
      lineParts.push("(attack cancelled or no melee weapon)");
      summary.push(lineParts.join(" \u2014 "));
      continue;
    }

    // Step 3: read result.
    const outcome = oppResult.outcome;
    const baseSL = Number(oppResult.baseSL ?? 0);
    const damage = Number(oppResult.damage ?? 0);
    const loc = oppResult.hitloc ?? "body";
    const slDisplay = oppResult.SL ?? baseSL;

    if (outcome !== "success") {
      lineParts.push(`attack missed (SL ${slDisplay})`);
      summary.push(lineParts.join(" \u2014 "));
      continue;
    }

    lineParts.push(`hit for ${damage} dmg (${loc}, SL ${slDisplay})`);

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
    // Cool is a SKILL (based on Willpower), not a characteristic. setupSkill
    // takes the skill name as a string and falls back gracefully to the
    // underlying characteristic if the actor doesn't have the skill — same
    // behavior we rely on for "Dodge".
    const coolTest = await token.actor.setupSkill("Cool", {
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

  // After all free attacks: drop engagement edges and post a summary card.
  // Per WFRP4e Core p.167, "Broken: You are fleeing" \u2014 there is no separate
  // Fleeing condition in the system; the Broken state IS the fleeing state.
  // Broken (if any) was already applied per RAW p.165 from failed Cool tests
  // during the free-attack loop above. We do NOT auto-apply Broken here:
  // RAW only requires Broken on a failed Cool test after taking damage.
  // A character who fled successfully (no hit, or hit but Cool held) is
  // narratively fleeing this round but isn't mechanically Broken.
  //
  // Each step is wrapped so a failure in one doesn't suppress the chat
  // summary. If any step throws we log it; the user always gets a summary.
  for (const opp of opponents) {
    try {
      await tracker.disengage(token.id, opp.id);
    } catch (e) {
      console.error(`${MODULE_ID} | Flee: failed to drop edge ${token.name} <-> ${opp.name}:`, e);
    }
  }

  try {
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ token: token.document }),
      content: `
        <div class="${MODULE_ID}-chat-panel">
          <p><strong>${esc(token.name)} fled!</strong></p>
          <ul style="margin-top: 0.4em;">
            ${summary.map((s) => `<li>${s}</li>`).join("")}
          </ul>
          <p style="font-size: 0.9em; opacity: 0.85;">Move directly away using your Run movement. Any Broken Conditions from failed Cool tests have been applied above. (Per Core p.167, Broken is the fleeing state.)</p>
        </div>
      `,
    });
  } catch (e) {
    console.error(`${MODULE_ID} | Flee: failed to post summary chat card:`, e);
  }

  if (game.settings.get(MODULE_ID, SETTINGS.DEBUG)) {
    console.log(`${MODULE_ID} | Flee complete: ${token.name} from ${opponents.length} opponents.`);
  }
}

/**
 * Edge case: token tries to Flee with no engaged opponents. Per RAW (Core
 * p.165), Fleeing requires opponents to be a meaningful action \u2014 with no
 * one engaged, there's nothing to flee from. We notify the user and do not
 * auto-apply Broken (which is the fleeing condition per Core p.167).
 */
async function handleUnopposedFlee(token) {
  try {
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ token: token.document }),
      content: `
        <div class="${MODULE_ID}-chat-panel">
          <p><strong>${esc(token.name)} attempted to flee.</strong></p>
          <p>No engaged opponents \u2014 you may simply move away normally without using the Flee action.</p>
        </div>
      `,
    });
  } catch (e) {
    console.error(`${MODULE_ID} | Unopposed Flee: failed to post chat card:`, e);
  }
}

// ============================================================================
// MOVEMENT-TRIGGER DIALOG
// ============================================================================

/**
 * Replay a movement that was cancelled by the preUpdateToken hook. The
 * options.bypassEngagementCheck flag prevents the hook from re-intercepting.
 */
async function replayMove(token, targetX, targetY) {
  try {
    await token.document.update(
      { x: targetX, y: targetY },
      { bypassEngagementCheck: true }
    );
  } catch (e) {
    console.error(`${MODULE_ID} | replayMove failed:`, e);
  }
}

/**
 * Entry point for the movement-trigger flow. Called by the preUpdateToken
 * hook when a move would leave at least one opponent's reach.
 *
 * Presents a four-option dialog: Drop Advantage / Roll Dodge / Flee / Cancel.
 * Each path resolves the engagement consequences and (except Cancel) replays
 * the originally-attempted move with a bypass flag.
 *
 * Args:
 *   token: the moving Token (the placeable, not the document)
 *   leavingOpponents: array of Tokens whose reach the move would leave
 *   stayingOpponents: array of Tokens whose reach the move stays within
 *   moveTarget: { targetX, targetY } the destination coordinates
 */
export async function openMovementTriggerDialog(
  token,
  leavingOpponents,
  stayingOpponents,
  moveTarget
) {
  const tracker = EngagementTracker.current();
  if (!tracker) return;

  const allOpponents = [...leavingOpponents, ...stayingOpponents];
  const myAdv = getAdvantage(token);
  // For "Drop Advantage" eligibility we compare against ALL engaged opponents'
  // total Adv \u2014 because Drop Advantage drops ALL edges, not just the leaving
  // ones (per RAW: "you can move away from your opponents without penalty",
  // plural). The cost is dropping our Adv to 0 against the whole engagement.
  const oppTotal = allOpponents.reduce((sum, t) => sum + getAdvantage(t), 0);
  const canDropAdv = myAdv > oppTotal;

  const leavingNames = leavingOpponents.map((t) => esc(t.name)).join(", ");
  const stayingNames = stayingOpponents.length > 0
    ? stayingOpponents.map((t) => esc(t.name)).join(", ")
    : null;

  let stayingHtml = "";
  if (stayingNames) {
    stayingHtml = `<p style="font-size: 0.9em; opacity: 0.85;">You will remain engaged with: ${stayingNames}.</p>`;
  }

  const content = `
    <div style="line-height: 1.5;">
      <p><strong>${esc(token.name)}</strong> is moving out of reach of: <strong>${leavingNames}</strong>.</p>
      ${stayingHtml}
      <p>Your Advantage: <strong>${myAdv}</strong> &nbsp; | &nbsp; All opponents total: <strong>${oppTotal}</strong></p>
      ${canDropAdv
        ? `<p style="color: var(--color-text-light-success, green);">You may drop your Advantage to disengage from <em>all</em> opponents (Core p.165).</p>`
        : `<p style="color: var(--color-text-light-warning, #b30);">You cannot drop Advantage to disengage \u2014 your opponents have equal or greater Advantage.</p>`}
      <p>Choose how to handle the disengagement:</p>
    </div>
  `;

  const buttons = [];

  if (canDropAdv) {
    buttons.push({
      action: "drop",
      label: `Drop Advantage (-${myAdv}, drops all)`,
      callback: () => "drop",
    });
  }

  buttons.push({
    action: "dodge",
    label: `Roll Dodge (vs ${leavingOpponents.length} opponent${leavingOpponents.length === 1 ? "" : "s"})`,
    callback: () => "dodge",
  });

  buttons.push({
    action: "flee",
    label: "Flee (free attacks from all)",
    callback: () => "flee",
  });

  buttons.push({
    action: "cancel",
    label: "Cancel (don't move)",
    callback: () => "cancel",
  });

  const choice = await foundry.applications.api.DialogV2.wait({
    window: { title: `${token.name} \u2014 Leaving combat reach` },
    content,
    buttons,
    rejectClose: false,
  });

  // Handle the choice. After consequence resolution (except Cancel), replay
  // the original move so the token actually ends up at the destination.
  if (choice === "drop") {
    // Drops engagement with ALL opponents (per RAW), then replay the move.
    await handleDropAdvantageDisengage(token, allOpponents, myAdv);
    await replayMove(token, moveTarget.targetX, moveTarget.targetY);
  } else if (choice === "dodge") {
    // Roll Dodge only vs the leaving opponents. Per RAW Core p.165 strict
    // reading: a failed Dodge means the disengage attempt itself failed, so
    // the move is BLOCKED. The player can re-attempt with Flee on their
    // next move if they want to leave anyway (at the cost of free attacks).
    // We only replay the move on a full success (beat ALL leaving opponents).
    // Partial success also blocks the move \u2014 you didn't fully escape so
    // you don't move. (The won-edges still drop per handleDodgeDisengage.)
    const result = await handleDodgeDisengage(token, leavingOpponents, { movementBlocked: true });
    if (result?.fullSuccess === true) {
      await replayMove(token, moveTarget.targetX, moveTarget.targetY);
    }
    // Failed/partial/aborted: token snaps back automatically (preUpdateToken
    // already returned false). handleDodgeDisengage's own chat card explains
    // the outcome to the player, including the "move blocked" guidance.
  } else if (choice === "flee") {
    // Flee triggers free attacks from ALL engaged opponents (not just the
    // leaving ones), per RAW \u2014 "If you flee, your opponent immediately gains
    // 1 Advantage and may attempt 1 free attack" (singular "your opponent"
    // but plural in spirit when multiply engaged).
    await runFleeFreeAttacks(token, allOpponents);
    await replayMove(token, moveTarget.targetX, moveTarget.targetY);
  }
  // "cancel" or close: do nothing; token already snapped back automatically
  // when the preUpdateToken hook returned false.
}
