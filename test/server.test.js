import { request } from "node:http";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { createDaemonLink, DaemonLinkVersion, LinkRoutes, MaxBatchBytes } from "../extension/daemon-link.js";
import { StdoutId } from "../extension/tap-link.js";
import { getFreePort } from "./free-port.js";

const port = await getFreePort();
const baseURL = `http://127.0.0.1:${port}`;
const extensionOrigin = `chrome-extension://${StdoutId}`;
const bufferId = "test";
	// the real extension's half of the conversation, with the origin Chrome adds
const link = createDaemonLink({
	baseURL,
	fetch: (url, init) => fetch(url, { ...init, headers: { ...init.headers, Origin: extensionOrigin } }),
});
const buffer = [];
let syncPosition = null;
let client;
let legacyClient;

const getEntriesAfter = async (position, limit) => buffer.filter(({ seq }) => seq > position).slice(0, limit);

function addToBuffer(
	entries)
{
	buffer.push(...entries.map((item) => ({ ...item, seq: buffer.length + entries.indexOf(item) + 1 })));
}

async function send(
	...entries)
{
	addToBuffer(entries);
	syncPosition = await link.catchUp({ bufferId, syncPosition, getEntriesAfter });
}

	// for requests the real extension would never make
function post(
	path,
	body,
	origin = extensionOrigin)
{
	return fetch(`${baseURL}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: origin },
		body: JSON.stringify(body ?? {}),
	});
}

async function callTool(
	name,
	args = {})
{
	const result = await client.callTool({ name, arguments: args });

	return result.content[0].text;
}

const cursorIn = (text) => text.match(/cursor: (\S+)/)[1];

const entry = (args, method = "log", extra = {}) => ({
	time: Date.now(),
	extensionId: "abcdefghijklmnopabcdefghijklmnop",
	extensionName: "Test Extension",
	filename: "sw.js",
	method,
	args,
	...extra,
});

function connect(
	options)
{
	const newClient = new Client({ name: "test", version: "1.0.0" }, options);

	return newClient.connect(new StdioClientTransport({
		command: process.execPath,
		args: ["mcp/server.js"],
		env: { ...process.env, STDOUT_MCP_PORT: String(port) },
	})).then(() => newClient);
}

before(async () => {
	client = await connect({ versionNegotiation: { mode: { pin: "2026-07-28" } } });
		// clients default to the 2025 protocol
	legacyClient = await connect();
});

after(async () => {
	const health = await fetch(`${baseURL}/health`).then((response) => response.json(), () => null);

	await client.close();
	await legacyClient.close();

	if (health) {
		process.kill(health.pid);
	}
});

test("lists the tools", async () => {
	const { tools } = await client.listTools();

	assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
	assert.deepEqual(tools.map(({ name }) => name).sort(), ["get_logs", "list_sources", "mark", "reload_extension", "wait_for_log"]);
});

test("serves clients using the 2025 protocol", async () => {
	const { tools } = await legacyClient.listTools();
	const result = await legacyClient.callTool({ name: "list_sources", arguments: {} });

	assert.equal(legacyClient.getNegotiatedProtocolVersion(), "2025-11-25");
	assert.equal(tools.length, 5);
	assert.match(result.content[0].text, /MCP server started/);
});

test("starts the daemon and reports that the extension hasn't connected", async () => {
	const text = await callTool("get_logs");

	assert.match(text, /No matching log entries/);
	assert.match(text, /hasn't sent anything/);
});

test("only accepts entries from the stdout extension", async () => {
	const batch = { bufferId, syncPosition: 0, entries: [] };

	assert.equal((await post(LinkRoutes.Ingest, batch, "chrome-extension://someoneelse")).status, 403);
	assert.equal((await post(LinkRoutes.Ingest, batch, "https://example.com")).status, 403);
	assert.equal((await fetch(`${baseURL}/health`, { headers: { Origin: "https://example.com" } })).status, 403);

		// fetch() won't let us change the Host header, which is what a DNS rebinding
		// attack would send
	const status = await new Promise((resolve, reject) => {
		request(`${baseURL}/health`, { headers: { Host: "evil.example" } }, (response) => {
			response.resume();
			resolve(response.statusCode);
		}).on("error", reject).end();
	});

	assert.equal(status, 403);
});

test("returns ingested logs with a cursor", async () => {
	await send();
	assert.equal(syncPosition, 0);

	await send(
		entry(["%s started", "worker"]),
		entry(["request failed", { __type: "Error", name: "TypeError", message: "boom", stack: "TypeError: boom\n    at foo (sw.js:1:1)" }], "error"),
	);
	assert.equal(syncPosition, 2);

	const text = await callTool("get_logs");

	assert.match(text, /^--- \d{4}-\d\d-\d\d, times in UTC[+-]\d\d:\d\d ---\n#1 \d\d:\d\d:\d\d\.\d{3} \[log\] Test Extension\/sw\.js: worker started/);
	assert.match(text, /#2 \S+ \+\d+ms \[error\] Test Extension\/sw\.js: request failed TypeError: boom\n {8}at foo/);
	assert.match(text, /cursor: \w+:2/);
	assert.doesNotMatch(text, /Note:/);
	assert.match(await callTool("get_logs", { levels: ["error"] }), /^#2 /m);
	assert.match(await callTool("get_logs", { after: cursorIn(text) }), /No matching log entries/);
	assert.match(await callTool("list_sources"), /Test Extension \(abcdefghijklmnopabcdefghijklmnop\): 2 entries.*files: sw\.js \(2\)/);
});

test("waits for a new matching log", async () => {
	const waiting = callTool("wait_for_log", { pattern: "ready$", timeoutSeconds: 10 });

	await new Promise((resolve) => setTimeout(resolve, 200));
	await send(entry(["not ready yet!"]), entry(["now ready"]));

	const text = await waiting;

	assert.match(text, /^#4 .*now ready/m);
	assert.doesNotMatch(text, /#3/);
	assert.match(text, /cursor: \w+:4/);
	assert.match(
		await callTool("wait_for_log", { pattern: "never", timeoutSeconds: 1 }),
		/No matching log entry within 1 seconds/
	);
});

test("says when a cursor is from before the MCP server restarted", async () => {
	const logs = await callTool("get_logs", { after: "old-run:1", limit: 1 });

	assert.match(logs, /^The MCP server restarted since that cursor was issued, so it no longer applies\. These are the latest entries\.\n\n--- .* ---\n#4 /);

	const waited = await callTool("wait_for_log", { after: "old-run:0", pattern: "now ready", timeoutSeconds: 1 });

	assert.match(waited, /^The MCP server restarted since that cursor was issued, so this only waited for new entries\./);
	assert.match(waited, /No matching log entry within 1 seconds/);
	assert.doesNotMatch(waited, /#4 /);
});

test("reports bad patterns as tool errors", async () => {
	const result = await client.callTool({ name: "get_logs", arguments: { search: "(" } });

	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Invalid regular expression/);
});

test("marks the log and shows page loads and time deltas", async () => {
	const time = Date.now();
	const marked = await callTool("mark", { label: "repro start" });

	assert.match(marked, /Added this line:\n--- .* ---\n#5 \S+ --- mark: repro start ---/);
	assert.match(marked, /cursor: \w+:5/);
	await send(
		{ ...entry(["first"], "log", { loadId: "load1" }), time },
		{ ...entry(["second"], "log", { loadId: "load1" }), time: time + 1500 },
	);

	const text = await callTool("get_logs", { after: cursorIn(marked) });

	assert.match(text, /^--- Test Extension\/sw\.js loaded ---\n#6 \S+ \[log\] .*first\n#7 \S+ \+1\.5s \[log\] .*second/m);
		// times of day are local, like in the stdout console
	assert.match(text, new RegExp(`#6 ${new Date(time).toTimeString().slice(0, 8)}\.`));
	assert.match(await callTool("get_logs", { around: 5, limit: 3 }), /^#4 .*\n#5 .*mark: repro start.*\n--- .*loaded ---\n#6 /m);
	assert.match(await callTool("get_logs", { since: "1m", search: "second" }), /#5 .*mark.*\n#7 /);
	assert.equal((await client.callTool({ name: "get_logs", arguments: { since: "soon" } })).isError, true);
});

test("says when logs come from more than one extension", async () => {
	await send(entry(["from another extension"], "log", { extensionId: "ponmlkjihgfedcbaponmlkjihgfedcba", extensionName: "Other Extension" }));

	assert.match(
		await callTool("get_logs", { since: "1m" }),
		/These entries come from 2 extensions: Test Extension \(6\), Other Extension \(1\)\. To see only one, pass its name or ID as `extension`\./
	);
	assert.doesNotMatch(await callTool("get_logs", { extension: "Test Extension" }), /These entries come from/);
});

async function answerReload(
	outcome,
	reloadManifest)
{
	const call = callTool("reload_extension", { extension: "Test Extension", reloadManifest });
	const commands = await link.pollCommands();

	assert.deepEqual(
		commands.map(({ name, args }) => ({ name, args })),
		[{ name: "reload", args: { extension: "Test Extension", ...(reloadManifest && { reloadManifest }) } }]
	);
	await link.sendCommandResult(commands[0].id, outcome);

	return call;
}

test("only the stdout extension can get commands or report results", async () => {
	assert.equal((await post(LinkRoutes.Commands, {}, "https://example.com")).status, 403);
	assert.equal((await post(LinkRoutes.CommandResult, { id: 1 }, "chrome-extension://someoneelse")).status, 403);
});

test("reloads an extension through the stdout extension", async () => {
	const text = await answerReload({ result: { id: "abc", name: "Test Extension", manifest: "skipped" } });

	assert.match(text, /Reloaded the code of Test Extension \(abc\)\. manifest\.json was not read again/);
	assert.match(text, /cursor: \w+:8 \(pass as `after` to get the entries logged since the reload\)/);
});

test("says whether reloading the manifest worked", async () => {
	const result = { id: "abc", name: "Test Extension", version: "2.0" };
	const expected = {
		reloaded: /including its manifest\.json\. It's now version 2\.0/,
		unconfirmed: /didn't call stdout\(\) again/,
		failed: /didn't come back/,
		unreachable: /manifest\.json was not read again, because the extension didn't answer/,
	};

	for (const [manifest, pattern] of Object.entries(expected)) {
		assert.match(await answerReload({ result: { ...result, manifest } }, true), pattern);
	}
});

test("reports why an extension couldn't be reloaded", async () => {
	assert.match(await answerReload({ error: "Test Extension is turned off" }), /^Test Extension is turned off$/);
});

test("the reload cursor includes logs that arrive before the extension gets the command", async () => {
	const call = callTool("reload_extension", { extension: "Test Extension" });

	await new Promise((resolve) => setTimeout(resolve, 200));
	await send(entry(["backlog"]));

	const commands = await link.pollCommands();

	await link.sendCommandResult(commands[0].id, { result: { id: "abc", name: "Test Extension", manifest: "skipped" } });
	assert.match(await call, /cursor: \w+:9 /);
});

test("resends from the daemon's sync position when the extension's is wrong", async () => {
	const delivered = syncPosition;

	addToBuffer([entry(["missed one"]), entry(["missed two"])]);

		// as if the extension thinks the daemon got these before it restarted
	syncPosition = buffer.length;
	syncPosition = await link.catchUp({ bufferId, syncPosition, getEntriesAfter });

	assert.equal(syncPosition, delivered + 2);
	assert.match(await callTool("get_logs", { limit: 2 }), /missed one[^]*missed two/);
});

test("sends a backlog larger than one batch", async () => {
	const start = syncPosition;

	addToBuffer(Array.from({ length: 1201 }, (_, i) => entry([`backlog ${i}`])));
	syncPosition = await link.catchUp({ bufferId, syncPosition, getEntriesAfter });

	assert.equal(syncPosition, start + 1201);
	assert.match(await callTool("get_logs", { limit: 1 }), /backlog 1200/);
});

test("rejects a failed exchange", async () => {
	const failing = createDaemonLink({ baseURL, fetch: (url, init) => fetch(url, init) });

	await assert.rejects(failing.pollCommands(), /HTTP 403/);
});

test("warns when the extension's Daemon Link version differs", async () => {
	const check = (body) => post(LinkRoutes.Ingest, { bufferId, syncPosition, entries: [], ...body })
		.then(() => callTool("get_logs", { limit: 1 }));

	assert.match(await check({}), /Note: the stdout extension running in Chrome is older .*reload button/);
	assert.match(await check({ linkVersion: DaemonLinkVersion - 1 }), /is older/);
	assert.match(await check({ linkVersion: DaemonLinkVersion + 1 }), /is newer .*update the stdout-mcp package/);

	await send();
	assert.doesNotMatch(await callTool("get_logs", { limit: 1 }), /Note:/);
});

test("tells agents when a batch is too big, until one is accepted", async () => {
	const body = { bufferId, syncPosition, entries: [{ ...entry(["x".repeat(MaxBatchBytes)]), seq: buffer.length + 1 }] };

		// the daemon hangs up without reading the whole request
	await post(LinkRoutes.Ingest, body).catch(() => {});
	assert.match(await callTool("get_logs", { limit: 1 }), /couldn't accept the stdout extension's last batch of logs \(Request body too large\)/);

	await send(entry(["after the big one"]));
	assert.doesNotMatch(await callTool("get_logs", { limit: 1 }), /couldn't accept/);
});
