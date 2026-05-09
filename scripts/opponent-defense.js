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
 * Find melee-capable items on an actor. Mirrors the helper in
 * disengage-flee.js. We re-implement here so this module can be loaded
 * standalone (e.g., the query handler runs on a player client, which still
 * needs to walk the opponent's items locally).
 */
function getMeleeItems(actor) {
  const items = [];
  for (const item of actor.items) {
    const sys = item.system ?? {};
    const attackType = (sys.attackType && typeof sys.attackType === "object")
      ? sys.attackType.value
      : sys.attackType;

    if (item.type === "weapon" && attackType === "melee") {
      items.push({ itemId: item.id, label: `${item.name} (Weapon)`, kind: "weapon" });
    } else if (item.type === "trait" && attackType === "melee") {
      items.push({ itemId: item.id, label: `${item.name} (Trait)`, kind: "trait" });
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
  // marker so onCreateChatMessage can flag the resulting message for the
  // damage-suppression render hook. Marker is keyed by actor id and is
  // self-expiring (5 second TTL) to prevent leaking onto unrelated rolls.
  if (mode === "defense") {
    const stash = (globalThis[`__${MODULE_ID}_suppressDamage`] ||= new Map());
    stash.set(token.actor.id, { _timestamp: Date.now() });
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
 * Public entry point. Called from the flow-driving client (whoever clicked
 * the Disengage/Flee button or triggered the movement dialog).
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

  // Path 1: this client owns the opponent's actor — run locally.
  if (opponentToken.actor.isOwner && !game.user.isGM) {
    return runOpponentTestLocally({
      token: opponentToken,
      mode,
      contextLabel,
      appendTitle,
      modifier,
    });
  }

  // Path 2: find an active human owner and delegate to their client.
  const owner = findActiveHumanOwner(opponentToken.actor);
  if (owner && owner.id !== game.user.id) {
    try {
      const result = await owner.query(
        QUERY_ID,
        {
          tokenId: opponentToken.id,
          mode,
          contextLabel,
          appendTitle,
          modifier,
        },
        { timeout: QUERY_TIMEOUT_MS }
      );
      // Defensive: if the queried client returned malformed data, treat as
      // aborted so the caller doesn't apply phantom consequences.
      if (!result || typeof result !== "object") {
        return { aborted: true };
      }
      return result;
    } catch (err) {
      console.warn(
        `${MODULE_ID} | requestOpponentDefense: query to ${owner.name} for ${opponentToken.name} failed (${err?.message ?? err}); falling back to local execution`
      );
      // Timeout, network failure, or remote exception. Post a chat note and
      // skip the test. The Disengage flow treats this as "opponent did not
      // defend" — usually means the player went AFK.
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

  // Path 3: no active human owner — run locally on this client. For unowned
  // NPCs driven by the GM, this is the same flow as v0.1.20 and earlier.
  return runOpponentTestLocally({
    token: opponentToken,
    mode,
    contextLabel,
    appendTitle,
    modifier,
  });
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
