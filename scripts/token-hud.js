import { MODULE_ID } from "./constants.js";
import { EngagementTracker } from "./engagement-tracker.js";
import { openDisengageDialog, openFleeDialog } from "./disengage-flee.js";

/**
 * Token HUD: Disengage and Flee buttons.
 *
 * Adds two buttons to the left column of the Token HUD:
 *   - Disengage: opens a dialog letting the player choose Drop-Advantage or
 *     Roll Dodge (Core p.165). Module applies consequences (edge drops,
 *     Advantage adjustments) based on rolled outcomes.
 *   - Flee: confirmation dialog, then automated free-attack flow per opponent
 *     (+1 Adv, +20 Melee test, on hit: damage + Cool test + potential Broken),
 *     finally Fleeing condition + drop edges (Core p.165).
 *
 * Buttons only appear when the selected token has at least one engagement.
 *
 * Hook: renderTokenHUD. Fires every time the HUD is rendered.
 */
export function onRenderTokenHUD(hud, html, data) {
  try {
    const tracker = EngagementTracker.current();
    if (!tracker) return;

    const tokenId = data._id ?? data.id;
    const engagements = tracker.getEngagementsFor(tokenId);
    if (engagements.length === 0) return;

    const root = html instanceof HTMLElement ? html : html[0];
    if (!root) return;

    // Don't double-add if Foundry re-renders.
    if (root.querySelector(`.${MODULE_ID}-disengage`)) return;

    const leftColumn = root.querySelector(".col.left");
    const target = leftColumn ?? root;

    // === Disengage button ===
    const disengageBtn = document.createElement("div");
    disengageBtn.classList.add("control-icon", `${MODULE_ID}-disengage`);
    disengageBtn.dataset.action = "disengage";
    disengageBtn.title = game.i18n.localize(`${MODULE_ID}.hud.disengageTooltip`);
    disengageBtn.innerHTML = `<i class="fas fa-shield-halved"></i>`;
    disengageBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      const token = canvas.tokens?.get(tokenId);
      if (!token) {
        ui.notifications.warn("Token not found.");
        return;
      }
      await openDisengageDialog(token);
      hud.render(); // re-render so button visibility reflects new state
    });
    target.appendChild(disengageBtn);

    // === Flee button ===
    const fleeBtn = document.createElement("div");
    fleeBtn.classList.add("control-icon", `${MODULE_ID}-flee`);
    fleeBtn.dataset.action = "flee";
    fleeBtn.title = game.i18n.localize(`${MODULE_ID}.hud.fleeTooltip`);
    fleeBtn.innerHTML = `<i class="fas fa-running"></i>`;
    fleeBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      const token = canvas.tokens?.get(tokenId);
      if (!token) {
        ui.notifications.warn("Token not found.");
        return;
      }
      await openFleeDialog(token);
      hud.render();
    });
    target.appendChild(fleeBtn);
  } catch (err) {
    console.error(`${MODULE_ID} | renderTokenHUD hook error:`, err);
  }
}
