import {
  compareStableSemver,
  parseStableSemver,
  type UpdateViewState,
} from "../core/companion/update";

const MSG = {
  state: "COMPANION_UPDATE_GET_STATE",
  check: "COMPANION_UPDATE_CHECK",
} as const;

async function request(type: string): Promise<UpdateViewState> {
  const response = await chrome.runtime.sendMessage({ type });
  if (!response?.success) throw new Error("Could not check for updates.");
  return response.data as UpdateViewState;
}

function formatCheckTime(value?: number): string {
  return value ? new Date(value).toLocaleString() : "Not checked yet";
}

export function mountCompanionUpdateSettings(): void {
  const about = document.getElementById("view-about");
  if (!about || document.getElementById("media-sniper-update-settings")) return;
  const section = document.createElement("section");
  section.id = "media-sniper-update-settings";
  section.className = "section";
  const heading = document.createElement("h2");
  heading.className = "section-title";
  heading.textContent = "Updates";
  const status = document.createElement("div");
  status.className = "form-help";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn btn-secondary";
  button.textContent = "Check for updates";
  const render = (state: UpdateViewState) => {
    const newerRelease = Boolean(
      state.latestVersion && parseStableSemver(state.latestVersion) &&
      compareStableSemver(state.latestVersion, state.currentVersion) > 0,
    );
    status.textContent = !state.lastSuccessfulCheckAt
      ? "Media Sniper has not checked for updates yet."
      : newerRelease
      ? `Release ${state.latestVersion} is available. Open the Media Sniper popup to install it. Last checked ${formatCheckTime(state.lastSuccessfulCheckAt)}.`
      : `Media Sniper is up to date. Last checked ${formatCheckTime(state.lastSuccessfulCheckAt)}.`;
  };
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Checking…";
    try { render(await request(MSG.check)); }
    catch { status.textContent = "Could not check right now. Media Sniper will try again later."; }
    finally { button.disabled = false; button.textContent = "Check for updates"; }
  });
  section.append(heading, status, button);
  about.append(section);
  void request(MSG.state).then(render).catch(() => {
    status.textContent = "Update status is temporarily unavailable.";
  });
}
