import { handleAlarm, handleEntryAdded, handleStorageChange, restoreAgentMode, toggleAgentMode } from "./agent-mode.js";
import { addEntry } from "./buffer.js";
import { createTapReceiver } from "./tap-receiver.js";

const handleTapMessage = createTapReceiver({
	storeEntry: (entry) => addEntry(entry).then(handleEntryAdded),
});

chrome.runtime.onMessageExternal.addListener(handleTapMessage);
chrome.action.onClicked.addListener(toggleAgentMode);
chrome.storage.onChanged.addListener(handleStorageChange);
chrome.alarms.onAlarm.addListener(handleAlarm);
chrome.runtime.onStartup.addListener(restoreAgentMode);
chrome.runtime.onInstalled.addListener(restoreAgentMode);
