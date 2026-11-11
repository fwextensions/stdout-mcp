// @ts-check

// The Daemon Link: the conversation between the stdout extension and the
// daemon.  It lives here because an unpacked extension can't import anything
// outside its own folder, and the daemon imports it from here, so it can't use
// Chrome or Node APIs.

	// bump this only when a change would break the other side, so the daemon can
	// tell agents when the extension running in Chrome doesn't match it
export const DaemonLinkVersion = 1;

export const DefaultPort = 47321;

export const DaemonURL = `http://127.0.0.1:${DefaultPort}`;

export const LinkRoutes = {
	Ingest: "/ingest",
	Commands: "/commands",
	CommandResult: "/commands/result",
};

	// every request names the buffer it comes from, so the daemon can tell
	// browsers apart even when it can't read the body, such as when it's too large
export const BufferIdHeader = "X-Stdout-Buffer-Id";

export const CommandNames = {
	Reload: "reload",
};

	// how a reload command dealt with the extension's manifest.json
export const ManifestStatus = {
	Reloaded: "reloaded",
	Unconfirmed: "unconfirmed",
	Failed: "failed",
	Unreachable: "unreachable",
	Skipped: "skipped",
};

	// while agent mode is on, the extension checks in at least this often, even
	// with no new logs to send.  30 seconds is the shortest alarm period Chrome
	// allows.
export const CheckInPeriodSeconds = 30;

	// once the extension picks up a command, it says how it went within this long
export const CommandRunSeconds = 40;

export const BatchSize = 500;

	// the largest request body the daemon accepts
export const MaxBatchBytes = 16 * 1024 * 1024;

	// leaves room for the rest of the request
const MaxEntriesBytes = MaxBatchBytes - 1024;
const MaxBatchesPerCatchUp = 50;
const BytesPerMB = 1024 * 1024;
const Encoder = new TextEncoder();

/**
 * @typedef {object} IngestRequest
 * @property {string} bufferId  Identifies this browser, and changes if its
 * buffer is recreated.
 * @property {string} [browserName]  What to call this browser, which is either
 * the name the user gave it or its brand and version, like "Edge 146".  Missing
 * from extensions that predate it.
 * @property {number|null} syncPosition  Where the extension thinks the daemon is,
 * or null to just ask.
 * @property {object[]} entries  The entries following that position, in order.
 * @property {number} [linkVersion]  Missing from extensions that predate it.
 */

/**
 * @typedef {object} IngestReply
 * @property {number} syncPosition  The daemon's actual position, whether or not
 * it accepted the batch.
 */

/**
 * @typedef {object} Command
 * @property {number} id
 * @property {string} name
 * @property {object} args
 */

/**
 * @typedef {object} ReloadResult  What a reload command did.
 * @property {string} id
 * @property {string} name
 * @property {string} manifest  One of the ManifestStatus values.
 * @property {string} [version]  The extension's version after the reload, when
 * manifest.json was read again.
 */

/**
 * @typedef {object} CommandResult
 * @property {ReloadResult} [result]  What the command did.  Reload is the only
 * command so far.
 * @property {string} [error]  Why the stdout extension couldn't run the command.
 */

function getEntryBytes(
	entry)
{
		// the extra byte is the comma between entries
	return Encoder.encode(JSON.stringify(entry)).length + 1;
}

/**
 * Take as many of these entries as fit in one request.  An entry too big for any
 * request goes as a note in its place, so that it can't hold up the ones after it.
 *
 * @param {object[]} entries
 * @returns {object[]}
 */
function fitInBatch(
	entries)
{
	const batch = [];
	let bytes = 0;

	for (const entry of entries) {
		const entryBytes = getEntryBytes(entry);
		const item = entryBytes > MaxEntriesBytes
			? { ...entry, args: [`[stdout: this entry was ${(entryBytes / BytesPerMB).toFixed(1)} MB, which is too large to send to the MCP server]`] }
			: entry;

		bytes += item === entry ? entryBytes : getEntryBytes(item);

		if (bytes > MaxEntriesBytes) {
			break;
		}

		batch.push(item);
	}

	return batch;
}

/**
 * The stdout extension's half of the conversation.  Each exchange throws if the
 * daemon can't be reached or returns an error.
 *
 * @param {{ fetch?: typeof fetch, baseURL?: string }} [options]
 */
export function createDaemonLink(
	{ fetch: request = fetch, baseURL = DaemonURL } = {})
{
	/**
	 * @param {string} route
	 * @param {object} [body]
	 * @returns {Promise<any>}
	 */
	async function post(
		route,
		bufferId,
		body)
	{
		const response = await request(baseURL + route, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...(bufferId && { [BufferIdHeader]: bufferId }) },
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}

		return response.json();
	}

	return {
		/**
		 * Send the daemon every entry it doesn't have yet.  It only accepts a batch
		 * that continues from what it already has.  If it restarted or we were out
		 * of date, it returns its actual position and we resend from there.
		 *
		 * @param {{ bufferId: string, browserName?: string, syncPosition: number|null, getEntriesAfter: (position: number, limit: number) => Promise<object[]> }} options
		 * Pass a null `syncPosition` when it isn't known yet.
		 * @returns {Promise<number>} The daemon's new sync position.
		 */
		async catchUp(
			{ bufferId, browserName, syncPosition, getEntriesAfter })
		{
			let position = syncPosition;

			for (let i = 0; i < MaxBatchesPerCatchUp; i++) {
					// the first request after the worker starts just asks the daemon what
					// it already has
				const available = position === null
					? []
					: await getEntriesAfter(position, BatchSize);
				const entries = fitInBatch(available);
				/** @type {IngestRequest} */
				const batch = { linkVersion: DaemonLinkVersion, bufferId, browserName, syncPosition: position, entries };
				/** @type {IngestReply} */
				const reply = await post(LinkRoutes.Ingest, bufferId, batch);
				const accepted = position !== null
					&& reply.syncPosition === (entries.at(-1)?.seq ?? position);

				position = reply.syncPosition;

				if (accepted && available.length < BatchSize && entries.length === available.length) {
					break;
				}
			}

			return position;
		},

		/**
		 * Wait for commands.  The daemon holds this request until it has one, for
		 * less than Chrome's limit on how long a fetch can take.  Each browser polls
		 * for its own commands.
		 *
		 * @param {string} bufferId
		 * @returns {Promise<Command[]>}
		 */
		async pollCommands(
			bufferId)
		{
			const { commands } = await post(LinkRoutes.Commands, bufferId);

			return commands;
		},

		/**
		 * @param {string} bufferId
		 * @param {number} id
		 * @param {CommandResult} outcome
		 * @returns {Promise<void>}
		 */
		async sendCommandResult(
			bufferId,
			id,
			outcome)
		{
			await post(LinkRoutes.CommandResult, bufferId, { id, ...outcome });
		},
	};
}
