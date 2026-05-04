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

- Attack a goblin while another PC is also engaged with it → your melee test silently gains +20.
- A chat-card panel below the test shows the breakdown: who's on each side and what the ratio was.
- Move a polearm-wielder away from their target → engagement holds out to their reach. Move further → engagement breaks automatically.
- A "Disengage" button (red running figure) appears on the Token HUD whenever a token has active engagements.

## Installation

In Foundry → **Add-on Modules** → **Install Module**, paste this manifest URL:

```
https://raw.githubusercontent.com/TheWingedLancer/WFRP4e-Engaged-In-Melee/main/module.json
```

Then enable it in your world's module list.

## Settings

- **Auto-disengage on movement** (default on) — drop engagements when a token moves out of reach.
- **Minimum auto-disengage distance** (default 2 yards) — floor for the auto-disengage threshold; the actual threshold is `max(this, max-of-both-weapons-reach)`.
- **Debug logging** (default off) — log engagement state changes to the console.

## API

The module exposes a small API on the module's data, useful for macros:

```js
const api = game.modules.get("wfrp4e-engaged-in-melee").api;

// Get the active tracker for the current combat
const tracker = api.getCurrentTracker();

// Who is the selected token engaged with?
const engaged = tracker?.getEngagementsFor(token.id);

// What's the engagement reach of a token's currently equipped weapons?
const reach = api.getTokenEngagementReach(token);
```

## Design notes

The module is built around three small, separable services:

- `EngagementTracker` — manages the engagement graph, stored as a flag on the active Combat document so it persists across reloads and syncs to all clients.
- `Outnumbering` calculator — given attacker, defender, and a tracker, returns the to-hit bonus and the breakdown.
- `Reach` resolver — extracts engagement reach from a token's equipped melee weapons.

Hook integration:

- `wfrp4e:preRollTest` — injects the Outnumbering modifier before the roll.
- `wfrp4e:rollTest` — marks attacker and defender as Engaged.
- `combatRound` — prunes stale engagements at the start of each new round.
- `updateToken` — auto-disengages on out-of-reach movement.
- `renderTokenHUD` — adds the manual Disengage button.

## License

MIT. See LICENSE.

## Credits

Built by [TheWingedLancer](https://github.com/TheWingedLancer). Warhammer Fantasy Roleplay © Games Workshop. WFRP4e is published by Cubicle 7.
