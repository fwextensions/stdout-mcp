import { request } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import { LinkRoutes, MaxBatchBytes } from "../extension/daemon-link.js";
import { createDaemonServer } from "../mcp/daemon-server.js";
import { getFreePort } from "./free-port.js";

const ExtensionOrigin = "chrome-extension://stdout";

	// start a daemon in this process.  it calls onIdle instead of exiting.
async function startDaemon(
	t,
	{ idleTimeout = 60 * 60 * 1000, onIdle = () => {} } = {})
{
	const port = await getFreePort();
	const { server, close } = createDaemonServer({ port, extensionOrigin: ExtensionOrigin, idleTimeout, onIdle });

	server.listen(port, "127.0.0.1");
	await once(server, "listening");
	t.after(close);

	return port;
}

	// node:http, since fetch won't let us set the Host header.  resolves with the
	// error code if the daemon drops the connection.
function send(
	port,
	{ method = "POST", path = LinkRoutes.Ingest, host = `127.0.0.1:${port}`, origin = ExtensionOrigin, body = "{}" } = {})
{
	return new Promise((resolve, reject) => {
		const headers = { Host: host, "Content-Type": "application/json" };

		if (origin) {
			headers.Origin = origin;
		}

		const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
			const chunks = [];

			res.on("data", (chunk) => chunks.push(chunk));
			res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
		});

		req.on("error", (error) => error.code === "EPIPE" || error.code === "ECONNRESET"
			? resolve({ status: null, error: error.code })
			: reject(error));
			// fail instead of hanging the test run
		req.setTimeout(5000, () => req.destroy(new Error("The daemon didn't answer")));
			// Node refuses a GET with a body
		req.end(method === "GET" ? undefined : body);
	});
}

test("refuses a batch bigger than the Daemon Link allows, and says so to agents", async (t) => {
	const port = await startDaemon(t);
		// the daemon stops reading and drops the connection, so the sender may not
		// get the 413
	const { status } = await send(port, { body: JSON.stringify({ pad: "x".repeat(MaxBatchBytes) }) });
	const health = await send(port, { method: "GET", path: "/health", origin: null });

	assert.ok(status === 413 || status === null);
	assert.equal(health.body.batchRejection, "Request body too large");
});

test("refuses a body that isn't JSON", async (t) => {
	const port = await startDaemon(t);
	const { status, body } = await send(port, { body: "{not json" });

	assert.equal(status, 400);
	assert.equal(body.error, "Invalid JSON");
});

test("refuses requests addressed to another host name", async (t) => {
	const port = await startDaemon(t);

	assert.equal((await send(port, { host: `evil.example:${port}` })).status, 403);
	assert.equal((await send(port, { method: "GET", path: "/health", origin: null, host: `localhost:${port}` })).status, 200);
});

test("only lets the stdout extension send entries, and web pages read nothing", async (t) => {
	const port = await startDaemon(t);

	assert.equal((await send(port, { origin: "https://example.com" })).status, 403);
	assert.equal((await send(port, { origin: null })).status, 403);
	assert.equal((await send(port, { method: "GET", path: "/health", origin: "https://example.com" })).status, 403);
	assert.equal((await send(port, { path: "/nowhere", origin: null })).status, 404);
});

test("says when it's been idle long enough to exit", async (t) => {
	let idle = 0;
	const port = await startDaemon(t, { idleTimeout: 50, onIdle: () => idle++ });

	await send(port, { method: "GET", path: "/health", origin: null });
	assert.equal(idle, 0);
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.ok(idle > 0);
});
