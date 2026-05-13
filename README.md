# WFRP4e Engaged In Melee

A FoundryVTT module for the **Warhammer Fantasy Roleplay 4th Edition** system that tracks melee Engagement and automatically applies the Outnumbering to-hit bonus.

- **Foundry compatibility:** V13 (verified on 13.351)
- **System compatibility:** wfrp4e 9.x (verified on 9.4.0)

## What it does

WFRP4e's Outnumbering rule (Core p.161) gives a +20 to-hit at 2-to-1 and +40 at 3-to-1 in melee. Determining "to-1" requires knowing who is **Engaged** with whom — a state established by attack actions, not by distance (Core p.159). This module tracks that state automatically and injects the correct bonus into your melee tests.

### Rules implemented

- **Engagement state** (Core p.159): Two tokens become Engaged when one attacks the other in melee. The state persists until a full Round passes with no attacks between them.
- **Outnumbering bonus** (Core p.161): +20 at 2:1, +40 at 3:1, applied automatically to the melee test before the dice roll. Allies who are Unconscious or Fleeing don't count.
- **Disengagement** (Core p.165): Manual via a Token HUD button, plus auto-disengage when a token moves further than the longer of the two combatants' equipped weapon reaches (Core p.297 — Very Long = 4 yards, Massive = 6 yards, all others = 2 yards).

### What you'll see at the table

- Attack a goblin while another PC is also engaged with it → your melee test silently gains +2 SL (equivalent to +20 to-hit).
- A chat-card panel below the test shows the breakdown: who's on each side, the ratio, and the SL adjustment.
- Move a polearm-wielder away from their target → engagement holds out to their reach. Move further → engagement breaks automatically.
- A "Disengage" button (red running figure) appears on the Token HUD whenever a token has active engagements.

### Creature trait attacks

Mounts, monsters, and animals attack via **Traits** (Hooves, Bite, Claws, etc.) rather than weapons. The module hooks both weapon and trait dialogs, so a war-trained mount attacking with its Hooves will:

- Have the Outnumbering bonus applied to its trait test if its rider's allies are engaged with the target
- Establish its own engagement edge with the target after attacking

Trait attacks must declare `attackType: "melee"` in the trait's data (the system default for combat traits like Hooves and Bite). Ranged traits like Breath weapons or Spittle are correctly excluded.

### How the bonus is applied (technical detail)

When the player opens an attack dialog targeting an engaged enemy, the module hooks the dialog's render cycle and adds the appropriate +20 or +40 to the dialog's `modifier` field — exactly as if the player had typed it in themselves, or as the system itself does for Charging and weapon Quality bonuses. The user sees the modifier in the dialog before they roll. When they submit, WFRP4e rolls against the modified target, and the system's own logic handles Critical/Fumble correctly.

This means: **a roll of 66 against a Skill 54 attacker outnumbering 2:1 is correctly resolved as a Critical Hit** (66 ≤ 74 modified target, 6/6 doubles), not a Fumble.

### Important: Disposition matters

Allies are determined by **token disposition** (FRIENDLY / NEUTRAL / HOSTILE) plus mount relationships.

- Two tokens with the **same disposition** are allies.
- A **mount** is allied with its rider, and with all of the rider's allies. So a NEUTRAL warhorse ridden by a FRIENDLY PC counts as an ally to all FRIENDLY PCs in the fight.
- Mount relationships are detected via WFRP4e's native mount tracking (`actor.system.status.mount`) AND the **Rideable** module's flags. Either system alone is sufficient; both together work fine.

NPC followers and animal companions that aren't formal mounts default to NEUTRAL disposition. If you want them to count as allies to your FRIENDLY PCs, change their token disposition to FRIENDLY in the Token Configuration.

### Combat Tracker is optional

The module works whether or not a Combat Tracker is running:

- **In a formal Combat:** engagements are pruned at the start of each new round per Core p.159.
- **In a skirmish (no Combat):** engagements are pruned by wall-clock time after the configurable TTL (default 60 seconds).

## Installation

In Foundry → **Add-on Modules** → **Install Module**, paste this manifest URL:

```
https://raw.githubusercontent.com/TheWingedLancer/WFRP4e-Engaged-In-Melee/main/module.json
```

Then enable it in your world's module list.

## Settings

- **Auto-disengage on movement** (default on) — drop engagements when a token moves out of reach.
- **Minimum auto-disengage distance** (default 2 yards) — floor for the auto-disengage threshold.
- **Skirmish engagement TTL** (default 60 seconds) — how long out-of-combat engagements persist without further attacks. Set to 0 to disable wall-clock pruning.
- **Debug logging** (default off) — log engagement state changes and bonus calculations to the console.

## API

The module exposes a small API on the module's data, useful for macros:

```js
const api = game.modules.get("wfrp4e-engaged-in-melee").api;

// Get the active tracker for the current scene
const tracker = api.getCurrentTracker();

// Who is the selected token engaged with?
const engaged = tracker?.getEngagementsFor(token.id);

// What's the engagement reach of a token's currently equipped weapons?
const reach = api.getTokenEngagementReach(token);

// Symmetric MAX reach (used internally for auto-disengage decisions)
const engThreshold = api.getEngagementThreshold(tokenA, tokenB);

// Asymmetric reach: returns just the opponent's reach (used internally
// for the movement-trigger dialog). A long-weapon attacker stepping back
// from a short-weapon opponent: the opponent's reach is what matters.
const moveThreshold = api.getMoverInterceptThreshold(mover, opponent);

// Compute the outnumbering breakdown for a hypothetical attack
const result = api.calculateOutnumbering(attacker, defender, tracker);
// { bonus: 0|20|40, ratio: "2:1", attackerSideCount, defenderSideCount, ... }
```

## Design notes

The module is built around three small, separable services:

- `EngagementTracker` — manages the engagement graph, stored as a flag on the active **Scene** document so it persists across reloads, syncs to all clients, and works whether or not a Combat is running. Player clients can't write scene flags directly; all writes route through the active GM via a socket layer so the state stays consistent across the table.
- `Outnumbering` calculator — given attacker, defender, and a tracker, returns the to-hit bonus and the breakdown. Allyship is determined by token disposition plus mount transitive rules.
- `Reach` resolver — extracts engagement reach from a token's equipped melee weapons. Two threshold functions: a symmetric `getEngagementThreshold(a, b) = MAX(reachA, reachB)` used for the post-move auto-disengage check, and an asymmetric `getMoverInterceptThreshold(mover, opponent) = reach(opponent)` used for the movement-trigger dialog (a dagger-wielder cannot stop a pike-wielder from stepping back).

Foundry hook integration:

- `renderWeaponDialog` / `renderTraitDialog` — inject the Outnumbering bonus into the dialog's `modifier` field before the user rolls, so the bonus correctly affects Critical/Fumble determination per RAW.
- `wfrp4e:rollWeaponTest` / `wfrp4e:rollTraitTest` — record the engagement edge after the roll resolves.
- `createChatMessage` / `renderChatMessageHTML` — attach and render the outnumbering breakdown panel; suppress the damage row on Dodge-Disengage opposed defense cards (no damage is awarded per Core p.165).
- `combatRound` — prune stale engagements at the start of each new round.
- `deleteCombat`, `deleteToken` — cleanup hooks.
- `updateToken` — auto-disengage on out-of-reach movement.
- `preUpdateToken` — intercept moves that would leave engagement reach and open the Disengage/Flee decision dialog.
- `renderTokenHUD` — add the Disengage and Flee buttons to the Token HUD.

Cross-client coordination:

- **Socket layer** (namespace: `module.wfrp4e-engaged-in-melee`, requires `"socket": true` in manifest) — handles GM-authoritative writes to the engagement graph, Engaged status effect toggles, and Advantage mutations on actors the current client doesn't own.
- **CONFIG.queries** (id: `wfrp4e-engaged-in-melee.opponentDefense`) — routes opponent-side weapon picker and roll dialogs to the opponent's owner client during Dodge-Disengage and Flee. Five-minute timeout so players aren't pressured.

For the full architectural picture, see `ARCHITECTURE.md` at the repo root.

## License

MIT. See LICENSE.

## Releasing (for maintainers)

This repo includes a GitHub Actions workflow at `.github/workflows/release.yml` that handles the release-build flow. To cut a new release:

1. Bump the `version` field in `module.json` (e.g. `0.1.3` → `0.1.4`).
2. Commit and push to `main`.
3. Tag the commit: `git tag v0.1.4 && git push --tags`.
4. The workflow runs automatically: it verifies the tag matches the version, builds `module.zip` with `module.json` at the root, and creates a GitHub Release with both files attached.

Foundry's update mechanism will then pick it up via the `manifest` URL pointing at `main/module.json`.

## Credits

Built by [TheWingedLancer](https://github.com/TheWingedLancer). Warhammer Fantasy Roleplay © Games Workshop. WFRP4e is published by Cubicle 7.
