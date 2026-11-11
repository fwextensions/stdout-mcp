import { test } from "node:test";
import assert from "node:assert/strict";
import { DaemonLinkVersion } from "../extension/daemon-link.js";
import { getConnectionNote, isExtensionDisconnected } from "../mcp/check-ins.js";

const Now = 1_000_000_000;
const secondsAgo = (seconds) => Now - seconds * 1000;
	// checked in recently, with nothing wrong
const healthy = { startedAt: secondsAgo(600), lastIngestAt: secondsAgo(1), daemonLinkVersion: DaemonLinkVersion, batchRejection: null };

test("an extension that has never checked in is given one check-in's time", () => {
	assert.equal(isExtensionDisconnected({ startedAt: secondsAgo(5), lastIngestAt: 0 }, Now), false);
	assert.equal(isExtensionDisconnected({ startedAt: secondsAgo(60), lastIngestAt: 0 }, Now), true);
});

test("an extension that missed a few check-ins in a row is disconnected", () => {
	assert.equal(isExtensionDisconnected({ ...healthy, lastIngestAt: secondsAgo(60) }, Now), false);
	assert.equal(isExtensionDisconnected({ ...healthy, lastIngestAt: secondsAgo(300) }, Now), true);
});

test("a healthy extension gets no note", () => {
	assert.equal(getConnectionNote(healthy, Now), "");
});

test("says how to turn on agent mode while the extension hasn't checked in, even right away", () => {
	const note = getConnectionNote({ startedAt: secondsAgo(5), lastIngestAt: 0, daemonLinkVersion: null }, Now);

	assert.match(note, /hasn't sent anything since the MCP server started 5 seconds ago/);
	assert.match(note, /within about 30 seconds/);
	assert.match(note, /click the stdout toolbar icon/);
});

test("a stale check-in outranks a rejected batch", () => {
	const note = getConnectionNote({ ...healthy, lastIngestAt: secondsAgo(300), batchRejection: "too large" }, Now);

	assert.match(note, /last checked in 5 minutes ago/);
	assert.doesNotMatch(note, /couldn't accept/);
});

test("says when the last batch was rejected", () => {
	assert.match(getConnectionNote({ ...healthy, batchRejection: "too large" }, Now), /couldn't accept .*\(too large\)/);
});

test("says which side to update when the Daemon Link versions differ", () => {
	assert.match(getConnectionNote({ ...healthy, daemonLinkVersion: DaemonLinkVersion - 1 }, Now), /older than this MCP server.*reload button/);
	assert.match(getConnectionNote({ ...healthy, daemonLinkVersion: DaemonLinkVersion + 1 }, Now), /newer than this MCP server.*update the stdout-mcp package/);
});
