# WFRP4e Engaged In Melee — Architecture

This document describes how the module is organized internally: which file owns which responsibility, how data flows between them, and the rationale behind the non-obvious design choices. The intended audience is anyone (including future-Jeramie) maintaining or extending the module.

This is grounded in the source comments themselves. Anywhere the comments describe a rationale, this doc preserves it; anywhere the comments are sparse or outdated, this doc says so.

## At a glance

A FoundryVTT module for the **Warhammer Fantasy Roleplay 4th Edition** system. It tracks melee engagement, applies the Outnumbering bonus (Core p.161) automatically, and provides Disengage/Flee flows for ending engagements (Core p.165).

- **Foundry compatibility:** V13 (verified on 13.351)
- **System compatibility:** wfrp4e 9.x (verified on 9.4.0)
- **Module ID:** `wfrp4e-engaged-in-melee`

The module is built around three small, separable services:
- **EngagementTracker** — graph of who is engaged with whom, persisted as a scene flag
- **Outnumbering calculator** — pure function: given attacker, defender, tracker, returns the +20/+40 bonus and breakdown
- **Reach resolver** — pure function: given a token, returns its longest equipped melee weapon's reach in yards

Everything else is wiring — Foundry hooks that observe attacks and movement, dialogs for the Disengage and Flee actions, and a socket layer that lets non-GM clients perform writes.

## File map

```
scripts/
├── main.js                  Hook registration, init/ready lifecycle, module API surface
├── constants.js             MODULE_ID, FLAGS, SETTINGS, ENGAGED_STATUS_ID, EXCLUDED_CONDITIONS, OUTNUMBERING_BONUSES
├── settings.js              Foundry game settings registration
│
├── engagement-tracker.js    EngagementTracker class, scene-flag persistence, GM-authoritative socket layer, advantage-write helper
├── outnumbering.js          calculateOutnumbering(), areAllied() — the math and the disposition/mount allyship rules
├── reach.js                 getTokenEngagementReach(), getEngagementThreshold(), getMoverInterceptThreshold()
│
├── roll-hooks.js            renderWeaponDialog/renderTraitDialog injection, post-roll engagement establishment, outnumbering breakdown chat panel, damage-line suppression on Dodge-Disengage cards
├── movement-hooks.js        preUpdateToken (dialog trigger) and updateToken (auto-disengage)
├── combat-hooks.js          combatRound stale-pruning, deleteCombat cleanup, deleteToken cleanup, createActiveEffect for incapacitation
├── token-hud.js             Disengage and Flee buttons on the Token HUD
│
├── disengage-flee.js        Disengage decision dialog, Flee confirmation, Dodge/Flee flow orchestration, movement-trigger dialog
└── opponent-defense.js      CONFIG.queries-based routing of opponent-side weapon picker and roll dialogs to opponent's owner client
```

## The engagement model

The core data structure is a **graph of token-id pairs**, stored as a flag on the active scene document.

```js
scene.flags["wfrp4e-engaged-in-melee"].engagements = {
  "tokenIdA": {
    "tokenIdB": { round: 3 },   // edge: A engaged with B since round 3
    "tokenIdC": { round: 3 },   // edge: A engaged with C since round 3
  },
  "tokenIdB": {
    "tokenIdA": { round: 3 },   // edges are symmetric
  },
  // ...
}
```

Each engagement is stored twice (once on each endpoint) for fast lookup of "who is X engaged with?" without scanning every node.

**State location: scene, not Combat.** Stored on the scene so the module works whether or not a Combat is running. Engagements happen out-of-combat too (in skirmish mode), pruned by wall-clock time instead of round number. (The header comment in `constants.js` was wrong in v0.1.23 and earlier — fixed in v0.1.24.) The code stores on `scene.setFlag(...)`.

**Engagement is established by attack actions, not by distance.** This follows RAW Core p.159: two tokens become Engaged when one attacks the other in melee. Two tokens standing next to each other are not Engaged until someone swings. The engagement persists until pruned.

**Pruning:**
- In-combat: stale engagements (no attacks for a full round) are pruned at the start of each new round (`combatRound` hook, Core p.159).
- Skirmish: engagements with `round: 0` are pruned by wall-clock time after a configurable TTL (default 60 seconds).
- Combat end: all engagements clear (`deleteCombat` hook).
- Token deletion: that token's edges are dropped (`deleteToken` hook).
- Token incapacitation (dead, unconscious, defeated): that token's edges drop immediately (`createActiveEffect` hook, v0.1.27). Engaged icons clear on both that token and any survivor whose last engagement was with them.

**Excluded conditions:** `unconscious`, `dead`, and `defeated` exclude an ally from outnumbering counts. Broken/Fleeing characters per Core p.168 CAN still be engaged — they still occupy space and force opponents to deal with them, they just can't take normal actions. Earlier versions excluded Broken too; this was reverted in v0.1.15. Dead and defeated were added in v0.1.26 after a dead orc was observed still counting for outnumbering math at the table.

## The three pure services

### `EngagementTracker` (engagement-tracker.js)

The graph manager. Two responsibilities:

1. **Read API:** `getEngagementsFor(tokenId)`, `areEngaged(a, b)` — used by callers everywhere. Reads work on any client (scene flags are world-state, synced to everyone).
2. **Write API:** `engage(a, b, round)`, `disengage(a, b)`, `pruneStale(round)`, `pruneStaleByTime(seconds)`, `clear()` — writes only work on the active GM client. Non-GM callers automatically socket-route to the GM.

The class is a thin wrapper around module-level `performXLocally(...)` functions. Writers check `isActiveGM()`:
- If yes → call the local performer directly
- If no → emit a socket message; the GM's listener receives it and runs the local performer

This pattern was introduced in v0.1.18 after discovering that player clients can't write to scene flags or to GM-owned actors. Before v0.1.20, the socket layer didn't broadcast across clients because the module manifest was missing `"socket": true`; that was the v0.1.20 fix.

Diagnostic console logs (`SOCKET RECEIVED`, `SOCKET handling`, `SOCKET completed`, `engage: emitting socket message to GM for ...`) were added in v0.1.19 and remain in v0.1.23 in case socket issues recur. They can be stripped in a future polish version.

### Outnumbering calculator (outnumbering.js)

A pure function: `calculateOutnumbering(attackerToken, defenderToken, tracker)` returns:
```js
{
  bonus: 0 | 20 | 40,
  attackerSideCount: number,
  defenderSideCount: number,
  ratio: "1:1" | "2:1" | "3:1" | ...,
  attackerSideTokens: Token[],
  defenderSideTokens: Token[],
  combatMaster: null | {           // present only when Combat Master adjusted a count
    side: "attacker" | "defender",
    total: number,                 // levels added to that side
    contributors: [{ name, level }],
    rawAttackerCount: number,
    rawDefenderCount: number,
  },
}
```

The algorithm, per Core p.161:
1. Side A = `{attacker} ∪ (attacker's allies engaged with defender)`
2. Side D = `{defender} ∪ (defender's allies engaged with attacker)`
3. Filter both sides for tokens in fighting condition (i.e., not Unconscious/dead/defeated)
4. **Combat Master (Core p.134-135):** if the sides are unequal, sum the Combat Master talent levels (`talent.system.advances.value`) across combatants on the *smaller* (outnumbered) side and add that to the smaller side's count. Only the outnumbered side benefits — an even fight gets no adjustment, and a Combat Master holder on the larger side contributes nothing. Per the literal reading (table ruling), this can push a count past parity and flip the outnumbering bonus to the Combat-Master side. See `getCombatMasterLevel` / `sumCombatMasterLevels`.
5. Ratio = ⌊|Side A| / |Side D|⌋ (adjusted). Apply the highest matching bonus from `OUTNUMBERING_BONUSES`.

The `combatMaster` field, when populated, drives a transparency note in both the modifier tooltip and the chat-card breakdown panel ("+N from Combat Master on X's side: ...").

**Note on the symmetric reading:** the math counts allies-engaged-with-the-OTHER-side, not allies-engaged-with-each-other. The "common point" is the attacker-defender pair: anyone on your side who is also in melee with the person you're swinging at counts, and anyone on their side who is also in melee with you counts. Allies don't need to be mutually engaged.

This matters in practice. Two HOSTILE orcs both attacking Tristan but not standing next to each other still trigger outnumbering once both are engaged with Tristan — even though the orcs aren't engaged with each other.

**Allyship: `areAllied(tokenA, tokenB)`** — same disposition match, plus mount/rider transitive. A NEUTRAL warhorse ridden by a FRIENDLY PC inherits FRIENDLY for outnumbering purposes (Rideable module flag `flags.Rideable.RidersFlag` and WFRP4e's native `actor.system.status.mount` both supported).

The transitive rule only fires when one of the two tokens is actually IN a mount relationship. Two random NEUTRAL tokens that happen to share disposition with a mount somewhere on the canvas do not become allies.

**Disposition matters strictly.** If you place a HOSTILE orc next to a NEUTRAL orc, they will NOT count as allies. (Lesson learned during v0.1.22 testing — Orc 2 was accidentally NEUTRAL while Orc 4 was HOSTILE, and outnumbering didn't kick in for either. Strict matching is the intended behavior; the fix is the data, not the code.)

### Reach resolver (reach.js)

Three exported functions, all pure:

- **`getTokenEngagementReach(token)`** — returns the longest equipped melee weapon's reach in yards. Personal/Short/Long all map to 2yd; Very Long → 4yd; Massive → 6yd (Core p.297). Falls back to 2yd if no equipped melee weapons. Does not currently inspect creature traits for innate reach.

- **`getEngagementThreshold(tokenA, tokenB)`** — returns `MAX(reachA, reachB)`. **Used for auto-disengage in `updateToken`**: the engagement edge persists as long as either party can still threaten the other.

- **`getMoverInterceptThreshold(mover, opponent)`** — returns `getTokenEngagementReach(opponent)` only, ignoring the mover's reach. **Used by the movement-trigger dialog gate** (`preMoveToken` on V13+, `preUpdateToken` on the V12 fallback): the opponent can only intercept the move if their weapon can reach the mover. This is the asymmetric reading introduced in v0.1.22.

The split matters: in the movement-trigger gate, a pike-wielder stepping back from a dagger-wielder gets no dialog (dagger can't intercept). But the engagement edge can still drop in `onUpdateToken` once the pike-wielder is beyond their OWN 6yd reach, since at that point neither party can threaten the other.

## The hook integrations

Hooks are registered in `main.js`. There are seven, plus two ESM imports of system hooks.

### `renderWeaponDialog` and `renderTraitDialog` → `onRenderWeaponDialog` (roll-hooks.js)

Fired by WFRP4e when an attack dialog opens. The handler:
1. Resolves attacker and target tokens from the dialog (`getAttackerTokenFromDialog`, `getMeleeTargetFromDialog`).
2. Calls `calculateOutnumbering` against the current tracker.
3. If bonus > 0:
   - Writes the bonus to `dialog.fields.modifier`. The system reads this for the actual roll, so the bonus correctly affects Critical/Fumble determination per RAW.
   - Patches the DOM `data-tooltip` attribute on the modifier input, form-fields, and form-group surfaces so hovering shows the outnumbering breakdown.
4. Stamps the dialog instance with `[APPLIED_MARKER]` so re-renders (e.g., Charging toggle) don't compound the bonus.

The DOM-direct tooltip approach was the v0.1.23 fix. Earlier versions participated in the system's `dialog.tooltips._modifier.list` machinery; cross-round bleed between dialog instances caused stale outnumbering text to persist into new dialogs. The current implementation defers via `setTimeout(0)`, reads existing tooltip content, strips any prior outnumbering line (regex match on `<p>&#8226; Bonus for outnumbering...</p>`), appends a fresh entry, and writes back. This avoids the system's tooltip object model entirely.

There is also a "system rebaseline detection" path: when the user toggles Charging in the dialog, the system resets `modifier` to 0 between renders. The hook detects this (current value < previously-applied value) and re-applies the bonus.

### `wfrp4e:rollWeaponTest` and `wfrp4e:rollTraitTest` → `onRollMeleeTest`

Fired after the test resolves. The handler records the engagement edge (attacker ↔ each target) by calling `tracker.engage(...)`. This is where engagement is actually established — *not* at attack-dialog open.

WFRP4e does not fire `preRoll` hooks (verified empirically). The `wfrp4e:rollXTest` hooks fire post-roll on all clients. The handler also stashes the outnumbering breakdown in a per-actor `__pending` map keyed by speakerActorId, so the next `preCreateChatMessage` hook can attach it as a flag.

### `preCreateChatMessage` and `renderChatMessageHTML` → `onPreCreateChatMessage`, `onRenderChatMessage`

Two-stage handling:

- **`preCreateChatMessage`** (initiating client): reads the pending breakdown for the speaker actor (outnumbering) and the damage-suppression marker for the speaker token id, and writes each as a flag on the PENDING message via `message.updateSource(...)` \u2014 synchronously, before the document is created. This is deliberate (v0.1.32): the earlier `createChatMessage` + `await setFlag()` approach wrote the flag AFTER creation, triggering a second render, and on V14 the first render (no flag) produced no panel while the flag-bearing re-render appended to a detached node. Writing into the pending source guarantees the flag is present on the first render. The flag becomes part of the created document and syncs to all clients automatically; no isGM gate is needed because the message author owns the pending document.
- **`renderChatMessageHTML`** (all clients): reads both flags. For outnumbering, appends an info panel showing attacker/defender/ratio/bonus (plus a Combat Master note when present). For damage suppression, hides damage/hit-location/qualities rows and the Apply Damage button, then appends "*Disengage defense — no damage applied (Core p.165).*"

The damage suppression machinery was introduced in v0.1.22 and made reliable in v0.1.23 (key change: stash by token id instead of actor id, since synthetic tokens have actor-delta ids that can differ from world-actor ids). The pre-create flag-write timing fix came in v0.1.32.

### `combatRound`, `deleteCombat`, `deleteToken`, `createActiveEffect` → combat-hooks.js

Pruning and cleanup hooks. All guarded by `shouldHandleStateChange()` which is the active-GM check — only one client should mutate state to avoid races. `combatRound` prunes engagements with no attacks in the new round per Core p.159; `deleteCombat` clears everything; `deleteToken` drops all edges involving the removed token; `createActiveEffect` (v0.1.27) drops all edges for a token that just became dead/unconscious/defeated, filtered by overlap between the new effect's `statuses` set and `EXCLUDED_CONDITIONS`.

### `updateToken` → `onUpdateToken` (movement-hooks.js)

Post-move auto-disengage. Iterates over the moved token's engagement edges and uses `getEngagementThreshold` (symmetric MAX) to decide whether to drop each edge. Active-GM gated.

### Movement-trigger gate (movement-hooks.js)

The movement-trigger dialog hook — where the Disengage/Flee dialog opens when a token's move would leave engagement reach. The gate is registered on exactly one hook, feature-detected in `main.js` by the presence of `TokenDocument#move`: `preMoveToken` → `onPreMoveToken` on V13+ (required on V14, where a raw positional `update` is superseded by the movement pipeline and can be silently reverted), and `preUpdateToken` → `onPreUpdateToken` as the V12 fallback. Both handlers run the same gating logic below; they differ only in where the destination and bypass flag come from (`movement.destination` / `operation` vs `changes` / `options`).

Several layers of correctness here:

1. **No-op move filter** (v0.1.21, `preUpdateToken` path only): WFRP4e attack resolution sometimes updates a token document with `changes.x`/`changes.y` set to the same value as the current x/y (e.g., for animation refs, hit-effect overlays). The `onPreUpdateToken` handler compares projected position vs current position and bails if there's no actual change. `onPreMoveToken` needs no such filter — `preMoveToken` fires only on real movement, not on incidental document writes.

2. **Crossing-threshold model** (v0.1.23): the dialog fires only when pre-move distance ≤ threshold AND post-move distance > threshold. If the mover was already outside the opponent's reach pre-move, they're not "leaving" — no dialog. This is what makes Igor's pike-wielder not trigger a dialog when stepping back from a dagger-wielding orc he was never actually within reach of.

3. **Asymmetric reach** (v0.1.22): threshold = `getMoverInterceptThreshold(mover, opponent)` = opponent's reach only. The mover's own reach is irrelevant for whether the opponent can intercept.

4. **Floor threshold** (configurable setting): `Math.max(reachThreshold, AUTO_DISENGAGE_DISTANCE)`. Defaults to 2yd. Prevents engagement from yo-yoing on tiny moves between tokens with very short reach.

5. **Swarm exemption** (v0.1.34, Core p.342): if the moving token's actor has the Swarm trait (`isSwarm()`), the gate returns early and allows the move without interception — a Swarm "can ignore the Engaged rules when using its Move." The check sits right after the engagement lookup in both handlers, so it only applies to a moving Swarm. It does NOT affect a non-Swarm moving away from a Swarm (that still triggers the dialog), nor does it change engagement/outnumbering — a Swarm still forms edges and counts for outnumbering; only its own movement is exempt.

When a dialog needs to fire, the gate calls `openMovementTriggerDialog` and returns `false` to cancel the move. If the user picks "Drop Advantage" or successfully Dodges, the dialog calls `replayMove(token, x, y)`, which re-issues the move with a `bypassEngagementCheck` flag in the operation object so the gate doesn't re-fire on the replay. `replayMove` routes through `TokenDocument#move()` when it exists (V13+, required on V14 where a raw `update` is reverted by the movement pipeline) and falls back to `update()` on V12 (v0.1.28).

### `renderTokenHUD` → `onRenderTokenHUD` (token-hud.js)

Adds Disengage and Flee buttons to the left column of the Token HUD. Only renders when the selected token has at least one engagement.

## The Disengage and Flee flows

`disengage-flee.js` is the longest file (~700 lines) and orchestrates the most complex behavior. Per RAW Core p.165:

- **Disengage:** Spend an Action. Choose Drop-Advantage (zero your Advantage to leave freely) or Opposed Dodge vs Melee per opponent. Full success = drop all edges + gain +1 Advantage. Partial or full failure = stay engaged with everyone, opponents who beat you each gain +1 Advantage.
- **Flee:** Move freely (Run-distance), but each currently-engaged opponent gets a free attack at +20 immediately, and you must pass a Challenging Cool test or become Broken (which IS the fleeing state per Core p.167 — there is no separate "Fleeing" condition).

### Three entry points

- **`openDisengageDialog(token)`** — the Token HUD button. Shows the choice between Drop-Advantage and Roll Dodge.
- **`openFleeDialog(token)`** — the Token HUD button. Confirmation, then `runFleeFreeAttacks`.
- **`openMovementTriggerDialog(token, leavingOpponents, stayingOpponents, moveTarget)`** — fired from `preUpdateToken` when a move would leave reach. Shows Drop-Advantage / Roll Dodge / Flee / Cancel, with "Drop Advantage" disabled if the player's Advantage is already at-or-below all opponents' (Core p.165 rule).

### The opponent-defense routing

When a Dodge-Disengage or Flee free-attack requires the **opponent** to roll something (Melee defense in Dodge, free attack in Flee), the dialogs (weapon picker + roll dialog) must appear on the **opponent's owner client**, not the flow-driving client. Otherwise the GM ends up rolling for the player's PCs, or vice versa.

This is implemented in `opponent-defense.js` using Foundry V13's `CONFIG.queries` system. The flow-driving client calls `requestOpponentDefense(opponentToken, { mode, contextLabel, appendTitle })`, which routes as follows:

1. If THIS client owns the opponent's actor (and isn't the GM) → run locally.
2. If an active human player owns the opponent → query that user via `User#query`.
3. If no human owner AND this client is the GM → run locally.
4. If no human owner AND this client is NOT the GM → query the active GM. **This case** is what was added in v0.1.22 to fix the bug where player-vs-orc Dodge opened the orc's roll dialog on the player's screen.
5. No active GM either → return `aborted: true`.

Five-minute query timeout to accommodate players who take real time picking weapons and clicking Roll.

The query handler runs `runOpponentTestLocally` on the receiving client, which opens the weapon picker and roll dialog, awaits the roll, and returns `{ aborted, baseSL, SL, outcome, damage, hitloc }` to the caller.

### Advantage mutations

`adjustAdvantage(token, delta)` and `setAdvantage(token, value)` in `disengage-flee.js` both route through `applyActorAdvantageDelta(token, delta)` from `engagement-tracker.js`. That helper:

- Writes locally if `token.actor.isOwner` is true (covers GM and player-PC cases).
- Otherwise emits a `setActorAdvantageDelta` socket message to the active GM.

This was the v0.1.23 fix for the "User X lacks permission to update ActorDelta" error that appeared when a player's Dodge-Disengage tried to bump a GM-owned opponent's Advantage. The same routing handles Flee's two Advantage bumps per opponent (immediate +1, and +1 more on hit).

### Partial Dodge success (v0.1.23 ruling)

Per the in-house ruling: partial success on Dodge-Disengage = the disengage attempt as a whole failed. The PC remains engaged with all opponents, including those they individually beat. Won edges are NOT dropped; only full success drops all edges and grants +1 Advantage.

The chat card shows the per-opponent outcomes for transparency but is explicit about the disengage failing as a whole.

## Persistent state summary

The module touches three persistent storage surfaces:

| Where | What | Cleared by |
|---|---|---|
| `scene.flags["wfrp4e-engaged-in-melee"].engagements` | Engagement graph | `deleteCombat`, round pruning, manual `tracker.clear()` |
| `chatMessage.flags["wfrp4e-engaged-in-melee"].outnumberingInfo` | Outnumbering breakdown for chat display | Message deletion |
| `chatMessage.flags["wfrp4e-engaged-in-melee"].suppressDamageDisplay` | Marker for Dodge-Disengage defense cards | Message deletion |

Plus the Engaged status effect on actors (not a flag, an ActiveEffect with id `"engaged"`), which is applied/removed via `toggleStatusEffect` and tracked alongside the engagement graph. The visual status is decoupled from the graph: changes to the graph trigger status updates, but the status effect itself is what players see on tokens.

## Socket layer summary

One socket namespace: `module.wfrp4e-engaged-in-melee` (declared via `"socket": true` in module.json, which was the v0.1.20 fix without which server-side broadcast does not work).

Actions handled by the GM-side listener (`registerEngagedStatusSocket`):

| Action | Effect |
|---|---|
| `setEngagedStatus` | Toggle Engaged ActiveEffect on a token |
| `engage` | Add an engagement edge to the graph |
| `disengage` | Remove an engagement edge or all edges of a token |
| `pruneStale` | Round-based stale-engagement pruning |
| `pruneStaleByTime` | Wall-clock stale-engagement pruning |
| `clear` | Clear the entire engagement graph |
| `setActorAdvantageDelta` | Apply a delta to an actor's Advantage (Core p.165 bumps) |

Plus the `CONFIG.queries`-based routing for opponent-side rolls (separate from the socket, uses Foundry V13's User#query mechanism). Query id: `wfrp4e-engaged-in-melee.opponentDefense`.

## Settings

Registered in `settings.js`. All five:

| Setting | Default | Scope | Purpose |
|---|---|---|---|
| `enableAutoTracking` | true | world | Master toggle: post-roll engagement establishment and movement-based auto-disengage. |
| `autoDisengageDistance` | 2 | world | Floor (in yards) for the auto-disengage threshold. Threshold = `max(weaponReach, this)`. |
| `skirmishStaleSeconds` | 60 | world | Wall-clock TTL for out-of-combat engagements. 0 disables time-based pruning. |
| `enableMovementTrigger` | true | world | Whether `preUpdateToken` opens the Disengage dialog on out-of-reach moves. |
| `debug` | false | client | Verbose console logging for diagnosis. |

The `debug` setting gates the more verbose console output in movement-hooks.js and elsewhere. Default-off so it doesn't spam ordinary play.

`settings.js` got per-setting developer-facing JSDoc in v0.1.24. The language file (`lang/en.json`) still drives the user-facing display names and hints; the JSDoc blocks describe the runtime effect of each toggle for someone reading the code.

## API surface

Exposed on `game.modules.get("wfrp4e-engaged-in-melee").api` at the `ready` hook:

```js
{
  EngagementTracker,                    // the class
  calculateOutnumbering,                // pure function
  getTokenEngagementReach,              // pure function
  getEngagementThreshold,               // symmetric MAX (auto-disengage)
  getMoverInterceptThreshold,           // asymmetric opponent-only (move-intercept)
  getCurrentTracker,                    // () => EngagementTracker.current()
}
```

Useful for macros, manual diagnostics, or other modules that want to query engagement state.

## Lessons preserved in the comments

Notable design rationales worth remembering, scattered throughout the codebase:

- **Outnumbering bonus must apply pre-roll** (not as post-roll SL adjustment) for Critical/Fumble determination to work correctly. A 66 against Skill 54 outnumbering 2:1 is a Critical at modified target 74, not a Fumble at 54. (roll-hooks.js)
- **Engagement is established by attacks, not distance.** Two tokens standing adjacent are not Engaged until one swings. (Tracked everywhere, codified in roll-hooks.js's post-roll handler.)
- **MAX-reach engagement persists, but asymmetric reach intercepts.** Two different thresholds for two different questions. (reach.js)
- **Player clients can't write to scene flags or GM-owned actors.** All writes route through the active GM via socket. (engagement-tracker.js socket layer; v0.1.18 work.)
- **`"socket": true` in manifest is required for server-side broadcast.** Without it, `game.socket.emit` is silently dropped between clients. (v0.1.20 fix; documented inline.)
- **`setFlag` uses MERGE semantics.** Deletions don't propagate via simple updates. Pattern: `unsetFlag` then `setFlag`. (engagement-tracker.js readGraph/writeGraph.)
- **Synthetic tokens have actor deltas with their own ids.** Don't key off `actor.id` for cross-client coordination; use `token.id` which is canonical. (v0.1.23 fix for damage suppression keying.)
- **WFRP4e has no `preRoll` hooks.** Pre-roll injection happens via `renderWeaponDialog`/`renderTraitDialog`; post-roll consequences via `wfrp4e:rollWeaponTest`/`wfrp4e:rollTraitTest`. (main.js comment.)
- **There is no "Fleeing" condition.** Broken IS the fleeing state per Core p.167. (v0.1.14 fix.)
- **Cool is a skill, not a characteristic.** `setupSkill("Cool")` not `setupCharacteristic("cl")`. (v0.1.13 fix.)
- **DOM-direct tooltip patching beats participating in `dialog.tooltips`.** The system's tooltip object model reuses state across dialog instances in unpredictable ways; writing data-tooltip attributes directly is more robust. (v0.1.23 fix.)
- **WFRP4e item shapes vary across versions and custom content.** The `isWeaponMelee` helper in `reach.js` handles `attackType.value`, `attackType`, missing `attackType`, and `weaponGroup` as a fallback. Reuse it everywhere "is this a melee weapon" matters; don't reimplement the detection in each caller. (v0.1.25 refactor.)

## Version progression (high level)

- **v0.1.0 – 0.1.7:** Core engagement tracker, outnumbering math, weapon/trait support, mount allyship.
- **v0.1.8:** Cross-melee scoping experiment — reverted.
- **v0.1.9 – 0.1.11:** Outnumbering tooltip on Modifier field.
- **v0.1.12 – 0.1.14:** Disengage and Flee flows. Discovered Cool is a skill; Broken is the fleeing state.
- **v0.1.15:** Engaged status effect integration. Movement-trigger dialog.
- **v0.1.16 – 0.1.17:** Charging toggle rebaseline fix. Socket-route Engaged status for player attacks on GM-owned actors.
- **v0.1.18:** Full GM-authoritative socket pattern for engagement-tracker writes.
- **v0.1.19:** Diagnostic logging in socket paths.
- **v0.1.20:** Added `"socket": true` to manifest — fixes everything because nothing was being broadcast before.
- **v0.1.21:** CONFIG.queries routing for opponent-side roll dialogs. Duplicate Engaged status race fixed. Spurious movement-trigger dialogs during attack resolution fixed.
- **v0.1.22:** Failed Dodge blocks movement. Damage-line suppression on Dodge defense cards. Outnumbering tooltip always-show fallback. Asymmetric mover-intercept reach. Player-vs-GM-owned-opponent rolls route to GM.
- **v0.1.23:** Crossing-threshold model for move-intercept. Advantage writes routed through GM socket. Partial Dodge success keeps all edges. DOM-direct tooltip patching.
- **v0.1.24:** Documentation polish. Fixed stale header comment in `constants.js`. Added per-setting JSDoc to `settings.js`. Added top-of-file architecture summary to `main.js`. Refreshed README's Design notes section. No behavior changes.
- **v0.1.25:** Defensive hardening from automated code review. Tooltip helper now strips its prior contribution even when current bonus is 0 (prevents stale tooltip when user retargets mid-dialog). `preUpdateToken` proactively prunes stale engagement edges when an opponent token is missing from canvas instead of leaving them for next pruning cycle. `isWeaponMelee` extracted from `reach.js` as a shared helper used by both reach calculation and opponent-defense weapon picker; gives the picker the same weaponGroup fallback for items with missing `attackType`. No observable behavior changes in normal play.
- **v0.1.26:** Exclude `dead` and `defeated` from outnumbering counts (was only excluding `unconscious`). Movement hooks now also proactively drop edges to incapacitated opponents so the surviving fighter's Engaged status clears at the next move and no spurious Disengage dialogs fire near corpses. Discovered during real Saturday session: a dead orc was still counting for outnumbering math.
- **v0.1.27:** New `createActiveEffect` hook in `combat-hooks.js` drops all engagement edges instantly when a token's status changes to dead/unconscious/defeated. The Engaged icon now clears at the moment of death rather than waiting for the next move. The reverse transition (healing out of incapacitation) does NOT re-form engagement \u2014 engagement is established by attacks, per Core p.159.
- **v0.1.28:** V14 compatibility for the movement-trigger gate. On V14 a raw `token.document.update({x, y})` is superseded by the new movement pipeline and can be silently reverted (the document reports the new x/y but snaps back), so the interception point moves from `preUpdateToken` to the movement layer's own `preMoveToken` hook — new `onPreMoveToken` in `movement-hooks.js` — and the disengage replay (`replayMove` in `disengage-flee.js`) now goes through `TokenDocument#move()` instead of `update()`. `main.js` feature-detects `TokenDocument#move` and registers exactly one gate — `preMoveToken` on V13+, `preUpdateToken` as the V12 fallback — so there is no double-dialog. The gating logic itself is unchanged: same engagement lookup, asymmetric mover-intercept reach (v0.1.22), and crossing-threshold model (v0.1.23); only the hook it runs on and the replay call changed. The `bypassEngagementCheck` flag rides the move operation object and round-trips back into `preMoveToken`, so the replay self-bypasses without re-prompting. `compatibility.verified` stays at 13.351 pending the V14 smoke test.
- **v0.1.29:** Verified on Foundry V14 — `compatibility.verified` bumped from 13.351 to 14 after the V14 movement-gate smoke test passed (drag-out-of-reach dialog, Drop Advantage / Dodge / Flee replays landing at destination, Cancel / failed-Dodge holding position). Documentation consistency pass: the `getMoverInterceptThreshold` reach-resolver note and the movement-trigger gate section now describe the V13+ `preMoveToken` path with `preUpdateToken` as the V12 fallback, and the no-op move filter is marked as `preUpdateToken`-path-only (unnecessary under `preMoveToken`, which fires only on real movement). No code changes beyond the manifest version/verified bump.
- **v0.1.30:** Combat Master talent (Core p.134-135) now affects the outnumbering calculation. When a side is outnumbered, each level of Combat Master on that side's combatants adds one to its count. Literal reading (table ruling): can flip the ratio to grant the bonus to the Combat-Master side; only the outnumbered side benefits. Reads `talent.system.advances.value`. Tooltip and chat-card breakdown gained a "+N from Combat Master" transparency note. Smoke-tested across 9 scenarios (negate, flip, even-fight-no-op, larger-side-no-op). NOTE: this release never installed cleanly due to a stale `download` URL in the manifest (see v0.1.31).
- **v0.1.31:** Manifest URL fix. The `download` field was hardcoded to `releases/download/v0.1.29/module.zip`, so every install \u2014 regardless of version \u2014 fetched and extracted the v0.1.29 zip, silently reverting to 0.1.29. Both `manifest` and `download` now use the version-independent `releases/latest/download/...` form, which auto-resolves to the newest release and prevents this class of bug recurring. Carries forward the v0.1.30 Combat Master code (which had not successfully installed anywhere).
- **v0.1.32:** Fix the outnumbering chat-card breakdown panel not appearing on V14. Root cause was an async render race: the old `createChatMessage` hook wrote the breakdown flag via `await setFlag()` AFTER message creation, which fires a second render \u2014 but the first `renderChatMessageHTML` already ran without the flag (no panel), and the later flag-triggered re-render appended to a replaced/detached node. Fixed by moving the flag-write to `preCreateChatMessage`, which mutates the pending document's source synchronously via `updateSource` BEFORE creation, so the flag is present on the very first render. Both the outnumbering breakdown and the Dodge-Disengage damage-suppression flags moved to this pre-create path. Diagnosed via live console probe (stash key matched \u2014 `pending has this actor key? true` \u2014 but `outnumberingInfo flag after create: not set` on first render, then `SET` on a later render, confirming the timing race rather than a key mismatch).
- **v0.1.33:** Fix the outnumbering panel appearing only INTERMITTENTLY (worked when the player rolled quickly, missing when they deliberated). Root cause: the breakdown was stashed during dialog RENDER with a 5-second TTL, but a player choosing difficulty / Charging / reading the tooltip could easily exceed 5s before committing the roll \u2014 by which time `preCreateChatMessage` found the stash entry already purged. Fixed by moving the stash from dialog-render to `onRollMeleeTest` (the post-roll `wfrp4e:rollWeaponTest`/`rollTraitTest` hook, which fires immediately before message creation), shrinking the stash\u2192message gap from "however long the player deliberates" to milliseconds. The breakdown is recomputed there via `calculateOutnumbering` against the pre-attack graph so it matches the dialog tooltip. TTL relaxed from 5s to 30s as a generous cancel-leak guard, though timing is no longer the failure mode. Confirmed hook order (`wfrp4e:rollWeaponTest` fires before `preCreateChatMessage`) via the `engage:` log preceding `PRECREATE fired` in probe output.

- **v0.1.34:** Swarm creature trait (Core p.342), movement clause only. A Swarm "can ignore the Engaged rules when using its Move" — so a token whose actor has the Swarm trait never triggers the movement-based Disengage dialog and moves freely out of engagement. Implemented as an early-out in both movement handlers (`onPreMoveToken` on V13+/V14, `onPreUpdateToken` on V12), placed after the engagement check so non-engaged tokens are unaffected. Detection: `isSwarm()` scans `actor.items` for a `type: "trait"` item whose name is/starts with "Swarm" (handles the "Swarm (Rats)" specification form and the common duplicate-trait bestiary shape; guards against `Swarmlike` false-positives and trait-vs-talent confusion). Deliberately scoped: a Swarm STILL forms engagement edges and STILL counts for outnumbering (only its own movement is exempt), and a NON-Swarm moving away from a Swarm still triggers the normal Disengage dialog (the trait frees the Swarm's movement, not its opponents'). Damage aspects of the trait (Deathblow, end-of-round Wound loss, +40 to be shot) are out of scope for this module.
## Known cleanup candidates

Remaining for a future polish version:

- **v0.1.19 diagnostic logs in engagement-tracker.js** (the `SOCKET RECEIVED`/`SOCKET handling`/etc. lines) can be gated behind the debug setting or stripped now that the socket layer is stable. Left in v0.1.24 because they're harmless and useful if socket issues recur during real play.
