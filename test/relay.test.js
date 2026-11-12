import { spawn } from "node:child_process";
import { once } from "node:events";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { getCodeVersion } from "../mcp/version.js";
import { getFreePort } from "./free-port.js";

const port = await getFreePort();
const baseURL = `http://127.0.0.1:${port}`;
	// stands in for a daemon started from older code
const OldDaemon = `
	require("node:http").createServer((req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ status: "ok", pid: process.pid, codeVersion: "old" }));
	}).listen(${port}, "127.0.0.1", () => console.log("listening"));
`;
	// stands in for a daemon started from a newer stdout-mcp package
const NewerDaemon = `
	require("node:http").createServer((req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ status: "ok", pid: process.pid, packageVersion: "999.0.0", codeVersion: "newer" }));
	}).listen(${port}, "127.0.0.1", () => console.log("listening"));
`;
let client;

function connectRelay()
{
	const newClient = new Client({ name: "test", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });

	return newClient.connect(new StdioClientTransport({
		command: process.execPath,
		args: ["mcp/server.js"],
		env: { ...process.env, STDOUT_MCP_PORT: String(port) },
	})).then(() => newClient);
}

after(async () => {
	const health = await fetch(`${baseURL}/health`).then((response) => response.json(), () => null);

	await client?.close();

	if (health) {
		process.kill(health.pid);
	}
});

test("leaves a daemon from a newer package running", async () => {
	const newerDaemon = spawn(process.execPath, ["-e", NewerDaemon], { stdio: ["ignore", "pipe", "inherit"] });
	let exited = false;

	newerDaemon.on("exit", () => exited = true);
	await once(newerDaemon.stdout, "data");

	try {
			// the stand-in can't speak MCP, so connecting fails, but the relay checks
			// the daemon before passing on the first message
		const newerClient = await connectRelay().catch(() => null);

		await newerClient?.close();
		await new Promise((resolve) => setTimeout(resolve, 500));

		const health = await fetch(`${baseURL}/health`).then((response) => response.json());

		assert.equal(exited, false);
		assert.equal(health.pid, newerDaemon.pid);
	} finally {
		newerDaemon.kill();

		if (!exited) {
			await once(newerDaemon, "exit");
		}
	}
});

test("replaces a daemon that was started from older code", async () => {
	const oldDaemon = spawn(process.execPath, ["-e", OldDaemon], { stdio: ["ignore", "pipe", "inherit"] });
	const exited = once(oldDaemon, "exit");

	await once(oldDaemon.stdout, "data");

		// 2026-07-28 clients don't send an initialize request, which is when the
		// daemon's code used to be checked
	client = new Client({ name: "test", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
	await client.connect(new StdioClientTransport({
		command: process.execPath,
		args: ["mcp/server.js"],
		env: { ...process.env, STDOUT_MCP_PORT: String(port) },
	}));

	const result = await client.callTool({ name: "list_sources", arguments: {} });

	assert.match(result.content[0].text, /MCP server started \d+ seconds ago/);
	await exited;

	const health = await fetch(`${baseURL}/health`).then((response) => response.json());

	assert.equal(health.codeVersion, getCodeVersion());
	assert.notEqual(health.pid, oldDaemon.pid);
});

test("restarts the daemon if it exits during a session", async () => {
	const { pid } = await fetch(`${baseURL}/health`).then((response) => response.json());

	process.kill(pid);

	while (await fetch(`${baseURL}/health`).then(() => true, () => false)) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}

	const result = await client.callTool({ name: "list_sources", arguments: {} });

	assert.match(result.content[0].text, /MCP server started \d+ seconds ago/);
	assert.notEqual((await fetch(`${baseURL}/health`).then((response) => response.json())).pid, pid);
});
