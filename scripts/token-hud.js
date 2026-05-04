import { MODULE_ID } from "./constants.js";
import { EngagementTracker } from "./engagement-tracker.js";

/**
 * Token HUD: Disengage button.
 *
 * Adds a button to the left column of the Token HUD. When clicked, removes
 * ALL engagement edges touching this token. Useful for the "Use Advantage to
 * Disengage" case (Core p.165) and for cleaning up when the GM has manually
 * moved tokens around.
 *
 * Hook: renderTokenHUD. Fires every time the HUD is rendered (i.e. every time
 * a token is selected).
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

    const button = document.createElement("div");
    button.classList.add("control-icon", `${MODULE_ID}-disengage`);
    button.dataset.action = "disengage";
    button.title = game.i18n.localize(`${MODULE_ID}.hud.disengageTooltip`);
    button.innerHTML = `<i class="fas fa-running"></i>`;

    button.addEventListener("click", async (event) => {
      event.preventDefault();
      const t = EngagementTracker.current();
      if (!t) return;
      await t.disengage(tokenId);
      ui.notifications.info(
        game.i18n.format(`${MODULE_ID}.hud.disengageMessage`, {
          name: data.name ?? canvas.tokens?.get(tokenId)?.name ?? "Token",
        })
      );
      // Re-render the HUD so the button disappears (no engagements left).
      hud.render();
    });

    // Inject into the left column. V13 token HUD has .col.left and .col.right.
    const leftColumn = root.querySelector(".col.left");
    if (leftColumn) {
      leftColumn.appendChild(button);
    } else {
      // Fallback: append to the HUD root.
      root.appendChild(button);
    }
  } catch (err) {
    console.error(`${MODULE_ID} | renderTokenHUD hook error:`, err);
  }
}
