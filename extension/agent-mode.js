import { getBufferId, getEntriesAfter } from "./buffer.js";
import { runCommand } from "./commands.js";
import { ConnectionStatus, createDaemonConnection } from "./connection.js";
import { CheckInPeriodSeconds, createExtensionLink } from "./link.js";

const AlarmName = "stdout-sync";
	// alarms wake the service worker to check in, such as after a new agent session
	// starts the daemon
const AlarmPeriodMinutes = CheckInPeriodSeconds / 60;

const BadgeColors = {
	[ConnectionStatus.Off]: "#888",
	[ConnectionStatus.Looking]: "#888",
	[ConnectionStatus.Connected]: "#2e7d32",
};
const Titles = {
	[ConnectionStatus.Off]: "stdout: click to let coding agents read the logs",
	[ConnectionStatus.Looking]: "stdout: waiting for the stdout-mcp server (click to stop)",
	[ConnectionStatus.Connected]: "stdout: agents can read the logs (click to stop)",
};

async function isAgentMode()
{
	const { agentMode = false } = await chrome.storage.local.get("agentMode");

	return agentMode;
}

async function updateBadge(
	status)
{
	await Promise.all([
		chrome.action.setBadgeText({ text: status === ConnectionStatus.Off ? "" : "MCP" }),
		chrome.action.setBadgeBackgroundColor({ color: BadgeColors[status] }),
			// Chrome picks black text for the gray background, which is hard to read
		chrome.action.setBadgeTextColor({ color: "#fff" }),
		chrome.action.setTitle({ title: Titles[status] }),
	]);
}

const connection = createDaemonConnection({
	link: createExtensionLink(),
	getBufferId,
	getEntriesAfter,
	isAgentMode,
	runCommand,
	onStatus: updateBadge,
});

export const handleEntryAdded = connection.entryAdded;

/**
 * Turn agent mode on or off.  When it's on, logs are sent to the local MCP server
 * so coding agents can read them.  They're stored in the extension either way.
 * The change is applied by handleStorageChange().
 */
export async function toggleAgentMode()
{
	await chrome.storage.local.set({ agentMode: !(await isAgentMode()) });
}

export async function handleStorageChange(
	changes,
	areaName)
{
	if (areaName !== "local" || !changes.agentMode) {
		return;
	}

	if (changes.agentMode.newValue) {
		await chrome.alarms.create(AlarmName, { periodInMinutes: AlarmPeriodMinutes });
		await connection.start();
	} else {
		await chrome.alarms.clear(AlarmName);
		await connection.stop();
	}
}

/**
 * Restore the alarm and badge after the browser restarts, since neither is
 * guaranteed to persist.
 */
export async function restoreAgentMode()
{
	if (await isAgentMode()) {
			// this replaces any existing alarm, which may have an older period
		await chrome.alarms.create(AlarmName, { periodInMinutes: AlarmPeriodMinutes });
		await connection.start();
	} else {
		await updateBadge(ConnectionStatus.Off);
	}
}

export function handleAlarm(
	alarm)
{
	if (alarm.name === AlarmName) {
		connection.checkIn();
	}
}
