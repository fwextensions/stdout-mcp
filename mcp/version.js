// @ts-check
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

const McpDir = new URL("./", import.meta.url);
const VersionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/;

/**
 * Hash the code that the daemon runs, so an MCP server can tell whether a
 * running daemon was started from different code.
 *
 * @returns {string}
 */
export function getCodeVersion()
{
	const files = readdirSync(McpDir)
		.filter((name) => name.endsWith(".js"))
		.sort()
		.map((name) => new URL(name, McpDir));
	const hash = createHash("sha256");

		// the daemon also runs the extension's definitions of the Daemon Link, the
		// Tap Link (for the stdout extension's ID) and the value tags
	files.push(
		new URL("../extension/daemon-link.js", McpDir),
		new URL("../extension/tap-link.js", McpDir),
		new URL("../extension/value-tags.js", McpDir)
	);

	for (const file of files) {
		hash.update(readFileSync(file));
	}

	return hash.digest("hex").slice(0, 12);
}

/**
 * @returns {string} The version of the stdout-mcp package this code is from.
 */
export function getPackageVersion()
{
	return JSON.parse(readFileSync(new URL("../package.json", McpDir), "utf8")).version;
}

/**
 * Compare two package versions, like "0.2.0" and "0.2.0-beta.1".  A prerelease
 * comes before the release it leads up to.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} Less than 0 if `a` is older, more than 0 if it's newer, or 0
 * if they're the same.  A version that can't be read is older than any other.
 */
export function compareVersions(
	a,
	b)
{
	const [, ...partsA] = VersionPattern.exec(String(a ?? "")) ?? [];
	const [, ...partsB] = VersionPattern.exec(String(b ?? "")) ?? [];

	if (!partsA.length || !partsB.length) {
		return partsA.length - partsB.length;
	}

	for (let i = 0; i < 3; i++) {
		const difference = Number(partsA[i]) - Number(partsB[i]);

		if (difference) {
			return Math.sign(difference);
		}
	}

	const [preA, preB] = [partsA[3], partsB[3]];

	if (preA === preB) {
		return 0;
	}

	if (!preA || !preB) {
		return preA ? -1 : 1;
	}

	return preA.localeCompare(preB, "en", { numeric: true }) < 0 ? -1 : 1;
}

/**
 * @typedef {object} DaemonCode
 * @property {string} [packageVersion]  Missing from daemons that predate it.
 * @property {string} [codeVersion]
 */

/**
 * Whether a starting MCP server should replace the running daemon with its own.
 * A daemon from an older package is replaced, but one from a newer package is
 * left running, since agents in other projects may be using it.  When the
 * packages match but the code doesn't, such as while working on stdout-mcp
 * itself, the code that's starting is assumed to be the newer.
 *
 * @param {DaemonCode} running  What the running daemon's health check reported.
 * @param {DaemonCode} [starting]  This MCP server's code.
 * @returns {boolean}
 */
export function shouldReplaceDaemon(
	running,
	starting = { packageVersion: getPackageVersion(), codeVersion: getCodeVersion() })
{
	const order = compareVersions(running.packageVersion, starting.packageVersion);

	return order < 0 || (order === 0 && running.codeVersion !== starting.codeVersion);
}
