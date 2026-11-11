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

/**
 * @typedef {object} CheckInStatus
 * @property {number} startedAt  When the daemon started.
 * @property {number} lastIngestAt  When the stdout extension last checked in, or 0.
 * @property {number|null} [daemonLinkVersion]  The Daemon Link version it last
 * sent, 0 if it didn't send one, or null before it checks in.
 * @property {string|null} [batchRejection]  Why its last batch was refused, until
 * one is accepted.
 */

/**
 * Whether there's no point waiting on the stdout extension, because it has
 * stopped checking in, or never did when it would have by now.
 *
 * @param {CheckInStatus} status
 * @param {number} [now]
 * @returns {boolean}
 */
export function isExtensionDisconnected(
	{ lastIngestAt, startedAt },
	now = Date.now())
{
	return lastIngestAt
		? now - lastIngestAt > StaleTime
		: now - startedAt > FirstCheckInTime;
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
	{ lastIngestAt, startedAt, daemonLinkVersion, batchRejection },
	now = Date.now())
{
	if (!lastIngestAt) {
		return `Note: the stdout extension hasn't sent anything since the MCP server started ${formatAge(startedAt, now)}. `
			+ "If agent mode is on (the stdout toolbar icon in Chrome shows an MCP badge), its stored logs "
			+ `will arrive within about ${CheckInPeriodSeconds} seconds. `
			+ "Otherwise, ask the user to click the stdout toolbar icon to turn on agent mode.";
	}

	if (now - lastIngestAt > StaleTime) {
		return `Note: the stdout extension last checked in ${formatAge(lastIngestAt, now)}, so agent mode may have been turned off, or Chrome may be closed. `
			+ "Newer logs may be missing.";
	}

	if (batchRejection) {
		return `Note: the MCP server couldn't accept the stdout extension's last batch of logs (${batchRejection}), so newer logs are missing.`;
	}

	if (daemonLinkVersion < DaemonLinkVersion) {
		return "Note: the stdout extension running in Chrome is older than this MCP server, so logs or commands may not work. "
			+ "Ask the user to click the reload button for stdout on chrome://extensions.";
	}

	if (daemonLinkVersion > DaemonLinkVersion) {
		return "Note: the stdout extension running in Chrome is newer than this MCP server, so logs or commands may not work. "
			+ "Ask the user to update the stdout-mcp package this agent is using.";
	}

	return "";
}
