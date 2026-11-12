// @ts-check
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { BufferIdHeader, MaxBatchBytes } from "../extension/daemon-link.js";
import { CommandQueue } from "./commands.js";
import { createExtensionRoutes, ExtensionRoutes } from "./extension-routes.js";
import { LogStore } from "./store.js";
import { createMcpServer } from "./tools.js";
import { getCodeVersion, getPackageVersion } from "./version.js";

	// returned by route() when it has already sent the response
const Handled = Symbol("handled");

class HTTPError extends Error
{
	constructor(
		status,
		message)
	{
		super(message);
		this.status = status;
	}
}

function readJSON(
	req)
{
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;

		req.on("data", (chunk) => {
			size += chunk.length;

			if (size > MaxBatchBytes) {
				reject(new HTTPError(413, "Request body too large"));
				req.destroy();
			} else {
				chunks.push(chunk);
			}
		});
		req.on("end", () => {
			try {
				resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
			} catch {
				reject(new HTTPError(400, "Invalid JSON"));
			}
		});
		req.on("error", reject);
	});
}

/**
 * @typedef {object} DaemonServerOptions
 * @property {number} port  The port the server will listen on, which requests
 * must be addressed to.
 * @property {string} extensionOrigin  The stdout extension's origin, the only
 * one that may send entries or get commands.
 * @property {number} idleTimeout  How long to go without a request from an MCP
 * server before calling onIdle.
 * @property {() => void} onIdle
 */

/**
 * Create the daemon's HTTP server, without listening yet.
 *
 * @param {DaemonServerOptions} options
 * @returns {{ server: import("node:http").Server, close: () => void }}
 */
export function createDaemonServer(
	{ port, extensionOrigin, idleTimeout, onIdle })
{
	const store = new LogStore();
	const commands = new CommandQueue({ getCursor: () => store.getCursor() });
	const handleExtensionRequest = createExtensionRoutes({ store, commands });
	const bootId = randomUUID();
	const codeVersion = getCodeVersion();
	const packageVersion = getPackageVersion();
	const startedAt = Date.now();
	const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
	let lastActivity = Date.now();
	let activeRequests = 0;

	/** @returns {import("./tools.js").DaemonStatus} */
	function getStatus()
	{
		return {
			status: "ok",
			pid: process.pid,
			bootId,
			packageVersion,
			codeVersion,
			startedAt,
			browsers: store.getBrowsers(),
			batchRejection: store.batchRejection,
			maxSeq: store.maxSeq,
			entryCount: store.entries.length,
		};
	}

		// each request gets its own server, since the 2026-07-28 protocol has no
		// sessions.  requests from 2025-era clients are served the same way.
	const handleMCP = toNodeHandler(createMcpHandler(() => createMcpServer({ store, getStatus, commands })));

	async function route(
		req,
		res)
	{
		const { method, url } = req;
		const { origin } = req.headers;

			// reject requests addressed to some other host name, which is how a web
			// page could reach us through DNS rebinding
		if (!allowedHosts.has(req.headers.host)) {
			throw new HTTPError(403, "Forbidden host");
		}

		if (method === "POST" && ExtensionRoutes.has(url)) {
			if (origin !== extensionOrigin) {
				throw new HTTPError(403, "Forbidden origin");
			}

			const bufferId = req.headers[BufferIdHeader.toLowerCase()];

			return handleExtensionRequest(
				url,
				() => readJSON(req),
				(listener) => res.on("close", listener),
				typeof bufferId === "string" ? bufferId : undefined
			);
		}

			// browsers always send an Origin with cross-origin requests, so this keeps
			// web pages from reading the logs.  the MCP servers that query us don't
			// send one.
		if (origin && origin !== extensionOrigin) {
			throw new HTTPError(403, "Forbidden origin");
		}

		lastActivity = Date.now();

		if (method === "GET" && url === "/health") {
			return getStatus();
		}

		if (url === "/mcp") {
				// this also answers the GET and DELETE that 2025-era clients send for
				// sessions with a 405
			activeRequests++;
			res.on("close", () => {
				activeRequests--;
				lastActivity = Date.now();
			});
			await handleMCP(req, res);

			return Handled;
		}

		throw new HTTPError(404, "Not found");
	}

	const server = createServer(async (req, res) => {
		let status = 200;
		let body;

		try {
			body = await route(req, res);
		} catch (error) {
				// a bad search pattern throws a SyntaxError from the RegExp constructor
			status = error.status ?? (error instanceof SyntaxError ? 400 : 500);
			body = { error: error.message };
		}

		if (body !== Handled && !res.destroyed) {
			res.writeHead(status, { "Content-Type": "application/json" });
			res.end(JSON.stringify(body));
		}
	});

	const idleCheck = setInterval(() => {
		if (!activeRequests && Date.now() - lastActivity > idleTimeout) {
			onIdle();
		}
	}, Math.min(idleTimeout, 60 * 1000));

	return {
		server,
		close: () => {
			clearInterval(idleCheck);
			server.closeAllConnections();
			server.close();
		},
	};
}
