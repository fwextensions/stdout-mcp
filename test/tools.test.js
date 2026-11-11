import { createServer } from "node:http";
import { once } from "node:events";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpServer } from "../mcp/tools.js";

const Modern = { mode: { pin: "2026-07-28" } };
let cancelCount = 0;
let status = {};
	// the extensions that have logged, and the browser each did it in
let sources = [];
	// a store whose waits never finish on their own
const store = {
	wait: () => ({ promise: new Promise(() => {}), cancel: () => cancelCount++ }),
	getSources: () => sources,
	findBrowsers: (nameOrId) => new Set(status.browsers
		.filter(({ id, name }) => id === nameOrId || name.toLowerCase() === nameOrId.toLowerCase())
		.map(({ id }) => id)),
};
let sendCount = 0;
let sentTo;
	// what the next command sent to the extension will come back with
let outcome;
const commands = {
	send: (name, args, { browserId }) => {
		sendCount++;
		sentTo = browserId;

		return { promise: Promise.resolve(outcome), cancel() {} };
	},
};
let server;

async function connect(
	versionNegotiation)
{
	const client = new Client({ name: "test", version: "1.0.0" }, { versionNegotiation });

	await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));

	return client;
}

async function waitForCancel(
	count)
{
	for (let i = 0; i < 40 && cancelCount < count; i++) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}

	assert.equal(cancelCount, count);
}

before(async () => {
	const handle = toNodeHandler(createMcpHandler(() => createMcpServer({ store, getStatus: () => status, commands })));

	server = createServer((req, res) => handle(req, res)).listen(0, "127.0.0.1");
	await once(server, "listening");
});

after(() => {
	server.closeAllConnections();
	server.close();
});

test("stops waiting for a log when the call is cancelled", async () => {
	const client = await connect(Modern);
	const controller = new AbortController();
	const call = client.callTool({ name: "wait_for_log", arguments: { pattern: "never" } }, { signal: controller.signal });

	await new Promise((resolve) => setTimeout(resolve, 200));
	controller.abort();
	await assert.rejects(call);
	await waitForCancel(1);
	await client.close();
});

for (const [era, versionNegotiation] of [["2026-07-28", Modern], ["2025", undefined]]) {
	test(`stops waiting for a log when a ${era} client goes away`, async () => {
		const count = cancelCount;
		const client = await connect(versionNegotiation);
		const call = client.callTool({ name: "wait_for_log", arguments: { pattern: "never" } });

		call.catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, 200));
		await client.close();
		await waitForCancel(count + 1);
	});
}

	// whether the extension counts as disconnected is tested in check-ins.test.js
const browser = (id, name) => ({ id, name, label: name, lastCheckInAt: Date.now(), daemonLinkVersion: 1, batchRejection: null });
const Chrome = browser("aaaa1111", "Chrome 146");
const Edge = browser("bbbb2222", "Edge 146");
const CheckedIn = { startedAt: 1, browsers: [Chrome] };
const Reloaded = { result: { id: "a", name: "A", manifest: "skipped" }, cursor: "1:5" };

async function reload(
	newStatus,
	newOutcome = Reloaded,
	{ args = {}, newSources = [] } = {})
{
	const count = sendCount;
	const client = await connect(Modern);

	status = newStatus;
	outcome = newOutcome;
	sources = newSources;
	sentTo = undefined;

	const result = await client.callTool({ name: "reload_extension", arguments: { extension: "A", ...args } });

	await client.close();

	return { queued: sendCount > count, sentTo, isError: result.isError, text: result.content[0].text };
}

test("doesn't wait on an extension that isn't checking in", async () => {
	const { queued, isError, text } = await reload({ startedAt: 1, browsers: [] });

	assert.equal(queued, false);
	assert.equal(isError, true);
	assert.match(text, /Can't reload A right now.*ask the user to click the stdout toolbar icon/s);
});

test("reloads when the extension checked in recently", async () => {
	const { queued, isError, text } = await reload(CheckedIn);

	assert.equal(queued, true);
	assert.equal(isError, undefined);
	assert.match(text, /Reloaded the code of A/);
});

test("suggests trying again when the extension never picked up the reload", async () => {
	const { isError, text } = await reload(CheckedIn, { timedOut: "pickup" });

	assert.equal(isError, true);
	assert.match(text, /didn't pick up the reload.*try again/s);
});

test("warns against trying again when the reload started but never finished", async () => {
	const { isError, text } = await reload(CheckedIn, { timedOut: "result", cursor: "1:5" });

	assert.equal(isError, true);
	assert.match(text, /started reloading A.*may have reloaded/s);
	assert.doesNotMatch(text, /try again/);
	assert.match(text, /cursor: 1:5/);
});

test("reloads in the browser that has logged from the extension", async () => {
	const { sentTo, isError, text } = await reload({ startedAt: 1, browsers: [Chrome, Edge] }, Reloaded, {
		newSources: [{ browserId: Edge.id, extensionId: "a", extensionName: "A" }],
	});

	assert.equal(isError, undefined);
	assert.equal(sentTo, Edge.id);
	assert.match(text, /Reloaded the code of A \(a\) in Edge 146/);
});

test("asks which browser when the extension is in more than one", async () => {
	const { queued, isError, text } = await reload({ startedAt: 1, browsers: [Chrome, Edge] }, Reloaded, {
		newSources: [Chrome, Edge].map(({ id }) => ({ browserId: id, extensionId: "a", extensionName: "A" })),
	});

	assert.equal(queued, false);
	assert.equal(isError, true);
	assert.match(text, /more than one browser: Chrome 146, Edge 146\. Pass one of those as `browser`/);
});

test("reloads in the browser it's told to", async () => {
	const { sentTo, isError } = await reload({ startedAt: 1, browsers: [Chrome, Edge] }, Reloaded, {
		args: { browser: "edge 146" },
		newSources: [Chrome, Edge].map(({ id }) => ({ browserId: id, extensionId: "a", extensionName: "A" })),
	});

	assert.equal(isError, undefined);
	assert.equal(sentTo, Edge.id);
});

test("says which browsers there are when told one that hasn't checked in", async () => {
	const { queued, isError, text } = await reload(CheckedIn, Reloaded, { args: { browser: "Canary" } });

	assert.equal(queued, false);
	assert.equal(isError, true);
	assert.match(text, /No browser called "Canary" has checked in\. These have: Chrome 146 \(aaaa1111\)\./);
});

test("doesn't reload in a browser that has stopped checking in", async () => {
	const stale = { ...Edge, lastCheckInAt: Date.now() - 10 * 60 * 1000 };
	const { queued, isError, text } = await reload({ startedAt: 1, browsers: [Chrome, stale] }, Reloaded, {
		newSources: [{ browserId: Edge.id, extensionId: "a", extensionName: "A" }],
	});

	assert.equal(queued, false);
	assert.equal(isError, true);
	assert.match(text, /Can't reload A right now\. Note: the stdout extension in Edge 146 last checked in 10 minutes ago/);
});
