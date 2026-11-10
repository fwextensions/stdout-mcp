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
	// a store whose waits never finish on their own
const store = {
	wait: () => ({ promise: new Promise(() => {}), cancel: () => cancelCount++ }),
};
let status = {};
let sendCount = 0;
const commands = {
	send: () => {
		sendCount++;

		return { promise: Promise.resolve({ result: { id: "a", name: "A", manifest: "skipped" } }), cancel() {} };
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

async function reload(
	newStatus)
{
	const count = sendCount;
	const client = await connect(Modern);

	status = newStatus;

	const result = await client.callTool({ name: "reload_extension", arguments: { extension: "A" } });

	await client.close();

	return { queued: sendCount > count, isError: result.isError, text: result.content[0].text };
}

test("doesn't wait on an extension that never checked in", async () => {
	const { queued, isError, text } = await reload({ startedAt: Date.now() - 60 * 1000, lastIngestAt: 0 });

	assert.equal(queued, false);
	assert.equal(isError, true);
	assert.match(text, /Can't reload A right now.*ask the user to click the stdout toolbar icon/s);
});

test("doesn't wait on an extension that stopped checking in", async () => {
	const { queued, isError, text } = await reload({ startedAt: 1, lastIngestAt: Date.now() - 5 * 60 * 1000, batchRejection: "too large" });

	assert.equal(queued, false);
	assert.equal(isError, true);
	assert.match(text, /last checked in/);
	assert.doesNotMatch(text, /couldn't accept/);
});

test("waits on an extension that hasn't had time to check in yet", async () => {
	assert.equal((await reload({ startedAt: Date.now() - 5 * 1000, lastIngestAt: 0 })).queued, true);
});

test("reloads when the extension checked in recently", async () => {
	assert.equal((await reload({ startedAt: 1, lastIngestAt: Date.now() - 1000 })).queued, true);
});
