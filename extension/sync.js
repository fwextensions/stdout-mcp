import { getBufferId, getEntriesAfter } from "./buffer.js";
import { runCommand } from "./commands.js";
import { CheckInPeriodSeconds, createExtensionLink } from "./link.js";

const AlarmName = "stdout-sync";
	// alarms wake the service worker to send any logs the daemon doesn't have yet,
	// such as after a new agent session starts it
const AlarmPeriodMinutes = CheckInPeriodSeconds / 60;
	// right after agent mode is turned on or Chrome starts, an agent session is
	// likely to start soon, so check for the daemon more often than the alarm
const FastRetryDelay = 5 * 1000;
const FastRetryDuration = 3 * 60 * 1000;
const FlushDelay = 250;
	// after a failed request, leave retries to the alarm instead of trying again
	// on every new log message
const RetryDelay = 30 * 1000;

const BadgeColors = {
	connected: "#2e7d32",
	waiting: "#888",
};

const link = createExtensionLink();

	// null if we haven't asked the daemon yet since the service worker started
let syncPosition = null;
let flushTimer = null;
let flushing = null;
let flushAgain = false;
let lastFailure = 0;
let polling = false;
let retrying = false;

export async function isAgentMode()
{
	const { agentMode = false } = await chrome.storage.local.get("agentMode");

	return agentMode;
}

async function updateBadge(
	agentMode,
	status = "waiting")
{
	await Promise.all([
		chrome.action.setBadgeText({ text: agentMode ? "MCP" : "" }),
		chrome.action.setBadgeBackgroundColor({ color: BadgeColors[status] }),
			// Chrome picks black text for the gray background, which is hard to read
		chrome.action.setBadgeTextColor({ color: "#fff" }),
		chrome.action.setTitle({
			title: !agentMode
				? "stdout: click to let coding agents read the logs"
				: status === "connected"
					? "stdout: agents can read the logs (click to stop)"
					: "stdout: waiting for the stdout-mcp server (click to stop)"
		}),
	]);
}

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
		await updateBadge(true);
		lastFailure = 0;
		retryUntilConnected();
	} else {
		await chrome.alarms.clear(AlarmName);
		await updateBadge(false);
		syncPosition = null;
	}
}

/**
 * Restore the alarm and badge after the browser restarts, since neither is
 * guaranteed to persist.
 */
export async function restoreAgentMode()
{
	const agentMode = await isAgentMode();

	if (agentMode) {
			// this replaces any existing alarm, which may have an older period
		await chrome.alarms.create(AlarmName, { periodInMinutes: AlarmPeriodMinutes });
	}

	await updateBadge(agentMode);

	if (agentMode) {
		retryUntilConnected();
	}
}

export function handleAlarm(
	alarm)
{
	if (alarm.name === AlarmName) {
		lastFailure = 0;
		flush();
	}
}

/**
 * Send new entries to the server shortly, batching up bursts of log calls.
 */
export function scheduleFlush()
{
	if (!flushTimer && Date.now() - lastFailure > RetryDelay) {
		flushTimer = setTimeout(() => {
			flushTimer = null;
			flush();
		}, FlushDelay);
	}
}

export function flush()
{
	if (flushing) {
		flushAgain = true;
	} else {
		flushing = sendEntries()
			.finally(() => {
				flushing = null;

				if (flushAgain) {
					flushAgain = false;
					flush();
				}
			});
	}

	return flushing;
}

async function sendCommandResult(
	command)
{
	const outcome = await isAgentMode()
		? await runCommand(command)
		: { error: "Agent mode was turned off in the stdout extension." };

	await link.sendCommandResult(command.id, outcome);
}

/**
 * Ask the daemon for commands for as long as it's running.  Checking the storage
 * API between requests keeps the service worker awake.  If the daemon goes away,
 * the next successful sync starts this again.
 */
async function pollCommands()
{
	if (polling) {
		return;
	}

	polling = true;

	try {
		while (await isAgentMode()) {
			const commands = await link.pollCommands();

			await Promise.all(commands.map(sendCommandResult));
		}
	} catch {
			// the alarm will start polling again once the daemon is back
	} finally {
		polling = false;
	}
}

/**
 * Check for the daemon every few seconds for a little while, until it's found.
 * Each check calls the storage API, which keeps the service worker awake
 * between them.
 */
async function retryUntilConnected()
{
	if (retrying) {
		return;
	}

	retrying = true;

	const deadline = Date.now() + FastRetryDuration;

	try {
		while (Date.now() < deadline && await isAgentMode()) {
			await flush();

				// a failed sync clears this
			if (syncPosition !== null) {
				break;
			}

			await new Promise((resolve) => setTimeout(resolve, FastRetryDelay));
		}
	} finally {
		retrying = false;
	}
}

async function sendEntries()
{
	const agentMode = await isAgentMode();

	if (!agentMode) {
		return;
	}

	try {
		const bufferId = await getBufferId();

		syncPosition = await link.catchUp({ bufferId, syncPosition, getEntriesAfter });

		await updateBadge(true, "connected");

		pollCommands();
	} catch {
			// the daemon isn't running, which is the normal state when no agent is
			// using it
		syncPosition = null;
		lastFailure = Date.now();
		await updateBadge(true, "waiting");
	}
}
