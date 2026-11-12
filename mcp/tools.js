// @ts-check
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CommandNames, CommandRunSeconds, ManifestStatus } from "../extension/daemon-link.js";
import { getConnectedBrowsers, getConnectionNote, isExtensionDisconnected, PickupTimeout } from "./check-ins.js";
import { formatAge } from "./format.js";

/** @typedef {import("@modelcontextprotocol/server").CallToolResult} CallToolResult */

/**
 * @typedef {object} DaemonStatus
 * @property {string} status
 * @property {number} pid
 * @property {string} bootId
 * @property {string} packageVersion  The stdout-mcp version the daemon was
 * started from.
 * @property {string} codeVersion  Hash of the code the daemon was started from.
 * @property {number} startedAt
 * @property {import("./store.js").BrowserStatus[]} browsers  The browsers whose
 * stdout extension has checked in, most recent first.
 * @property {string|null} batchRejection  Why the last batch that couldn't be
 * tied to a browser was refused, until one is accepted.
 * @property {number} maxSeq
 * @property {number} entryCount
 */

const Instructions = `\
Reads console output from Chrome extensions under development. The extension \
being debugged forwards its console calls to the "stdout" helper extension, \
which stores them even when no agent is connected, so logs from before this \
session started are available.

Start with get_logs to see recent output, or list_sources to see which \
extensions and pages have logged. Logs from every extension are mixed \
together, so when you know which extension you're working on, such as from \
the name in the project's manifest.json, pass it as \`extension\`. get_logs \
says when its results come from more than one extension.

The stdout extension can run in more than one browser at once, such as Chrome \
and Edge, or Chrome and Canary. Each entry then says which browser it came \
from, and \`browser\` limits results to one of them. list_sources lists the \
browsers by the names the user gave them, or by brand and version.

Every result includes a cursor; pass it as \
\`after\` to get only newer entries. Use \`since\` to limit results to a recent \
time span, or \`around\` to see the entries near one you found. Each entry \
shows the time since the previous one, and a "loaded" line marks the first \
entry from each page load, such as a service worker restart.

Before asking the user to reproduce a problem, call mark to add a line that \
brackets the repro. Then use wait_for_log to wait for a specific message.

After changing an extension's code, call reload_extension instead of asking \
the user to reload it. Only unpacked extensions that have called stdout() can \
be reloaded. If you changed manifest.json, pass reloadManifest and check \
whether the result says it worked. Open tabs keep any old content scripts \
until they're refreshed.

If the tools report that the stdout extension hasn't sent anything, ask the \
user to click the stdout extension's toolbar icon in Chrome so it shows an MCP \
badge. That turns on agent mode, which lets the extension send logs here.`;

const filterShape = {
	levels: z.array(z.string()).optional()
		.describe('Console methods to include, like ["error", "warn"]. Defaults to all.'),
	extension: z.string().optional()
		.describe("Only include logs from this extension, by ID or exact name."),
	browser: z.string().optional()
		.describe("Only include logs from this browser, by the name or ID that list_sources shows."),
	filename: z.string().optional()
		.describe('Only include logs from pages or scripts whose filename contains this, like "popup".'),
	search: z.string().optional()
		.describe("Case-insensitive regular expression to match against the message text."),
	since: z.string().optional()
		.describe('Only include entries from this long ago or later, like "30s", "10m" or "2h", or from a local time like "2026-10-20 16:35".'),
};
const DurationPattern = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i;
const DurationUnits = { ms: 1, s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };

function pad(
	number,
	length = 2)
{
	return String(number).padStart(length, "0");
}

	// times are shown in the local time zone, so they match the stdout console
function formatDate(
	time)
{
	const date = new Date(time);

	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatClock(
	time)
{
	const date = new Date(time);

	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function formatZone(
	time)
{
	const offset = -new Date(time).getTimezoneOffset();
	const sign = offset < 0 ? "-" : "+";

	return `UTC${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

function formatTime(
	time)
{
	return time
		? `${formatDate(time)} ${formatClock(time)} ${formatZone(time)}`
		: "unknown time";
}

function formatDelta(
	ms)
{
	const sign = ms < 0 ? "-" : "+";

	ms = Math.abs(ms);

	if (ms < 1000) {
		return `${sign}${ms}ms`;
	}

	if (ms < 60 * 1000) {
		return `${sign}${(ms / 1000).toFixed(1)}s`;
	}

	const seconds = Math.round(ms / 1000);

	return `${sign}${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function formatEntry(
	{ seq, time, method, extensionId, extensionName, browserId, filename, text, mark, newLoad },
	previousTime,
	browserLabels)
{
		// show how long it's been since the previous line, which is what matters
		// when debugging timing problems
	const delta = previousTime && time ? ` ${formatDelta(time - previousTime)}` : "";
	const prefix = `#${seq} ${time ? formatClock(time) : "unknown time"}${delta}`;

	if (mark) {
		return `${prefix} --- mark: ${text} ---`;
	}

	const browser = browserLabels && ` (${browserLabels.get(browserId) ?? browserId})`;
	const source = `${extensionName ?? extensionId}/${filename}${browser || ""}`;
		// indent continuation lines, like stack traces, under the entry
	const body = text.replaceAll("\n", "\n    ");
	const line = `${prefix} [${method}] ${source}: ${body}`;

	return newLoad ? `--- ${source} loaded ---\n${line}` : line;
}

/**
 * @param {object[]} entries
 * @param {Map<string, string>} [browserLabels]  If the entries come from more
 * than one browser, each one says which, by these labels.
 * @returns {string}
 */
function formatEntries(
	entries,
	browserLabels = new Map())
{
	const browserIds = new Set(entries.filter(({ mark }) => !mark).map(({ browserId }) => browserId));
	const labels = browserIds.size > 1 ? browserLabels : null;

	return entries.map((entry, i) => {
		const previousTime = entries[i - 1]?.time;
		const line = formatEntry(entry, previousTime, labels);
			// each line only shows the time of day, so add a line with the date
			// when it changes
		const showDate = entry.time
			&& (!previousTime || formatDate(entry.time) !== formatDate(previousTime));

		return showDate
			? `--- ${formatDate(entry.time)}, times in ${formatZone(entry.time)} ---\n${line}`
			: line;
	}).join("\n");
}

function parseSince(
	since)
{
	if (!since) {
		return undefined;
	}

	const [, amount, unit] = since.trim().match(DurationPattern) ?? [];

	if (amount) {
		return Date.now() - amount * DurationUnits[unit.toLowerCase()];
	}

	const time = Date.parse(since);

	if (Number.isNaN(time)) {
		throw new Error(`Invalid since value: "${since}". Use a duration like "10m" or a time like "2026-10-20 16:35".`);
	}

	return time;
}

/**
 * @param {import("../extension/daemon-link.js").ReloadResult} result
 * @returns {string}
 */
function getReloadMessage(
	{ id, name, manifest, version },
	where = "")
{
	const extension = `${name} (${id})${where}`;

	switch (manifest) {
		case ManifestStatus.Reloaded:
			return `Reloaded ${extension}, including its manifest.json. It's now version ${version}, `
				+ "and its service worker started and called stdout().";

		case ManifestStatus.Unconfirmed:
			return `Asked ${extension} to reload, including its manifest.json. It's enabled at version `
				+ `${version}, but its service worker didn't call stdout() again, so it may not have `
				+ "started. Check its logs, or ask the user to look at chrome://extensions.";

		case ManifestStatus.Failed:
			throw new Error(`Asked ${extension} to reload its manifest.json, but it didn't come back. `
				+ "The manifest may be invalid, and Chrome has turned the extension off. Once it's fixed, "
				+ "ask the user to click the reload button on chrome://extensions.");

		case ManifestStatus.Unreachable:
			return `Reloaded the code of ${extension}, but manifest.json was not read again, because the `
				+ "extension didn't answer. It needs the current stdout-mcp library, with stdout() called "
				+ "when a working service worker starts. If manifest.json changed, ask the user to click "
				+ "the reload button on chrome://extensions.";

		case ManifestStatus.Skipped:
		default:
			return `Reloaded the code of ${extension}. manifest.json was not read again. If it changed, `
				+ "call this again with `reloadManifest`.";
	}
}

	// tell the agent when other extensions' logs are mixed in, since a noisy one
	// can crowd out the extension it's working on
function getMixedSourcesNote(
	entries)
{
	const counts = new Map();

	for (const { mark, extensionId, extensionName } of entries) {
		if (!mark) {
			const source = counts.get(extensionId) ?? { name: extensionName ?? extensionId, count: 0 };

			source.count++;
			counts.set(extensionId, source);
		}
	}

	if (counts.size < 2) {
		return "";
	}

	const list = [...counts.values()]
		.sort((a, b) => b.count - a.count)
		.map(({ name, count }) => `${name} (${count})`)
		.join(", ");

	return `These entries come from ${counts.size} extensions: ${list}. `
		+ "To see only one, pass its name or ID as `extension`.";
}

/**
 * @param {DaemonStatus} status
 * @returns {Map<string, string>} Each browser's label, by its ID.
 */
function getBrowserLabels(
	{ browsers = [] })
{
	return new Map(browsers.map(({ id, label }) => [id, label]));
}

/**
 * Pick the browser to reload an extension in: the one that has logged from it,
 * or the only one checking in.
 *
 * @param {{ extension: string, browser?: string }} target
 * @param {DaemonStatus} status
 * @param {import("./store.js").LogStore} store
 * @returns {import("./store.js").BrowserStatus|null} Null if no browser has
 * checked in yet, but one may soon.
 */
function chooseBrowser(
	{ extension, browser },
	status,
	store)
{
	const browsers = status.browsers ?? [];
	let candidates = browsers;

	if (browser) {
		const ids = store.findBrowsers(browser);

		candidates = browsers.filter(({ id }) => ids.has(id));

		if (!candidates.length) {
			throw new Error(`No browser called "${browser}" has checked in. `
				+ (browsers.length
					? `These have: ${browsers.map(({ label, id }) => `${label} (${id})`).join(", ")}.`
					: getConnectionNote(status)));
		}
	}

	const lower = extension.toLowerCase();
	const logged = new Set(store.getSources()
		.filter(({ extensionId, extensionName }) => extensionId === extension
			|| extensionName?.toLowerCase() === lower)
		.map(({ browserId }) => browserId));
	const havingIt = candidates.filter(({ id }) => logged.has(id));
		// an extension that hasn't logged may still be in a browser, whose stdout
		// extension will say what can be reloaded if it isn't
	const targets = havingIt.length ? havingIt : candidates;
	const connected = getConnectedBrowsers({ ...status, browsers: targets });

	if (connected.length === 1) {
		return connected[0];
	}

		// right after the daemon starts, a browser may not have checked in yet.
		// whichever one asks for commands first gets the reload.
	if (!browsers.length && !browser && !isExtensionDisconnected(status)) {
		return null;
	}

	if (connected.length > 1) {
		throw new Error(`${extension} could be reloaded in more than one browser: `
			+ `${connected.map(({ label }) => label).join(", ")}. Pass one of those as \`browser\` to say which.`);
	}

	throw new Error(`Can't reload ${extension} right now. ${getConnectionNote(status)}`);
}

/**
 * @param {...(string|false|undefined)} parts  Falsy parts are left out.
 * @returns {CallToolResult}
 */
function textResult(
	...parts)
{
	return {
		content: [{ type: "text", text: parts.filter(Boolean).join("\n\n") }],
	};
}

/**
 * @param {Error} error
 * @returns {CallToolResult}
 */
function errorResult(
	error)
{
	return {
		content: [{ type: "text", text: error.message }],
		isError: true,
	};
}

/**
 * Create an MCP server whose tools read from the daemon's log store.  The
 * daemon creates one for each request, so they're cheap to make.
 *
 * @param {{ store: import("./store.js").LogStore, getStatus: () => DaemonStatus, commands: import("./commands.js").CommandQueue }} options
 * @returns {McpServer}
 */
export function createMcpServer(
	{ store, getStatus, commands })
{
	const server = new McpServer(
		{ name: "stdout-mcp", version: "0.1.0" },
		{ instructions: Instructions }
	);

	server.registerTool(
		"get_logs",
		{
			title: "Get extension logs",
			description: "Get console output from Chrome extensions that use the stdout-mcp library, "
				+ "including output from before this session started. Without `after`, returns the most "
				+ "recent matching entries. With `after`, returns the entries following that cursor, "
				+ "oldest first. With `around`, returns the entries before and after that one.",
			inputSchema: z.object({
				after: z.string().optional()
					.describe("Cursor from a previous result. Only entries after it are returned."),
				around: z.number().int().optional()
					.describe("Entry number to center the results on, such as one found with `search`. "
						+ "Filters apply to the entries around it."),
				limit: z.number().int().min(1).max(1000).optional()
					.describe("Maximum number of entries to return. Defaults to 100, or 21 with `around`."),
				...filterShape,
			}),
			annotations: { readOnlyHint: true },
		},
		async ({ after, around, limit = around === undefined ? 100 : 21, since, ...filter }) => {
			try {
					// a bad search pattern throws here, with a message that says so
				const { entries, cursor, cursorReset, hasMore } = store.query({
					after,
					around,
					limit,
					filter: { ...filter, since: parseSince(since) },
				});

				const status = getStatus();

				return textResult(
					cursorReset && "The MCP server restarted since that cursor was issued, so it no longer applies. These are the latest entries.",
					entries.length ? formatEntries(entries, getBrowserLabels(status)) : "No matching log entries.",
					hasMore && "There may be more entries after these.",
					getMixedSourcesNote(entries),
					`cursor: ${cursor} (pass as \`after\` to get only newer entries)`,
					getConnectionNote(status)
				);
			} catch (error) {
				return errorResult(error);
			}
		}
	);

	server.registerTool(
		"wait_for_log",
		{
			title: "Wait for an extension log",
			description: "Wait until a Chrome extension logs a message matching a pattern, such as after "
				+ "asking the user to reproduce a problem or reload the extension. By default, only "
				+ "entries logged after this call starts are considered.",
			inputSchema: z.object({
				pattern: z.string()
					.describe("Case-insensitive regular expression to match against the message text."),
				after: z.string().optional()
					.describe("Cursor from a previous result. Defaults to the latest entry, so only new logs match."),
				timeoutSeconds: z.number().min(1).max(120).optional()
					.describe("How long to wait. Defaults to 30."),
				levels: filterShape.levels,
				extension: filterShape.extension,
				browser: filterShape.browser,
				filename: filterShape.filename,
			}),
			annotations: { readOnlyHint: true },
		},
		async ({ pattern, after, timeoutSeconds = 30, ...filter }, ctx) => {
			try {
				const { promise, cancel } = store.wait({
					after,
					limit: 100,
					timeoutMs: timeoutSeconds * 1000,
					filter: { ...filter, search: pattern },
				});

					// stop waiting if the request is cancelled, or the agent session
					// that asked goes away
				ctx.mcpReq.signal.addEventListener("abort", cancel);

				const { entries, cursor, cursorReset, timedOut } = await promise;
				const status = getStatus();

				return textResult(
					cursorReset && "The MCP server restarted since that cursor was issued, so this only waited for new entries. A match logged before this call could have been missed.",
					timedOut
						? `No matching log entry within ${timeoutSeconds} seconds.`
						: formatEntries(entries, getBrowserLabels(status)),
					`cursor: ${cursor} (pass as \`after\` to get only newer entries)`,
					getConnectionNote(status)
				);
			} catch (error) {
				return errorResult(error);
			}
		}
	);

	server.registerTool(
		"mark",
		{
			title: "Mark the log",
			description: "Add a line to the log, such as before asking the user to reproduce a problem, "
				+ "so the entries that follow are easy to find. Returns a cursor to pass as `after` "
				+ "to get the entries logged since the mark.",
			inputSchema: z.object({
				label: z.string().optional()
					.describe('Text for the line, like "repro 2: open popup twice". Defaults to "mark".'),
			}),
		},
		async ({ label = "mark" }) => {
			try {
				const { entry, cursor } = store.addMark(label);

				return textResult(
					`Added this line:\n${formatEntries([entry])}`,
					`cursor: ${cursor} (pass as \`after\` to get the entries logged since the mark)`,
					getConnectionNote(getStatus())
				);
			} catch (error) {
				return errorResult(error);
			}
		}
	);

	server.registerTool(
		"reload_extension",
		{
			title: "Reload an extension",
			description: "Reload an unpacked Chrome extension so it picks up changes to its code. Pass "
				+ "`reloadManifest` if manifest.json changed too, and the result will say whether that "
				+ "looks like it worked. Only extensions that have called stdout() can be reloaded. "
				+ "Returns a cursor to pass as `after` to get the entries logged since the reload.",
			inputSchema: z.object({
				extension: z.string()
					.describe("The extension to reload, by ID or exact name."),
				browser: z.string().optional()
					.describe("The browser to reload it in, by the name or ID that list_sources shows. Only "
						+ "needed when the extension is in more than one browser."),
				reloadManifest: z.boolean().optional()
					.describe("Also read manifest.json again. Needs the current stdout-mcp library, with "
						+ "stdout() called when the service worker starts. Defaults to false."),
			}),
		},
		async ({ extension, browser, reloadManifest }, ctx) => {
			try {
				const status = getStatus();
					// this also keeps the agent from waiting for an answer that won't come
				const target = chooseBrowser({ extension, browser }, status, store);
				const where = target && (status.browsers?.length ?? 0) > 1 ? ` in ${target.label}` : "";

				const { promise, cancel } = commands.send(CommandNames.Reload, { extension, reloadManifest }, {
					browserId: target?.id,
					pickupTimeout: PickupTimeout,
					runTimeout: CommandRunSeconds * 1000,
				});

				ctx.mcpReq.signal.addEventListener("abort", cancel);

				const { result, error, timedOut, cancelled, cursor } = await promise;

				if (timedOut === "pickup") {
					throw new Error(`The stdout extension${where} didn't pick up the reload within ${PickupTimeout / 1000} seconds. `
						+ (getConnectionNote(getStatus()) || "Chrome may be busy, so try again."));
				}

					// the reload may have worked, so a retry could reload it twice
				if (timedOut === "result") {
					throw new Error(`The stdout extension started reloading ${extension}${where}, but didn't say how it went `
						+ `within ${CommandRunSeconds} seconds. Check its logs before trying again, since it may `
						+ `have reloaded.\n\ncursor: ${cursor} (pass as \`after\` to get the entries logged since `
						+ "the reload started)");
				}

				if (cancelled) {
					throw new Error("The reload was cancelled.");
				}

				if (error) {
					throw new Error(error);
				}

				return textResult(
					getReloadMessage(result, where),
					`cursor: ${cursor} (pass as \`after\` to get the entries logged since the reload)`
				);
			} catch (error) {
				return errorResult(error);
			}
		}
	);

	server.registerTool(
		"list_sources",
		{
			title: "List log sources",
			description: "List the Chrome extensions and pages that have sent logs, and the browsers "
				+ "the stdout extension is sending them from.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async () => {
			try {
				const result = { ...getStatus(), sources: store.getSources() };
				const browsers = result.browsers ?? [];
				const labels = getBrowserLabels(result);
				const status = `MCP server started ${formatAge(result.startedAt)} and holds ${result.entryCount} entries.`
					+ (browsers.length ? "" : " The stdout extension hasn't checked in yet.");
				const browserList = browsers.map(({ id, label, lastCheckInAt }) =>
					`- ${label} (${id}): the stdout extension last checked in ${formatAge(lastCheckInAt)}`);
				const sources = result.sources.map(({ extensionId, extensionName, browserId, count, lastTime, filenames }) => {
					const files = Object.entries(filenames)
						.map(([filename, fileCount]) => `${filename} (${fileCount})`)
						.join(", ");
					const where = browsers.length > 1 ? ` in ${labels.get(browserId) ?? browserId}` : "";

					return `- ${extensionName ?? "unnamed extension"} (${extensionId})${where}: ${count} entries, `
						+ `last at ${formatTime(lastTime)}; files: ${files}`;
				});

				return textResult(
					status,
					browserList.length && `Browsers:\n${browserList.join("\n")}`,
					sources.length ? `Extensions:\n${sources.join("\n")}` : "No extensions have sent logs yet.",
					getConnectionNote(result)
				);
			} catch (error) {
				return errorResult(error);
			}
		}
	);

	return server;
}
