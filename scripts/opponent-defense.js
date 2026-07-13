/**
 * Opponent-defense routing.
 *
 * When a Disengage or Flee flow needs an opponent to roll something (defending
 * weapon test in a Dodge-Disengage, free attack in a Flee), the dialogs MUST
 * appear on the client that owns the opponent's actor — not on the client
 * that initiated the flow. Otherwise the GM ends up clicking through dialogs
 * for player-controlled tokens and the player never sees their own roll.
 *
 * We use the V13 query system (CONFIG.queries) to delegate. The flow-driving
 * client calls `requestOpponentDefense(opponentToken, mode, contextLabel)`.
 * That helper:
 *   - If the local client owns the opponent's actor, runs locally.
 *   - Else, finds an active human owner of the opponent and queries them via
 *     User#query. The query handler runs on that user's client, opens the
 *     weapon picker and the roll dialog there, awaits the roll, and returns
 *     the test result.
 *   - If no active human owner exists, runs locally on the GM (preserves
 *     v0.1.20 behavior for unowned NPCs).
 *
 * Modes:
 *   - "defense":   no modifier; used in Dodge-Disengage opposed Melee tests
 *   - "freeAttack": +20 modifier; used in Flee free attacks
 *
 * Returned shape (from any branch):
 *   {
 *     aborted: boolean,        // true if user closed/cancelled any dialog
 *     baseSL: number,          // numeric SL of the rolled test
 *     SL: string,              // string SL like "+1" or "-2"
 *     outcome: "success"|"failure",
 *     damage: number,          // damage rolled (for free attacks)
 *     hitloc: string,          // hit location id
 *   }
 *
 * On `aborted`, all other fields may be missing — callers should check
 * `aborted` first and short-circuit.
 */

import { MODULE_ID } from "./constants.js";
import { isWeaponMelee } from "./reach.js";

const QUERY_ID = `${MODULE_ID}.opponentDefense`;
// Five minutes — players take real time to click weapon pickers and roll
// dialogs, especially mid-session with side conversations.
const QUERY_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Minimal HTML-escape duplicated from disengage-flee.js to avoid an import
 * cycle. Foundry's escape helpers vary across versions.
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
 * Find melee-capable items on an actor.
 *
 * Uses the shared isWeaponMelee helper from reach.js for weapon detection,
 * which gives us the weaponGroup fallback for items where attackType is
 * missing (custom items, older data shapes). Trait detection stays strict
 * on attackType because traits don't have a weaponGroup field \u2014 the
 * only signal we have is the explicit attackType: "melee" declaration.
 * In practice every compendium creature trait sets this correctly; the
 * gap is only for hand-crafted custom traits, and a stricter check is
 * better than a fuzzy name-based heuristic that could false-positive.
 *
 * The equipped flag is intentionally NOT filtered here: opponent-side
 * defense and free-attack flows offer whatever the opponent carries, since
 * NPC stat blocks frequently leave "equipped" inconsistent. The user
 * picking the weapon makes the final call.
 */
function getMeleeItems(actor) {
  const items = [];
  for (const item of actor.items) {
    if (item.type === "weapon") {
      if (isWeaponMelee(item)) {
        items.push({ itemId: item.id, label: `${item.name} (Weapon)`, kind: "weapon" });
      }
    } else if (item.type === "trait") {
      const sys = item.system ?? {};
      const attackType = (sys.attackType && typeof sys.attackType === "object")
        ? sys.attackType.value
        : sys.attackType;
      if (attackType === "melee") {
        items.push({ itemId: item.id, label: `${item.name} (Trait)`, kind: "trait" });
      }
    }
  }
  return items;
}

/**
 * Pick which weapon/trait an opponent uses. If only one melee item exists,
 * return it directly. Otherwise prompt the user on whichever client this
 * runs on.
 *
 * Returns { itemId, kind, label } or null on cancel.
 */
async function pickOpponentWeaponLocal(opponentActor, opponentName, contextLabel = "") {
  const meleeItems = getMeleeItems(opponentActor);
  if (meleeItems.length === 0) {
    ui.notifications.warn(
      `${opponentName} has no melee weapons or traits to attack with.`
    );
    return null;
  }
  if (meleeItems.length === 1) return meleeItems[0];

  const optionsHtml = meleeItems
    .map((m, i) => `<option value="${i}">${esc(m.label)}</option>`)
    .join("");
  const content = `
    <p>Which weapon or trait should ${esc(opponentName)} use${contextLabel ? " " + contextLabel : ""}?</p>
    <select name="pick" style="width: 100%;">${optionsHtml}</select>
  `;

  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: `Select ${opponentName}'s weapon` },
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
 * Resolve a token+actor pair from a tokenId on whichever client this runs on.
 * Returns null if the token is no longer present (scene change, deletion).
 */
function resolveTokenAndActor(tokenId) {
  const token = canvas?.tokens?.get(tokenId);
  if (!token?.actor) return null;
  return { token, actor: token.actor };
}

/**
 * Run the opponent-side test locally on this client.
 *
 * Args:
 *   token: the opponent's Token placeable
 *   mode: "defense" | "freeAttack"
 *   contextLabel: human-readable context for the picker prompt
 *   appendTitle: text appended to the test dialog title
 *   modifier: numeric modifier to inject into the test (typically 0 or 20)
 *
 * Returns the result shape documented at the top of this file.
 */
async function runOpponentTestLocally({ token, mode, contextLabel, appendTitle, modifier }) {
  const pick = await pickOpponentWeaponLocal(token.actor, token.name, contextLabel);
  if (!pick) {
    return { aborted: true };
  }

  const item = token.actor.items.get(pick.itemId);
  if (!item) {
    ui.notifications.warn(`${token.name}'s ${pick.label} is no longer available.`);
    return { aborted: true };
  }

  const setupFn = pick.kind === "weapon" ? "setupWeapon" : "setupTrait";
  const setupOptions = { appendTitle };
  if (modifier && Number(modifier) !== 0) {
    setupOptions.fields = { modifier: Number(modifier) };
  }
  const test = await token.actor[setupFn](item, setupOptions);
  if (!test) {
    return { aborted: true };
  }

  // For Dodge-Disengage defense rolls: the system's chat card includes a
  // Damage line and an Apply Damage button. Per RAW (Core p.165), no damage
  // is awarded on these opposed tests \u2014 only Advantage shifts. Stash a
  // marker so onPreCreateChatMessage can flag the resulting message for the
  // damage-suppression render hook.
  //
  // Important: we key by TOKEN id (not actor id) because synthetic
  // (unlinked) tokens carry an actor delta whose id can differ between the
  // token actor and the world actor. message.speaker.token, by contrast, is
  // the literal token id on the canvas and matches what we have here.
  //
  // The stash lives only on whichever client called runOpponentTestLocally
  // \u2014 that's also the client that test.roll() will create the chat message
  // on, so onPreCreateChatMessage will see the same stash entry and bake the
  // flag into the pending document via updateSource. Other clients receiving
  // the created message (flag already present) render correctly; their own
  // local stash is empty and no-ops. 5-second TTL prevents leaking onto
  // unrelated rolls if a test is cancelled mid-flight.
  if (mode === "defense") {
    const stash = (globalThis[`__${MODULE_ID}_suppressDamage`] ||= new Map());
    stash.set(token.id, { _timestamp: Date.now() });
  }

  await test.roll();

  const result = test.data?.result ?? {};
  return {
    aborted: false,
    baseSL: Number(result.baseSL ?? 0),
    SL: result.SL ?? "",
    outcome: result.outcome ?? "failure",
    damage: Number(result.damage ?? 0),
    hitloc: result.hitloc?.result ?? "body",
  };
}

/**
 * Find an active human user who owns this actor. Returns null if none.
 *
 * "Active" means logged in right now (game.users.find(u => u.active)). A
 * user who logs back in mid-session will start receiving routed queries
 * from that moment forward, since this is re-evaluated per call.
 *
 * If the only owner is the current GM (e.g., Game Master assigned to actor),
 * we return null so the caller falls through to the local-execution path
 * (the GM client is already driving the flow).
 */
function findActiveHumanOwner(actor) {
  if (!game.users) return null;
  for (const user of game.users) {
    if (!user.active) continue;
    if (user.isGM) continue;
    if (actor.testUserPermission(user, "OWNER")) return user;
  }
  return null;
}

/**
 * Find an active GM user. For unowned NPCs (no human owner) the GM is the
 * de facto controller; we route opponent-side rolls there. If multiple GMs
 * are active, prefer the designated activeGM if available.
 */
function findActiveGM() {
  if (!game.users) return null;
  const activeGM = game.users.activeGM;
  if (activeGM && activeGM.active) return activeGM;
  for (const user of game.users) {
    if (user.active && user.isGM) return user;
  }
  return null;
}

/**
 * Delegate the opponent-side test to another user's client via CONFIG.queries.
 * Returns the same result shape as runOpponentTestLocally, or { aborted: true }
 * on timeout / error / disconnect.
 */
async function queryRemoteUser(targetUser, opponentToken, payload) {
  try {
    const result = await targetUser.query(
      QUERY_ID,
      {
        tokenId: opponentToken.id,
        ...payload,
      },
      { timeout: QUERY_TIMEOUT_MS }
    );
    if (!result || typeof result !== "object") return { aborted: true };
    return result;
  } catch (err) {
    console.warn(
      `${MODULE_ID} | requestOpponentDefense: query to ${targetUser.name} for ${opponentToken.name} failed (${err?.message ?? err})`
    );
    try {
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ token: opponentToken.document }),
        content: `
          <div class="${MODULE_ID}-chat-panel">
            <p><strong>${esc(opponentToken.name)}</strong> did not respond to the defense request \u2014 test skipped.</p>
          </div>
        `,
      });
    } catch (_) {}
    return { aborted: true };
  }
}

/**
 * Public entry point. Called from the flow-driving client (whoever clicked
 * the Disengage/Flee button or triggered the movement dialog).
 *
 * Routing (in order):
 *   1. If THIS client owns the opponent's actor (player owning their PC),
 *      run locally. Dialogs appear on the current client.
 *   2. If an active human OWNS the opponent (someone else's PC, or a
 *      shared NPC with an assigned player owner), query that human.
 *   3. No human owner. If THIS client is the GM, run locally \u2014 the GM
 *      is the de facto controller of unowned NPCs.
 *   4. No human owner and THIS client is NOT the GM (e.g., a player just
 *      triggered Disengage against a GM-controlled orc). Query the
 *      active GM so the picker/roll dialog opens on the GM's screen.
 *      Without this routing the dialog would open on the player's screen
 *      \u2014 they'd be rolling the orc's defense for the GM, which is wrong.
 *   5. No GM available either: return aborted. We can't proxy.
 *
 * Args:
 *   opponentToken: the Token placeable for the opponent
 *   mode: "defense" | "freeAttack"
 *   contextLabel: text for the weapon-picker prompt
 *   appendTitle: text appended to the roll dialog title
 *
 * Returns the result shape documented at the top of this file.
 */
export async function requestOpponentDefense(opponentToken, { mode, contextLabel, appendTitle }) {
  const modifier = mode === "freeAttack" ? 20 : 0;
  const payload = { mode, contextLabel, appendTitle, modifier };

  // Path 1: this client owns the opponent's actor \u2014 run locally.
  // (Exclude GMs from this branch: GMs "own" everything, but we want
  // unowned-NPC routing to fall through to Path 3 below where the GM
  // also runs locally with the right semantics.)
  if (opponentToken.actor.isOwner && !game.user.isGM) {
    return runOpponentTestLocally({ token: opponentToken, ...payload });
  }

  // Path 2: an active human player owns the opponent \u2014 delegate to them.
  const humanOwner = findActiveHumanOwner(opponentToken.actor);
  if (humanOwner && humanOwner.id !== game.user.id) {
    return queryRemoteUser(humanOwner, opponentToken, payload);
  }

  // Path 3: no human owner. If THIS client is the GM, run locally.
  if (game.user.isGM) {
    return runOpponentTestLocally({ token: opponentToken, ...payload });
  }

  // Path 4: no human owner and we're not the GM. Route the test to the GM
  // so their client opens the picker and roll dialog. This is the common
  // case for a player attempting to Disengage from a GM-controlled enemy:
  // before this routing, the orc's weapon-pick and attack roll appeared on
  // the player's screen, which is wrong.
  const gm = findActiveGM();
  if (gm) {
    return queryRemoteUser(gm, opponentToken, payload);
  }

  // Path 5: no GM online. We genuinely cannot proxy this. Abort and log.
  console.warn(
    `${MODULE_ID} | requestOpponentDefense: no human owner and no active GM for ${opponentToken.name}; cannot proxy defense test`
  );
  return { aborted: true };
}

/**
 * Query handler. Registered into CONFIG.queries during init. Runs on the
 * receiving client (the opponent's owner) and opens the weapon picker + test
 * dialog there. Returns the test result back to the requesting client.
 */
async function handleOpponentDefenseQuery(queryData, { timeout } = {}) {
  try {
    const { tokenId, mode, contextLabel, appendTitle, modifier } = queryData ?? {};
    if (!tokenId) return { aborted: true };

    const resolved = resolveTokenAndActor(tokenId);
    if (!resolved) {
      console.warn(`${MODULE_ID} | opponentDefense query: token ${tokenId} not found on this client`);
      return { aborted: true };
    }

    return await runOpponentTestLocally({
      token: resolved.token,
      mode,
      contextLabel,
      appendTitle,
      modifier,
    });
  } catch (err) {
    console.error(`${MODULE_ID} | opponentDefense query handler error:`, err);
    return { aborted: true };
  }
}

/**
 * Register the query handler. Called from main.js during init.
 */
export function registerOpponentDefenseQuery() {
  if (!CONFIG.queries) {
    console.warn(`${MODULE_ID} | CONFIG.queries unavailable; opponent-defense routing disabled (Foundry < V13?)`);
    return;
  }
  CONFIG.queries[QUERY_ID] = handleOpponentDefenseQuery;
  console.log(`${MODULE_ID} | Registered query: ${QUERY_ID}`);
}
