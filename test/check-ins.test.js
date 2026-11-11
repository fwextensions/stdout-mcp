import { test } from "node:test";
import assert from "node:assert/strict";
import { DaemonLinkVersion } from "../extension/daemon-link.js";
import { getConnectedBrowsers, getConnectionNote, isExtensionDisconnected } from "../mcp/check-ins.js";

const Now = 1_000_000_000;
const secondsAgo = (seconds) => Now - seconds * 1000;
	// checked in recently, with nothing wrong
const chrome = { id: "aaaa1111", name: "Chrome 146", label: "Chrome 146", lastCheckInAt: secondsAgo(1), daemonLinkVersion: DaemonLinkVersion, batchRejection: null };
const edge = { ...chrome, id: "bbbb2222", name: "Edge 146", label: "Edge 146" };
const status = (...browsers) => ({ startedAt: secondsAgo(600), browsers, batchRejection: null });
const healthy = status(chrome);

test("an extension that has never checked in is given one check-in's time", () => {
	assert.equal(isExtensionDisconnected({ startedAt: secondsAgo(5), browsers: [] }, Now), false);
	assert.equal(isExtensionDisconnected({ startedAt: secondsAgo(60), browsers: [] }, Now), true);
});

test("an extension that missed a few check-ins in a row is disconnected", () => {
	assert.equal(isExtensionDisconnected(status({ ...chrome, lastCheckInAt: secondsAgo(60) }), Now), false);
	assert.equal(isExtensionDisconnected(status({ ...chrome, lastCheckInAt: secondsAgo(300) }), Now), true);
});

test("the extension is connected while any browser is checking in", () => {
	const stale = { ...chrome, lastCheckInAt: secondsAgo(300) };

	assert.equal(isExtensionDisconnected(status(edge, stale), Now), false);
	assert.deepEqual(getConnectedBrowsers(status(edge, stale), Now), [edge]);
});

test("a healthy extension gets no note", () => {
	assert.equal(getConnectionNote(healthy, Now), "");
	assert.equal(getConnectionNote(status(chrome, edge), Now), "");
});

test("says how to turn on agent mode while the extension hasn't checked in, even right away", () => {
	const note = getConnectionNote({ startedAt: secondsAgo(5), browsers: [] }, Now);

	assert.match(note, /hasn't sent anything since the MCP server started 5 seconds ago/);
	assert.match(note, /within about 30 seconds/);
	assert.match(note, /click the stdout toolbar icon/);
});

test("a stale check-in outranks a rejected batch", () => {
	const note = getConnectionNote(status({ ...chrome, lastCheckInAt: secondsAgo(300), batchRejection: "too large" }), Now);

	assert.match(note, /last checked in 5 minutes ago/);
	assert.doesNotMatch(note, /couldn't accept/);
});

test("says when the last batch was rejected", () => {
	assert.match(getConnectionNote(status({ ...chrome, batchRejection: "too large" }), Now), /couldn't accept .*\(too large\)/);
	assert.match(getConnectionNote({ ...healthy, batchRejection: "too large" }, Now), /couldn't accept .*\(too large\)/);
});

test("says which side to update when the Daemon Link versions differ", () => {
	assert.match(getConnectionNote(status({ ...chrome, daemonLinkVersion: DaemonLinkVersion - 1 }), Now), /older than this MCP server.*reload button/);
	assert.match(getConnectionNote(status({ ...chrome, daemonLinkVersion: DaemonLinkVersion + 1 }), Now), /newer than this MCP server.*update the stdout-mcp package/);
});

test("names the browser a note is about when there's more than one", () => {
	const note = getConnectionNote(status(edge, { ...chrome, lastCheckInAt: secondsAgo(300) }), Now);

	assert.match(note, /the stdout extension in Chrome 146 last checked in 5 minutes ago/);
	assert.match(note, /Newer logs from Chrome 146 may be missing/);
	assert.match(getConnectionNote(status(chrome, { ...edge, batchRejection: "too large" }), Now), /last batch of logs from Edge 146 \(too large\)/);
	assert.doesNotMatch(getConnectionNote(healthy, Now), /in Chrome/);
});

test("forgets a browser that's been gone for a long time while another checks in", () => {
	assert.equal(getConnectionNote(status(edge, { ...chrome, lastCheckInAt: secondsAgo(2 * 60 * 60) }), Now), "");
	assert.match(getConnectionNote(status({ ...chrome, lastCheckInAt: secondsAgo(2 * 60 * 60) }), Now), /last checked in 120 minutes ago/);
});
