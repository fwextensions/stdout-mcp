// @ts-check
import { CheckInPeriodSeconds, DaemonLinkVersion } from "../extension/daemon-link.js";
import { formatAge } from "./format.js";

// What the daemon can tell about the stdout extension from its check-ins, and
// what it tells agents about that.  Every timing here comes from the check-in
// period, which is set by the extension.

const CheckInPeriod = CheckInPeriodSeconds * 1000;
	// allows for a slow request or a service worker that's slow to wake
const Leeway = 5 * 1000;
	// missing a few check-ins in a row means agent mode is off or Chrome is closed
const StaleTime = 3 * CheckInPeriod;
	// a daemon that's been running this long would have heard from the extension
	// by now if agent mode were on
const FirstCheckInTime = CheckInPeriod + Leeway;

/**
 * How long the extension has to pick up a command.  If its service worker is
 * asleep, the next check-in wakes it, and it asks for commands after catching
 * the daemon up.
 */
export const PickupTimeout = CheckInPeriod + 2 * Leeway;

	// a browser that's been quiet this long is probably closed for the day, so
	// it's no longer worth mentioning while others are checking in
const ForgetTime = 60 * 60 * 1000;

/**
 * @typedef {import("./store.js").BrowserStatus} BrowserStatus
 */

/**
 * @typedef {object} CheckInStatus
 * @property {number} startedAt  When the daemon started.
 * @property {BrowserStatus[]} [browsers]  The browsers whose stdout extension
 * has checked in, most recent first.
 * @property {string|null} [batchRejection]  Why the last batch that couldn't be
 * tied to a browser was refused, until one is accepted.
 */

/**
 * Whether there's no point waiting on this browser's stdout extension, because
 * it has stopped checking in.
 *
 * @param {BrowserStatus} browser
 * @param {number} [now]
 * @returns {boolean}
 */
export function isBrowserDisconnected(
	{ lastCheckInAt },
	now = Date.now())
{
	return !lastCheckInAt || now - lastCheckInAt > StaleTime;
}

/**
 * @param {CheckInStatus} status
 * @param {number} [now]
 * @returns {BrowserStatus[]} The browsers whose stdout extension is checking in.
 */
export function getConnectedBrowsers(
	{ browsers = [] },
	now = Date.now())
{
	return browsers.filter((browser) => !isBrowserDisconnected(browser, now));
}

/**
 * Whether there's no point waiting on any stdout extension, because they've
 * all stopped checking in, or none did when one would have by now.
 *
 * @param {CheckInStatus} status
 * @param {number} [now]
 * @returns {boolean}
 */
export function isExtensionDisconnected(
	status,
	now = Date.now())
{
	return status.browsers?.length
		? !getConnectedBrowsers(status, now).length
		: now - status.startedAt > FirstCheckInTime;
}

/**
 * @param {BrowserStatus} browser
 * @param {boolean} named  Whether to say which browser, because there's more
 * than one.
 * @param {number} now
 * @returns {string[]}
 */
function getBrowserNotes(
	{ label, lastCheckInAt, daemonLinkVersion, batchRejection },
	named,
	now)
{
	const extension = named ? `the stdout extension in ${label}` : "the stdout extension";
	const fromIt = named ? ` from ${label}` : "";

	if (now - lastCheckInAt > StaleTime) {
		return [`Note: ${extension} last checked in ${formatAge(lastCheckInAt, now)}, so agent mode may have been turned off, or the browser may be closed. `
			+ `Newer logs${fromIt} may be missing.`];
	}

	if (batchRejection) {
		return [`Note: the MCP server couldn't accept the last batch of logs${fromIt} (${batchRejection}), so newer logs${fromIt} are missing.`];
	}

	if (daemonLinkVersion !== null && daemonLinkVersion < DaemonLinkVersion) {
		return [`Note: ${extension} is older than this MCP server, so logs or commands may not work. `
			+ "Ask the user to click the reload button for stdout on the browser's extensions page."];
	}

	if (daemonLinkVersion !== null && daemonLinkVersion > DaemonLinkVersion) {
		return [`Note: ${extension} is newer than this MCP server, so logs or commands may not work. `
			+ "Ask the user to update the stdout-mcp package this agent is using."];
	}

	return [];
}

/**
 * A note for agents about why logs may be missing or commands may fail, or an
 * empty string if all looks well.  Unlike isExtensionDisconnected(), this
 * mentions an extension that hasn't checked in yet, even right after the daemon
 * started, since its stored logs haven't arrived.
 *
 * @param {CheckInStatus} status
 * @param {number} [now]
 * @returns {string}
 */
export function getConnectionNote(
	{ startedAt, browsers = [], batchRejection },
	now = Date.now())
{
	const notes = [];

	if (batchRejection) {
		notes.push(`Note: the MCP server couldn't accept the stdout extension's last batch of logs (${batchRejection}), so newer logs are missing.`);
	}

	if (!browsers.some(({ lastCheckInAt }) => lastCheckInAt)) {
		if (!batchRejection) {
			notes.push(`Note: the stdout extension hasn't sent anything since the MCP server started ${formatAge(startedAt, now)}. `
				+ "If agent mode is on (the stdout toolbar icon shows an MCP badge), its stored logs "
				+ `will arrive within about ${CheckInPeriodSeconds} seconds. `
				+ "Otherwise, ask the user to click the stdout toolbar icon to turn on agent mode.");
		}

		return notes.join("\n");
	}

	const connected = getConnectedBrowsers({ startedAt, browsers }, now);
		// while some browser is checking in, one that's been gone a long time isn't
		// worth a note.  when none is, the most recent one is.
	const relevant = connected.length
		? browsers.filter(({ lastCheckInAt }) => now - lastCheckInAt <= ForgetTime)
		: [browsers[0]];
	const named = browsers.filter(({ lastCheckInAt }) => now - lastCheckInAt <= ForgetTime).length > 1;

	for (const browser of relevant) {
		notes.push(...getBrowserNotes(browser, named, now));
	}

	return notes.join("\n");
}
