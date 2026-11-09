import { getBufferId, getEntriesAfter } from "./buffer.js";
import { runCommand } from "./commands.js";

	// the stdout-mcp server listens on this port by default
export const ServerURL = "http://127.0.0.1:47321";

const AlarmName = "stdout-sync";
	// alarms wake the service worker to send any logs the server doesn't have yet,
	// such as after a new agent session starts the server.  30 seconds is the
	// shortest period Chrome allows.
const AlarmPeriodMinutes = 0.5;
	// right after agent mode is turned on or Chrome starts, an agent session is
	// likely to start soon, so check for the server more often than the alarm
const FastRetryDelay = 5 * 1000;
const FastRetryDuration = 3 * 60 * 1000;
const FlushDelay = 250;
const BatchSize = 500;
const MaxBatchesPerFlush = 50;
	// after a failed request, leave retries to the alarm instead of trying again
	// on every new log message
const RetryDelay = 30 * 1000;

const BadgeColors = {
	connected: "#2e7d32",
	waiting: "#888",
};

	// the highest sequence number the server has from this buffer, or null if we
	// haven't asked it yet since the service worker started
let serverSeq = null;
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
		serverSeq = null;
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

	await fetch(`${ServerURL}/commands/result`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ id: command.id, ...outcome }),
	});
}

/**
 * Ask the server for commands for as long as it's running.  The server holds
 * each request until it has a command, for less than Chrome's limit on how long
 * a fetch can take.  Checking the storage API between requests keeps the service
 * worker awake.  If the server goes away, the next successful sync starts this
 * again.
 */
async function pollCommands()
{
	if (polling) {
		return;
	}

	polling = true;

	try {
		while (await isAgentMode()) {
			const response = await fetch(`${ServerURL}/commands`, { method: "POST" });

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}

			const { commands } = await response.json();

			await Promise.all(commands.map(sendCommandResult));
		}
	} catch {
			// the alarm will start polling again once the server is back
	} finally {
		polling = false;
	}
}

/**
 * Check for the server every few seconds for a little while, until it's found.
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
			if (serverSeq !== null) {
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

		for (let i = 0; i < MaxBatchesPerFlush; i++) {
				// the first request after the worker starts just asks the server what
				// it already has
			const entries = serverSeq === null
				? []
				: await getEntriesAfter(serverSeq, BatchSize);
			const response = await fetch(`${ServerURL}/ingest`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ bufferId, afterSeq: serverSeq, entries }),
			});

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}

			const { maxSeq } = await response.json();
				// the server only accepts a batch that continues from what it already
				// has.  if it restarted or we were out of date, it returns its actual
				// position and we resend from there.
			const accepted = serverSeq !== null
				&& maxSeq === (entries.at(-1)?.seq ?? serverSeq);

			serverSeq = maxSeq;

			if (accepted && entries.length < BatchSize) {
				break;
			}
		}

		await updateBadge(true, "connected");

		pollCommands();
	} catch {
			// the server isn't running, which is the normal state when no agent is
			// using it
		serverSeq = null;
		lastFailure = Date.now();
		await updateBadge(true, "waiting");
	}
}
