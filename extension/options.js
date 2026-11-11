import { BrowserNameKey, getDefaultBrowserName } from "./browser-name.js";

	// saves after a pause in typing, rather than on every key
const SaveDelay = 300;

const input = /** @type {HTMLInputElement} */ (document.getElementById("browser-name"));
let saveTimer = null;

function save()
{
	clearTimeout(saveTimer);
	saveTimer = null;
	chrome.storage.local.set({ [BrowserNameKey]: input.value.trim() });
}

input.placeholder = getDefaultBrowserName();
input.value = (await chrome.storage.local.get(BrowserNameKey))[BrowserNameKey] ?? "";
input.addEventListener("input", () => {
	clearTimeout(saveTimer);
	saveTimer = setTimeout(save, SaveDelay);
});
input.addEventListener("change", save);
	// the options dialog can be closed while a save is waiting
addEventListener("pagehide", () => saveTimer && save());
